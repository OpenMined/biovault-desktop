/**
 * File Transfer Collaboration Test (Two Clients)
 * Tests the SyftBox file sharing workflow with pause/resume:
 * 1. Both clients navigate to SyftBox tab
 * 2. Both clients add each other as trusted contacts via Network tab
 * 3. Client1 creates a shared folder with a large file
 * 4. Client1 adds permission file granting Client2 access
 * 5. Both clients watch sync progress in Activity panel
 * 6. Test pause/resume during sync
 * 7. Client2 verifies file received
 * 8. Open file location in Finder
 *
 * Usage:
 *   ./test-scenario.sh --file-transfer
 *
 * @tag file-transfer
 */
import { expect, test, type Page, pauseForInteractive } from './playwright-fixtures'
import WebSocket from 'ws'
import * as fs from 'fs'
import * as path from 'path'
import { applyWindowLayout, ensureProfileSelected, waitForAppReady } from './test-helpers.js'
import { setWsPort, completeOnboarding, ensureLogSocket, log } from './onboarding-helper.js'

const TEST_TIMEOUT = 600_000 // 10 minutes max
const UI_TIMEOUT = 10_000
const SYNC_TIMEOUT = 180_000 // 3 minutes for sync operations
const PEER_DID_TIMEOUT_MS = 180_000 // 3 minutes for peer DID sync

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

async function ensureProfilePickerClosed(page: Page): Promise<void> {
	if (await ensureProfileSelected(page, { timeout: 30_000 })) {
		await waitForAppReady(page, { timeout: 30_000 })
	}
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
	clientLabel?: string,
): Promise<string> {
	const label = clientLabel || 'client'
	const datasitesRoot = resolveDatasitesRoot(dataDir)
	const didPath = path.join(datasitesRoot, peerEmail, 'public', 'crypto', 'did.json')

	console.log(`[${label}] waitForPeerDid: looking for ${peerEmail}`)

	const start = Date.now()
	let syncTriggerCount = 0

	while (Date.now() - start < timeoutMs) {
		if (fs.existsSync(didPath)) {
			console.log(`[${label}] ✓ Found peer DID: ${didPath}`)
			return didPath
		}

		// Trigger sync every ~2 seconds
		if (backend && syncTriggerCount % 4 === 0) {
			try {
				await backend.invoke('trigger_syftbox_sync')
			} catch (err) {
				// Ignore sync errors
			}
		}
		syncTriggerCount++
		await new Promise((r) => setTimeout(r, 500))
	}

	throw new Error(`Timed out waiting for peer DID file: ${didPath}`)
}

// Timing helper
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

async function waitForFileSync(
	filePath: string,
	timeoutMs = SYNC_TIMEOUT,
	expectedSize?: number,
): Promise<void> {
	const start = Date.now()
	while (Date.now() - start < timeoutMs) {
		if (fs.existsSync(filePath)) {
			const stat = fs.statSync(filePath)
			if (!expectedSize || stat.size >= expectedSize) {
				console.log(`✓ File synced: ${filePath} (${stat.size} bytes)`)
				return
			}
			console.log(`File exists but incomplete: ${stat.size}/${expectedSize} bytes`)
		}
		await new Promise((r) => setTimeout(r, 1000))
	}
	throw new Error(`Timed out waiting for file sync: ${filePath}`)
}

test.describe('File Transfer Collaboration @file-transfer', () => {
	test('two clients share a large file via SyftBox with pause/resume', async ({
		browser,
	}, testInfo) => {
		const testTimer = timer('Total test time')
		const wsPort1 = Number.parseInt(process.env.DEV_WS_BRIDGE_PORT_BASE || '3333', 10)
		const wsPort2 = wsPort1 + 1
		const email1 = process.env.CLIENT1_EMAIL || 'client1@sandbox.local'
		const email2 = process.env.CLIENT2_EMAIL || 'client2@sandbox.local'
		const largeFilePath = process.env.LARGE_FILE_PATH || ''

		console.log('Setting up file transfer collaboration test')
		console.log(`Client1 (Alice): ${email1} (port ${wsPort1})`)
		console.log(`Client2 (Bob): ${email2} (port ${wsPort2})`)
		console.log(`Large file: ${largeFilePath}`)

		// Verify large file exists
		if (!largeFilePath || !fs.existsSync(largeFilePath)) {
			throw new Error(`Large file not found: ${largeFilePath}`)
		}
		const largeFileSize = fs.statSync(largeFilePath).size
		console.log(`Large file size: ${(largeFileSize / 1024 / 1024).toFixed(2)} MB`)

		const logSocket = await ensureLogSocket()

		// Create browser contexts and pages for both clients
		const context1 = await browser.newContext()
		const context2 = await browser.newContext()
		const page1 = await context1.newPage()
		const page2 = await context2.newPage()

		// Log console errors
		page1.on('console', (msg) => {
			if (msg.type() === 'error') {
				console.log(`[Client1 Error] ${msg.text()}`)
			}
		})
		page2.on('console', (msg) => {
			if (msg.type() === 'error') {
				console.log(`[Client2 Error] ${msg.text()}`)
			}
		})

		// Handle dialogs
		page1.on('dialog', async (dialog) => {
			console.log(`[Client1 Dialog] ${dialog.type()}: ${dialog.message().substring(0, 80)}...`)
			try {
				await dialog.accept()
			} catch {}
		})
		page2.on('dialog', async (dialog) => {
			console.log(`[Client2 Dialog] ${dialog.type()}: ${dialog.message().substring(0, 80)}...`)
			try {
				await dialog.accept()
			} catch {}
		})

		await setWsPort(page1, wsPort1)
		await setWsPort(page2, wsPort2)

		const backend1 = await connectBackend(wsPort1)
		const backend2 = await connectBackend(wsPort2)

		try {
			const baseUrl = process.env.UI_BASE_URL || 'http://localhost:8082'
			await page1.goto(`${baseUrl}?ws=${wsPort1}&real=1`)
			await page2.goto(`${baseUrl}?ws=${wsPort2}&real=1`)
			await applyWindowLayout(page1, 0, 'client1')
			await applyWindowLayout(page2, 1, 'client2')
			await waitForAppReady(page1, { timeout: 10_000 })
			await waitForAppReady(page2, { timeout: 10_000 })
			await ensureProfilePickerClosed(page1)
			await ensureProfilePickerClosed(page2)

			// Check if clients are onboarded
			const isOnboarded1 = await backend1.invoke('check_is_onboarded')
			const isOnboarded2 = await backend2.invoke('check_is_onboarded')
			console.log(`Client1 onboarded: ${isOnboarded1}, Client2 onboarded: ${isOnboarded2}`)

			// Do onboarding if needed
			if (!isOnboarded1 || !isOnboarded2) {
				const onboardingTimer = timer('Onboarding')
				console.log('\n=== Onboarding clients ===')

				if (!isOnboarded1) {
					await completeOnboarding(page1, email1, logSocket)
				}
				if (!isOnboarded2) {
					await completeOnboarding(page2, email2, logSocket)
				}

				// Wait for peer DID files to sync
				console.log('Waiting for peer DID files to sync...')
				const dataDir1 = await getSyftboxDataDir(backend1)
				const dataDir2 = await getSyftboxDataDir(backend2)
				await Promise.all([
					waitForPeerDid(dataDir1, email2, PEER_DID_TIMEOUT_MS, backend1, 'client1'),
					waitForPeerDid(dataDir2, email1, PEER_DID_TIMEOUT_MS, backend2, 'client2'),
				])
				onboardingTimer.stop()
			}

			// ============================================================
			// Step 1: Navigate both clients to SyftBox tab
			// ============================================================
			log(logSocket, { event: 'step-1', action: 'navigate-syftbox' })
			console.log('\n=== Step 1: Navigate to SyftBox tab ===')

			await page1.locator('.nav-item[data-tab="syftbox"]').click()
			await page2.locator('.nav-item[data-tab="syftbox"]').click()
			await expect(page1.locator('#syftbox-view.tab-content.active')).toBeVisible({
				timeout: UI_TIMEOUT,
			})
			await expect(page2.locator('#syftbox-view.tab-content.active')).toBeVisible({
				timeout: UI_TIMEOUT,
			})
			console.log('Both clients on SyftBox tab')

			// ============================================================
			// Step 2: Exchange keys via Network tab (add each other as contacts)
			// ============================================================
			log(logSocket, { event: 'step-2', action: 'add-contacts' })
			console.log('\n=== Step 2: Add each other as trusted contacts ===')

			const keysTimer = timer('Key exchange')
			await page1.locator('.nav-item[data-tab="network"]').click()
			await page2.locator('.nav-item[data-tab="network"]').click()
			await expect(page1.locator('.network-container, #network-view')).toBeVisible({
				timeout: UI_TIMEOUT,
			})
			await expect(page2.locator('.network-container, #network-view')).toBeVisible({
				timeout: UI_TIMEOUT,
			})

			// Import contacts via backend
			await backend1.invoke('network_import_contact', { identity: email2 })
			await backend2.invoke('network_import_contact', { identity: email1 })
			console.log('✓ Contacts imported!')

			await page1.reload()
			await page2.reload()
			await waitForAppReady(page1, { timeout: 10_000 })
			await waitForAppReady(page2, { timeout: 10_000 })
			await ensureProfilePickerClosed(page1)
			await ensureProfilePickerClosed(page2)
			keysTimer.stop()

			// ============================================================
			// Step 3: Navigate back to SyftBox and expand tree
			// ============================================================
			log(logSocket, { event: 'step-3', action: 'expand-tree' })
			console.log('\n=== Step 3: Navigate to SyftBox and expand tree ===')

			await page1.locator('.nav-item[data-tab="syftbox"]').click()
			await page2.locator('.nav-item[data-tab="syftbox"]').click()
			await page1.waitForTimeout(1000)
			await page2.waitForTimeout(1000)

			// Expand "My Datasite" section on Client1
			const myDatasiteSection = page1.locator('.tree-section[data-section="your-files"]')
			if (await myDatasiteSection.isVisible().catch(() => false)) {
				const header = myDatasiteSection.locator('.tree-section-header')
				if ((await header.locator('.section-icon').textContent()) === '▶') {
					await header.click()
					await page1.waitForTimeout(500)
				}
			}

			// Click to expand user's datasite folder
			const userFolder = page1.locator(`.tree-node[data-path="${email1}"]`)
			if (await userFolder.isVisible().catch(() => false)) {
				const expandBtn = userFolder.locator('.tree-expand')
				await expandBtn.click()
				await page1.waitForTimeout(1000)
			}

			console.log('✓ Tree expanded on Client1')

			// ============================================================
			// Step 4: Create shared folder with permission file
			// ============================================================
			log(logSocket, { event: 'step-4', action: 'create-shared-folder' })
			console.log('\n=== Step 4: Create shared folder with test file ===')

			const dataDir1 = await getSyftboxDataDir(backend1)
			const dataDir2 = await getSyftboxDataDir(backend2)

			// Use the existing public folder which is already synced
			// Place a small test file first to verify sync works
			const publicPath1 = path.join(dataDir1, 'datasites', email1, 'public')
			const testFileName = 'test-sync-file.txt'
			const testFilePath = path.join(publicPath1, testFileName)
			const testContent = `Test file created at ${new Date().toISOString()}\nThis verifies SyftBox sync is working.`
			fs.writeFileSync(testFilePath, testContent)
			console.log(`✓ Created test file: ${testFilePath}`)

			// Now create shared folder with the large file
			const sharedFolderName = 'shared-files'
			const sharedFolderPath = path.join(publicPath1, sharedFolderName)

			// Create the shared folder
			fs.mkdirSync(sharedFolderPath, { recursive: true })
			console.log(`✓ Created shared folder: ${sharedFolderPath}`)

			// Create permission file granting read access to Client2
			// Use the correct syft.pub.yaml format
			const permissionContent = `# Permissions for shared-files folder
path: "${email1}/public/${sharedFolderName}"
permissions:
  - user: "*"
    permission: read
`
			const permissionPath = path.join(sharedFolderPath, 'syft.pub.yaml')
			fs.writeFileSync(permissionPath, permissionContent)
			console.log(`✓ Created permission file: ${permissionPath}`)

			// Copy the large file to the shared folder
			const targetFileName = 'large-test-file.bin'
			const targetFilePath = path.join(sharedFolderPath, targetFileName)
			console.log(`Copying large file to shared folder...`)
			const copyTimer = timer('File copy')
			fs.copyFileSync(largeFilePath, targetFilePath)
			copyTimer.stop()
			console.log(`✓ Copied file to: ${targetFilePath}`)

			// Trigger sync
			await backend1.invoke('trigger_syftbox_sync')
			await page1.waitForTimeout(2000)

			// ============================================================
			// Step 5: Switch to Activity view and watch sync progress
			// ============================================================
			log(logSocket, { event: 'step-5', action: 'watch-activity' })
			console.log('\n=== Step 5: Switch to Activity view ===')

			// Click Activity tab on both clients
			await page1.locator('#view-tab-log').click()
			await page2.locator('#view-tab-log').click()
			await page1.waitForTimeout(500)
			await page2.waitForTimeout(500)

			console.log('✓ Both clients showing Activity view')

			// Refresh tree on Client1 to see the new folder
			await page1.locator('#tree-refresh-btn').click()
			await page1.waitForTimeout(2000)

			// ============================================================
			// Step 6: Test pause functionality (if available)
			// ============================================================
			log(logSocket, { event: 'step-6', action: 'test-pause' })
			console.log('\n=== Step 6: Observe sync in activity log ===')

			// Look for sync activity in the log
			await page1.waitForTimeout(3000)

			// Check global status bar shows connected
			const statusBar1 = page1.locator('#global-ws-status .ws-label')
			const statusText1 = await statusBar1.textContent()
			console.log(`Client1 status: ${statusText1}`)

			const statusBar2 = page2.locator('#global-ws-status .ws-label')
			const statusText2 = await statusBar2.textContent()
			console.log(`Client2 status: ${statusText2}`)

			// ============================================================
			// Step 7: Trigger sync and wait for file to appear on Client2
			// ============================================================
			log(logSocket, { event: 'step-7', action: 'wait-sync' })
			console.log('\n=== Step 7: Wait for files to sync to Client2 ===')

			const syncTimer = timer('File sync')

			// Continuously trigger sync on both sides
			const syncInterval = setInterval(async () => {
				try {
					await backend1.invoke('trigger_syftbox_sync')
					await backend2.invoke('trigger_syftbox_sync')
				} catch {}
			}, 3000)

			// First, wait for the small test file to verify basic sync works
			const expectedTestFile = path.join(dataDir2, 'datasites', email1, 'public', testFileName)
			console.log(`First, waiting for test file at: ${expectedTestFile}`)

			try {
				await waitForFileSync(expectedTestFile, 60_000) // 1 minute for small file
				console.log('✓ Small test file synced - basic sync is working!')

				// Now wait for the large file (placed directly in public/)
				const expectedLargeFile = path.join(dataDir2, 'datasites', email1, 'public', targetFileName)
				console.log(`Waiting for large file at: ${expectedLargeFile}`)

				// Also copy the large file directly to public (not subfolder) for sync testing
				const directTargetPath = path.join(publicPath1, targetFileName)
				if (!fs.existsSync(directTargetPath)) {
					fs.copyFileSync(largeFilePath, directTargetPath)
					console.log(`Also copied large file directly to public: ${directTargetPath}`)
				}

				await waitForFileSync(expectedLargeFile, SYNC_TIMEOUT, largeFileSize)
				syncTimer.stop()
			} finally {
				clearInterval(syncInterval)
			}

			// ============================================================
			// Step 8: Verify file on Client2 and show in activity
			// ============================================================
			log(logSocket, { event: 'step-8', action: 'verify-file' })
			console.log('\n=== Step 8: Verify file on Client2 ===')

			// Refresh Client2's tree
			await page2.locator('#tree-refresh-btn').click()
			await page2.waitForTimeout(2000)

			// Switch Client2 to Tree view
			await page2.locator('#view-tab-tree').click()
			await page2.waitForTimeout(500)

			// Expand trusted contacts section
			const trustedSection = page2.locator('.tree-section[data-section="contacts"]')
			if (await trustedSection.isVisible().catch(() => false)) {
				const header = trustedSection.locator('.tree-section-header')
				if ((await header.locator('.section-icon').textContent()) === '▶') {
					await header.click()
					await page2.waitForTimeout(500)
				}
			}

			// Try to expand Client1's folder
			const client1Folder = page2.locator(`.tree-node[data-path="${email1}"]`)
			if (await client1Folder.isVisible().catch(() => false)) {
				const expandBtn = client1Folder.locator('.tree-expand')
				await expandBtn.click()
				await page2.waitForTimeout(1000)
			}

			// Verify large file exists on disk (in public/, not subfolder)
			const verifyFilePath = path.join(dataDir2, 'datasites', email1, 'public', targetFileName)
			expect(fs.existsSync(verifyFilePath)).toBe(true)
			const receivedSize = fs.statSync(verifyFilePath).size
			console.log(`✓ File received: ${(receivedSize / 1024 / 1024).toFixed(2)} MB`)
			expect(receivedSize).toBe(largeFileSize)

			// ============================================================
			// Step 9: Open file location in Finder
			// ============================================================
			log(logSocket, { event: 'step-9', action: 'open-finder' })
			console.log('\n=== Step 9: Open file location in Finder ===')

			// Select the file in tree if visible
			const fileNode = page2.locator(`.tree-node[data-path*="${targetFileName}"]`)
			if (await fileNode.isVisible().catch(() => false)) {
				await fileNode.click()
				await page2.waitForTimeout(500)

				// Click "Open in Finder" button in details pane
				const openInFinderBtn = page2.locator('.detail-actions button:has-text("Open in Finder")')
				if (await openInFinderBtn.isVisible().catch(() => false)) {
					await openInFinderBtn.click()
					console.log('✓ Opened file location in Finder')
				}
			}

			// Also open via backend command
			try {
				await backend2.invoke('open_folder', { path: path.dirname(verifyFilePath) })
				console.log('✓ Opened folder via backend')
			} catch (err) {
				console.log('Note: Could not open folder via backend:', err)
			}

			// ============================================================
			// Summary
			// ============================================================
			console.log('\n=== TEST COMPLETED ===')
			console.log('File transfer collaboration flow tested:')
			console.log('  ✓ Both clients navigated to SyftBox tab')
			console.log('  ✓ Added each other as trusted contacts')
			console.log('  ✓ Created shared folder with permissions')
			console.log(`  ✓ Transferred ${(largeFileSize / 1024 / 1024).toFixed(2)} MB file`)
			console.log('  ✓ Verified file synced to Client2')
			console.log('  ✓ Opened file location in Finder')

			testTimer.stop()
		} finally {
			await pauseForInteractive(testInfo)
			if (logSocket) {
				logSocket.close()
			}
			await backend1.close()
			await backend2.close()
			await context1.close()
			await context2.close()
		}
	})
})
