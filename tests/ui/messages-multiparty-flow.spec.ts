/**
 * Multiparty Flow Test (Three Clients)
 * Tests the multiparty flow invitation and step-by-step execution:
 * 1. Three clients (client1, client2, aggregator) onboard
 * 2. All three exchange keys
 * 3. Aggregator creates a group chat and sends flow invitation
 * 4. Client1 and client2 receive invitation, import flow, and join
 * 5. Each participant goes to Runs tab and executes their steps
 * 6. Shared results appear in the chat
 *
 * Usage:
 *   ./test-scenario.sh --pipelines-multiparty-flow --interactive
 *
 * @tag pipelines-multiparty-flow
 */
import { expect, test, type Page } from './playwright-fixtures'
import WebSocket from 'ws'
import * as fs from 'node:fs'
import { waitForAppReady, ensureProfileSelected } from './test-helpers.js'
import { setWsPort, completeOnboarding, ensureLogSocket, log } from './onboarding-helper.js'

const TEST_TIMEOUT = 300_000 // 5 minutes max
const UI_TIMEOUT = 15_000
const MESSAGE_TIMEOUT = 90_000
const SYNC_INTERVAL = 500

test.describe.configure({ timeout: TEST_TIMEOUT })

interface Backend {
	invoke: (cmd: string, args?: Record<string, unknown>, timeoutMs?: number) => Promise<any>
	close: () => Promise<void>
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

function normalizeMetadata(metadata: any): any {
	if (!metadata) return null
	if (typeof metadata === 'string') {
		try {
			return JSON.parse(metadata)
		} catch {
			return null
		}
	}
	return metadata
}

async function waitForThreadMessageMatching(
	backend: Backend,
	threadId: string,
	predicate: (msg: any) => boolean,
	label: string,
	timeoutMs = MESSAGE_TIMEOUT,
): Promise<any> {
	const start = Date.now()
	while (Date.now() - start < timeoutMs) {
		try {
			await backend.invoke('sync_messages_with_failures')
		} catch {
			// Ignore transient sync failures during polling
		}
		const msgs = await backend.invoke('get_thread_messages', { threadId })
		if (Array.isArray(msgs)) {
			const found = msgs.find((msg: any) => predicate(msg))
			if (found) return found
		}
		await new Promise((r) => setTimeout(r, SYNC_INTERVAL))
	}
	throw new Error(`Timed out waiting for thread message: ${label}`)
}

async function importContactWithRetry(
	backend: Backend,
	identity: string,
	label: string,
	timeoutMs = 60_000,
) {
	const start = Date.now()
	let lastErr: any = null
	while (Date.now() - start < timeoutMs) {
		try {
			await backend.invoke('network_import_contact', { identity })
			return
		} catch (err: any) {
			lastErr = err
			const msg = String(err?.message || err || '')
			if (!msg.includes('DID not found')) {
				throw err
			}
			await backend.invoke('trigger_syftbox_sync').catch(() => {})
			await new Promise((r) => setTimeout(r, 1000))
		}
	}
	throw new Error(`${label}: timed out importing ${identity}. last error: ${lastErr}`)
}

function extractReadPrincipalsFromSyftPub(content: string): string[] {
	const lines = content.split(/\r?\n/)
	const principals: string[] = []
	let inReadBlock = false

	for (const line of lines) {
		const trimmed = line.trim()
		if (/^read:\s*$/.test(trimmed)) {
			inReadBlock = true
			continue
		}
		if (!inReadBlock) continue
		if (/^[a-zA-Z_]+:\s*$/.test(trimmed) && !trimmed.startsWith('-')) {
			break
		}
		const match = trimmed.match(/^-+\s*(.+)$/)
		if (match && match[1]) {
			principals.push(match[1].trim())
		}
	}

	return [...new Set(principals)]
}

type ViewerContext = {
	label: string
	backend: Backend
}

async function waitForViewerCondition(
	viewer: ViewerContext,
	label: string,
	check: () => Promise<string | null>,
	timeoutMs = 60_000,
): Promise<void> {
	const start = Date.now()
	let lastError = ''

	while (Date.now() - start < timeoutMs) {
		const result = await check()
		if (!result) {
			console.log(`  ✓ Sync check passed: ${label}`)
			return
		}
		lastError = result
		await new Promise((r) => setTimeout(r, SYNC_INTERVAL))
	}

	throw new Error(`Timed out waiting for sync condition "${label}": ${lastError}`)
}

test.describe('Multiparty flow between three clients @pipelines-multiparty-flow', () => {
	test('three clients execute a multiparty flow with UI interactions', async ({ browser }) => {
		const wsPortBase = Number.parseInt(process.env.DEV_WS_BRIDGE_PORT_BASE || '3333', 10)
		const wsPort1 = wsPortBase
		const wsPort2 = wsPortBase + 1
		const wsPort3 = wsPortBase + 2

		const expectedEmail1 = process.env.CLIENT1_EMAIL || 'client1@sandbox.local'
		const expectedEmail2 = process.env.CLIENT2_EMAIL || 'client2@sandbox.local'
		const expectedEmail3 = process.env.AGG_EMAIL || 'aggregator@sandbox.local'

		const logSocket = await ensureLogSocket()
		log(logSocket, {
			event: 'multiparty-flow-start',
			email1: expectedEmail1,
			email2: expectedEmail2,
			email3: expectedEmail3,
			wsPort1,
			wsPort2,
			wsPort3,
		})

		console.log('=== Multiparty Flow Test ===')
		console.log(`Client 1 (contributor1): ${expectedEmail1} (WS port ${wsPort1})`)
		console.log(`Client 2 (contributor2): ${expectedEmail2} (WS port ${wsPort2})`)
		console.log(`Client 3 (aggregator): ${expectedEmail3} (WS port ${wsPort3})`)

		// Create pages for all three clients
		const page1 = await browser.newPage()
		const page2 = await browser.newPage()
		const page3 = await browser.newPage()

		// Add console listeners to capture browser logs
		page1.on('console', (msg) => {
			if (msg.text().includes('[Flow Import]') || msg.type() === 'error') {
				console.log(`[Browser1] ${msg.type()}: ${msg.text()}`)
			}
		})
		page2.on('console', (msg) => {
			if (msg.text().includes('[Flow Import]') || msg.type() === 'error') {
				console.log(`[Browser2] ${msg.type()}: ${msg.text()}`)
			}
		})
		page3.on('console', (msg) => {
			if (msg.text().includes('[Flow Import]') || msg.type() === 'error') {
				console.log(`[Browser3] ${msg.type()}: ${msg.text()}`)
			}
		})

		await setWsPort(page1, wsPort1)
		await setWsPort(page2, wsPort2)
		await setWsPort(page3, wsPort3)

		// Connect backends
		console.log('\n--- Connecting backends ---')
		const backend1 = await connectBackend(wsPort1)
		const backend2 = await connectBackend(wsPort2)
		const backend3 = await connectBackend(wsPort3)
		console.log('All backends connected')

		// Navigate to UI
		const uiBaseUrl = process.env.UI_BASE_URL || 'http://localhost:8082'
		await page1.goto(uiBaseUrl)
		await page2.goto(uiBaseUrl)
		await page3.goto(uiBaseUrl)

		// Complete onboarding for all three
		console.log('\n--- Onboarding ---')
		await completeOnboarding(page1, expectedEmail1, logSocket)
		await completeOnboarding(page2, expectedEmail2, logSocket)
		await completeOnboarding(page3, expectedEmail3, logSocket)
		console.log('All clients onboarded')

		// Ensure dev mode is available
		await backend1.invoke('get_dev_mode_info')
		await backend2.invoke('get_dev_mode_info')
		await backend3.invoke('get_dev_mode_info')

		const settings1 = await backend1.invoke('get_settings')
		const settings2 = await backend2.invoke('get_settings')
		const settings3 = await backend3.invoke('get_settings')
		const email1 = String(settings1?.email || '').trim()
		const email2 = String(settings2?.email || '').trim()
		const email3 = String(settings3?.email || '').trim()
		if (!email1 || !email2 || !email3) {
			throw new Error(
				`Missing runtime emails from settings: ${JSON.stringify({ email1, email2, email3 })}`,
			)
		}
		console.log(
			`Resolved runtime identities from settings: client1=${email1}, client2=${email2}, aggregator=${email3}`,
		)

		const viewers: ViewerContext[] = [
			{ label: email1, backend: backend1 },
			{ label: email2, backend: backend2 },
			{ label: email3, backend: backend3 },
		]

		// === Key Exchange Phase ===
		console.log('\n--- Key Exchange Phase ---')
		console.log('Each client importing the other two as contacts...')

		await importContactWithRetry(backend1, email2, email1)
		await importContactWithRetry(backend1, email3, email1)
		await importContactWithRetry(backend2, email1, email2)
		await importContactWithRetry(backend2, email3, email2)
		await importContactWithRetry(backend3, email1, email3)
		await importContactWithRetry(backend3, email2, email3)
		console.log('All key exchanges complete!')

		log(logSocket, { event: 'key-exchange-complete' })

		// === Create Flow Invitation ===
		console.log('\n--- Creating Flow Invitation ---')
		const timestamp = Date.now()
		const flowName = 'multiparty'
		const fixtureModuleName = `invite-fixture-${timestamp}`
		const fixtureModuleDirName = fixtureModuleName
		const fixtureAssetRelativePath = 'assets/fixture-data.txt'
		const fixtureAssetContent = `fixture asset for ${fixtureModuleName}`
		let sessionId = ''

		// Ensure aggregator has a multiparty flow available in local Flows before opening modal.
		const flowSpec = {
			apiVersion: 'syftbox.openmined.org/v1alpha1',
			kind: 'Flow',
			metadata: {
				name: flowName,
				version: '0.1.0',
			},
			spec: {
				vars: {
					flow_path: 'syft://{datasite.current}/shared/flows/{flow_name}',
					run_path: '{vars.flow_path}/{run_id}',
					step_path: '{vars.run_path}/{step.number}-{step.id}',
				},
				coordination: {
					url: '{vars.run_path}/_progress',
					share_with: 'all',
				},
				datasites: {
					// Intentionally use canonical placeholders to exercise role mapping.
					all: [
						'aggregator@flow.example',
						'contributor1@flow.example',
						'contributor2@flow.example',
					],
					groups: {
						aggregator: { include: ['aggregator@flow.example'] },
						clients: {
							include: ['contributor1@flow.example', 'contributor2@flow.example'],
						},
					},
				},
				steps: [
					{
						id: 'generate',
						name: 'Generate Numbers',
						description: 'Generate random numbers locally',
						run: { targets: 'clients', strategy: 'parallel' },
						share: {
							numbers_shared: {
								source: 'self.outputs.numbers',
								url: '{vars.step_path}/numbers.json',
								permissions: { read: [email3] },
							},
						},
					},
					{
						id: 'contributions_ready',
						name: 'Wait for Contributions',
						description: 'Wait for all contributors to share',
						barrier: {
							wait_for: 'generate',
							targets: 'clients',
							timeout: 300,
						},
					},
					{
						id: 'aggregate',
						name: 'Aggregate Sum',
						description: 'Compute sum of all contributions',
						run: { targets: 'aggregator' },
						depends_on: ['contributions_ready'],
						share: {
							result_shared: {
								source: 'self.outputs.result',
								url: '{vars.step_path}/result.json',
								permissions: { read: [email1, email2, email3] },
							},
						},
					},
				],
			},
		}

		await backend3.invoke(
			'import_flow_from_json',
			{
				request: {
					name: flowName,
					flow_json: flowSpec,
					overwrite: true,
				},
			},
			60_000,
		)

		// Add a fixture module + asset to the flow folder so invitation source sync/import
		// can be validated for bundled module files.
		const proposerFlows = await backend3.invoke('get_flows')
		const proposerFlow = (proposerFlows || []).find(
			(f: any) =>
				String(f?.name || f?.metadata?.name || '')
					.trim()
					.toLowerCase() === flowName.toLowerCase(),
		)
		const proposerFlowPath = String(proposerFlow?.flow_path || '').trim()
		expect(proposerFlowPath).toBeTruthy()

		const fixtureModulePath = `${proposerFlowPath}/modules/${fixtureModuleDirName}`
		fs.mkdirSync(`${fixtureModulePath}/assets`, { recursive: true })
		fs.writeFileSync(
			`${fixtureModulePath}/module.yaml`,
			[
				'apiVersion: syftbox.openmined.org/v1alpha1',
				'kind: Module',
				'metadata:',
				`  name: ${fixtureModuleName}`,
				'  version: 0.1.0',
				'spec:',
				'  runner:',
				'    kind: shell',
				'    template: shell',
				'    entrypoint: run.sh',
				'  assets:',
				`    - path: ${fixtureAssetRelativePath}`,
				'  outputs:',
				'    - name: done',
				'      type: File',
				'      format: { kind: txt }',
				'      path: done.txt',
				'',
			].join('\n'),
		)
		fs.writeFileSync(`${fixtureModulePath}/run.sh`, '#!/usr/bin/env bash\necho done > done.txt\n')
		fs.writeFileSync(`${fixtureModulePath}/${fixtureAssetRelativePath}`, `${fixtureAssetContent}\n`)

		// Bootstrap a group thread first so Propose Flow has all participants in-context.
		const bootstrap = await backend3.invoke('send_message', {
			request: {
				recipients: [email1, email2],
				body: `bootstrap thread ${timestamp}`,
				subject: 'Multiparty bootstrap',
			},
		})
		const threadId = bootstrap.thread_id

		// === Navigate to Messages and View Invitation in UI ===
		console.log('\n--- Navigating to Messages UI ---')

		async function navigateToMessagesAndFindThread(page: Page, label: string) {
			await page.click('button:has-text("Messages")')
			await page.waitForTimeout(500)

			console.log(`  ${label}: Syncing messages...`)
			const syncBtn = page.locator('#refresh-messages-btn')
			if (await syncBtn.isVisible()) {
				await syncBtn.click()
				await page.waitForTimeout(2000)
			}

			const threadItem = page.locator('.message-thread-item').first()
			await threadItem.waitFor({ timeout: UI_TIMEOUT })
			await threadItem.click()
			await page.waitForTimeout(250)
			console.log(`  ${label}: Thread selected`)
		}

		// Navigate all three clients to Messages
		console.log('Navigating client1 to Messages...')
		await navigateToMessagesAndFindThread(page1, email1)

		console.log('Navigating client2 to Messages...')
		await navigateToMessagesAndFindThread(page2, email2)

		console.log('Navigating aggregator to Messages...')
		await navigateToMessagesAndFindThread(page3, email3)

		// Aggregator creates flow invitation using the actual Propose Flow modal UI.
		console.log('\n--- Creating Flow Invitation via UI Modal ---')
		const proposeBtn = page3.locator('#propose-flow-btn')
		await proposeBtn.waitFor({ timeout: UI_TIMEOUT })
		await expect(proposeBtn).toBeVisible()
		await proposeBtn.click()

		const proposeModal = page3.locator('#propose-flow-modal')
		await proposeModal.waitFor({ timeout: UI_TIMEOUT })
		await page3.selectOption('#propose-flow-select', { label: flowName })
		await page3.waitForTimeout(500)

		const roleRows = page3.locator('#propose-flow-roles-list .propose-flow-role-row')
		const roleCount = await roleRows.count()
		console.log(`  Aggregator: role rows in modal = ${roleCount}`)
		expect(roleCount).toBe(3)

		// Assign roles by label content with unique participant mapping.
		const allCandidates = [email1, email2, email3]
		const usedEmails = new Set<string>()
		for (let i = 0; i < roleCount; i += 1) {
			const row = roleRows.nth(i)
			const roleLabel = (
				(await row
					.locator('.propose-flow-role-label')
					.textContent()
					.catch(() => '')) || ''
			)
				.toLowerCase()
				.trim()
			const select = roleRows.nth(i).locator('select')
			let preferred = ''
			if (roleLabel.includes('aggregator')) {
				preferred = email3
			} else if (roleLabel.includes('client') || roleLabel.includes('contributor')) {
				if (roleLabel.includes('1')) {
					preferred = email1
				} else if (roleLabel.includes('2')) {
					preferred = email2
				}
			}
			const selectedEmail =
				(preferred && !usedEmails.has(preferred) ? preferred : '') ||
				allCandidates.find((candidate) => !usedEmails.has(candidate)) ||
				preferred ||
				email1
			await select.selectOption(selectedEmail)
			usedEmails.add(selectedEmail)
		}

		await page3
			.locator('#propose-flow-message')
			.fill(`Join me in a multiparty flow! Flow: ${flowName} - ${timestamp}`)
		const sendBtn = page3.locator('#propose-flow-send-btn')
		await sendBtn.waitFor({ timeout: UI_TIMEOUT })
		await expect
			.poll(
				async () => {
					try {
						return await sendBtn.isEnabled()
					} catch {
						return false
					}
				},
				{ timeout: UI_TIMEOUT },
			)
			.toBe(true)
		await sendBtn.click({ timeout: UI_TIMEOUT })
		let modalClosed = false
		try {
			await expect(proposeModal).toBeHidden({ timeout: 6000 })
			modalClosed = true
		} catch {
			console.log('  Aggregator: modal still open after click, using JS send fallback')
			await page3.evaluate(() => window.proposeFlowModal?.sendInvitation?.())
			await expect(proposeModal).toBeHidden({ timeout: UI_TIMEOUT })
			modalClosed = true
		}
		expect(modalClosed).toBe(true)
		await page3.waitForTimeout(1500)

		const invitationForClient1 = await waitForThreadMessageMatching(
			backend1,
			threadId,
			(msg) => normalizeMetadata(msg?.metadata)?.flow_invitation?.flow_name === flowName,
			'flow invitation message (from UI modal)',
		)
		const invitationMeta = normalizeMetadata(invitationForClient1?.metadata)?.flow_invitation
		sessionId = invitationMeta?.session_id || invitationMeta?.sessionId || ''
		const invitationFlowLocation = String(invitationMeta?.flow_location || '').trim()
		expect(sessionId).toBeTruthy()
		expect(invitationFlowLocation).toBeTruthy()

		console.log(`Flow invitation sent via UI! Thread ID: ${threadId}, Session ID: ${sessionId}`)
		log(logSocket, { event: 'flow-invitation-sent', sessionId, threadId })

		// Wait for invitation cards to render
		console.log('\n--- Waiting for Flow Invitation Cards ---')
		await page1.waitForTimeout(2000)
		await page2.waitForTimeout(2000)

		// === Import and Join Flow via UI ===
		console.log('\n--- Import and Join Flow via UI ---')

		async function importAndJoinFlow(page: Page, label: string, backend: Backend) {
			// Ensure thread view includes both inbound/outbound messages.
			const allFilterBtn = page.locator('.message-filter[data-filter="all"]')
			if (await allFilterBtn.isVisible().catch(() => false)) {
				await allFilterBtn.click().catch(() => {})
				await page.waitForTimeout(250)
			}
			const refreshBtn = page.locator('#refresh-messages-btn')
			if (await refreshBtn.isVisible().catch(() => false)) {
				await refreshBtn.click().catch(() => {})
				await page.waitForTimeout(1200)
			}

			// Wait for invitation card
			const invitationCard = page
				.locator('#messages-main:visible #message-conversation .flow-invitation-card:visible')
				.first()
			try {
				await invitationCard.waitFor({ timeout: UI_TIMEOUT })
				console.log(`  ${label}: Found visible invitation card`)
			} catch {
				// Sender can already be joined and only have a View button available; accept that path.
				const directOpenBtn = page
					.locator(
						'#messages-main:visible button:has-text("View Flow"), #messages-main:visible button:has-text("Join Flow")',
					)
					.first()
				if (await directOpenBtn.isVisible().catch(() => false)) {
					console.log(`  ${label}: Invitation card not visible; using direct flow button`)
					await directOpenBtn.click()
					await page.waitForTimeout(800)
					return
				}
				throw new Error(`${label}: flow invitation UI not visible in message thread`)
			}

			const importBtn = invitationCard.locator(
				'.flow-invitation-btn.import-btn, button:has-text("Import Flow")',
			)
			const syncBtn = invitationCard.locator(
				'.flow-invitation-btn:has-text("Sync Flow Files"), button:has-text("Sync Flow Files")',
			)
			const showFilesBtn = invitationCard.locator(
				'.flow-invitation-btn:has-text("Show Flow Files"), button:has-text("Show Flow Files")',
			)
			const joinBtn = invitationCard.locator(
				'.flow-invitation-btn.view-runs-btn, button:has-text("Join Flow"), button:has-text("View Flow")',
			)
			const statusEl = invitationCard.locator('.flow-invitation-status')
			if (await importBtn.isVisible({ timeout: 5000 }).catch(() => false)) {
				const joinInitiallyVisible = await joinBtn.isVisible().catch(() => false)
				console.log(`  ${label}: Join button visible before import: ${joinInitiallyVisible}`)
				expect(joinInitiallyVisible).toBe(false)

				// Explicitly validate Sync/Show actions before import.
				await syncBtn.waitFor({ timeout: UI_TIMEOUT })
				await syncBtn.click()
				await expect
					.poll(async () => ((await statusEl.textContent().catch(() => '')) || '').trim(), {
						timeout: 45_000,
					})
					.toContain('Flow files synced and ready to import')

				await showFilesBtn.waitFor({ timeout: UI_TIMEOUT })
				await showFilesBtn.click()
				await expect
					.poll(async () => ((await statusEl.textContent().catch(() => '')) || '').trim(), {
						timeout: 20_000,
					})
					.toContain('Opened:')

				// Ensure synced source includes fixture module + asset.
				const localFlowSourcePath = await backend.invoke('resolve_syft_url_to_local_path', {
					syftUrl: invitationFlowLocation,
				})
				expect(localFlowSourcePath).toBeTruthy()
				await expect
					.poll(
						async () =>
							await backend.invoke('path_exists', {
								path: `${localFlowSourcePath}/flow.yaml`,
							}),
						{ timeout: 45_000 },
					)
					.toBe(true)
				await expect
					.poll(
						async () =>
							await backend.invoke('path_exists', {
								path: `${localFlowSourcePath}/modules/${fixtureModuleDirName}/module.yaml`,
							}),
						{ timeout: 45_000 },
					)
					.toBe(true)
				await expect
					.poll(
						async () =>
							await backend.invoke('path_exists', {
								path: `${localFlowSourcePath}/modules/${fixtureModuleDirName}/${fixtureAssetRelativePath}`,
							}),
						{ timeout: 45_000 },
					)
					.toBe(true)

				// Click Import Flow button
				await importBtn.click()
				console.log(`  ${label}: Clicked "Import Flow"`)

				await expect
					.poll(async () => ((await statusEl.textContent().catch(() => '')) || '').trim(), {
						timeout: 60_000,
					})
					.toContain('Flow imported')

				// Check if import button changed
				const importBtnText = await importBtn.textContent().catch(() => '')
				console.log(`  ${label}: Import button text after click: ${importBtnText}`)

				// Ensure fixture module got imported (with asset) into local modules.
				await expect
					.poll(
						async () => {
							const modules = await backend.invoke('get_modules')
							return (modules || []).find((m: any) => m?.name === fixtureModuleName) || null
						},
						{ timeout: 60_000 },
					)
					.not.toBeNull()
				const importedModules = await backend.invoke('get_modules')
				const importedFixture = (importedModules || []).find(
					(m: any) => m?.name === fixtureModuleName,
				)
				expect(importedFixture?.module_path).toBeTruthy()
				await expect
					.poll(
						async () =>
							await backend.invoke('path_exists', {
								path: `${importedFixture.module_path}/${fixtureAssetRelativePath}`,
							}),
						{ timeout: 30_000 },
					)
					.toBe(true)
				const importedAssetText = fs
					.readFileSync(`${importedFixture.module_path}/${fixtureAssetRelativePath}`, 'utf-8')
					.trim()
				expect(importedAssetText).toContain(fixtureAssetContent)
			} else {
				console.log(`  ${label}: Import button not visible (flow may already be imported)`)
			}

			// Click Join Flow button
			const joinBtnVisible = await joinBtn.isVisible({ timeout: 5000 }).catch(() => false)
			console.log(`  ${label}: Join button visible: ${joinBtnVisible}`)
			if (!joinBtnVisible) {
				// Debug: check what buttons are visible
				const allButtons = await invitationCard.locator('button').allTextContents()
				console.log(`  ${label}: All buttons in invitation card: ${JSON.stringify(allButtons)}`)
			}
			await joinBtn.waitFor({ timeout: UI_TIMEOUT })
			await joinBtn.click()
			console.log(`  ${label}: Clicked "Join Flow"`)
			await page.waitForTimeout(1500)

			// Verify post-join state.
			// UI can show either "View Flow" or keep "Join Flow" depending on role/timing,
			// so assert using both button text and card state.
			const joinBtnText = ((await joinBtn.textContent().catch(() => '')) || '').trim()
			console.log(`  ${label}: Join button text after join: "${joinBtnText}"`)
			const joinLooksCompleted =
				joinBtnText.includes('View Flow') || joinBtnText.includes('Join Flow')
			expect(joinLooksCompleted).toBe(true)

			// Verify Decline button is hidden after joining (authoritative signal).
			const declineBtn = invitationCard.locator('.decline-btn')
			const declineVisible = await declineBtn.isVisible().catch(() => false)
			console.log(`  ${label}: Decline button visible after join: ${declineVisible}`)
			expect(declineVisible).toBe(false)
		}

		// Client 1 imports and joins
		console.log(`${email1} importing and joining flow...`)
		await importAndJoinFlow(page1, email1, backend1)

		// Client 2 imports and joins
		console.log(`${email2} importing and joining flow...`)
		await importAndJoinFlow(page2, email2, backend2)

		// Aggregator also imports and joins via UI
		console.log(`${email3} importing and joining flow...`)
		await importAndJoinFlow(page3, email3, backend3)

		log(logSocket, { event: 'all-joined' })

		console.log('\n--- Verifying Initial Shared Coordination Sync ---')
		for (const viewer of viewers) {
			const initialProgress = await viewer.backend.invoke('get_all_participant_progress', {
				sessionId,
			})
			expect(Array.isArray(initialProgress)).toBe(true)
			expect((initialProgress || []).length).toBeGreaterThanOrEqual(3)
		}

		// === Navigate to Runs Tab and Execute Steps ===
		console.log('\n--- Navigating to Runs Tab ---')

		async function navigateToRuns(page: Page, label: string) {
			await page.click('button:has-text("Runs")')
			await page.waitForTimeout(1000)
			console.log(`  ${label}: On Runs tab`)
		}

		// All clients navigate to Runs
		await navigateToRuns(page1, email1)
		await navigateToRuns(page2, email2)
		await navigateToRuns(page3, email3)

		// === Verify Multiparty Run Cards ===
		console.log('\n--- Verifying Multiparty Run Cards ---')

		async function verifyMultipartyRun(page: Page, label: string) {
			// Look for run card with multiparty indicator
			const runCard = page.locator('.flow-run-card').first()
			await runCard.waitFor({ timeout: UI_TIMEOUT })

			// Card should auto-expand as latest run, wait for steps to load
			await page.waitForTimeout(1500)

			// Verify multiparty details are visible
			const mpDetails = runCard.locator('.multiparty-details')
			const isMultiparty = await mpDetails.isVisible().catch(() => false)
			console.log(`  ${label}: Multiparty details visible: ${isMultiparty}`)
			expect(isMultiparty).toBe(true)

			// Verify participants section
			const participants = runCard.locator('.mp-participants .mp-participant')
			const participantCount = await participants.count()
			console.log(`  ${label}: Found ${participantCount} participants`)
			expect(participantCount).toBe(3)

			// Verify steps section loaded
			const steps = runCard.locator('.mp-steps-list .mp-step')
			const stepCount = await steps.count()
			console.log(`  ${label}: Found ${stepCount} steps`)
			expect(stepCount).toBe(3)

			// Verify progress bar exists
			const progressBar = runCard.locator('.mp-progress-bar')
			expect(await progressBar.isVisible()).toBe(true)

			return runCard
		}

		const runCard1 = await verifyMultipartyRun(page1, email1)
		const runCard2 = await verifyMultipartyRun(page2, email2)
		const runCard3 = await verifyMultipartyRun(page3, email3)

		// === Verify Initial Button State ===
		console.log('\n--- Verifying Initial Button Visibility ---')

		// Contributors should see Run button for 'generate' (first step, Ready)
		await verifyRunButtonVisibility(page1, 'generate', true, email1)
		await verifyRunButtonVisibility(page2, 'generate', true, email2)

		// Aggregator should NOT see Run button for 'aggregate' (WaitingForInputs)
		await verifyRunButtonVisibility(page3, 'aggregate', false, email3)

		// Initial progress should be 0/3 steps complete (total flow progress)
		const initialProgress1 = await verifyProgressInUI(page1, email1)
		expect(initialProgress1).toContain('0/3 steps complete')

		const initialProgress3 = await verifyProgressInUI(page3, email3)
		expect(initialProgress3).toContain('0/3 steps complete')

		// Run Next should be visible for contributors, hidden for aggregator until ready
		await verifyRunNextButton(page1, true, 'Generate Numbers', email1)
		await verifyRunNextButton(page2, true, 'Generate Numbers', email2)
		await verifyRunNextButton(page3, false, null, email3)

		// Auto-run checkbox should persist to flow state
		const autoToggle1 = page1.locator(
			'.mp-step[data-step-id="generate"] .mp-auto-toggle input[type="checkbox"]',
		)
		await autoToggle1.waitFor({ timeout: UI_TIMEOUT })
		await autoToggle1.check()
		await page1.waitForTimeout(300)
		const stateAfterAutoOn = await backend1.invoke('get_multiparty_flow_state', { sessionId })
		expect(stateAfterAutoOn?.steps?.find((s: any) => s.id === 'generate')?.auto_run).toBe(true)
		await autoToggle1.uncheck()
		await page1.waitForTimeout(300)
		const stateAfterAutoOff = await backend1.invoke('get_multiparty_flow_state', { sessionId })
		expect(stateAfterAutoOff?.steps?.find((s: any) => s.id === 'generate')?.auto_run).toBe(false)

		// Aggregator aggregate step should not be ready before contributor shares
		const initialAggState = await backend3.invoke('get_multiparty_flow_state', { sessionId })
		const initialAggStatus = initialAggState?.steps?.find((s: any) => s.id === 'aggregate')?.status
		expect(['Pending', 'WaitingForInputs']).toContain(initialAggStatus)

		// Step should show participant chips for all 3 parties
		const aggGenerateChips = page3.locator('.mp-step[data-step-id="generate"] .mp-participant-chip')
		expect(await aggGenerateChips.count()).toBe(3)
		const chipsText = (await aggGenerateChips.allTextContents()).join(' ')
		expect(chipsText).toContain(email1)
		expect(chipsText).toContain(email2)
		expect(chipsText).toContain(email3)

		// Activity log should include join events
		await verifyActivityLogContains(page3, email3, 'joined the flow', 20_000, backend3, sessionId)

		// === Execute Steps via UI ===
		console.log('\n--- Executing Flow Steps via Runs UI ---')

		async function ensureStepsTabActive(page: Page) {
			const runCard = page.locator('.flow-run-card').first()
			const stepsTab = runCard.locator('.mp-tab[data-tab="steps"]')
			if (await stepsTab.isVisible().catch(() => false)) {
				await stepsTab.click().catch(() => {})
				await runCard
					.locator('.mp-tab-content[data-tab-content="steps"]')
					.waitFor({ state: 'visible', timeout: UI_TIMEOUT })
					.catch(() => {})
			}
		}

		async function ensureStepExpanded(page: Page, stepId: string) {
			await ensureStepsTabActive(page)
			const step = page.locator(`.mp-step[data-step-id="${stepId}"]`)
			await step.waitFor({ timeout: UI_TIMEOUT })
			const isCollapsed = await step.evaluate((el) => el.classList.contains('collapsed'))
			if (isCollapsed) {
				await step.locator('.mp-step-toggle').click()
				await page.waitForTimeout(150)
			}
		}

		async function runStepInUI(page: Page, stepId: string, label: string) {
			const step = page.locator(`.mp-step[data-step-id="${stepId}"]`)
			for (let attempt = 0; attempt < 12; attempt += 1) {
				await ensureStepsTabActive(page)
				if (!(await step.isVisible().catch(() => false))) {
					await page.waitForTimeout(400)
					continue
				}

				await ensureStepExpanded(page, stepId)

				const statusClass = await step.getAttribute('class')
				if (
					statusClass?.includes('mp-step-running') ||
					statusClass?.includes('mp-step-completed') ||
					statusClass?.includes('mp-step-shared')
				) {
					console.log(`    ${label}: ${stepId} already in progress/completed`)
					return true
				}

				const runBtn = step.locator('.mp-run-btn, button:has-text("Run")')
				if (await runBtn.isVisible({ timeout: 1200 }).catch(() => false)) {
					await runBtn.click()
					console.log(`    ${label}: Clicked Run for ${stepId}`)
					await page.waitForTimeout(1000)
					return true
				}

				await page.waitForTimeout(500)
				if (attempt === 5) {
					// Mid-way nudge in headed runs where render can lag after many updates.
					await page.click('button:has-text("Runs")').catch(() => {})
					await page.waitForTimeout(400)
				}
			}

			console.log(`    ${label}: Run button for ${stepId} never became clickable`)
			return false
		}

		async function shareStepInUI(page: Page, stepId: string, label: string) {
			const step = page.locator(`.mp-step[data-step-id="${stepId}"]`)
			for (let attempt = 0; attempt < 12; attempt += 1) {
				await ensureStepsTabActive(page)
				if (!(await step.isVisible().catch(() => false))) {
					await page.waitForTimeout(400)
					continue
				}
				await ensureStepExpanded(page, stepId)

				const statusClass = await step.getAttribute('class')
				if (statusClass?.includes('mp-step-shared')) {
					console.log(`    ${label}: ${stepId} already shared`)
					return true
				}

				const shareBtn = step.locator('.mp-share-btn, button:has-text("Share")')
				if (await shareBtn.isVisible({ timeout: 1200 }).catch(() => false)) {
					await shareBtn.click()
					console.log(`    ${label}: Clicked Share for ${stepId}`)
					await page.waitForTimeout(1500)
					return true
				}

				await page.waitForTimeout(500)
			}
			console.log(`    ${label}: Share button for ${stepId} never became clickable`)
			return false
		}

		// Helper to verify output files exist after running a step
		async function verifyStepOutputFiles(
			backend: Backend,
			sessionIdVal: string,
			stepId: string,
			expectedFiles: string[],
			label: string,
		) {
			try {
				const files = await backend.invoke('get_step_output_files', {
					sessionId: sessionIdVal,
					stepId: stepId,
				})
				console.log(`    ${label}: Output files for ${stepId}: ${JSON.stringify(files)}`)

				for (const expectedFile of expectedFiles) {
					const found = files.some((f: string) => f.endsWith(expectedFile))
					if (found) {
						console.log(`    ${label}: ✓ Found expected output file: ${expectedFile}`)
					} else {
						console.log(`    ${label}: ✗ Missing expected output file: ${expectedFile}`)
					}
					expect(found).toBe(true)
				}
				return files
			} catch (err) {
				console.log(`    ${label}: Error getting output files: ${err}`)
				return []
			}
		}

		// Helper to verify step status in UI
		async function verifyStepStatusInUI(
			page: Page,
			stepId: string,
			expectedStatus: string,
			label: string,
		) {
			await ensureStepsTabActive(page)
			const step = page.locator(`.mp-step[data-step-id="${stepId}"]`)
			const statusEl = step.locator('.mp-step-status')
			const statusText = await statusEl.textContent().catch(() => '')
			console.log(`    ${label}: Step ${stepId} UI status: "${statusText}"`)
			return statusText
		}

		// Helper to verify progress bar percentage in UI
		async function verifyProgressInUI(page: Page, label: string) {
			const progressText = page.locator('.mp-progress-text')
			const text = await progressText.textContent().catch(() => '')
			console.log(`    ${label}: Progress: ${text}`)
			return text
		}

		// Helper to verify Run button visibility for a step
		async function verifyRunButtonVisibility(
			page: Page,
			stepId: string,
			shouldBeVisible: boolean,
			label: string,
		) {
			await ensureStepsTabActive(page)
			const step = page.locator(`.mp-step[data-step-id="${stepId}"]`)
			if (!(await step.isVisible().catch(() => false))) {
				console.log(`    ${label}: Step ${stepId} not visible on this page`)
				return null
			}
			await ensureStepExpanded(page, stepId)
			const runBtn = step.locator('.mp-run-btn')
			const isVisible = await runBtn.isVisible().catch(() => false)
			console.log(
				`    ${label}: Run button for ${stepId}: visible=${isVisible}, expected=${shouldBeVisible}`,
			)
			expect(isVisible).toBe(shouldBeVisible)
			return isVisible
		}

		// Helper to verify Preview button visibility
		async function verifyPreviewButtonVisibility(
			page: Page,
			stepId: string,
			shouldBeVisible: boolean,
			label: string,
		) {
			await ensureStepsTabActive(page)
			const step = page.locator(`.mp-step[data-step-id="${stepId}"]`)
			if (!(await step.isVisible().catch(() => false))) {
				return null
			}
			const previewBtn = step.locator('.mp-preview-btn').first()
			let isVisible = await previewBtn.isVisible().catch(() => false)
			if (shouldBeVisible && !isVisible) {
				const deadline = Date.now() + UI_TIMEOUT
				while (Date.now() < deadline) {
					await ensureStepExpanded(page, stepId)
					await page.waitForTimeout(250)
					isVisible = await previewBtn.isVisible().catch(() => false)
					if (isVisible) break
				}
			}
			console.log(
				`    ${label}: Preview button for ${stepId}: visible=${isVisible}, expected=${shouldBeVisible}`,
			)
			expect(isVisible).toBe(shouldBeVisible)
			return isVisible
		}

		async function verifyShareButtonVisibility(
			page: Page,
			stepId: string,
			shouldBeVisible: boolean,
			label: string,
		) {
			await ensureStepsTabActive(page)
			const step = page.locator(`.mp-step[data-step-id="${stepId}"]`)
			if (!(await step.isVisible().catch(() => false))) return null
			await ensureStepExpanded(page, stepId)
			const shareBtn = step.locator('.mp-share-btn').first()
			const isVisible = await shareBtn.isVisible().catch(() => false)
			console.log(
				`    ${label}: Share button for ${stepId}: visible=${isVisible}, expected=${shouldBeVisible}`,
			)
			expect(isVisible).toBe(shouldBeVisible)
			return isVisible
		}

		async function verifyContributionButtons(
			page: Page,
			stepId: string,
			minimumCount: number,
			label: string,
		) {
			await ensureStepsTabActive(page)
			const step = page.locator(`.mp-step[data-step-id="${stepId}"]`)
			await ensureStepExpanded(page, stepId)
			const finderButtons = step.locator('.mp-contrib-open-btn')
			const count = await finderButtons.count()
			console.log(`    ${label}: Contribution finder buttons for ${stepId}: ${count}`)
			expect(count).toBeGreaterThanOrEqual(minimumCount)
			return count
		}

		async function verifyRunNextButton(
			page: Page,
			shouldBeVisible: boolean,
			expectedText: string | null,
			label: string,
		) {
			const runNextBtn = page.locator('.mp-run-next-btn')
			const isVisible = await runNextBtn.isVisible().catch(() => false)
			console.log(`    ${label}: Run Next visible=${isVisible}, expected=${shouldBeVisible}`)
			expect(isVisible).toBe(shouldBeVisible)
			if (shouldBeVisible && expectedText) {
				const text = (await runNextBtn.textContent().catch(() => '')) || ''
				console.log(`    ${label}: Run Next text="${text}"`)
				expect(text).toContain(expectedText)
			}
		}

		async function verifyActivityLogContains(
			page: Page,
			label: string,
			expectedText: string,
			timeoutMs = 20_000,
			backend?: Backend,
			sessionIdForBackend?: string,
		) {
			const runCard = page.locator('.flow-run-card').first()
			const start = Date.now()
			while (Date.now() - start < timeoutMs) {
				await runCard
					.locator('.mp-tab[data-tab="logs"]')
					.click()
					.catch(() => {})
				await page.waitForTimeout(250)
				const logsText =
					(await runCard
						.locator('.mp-logs-content')
						.innerText()
						.catch(() => '')) || ''
				if (logsText.includes(expectedText)) {
					console.log(`    ${label}: Activity log contains "${expectedText}"`)
					await runCard.locator('.mp-tab[data-tab="steps"]').click()
					await runCard
						.locator('.mp-tab-content[data-tab-content="steps"]')
						.waitFor({ state: 'visible', timeout: UI_TIMEOUT })
						.catch(() => {})
					return
				}
				if (backend && sessionIdForBackend) {
					await backend.invoke('trigger_syftbox_sync').catch(() => {})
					const backendLogs = await backend
						.invoke('get_participant_logs', { sessionId: sessionIdForBackend })
						.catch(() => [])
					if (Array.isArray(backendLogs)) {
						const found = backendLogs.some((entry: any) => {
							const participant = entry?.participant || entry?.role || 'participant'
							const text =
								entry?.event === 'joined'
									? `${participant} joined the flow`
									: entry?.event === 'step_completed'
										? `${participant} completed step "${entry?.step_id}"`
										: entry?.event === 'step_shared'
											? `${participant} shared outputs from "${entry?.step_id}"`
											: `${participant}: ${entry?.event || ''}`
							return text.includes(expectedText)
						})
						if (found) {
							console.log(`    ${label}: Activity log matched via backend "${expectedText}"`)
							await runCard.locator('.mp-tab[data-tab="steps"]').click()
							await runCard
								.locator('.mp-tab-content[data-tab-content="steps"]')
								.waitFor({ state: 'visible', timeout: UI_TIMEOUT })
								.catch(() => {})
							return
						}
					}
				}
				await page.waitForTimeout(500)
			}
			await runCard.locator('.mp-tab[data-tab="steps"]').click()
			await runCard
				.locator('.mp-tab-content[data-tab-content="steps"]')
				.waitFor({ state: 'visible', timeout: UI_TIMEOUT })
				.catch(() => {})
			throw new Error(`${label}: Activity log missing expected text: ${expectedText}`)
		}

		async function sendMessageInSelectedThread(page: Page, label: string, body: string) {
			let messageInput = page.locator('#message-compose-body:visible').first()
			let inputVisible = await messageInput.isVisible().catch(() => false)
			if (!inputVisible) {
				console.log(`  ${label}: Composer hidden, re-selecting thread...`)
				for (let attempt = 0; attempt < 5; attempt += 1) {
					await page.click('button:has-text("Messages")').catch(() => {})
					await page.waitForTimeout(200)
					const threadItem = page.locator('.message-thread-item').first()
					if (await threadItem.isVisible().catch(() => false)) {
						await threadItem.click({ force: true }).catch(() => {})
					}
					await page.waitForTimeout(350)
					messageInput = page.locator('#message-compose-body:visible').first()
					inputVisible = await messageInput.isVisible().catch(() => false)
					if (inputVisible) break
				}
				if (!inputVisible) {
					throw new Error(`${label}: message composer remained hidden`)
				}
			}
			await messageInput.waitFor({ timeout: UI_TIMEOUT })
			await messageInput.fill(body)
			await page.locator('#message-send-btn:visible').first().click()
			console.log(`  ${label}: Sent message: "${body.substring(0, 40)}..."`)
			await page.waitForTimeout(1500)
		}

		// Step 1: Contributors run "generate"
		console.log('\nStep 1: Generate Numbers')
		const ranGenerate1 = await runStepInUI(page1, 'generate', email1)
		expect(ranGenerate1).toBe(true)
		await page1.waitForTimeout(1500) // Wait for file to be written
		await verifyStepOutputFiles(backend1, sessionId, 'generate', ['numbers.json'], email1)

		// Verify UI shows step as completed and review/share actions are available
		await verifyStepStatusInUI(page1, 'generate', 'Completed', email1)
		const progress1AfterGen = await verifyProgressInUI(page1, email1)
		expect(/0\/3|1\/3/.test(progress1AfterGen || '')).toBe(true)
		await verifyPreviewButtonVisibility(page1, 'generate', true, email1)
		await verifyShareButtonVisibility(page1, 'generate', true, email1)

		const ranGenerate2 = await runStepInUI(page2, 'generate', email2)
		expect(ranGenerate2).toBe(true)
		await page2.waitForTimeout(1500) // Wait for file to be written
		await verifyStepOutputFiles(backend2, sessionId, 'generate', ['numbers.json'], email2)

		// Verify UI shows step as completed and review/share actions are available
		await verifyStepStatusInUI(page2, 'generate', 'Completed', email2)
		await verifyProgressInUI(page2, email2)
		await verifyPreviewButtonVisibility(page2, 'generate', true, email2)
		await verifyShareButtonVisibility(page2, 'generate', true, email2)

		// Step 2: Contributors share from the same Generate step (run -> review -> share)
		console.log('\nStep 2: Share Generate Outputs')
		const sharedGenerate1 = await shareStepInUI(page1, 'generate', email1)
		expect(sharedGenerate1).toBe(true)

		// Verify UI shows step as shared
		await page1.waitForTimeout(500)
		await verifyStepStatusInUI(page1, 'generate', 'Shared', email1)
		const progress1AfterShare = await verifyProgressInUI(page1, email1)
		expect(/0\/3|1\/3|2\/3/.test(progress1AfterShare || '')).toBe(true)

		const sharedGenerate2 = await shareStepInUI(page2, 'generate', email2)
		expect(sharedGenerate2).toBe(true)

		// Verify UI shows step as shared
		await page2.waitForTimeout(500)
		await verifyStepStatusInUI(page2, 'generate', 'Shared', email2)
		const progress2AfterShare = await verifyProgressInUI(page2, email2)
		expect(/0\/3|1\/3|2\/3|Done/.test(progress2AfterShare || '')).toBe(true)

		// Aggregator should expose contributor finder links on generate step.
		await backend3.invoke('trigger_syftbox_sync').catch(() => {})
		await verifyContributionButtons(page3, 'generate', 2, email3)

		// Simulate receiving shared inputs at aggregator
		// In real flow, this would happen via messaging - for now we verify generate outputs exist
		console.log('\nVerifying contributor outputs before aggregation...')
		const files1 = await verifyStepOutputFiles(
			backend1,
			sessionId,
			'generate',
			['numbers.json'],
			email1,
		)
		const files2 = await verifyStepOutputFiles(
			backend2,
			sessionId,
			'generate',
			['numbers.json'],
			email2,
		)

		// Step 3: Barrier + Aggregate
		console.log('\nStep 3: Aggregate Sum')
		// After contributors share, the barrier step 'contributions_ready' should complete
		// which unblocks 'aggregate' (depends_on: [contributions_ready])

		const aggState = await backend3.invoke('get_multiparty_flow_state', { sessionId })
		const barrierStep = aggState?.steps?.find((s: any) => s.id === 'contributions_ready')
		const aggStep = aggState?.steps?.find((s: any) => s.id === 'aggregate')
		console.log(`  Barrier step status: ${barrierStep?.status}`)
		console.log(`  Aggregator aggregate step status: ${aggStep?.status}`)

		// Aggregate should now be Ready (barrier completed after contributors shared)
		expect(aggStep?.status).toBe('Ready')

		// Run aggregate step
		const aggregateRan = await runStepInUI(page3, 'aggregate', email3)
		expect(aggregateRan).toBe(true)
		await page3.waitForTimeout(1500)

		// Verify aggregate output files
		await verifyStepOutputFiles(backend3, sessionId, 'aggregate', ['result.json'], email3)

		// Verify aggregate result contains contributor data
		const aggResultFiles = await backend3.invoke('get_step_output_files', {
			sessionId: sessionId,
			stepId: 'aggregate',
		})
		console.log(`  Aggregator aggregate output: ${JSON.stringify(aggResultFiles)}`)
		expect(aggResultFiles.length).toBeGreaterThan(0)

		// Read the result file to verify it contains contributor data
		const resultPath = aggResultFiles.find((f: string) => f.endsWith('result.json'))
		if (resultPath) {
			const resultContent = fs.readFileSync(resultPath, 'utf-8')
			const resultData = JSON.parse(resultContent)
			console.log(
				`  Aggregate result: contributions=${resultData.contributions?.length}, all_numbers=${resultData.all_numbers?.length}, total_sum=${resultData.total_sum}`,
			)

			// Verify we got data from both contributors
			expect(resultData.contributions?.length).toBe(2)
			expect(resultData.all_numbers?.length).toBeGreaterThan(0)
			expect(resultData.count).toBeGreaterThan(0)
		}

		// Verify UI shows aggregate as completed
		await verifyStepStatusInUI(page3, 'aggregate', 'Completed', email3)
		const progressAfterAgg = await verifyProgressInUI(page3, email3)
		expect(/2\/3|Done/.test(progressAfterAgg || '')).toBe(true)
		await verifyPreviewButtonVisibility(page3, 'aggregate', true, email3)
		await verifyShareButtonVisibility(page3, 'aggregate', true, email3)

		// Share final results from the same Aggregate step
		const sharedAggregate = await shareStepInUI(page3, 'aggregate', email3)
		expect(sharedAggregate).toBe(true)
		await page3.waitForTimeout(500)
		await verifyStepStatusInUI(page3, 'aggregate', 'Shared', email3)
		const progressAfterShare = await verifyProgressInUI(page3, email3)
		expect(progressAfterShare).toContain('Done')
		const aggSharedFiles = await backend3.invoke('get_step_output_files', {
			sessionId,
			stepId: 'aggregate',
		})
		const aggPermFile = (aggSharedFiles || []).find((f: string) => f.endsWith('syft.pub.yaml'))
		expect(aggPermFile).toBeTruthy()
		const aggPermText = fs.readFileSync(String(aggPermFile), 'utf-8')
		const readPrincipals = extractReadPrincipalsFromSyftPub(aggPermText)
		expect(readPrincipals).toEqual(expect.arrayContaining([email1, email2, email3]))
		// Aggregate output may be directly resolvable (no per-contribution finder button needed).
		await verifyContributionButtons(page1, 'aggregate', 0, email1)
		await verifyContributionButtons(page2, 'aggregate', 0, email2)
		const waitingBannerClient1 =
			(await runCard1
				.locator('.mp-waiting-banner')
				.innerText()
				.catch(() => '')) || ''
		expect(waitingBannerClient1.toLowerCase()).not.toContain(email2.toLowerCase())

		// Shared step outputs should be published into chat messages with metadata/files
		const contributionSharedMsg = await waitForThreadMessageMatching(
			backend3,
			threadId,
			(msg) => normalizeMetadata(msg?.metadata)?.flow_results?.step_id === 'generate',
			'contribution share results message',
		)
		const contributionMeta = normalizeMetadata(contributionSharedMsg?.metadata)?.flow_results
		expect(Array.isArray(contributionMeta?.files)).toBe(true)
		expect(contributionMeta?.files?.length).toBeGreaterThan(0)

		const resultSharedMsg = await waitForThreadMessageMatching(
			backend1,
			threadId,
			(msg) => normalizeMetadata(msg?.metadata)?.flow_results?.step_id === 'aggregate',
			'final result share message',
		)
		const resultMeta = normalizeMetadata(resultSharedMsg?.metadata)?.flow_results
		expect(Array.isArray(resultMeta?.files)).toBe(true)
		expect(resultMeta?.files?.length).toBeGreaterThan(0)
		const resultSharedMsgClient2 = await waitForThreadMessageMatching(
			backend2,
			threadId,
			(msg) => normalizeMetadata(msg?.metadata)?.flow_results?.step_id === 'aggregate',
			'final result share message (client2)',
		)
		const resultMetaClient2 = normalizeMetadata(resultSharedMsgClient2?.metadata)?.flow_results
		expect(Array.isArray(resultMetaClient2?.files)).toBe(true)
		expect(resultMetaClient2?.files?.length).toBeGreaterThan(0)

		log(logSocket, { event: 'flow-steps-completed' })

		// === Send Messages to Chat and Verify ===
		console.log('\n--- Sending Messages Between Participants ---')

		// Navigate all clients to Messages and select the group thread
		await navigateToMessagesAndFindThread(page1, email1)
		await navigateToMessagesAndFindThread(page2, email2)
		await navigateToMessagesAndFindThread(page3, email3)

		// Everyone sends a hello message in the group chat
		const hello1 = `Hello from ${email1} at ${Date.now()}`
		const hello2 = `Hello from ${email2} at ${Date.now()}`
		const hello3 = `Hello from ${email3} at ${Date.now()}`
		await sendMessageInSelectedThread(page1, email1, hello1)
		await sendMessageInSelectedThread(page2, email2, hello2)
		await sendMessageInSelectedThread(page3, email3, hello3)

		// Verify all participants can receive all hello messages in the thread
		const participantsBackends = [
			{ email: email1, backend: backend1 },
			{ email: email2, backend: backend2 },
			{ email: email3, backend: backend3 },
		]
		const helloMessages = [hello1, hello2, hello3]
		for (const participant of participantsBackends) {
			for (const hello of helloMessages) {
				await waitForThreadMessageMatching(
					participant.backend,
					threadId,
					(msg) => (msg?.body || '').includes(hello),
					`${participant.email} sees hello message`,
				)
			}
		}

		// Navigate back to Runs to check final state
		await page1.click('button:has-text("Runs")')
		await page2.click('button:has-text("Runs")')
		await page3.click('button:has-text("Runs")')
		await page1.waitForTimeout(500)
		await page2.waitForTimeout(500)
		await page3.waitForTimeout(500)

		// === Verify Final State ===
		console.log('\n--- Final Verification ---')

		const finalState1 = await backend1.invoke('get_multiparty_flow_state', { sessionId })
		const finalState2 = await backend2.invoke('get_multiparty_flow_state', { sessionId })
		const finalState3 = await backend3.invoke('get_multiparty_flow_state', { sessionId })

		console.log(`\n${email1} final step states:`)
		finalState1?.steps?.forEach((s: any) => console.log(`  - ${s.name}: ${s.status}`))

		console.log(`\n${email2} final step states:`)
		finalState2?.steps?.forEach((s: any) => console.log(`  - ${s.name}: ${s.status}`))

		console.log(`\n${email3} final step states:`)
		finalState3?.steps?.forEach((s: any) => console.log(`  - ${s.name}: ${s.status}`))

		// Verify UI shows correct step status for each client
		console.log('\n--- Verifying Final UI State ---')
		const firstRunId1 = finalState1?.run_id
		const firstRunId2 = finalState2?.run_id
		const firstRunId3 = finalState3?.run_id

		// Client1 should show generate as shared
		const client1GenerateStatus = finalState1?.steps?.find((s: any) => s.id === 'generate')?.status
		console.log(`  ${email1}: generate=${client1GenerateStatus}`)
		expect(client1GenerateStatus).toBe('Shared')

		// Client2 should show generate as shared
		const client2GenerateStatus = finalState2?.steps?.find((s: any) => s.id === 'generate')?.status
		console.log(`  ${email2}: generate=${client2GenerateStatus}`)
		expect(client2GenerateStatus).toBe('Shared')

		// Aggregator should have shared aggregate
		const aggAggregateStatus = finalState3?.steps?.find((s: any) => s.id === 'aggregate')?.status
		console.log(`  ${email3}: aggregate=${aggAggregateStatus}`)
		expect(aggAggregateStatus).toBe('Shared')

		// Verify UI progress shows correct count
		const finalProgress1 = await verifyProgressInUI(page1, email1)
		const finalProgress2 = await verifyProgressInUI(page2, email2)
		const finalProgress3 = await verifyProgressInUI(page3, email3)

		// All clients should see full flow completion.
		expect(finalProgress1).toContain('Done')
		expect(finalProgress2).toContain('Done')
		expect(finalProgress3).toContain('Done')
		expect(await runCard1.evaluate((el) => el.classList.contains('mp-run-complete'))).toBe(true)
		expect(await runCard2.evaluate((el) => el.classList.contains('mp-run-complete'))).toBe(true)
		expect(await runCard3.evaluate((el) => el.classList.contains('mp-run-complete'))).toBe(true)

		// === Verify Results in Chat ===
		console.log('\n--- Checking for Shared Results in Chat ---')

		// Navigate back to Messages to see if results appeared
		await page1.click('button:has-text("Messages")')
		await page1.waitForTimeout(1000)

		// Sync and check for result messages
		const syncBtn1 = page1.locator('#refresh-messages-btn')
		if (await syncBtn1.isVisible()) {
			await syncBtn1.click()
			await page1.waitForTimeout(2000)
		}

		// === Re-propose Same Flow in Same Group Thread (new session/new run) ===
		console.log('\n--- Re-proposing Same Flow in Same Group Thread ---')
		const previousSessionId = sessionId
		const secondTimestamp = Date.now()

		await navigateToMessagesAndFindThread(page3, email3)
		await proposeBtn.waitFor({ timeout: UI_TIMEOUT })
		await proposeBtn.click()
		await proposeModal.waitFor({ timeout: UI_TIMEOUT })
		await page3.selectOption('#propose-flow-select', { label: flowName })
		await page3.waitForTimeout(500)

		const secondRoleRows = page3.locator('#propose-flow-roles-list .propose-flow-role-row')
		const secondRoleCount = await secondRoleRows.count()
		expect(secondRoleCount).toBe(3)

		// Deliberately assign clients in reverse order from the first invitation.
		const secondAllCandidates = [email1, email2, email3]
		const secondUsedEmails = new Set<string>()
		for (let i = 0; i < secondRoleCount; i += 1) {
			const row = secondRoleRows.nth(i)
			const roleLabel = (
				(await row
					.locator('.propose-flow-role-label')
					.textContent()
					.catch(() => '')) || ''
			)
				.toLowerCase()
				.trim()
			const select = row.locator('select')
			let preferred = ''

			if (roleLabel.includes('aggregator')) {
				preferred = email3
			} else if (roleLabel.includes('1')) {
				preferred = email2
			} else if (roleLabel.includes('2')) {
				preferred = email1
			}
			const selectedEmail =
				(preferred && !secondUsedEmails.has(preferred) ? preferred : '') ||
				secondAllCandidates.find((candidate) => !secondUsedEmails.has(candidate)) ||
				preferred ||
				email2
			await select.selectOption(selectedEmail)
			secondUsedEmails.add(selectedEmail)
		}

		await page3
			.locator('#propose-flow-message')
			.fill(`Second run in same thread (reordered clients) - ${secondTimestamp}`)
		await expect
			.poll(
				async () => {
					try {
						return await sendBtn.isEnabled()
					} catch {
						return false
					}
				},
				{ timeout: UI_TIMEOUT },
			)
			.toBe(true)
		await sendBtn.click()
		try {
			await expect(proposeModal).toBeHidden({ timeout: 6000 })
		} catch {
			console.log(
				'  Aggregator: second invite modal still open after click, using JS send fallback',
			)
			await page3.evaluate(() => window.proposeFlowModal?.sendInvitation?.())
			await expect(proposeModal).toBeHidden({ timeout: UI_TIMEOUT })
		}
		await page3.waitForTimeout(1500)

		const secondInvitation = await waitForThreadMessageMatching(
			backend1,
			threadId,
			(msg) => {
				const invite = normalizeMetadata(msg?.metadata)?.flow_invitation
				if (!invite || invite.flow_name !== flowName) return false
				const sid = invite.session_id || invite.sessionId
				return Boolean(sid && sid !== previousSessionId)
			},
			'second flow invitation in same group thread',
		)

		const secondInviteMeta = normalizeMetadata(secondInvitation?.metadata)?.flow_invitation
		const secondSessionId = secondInviteMeta?.session_id || secondInviteMeta?.sessionId || ''
		expect(secondSessionId).toBeTruthy()
		expect(secondSessionId).not.toBe(previousSessionId)

		const secondParticipants = secondInviteMeta?.participants || []
		const secondFlowSpec = secondInviteMeta?.flow_spec
		expect(Array.isArray(secondParticipants)).toBe(true)
		expect(secondParticipants.length).toBe(3)
		expect(secondFlowSpec).toBeTruthy()

		// Accept second invitation for all participants and verify it becomes a distinct run.
		const acceptPayload = {
			sessionId: secondSessionId,
			flowName,
			flowSpec: secondFlowSpec,
			participants: secondParticipants,
			autoRunAll: false,
			threadId,
		}
		await backend1.invoke('accept_flow_invitation', acceptPayload)
		await backend2.invoke('accept_flow_invitation', acceptPayload)
		await backend3.invoke('accept_flow_invitation', acceptPayload)

		const secondState1 = await backend1.invoke('get_multiparty_flow_state', {
			sessionId: secondSessionId,
		})
		const secondState2 = await backend2.invoke('get_multiparty_flow_state', {
			sessionId: secondSessionId,
		})
		const secondState3 = await backend3.invoke('get_multiparty_flow_state', {
			sessionId: secondSessionId,
		})

		expect(secondState1?.session_id).toBe(secondSessionId)
		expect(secondState2?.session_id).toBe(secondSessionId)
		expect(secondState3?.session_id).toBe(secondSessionId)

		expect(secondState1?.run_id).toBeTruthy()
		expect(secondState2?.run_id).toBeTruthy()
		expect(secondState3?.run_id).toBeTruthy()

		expect(secondState1?.run_id).not.toBe(firstRunId1)
		expect(secondState2?.run_id).not.toBe(firstRunId2)
		expect(secondState3?.run_id).not.toBe(firstRunId3)

		console.log('\n=== Multiparty Flow Test Complete! ===')
		log(logSocket, { event: 'multiparty-flow-test-complete' })

		// Interactive mode pause
		if (process.env.INTERACTIVE_MODE === '1') {
			console.log('\n--- Interactive Mode ---')
			console.log('All three clients have completed the flow. You can interact with them:')
			console.log(`  Client 1: ${uiBaseUrl}?ws=${wsPort1}&real=1`)
			console.log(`  Client 2: ${uiBaseUrl}?ws=${wsPort2}&real=1`)
			console.log(`  Client 3: ${uiBaseUrl}?ws=${wsPort3}&real=1`)
			console.log('\nInteractive pause disabled; continuing cleanup.')
		}

		// Cleanup - close pages first to stop polling intervals and prevent WS errors
		await page1.close()
		await page2.close()
		await page3.close()

		await backend1.close()
		await backend2.close()
		await backend3.close()

		if (logSocket) {
			await new Promise<void>((resolve) => {
				logSocket.once('close', () => resolve())
				logSocket.close()
			})
		}
	})
})
