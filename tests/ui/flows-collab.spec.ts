/**
 * Flows Collaboration Test (Two Clients)
 * Tests the full collaborative flow workflow:
 * 1. Client1 (Alice) creates dataset with private + mock data
 * 2. Client1 creates HERC2 flow (or imports from local bioscript)
 * 3. Client2 (Bob) imports HERC2 flow
 * 4. Client2 sees Alice's dataset on Network > Datasets tab
 * 5. Client2 runs HERC2 flow on mock data (verifies it works locally)
 * 6. Client2 sends "Request Run" for private data
 * 7. Client1 receives request in Messages
 * 8. Client1 runs flow on real data (start at concurrency 1, pause, resume at 5)
 * 9. Client1 shares results back to Client2
 * 10. Client2 receives and verifies results
 *
 * This is the UI version of inbox-ping-pong.yaml
 *
 * Usage:
 *   ./test-scenario.sh --flows-collab
 *
 * @tag flows-collab
 */
import { expect, test, type Page, pauseForInteractive } from './playwright-fixtures'
import WebSocket from 'ws'
import { createHash } from 'node:crypto'
import { execSync } from 'node:child_process'
import * as fs from 'fs'
import * as path from 'path'
import { applyWindowLayout, ensureProfileSelected, waitForAppReady } from './test-helpers.js'
import { setWsPort, completeOnboarding, ensureLogSocket, log } from './onboarding-helper.js'

const TEST_TIMEOUT = 480_000 // 8 minutes max (two clients + flow runs)
const UI_TIMEOUT = 10_000
const FLOW_RUN_TIMEOUT = 180_000 // 3 minutes for flow to complete
const SYNC_TIMEOUT = 60_000 // 1 minute for sync operations
const PEER_DID_TIMEOUT_MS = 60_000 // 1 minute for peer DID sync (avoid long stalls)
const COLLAB_DATASET_PREFIX = 'collab_genotype_dataset_'
const DEBUG_PIPELINE_PAUSE_MS = (() => {
	const raw = Number.parseInt(process.env.PIPELINES_COLLAB_PAUSE_MS || '30000', 10)
	return Number.isFinite(raw) ? raw : 30_000
})()
const WINDOWS_MOCK_RUN_ATTEMPTS = (() => {
	const raw = Number.parseInt(process.env.FLOWS_COLLAB_WINDOWS_MOCK_RUN_ATTEMPTS || '2', 10)
	if (!Number.isFinite(raw)) return 2
	return Math.max(1, raw)
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
	allowMissing = false,
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
				await backend.invoke('network_scan_datasites')
			} catch (err) {
				// Ignore sync errors
			}
		}
		syncTriggerCount++
		await new Promise((r) => setTimeout(r, 500))
	}

	const message = `Timed out waiting for peer DID file: ${didPaths.join(', ')}`
	if (allowMissing) {
		console.warn(`[${label}] ⚠️ ${message} (continuing)`)
		return ''
	}
	throw new Error(message)
}

async function waitForFlowRequestMetadata(
	backend: Backend,
	flowName: string,
	timeoutMs = SYNC_TIMEOUT,
): Promise<any> {
	const start = Date.now()
	const subjectPrefix = `Flow Request: ${flowName}`
	while (Date.now() - start < timeoutMs) {
		try {
			const threads = await backend.invoke('list_message_threads', {
				scope: 'inbox',
				limit: 50,
			})
			const flowThread = (threads || []).find((thread: any) =>
				String(thread?.subject || '').includes(subjectPrefix),
			)
			if (flowThread?.thread_id) {
				const messages = await backend.invoke('get_thread_messages', {
					threadId: flowThread.thread_id,
				})
				for (const msg of messages || []) {
					const flowRequest = msg?.metadata?.flow_request
					if (flowRequest?.flow_location) {
						return flowRequest
					}
				}
			}
		} catch (error) {
			// Ignore and retry
		}
		try {
			await backend.invoke('trigger_syftbox_sync')
		} catch (error) {
			// Ignore sync errors
		}
		await new Promise((r) => setTimeout(r, 1000))
	}
	throw new Error(`Timed out waiting for flow request metadata for ${flowName}`)
}

async function waitForSyncedFlowFolder(
	backend: Backend,
	flowRequest: any,
	timeoutMs = SYNC_TIMEOUT,
): Promise<string> {
	const start = Date.now()
	const flowLocation = flowRequest?.flow_location
	if (!flowLocation) {
		throw new Error('Flow request missing flow_location')
	}
	const folderPath = await backend.invoke('resolve_syft_url_to_local_path', {
		syftUrl: flowLocation,
	})
	const flowYaml = path.join(folderPath, 'flow.yaml')
	let lastReason = ''

	while (Date.now() - start < timeoutMs) {
		try {
			const status = await backend.invoke('flow_request_sync_status', { flowLocation })
			if (status?.ready) {
				return folderPath
			}
			const missingPaths = Array.isArray(status?.missingPaths) ? status.missingPaths : []
			lastReason =
				status?.reason || (missingPaths.length ? `missing: ${missingPaths.join(', ')}` : '')
		} catch {
			// Fallback for older backends or transient bridge errors.
			lastReason = ''
		}

		// Fallback filesystem check: flow.yaml is sufficient when no extra module dirs are required.
		if (fs.existsSync(flowYaml)) {
			const modulesDir = path.join(folderPath, 'modules')
			const modulesReady =
				!fs.existsSync(modulesDir) || (fs.readdirSync(modulesDir).length || 0) > 0
			if (modulesReady) {
				return folderPath
			}
		}
		try {
			await backend.invoke('trigger_syftbox_sync')
		} catch (error) {
			// Ignore sync errors
		}
		await new Promise((r) => setTimeout(r, 1000))
	}

	const reasonSuffix = lastReason ? ` (last status: ${lastReason})` : ''
	throw new Error(`Timed out waiting for flow sync at ${flowYaml}${reasonSuffix}`)
}

// Helper to wait for flow run to complete
async function waitForRunCompletion(
	page: Page,
	backend: Backend,
	runId: number,
	timeoutMs: number = FLOW_RUN_TIMEOUT,
): Promise<{ status: string; run: any }> {
	const startTime = Date.now()
	let lastStatus = 'unknown'

	while (Date.now() - startTime < timeoutMs) {
		try {
			const runs = await backend.invoke('get_flow_runs', {})
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

	throw new Error(`Flow run timed out after ${timeoutMs}ms. Last status: ${lastStatus}`)
}

async function waitForNewRun(
	backend: Backend,
	existingIds: Set<number>,
	timeoutMs = 60_000,
): Promise<any> {
	const startTime = Date.now()
	while (Date.now() - startTime < timeoutMs) {
		const runs = await backend.invoke('get_flow_runs', {})
		const newRuns = (runs || []).filter((run: any) => !existingIds.has(run.id))
		if (newRuns.length > 0) {
			newRuns.sort((a: any, b: any) => b.id - a.id)
			return newRuns[0]
		}
		await new Promise((r) => setTimeout(r, 1000))
	}
	throw new Error('Timed out waiting for new flow run')
}

function resolveFlowResultPath(run: any): string {
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

function parseTsvByParticipant(content: string): {
	header: string
	idIndex: number
	rows: string[]
	ids: string[]
	duplicates: string[]
	byId: Map<string, string[]>
} {
	const lines = content
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter(Boolean)
	const header = lines[0] ?? ''
	const rows = lines.slice(1)
	const headerCols = header.split('\t')
	let idIndex = headerCols.indexOf('participant_id')
	if (idIndex < 0) idIndex = 0
	const byId = new Map<string, string[]>()
	const ids: string[] = []
	const duplicates: string[] = []
	for (const row of rows) {
		const cols = row.split('\t')
		const id = (cols[idIndex] ?? '').trim()
		if (!id) continue
		ids.push(id)
		const existing = byId.get(id)
		if (existing) {
			existing.push(row)
			if (!duplicates.includes(id)) duplicates.push(id)
		} else {
			byId.set(id, [row])
		}
	}
	return { header, idIndex, rows, ids, duplicates, byId }
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

function parseSamplesheet(
	content: string,
): Array<{ participant_id: string; genotype_file: string }> {
	const lines = content
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter(Boolean)
	if (lines.length <= 1) return []
	const [header, ...rows] = lines
	const cols = header.split(',')
	const idIndex = cols.indexOf('participant_id')
	const fileIndex = cols.indexOf('genotype_file')
	return rows
		.map((row) => row.split(','))
		.map((parts) => ({
			participant_id: (parts[idIndex] ?? '').trim(),
			genotype_file: (parts[fileIndex] ?? '').trim(),
		}))
		.filter((entry) => entry.participant_id && entry.genotype_file)
}

function hashFileSafe(filePath: string): { exists: boolean; size: number; sha256?: string } {
	try {
		if (!fs.existsSync(filePath)) return { exists: false, size: 0 }
		const buf = fs.readFileSync(filePath)
		const sha256 = createHash('sha256').update(buf).digest('hex')
		return { exists: true, size: buf.length, sha256 }
	} catch {
		return { exists: false, size: 0 }
	}
}

async function resolveSyftUrlSafe(backend: Backend, syftUrl: string): Promise<string | null> {
	try {
		const localPath = await backend.invoke('resolve_syft_url_to_local_path', { syftUrl })
		return typeof localPath === 'string' && localPath.length ? localPath : null
	} catch {
		return null
	}
}

async function dumpMockEntryFiles(
	label: string,
	backend: Backend,
	entries: Array<{ participant_id?: string; url?: string }>,
): Promise<void> {
	console.log(`[${label}] mock entries count: ${entries.length}`)
	for (const entry of entries.slice(0, 10)) {
		const url = entry?.url || ''
		const id = entry?.participant_id || 'unknown'
		const localPath = url ? await resolveSyftUrlSafe(backend, url) : null
		const info = localPath ? hashFileSafe(localPath) : { exists: false, size: 0 }
		console.log(
			`[${label}] ${id} -> ${url} | local=${localPath ?? 'n/a'} (exists=${info.exists}, size=${info.size}${info.sha256 ? `, sha256=${info.sha256}` : ''})`,
		)
	}
}

function dumpAssetCsv(label: string, assetPath: string | null): void {
	if (!assetPath) {
		console.log(`[${label}] asset_1.csv path missing`)
		return
	}
	const info = hashFileSafe(assetPath)
	console.log(
		`[${label}] asset_1.csv: ${assetPath} (exists=${info.exists}, size=${info.size}${info.sha256 ? `, sha256=${info.sha256}` : ''})`,
	)
	const snippet = readFileSnippet(assetPath, 2000)
	if (snippet) {
		console.log(`[${label}] asset_1.csv snippet:\n${snippet}`)
	}
}

async function dumpDatasetDebug(label: string, backend: Backend, dataset: any): Promise<void> {
	if (!dataset) {
		console.log(`[${label}] dataset is null`)
		return
	}
	const assets = dataset.assets || []
	console.log(`[${label}] dataset name=${dataset.name} assets=${assets.length}`)
	if (!assets.length) return
	const asset = assets[0]
	console.log(`[${label}] asset key=${asset.key} kind=${asset.kind}`)
	console.log(`[${label}] mock_path=${asset.mock_path}`)
	console.log(`[${label}] mock_url=${asset.mock_url}`)
	if (asset.mock_path) {
		dumpAssetCsv(label, asset.mock_path)
	}
	const mockEntries = asset.mock_entries || []
	if (Array.isArray(mockEntries) && mockEntries.length) {
		await dumpMockEntryFiles(label, backend, mockEntries)
	}
}

function dumpSamplesheetDebug(label: string, samplesheetContent: string): void {
	const entries = parseSamplesheet(samplesheetContent)
	console.log(`[${label}] samplesheet entries: ${entries.length}`)
	for (const entry of entries) {
		const info = hashFileSafe(entry.genotype_file)
		console.log(
			`[${label}] ${entry.participant_id} -> ${entry.genotype_file} (exists=${info.exists}, size=${info.size}${info.sha256 ? `, sha256=${info.sha256}` : ''})`,
		)
	}
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

function collectFilesRecursive(baseDir: string, limit = 20, extensions?: string[]): string[] {
	const results: string[] = []
	const stack = [baseDir]
	const normalizedExts = extensions?.map((ext) => ext.toLowerCase()) ?? []

	while (stack.length > 0 && results.length < limit) {
		const current = stack.pop()
		if (!current) continue
		let entries: fs.Dirent[] = []
		try {
			entries = fs.readdirSync(current, { withFileTypes: true })
		} catch {
			continue
		}
		for (const entry of entries) {
			if (results.length >= limit) break
			const fullPath = path.join(current, entry.name)
			if (entry.isDirectory()) {
				stack.push(fullPath)
				continue
			}
			if (normalizedExts.length > 0) {
				const ext = path.extname(entry.name).toLowerCase()
				if (!normalizedExts.includes(ext)) continue
			}
			results.push(fullPath)
		}
	}

	return results
}

function buildDatasetManifestAssets(
	files: string[],
	assetCount: number,
): Record<
	string,
	{
		kind: string
		mappings: { private?: { file_path: string }; mock?: { file_path: string } }
	}
> {
	const assets: Record<
		string,
		{
			kind: string
			mappings: { private?: { file_path: string }; mock?: { file_path: string } }
		}
	> = {}

	for (let i = 0; i < assetCount; i += 1) {
		const privatePath = files[i]
		const mockPath = files[i + assetCount] || files[i]
		if (!privatePath) break
		assets[`asset_${i + 1}`] = {
			kind: 'twin',
			mappings: {
				private: { file_path: privatePath },
				mock: { file_path: mockPath },
			},
		}
	}

	return assets
}

async function waitForDatasetInList(
	backend: Backend,
	datasetName: string,
	timeoutMs = 30_000,
): Promise<any> {
	const start = Date.now()
	while (Date.now() - start < timeoutMs) {
		const datasets = await backend.invoke('list_datasets_with_assets', {})
		const found = datasets?.find((d: any) => d?.dataset?.name === datasetName)
		if (found) return found
		await new Promise((r) => setTimeout(r, 1000))
	}
	throw new Error(`Timed out waiting for dataset in list: ${datasetName}`)
}

async function cleanupDatasetsByPrefix(
	backend: Backend,
	clientLabel: string,
	prefix: string,
): Promise<void> {
	const datasets = await backend.invoke('list_datasets_with_assets', {})
	const staleNames = (datasets || [])
		.map((d: any) => d?.dataset?.name)
		.filter((name: any) => typeof name === 'string' && name.startsWith(prefix))

	if (staleNames.length === 0) return
	console.log(`[${clientLabel}] Cleaning stale datasets: ${staleNames.join(', ')}`)

	for (const name of staleNames) {
		try {
			await backend.invoke('delete_dataset', { name })
		} catch (err) {
			console.log(`[${clientLabel}] Failed to delete stale dataset ${name}: ${err}`)
		}
	}
}

async function waitForDatasetInListWithSync(
	backend: Backend,
	datasetName: string,
	timeoutMs = 60_000,
): Promise<any> {
	const start = Date.now()
	while (Date.now() - start < timeoutMs) {
		await backend.invoke('trigger_syftbox_sync').catch(() => {})
		const datasets = await backend.invoke('list_datasets_with_assets', {})
		const found = datasets?.find((d: any) => d?.dataset?.name === datasetName)
		if (found) return found
		await new Promise((r) => setTimeout(r, 2000))
	}
	throw new Error(`Timed out waiting for dataset in list (sync): ${datasetName}`)
}

async function waitForNetworkDataset(
	backend: Backend,
	datasetName: string,
	timeoutMs = SYNC_TIMEOUT,
): Promise<any> {
	const start = Date.now()
	while (Date.now() - start < timeoutMs) {
		const scan = await backend.invoke('network_scan_datasets')
		const target = (scan?.datasets || []).find((d: any) => d?.name === datasetName)
		if (target) return target
		await new Promise((r) => setTimeout(r, 2000))
	}
	throw new Error(`Timed out waiting for network dataset: ${datasetName}`)
}

function extractMockUrlsFromDataset(dataset: any): string[] {
	const urls: string[] = []
	for (const asset of dataset?.assets || []) {
		if (Array.isArray(asset?.mock_entries) && asset.mock_entries.length > 0) {
			for (const entry of asset.mock_entries) {
				if (entry?.url) urls.push(entry.url)
			}
			continue
		}
		if (asset?.mock_url) urls.push(asset.mock_url)
	}
	return Array.from(new Set(urls))
}

async function waitForThreadBySubject(
	backend: Backend,
	subjectPrefix: string,
	timeoutMs = SYNC_TIMEOUT,
): Promise<any> {
	const start = Date.now()
	while (Date.now() - start < timeoutMs) {
		const threads = await backend.invoke('list_message_threads', {
			scope: 'all',
			limit: 50,
		})
		const thread = (threads || []).find((t: any) =>
			String(t?.subject || '').includes(subjectPrefix),
		)
		if (thread) return thread
		await backend.invoke('trigger_syftbox_sync').catch(() => {})
		await new Promise((r) => setTimeout(r, 1000))
	}
	throw new Error(`Timed out waiting for message thread: ${subjectPrefix}`)
}

async function waitForFlowRequestMessage(
	backend: Backend,
	flowName: string,
	timeoutMs = SYNC_TIMEOUT,
): Promise<{ requestId: string; flowRequest: any; threadSubject: string }> {
	const start = Date.now()
	while (Date.now() - start < timeoutMs) {
		const threads = await backend.invoke('list_message_threads', {
			scope: 'all',
			limit: 50,
		})
		for (const thread of threads || []) {
			const messages = await backend.invoke('get_thread_messages', {
				threadId: thread.thread_id,
			})
			for (const msg of messages || []) {
				const flowRequest = msg?.metadata?.flow_request
				if (flowRequest?.flow_location) {
					return { requestId: msg.id, flowRequest, threadSubject: thread.subject || '' }
				}
			}
		}
		await backend.invoke('trigger_syftbox_sync').catch(() => {})
		await backend.invoke('sync_messages_with_failures').catch(() => {})
		await new Promise((r) => setTimeout(r, 1000))
	}
	throw new Error(`Timed out waiting for flow request message for ${flowName}`)
}

async function waitForFlowResultsMessage(
	backend: Backend,
	timeoutMs = SYNC_TIMEOUT,
): Promise<{ flowResults: any; threadSubject: string }> {
	const start = Date.now()
	while (Date.now() - start < timeoutMs) {
		const threads = await backend.invoke('list_message_threads', {
			scope: 'all',
			limit: 50,
		})
		for (const thread of threads || []) {
			const messages = await backend.invoke('get_thread_messages', {
				threadId: thread.thread_id,
			})
			for (const msg of messages || []) {
				const flowResults = msg?.metadata?.flow_results
				if (flowResults?.results_location) {
					return { flowResults, threadSubject: thread.subject || '' }
				}
			}
		}
		await backend.invoke('trigger_syftbox_sync').catch(() => {})
		await backend.invoke('sync_messages_with_failures').catch(() => {})
		await new Promise((r) => setTimeout(r, 1000))
	}
	throw new Error('Timed out waiting for flow results message')
}

function listDirSafe(dirPath: string, limit = 50): string[] {
	if (!dirPath || !fs.existsSync(dirPath)) return []
	try {
		return fs.readdirSync(dirPath).slice(0, limit)
	} catch {
		return []
	}
}

function readFileSnippet(filePath: string, maxBytes = 5000): string | null {
	if (!filePath || !fs.existsSync(filePath)) return null
	try {
		const buf = fs.readFileSync(filePath)
		if (buf.length <= maxBytes) return buf.toString('utf8')
		return `${buf.subarray(0, maxBytes).toString('utf8')}\n...[truncated ${buf.length - maxBytes} bytes]`
	} catch {
		return null
	}
}

function execCommandSafe(cmd: string): string {
	try {
		return execSync(cmd, { encoding: 'utf8', stdio: 'pipe' })
	} catch (error: any) {
		const stdout = error?.stdout?.toString?.() ?? ''
		const stderr = error?.stderr?.toString?.() ?? ''
		const message = error?.message ?? String(error)
		return `ERROR: ${message}\nSTDOUT:\n${stdout}\nSTDERR:\n${stderr}`.trim()
	}
}

function dumpDirTree(
	baseDir: string,
	maxDepth = 3,
	maxEntries = 200,
): { lines: string[]; truncated: boolean } {
	const lines: string[] = []
	let count = 0
	let truncated = false

	function walk(dir: string, depth: number) {
		if (count >= maxEntries) {
			truncated = true
			return
		}
		let entries: fs.Dirent[] = []
		try {
			entries = fs.readdirSync(dir, { withFileTypes: true })
		} catch (e) {
			lines.push(`${'  '.repeat(depth)}[error] ${dir}: ${e}`)
			count++
			return
		}

		for (const entry of entries) {
			if (count >= maxEntries) {
				truncated = true
				return
			}
			const fullPath = path.join(dir, entry.name)
			let stats: fs.Stats | null = null
			try {
				stats = fs.statSync(fullPath)
			} catch {}
			const size = stats ? stats.size : 0
			const mtime = stats ? stats.mtime.toISOString() : 'unknown'
			lines.push(
				`${'  '.repeat(depth)}${entry.isDirectory() ? '[dir]' : '[file]'} ${entry.name} (${size} bytes, ${mtime})`,
			)
			count++
			if (entry.isDirectory() && depth < maxDepth) {
				walk(fullPath, depth + 1)
			}
		}
	}

	if (fs.existsSync(baseDir)) {
		lines.push(`[tree] ${baseDir}`)
		walk(baseDir, 0)
	} else {
		lines.push(`[tree] baseDir missing: ${baseDir}`)
	}
	return { lines, truncated }
}

function findFilesByName(
	baseDir: string,
	filenames: string[],
	maxResults = 20,
	maxDepth = 6,
): string[] {
	const results: string[] = []
	if (!baseDir || !fs.existsSync(baseDir)) return results

	function walk(dir: string, depth: number) {
		if (results.length >= maxResults || depth > maxDepth) return
		let entries: fs.Dirent[] = []
		try {
			entries = fs.readdirSync(dir, { withFileTypes: true })
		} catch {
			return
		}
		for (const entry of entries) {
			if (results.length >= maxResults) return
			const fullPath = path.join(dir, entry.name)
			if (entry.isDirectory()) {
				walk(fullPath, depth + 1)
				continue
			}
			if (filenames.includes(entry.name)) {
				results.push(fullPath)
			}
		}
	}

	walk(baseDir, 0)
	return results
}

function dumpContainerDiagnostics(): void {
	console.log('\n=== DEBUG: Container Runtime Diagnostics ===')
	const podmanInfo = execCommandSafe('podman info --debug')
	console.log(`[podman info]\n${podmanInfo}`)
	const podmanPs = execCommandSafe('podman ps -a --format json')
	console.log(`[podman ps]\n${podmanPs}`)
	try {
		const parsed = JSON.parse(podmanPs || '[]')
		if (Array.isArray(parsed)) {
			for (const container of parsed.slice(0, 5)) {
				const id = container?.Id || container?.ID || container?.id
				if (!id) continue
				const logs = execCommandSafe(`podman logs --tail 200 ${id}`)
				console.log(`\n[podman logs ${id}]\n${logs}`)
			}
		}
	} catch {}

	const dockerInfo = execCommandSafe('docker info')
	console.log(`[docker info]\n${dockerInfo}`)
	const dockerPs = execCommandSafe('docker ps -a --format "{{json .}}"')
	console.log(`[docker ps]\n${dockerPs}`)
	if (dockerPs && !dockerPs.startsWith('ERROR:')) {
		const lines = dockerPs.split('\n').filter(Boolean).slice(0, 5)
		for (const line of lines) {
			try {
				const obj = JSON.parse(line)
				const id = obj?.ID
				if (!id) continue
				const logs = execCommandSafe(`docker logs --tail 200 ${id}`)
				console.log(`\n[docker logs ${id}]\n${logs}`)
			} catch {}
		}
	}
}

function dumpWindowsDiagnostics(): void {
	console.log('\n=== DEBUG: Windows Diagnostics ===')
	const ps = (script: string) =>
		execCommandSafe(`powershell -NoProfile -NonInteractive -Command "${script}"`)

	console.log('[windows] system info')
	console.log(
		ps(
			'$PSVersionTable; Get-ComputerInfo | Select-Object OsName,OsVersion,OsBuildNumber,WindowsVersion',
		),
	)

	console.log('[windows] recent Application events (errors/warnings, last 60 minutes)')
	console.log(
		ps(
			"Get-WinEvent -FilterHashtable @{LogName='Application'; StartTime=(Get-Date).AddMinutes(-60)} | Where-Object { $_.LevelDisplayName -in @('Error','Warning') } | Select-Object TimeCreated,ProviderName,Id,LevelDisplayName,Message -First 50 | Format-Table -AutoSize | Out-String -Width 200",
		),
	)

	console.log('[windows] recent System events (errors/warnings, last 60 minutes)')
	console.log(
		ps(
			"Get-WinEvent -FilterHashtable @{LogName='System'; StartTime=(Get-Date).AddMinutes(-60)} | Where-Object { $_.LevelDisplayName -in @('Error','Warning') } | Select-Object TimeCreated,ProviderName,Id,LevelDisplayName,Message -First 50 | Format-Table -AutoSize | Out-String -Width 200",
		),
	)

	console.log('[windows] Hyper-V related events (last 120 minutes)')
	console.log(
		ps(
			"Get-WinEvent -FilterHashtable @{LogName='Microsoft-Windows-Hyper-V-VMMS/Admin'; StartTime=(Get-Date).AddMinutes(-120)} | Select-Object TimeCreated,Id,LevelDisplayName,Message -First 30 | Format-Table -AutoSize | Out-String -Width 200",
		),
	)

	console.log('[windows] process snapshot (top 40 by CPU time)')
	console.log(
		ps(
			'Get-Process | Sort-Object CPU -Descending | Select-Object -First 40 Id,ProcessName,CPU,WorkingSet,StartTime | Format-Table -AutoSize | Out-String -Width 200',
		),
	)

	console.log('[windows] listening ports (netstat)')
	console.log(execCommandSafe('netstat -ano'))
}

async function dumpFlowRunDebug(label: string, run: any): Promise<void> {
	console.log(`\n=== DEBUG: Flow Run Diagnostics (${label}) ===`)
	try {
		console.log(`[Run Object] ${JSON.stringify(run, null, 2)}`)
	} catch (e) {
		console.log(`[Run Object] Failed to serialize: ${e}`)
	}
	try {
		const summary = {
			id: run?.id,
			status: run?.status,
			started_at: run?.started_at,
			ended_at: run?.ended_at,
			exit_code: run?.exit_code,
			error: run?.error,
			work_dir: run?.work_dir,
			results_dir: run?.results_dir,
		}
		console.log(`[Run Summary] ${JSON.stringify(summary, null, 2)}`)
	} catch (e) {
		console.log(`[Run Summary] Failed to serialize: ${e}`)
	}

	const baseDir = run?.results_dir || run?.work_dir
	if (!baseDir || !fs.existsSync(baseDir)) {
		console.log(`[Run Debug] Base dir not found: ${baseDir}`)
		return
	}

	console.log(`[Run Debug] baseDir: ${baseDir}`)
	console.log(`[Run Debug] baseDir entries: ${listDirSafe(baseDir).join(', ')}`)
	const tree = dumpDirTree(baseDir, 4, 250)
	console.log(`[Run Debug] dir tree:\n${tree.lines.join('\n')}`)
	if (tree.truncated) {
		console.log('[Run Debug] dir tree truncated')
	}

	const candidates = [
		path.join(run?.work_dir || '', '.nextflow.log'),
		path.join(run?.work_dir || '', 'nextflow.log'),
		path.join(run?.results_dir || '', '.nextflow.log'),
		path.join(run?.results_dir || '', 'nextflow.log'),
		path.join(run?.results_dir || '', 'trace.txt'),
		path.join(run?.results_dir || '', 'timeline.html'),
		path.join(run?.results_dir || '', 'report.html'),
		path.join(run?.results_dir || '', 'dag.html'),
		path.join(run?.results_dir || '', 'workflow.log'),
		path.join(run?.results_dir || '', 'stdout.log'),
		path.join(run?.results_dir || '', 'stderr.log'),
	]
	for (const filePath of candidates) {
		const snippet = readFileSnippet(filePath, 8000)
		if (snippet) {
			console.log(`\n[Run Debug] ${filePath}:\n${snippet}`)
		}
	}

	const commandLogs = findFilesByName(
		run?.work_dir || '',
		['.command.err', '.command.out', '.command.log', 'command.err', 'command.out'],
		10,
		6,
	)
	for (const filePath of commandLogs) {
		const snippet = readFileSnippet(filePath, 4000)
		if (snippet) {
			console.log(`\n[Run Debug] ${filePath}:\n${snippet}`)
		}
	}

	const logsDir = path.join(baseDir, 'logs')
	if (fs.existsSync(logsDir)) {
		console.log(`[Run Debug] logs/ entries: ${listDirSafe(logsDir).join(', ')}`)
		for (const name of listDirSafe(logsDir)) {
			const snippet = readFileSnippet(path.join(logsDir, name), 4000)
			if (snippet) {
				console.log(`\n[Run Debug] logs/${name}:\n${snippet}`)
			}
		}
	}
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
				mismatches.push(
					`${name} (src=${srcSize}/${srcHash.slice(0, 8)}, dest=${destSize}/${destHash.slice(0, 8)})`,
				)
			}
		}
		if (allMatch) {
			console.log(`[Content Match] All ${filenames.length} files have matching content`)
			return
		}
		console.log(
			`[Content Match] Waiting for ${mismatches.length} files to match: ${mismatches.slice(0, 3).join(', ')}${mismatches.length > 3 ? '...' : ''}`,
		)
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
		console.log(
			`  ${name}: src=${srcSize}/${srcHash.slice(0, 8)}, dest=${destSize}/${destHash.slice(0, 8)}, match=${srcHash === destHash}`,
		)
	}
	throw new Error(`[Content Match] Files did not match after ${timeoutMs}ms`)
}

// pause/resume test helper removed for now (see request to skip pause testing)

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

test.describe.only('Flows Collaboration @flows-collab', () => {
	test('two clients collaborate on flow run and share results', async ({ browser }, testInfo) => {
		const testTimer = timer('Total test time')
		const wsPort1 = Number.parseInt(process.env.DEV_WS_BRIDGE_PORT_BASE || '3333', 10)
		const wsPort2 = wsPort1 + 1
		const email1 = process.env.CLIENT1_EMAIL || 'client1@sandbox.local'
		const email2 = process.env.CLIENT2_EMAIL || 'client2@sandbox.local'
		let identity1 = email1
		let identity2 = email2
		const syntheticDataDir =
			process.env.SYNTHETIC_DATA_DIR || path.join(process.cwd(), 'test-data', 'synthetic-genotypes')
		const datasetName = `${COLLAB_DATASET_PREFIX}${Date.now()}`
		const defaultFlowName = 'herc2-classifier'
		const assetCount = 5
		console.log(`Using dataset name: ${datasetName}`)
		let client2MockResult = ''
		let client1PrivateResult = ''
		let client1PrivateRunId: number | null = null
		let client2BiovaultHome = ''
		let flowRequestId: string | null = null
		let flowName = defaultFlowName
		let syntheticFiles: string[] = []
		let mockRun2Final: any | null = null

		console.log('Setting up flows collaboration test')
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
		page1.on('pageerror', (err) => {
			console.log(`[Client1 PageError] ${err?.stack || err}`)
		})
		page1.on('requestfailed', (req) => {
			console.log(`[Client1 RequestFailed] ${req.url()} ${req.failure()?.errorText}`)
		})
		page2.on('console', (msg) => {
			if (msg.type() === 'error') {
				console.log(`[Client2 Error] ${msg.text()}`)
			} else if (msg.text().includes('[Network Dataset Debug]')) {
				console.log(`[Client2] ${msg.text()}`)
			}
		})
		page2.on('pageerror', (err) => {
			console.log(`[Client2 PageError] ${err?.stack || err}`)
		})
		page2.on('requestfailed', (req) => {
			console.log(`[Client2 RequestFailed] ${req.url()} ${req.failure()?.errorText}`)
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
			try {
				const settings1 = await backend1.invoke('get_settings')
				const settings2 = await backend2.invoke('get_settings')
				if (settings1?.email !== email1) {
					await backend1.invoke('complete_onboarding', { email: email1 })
				}
				if (settings2?.email !== email2) {
					await backend2.invoke('complete_onboarding', { email: email2 })
				}
				identity1 = email1
				identity2 = email2
				console.log(`Resolved identities: client1=${identity1} client2=${identity2}`)
			} catch (err) {
				console.log(`Failed to ensure onboarding emails: ${err}`)
			}

			await cleanupDatasetsByPrefix(backend1, 'Client1', COLLAB_DATASET_PREFIX)
			await cleanupDatasetsByPrefix(backend2, 'Client2', COLLAB_DATASET_PREFIX)

			const baseUrl = process.env.UI_BASE_URL || 'http://127.0.0.1:8082'
			console.log('Navigating to UI...')
			await page1.goto(`${baseUrl}?ws=${wsPort1}&real=1`, { waitUntil: 'networkidle' })
			await page2.goto(`${baseUrl}?ws=${wsPort2}&real=1`, { waitUntil: 'networkidle' })
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

			await captureKeySnapshot('initial', 'client1', backend1, identity1, identity2, logSocket)
			await captureKeySnapshot('initial', 'client2', backend2, identity2, identity1, logSocket)

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
					waitForPeerDid(dataDir1, identity2, PEER_DID_TIMEOUT_MS, backend1, 'client1', true),
					waitForPeerDid(dataDir2, identity1, PEER_DID_TIMEOUT_MS, backend2, 'client2', true),
				])
				onboardingTimer.stop()
			}

			await captureKeySnapshot('post-onboarding', 'client1', backend1, identity1, identity2, logSocket)
			await captureKeySnapshot('post-onboarding', 'client2', backend2, identity2, identity1, logSocket)

			// ============================================================
			// Step 1: Exchange keys (backend)
			// ============================================================
			const keysTimer = timer('Key exchange')
			console.log('\n=== Step 1: Exchange keys ===')

			// Import contacts via backend
			await backend1.invoke('network_import_contact', { identity: identity2 })
			await backend2.invoke('network_import_contact', { identity: identity1 })
			console.log('Contacts imported!')

			keysTimer.stop()

			await captureKeySnapshot(
				'post-network-import',
				'client1',
				backend1,
				identity1,
				identity2,
				logSocket,
			)
			await captureKeySnapshot(
				'post-network-import',
				'client2',
				backend2,
				identity2,
				identity1,
				logSocket,
			)

			// ============================================================
			// Step 2: Client1 creates dataset + publishes (backend)
			// ============================================================
			log(logSocket, { event: 'step-2', action: 'create-dataset' })
			console.log('\n=== Step 2: Client1 imports data and creates dataset ===')

			let files = collectFilesRecursive(syntheticDataDir, assetCount * 2, ['.txt'])
			if (files.length < assetCount * 2) {
				files = collectFilesRecursive(syntheticDataDir, assetCount * 2)
			}
			if (files.length < assetCount * 2) {
				throw new Error(
					`Not enough files in synthetic data dir. Need ${assetCount * 2}, found ${files.length}`,
				)
			}

			syntheticFiles = files
			const manifestAssets = buildDatasetManifestAssets(files, assetCount)
			await backend1.invoke('save_dataset_with_files', {
				manifest: {
					name: datasetName,
					description: 'Dataset for flow collaboration test',
					version: '1.0.0',
					schema: 'net.biovault.datasets:1.0.0',
					author: null,
					public_url: null,
					private_url: null,
					http_relay_servers: [],
					assets: manifestAssets,
				},
				originalName: null,
			})

			await waitForDatasetInList(backend1, datasetName, 30_000)
			await backend1.invoke('publish_dataset', { name: datasetName, copyMock: true })
			console.log('Dataset created and published!')
			await backend1.invoke('trigger_syftbox_sync').catch(() => {})
			try {
				const published = await backend1.invoke('is_dataset_published', { name: datasetName })
				console.log(`[Client1 Dataset] is_published=${published}`)
				const localDatasets = await backend1.invoke('list_datasets_with_assets', {})
				const created = localDatasets?.find((d: any) => d?.dataset?.name === datasetName)
				if (created) {
					console.log(
						`[Client1 Dataset] author=${created.dataset.author} public_url=${created.dataset.public_url} extra=${JSON.stringify(created.dataset.extra || {})}`,
					)
					console.log(`[Client1 Dataset] assets=${created.assets?.length || 0}`)
				}
				const scanSelf = await backend1.invoke('network_scan_datasets')
				const selfNames = (scanSelf?.datasets || []).map((d: any) => d?.name)
				console.log(`[Client1 Network Scan] datasets=${selfNames.length}`)
			} catch (err) {
				console.log(`Failed to debug dataset publish: ${err}`)
			}

			await page1.reload()
			await waitForAppReady(page1, { timeout: 10_000 })
			await page1.locator('[data-testid="nav-datasets"]').click()
			const datasetCard = page1.locator(`[data-testid="dataset-card-${datasetName}"]`)
			await expect(datasetCard).toBeVisible({ timeout: UI_TIMEOUT })

			// ============================================================
			// Step 3: Client2 (data scientist) imports HERC2 Flow
			// ============================================================
			log(logSocket, { event: 'step-3', action: 'import-flow' })
			console.log('\n=== Step 3: Client2 imports HERC2 Flow ===')

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
				await backend2.invoke('import_flow', {
					flowFile: herc2FlowPath,
					overwrite: true,
				})
				console.log('Client2: HERC2 flow imported from local path!')
			} catch (err) {
				console.log(`Import error (may be ok if already exists): ${err}`)
			}

			// Navigate to Flows tab to verify
			await page2.reload()
			await waitForAppReady(page2, { timeout: 10_000 })
			await page2.locator('[data-testid="nav-flows"]').click()
			const flowsAfterImport = await backend2.invoke('get_flows')
			const importedFlow =
				flowsAfterImport.find((f: any) => f.name === defaultFlowName) ||
				flowsAfterImport.find((f: any) => String(f.name).toLowerCase().includes('herc2'))
			if (!importedFlow) {
				throw new Error('Imported flow not found in client2 flows list')
			}
			flowName = importedFlow.name
			await expect(page2.locator(`[data-testid="flow-card-${flowName}"]`).first()).toBeVisible({
				timeout: UI_TIMEOUT,
			})

			// ============================================================
			// Step 4: Wait for dataset to appear on Client2's Network tab
			// ============================================================
			log(logSocket, { event: 'step-4', action: 'wait-network-sync' })
			console.log('\n=== Step 4: Wait for dataset on Client2 Network ===')

			// Wait for Client1's dataset to appear in network scan
			const syncTimer = timer('Dataset sync to network')
			let targetDatasetForMock: any = null
			let syncAttempt = 0
			const syncStart = Date.now()
			while (Date.now() - syncStart < SYNC_TIMEOUT) {
				syncAttempt += 1
				await Promise.all([
					backend1.invoke('trigger_syftbox_sync').catch(() => {}),
					backend2.invoke('trigger_syftbox_sync').catch(() => {}),
					backend2.invoke('network_scan_datasites').catch(() => {}),
				])

				const scan = await backend2.invoke('network_scan_datasets').catch(() => null)
				const datasets = scan?.datasets || []
				targetDatasetForMock = datasets.find((d: any) => d?.name === datasetName)
				if (targetDatasetForMock) break
				if (syncAttempt % 5 === 0) {
					const names = datasets.map((d: any) => d?.name).filter(Boolean)
					console.log(
						`[Client2 Network Scan] attempt=${syncAttempt} datasets=${names.length} names=${names.slice(0, 5).join(', ')}`,
					)
				}
				await new Promise((r) => setTimeout(r, 2000))
			}

			syncTimer.stop()
			if (!targetDatasetForMock) {
				throw new Error(`Timed out waiting for network dataset: ${datasetName}`)
			}

			try {
				await backend2.invoke('subscribe_dataset', { owner: identity1, name: datasetName })
			} catch (err) {
				console.log(`Subscribe dataset failed (continuing without local pin): ${err}`)
			}

			// Wait for all mock files to sync (5 files expected - test adds 5 mock + 5 private)
			// This prevents race condition where Client2 runs flow before all files are available
			const EXPECTED_MOCK_FILES = 5
			const mockSyncTimer = timer('Mock files sync')
			console.log(`\nWaiting for all ${EXPECTED_MOCK_FILES} mock files to sync...`)
			let mockFilesReady = false
			const mockSyncStart = Date.now()
			const MOCK_SYNC_TIMEOUT = 15_000 // 15 seconds (best-effort)

			// DEBUG: First check what Client1 has in their dataset
			try {
				const client1Datasets = await backend1.invoke('get_datasets', {})
				const client1Dataset = client1Datasets?.find((d: any) => d.name === datasetName)
				console.log('\n=== DEBUG: Client1 Dataset Info ===')
				console.log(`Dataset found: ${!!client1Dataset}`)
				if (client1Dataset) {
					console.log(`Assets: ${JSON.stringify(client1Dataset.assets, null, 2)}`)
					await dumpDatasetDebug('Client1 Dataset Info', backend1, client1Dataset)
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
						console.log(
							`Mock files synced: ${mockCount}/${EXPECTED_MOCK_FILES}, mock_path: ${mockPath}`,
						)

						// DEBUG: Log each mock entry
						if (asset.mock_entries?.length > 0) {
							console.log('Mock entries:')
							asset.mock_entries.forEach((entry: any, i: number) => {
								console.log(`  [${i}] ${entry.participant_id}: ${entry.url}`)
							})
						}

						if (mockCount >= EXPECTED_MOCK_FILES) {
							await dumpDatasetDebug('Client2 Network Dataset', backend2, targetDataset)
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
				try {
					const asset = targetDatasetForMock.assets[0]
					const mockEntries = asset.mock_entries || []
					const mockFilenames = extractMockFilenames(mockEntries)
					const assetKey = asset.key || 'asset_1'

					const dataDir1 = await getSyftboxDataDir(backend1)
					const dataDir2 = await getSyftboxDataDir(backend2)
					const assetsDir1 = path.join(
						resolveDatasitesRoot(dataDir1),
						identity1,
						'public',
						'biovault',
						'datasets',
						datasetName,
						'assets',
					)
					const assetsDir2 = path.join(
						resolveDatasitesRoot(dataDir2),
						identity1,
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
				} catch (err) {
					console.warn(`Mock file sync check failed (continuing): ${err}`)
				}
			}

			// ============================================================
			// Step 5: Client2 runs imported flow on peer's mock data (backend)
			// ============================================================
			log(logSocket, { event: 'step-5', action: 'run-flow-mock' })
			console.log('\n=== Step 5: Client2 runs HERC2 flow on mock data ===')

			// DEBUG: Query network datasets from backend to see what's returned
			try {
				const networkDatasets = await backend2.invoke('network_scan_datasets')
				console.log('\n=== DEBUG: Network Datasets from Backend ===')
				console.log(JSON.stringify(networkDatasets, null, 2))
				const target = networkDatasets?.datasets?.find((d: any) => d.name === datasetName)
				if (target) {
					await dumpDatasetDebug('Client2 Network Dataset (pre-run)', backend2, target)
				}
			} catch (err) {
				console.log('DEBUG: Failed to get network datasets:', err)
			}

			const flows2 = await backend2.invoke('get_flows')
			const flow2 =
				flows2.find((f: any) => f.name === flowName) ||
				flows2.find((f: any) => String(f.name).toLowerCase().includes('herc2'))
			if (!flow2) {
				throw new Error('Client2 flow not found for mock run')
			}

			let mockUrls = extractMockUrlsFromDataset(targetDatasetForMock)
			if (mockUrls.length === 0) {
				try {
					const localDataset = await waitForDatasetInList(backend2, datasetName, 10_000)
					mockUrls = (localDataset?.assets || [])
						.map((a: any) => a.resolved_mock_path || a.mock_path)
						.filter((p: string) => !!p)
						.map((p: string) => (p.startsWith('file://') ? p : `file://${p}`))
				} catch (err) {
					console.warn(`No local dataset mock paths available: ${err}`)
				}
			}
			const localMockUrls = syntheticFiles
				.slice(assetCount, assetCount * 2)
				.map((p) => (p.startsWith('file://') ? p : `file://${p}`))
			const runUrls = localMockUrls.length > 0 ? localMockUrls : mockUrls
			if (runUrls.length === 0) {
				throw new Error('No mock URLs found to run flow on')
			}
			if (localMockUrls.length > 0) {
				console.log(`Using ${runUrls.length} local mock files for test run`)
			}

			// Start mock run and wait for completion by checking backend.
			const mockRunTimer = timer('Mock data flow run')
			try {
				const runsBeforeMock = await backend2.invoke('get_flow_runs', {})
				const prevRunIds = new Set((runsBeforeMock || []).map((r: any) => r.id))

				await backend2.invoke('run_flow', {
					flowId: flow2.id,
					inputOverrides: {},
					resultsDir: null,
					selection: {
						urls: runUrls,
						dataSource: localMockUrls.length > 0 ? null : 'network_dataset',
						datasetName: localMockUrls.length > 0 ? null : datasetName,
					},
				})

				const mockRun = await waitForNewRun(backend2, prevRunIds)
				console.log(`Waiting for run ${mockRun.id} to complete...`)
				const { status: mockStatus, run } = await waitForRunCompletion(
					page2,
					backend2,
					mockRun.id,
				)
				mockRun2Final = run
				console.log(`Flow run on mock data completed with status: ${mockStatus}`)
				if (mockStatus !== 'success') {
					await dumpFlowRunDebug('client2-mock-run', mockRun2Final)
					console.warn('Mock run did not succeed; continuing with request flow test')
				}

				client2BiovaultHome = getBiovaultHomeFromRun(mockRun2Final)
				if (mockStatus === 'success') {
					const mockResultPath2 = resolveFlowResultPath(mockRun2Final)
					console.log(`[TSV] Reading client2 mock result from: ${mockResultPath2}`)
					client2MockResult = await readTextFileWithRetry(mockResultPath2)
					console.log(`[TSV] client2MockResult read, length: ${client2MockResult.length}`)
				}
			} catch (err) {
				console.warn(`Mock run failed (continuing): ${err}`)
			} finally {
				mockRunTimer.stop()
			}

			// DEBUG: Log Client2 run metadata to see inputs used
			console.log('\n=== DEBUG: Client2 Mock Run Metadata ===')
			if (mockRun2Final) {
				console.log(`Run ID: ${mockRun2Final.id}`)
				console.log(`Work dir: ${mockRun2Final.work_dir}`)
				console.log(`Results dir: ${mockRun2Final.results_dir}`)
				if (mockRun2Final.metadata) {
					try {
						const meta =
							typeof mockRun2Final.metadata === 'string'
								? JSON.parse(mockRun2Final.metadata)
								: mockRun2Final.metadata
						console.log(`Inputs: ${JSON.stringify(meta.inputs, null, 2)}`)
					} catch (e) {
						console.log(`Raw metadata: ${mockRun2Final.metadata}`)
					}
				}
				// Read and log samplesheet for Client2
				const samplesheetPath2 = path.join(
					mockRun2Final.results_dir,
					'inputs',
					'selected_participants.csv',
				)
				try {
					const samplesheet2 = await readTextFileWithRetry(samplesheetPath2, 5000)
					console.log(`\n=== DEBUG: Client2 Samplesheet ===\n${samplesheet2}`)
					dumpSamplesheetDebug('Client2 Samplesheet', samplesheet2)
				} catch (e) {
					console.log(`DEBUG: Could not read Client2 samplesheet: ${e}`)
				}
			} else {
				console.log('No mock run metadata captured')
			}

			await captureKeySnapshot('post-mock-run', 'client2', backend2, identity2, identity1, logSocket)
			await captureKeySnapshot('post-mock-run', 'client1', backend1, identity1, identity2, logSocket)

			// Navigate to Runs tab to verify
			await page2.locator('[data-testid="nav-results"]').click()
			await page2.waitForTimeout(1000)

			// ============================================================
			// Step 6: Client2 requests flow run on peer private data (backend)
			// ============================================================
			log(logSocket, { event: 'step-6', action: 'request-flow-run' })
			console.log('\n=== Step 6: Client2 requests flow run on peer private data ===')

			await backend2.invoke('send_flow_request', {
				flowName: flow2.name,
				flowVersion: '1.0.0',
				datasetName: datasetName,
				recipient: identity1,
				message: `Please run ${flow2.name} on ${datasetName}`,
			})
			console.log('Flow request sent!')

			await captureKeySnapshot('post-request-send', 'client2', backend2, identity2, identity1, logSocket)
			await captureKeySnapshot('post-request-send', 'client1', backend1, identity1, identity2, logSocket)

			// ============================================================
			// Step 7: Client1 receives request in Messages
			// ============================================================
			log(logSocket, { event: 'step-7', action: 'receive-request' })
			console.log('\n=== Step 7: Client1 receives request in Messages ===')

			// Trigger sync on Client1
			await backend1.invoke('trigger_syftbox_sync')
			await syncMessagesWithDebug(backend1, logSocket, 'client1', 'receive-request')
			await page1.waitForTimeout(3000)

			await captureKeySnapshot('post-request-sync', 'client1', backend1, identity1, identity2, logSocket)

			// Wait for flow request message + sync flow files
			const { requestId, flowRequest, threadSubject: requestThreadSubject } =
				await waitForFlowRequestMessage(
				backend1,
				flowName,
				SYNC_TIMEOUT,
			)
			flowRequestId = requestId
			await waitForSyncedFlowFolder(backend1, flowRequest, SYNC_TIMEOUT)
			console.log('Flow request files synced to disk')

			// Import flow from synced folder so client1 can run it
			const flowFolder = await backend1.invoke('resolve_syft_url_to_local_path', {
				syftUrl: flowRequest.flow_location,
			})
			const flowYamlPath = path.join(flowFolder, 'flow.yaml')
			await backend1.invoke('import_flow', { flowFile: flowYamlPath, overwrite: true })

			// UI: open Collaborate and select request thread
			await page1.locator('[data-testid="nav-collaborate"]').click()
			const requestThread = page1.locator('button', {
				hasText: requestThreadSubject || `Flow Request: ${flowName}`,
			})
			await expect(requestThread).toBeVisible({ timeout: UI_TIMEOUT })
			await requestThread.click()
			await page1.waitForTimeout(1000)

			// ============================================================
			// Step 8: Client1 runs flow on private data
			// ============================================================
			log(logSocket, { event: 'step-8', action: 'run-flow' })
			console.log('\n=== Step 8: Client1 runs flow on private data ===')

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
					await dumpDatasetDebug('Client1 Dataset (pre-run)', backend1, client1Dataset)
				}
			} catch (err) {
				console.log('DEBUG: Failed to get client1 dataset:', err)
			}

			const flows1 = await backend1.invoke('get_flows')
			const flow1 =
				flows1.find((f: any) => f.name === flowName) ||
				flows1.find((f: any) => String(f.name).toLowerCase().includes('herc2'))
			if (!flow1) {
				throw new Error('Client1 flow not found for private run')
			}

			const localDataset = await waitForDatasetInList(backend1, datasetName, 10_000)
			const privateUrls = (localDataset?.assets || [])
				.map((a: any) => a.resolved_private_path || a.private_path)
				.filter((p: string) => !!p)
				.map((p: string) => (p.startsWith('file://') ? p : `file://${p}`))
			if (privateUrls.length === 0) {
				throw new Error('No private URLs found to run flow on')
			}

			const runsBeforePrivate = await backend1.invoke('get_flow_runs', {})
			const prevPrivateIds = new Set((runsBeforePrivate || []).map((r: any) => r.id))

			await backend1.invoke('run_flow', {
				flowId: flow1.id,
				inputOverrides: {},
				resultsDir: null,
				selection: {
					urls: privateUrls,
					dataSource: 'dataset',
					datasetName: datasetName,
				},
			})

			const privateRun1 = await waitForNewRun(backend1, prevPrivateIds)
			console.log(`Flow private run started: ${privateRun1.id}`)
			const { status: privateStatus, run: privateRun1Final } = await waitForRunCompletion(
				page1,
				backend1,
				privateRun1.id,
			)
			console.log(`Flow private run completed with status: ${privateStatus}`)
			expect(privateStatus).toBe('success')
			client1PrivateRunId = privateRun1Final.id

			const privateResultPath1 = resolveFlowResultPath(privateRun1Final)
			client1PrivateResult = await readTextFileWithRetry(privateResultPath1)

			await captureKeySnapshot('post-client1-runs', 'client1', backend1, identity1, identity2, logSocket)

			if (!client1PrivateRunId) {
				throw new Error('Private flow run did not start correctly')
			}

			// ============================================================
			// Step 9: Client1 shares results back
			// ============================================================
			log(logSocket, { event: 'step-9', action: 'share-results' })
			console.log('\n=== Step 9: Client1 shares results back ===')

			if (!flowRequestId) {
				throw new Error('Flow request id missing for result sharing')
			}
			await backend1.invoke('send_flow_request_results', {
				requestId: flowRequestId,
				runId: client1PrivateRunId,
				outputPaths: [resolveFlowResultPath(privateRun1Final)],
			})
			console.log('Private results sent!')

			await captureKeySnapshot('post-results-send', 'client1', backend1, identity1, identity2, logSocket)

			// ============================================================
			// Step 10: Client2 receives results
			// ============================================================
			log(logSocket, { event: 'step-10', action: 'receive-results' })
			console.log('\n=== Step 10: Client2 receives results ===')

			// Trigger sync on Client2
			await backend2.invoke('trigger_syftbox_sync')
			await syncMessagesWithDebug(backend2, logSocket, 'client2', 'receive-results')
			await page2.waitForTimeout(3000)

			await captureKeySnapshot('post-results-sync', 'client2', backend2, identity2, identity1, logSocket)

			// UI: open Collaborate and select results thread
			await page2.locator('[data-testid="nav-collaborate"]').click()
			if (!client2BiovaultHome) {
				throw new Error('Client2 BioVault home path not resolved')
			}

			const { flowResults, threadSubject: resultsThreadSubject } = await waitForFlowResultsMessage(
				backend2,
				SYNC_TIMEOUT,
			)
			const resultsThread = page2.locator('button', {
				hasText: resultsThreadSubject || `Flow Results: ${flowName}`,
			})
			await expect(resultsThread).toBeVisible({ timeout: UI_TIMEOUT })
			await resultsThread.click()
			await page2.waitForTimeout(1000)
			await backend2.invoke('import_flow_results', {
				resultsLocation: flowResults.results_location,
				submissionId: flowResults.submission_id,
				runId: flowResults.run_id,
				flowName: flowResults.flow_name,
			})

			const resultsRoot = path.join(client2BiovaultHome, 'results')
			const importedResultPathFinal = await waitForImportedResults(
				resultsRoot,
				client1PrivateRunId!,
			)

			const importedBytes = fs.readFileSync(importedResultPathFinal)
			const header = importedBytes.slice(0, 4).toString('utf8')
			expect(header).not.toBe('SBC1')

			const importedContent = importedBytes.toString('utf8')
			expect(importedContent.trim()).toBe(client1PrivateResult.trim())

			// ============================================================
			// Summary
			// ============================================================
			console.log('\n=== TEST COMPLETED ===')
			console.log('Flow collaboration flow tested:')
			console.log('  ✓ Client1 created dataset with mock + private data')
			console.log('  ✓ Client2 imported HERC2 flow')
			console.log('  ✓ Client2 ran flow on mock data successfully')
			console.log('  ✓ Client2 sent flow request for private data')
			console.log('  ✓ Client1 received request and ran flow on private data')
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
