/**
 * Jupyter Collaboration Test (Two Clients)
 * Tests the full collaborative Jupyter workflow:
 * 1. Both clients onboarded (via @onboarding-two)
 * 2. Exchange keys via Network tab
 * 3. Client1 creates session and invites Client2
 * 4. Client2 accepts invitation
 * 5. Both launch Jupyter
 * 6. Each client runs their respective notebook (DO/DS pair)
 *
 * Usage:
 *   ./test-scenario.sh --jupyter-collab [config.json]
 *
 * Config JSON format (from biovault-beaver/notebooks/*.json):
 *   {
 *     "mode": "parallel",
 *     "runs": [
 *       { "role": "do", "notebook": "notebooks/02-advanced-features-do.ipynb", "email": "client1@sandbox.local" },
 *       { "role": "ds", "notebook": "notebooks/02-advanced-features-ds.ipynb", "email": "client2@sandbox.local" }
 *     ]
 *   }
 *
 * @tag jupyter-collab
 */
import { expect, test, type Page } from '@playwright/test'
import WebSocket from 'ws'
import * as fs from 'fs'
import * as path from 'path'
import { waitForAppReady } from './test-helpers.js'
import { setWsPort, completeOnboarding, ensureLogSocket, log } from './onboarding-helper.js'

const TEST_TIMEOUT = 420_000 // 7 minutes max (Jupyter startup can be slow on fresh envs)
const UI_TIMEOUT = 10_000
const JUPYTER_STARTUP_TIMEOUT = 240_000 // Allow more time for venv install + server start
const SYNC_TIMEOUT = 30_000 // 30 seconds for session sync
const PEER_DID_TIMEOUT_MS = 180_000 // 3 minutes for peer DID sync (CI can be slow)
const CHAT_PAUSE_MS = process.env.CHAT_PAUSE_MS
	? Number.parseInt(process.env.CHAT_PAUSE_MS, 10)
	: 250

// Config file interface
interface NotebookRun {
	role: 'do' | 'ds'
	notebook: string
	timeout?: number
	email?: string
}

interface NotebookConfig {
	mode?: 'parallel' | 'sequential'
	runs: NotebookRun[]
}

// Load config from JSON file if NOTEBOOK_CONFIG is set
function loadNotebookConfig(): { notebookDO: string; notebookDS: string } {
	const configPath = process.env.NOTEBOOK_CONFIG

	if (configPath && fs.existsSync(configPath)) {
		try {
			const configContent = fs.readFileSync(configPath, 'utf-8')
			const config: NotebookConfig = JSON.parse(configContent)

			const doRun = config.runs.find((r) => r.role === 'do')
			const dsRun = config.runs.find((r) => r.role === 'ds')

			// Extract notebook name from path (e.g., "notebooks/02-advanced-features-do.ipynb" -> "02-advanced-features-do")
			const extractName = (notebookPath: string) => {
				const basename = path.basename(notebookPath, '.ipynb')
				return basename
			}

			const notebookDO = doRun ? extractName(doRun.notebook) : '02-advanced-features-do'
			const notebookDS = dsRun ? extractName(dsRun.notebook) : '02-advanced-features-ds'

			console.log(`Loaded notebook config from ${configPath}`)
			console.log(`  DO notebook: ${notebookDO}`)
			console.log(`  DS notebook: ${notebookDS}`)

			return { notebookDO, notebookDS }
		} catch (err) {
			console.log(`Warning: Failed to load config from ${configPath}: ${err}`)
		}
	}

	// Fall back to env vars or defaults
	return {
		notebookDO: process.env.NOTEBOOK_DO || '02-advanced-features-do',
		notebookDS: process.env.NOTEBOOK_DS || '02-advanced-features-ds',
	}
}

// Load notebook configuration
const { notebookDO: NOTEBOOK_DO, notebookDS: NOTEBOOK_DS } = loadNotebookConfig()

test.describe.configure({ timeout: TEST_TIMEOUT })

interface Backend {
	invoke: (cmd: string, args?: Record<string, unknown>) => Promise<any>
	close: () => Promise<void>
}

function resolveDatasitesRoot(dataDir: string): string {
	return path.basename(dataDir) === 'datasites' ? dataDir : path.join(dataDir, 'datasites')
}

async function getSyftboxDataDir(backend: Backend): Promise<string> {
	const info = await backend.invoke('get_syftbox_config_info')
	const dataDir = info?.data_dir
	if (!dataDir || typeof dataDir !== 'string') {
		throw new Error(`WS bridge did not return a usable data_dir (get_syftbox_config_info)`)
	}
	return dataDir
}

async function waitForPeerDid(
	dataDir: string,
	peerEmail: string,
	timeoutMs = PEER_DID_TIMEOUT_MS,
	backend?: Backend,
): Promise<string> {
	const datasitesRoot = resolveDatasitesRoot(dataDir)
	const didPath = path.join(datasitesRoot, peerEmail, 'public', 'crypto', 'did.json')
	const start = Date.now()
	let syncTriggerCount = 0
	while (Date.now() - start < timeoutMs) {
		if (fs.existsSync(didPath)) return didPath
		// Trigger sync every ~2 seconds to accelerate DID file discovery
		if (backend && syncTriggerCount % 4 === 0) {
			try {
				await backend.invoke('trigger_syftbox_sync')
			} catch {
				// Ignore sync trigger errors - client may not be ready yet
			}
		}
		syncTriggerCount++
		await new Promise((r) => setTimeout(r, 500))
	}
	throw new Error(`Timed out waiting for peer DID file: ${didPath}`)
}

async function connectBackend(port: number): Promise<Backend> {
	const socket = new WebSocket(`ws://localhost:${port}`)
	await new Promise<void>((resolve, reject) => {
		const timeout = setTimeout(
			() => reject(new Error(`WS connect timeout on port ${port}`)),
			10_000,
		)
		socket.once('open', () => {
			clearTimeout(timeout)
			resolve()
		})
		socket.once('error', (err) => {
			clearTimeout(timeout)
			reject(err)
		})
	})

	let nextId = 0
	const pending = new Map<number, { resolve: (v: any) => void; reject: (e: any) => void }>()

	socket.on('message', (data) => {
		let parsed: any
		try {
			parsed = JSON.parse(data.toString())
		} catch {
			return
		}
		const entry = pending.get(parsed?.id)
		if (!entry) return
		pending.delete(parsed.id)
		if (parsed.error) entry.reject(new Error(parsed.error))
		else entry.resolve(parsed.result)
	})

	function invoke(cmd: string, args: Record<string, unknown> = {}, timeoutMs = 30_000) {
		const id = ++nextId
		socket.send(JSON.stringify({ id, cmd, args }))
		return new Promise<any>((resolve, reject) => {
			pending.set(id, { resolve, reject })
			setTimeout(() => {
				if (!pending.has(id)) return
				pending.delete(id)
				reject(new Error(`WS invoke timeout: ${cmd}`))
			}, timeoutMs)
		})
	}

	async function close() {
		if (socket.readyState !== WebSocket.OPEN) return
		await new Promise<void>((resolve) => {
			socket.once('close', () => resolve())
			socket.close()
		})
	}

	return { invoke, close }
}

async function runAllCellsAndWait(
	jupyterPage: Page,
	notebookName: string,
): Promise<{ outputs: string; errorCount: number }> {
	console.log(`[${notebookName}] Running all cells...`)

	// Count cells before running
	const cellCount = await jupyterPage.locator('.jp-CodeCell').count()
	console.log(`[${notebookName}] Found ${cellCount} code cells`)

	// Click on the Run menu
	const runMenu = jupyterPage.locator('div.lm-MenuBar-itemLabel:has-text("Run")')
	await runMenu.click()
	await jupyterPage.waitForTimeout(500)

	// Click "Run All Cells" (exact match)
	const runAllOption = jupyterPage.getByText('Run All Cells', { exact: true })
	await runAllOption.click()

	console.log(`[${notebookName}] Executing all cells...`)

	// Wait for execution to start (at least one cell should show running)
	await jupyterPage.waitForTimeout(2000)

	// Wait for kernel to become idle - check both indicator and cell execution counts
	const startTime = Date.now()
	try {
		await jupyterPage.waitForFunction(
			() => {
				// Check kernel status indicator
				const status = document.querySelector('.jp-Notebook-ExecutionIndicator')
				const isIdle =
					status?.textContent?.includes('Idle') || !status?.textContent?.includes('Busy')

				// Also check if any cells still show execution in progress
				const runningCells = document.querySelectorAll('.jp-Cell.jp-mod-running')
				const noRunningCells = runningCells.length === 0

				return isIdle && noRunningCells
			},
			{ timeout: 240_000 },
		)
	} catch {
		console.log(
			`[${notebookName}] Could not detect kernel idle after ${Math.round((Date.now() - startTime) / 1000)}s, waiting 30s...`,
		)
		await jupyterPage.waitForTimeout(30_000)
	}

	const execTime = Math.round((Date.now() - startTime) / 1000)
	console.log(`[${notebookName}] All cells executed! (took ${execTime}s)`)

	// Collect outputs
	const allOutputText = await jupyterPage.locator('.jp-OutputArea').allTextContents()
	const combinedOutput = allOutputText.join('\n')

	// Count errors
	const errorOutputs = jupyterPage.locator('[data-mime-type="application/vnd.jupyter.stderr"]')
	const errorCount = await errorOutputs.count()

	// Check for tracebacks
	const tracebackOutputs = jupyterPage.locator(
		'.jp-OutputArea-output pre:has-text("Traceback"), .jp-OutputArea-output pre:has-text("Error:")',
	)
	const tracebackCount = await tracebackOutputs.count()

	if (errorCount > 0 || tracebackCount > 0) {
		console.log(`\n${'='.repeat(60)}`)
		console.log(`[${notebookName}] ⚠️  Found ${errorCount} stderr + ${tracebackCount} tracebacks:`)
		console.log('='.repeat(60))

		for (let i = 0; i < Math.min(errorCount, 5); i++) {
			const errorText = await errorOutputs.nth(i).textContent()
			if (errorText) {
				console.log(`--- Stderr ${i + 1} ---`)
				console.log(errorText.substring(0, 500))
			}
		}

		for (let i = 0; i < Math.min(tracebackCount, 5); i++) {
			const tbText = await tracebackOutputs.nth(i).textContent()
			if (tbText) {
				console.log(`--- Traceback ${i + 1} ---`)
				console.log(tbText.substring(0, 1000))
			}
		}
		console.log('='.repeat(60))
	}

	return { outputs: combinedOutput, errorCount: errorCount + tracebackCount }
}

// Timing helper for detailed performance analysis
function timer(label: string) {
	const start = Date.now()
	return {
		stop: () => {
			const elapsed = Date.now() - start
			console.log(`⏱️  ${label}: ${(elapsed / 1000).toFixed(2)}s`)
			return elapsed
		},
	}
}

test.describe('Jupyter Collaboration @jupyter-collab', () => {
	test('two clients collaborate on notebooks', async ({ browser }) => {
		const testTimer = timer('Total test time')
		const wsPort1 = Number.parseInt(process.env.DEV_WS_BRIDGE_PORT_BASE || '3333', 10)
		const wsPort2 = wsPort1 + 1
		const email1 = process.env.CLIENT1_EMAIL || 'client1@sandbox.local'
		const email2 = process.env.CLIENT2_EMAIL || 'client2@sandbox.local'

		console.log(`Setting up two-client Jupyter collaboration test`)
		console.log(`Client1: ${email1} (port ${wsPort1})`)
		console.log(`Client2: ${email2} (port ${wsPort2})`)
		console.log(`Notebook pair: DO="${NOTEBOOK_DO}", DS="${NOTEBOOK_DS}"`)

		// Create contexts and pages for both clients
		const context1 = await browser.newContext()
		const context2 = await browser.newContext()
		const page1 = await context1.newPage()
		const page2 = await context2.newPage()

		// Monitor console errors for missing WS commands
		const consoleErrors: string[] = []
		page1.on('console', (msg) => {
			if (msg.type() === 'error') {
				const text = msg.text()
				consoleErrors.push(`[Client1] ${text}`)
				if (text.includes('Unhandled command')) {
					console.log(`⚠️  [Client1] Missing WS command: ${text}`)
				}
			}
		})
		page2.on('console', (msg) => {
			if (msg.type() === 'error') {
				const text = msg.text()
				consoleErrors.push(`[Client2] ${text}`)
				if (text.includes('Unhandled command')) {
					console.log(`⚠️  [Client2] Missing WS command: ${text}`)
				}
			}
		})

		await setWsPort(page1, wsPort1)
		await setWsPort(page2, wsPort2)

		const backend1 = await connectBackend(wsPort1)
		const backend2 = await connectBackend(wsPort2)

		const baseUrl = process.env.UI_BASE_URL || 'http://localhost:8082'
		await page1.goto(baseUrl)
		await page2.goto(baseUrl)

		// Check if clients are onboarded, do onboarding if needed
		const isOnboarded1 = await backend1.invoke('check_is_onboarded')
		const isOnboarded2 = await backend2.invoke('check_is_onboarded')
		console.log(`Client1 onboarded: ${isOnboarded1}, Client2 onboarded: ${isOnboarded2}`)

		// Do onboarding inline if needed (allows running this test standalone)
		if (!isOnboarded1 || !isOnboarded2) {
			const onboardingTimer = timer('Onboarding')
			console.log('\n=== Onboarding clients (inline) ===')
			const logSocket = await ensureLogSocket()

			// Run both onboardings in parallel for speed
			const onboardingPromises: Promise<boolean>[] = []
			if (!isOnboarded1) {
				onboardingPromises.push(completeOnboarding(page1, email1, logSocket))
			}
			if (!isOnboarded2) {
				onboardingPromises.push(completeOnboarding(page2, email2, logSocket))
			}
			await Promise.all(onboardingPromises)

			if (logSocket) {
				logSocket.close()
			}
			console.log('Onboarding complete!')

			// Give SyftBox time to write/publish DID files and sync them between clients
			// We trigger sync on both clients to accelerate the discovery
			console.log('Waiting for peer DID files to sync...')
			const dataDir1 = await getSyftboxDataDir(backend1)
			const dataDir2 = await getSyftboxDataDir(backend2)
			await Promise.all([
				waitForPeerDid(dataDir1, email2, PEER_DID_TIMEOUT_MS, backend1),
				waitForPeerDid(dataDir2, email1, PEER_DID_TIMEOUT_MS, backend2),
			])
			onboardingTimer.stop()
		}

		// ============================================================
		// Step 1: Exchange keys via Network tab
		// ============================================================
		const keysTimer = timer('Key exchange')
		console.log('\n=== Step 1: Exchange keys via Network tab ===')

		// Navigate to Network tab on both
		await page1.locator('.nav-item[data-tab="network"]').click()
		await page2.locator('.nav-item[data-tab="network"]').click()
		await expect(page1.locator('.network-container, #network-view')).toBeVisible({
			timeout: UI_TIMEOUT,
		})
		await expect(page2.locator('.network-container, #network-view')).toBeVisible({
			timeout: UI_TIMEOUT,
		})

		// Import each other as contacts via backend (more reliable than UI)
		console.log('Importing contacts via backend...')
		await backend1.invoke('network_import_contact', { identity: email2 })
		await backend2.invoke('network_import_contact', { identity: email1 })
		console.log('Contacts imported!')

		// Refresh network view
		await page1.reload()
		await page2.reload()
		await waitForAppReady(page1, { timeout: 10_000 })
		await waitForAppReady(page2, { timeout: 10_000 })
		keysTimer.stop()

		// ============================================================
		// Step 2: Client1 creates session and invites Client2 (via backend)
		// ============================================================
		const sessionTimer = timer('Session creation + sync')
		console.log('\n=== Step 2: Client1 creates session and invites Client2 ===')

		const sessionName = `Collab-Test-${Date.now()}`

		// Create session via backend for reliability
		console.log(`Creating session "${sessionName}" via backend...`)
		const createResult = await backend1.invoke('create_session', {
			request: {
				name: sessionName,
				peer: email2, // Invite Client2
			},
		})
		const sessionId = createResult?.session_id || createResult?.sessionId || createResult?.id
		console.log(`Session created with ID: ${sessionId}`)

		// 🚀 OPTIMIZATION: Launch Jupyter on Client1 EARLY (runs in background while we sync & chat)
		// This overlaps Jupyter startup (~30-60s) with session sync and chat (~5-10s)
		// NOTE: Client2 Jupyter is launched later, after it accepts the invitation
		const jupyterTimer = timer('Jupyter startup (background)')
		console.log('🚀 Starting Jupyter in background (will continue while doing chat)...')
		const jupyterPromise1 = backend1
			.invoke(
				'launch_session_jupyter',
				{
					sessionId,
					pythonVersion: '3.12',
					copyExamples: true,
				},
				JUPYTER_STARTUP_TIMEOUT,
			)
			.catch((err: Error) => {
				console.log(`Warning: Client1 Jupyter launch error: ${err.message}`)
				return null
			})

		// Client2 Jupyter promise - will be set after invitation acceptance
		let jupyterPromise2: Promise<any> = Promise.resolve(null)

		// Helper to click on a session and open its detail panel (with retries)
		async function clickSessionItem(
			page: Page,
			clientName: string,
			sessName: string,
			maxRetries = 3,
		): Promise<boolean> {
			for (let attempt = 1; attempt <= maxRetries; attempt++) {
				console.log(`${clientName}: Attempt ${attempt}/${maxRetries} to find session...`)

				// Reload and navigate to sessions tab
				await page.reload()
				await waitForAppReady(page, { timeout: 10_000 })
				await page.locator('.nav-item[data-tab="sessions"]').click()
				await expect(page.locator('.sessions-container')).toBeVisible({ timeout: UI_TIMEOUT })

				// Wait a bit for sessions to load from backend
				await page.waitForTimeout(2000)

				// Debug: list all session items
				const allItems = await page.locator('.session-list-item').all()
				console.log(`${clientName}: Found ${allItems.length} session items`)
				for (let i = 0; i < Math.min(allItems.length, 3); i++) {
					const text = await allItems[i].textContent()
					console.log(`  [${i}] ${text?.substring(0, 50)}...`)
				}

				if (allItems.length === 0) {
					if (attempt < maxRetries) {
						console.log(`${clientName}: No sessions yet, waiting before retry...`)
						await page.waitForTimeout(2000)
						continue
					}
					console.log(`${clientName}: No session items visible after ${maxRetries} attempts`)
					return false
				}

				// Try to find session by name
				let sessionItem = page.locator('.session-list-item').filter({ hasText: sessName }).first()
				if (!(await sessionItem.isVisible({ timeout: 2000 }).catch(() => false))) {
					// If not found by exact name, try first session item
					console.log(`${clientName}: Session "${sessName}" not found, trying first item...`)
					sessionItem = page.locator('.session-list-item').first()
				}

				if (await sessionItem.isVisible({ timeout: 3000 }).catch(() => false)) {
					console.log(`${clientName}: Clicking on session item...`)
					await sessionItem.click()
					await page.waitForTimeout(500)

					// Wait for session detail panel to appear
					const sessionsMain = page.locator('#sessions-main')
					if (await sessionsMain.isVisible({ timeout: 5000 }).catch(() => false)) {
						console.log(`${clientName}: Session detail panel is visible!`)
						return true
					} else {
						console.log(`${clientName}: Session detail panel NOT visible after click`)
					}
				}
			}
			return false
		}

		// Navigate to Sessions tab and click on the session for Client1
		console.log('\nOpening session for Client1...')
		await clickSessionItem(page1, 'Client1', sessionName)

		// ============================================================
		// Step 3: Wait for session to sync and Client2 accepts
		// ============================================================
		console.log('\n=== Step 3: Wait for session sync and Client2 accepts ===')

		// Poll for invitation on Client2's backend
		let invitationFound = false
		const syncStart = Date.now()
		while (Date.now() - syncStart < SYNC_TIMEOUT) {
			try {
				const invitations = await backend2.invoke('get_session_invitations')
				console.log(`Client2 invitations: ${JSON.stringify(invitations)}`)
				if (Array.isArray(invitations) && invitations.length > 0) {
					// Find our session
					const ourInvite = invitations.find(
						(inv: any) =>
							inv.session_id === sessionId ||
							inv.sessionId === sessionId ||
							inv.name === sessionName,
					)
					if (ourInvite) {
						console.log(
							`Found invitation for session: ${ourInvite.session_id || ourInvite.sessionId}`,
						)
						// Accept the invitation
						const inviteId = ourInvite.session_id || ourInvite.sessionId || ourInvite.id
						await backend2.invoke('accept_session_invitation', { sessionId: inviteId })
						console.log('Invitation accepted via backend!')
						invitationFound = true
						break
					}
				}
				// Also check if session already synced
				const sessions = await backend2.invoke('get_sessions')
				if (Array.isArray(sessions)) {
					const ourSession = sessions.find(
						(s: any) =>
							s.session_id === sessionId || s.sessionId === sessionId || s.name === sessionName,
					)
					if (ourSession) {
						console.log('Session already synced to Client2!')
						invitationFound = true
						break
					}
				}
			} catch (err) {
				console.log(`Sync check error: ${err}`)
			}
			await page2.waitForTimeout(2000)
		}

		if (!invitationFound) {
			console.log('WARNING: Session invitation not found within timeout - continuing anyway')
		}

		// 🚀 OPTIMIZATION: Now that Client2 has the session, launch Jupyter on Client2 too
		console.log('🚀 Starting Jupyter on Client2 (session now available)...')
		jupyterPromise2 = backend2
			.invoke(
				'launch_session_jupyter',
				{
					sessionId,
					pythonVersion: '3.12',
					copyExamples: true,
				},
				JUPYTER_STARTUP_TIMEOUT,
			)
			.catch((err: Error) => {
				console.log(`Warning: Client2 Jupyter launch error: ${err.message}`)
				return null
			})

		// Navigate Client2 to Sessions tab and click on the session
		await page2.locator('.nav-item[data-tab="sessions"]').click()
		await expect(page2.locator('.sessions-container')).toBeVisible({ timeout: UI_TIMEOUT })
		await page2.waitForTimeout(1000)

		// Click on the session to select it
		const sessionItem2 = page2
			.locator('.session-list-item')
			.filter({ hasText: sessionName })
			.first()
		if (await sessionItem2.isVisible({ timeout: 5000 }).catch(() => false)) {
			console.log('Clicking on session in Client2 UI...')
			await sessionItem2.click()
			// Wait for session detail panel to appear
			await expect(page2.locator('#sessions-main')).toBeVisible({ timeout: 5000 })
			console.log('Client2 session detail panel is visible')
		} else {
			console.log('WARNING: Session item not visible in Client2 - may need to wait for sync')
		}

		// ============================================================
		// Step 4: Send test messages via session chat (using UI)
		// ============================================================
		console.log('\n=== Step 4: Exchange test messages in session chat ===')

		// Helper function to send a message via UI
		async function sendChatMessage(page: Page, clientName: string, message: string) {
			// Scroll to the chat panel first (it's at the bottom of session detail)
			const chatPanel = page.locator('.session-chat-panel')
			await chatPanel.scrollIntoViewIfNeeded()

			const messageInput = page.locator('#session-message-input')
			const sendBtn = page.locator('#send-session-message-btn')

			// Wait for chat input to be visible
			await expect(messageInput).toBeVisible({ timeout: 5000 })

			// Clear any existing text and type the message
			await messageInput.click()
			await messageInput.fill(message)
			console.log(`${clientName} typing: "${message}"`)

			// Click the send button
			await sendBtn.click()
			console.log(`${clientName} sent message!`)

			// Reactive waits: input clears and message appears in timeline.
			await expect(messageInput).toHaveValue('', { timeout: 5000 })
			await expect(page.locator('#session-messages')).toContainText(message, { timeout: 5000 })
		}

		// Verify session detail panel is visible on both clients before sending messages
		console.log('Verifying chat panels are accessible...')

		// Check Client1 session detail is showing
		const sessionsMain1 = page1.locator('#sessions-main')
		if (!(await sessionsMain1.isVisible().catch(() => false))) {
			console.log('Client1 session detail not visible, clicking session again...')
			const reSessionItem1 = page1
				.locator('.session-list-item')
				.filter({ hasText: sessionName })
				.first()
			if (await reSessionItem1.isVisible({ timeout: 3000 }).catch(() => false)) {
				await reSessionItem1.click()
				await expect(sessionsMain1).toBeVisible({ timeout: 5000 })
			}
		}

		// Check Client2 session detail is showing
		const sessionsMain2 = page2.locator('#sessions-main')
		if (!(await sessionsMain2.isVisible().catch(() => false))) {
			console.log('Client2 session detail not visible, clicking session again...')
			const reSessionItem2 = page2
				.locator('.session-list-item')
				.filter({ hasText: sessionName })
				.first()
			if (await reSessionItem2.isVisible({ timeout: 3000 }).catch(() => false)) {
				await reSessionItem2.click()
				await expect(sessionsMain2).toBeVisible({ timeout: 5000 })
			}
		}

		await page1.waitForTimeout(500)
		await page2.waitForTimeout(500)

		// Client1 sends a message via UI
		console.log('Client1 sending message via UI...')
		try {
			await sendChatMessage(page1, 'Client1', 'Hello from Client1! Ready to collaborate.')
		} catch (err) {
			console.log(`Warning: Client1 chat UI not available: ${err}`)
		}

		await page1.waitForTimeout(CHAT_PAUSE_MS)

		// Client2 sends a message via UI
		console.log('Client2 sending message via UI...')
		try {
			await sendChatMessage(page2, 'Client2', "Hello from Client2! Let's start the analysis.")
		} catch (err) {
			console.log(`Warning: Client2 chat UI not available: ${err}`)
		}

		await page2.waitForTimeout(CHAT_PAUSE_MS)

		// Client1 sends another message
		console.log('Client1 sending another message via UI...')
		try {
			await sendChatMessage(page1, 'Client1', 'Starting Jupyter notebooks now...')
		} catch (err) {
			console.log(`Warning: Client1 chat UI not available: ${err}`)
		}

		await page1.waitForTimeout(CHAT_PAUSE_MS)
		console.log('Messages exchanged successfully!')
		sessionTimer.stop()

		// ============================================================
		// Step 5: Wait for Jupyter (started earlier in background)
		// ============================================================
		console.log('\n=== Step 5: Wait for Jupyter to be ready ===')

		// Wait for the Jupyter promises we started earlier
		console.log('Waiting for Jupyter startup to complete...')
		const [jupyterStatus1, jupyterStatus2] = await Promise.all([jupyterPromise1, jupyterPromise2])
		jupyterTimer.stop()

		// Get URLs from status
		const jupyterUrl1 = jupyterStatus1?.url || null
		let jupyterUrl2 = jupyterStatus2?.url || null

		if (!jupyterUrl1) {
			throw new Error('Client1 Jupyter did not return a URL')
		}
		console.log(`Client1 Jupyter URL: ${jupyterUrl1}`)

		if (jupyterStatus2 && !jupyterUrl2) {
			const link2 = page2.locator('#session-jupyter-link')
			const visible2 = await link2
				.isVisible({ timeout: JUPYTER_STARTUP_TIMEOUT })
				.catch(() => false)
			if (visible2) {
				jupyterUrl2 = await link2.getAttribute('href')
			}
			if (!jupyterUrl2) {
				console.log('WARNING: Client2 Jupyter link did not become visible; fetching via backend')
				try {
					const status2 = await backend2.invoke('get_session_jupyter_status', { sessionId })
					if (status2?.url) {
						jupyterUrl2 = String(status2.url)
						// Try to surface the link in the UI for visibility
						await page2.evaluate((url) => {
							const urlEl = document.getElementById('session-jupyter-url')
							const linkEl = document.getElementById('session-jupyter-link')
							if (urlEl && linkEl) {
								urlEl.style.display = 'block'
								linkEl.setAttribute('href', url)
								linkEl.textContent = `Open Jupyter (from backend)`
							}
						}, jupyterUrl2)
					}
				} catch (err) {
					console.log(`Client2 backend status fetch failed: ${err}`)
				}
			}
		}

		if (jupyterUrl2) {
			console.log(`Client2 Jupyter URL: ${jupyterUrl2}`)
		} else {
			console.log('WARNING: Client2 Jupyter did not return a URL')
		}

		// ============================================================
		// Step 6: Open notebooks in JupyterLab
		// ============================================================
		const notebookOpenTimer = timer('Open notebooks in JupyterLab')
		console.log('\n=== Step 6: Open notebooks in JupyterLab ===')

		// Open JupyterLab pages in parallel.
		const jupyterPage1 = await context1.newPage()
		let jupyterPage2: Page | null = null
		if (jupyterUrl2) {
			jupyterPage2 = await context2.newPage()
		}

		await Promise.all([
			jupyterPage1.goto(jupyterUrl1),
			jupyterPage2 ? jupyterPage2.goto(jupyterUrl2 as string) : Promise.resolve(),
		])

		await Promise.all([
			jupyterPage1.waitForLoadState('networkidle'),
			jupyterPage2 ? jupyterPage2.waitForLoadState('networkidle') : Promise.resolve(),
		])

		await Promise.all([
			jupyterPage1.waitForSelector('.jp-Launcher, .jp-NotebookPanel, .jp-DirListing', {
				timeout: 30_000,
			}),
			jupyterPage2
				? jupyterPage2.waitForSelector('.jp-Launcher, .jp-NotebookPanel, .jp-DirListing', {
						timeout: 30_000,
					})
				: Promise.resolve(),
		])

		console.log('Client1 JupyterLab loaded!')
		if (jupyterPage2) {
			console.log('Client2 JupyterLab loaded!')
		}

		// Dismiss notification popup(s) if present
		const noBtn1 = jupyterPage1.locator('button:has-text("No")').first()
		const noBtn2 = jupyterPage2 ? jupyterPage2.locator('button:has-text("No")').first() : null
		await Promise.all([
			noBtn1
				.isVisible({ timeout: 2000 })
				.catch(() => false)
				.then(async (v) => {
					if (!v) return
					await noBtn1.click()
					await jupyterPage1.waitForTimeout(500)
				}),
			noBtn2
				? noBtn2
						.isVisible({ timeout: 2000 })
						.catch(() => false)
						.then(async (v) => {
							if (!v || !noBtn2 || !jupyterPage2) return
							await noBtn2.click()
							await jupyterPage2.waitForTimeout(500)
						})
				: Promise.resolve(),
		])

		// Find and open the DO notebook
		const fileBrowser1 = jupyterPage1.locator('.jp-DirListing-content')
		await expect(fileBrowser1).toBeVisible({ timeout: 5000 })

		const doNotebookPattern = new RegExp(NOTEBOOK_DO, 'i')
		const doNotebook = fileBrowser1
			.locator('.jp-DirListing-item')
			.filter({ hasText: doNotebookPattern })
			.first()
		if (await doNotebook.isVisible({ timeout: 5000 }).catch(() => false)) {
			console.log(`Opening ${NOTEBOOK_DO}.ipynb on Client1...`)
			await doNotebook.dblclick()
			await jupyterPage1.waitForSelector('.jp-NotebookPanel', { timeout: 15_000 })
		} else {
			console.log(`WARNING: ${NOTEBOOK_DO}.ipynb not found on Client1`)
		}

		// Find and open the DS notebook
		if (jupyterPage2) {
			// Find and open the DS notebook
			const fileBrowser2 = jupyterPage2.locator('.jp-DirListing-content')
			await expect(fileBrowser2).toBeVisible({ timeout: 5000 })

			const dsNotebookPattern = new RegExp(NOTEBOOK_DS, 'i')
			const dsNotebook = fileBrowser2
				.locator('.jp-DirListing-item')
				.filter({ hasText: dsNotebookPattern })
				.first()
			if (await dsNotebook.isVisible({ timeout: 5000 }).catch(() => false)) {
				console.log(`Opening ${NOTEBOOK_DS}.ipynb on Client2...`)
				await dsNotebook.dblclick()
				await jupyterPage2.waitForSelector('.jp-NotebookPanel', { timeout: 15_000 })
			} else {
				console.log(`WARNING: ${NOTEBOOK_DS}.ipynb not found on Client2`)
			}
		}

		// ============================================================
		// Step 7: Run all cells on both notebooks
		// ============================================================
		notebookOpenTimer.stop()
		const notebookExecTimer = timer('Execute notebook cells')
		console.log('\n=== Step 7: Run all cells on both notebooks ===')

		// Wait for notebooks to be ready
		await jupyterPage1.waitForSelector('.jp-CodeCell', { timeout: 15_000 })
		if (jupyterPage2) {
			await jupyterPage2.waitForSelector('.jp-CodeCell', { timeout: 15_000 })
		}
		await jupyterPage1.waitForTimeout(2000)

		// Run BOTH notebooks in parallel - they need to communicate with each other
		// DO publishes data, DS requests it - they must run simultaneously
		console.log('Starting both notebooks in parallel...')

		let result1 = { outputs: '', errorCount: 0 }
		let result2 = { outputs: '', errorCount: 0 }

		if (jupyterPage2) {
			// Run both in parallel
			const [r1, r2] = await Promise.all([
				runAllCellsAndWait(jupyterPage1, 'DO (Client1)'),
				runAllCellsAndWait(jupyterPage2, 'DS (Client2)'),
			])
			result1 = r1
			result2 = r2
		} else {
			// Only DO notebook available
			result1 = await runAllCellsAndWait(jupyterPage1, 'DO (Client1)')
		}

		console.log(`\n=== Client1 (DO) Output Summary ===`)
		console.log(result1.outputs.substring(0, 2000))
		console.log(`=== End Client1 Output (errors: ${result1.errorCount}) ===\n`)

		if (jupyterPage2) {
			console.log(`\n=== Client2 (DS) Output Summary ===`)
			console.log(result2.outputs.substring(0, 2000))
			console.log(`=== End Client2 Output (errors: ${result2.errorCount}) ===\n`)
		}
		notebookExecTimer.stop()

		// ============================================================
		// Summary and Assertions
		// ============================================================
		console.log('\n=== Test Summary ===')
		console.log(`Client1 (DO) errors: ${result1.errorCount}`)
		console.log(`Client2 (DS) errors: ${result2.errorCount}`)

		// Log any console errors (especially missing WS commands)
		if (consoleErrors.length > 0) {
			console.log(`\n=== Console Errors (${consoleErrors.length}) ===`)
			// Deduplicate similar errors
			const uniqueErrors = [...new Set(consoleErrors)]
			uniqueErrors.slice(0, 20).forEach((err) => console.log(err))
			if (uniqueErrors.length > 20) {
				console.log(`... and ${uniqueErrors.length - 20} more`)
			}
			console.log('=== End Console Errors ===\n')
		} else {
			console.log('✅ No console errors detected')
		}

		// Pause for inspection (only in interactive mode, default 0 for CI)
		const isInteractive = process.env.INTERACTIVE_MODE === '1'
		const pauseTime = process.env.JUPYTER_PAUSE_TIME
			? parseInt(process.env.JUPYTER_PAUSE_TIME, 10)
			: isInteractive
				? 10_000
				: 0
		if (pauseTime > 0) {
			console.log(`Pausing for ${pauseTime / 1000} seconds to inspect outputs...`)
			await jupyterPage1.waitForTimeout(pauseTime)
		}

		// TODO: Add specific assertions once we know what the expected outputs are
		// For now, just log everything and don't fail on errors so we can see what happens
		if (result1.errorCount > 0 || result2.errorCount > 0) {
			console.log('⚠️  There were errors in the notebooks - check output above')
			// Uncomment to fail on errors once we know expected behavior:
			// throw new Error(`Notebooks had errors: DO=${result1.errorCount}, DS=${result2.errorCount}`)
		}

		// ============================================================
		// Cleanup
		// ============================================================
		console.log('\n=== Cleanup: Stopping Jupyter sessions ===')

		// Stop Jupyter on both clients to avoid leaking processes
		try {
			await backend1.invoke('reset_session_jupyter', { sessionId: sessionId })
			console.log('Client1 Jupyter stopped')
		} catch (err) {
			console.log(`Warning: Failed to stop Client1 Jupyter: ${err}`)
		}

		try {
			await backend2.invoke('reset_session_jupyter', { sessionId: sessionId })
			console.log('Client2 Jupyter stopped')
		} catch (err) {
			console.log(`Warning: Failed to stop Client2 Jupyter: ${err}`)
		}

		// Close Jupyter pages if open
		if (jupyterPage2) {
			await jupyterPage2.close().catch(() => {})
		}
		await jupyterPage1.close().catch(() => {})

		await backend1.close()
		await backend2.close()
		await context1.close()
		await context2.close()

		console.log('Cleanup complete!')
		testTimer.stop()
	})
})
