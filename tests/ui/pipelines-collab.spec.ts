/**
 * Pipelines Collaboration Test (Two Clients)
 * Tests the full collaborative pipeline workflow:
 * 1. Client1 (Alice) creates dataset with private + mock data
 * 2. Client1 creates HERC2 pipeline (or imports from local bioscript)
 * 3. Client2 (Bob) imports HERC2 pipeline
 * 4. Client2 sees Alice's dataset on Network > Datasets tab
 * 5. Client2 runs HERC2 pipeline on mock data (verifies it works locally)
 * 6. Client2 sends "Request Run" for private data
 * 7. Client1 receives request in Messages
 * 8. Client1 runs pipeline on mock data, then real data
 * 9. Client1 shares results back to Client2
 * 10. Client2 receives and verifies results
 *
 * This is the UI version of inbox-ping-pong.yaml
 *
 * Usage:
 *   ./test-scenario.sh --pipelines-collab
 *
 * @tag pipelines-collab
 */
import { expect, test, type Page, pauseForInteractive } from './playwright-fixtures'
import WebSocket from 'ws'
import { createHash } from 'node:crypto'
import * as fs from 'fs'
import * as path from 'path'
import { applyWindowLayout, ensureProfileSelected, waitForAppReady } from './test-helpers.js'
import { setWsPort, completeOnboarding, ensureLogSocket, log } from './onboarding-helper.js'

const TEST_TIMEOUT = 480_000 // 8 minutes max (two clients + pipeline runs)
const UI_TIMEOUT = 10_000
const PIPELINE_RUN_TIMEOUT = 180_000 // 3 minutes for pipeline to complete
const SYNC_TIMEOUT = 60_000 // 1 minute for sync operations
const PEER_DID_TIMEOUT_MS = 180_000 // 3 minutes for peer DID sync
const DEBUG_PIPELINE_PAUSE_MS = (() => {
	const raw = Number.parseInt(process.env.PIPELINES_COLLAB_PAUSE_MS || '30000', 10)
	return Number.isFinite(raw) ? raw : 30_000
})()

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

async function pauseForInteractiveMode(timeoutMs = 30_000): Promise<void> {
	if (process.env.INTERACTIVE_MODE !== '1') return
	const seconds = Math.round(timeoutMs / 1000)
	console.log(`Interactive mode: Press ENTER to finish and exit (or wait ${seconds}s)`)
	await new Promise<void>((resolve) => {
		const stdin = process.stdin
		const done = () => {
			if (stdin) {
				stdin.off('data', onData)
				stdin.pause()
			}
			resolve()
		}
		const onData = () => {
			clearTimeout(timer)
			done()
		}
		const timer = setTimeout(done, timeoutMs)
		if (stdin) {
			stdin.resume()
			stdin.once('data', onData)
		}
	})
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
	const didPaths = [
		path.join(datasitesRoot, peerEmail, 'public', 'did.json'),
		path.join(datasitesRoot, peerEmail, 'public', 'crypto', 'did.json'),
	]

	console.log(`[${label}] waitForPeerDid: looking for ${peerEmail}`)

	const start = Date.now()
	let syncTriggerCount = 0

	while (Date.now() - start < timeoutMs) {
		const foundPath = didPaths.find((candidate) => fs.existsSync(candidate))
		if (foundPath) {
			console.log(`[${label}] ✓ Found peer DID: ${foundPath}`)
			return foundPath
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

	throw new Error(`Timed out waiting for peer DID file: ${didPaths.join(', ')}`)
}

// Helper to wait for pipeline run to complete
async function waitForRunCompletion(
	page: Page,
	backend: Backend,
	runId: number,
	timeoutMs: number = PIPELINE_RUN_TIMEOUT,
): Promise<{ status: string; run: any }> {
	const startTime = Date.now()
	let lastStatus = 'unknown'

	while (Date.now() - startTime < timeoutMs) {
		try {
			const runs = await backend.invoke('get_pipeline_runs', {})
			const run = runs.find((r: any) => r.id === runId)
			if (run) {
				lastStatus = run.status
				console.log(`Run ${runId} status: ${lastStatus}`)

				if (run.status === 'success' || run.status === 'failed' || run.status === 'error') {
					return { status: run.status, run }
				}
			}
		} catch (e) {
			console.log(`Error checking run status: ${e}`)
		}

		await page.waitForTimeout(2000)
	}

	throw new Error(`Pipeline run timed out after ${timeoutMs}ms. Last status: ${lastStatus}`)
}

async function waitForNewRun(
	backend: Backend,
	existingIds: Set<number>,
	timeoutMs = 60_000,
): Promise<any> {
	const startTime = Date.now()
	while (Date.now() - startTime < timeoutMs) {
		const runs = await backend.invoke('get_pipeline_runs', {})
		const newRuns = (runs || []).filter((run: any) => !existingIds.has(run.id))
		if (newRuns.length > 0) {
			newRuns.sort((a: any, b: any) => b.id - a.id)
			return newRuns[0]
		}
		await new Promise((r) => setTimeout(r, 1000))
	}
	throw new Error('Timed out waiting for new pipeline run')
}

async function clickImportResults(page: Page, timeoutMs = 30_000): Promise<void> {
	const startTime = Date.now()
	let attempt = 0
	while (Date.now() - startTime < timeoutMs) {
		attempt += 1
		const importBtn = page
			.locator('.message-pipeline-results button:has-text("Import Results")')
			.first()
		try {
			await expect(importBtn).toBeVisible({ timeout: 3_000 })
			await expect(importBtn).toBeEnabled({ timeout: 3_000 })
			await importBtn.scrollIntoViewIfNeeded().catch(() => {})
			await importBtn.click({ timeout: 5_000 })
			return
		} catch (err) {
			console.log(`[Import Results] retry ${attempt}: ${err}`)
			await page.waitForTimeout(750)
		}
	}
	throw new Error(`Timed out clicking Import Results after ${timeoutMs}ms`)
}

function resolvePipelineResultPath(run: any): string {
	const baseDir = run.results_dir || run.work_dir
	return path.join(baseDir, 'herc2', 'result_HERC2.tsv')
}

async function readTextFileWithRetry(filePath: string, timeoutMs = 30_000): Promise<string> {
	const startTime = Date.now()
	while (Date.now() - startTime < timeoutMs) {
		if (fs.existsSync(filePath)) {
			const content = fs.readFileSync(filePath, 'utf8')
			if (content.trim().length > 0) {
				return content
			}
		}
		await new Promise((r) => setTimeout(r, 1000))
	}
	throw new Error(`Timed out waiting for file: ${filePath}`)
}

function getBiovaultHomeFromRun(run: any): string {
	const baseDir = run.results_dir || run.work_dir
	return path.dirname(path.dirname(baseDir))
}

function findImportedResultsFile(resultsRoot: string, runId: number): string | null {
	if (!fs.existsSync(resultsRoot)) {
		return null
	}
	const entries = fs.readdirSync(resultsRoot, { withFileTypes: true })
	for (const entry of entries) {
		if (!entry.isDirectory()) continue
		const candidate = path.join(
			resultsRoot,
			entry.name,
			`run_${runId}`,
			'herc2',
			'result_HERC2.tsv',
		)
		if (fs.existsSync(candidate)) {
			return candidate
		}
	}
	return null
}

async function waitForImportedResults(
	resultsRoot: string,
	runId: number,
	timeoutMs = 30_000,
): Promise<string> {
	const startTime = Date.now()
	while (Date.now() - startTime < timeoutMs) {
		const found = findImportedResultsFile(resultsRoot, runId)
		if (found) return found
		await new Promise((r) => setTimeout(r, 1000))
	}
	throw new Error(`Timed out waiting for imported results for run ${runId}`)
}

async function waitForMessageCard(
	page: Page,
	backend: Backend,
	selector: string,
	timeoutMs = SYNC_TIMEOUT,
	logSocket: WebSocket | null = null,
	clientLabel = 'client',
	label = 'wait-for-message',
): Promise<ReturnType<Page['locator']>> {
	const startTime = Date.now()
	while (Date.now() - startTime < timeoutMs) {
		const card = page.locator(selector)
		if (await card.isVisible().catch(() => false)) {
			return card
		}

		const threadItems = page.locator('#message-list .message-thread-item')
		if (await threadItems.count().catch(() => 0)) {
			await threadItems.first().click()
			await page.waitForTimeout(1000)
			if (await card.isVisible().catch(() => false)) {
				return card
			}
		}

		try {
			await backend.invoke('trigger_syftbox_sync')
		} catch {}
		try {
			await syncMessagesWithDebug(backend, logSocket, clientLabel, label)
		} catch {}

		await page.reload()
		await waitForAppReady(page, { timeout: 10_000 })
		await page.locator('.nav-item[data-tab="messages"]').click()
		await page.waitForTimeout(1500)
	}
	throw new Error(`Timed out waiting for message card: ${selector}`)
}

function normalizeTsvResult(content: string): string {
	const lines = content
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter(Boolean)
	if (lines.length <= 1) return lines.join('\n')
	const [header, ...rows] = lines
	rows.sort((a, b) => a.localeCompare(b))
	return [header, ...rows].join('\n')
}

function normalizeCsvResult(content: string): string {
	const lines = content
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter(Boolean)
	if (lines.length <= 1) return lines.join('\n')
	const [header, ...rows] = lines
	rows.sort((a, b) => a.localeCompare(b))
	return [header, ...rows].join('\n')
}

function extractMockFilenames(entries: any[]): string[] {
	if (!Array.isArray(entries)) return []
	const filenames = entries
		.map((entry) => {
			const url = entry?.url || ''
			if (typeof url !== 'string' || !url) return ''
			const name = url.split('/').next_back?.() ?? url.split('/').pop()
			return name || ''
		})
		.filter((name) => typeof name === 'string' && name.length > 0)
	return Array.from(new Set(filenames))
}

async function waitForFilesOnDisk(
	label: string,
	baseDir: string,
	filenames: string[],
	timeoutMs = 60_000,
): Promise<void> {
	if (!filenames.length) return
	const start = Date.now()
	while (Date.now() - start < timeoutMs) {
		const missing = filenames.filter((name) => !fs.existsSync(path.join(baseDir, name)))
		if (missing.length === 0) {
			console.log(`[${label}] All mock files present on disk (${filenames.length})`)
			return
		}
		console.log(`[${label}] Waiting for ${missing.length} mock files: ${missing.join(', ')}`)
		await new Promise((r) => setTimeout(r, 2000))
	}
	throw new Error(`[${label}] Mock files not present on disk after ${timeoutMs}ms`)
}

function computeFileHash(filePath: string): string {
	const content = fs.readFileSync(filePath)
	return createHash('md5').update(content).digest('hex')
}

async function waitForFilesContentMatch(
	sourceDir: string,
	destDir: string,
	filenames: string[],
	timeoutMs = 60_000,
): Promise<void> {
	if (!filenames.length) return
	const start = Date.now()
	while (Date.now() - start < timeoutMs) {
		let allMatch = true
		const mismatches: string[] = []
		for (const name of filenames) {
			const srcPath = path.join(sourceDir, name)
			const destPath = path.join(destDir, name)
			if (!fs.existsSync(srcPath) || !fs.existsSync(destPath)) {
				allMatch = false
				mismatches.push(`${name} (missing)`)
				continue
			}
			const srcHash = computeFileHash(srcPath)
			const destHash = computeFileHash(destPath)
			if (srcHash !== destHash) {
				allMatch = false
				const srcSize = fs.statSync(srcPath).size
				const destSize = fs.statSync(destPath).size
				mismatches.push(`${name} (src=${srcSize}/${srcHash.slice(0,8)}, dest=${destSize}/${destHash.slice(0,8)})`)
			}
		}
		if (allMatch) {
			console.log(`[Content Match] All ${filenames.length} files have matching content`)
			return
		}
		console.log(`[Content Match] Waiting for ${mismatches.length} files to match: ${mismatches.slice(0, 3).join(', ')}${mismatches.length > 3 ? '...' : ''}`)
		await new Promise((r) => setTimeout(r, 2000))
	}
	// Log final state for debugging
	console.log('[Content Match] TIMEOUT - Final file state:')
	for (const name of filenames) {
		const srcPath = path.join(sourceDir, name)
		const destPath = path.join(destDir, name)
		const srcExists = fs.existsSync(srcPath)
		const destExists = fs.existsSync(destPath)
		const srcHash = srcExists ? computeFileHash(srcPath) : 'N/A'
		const destHash = destExists ? computeFileHash(destPath) : 'N/A'
		const srcSize = srcExists ? fs.statSync(srcPath).size : 0
		const destSize = destExists ? fs.statSync(destPath).size : 0
		console.log(`  ${name}: src=${srcSize}/${srcHash.slice(0,8)}, dest=${destSize}/${destHash.slice(0,8)}, match=${srcHash === destHash}`)
	}
	throw new Error(`[Content Match] Files did not match after ${timeoutMs}ms`)
}

function getNetworkDatasetItem(page: Page, datasetName: string, owner: string) {
	return page.locator(
		`.dataset-item[data-name="${datasetName}"][data-owner="${owner}"]`,
	)
}

async function runDatasetPipeline(
	page: Page,
	backend: Backend,
	datasetName: string,
	dataType: 'mock' | 'real',
	pipelineMatch = 'herc2',
): Promise<any> {
	await page.locator('.nav-item[data-tab="data"]').click()
	await expect(page.locator('#data-view.tab-content.active')).toBeVisible({
		timeout: UI_TIMEOUT,
	})
	await page.locator('#data-view-toggle .pill-button[data-view="datasets"]').click()
	await page.waitForTimeout(1000)

	const datasetCard = page.locator('#datasets-grid .dataset-card').filter({ hasText: datasetName })
	await expect(datasetCard).toBeVisible({ timeout: UI_TIMEOUT })

	const runPipelineBtn = datasetCard.locator('.btn-run-pipeline')
	await expect(runPipelineBtn).toBeVisible({ timeout: UI_TIMEOUT })

	const runsBefore = await backend.invoke('get_pipeline_runs', {})
	const previousIds = new Set((runsBefore || []).map((run: any) => run.id))

	await runPipelineBtn.click()

	const runModal = page.locator('#run-pipeline-modal')
	await expect(runModal).toBeVisible({ timeout: UI_TIMEOUT })
	await runModal.locator(`input[name="pipeline-data-type"][value="${dataType}"]`).check()
	await runModal.locator('#run-pipeline-confirm').click()

	const dataRunModal = page.locator('#data-run-modal')
	await expect(dataRunModal).toBeVisible({ timeout: UI_TIMEOUT })

	const pipelineOption = dataRunModal.locator(
		`input[name="data-run-pipeline"][value*="${pipelineMatch}"], .data-run-pipeline-option:has-text("${pipelineMatch}")`,
	)
	if (await pipelineOption.isVisible().catch(() => false)) {
		await pipelineOption.first().click()
	}

	const runBtn = dataRunModal.locator('#data-run-run-btn')
	await expect(runBtn).toBeVisible({ timeout: UI_TIMEOUT })
	await runBtn.click()
	await page.waitForTimeout(3000)

	return await waitForNewRun(backend, previousIds)
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

type KeySnapshot = {
	label: string
	client: string
	email: string
	peerEmail: string
	capturedAt: string
	selfStatus?: any
	peerStatus?: any
	vaultDebug?: any
	networkPeer?: any
	networkCounts?: { contacts: number; discovered: number }
	errors?: string[]
}

const keySnapshots = new Map<string, KeySnapshot>()

function summarizeNetworkPeer(scan: any, peerEmail: string) {
	if (!scan || !peerEmail) return null
	const contacts = Array.isArray(scan.contacts) ? scan.contacts : []
	const discovered = Array.isArray(scan.discovered) ? scan.discovered : []
	const inContacts = contacts.find((c: any) => c.identity === peerEmail)
	const inDiscovered = discovered.find((c: any) => c.identity === peerEmail)
	if (inContacts) return { location: 'contacts', ...inContacts }
	if (inDiscovered) return { location: 'discovered', ...inDiscovered }
	return null
}

function keyListSignature(list: string[] | undefined): string {
	if (!Array.isArray(list)) return ''
	return [...list].sort().join('|')
}

function diffKeySnapshots(prev: KeySnapshot, next: KeySnapshot): string[] {
	const changes: string[] = []

	const prevSelf = prev.selfStatus?.vault_fingerprint
	const nextSelf = next.selfStatus?.vault_fingerprint
	if (prevSelf !== nextSelf) {
		changes.push(`self.vault_fingerprint: ${prevSelf ?? 'none'} -> ${nextSelf ?? 'none'}`)
	}

	const prevExport = prev.selfStatus?.export_fingerprint
	const nextExport = next.selfStatus?.export_fingerprint
	if (prevExport !== nextExport) {
		changes.push(`self.export_fingerprint: ${prevExport ?? 'none'} -> ${nextExport ?? 'none'}`)
	}

	const prevMatch = prev.selfStatus?.export_matches
	const nextMatch = next.selfStatus?.export_matches
	if (prevMatch !== nextMatch) {
		changes.push(`self.export_matches: ${prevMatch ?? 'none'} -> ${nextMatch ?? 'none'}`)
	}

	const prevPeer = prev.peerStatus?.fingerprint
	const nextPeer = next.peerStatus?.fingerprint
	if (prevPeer !== nextPeer) {
		changes.push(`peer.cached_fingerprint: ${prevPeer ?? 'none'} -> ${nextPeer ?? 'none'}`)
	}

	const prevNetwork = prev.networkPeer?.fingerprint
	const nextNetwork = next.networkPeer?.fingerprint
	if (prevNetwork !== nextNetwork) {
		changes.push(`peer.network_fingerprint: ${prevNetwork ?? 'none'} -> ${nextNetwork ?? 'none'}`)
	}

	const prevKeyFiles = keyListSignature(prev.vaultDebug?.key_files)
	const nextKeyFiles = keyListSignature(next.vaultDebug?.key_files)
	if (prevKeyFiles !== nextKeyFiles) {
		changes.push(`vault.key_files: ${prevKeyFiles || 'none'} -> ${nextKeyFiles || 'none'}`)
	}

	const prevBundleFiles = keyListSignature(prev.vaultDebug?.bundle_files)
	const nextBundleFiles = keyListSignature(next.vaultDebug?.bundle_files)
	if (prevBundleFiles !== nextBundleFiles) {
		changes.push(`vault.bundle_files: ${prevBundleFiles || 'none'} -> ${nextBundleFiles || 'none'}`)
	}

	return changes
}

async function captureKeySnapshot(
	label: string,
	clientLabel: string,
	backend: Backend,
	email: string,
	peerEmail: string,
	logSocket: WebSocket | null,
): Promise<KeySnapshot> {
	const snapshot: KeySnapshot = {
		label,
		client: clientLabel,
		email,
		peerEmail,
		capturedAt: new Date().toISOString(),
		errors: [],
	}

	try {
		snapshot.selfStatus = await backend.invoke('key_get_status', { email })
	} catch (err) {
		snapshot.errors?.push(`key_get_status: ${err}`)
	}

	try {
		snapshot.peerStatus = await backend.invoke('key_check_contact', { email: peerEmail })
	} catch (err) {
		snapshot.errors?.push(`key_check_contact: ${err}`)
	}

	try {
		snapshot.vaultDebug = await backend.invoke('key_check_vault_debug')
	} catch (err) {
		snapshot.errors?.push(`key_check_vault_debug: ${err}`)
	}

	try {
		const scan = await backend.invoke('network_scan_datasites')
		snapshot.networkPeer = summarizeNetworkPeer(scan, peerEmail)
		snapshot.networkCounts = {
			contacts: Array.isArray(scan?.contacts) ? scan.contacts.length : 0,
			discovered: Array.isArray(scan?.discovered) ? scan.discovered.length : 0,
		}
	} catch (err) {
		snapshot.errors?.push(`network_scan_datasites: ${err}`)
	}

	const summary = [
		`self_fp=${snapshot.selfStatus?.vault_fingerprint ?? 'none'}`,
		`export_fp=${snapshot.selfStatus?.export_fingerprint ?? 'none'}`,
		`export_matches=${snapshot.selfStatus?.export_matches ?? 'none'}`,
		`peer_cached_fp=${snapshot.peerStatus?.fingerprint ?? 'none'}`,
		`peer_network_fp=${snapshot.networkPeer?.fingerprint ?? 'none'}`,
		`vault_keys=${snapshot.vaultDebug?.key_files?.length ?? 0}`,
		`vault_bundles=${snapshot.vaultDebug?.bundle_files?.length ?? 0}`,
	].join(' ')

	console.log(`[${clientLabel}] key snapshot ${label}: ${summary}`)
	log(logSocket, { event: 'key-snapshot', ...snapshot })

	const previous = keySnapshots.get(clientLabel)
	if (previous) {
		const changes = diffKeySnapshots(previous, snapshot)
		if (changes.length > 0) {
			console.log(`[${clientLabel}] key change ${label}: ${changes.join(' | ')}`)
			log(logSocket, {
				event: 'key-change',
				label,
				client: clientLabel,
				email,
				peerEmail,
				changes,
			})
		}
	}
	keySnapshots.set(clientLabel, snapshot)

	return snapshot
}

async function syncMessagesWithDebug(
	backend: Backend,
	logSocket: WebSocket | null,
	clientLabel: string,
	label: string,
): Promise<void> {
	try {
		const result = await backend.invoke('sync_messages_with_failures')
		log(logSocket, {
			event: 'message-sync',
			client: clientLabel,
			label,
			...result,
		})
		if (result?.new_failed > 0) {
			const failed = await backend.invoke('list_failed_messages', { includeDismissed: true })
			log(logSocket, {
				event: 'message-sync-failures',
				client: clientLabel,
				label,
				failed,
			})
		}
	} catch (err) {
		log(logSocket, {
			event: 'message-sync-error',
			client: clientLabel,
			label,
			error: String(err),
		})
	}
}

test.describe('Pipelines Collaboration @pipelines-collab', () => {
	test('two clients collaborate on pipeline run and share results', async ({
		browser,
	}, testInfo) => {
		const testTimer = timer('Total test time')
		const wsPort1 = Number.parseInt(process.env.DEV_WS_BRIDGE_PORT_BASE || '3333', 10)
		const wsPort2 = wsPort1 + 1
		const email1 = process.env.CLIENT1_EMAIL || 'client1@sandbox.local'
		const email2 = process.env.CLIENT2_EMAIL || 'client2@sandbox.local'
		const syntheticDataDir =
			process.env.SYNTHETIC_DATA_DIR || path.join(process.cwd(), 'test-data', 'synthetic-genotypes')
		const datasetName = `collab_genotype_dataset_${Date.now()}`
		console.log(`Using dataset name: ${datasetName}`)
		let client2MockResult = ''
		let client1MockResult = ''
		let client1PrivateResult = ''
		let client1PrivateRunId: number | null = null
		let client2BiovaultHome = ''

		console.log('Setting up pipelines collaboration test')
		console.log(`Client1 (Alice): ${email1} (port ${wsPort1})`)
		console.log(`Client2 (Bob): ${email2} (port ${wsPort2})`)
		console.log(`Synthetic data dir: ${syntheticDataDir}`)

		// Verify synthetic data exists
		if (!fs.existsSync(syntheticDataDir)) {
			throw new Error(`Synthetic data directory not found: ${syntheticDataDir}`)
		}

		const logSocket = await ensureLogSocket()

		// Create browser contexts and pages for both clients
		const context1 = await browser.newContext()
		const context2 = await browser.newContext()
		const page1 = await context1.newPage()
		const page2 = await context2.newPage()

		// Log console errors and debug messages
		page1.on('console', (msg) => {
			if (msg.type() === 'error') {
				console.log(`[Client1 Error] ${msg.text()}`)
			} else if (msg.text().includes('[Network Dataset Debug]')) {
				console.log(`[Client1] ${msg.text()}`)
			}
		})
		page2.on('console', (msg) => {
			if (msg.type() === 'error') {
				console.log(`[Client2 Error] ${msg.text()}`)
			} else if (msg.text().includes('[Network Dataset Debug]')) {
				console.log(`[Client2] ${msg.text()}`)
			}
		})

		// Handle dialogs for both clients (needed for publish confirmations, etc.)
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
			console.log('Navigating to UI...')
			await page1.goto(`${baseUrl}?ws=${wsPort1}&real=1`)
			await page2.goto(`${baseUrl}?ws=${wsPort2}&real=1`)
			console.log('Applying window layouts...')
			await applyWindowLayout(page1, 0, 'client1')
			await applyWindowLayout(page2, 1, 'client2')
			console.log('Waiting for apps to be ready...')
			await waitForAppReady(page1, { timeout: 15_000 })
			console.log('Client1 app ready')
			await waitForAppReady(page2, { timeout: 15_000 })
			console.log('Client2 app ready')
			await ensureProfilePickerClosed(page1)
			console.log('Client1 profile picker closed')
			await ensureProfilePickerClosed(page2)
			console.log('Client2 profile picker closed')

			await captureKeySnapshot('initial', 'client1', backend1, email1, email2, logSocket)
			await captureKeySnapshot('initial', 'client2', backend2, email2, email1, logSocket)

			// Check if clients are onboarded
			console.log('Checking onboarding status...')
			let isOnboarded1: boolean
			let isOnboarded2: boolean
			try {
				isOnboarded1 = await backend1.invoke('check_is_onboarded')
				console.log(`Client1 onboarded: ${isOnboarded1}`)
			} catch (err) {
				console.error(`Failed to check client1 onboarding: ${err}`)
				throw err
			}
			try {
				isOnboarded2 = await backend2.invoke('check_is_onboarded')
				console.log(`Client2 onboarded: ${isOnboarded2}`)
			} catch (err) {
				console.error(`Failed to check client2 onboarding: ${err}`)
				throw err
			}

			// Do onboarding if needed
			if (!isOnboarded1 || !isOnboarded2) {
				const onboardingTimer = timer('Onboarding')
				console.log('\n=== Onboarding clients ===')

				// Run onboardings sequentially to avoid race conditions with dialog handling
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

			await captureKeySnapshot('post-onboarding', 'client1', backend1, email1, email2, logSocket)
			await captureKeySnapshot('post-onboarding', 'client2', backend2, email2, email1, logSocket)

			// ============================================================
			// Step 1: Exchange keys via Network tab
			// ============================================================
			const keysTimer = timer('Key exchange')
			console.log('\n=== Step 1: Exchange keys ===')

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
			console.log('Contacts imported!')

			await page1.reload()
			await page2.reload()
			await waitForAppReady(page1, { timeout: 10_000 })
			await waitForAppReady(page2, { timeout: 10_000 })
			await ensureProfilePickerClosed(page1)
			await ensureProfilePickerClosed(page2)
			keysTimer.stop()

			await captureKeySnapshot(
				'post-network-import',
				'client1',
				backend1,
				email1,
				email2,
				logSocket,
			)
			await captureKeySnapshot(
				'post-network-import',
				'client2',
				backend2,
				email2,
				email1,
				logSocket,
			)

			// ============================================================
			// Step 2: Client1 imports data and creates dataset
			// ============================================================
			log(logSocket, { event: 'step-2', action: 'create-dataset' })
			console.log('\n=== Step 2: Client1 imports data and creates dataset ===')

			// Navigate to Data tab on Client1
			await page1.locator('.nav-item[data-tab="data"]').click()
			await expect(page1.locator('#data-view.tab-content.active')).toBeVisible({
				timeout: UI_TIMEOUT,
			})

			// Import synthetic data
			const importBtn = page1.locator('#open-import-modal-btn')
			await expect(importBtn).toBeVisible()
			await importBtn.click()

			const importModal = page1.locator('#import-modal')
			await expect(importModal).not.toHaveAttribute('hidden')

			// Set folder path
			await page1.evaluate((folderPath) => {
				const w = window as any
				w.__TEST_SELECT_FOLDER__ = () => folderPath
			}, syntheticDataDir)

			const folderDropzone = page1.locator('#folder-dropzone')
			await folderDropzone.click()

			// Wait for file types section
			await page1.waitForTimeout(1000)
			await expect(page1.locator('#file-types-section')).toBeVisible({ timeout: 10_000 })

			// Select .txt files
			const txtCheckbox = page1.locator('.file-type-checkbox input[value=".txt"]')
			if ((await txtCheckbox.count()) > 0) {
				await txtCheckbox.check()
			}

			await page1.waitForTimeout(2000)

			// Select pattern if available
			const patternSection = page1.locator('#pattern-detection-section')
			if (await patternSection.isVisible().catch(() => false)) {
				const patternSuggestions = page1.locator('.pattern-suggestion')
				if ((await patternSuggestions.count()) > 0) {
					await patternSuggestions.first().click()
				}
			}

			// Select all files
			const selectAllFiles = page1.locator('#select-all-files')
			if ((await selectAllFiles.count()) > 0) {
				await selectAllFiles.check()
			}

			// Continue to review
			const continueBtn = page1.locator('#import-continue-btn')
			await expect(continueBtn).toBeEnabled({ timeout: 10_000 })
			await continueBtn.click()

			await expect(page1.locator('#import-modal-review')).toBeVisible({ timeout: 10_000 })

			// Wait for detection
			const detectionProgress = page1.locator('#detection-progress')
			if (await detectionProgress.isVisible().catch(() => false)) {
				await expect(detectionProgress).toBeHidden({ timeout: 30_000 })
			}

			// Import
			await page1.locator('#review-import-btn').click()
			await expect(importModal).toHaveAttribute('hidden', '', { timeout: 30_000 })
			await page1.waitForTimeout(2000)

			const importedCount = await page1.locator('#files-table-body tr, .file-row').count()
			console.log(`Imported ${importedCount} files`)

			// Switch to Datasets view and create dataset
			const datasetsToggle = page1.locator('#data-view-toggle .pill-button[data-view="datasets"]')
			await expect(datasetsToggle).toBeVisible({ timeout: UI_TIMEOUT })
			await datasetsToggle.click()
			await page1.waitForTimeout(1000)

			// Wait for datasets view to fully load (either the main section or empty state)
			await expect(page1.locator('#dataset-data-section')).toBeVisible({ timeout: UI_TIMEOUT })

			// Wait for new dataset button to be visible and click it
			const newDatasetBtn = page1.locator('#new-dataset-btn')
			await expect(newDatasetBtn).toBeVisible({ timeout: UI_TIMEOUT })
			await newDatasetBtn.click()

			// Wait for dataset editor to open
			await expect(page1.locator('#dataset-editor-section')).toBeVisible({ timeout: 10000 })

			// Fill dataset form
			await page1.locator('#dataset-form-name').fill(datasetName)
			await page1
				.locator('#dataset-form-description')
				.fill('Dataset for pipeline collaboration test')

			// Add asset with private + mock files
			const addAssetBtn = page1.locator('#dataset-add-asset')
			await expect(addAssetBtn).toBeVisible({ timeout: UI_TIMEOUT })
			await addAssetBtn.click()
			await page1.waitForTimeout(300)

			// Switch to File List mode
			const assetRow = page1.locator('#dataset-assets-list .asset-row').first()
			await expect(assetRow).toBeVisible({ timeout: 3000 })
			const fileListModeBtn = assetRow.locator('.pill-button[data-mode="list"]')
			await fileListModeBtn.click()
			await page1.waitForTimeout(300)

			// Add 5 private files
			console.log('Adding 5 files to Private side...')
			const privateExistingFilesBtn = assetRow.locator('.asset-side.private .btn-existing-files')
			await expect(privateExistingFilesBtn).toBeVisible()
			await privateExistingFilesBtn.click()

			const filePickerModal = page1.locator('#file-picker-modal')
			await expect(filePickerModal).toBeVisible({ timeout: 5000 })

			let filePickerCheckboxes = filePickerModal.locator('.file-picker-checkbox')
			const checkboxCount = await filePickerCheckboxes.count()
			console.log(`File picker shows ${checkboxCount} files`)
			expect(checkboxCount).toBeGreaterThanOrEqual(10)

			for (let i = 0; i < 5; i++) {
				await filePickerCheckboxes.nth(i).check()
			}

			const addSelectedBtn = page1.locator('#file-picker-add')
			await expect(addSelectedBtn).toBeVisible()
			await addSelectedBtn.click()
			await expect(filePickerModal).toBeHidden({ timeout: 3000 })
			await page1.waitForTimeout(500)

			// Verify private files added
			const privateFileItems = assetRow.locator('.asset-side.private .file-item')
			const privateCount = await privateFileItems.count()
			console.log(`Private side has ${privateCount} files`)
			expect(privateCount).toBe(5)

			// Add 5 mock files
			console.log('Adding 5 files to Mock side...')
			const mockExistingFilesBtn = assetRow.locator('.asset-side.mock .btn-existing-files')
			await expect(mockExistingFilesBtn).toBeVisible()
			await mockExistingFilesBtn.click()

			await expect(filePickerModal).toBeVisible({ timeout: 5000 })

			filePickerCheckboxes = filePickerModal.locator('.file-picker-checkbox')
			for (let i = 5; i < 10; i++) {
				await filePickerCheckboxes.nth(i).check()
			}

			await addSelectedBtn.click()
			await expect(filePickerModal).toBeHidden({ timeout: 3000 })
			await page1.waitForTimeout(500)

			// Verify mock files added
			const mockFileItems = assetRow.locator('.asset-side.mock .file-item')
			const mockCount = await mockFileItems.count()
			console.log(`Mock side has ${mockCount} files`)
			expect(mockCount).toBe(5)

			// Save dataset
			const saveDatasetBtn = page1.locator('#dataset-editor-save')
			await expect(saveDatasetBtn).toBeVisible()
			await saveDatasetBtn.click()
			await expect(page1.locator('#dataset-editor-section')).toBeHidden({ timeout: 10000 })
			console.log('Dataset created!')

			// Publish dataset
			const datasetCard = page1
				.locator('#datasets-grid .dataset-card')
				.filter({ hasText: datasetName })
			const publishBtn = datasetCard.locator('.btn-publish, button:has-text("Publish")')
			await expect(publishBtn).toBeVisible({ timeout: 5000 })
			await publishBtn.click()
			await page1.waitForTimeout(3000)
			console.log('Dataset published!')

			// ============================================================
			// Step 3: Client2 (data scientist) imports HERC2 Pipeline
			// ============================================================
			log(logSocket, { event: 'step-3', action: 'import-pipeline' })
			console.log('\n=== Step 3: Client2 imports HERC2 Pipeline ===')

			// Import HERC2 from local bioscript examples (faster than GitHub)
			const herc2LocalPath = path.join(
				process.cwd(),
				'bioscript',
				'examples',
				'herc2',
				'herc2-classifier',
			)
			const herc2FlowPath = path.join(herc2LocalPath, 'flow.yaml')
			console.log(`Importing HERC2 from: ${herc2FlowPath}`)

			try {
				await backend2.invoke('import_pipeline', {
					pipelineFile: herc2FlowPath,
					overwrite: true,
				})
				console.log('Client2: HERC2 pipeline imported from local path!')
			} catch (err) {
				console.log(`Import error (may be ok if already exists): ${err}`)
			}

			// Navigate to Pipelines tab to verify
			await page2.locator('.nav-item[data-tab="run"]').click()
			await expect(page2.locator('#run-view')).toBeVisible({ timeout: UI_TIMEOUT })
			await page2.waitForTimeout(1000)

			// ============================================================
			// Step 4: Wait for dataset to appear on Client2's Network tab
			// ============================================================
			log(logSocket, { event: 'step-4', action: 'wait-network-sync' })
			console.log('\n=== Step 4: Wait for dataset on Client2 Network ===')

			// Navigate Client2 to Network tab > Datasets
			await page2.locator('.nav-item[data-tab="network"]').click()
			await expect(page2.locator('.network-container, #network-view')).toBeVisible({
				timeout: UI_TIMEOUT,
			})

			// Click on Datasets tab within Network
			const networkDatasetsTab = page2.locator('#network-view-toggle button[data-view="datasets"]')
			await expect(networkDatasetsTab).toBeVisible({ timeout: UI_TIMEOUT })
			await networkDatasetsTab.click()
			await page2.waitForTimeout(500)

			// Wait for Client1's dataset to appear
			const syncTimer = timer('Dataset sync to network')
			let datasetFound = false
			let targetDatasetForMock: any = null
			const syncStart = Date.now()

			// Wait for dataset cards to render (they might already be there)
			await page2.waitForTimeout(2000)

			while (Date.now() - syncStart < SYNC_TIMEOUT) {
				// Trigger sync on BOTH clients - Client1 needs to upload, Client2 needs to download
				try {
					await Promise.all([
						backend1.invoke('trigger_syftbox_sync').catch(() => {}),
						backend2.invoke('trigger_syftbox_sync').catch(() => {}),
					])
				} catch {}

				// Check for dataset cards
				// Network datasets use .dataset-item class (not .dataset-card which is for local datasets)
				const datasetCards = page2.locator('.dataset-item')
				const count = await datasetCards.count()
				const targetDatasetCard = getNetworkDatasetItem(page2, datasetName, email1)
				const targetCount = await targetDatasetCard.count()
				console.log(`Checking for dataset cards... found: ${count} (target: ${targetCount})`)

				if (targetCount > 0) {
					console.log(`Found target dataset "${datasetName}" on network!`)
					datasetFound = true
					try {
						const scanResult = await backend2.invoke('network_scan_datasets')
						const datasets = scanResult?.datasets || []
						targetDatasetForMock = datasets.find((d: any) => d.name === datasetName)
					} catch {}
					break
				}

				// Only reload and retry if not found
				console.log('No datasets found yet, reloading...')
				// Removed duplicate sync trigger since we now sync both at start of loop

				await page2.reload()
				await waitForAppReady(page2, { timeout: 10_000 })
				await page2.locator('.nav-item[data-tab="network"]').click()
				await page2.waitForTimeout(1000)

				// Click Datasets tab
				const datasetsTab = page2.locator('#network-view-toggle button[data-view="datasets"]')
				if (await datasetsTab.isVisible().catch(() => false)) {
					await datasetsTab.click()
					await page2.waitForTimeout(1000)
				}

				await page2.waitForTimeout(2000)
			}

			syncTimer.stop()
			if (!datasetFound) {
				throw new Error('Dataset not found on network within timeout')
			}

			// Wait for all mock files to sync (5 files expected - test adds 5 mock + 5 private)
			// This prevents race condition where Client2 runs pipeline before all files are available
			const EXPECTED_MOCK_FILES = 5
			const mockSyncTimer = timer('Mock files sync')
			console.log(`\nWaiting for all ${EXPECTED_MOCK_FILES} mock files to sync...`)
			let mockFilesReady = false
			const mockSyncStart = Date.now()
			const MOCK_SYNC_TIMEOUT = 60_000 // 60 seconds

			// DEBUG: First check what Client1 has in their dataset
			try {
				const client1Datasets = await backend1.invoke('get_datasets', {})
				const client1Dataset = client1Datasets?.find((d: any) => d.name === datasetName)
				console.log('\n=== DEBUG: Client1 Dataset Info ===')
				console.log(`Dataset found: ${!!client1Dataset}`)
				if (client1Dataset) {
					console.log(`Assets: ${JSON.stringify(client1Dataset.assets, null, 2)}`)
				}
			} catch (err) {
				console.log('DEBUG: Failed to get client1 datasets:', err)
			}

			while (Date.now() - mockSyncStart < MOCK_SYNC_TIMEOUT) {
				try {
					// Trigger sync
					await Promise.all([
						backend1.invoke('trigger_syftbox_sync').catch(() => {}),
						backend2.invoke('trigger_syftbox_sync').catch(() => {}),
					])
					await page2.waitForTimeout(2000)

					const scanResult = await backend2.invoke('network_scan_datasets')
					const datasets = scanResult?.datasets || []
					const targetDataset = datasets.find((d: any) => d.name === datasetName)

					if (targetDataset && targetDataset.assets?.length > 0) {
						const asset = targetDataset.assets[0]
						const mockCount = asset.mock_entries?.length || 0
						const mockPath = asset.mock_path
						console.log(`Mock files synced: ${mockCount}/${EXPECTED_MOCK_FILES}, mock_path: ${mockPath}`)

						// DEBUG: Log each mock entry
						if (asset.mock_entries?.length > 0) {
							console.log('Mock entries:')
							asset.mock_entries.forEach((entry: any, i: number) => {
								console.log(`  [${i}] ${entry.participant_id}: ${entry.url}`)
							})
						}

						if (mockCount >= EXPECTED_MOCK_FILES) {
							console.log(`All ${EXPECTED_MOCK_FILES} mock files synced!`)
							mockFilesReady = true
							break
						}
					} else {
						console.log(`Dataset "${datasetName}" not found or no assets yet`)
					}
				} catch (err) {
					console.log('Error checking mock files:', err)
				}
				await page2.waitForTimeout(3000)
			}
			mockSyncTimer.stop()

			if (!mockFilesReady) {
				console.warn(`Warning: Only partial mock files synced, proceeding anyway`)
			}

			if (targetDatasetForMock?.assets?.length) {
				const asset = targetDatasetForMock.assets[0]
				const mockEntries = asset.mock_entries || []
				const mockFilenames = extractMockFilenames(mockEntries)
				const assetKey = asset.key || 'asset_1'

				const dataDir1 = await getSyftboxDataDir(backend1)
				const dataDir2 = await getSyftboxDataDir(backend2)
				const assetsDir1 = path.join(
					resolveDatasitesRoot(dataDir1),
					email1,
					'public',
					'biovault',
					'datasets',
					datasetName,
					'assets',
				)
				const assetsDir2 = path.join(
					resolveDatasitesRoot(dataDir2),
					email1,
					'public',
					'biovault',
					'datasets',
					datasetName,
					'assets',
				)

				await waitForFilesOnDisk('Client1', assetsDir1, mockFilenames, 60_000)
				await waitForFilesOnDisk('Client2', assetsDir2, mockFilenames, 60_000)

				// Wait for file CONTENT to match between source and synced locations
				// This catches cases where files exist but content hasn't fully synced
				await waitForFilesContentMatch(assetsDir1, assetsDir2, mockFilenames, 90_000)

				const csvPath1 = path.join(assetsDir1, `${assetKey}.csv`)
				const csvPath2 = path.join(assetsDir2, `${assetKey}.csv`)
				const csv1 = await readTextFileWithRetry(csvPath1, 30_000)
				const csv2 = await readTextFileWithRetry(csvPath2, 30_000)
				const normalizedCsv1 = normalizeCsvResult(csv1)
				const normalizedCsv2 = normalizeCsvResult(csv2)
				if (normalizedCsv1 !== normalizedCsv2) {
					console.log(`[CSV Compare] Client1: ${normalizedCsv1}`)
					console.log(`[CSV Compare] Client2: ${normalizedCsv2}`)
					throw new Error('Mock CSV mismatch between Client1 and Client2 assets')
				}
			}

			// ============================================================
			// Step 5: Client2 runs imported pipeline on peer's mock data
			// ============================================================
			log(logSocket, { event: 'step-5', action: 'run-pipeline-mock' })
			console.log('\n=== Step 5: Client2 runs HERC2 pipeline on mock data ===')

			// DEBUG: Query network datasets from backend to see what's returned
			try {
				const networkDatasets = await backend2.invoke('network_scan_datasets')
				console.log('\n=== DEBUG: Network Datasets from Backend ===')
				console.log(JSON.stringify(networkDatasets, null, 2))
			} catch (err) {
				console.log('DEBUG: Failed to get network datasets:', err)
			}

			// DEBUG: Check what's rendered in the DOM
			const datasetInfo = await page2.evaluate(() => {
				const items = document.querySelectorAll('.dataset-item')
				return Array.from(items).map((item) => {
					const row = item.querySelector('.dataset-row')
					const runBtn = item.querySelector('.run-pipeline-btn')
					const requestBtn = item.querySelector('.request-run-btn')
					return {
						name: item.dataset.name,
						owner: item.dataset.owner,
						runBtnDisplay: runBtn ? getComputedStyle(runBtn).display : 'not found',
						requestBtnDisplay: requestBtn ? getComputedStyle(requestBtn).display : 'not found',
					}
				})
			})
			console.log('\n=== DEBUG: Dataset Items in DOM ===')
			console.log(JSON.stringify(datasetInfo, null, 2))

			// Find the dataset card and click "Run Pipeline" button
			// This button appears for trusted peer datasets that have mock data
			const networkDatasetCardForRun = getNetworkDatasetItem(page2, datasetName, email1)
			const runPipelineOnMockBtn = networkDatasetCardForRun.locator('.run-pipeline-btn')
			await expect(runPipelineOnMockBtn).toBeVisible({ timeout: UI_TIMEOUT })
			console.log('Found Run Pipeline button for mock data, clicking...')
			await runPipelineOnMockBtn.click()
			await page2.waitForTimeout(2000)

			// Wait for the data run modal to appear (pipeline selection modal)
			console.log('Waiting for pipeline selection modal...')
			const dataRunModal = page2.locator('#data-run-modal')
			await expect(dataRunModal).toBeVisible({ timeout: UI_TIMEOUT })
			console.log('Pipeline selection modal visible!')

			// The herc2-classifier pipeline should be listed - select it if not already
			const herc2RadioOption = dataRunModal.locator(
				'input[name="data-run-pipeline"][value*="herc2"], .data-run-pipeline-option:has-text("herc2")',
			)
			if (await herc2RadioOption.isVisible().catch(() => false)) {
				await herc2RadioOption.click()
			}

			const runsBeforeMock = await backend2.invoke('get_pipeline_runs', {})
			const previousIds2 = new Set((runsBeforeMock || []).map((run: any) => run.id))

			// Click the Run button
			const runBtn = dataRunModal.locator('#data-run-run-btn')
			await expect(runBtn).toBeVisible({ timeout: UI_TIMEOUT })
			console.log('Clicking Run button...')
			await runBtn.click()
			await page2.waitForTimeout(1000)

			// Handle "Docker isn't running" dialog if it appears
			const runAnywayBtn = page2.getByRole('button', { name: 'Run anyway' })
			if (await runAnywayBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
				console.log('Docker dialog detected, clicking "Run anyway"...')
				await runAnywayBtn.click()
				await page2.waitForTimeout(2000)
			}
			console.log('Pipeline run started on mock data!')

			if (DEBUG_PIPELINE_PAUSE_MS > 0) {
				log(logSocket, { event: 'debug-pause', ms: DEBUG_PIPELINE_PAUSE_MS })
				console.log(`Pausing ${DEBUG_PIPELINE_PAUSE_MS}ms for Nextflow inspection...`)
				await page2.waitForTimeout(DEBUG_PIPELINE_PAUSE_MS)
			}

			// Wait for run to complete by checking backend
			const mockRunTimer = timer('Mock data pipeline run')
			const mockRun2 = await waitForNewRun(backend2, previousIds2)
			console.log(`Waiting for run ${mockRun2.id} to complete...`)
			const { status, run: mockRun2Final } = await waitForRunCompletion(
				page2,
				backend2,
				mockRun2.id,
			)
			console.log(`Pipeline run on mock data completed with status: ${status}`)
			expect(status).toBe('success')
			mockRunTimer.stop()

			const mockResultPath2 = resolvePipelineResultPath(mockRun2Final)
			console.log(`[TSV] Reading client2 mock result from: ${mockResultPath2}`)
			client2MockResult = await readTextFileWithRetry(mockResultPath2)
			console.log(`[TSV] client2MockResult read, length: ${client2MockResult.length}`)
			client2BiovaultHome = getBiovaultHomeFromRun(mockRun2Final)

			// DEBUG: Log Client2 run metadata to see inputs used
			console.log('\n=== DEBUG: Client2 Mock Run Metadata ===')
			console.log(`Run ID: ${mockRun2Final.id}`)
			console.log(`Work dir: ${mockRun2Final.work_dir}`)
			console.log(`Results dir: ${mockRun2Final.results_dir}`)
			if (mockRun2Final.metadata) {
				try {
					const meta = typeof mockRun2Final.metadata === 'string'
						? JSON.parse(mockRun2Final.metadata)
						: mockRun2Final.metadata
					console.log(`Inputs: ${JSON.stringify(meta.inputs, null, 2)}`)
				} catch (e) {
					console.log(`Raw metadata: ${mockRun2Final.metadata}`)
				}
			}
			// Read and log samplesheet for Client2
			const samplesheetPath2 = path.join(mockRun2Final.results_dir, 'inputs', 'selected_participants.csv')
			try {
				const samplesheet2 = await readTextFileWithRetry(samplesheetPath2, 5000)
				console.log(`\n=== DEBUG: Client2 Samplesheet ===\n${samplesheet2}`)
			} catch (e) {
				console.log(`DEBUG: Could not read Client2 samplesheet: ${e}`)
			}

			await captureKeySnapshot('post-mock-run', 'client2', backend2, email2, email1, logSocket)
			await captureKeySnapshot('post-mock-run', 'client1', backend1, email1, email2, logSocket)

			// Navigate to Runs tab to verify
			const runsTab = page2.locator(
				'.tab-pills button:has-text("Runs"), .pill-button:has-text("Runs")',
			)
			if (await runsTab.isVisible().catch(() => false)) {
				await runsTab.click()
				await page2.waitForTimeout(1000)

				// Verify run appears in list
				const runCard = page2.locator('.run-card, .run-item').first()
				await expect(runCard).toBeVisible({ timeout: UI_TIMEOUT })
				console.log('✓ Run verified in Runs tab!')
			}

			// ============================================================
			// Step 6: Client2 clicks "Request Run" to request pipeline on peer's private data
			// ============================================================
			log(logSocket, { event: 'step-6', action: 'request-pipeline-run' })
			console.log('\n=== Step 6: Client2 requests pipeline run on peer private data ===')

			// Navigate back to Network > Datasets
			await page2.locator('.nav-item[data-tab="network"]').click()
			await expect(page2.locator('.network-container, #network-view')).toBeVisible({
				timeout: UI_TIMEOUT,
			})
			const datasetsTabForRequest = page2.locator(
				'#network-view-toggle button[data-view="datasets"]',
			)
			if (await datasetsTabForRequest.isVisible().catch(() => false)) {
				await datasetsTabForRequest.click()
				await page2.waitForTimeout(1000)
			}

			// Find the dataset card and click "Request Run" button
			// The "Request Run" button is visible for peer datasets (not "Run Pipeline" which is for own datasets)
			const networkDatasetCard = getNetworkDatasetItem(page2, datasetName, email1)
			const requestRunBtn = networkDatasetCard.locator('.request-run-btn')
			await expect(requestRunBtn).toBeVisible({ timeout: UI_TIMEOUT })
			console.log('Found Request Run button, clicking...')
			await requestRunBtn.click()
			await page2.waitForTimeout(2000)

			// Wait for the "Request Pipeline Run" modal to appear
			console.log('Waiting for Request Pipeline Run modal...')
			const requestModal = page2.locator('#request-pipeline-modal')
			await expect(requestModal).toBeVisible({ timeout: UI_TIMEOUT })
			console.log('Request modal visible!')

			// The pipeline should already be selected (herc2-classifier)
			// Click "Send Request" button
			const sendRequestBtn = page2.locator('#send-pipeline-request-btn')
			await expect(sendRequestBtn).toBeVisible({ timeout: UI_TIMEOUT })
			console.log('Clicking Send Request...')
			await sendRequestBtn.click()
			await page2.waitForTimeout(3000)
			console.log('Pipeline request sent!')

			await captureKeySnapshot('post-request-send', 'client2', backend2, email2, email1, logSocket)
			await captureKeySnapshot('post-request-send', 'client1', backend1, email1, email2, logSocket)

			// ============================================================
			// Step 7: Client1 receives request in Messages
			// ============================================================
			log(logSocket, { event: 'step-7', action: 'receive-request' })
			console.log('\n=== Step 7: Client1 receives request in Messages ===')

			// Trigger sync on Client1
			await backend1.invoke('trigger_syftbox_sync')
			await syncMessagesWithDebug(backend1, logSocket, 'client1', 'receive-request')
			await page1.waitForTimeout(3000)

			await captureKeySnapshot('post-request-sync', 'client1', backend1, email1, email2, logSocket)

			// Navigate to Messages
			await page1.locator('.nav-item[data-tab="messages"]').click()
			await expect(page1.locator('#messages-view, .messages-container')).toBeVisible({
				timeout: UI_TIMEOUT,
			})
			await page1.waitForTimeout(1000)

			const requestCard = await waitForMessageCard(
				page1,
				backend1,
				'.message-pipeline-request',
				SYNC_TIMEOUT,
				logSocket,
				'client1',
				'wait-request-card',
			)
			console.log('Pipeline request received!')

			// Click Import Pipeline button if available
			const importPipelineBtn = requestCard.locator('button:has-text("Import Pipeline")')
			if (await importPipelineBtn.isVisible().catch(() => false)) {
				await importPipelineBtn.click()
				await page1.waitForTimeout(2000)
				console.log('Pipeline imported from request!')
			}

			// ============================================================
			// Step 8: Client1 runs pipeline on mock data, then private data
			// ============================================================
			log(logSocket, { event: 'step-8', action: 'run-pipeline' })
			console.log('\n=== Step 8: Client1 runs pipeline on mock + private data ===')

			// DEBUG: Check what mock files Client1 sees before running
			try {
				const client1Datasets = await backend1.invoke('get_datasets', {})
				const client1Dataset = client1Datasets?.find((d: any) => d.name === datasetName)
				console.log('\n=== DEBUG: Client1 Dataset before run ===')
				if (client1Dataset && client1Dataset.assets?.length > 0) {
					const asset = client1Dataset.assets[0]
					console.log(`Asset key: ${asset.key}`)
					console.log(`Mock path: ${asset.mock_path}`)
					console.log(`Mock file ID: ${asset.mock_file_id}`)
					console.log(`Resolved mock path: ${asset.resolved_mock_path}`)
				}
			} catch (err) {
				console.log('DEBUG: Failed to get client1 dataset:', err)
			}

			const mockRun1 = await runDatasetPipeline(page1, backend1, datasetName, 'mock')
			console.log(`Pipeline mock run started: ${mockRun1.id}`)
			const { status: mockStatus, run: mockRun1Final } = await waitForRunCompletion(
				page1,
				backend1,
				mockRun1.id,
			)
			console.log(`Pipeline mock run completed with status: ${mockStatus}`)
			expect(mockStatus).toBe('success')

			const mockResultPath1 = resolvePipelineResultPath(mockRun1Final)
			client1MockResult = await readTextFileWithRetry(mockResultPath1)

			// DEBUG: Log Client1 run metadata to see inputs used
			console.log('\n=== DEBUG: Client1 Mock Run Metadata ===')
			console.log(`Run ID: ${mockRun1Final.id}`)
			console.log(`Work dir: ${mockRun1Final.work_dir}`)
			console.log(`Results dir: ${mockRun1Final.results_dir}`)
			if (mockRun1Final.metadata) {
				try {
					const meta = typeof mockRun1Final.metadata === 'string'
						? JSON.parse(mockRun1Final.metadata)
						: mockRun1Final.metadata
					console.log(`Inputs: ${JSON.stringify(meta.inputs, null, 2)}`)
				} catch (e) {
					console.log(`Raw metadata: ${mockRun1Final.metadata}`)
				}
			}
			// Read and log samplesheet for Client1
			const samplesheetPath1 = path.join(mockRun1Final.results_dir, 'inputs', 'selected_participants.csv')
			try {
				const samplesheet1 = await readTextFileWithRetry(samplesheetPath1, 5000)
				console.log(`\n=== DEBUG: Client1 Samplesheet ===\n${samplesheet1}`)
			} catch (e) {
				console.log(`DEBUG: Could not read Client1 samplesheet: ${e}`)
			}

			console.log(`[TSV Compare] client1MockResult path: ${mockResultPath1}`)
			console.log(`[TSV Compare] client1MockResult length: ${client1MockResult.length}`)
			console.log(`[TSV Compare] client2MockResult length: ${client2MockResult.length}`)
			const normalized1 = normalizeTsvResult(client1MockResult)
			const normalized2 = normalizeTsvResult(client2MockResult)
			console.log(`[TSV Compare] normalized client1: ${normalized1.substring(0, 500)}...`)
			console.log(`[TSV Compare] normalized client2: ${normalized2.substring(0, 500)}...`)
			if (normalized1 !== normalized2) {
				console.log(
					`[TSV Compare] MISMATCH! client1 lines: ${normalized1.split('\n').length}, client2 lines: ${normalized2.split('\n').length}`,
				)
				// Log first difference
				const lines1 = normalized1.split('\n')
				const lines2 = normalized2.split('\n')
				for (let i = 0; i < Math.max(lines1.length, lines2.length); i++) {
					if (lines1[i] !== lines2[i]) {
						console.log(`[TSV Compare] First diff at line ${i}:`)
						console.log(`[TSV Compare]   client1: ${lines1[i]}`)
						console.log(`[TSV Compare]   client2: ${lines2[i]}`)
						break
					}
				}
			}
			expect(normalized1).toBe(normalized2)

			const privateRun1 = await runDatasetPipeline(page1, backend1, datasetName, 'real')
			console.log(`Pipeline private run started: ${privateRun1.id}`)
			const { status: privateStatus, run: privateRun1Final } = await waitForRunCompletion(
				page1,
				backend1,
				privateRun1.id,
			)
			console.log(`Pipeline private run completed with status: ${privateStatus}`)
			expect(privateStatus).toBe('success')
			client1PrivateRunId = privateRun1Final.id

			const privateResultPath1 = resolvePipelineResultPath(privateRun1Final)
			client1PrivateResult = await readTextFileWithRetry(privateResultPath1)

			await captureKeySnapshot('post-client1-runs', 'client1', backend1, email1, email2, logSocket)

			if (!client1PrivateRunId) {
				throw new Error('Private pipeline run did not start correctly')
			}

			// ============================================================
			// Step 9: Client1 shares results back
			// ============================================================
			log(logSocket, { event: 'step-9', action: 'share-results' })
			console.log('\n=== Step 9: Client1 shares results back ===')

			// Navigate to Messages and send results back from the request card
			await page1.locator('.nav-item[data-tab="messages"]').click()
			await expect(page1.locator('#messages-view, .messages-container')).toBeVisible({
				timeout: UI_TIMEOUT,
			})
			await page1.waitForTimeout(2000)

			const requestCardForSend = page1.locator('.message-pipeline-request')
			await expect(requestCardForSend).toBeVisible({ timeout: 10_000 })

			const runSelect = requestCardForSend.locator('select')
			await expect(runSelect).toBeVisible({ timeout: 10_000 })
			await expect(runSelect).toBeEnabled({ timeout: 10_000 })
			await runSelect.selectOption(client1PrivateRunId.toString())

			const sendBackBtn = requestCardForSend.locator('button:has-text("Send Back")')
			await expect(sendBackBtn).toBeVisible({ timeout: 10_000 })
			await sendBackBtn.click()

			const sendConfirmBtn = page1.locator('#send-results-confirm')
			await expect(sendConfirmBtn).toBeVisible({ timeout: 10_000 })
			const outputCheckboxes = page1.locator('input[data-output-path]')
			const outputCheckboxCount = await outputCheckboxes.count()
			expect(outputCheckboxCount).toBeGreaterThan(0)
			console.log(`Found ${outputCheckboxCount} output file checkboxes`)

			// Uncheck all files first
			for (let i = 0; i < outputCheckboxCount; i++) {
				const checkbox = outputCheckboxes.nth(i)
				if (await checkbox.isChecked()) {
					await checkbox.uncheck()
				}
			}
			console.log('Unchecked all output files')

			// Recheck only result_HERC2.tsv
			const herc2Checkbox = page1.locator('input[data-output-path*="result_HERC2.tsv"]')
			if ((await herc2Checkbox.count()) > 0) {
				await herc2Checkbox.check()
				console.log('Checked only result_HERC2.tsv for sharing')
			} else {
				// Fallback: check first checkbox if specific file not found
				console.log('result_HERC2.tsv checkbox not found, checking first file')
				await outputCheckboxes.first().check()
			}

			await sendConfirmBtn.click()
			await page1.waitForTimeout(3000)
			console.log('Private results sent!')

			await captureKeySnapshot('post-results-send', 'client1', backend1, email1, email2, logSocket)

			// ============================================================
			// Step 10: Client2 receives results
			// ============================================================
			log(logSocket, { event: 'step-10', action: 'receive-results' })
			console.log('\n=== Step 10: Client2 receives results ===')

			// Trigger sync on Client2
			await backend2.invoke('trigger_syftbox_sync')
			await syncMessagesWithDebug(backend2, logSocket, 'client2', 'receive-results')
			await page2.waitForTimeout(3000)

			await captureKeySnapshot('post-results-sync', 'client2', backend2, email2, email1, logSocket)

			// Navigate to Messages
			await page2.locator('.nav-item[data-tab="messages"]').click()
			await expect(page2.locator('#messages-view, .messages-container')).toBeVisible({
				timeout: UI_TIMEOUT,
			})
			await page2.waitForTimeout(1000)

			const resultsCard = await waitForMessageCard(
				page2,
				backend2,
				'.message-pipeline-results',
				SYNC_TIMEOUT,
				logSocket,
				'client2',
				'wait-results-card',
			)
			console.log('✓ Pipeline results received!')

			// Verify files are listed
			const fileItems = resultsCard.locator('.result-file')
			const fileCount = await fileItems.count()
			console.log(`Results contain ${fileCount} file(s)`)

			await clickImportResults(page2, 60_000)
			await page2.waitForTimeout(3000)

			if (!client2BiovaultHome) {
				throw new Error('Client2 BioVault home path not resolved')
			}

			const resultsRoot = path.join(client2BiovaultHome, 'results')
			const importedResultPath = await waitForImportedResults(resultsRoot, client1PrivateRunId!)

			const importedBytes = fs.readFileSync(importedResultPath)
			const header = importedBytes.slice(0, 4).toString('utf8')
			expect(header).not.toBe('SYC1')

			const importedContent = importedBytes.toString('utf8')
			expect(importedContent.trim()).toBe(client1PrivateResult.trim())

			// ============================================================
			// Summary
			// ============================================================
			console.log('\n=== TEST COMPLETED ===')
			console.log('Pipeline collaboration flow tested:')
			console.log('  ✓ Client1 created dataset with mock + private data')
			console.log('  ✓ Client2 imported HERC2 pipeline')
			console.log('  ✓ Client2 ran pipeline on mock data successfully')
			console.log('  ✓ Client2 sent pipeline request for private data')
			console.log('  ✓ Client1 received request and ran pipeline (mock + private)')
			console.log('  ✓ Client1 shared private results back')
			console.log('  ✓ Client2 imported private results (unencrypted)')

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
