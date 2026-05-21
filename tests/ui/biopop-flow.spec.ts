/**
 * BioVault Popgen e2e scenario.
 *
 * Client1 imports the local BioVault_popgen mock cohort, applies facets, creates
 * and publishes a dataset. Client2 imports the four popgen flows from GitHub
 * URLs, sends each flow request to Client1, and Client1 runs each request on
 * real data and sends all outputs back.
 *
 * Usage:
 *   ./dev-biopop.sh
 *
 * @tag biopop
 */
import { expect, test, type Page } from './playwright-fixtures'
import WebSocket from 'ws'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { applyWindowLayout, waitForAppReady } from './test-helpers.js'
import { completeOnboarding, ensureLogSocket, log, setWsPort } from './onboarding-helper.js'

const TEST_TIMEOUT = Number.parseInt(process.env.BIOPOP_TEST_TIMEOUT_MS || '3600000', 10)
const RUN_TIMEOUT = Number.parseInt(process.env.BIOPOP_RUN_TIMEOUT_MS || '1200000', 10)
const SYNC_TIMEOUT = Number.parseInt(process.env.BIOPOP_SYNC_TIMEOUT_MS || '600000', 10)
const UI_TIMEOUT = 30_000

const POPGEN_ROOT = process.env.BIOPOP_ROOT || '/Users/madhavajay/dev/BioVault_popgen'
const POPGEN_DATA_DIR =
	process.env.BIOPOP_DATA_DIR || path.join(POPGEN_ROOT, '01_mock_data_generation', 'output')
const POPGEN_FACETS_FILE =
	process.env.BIOPOP_FACETS_FILE ||
	path.join(POPGEN_ROOT, '01_mock_data_generation', 'facets', 'biovault-facets.csv')
const FLOW_URL_ROOT =
	process.env.BIOPOP_FLOW_URL_ROOT ||
	'https://github.com/madhavajay/BioVault_popgen/tree/main/flows'
const FLOW_NAMES = [
	'01_bv_paper_pca_qc_fast',
	'02_bv_paper_gnomad_projection_fast',
	'03_bv_paper_sex_biased_admixture_fast',
	'04_bv_paper_population_level',
]

test.describe.configure({ timeout: TEST_TIMEOUT })

interface Backend {
	invoke: (cmd: string, args?: Record<string, unknown>, timeoutMs?: number) => Promise<any>
	close: () => Promise<void>
}

type GenotypeFile = {
	participantId: string
	filePath: string
}

async function connectBackend(port: number): Promise<Backend> {
	const socket = new WebSocket(`ws://localhost:${port}`)
	await new Promise<void>((resolve, reject) => {
		const timeout = setTimeout(() => reject(new Error(`WS connect timeout on ${port}`)), 10_000)
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

function listGenotypeFiles(root: string): GenotypeFile[] {
	if (!fs.existsSync(root)) {
		throw new Error(`BioVault popgen data directory not found: ${root}`)
	}

	const files: GenotypeFile[] = []
	for (const participantId of fs.readdirSync(root).sort()) {
		const participantDir = path.join(root, participantId)
		if (!fs.statSync(participantDir).isDirectory()) continue
		const genotype = fs
			.readdirSync(participantDir)
			.filter((name) => name.endsWith('.txt'))
			.sort()[0]
		if (!genotype) continue
		files.push({ participantId, filePath: path.join(participantDir, genotype) })
	}
	if (files.length === 0) {
		throw new Error(`No genotype .txt files found under ${root}`)
	}
	return files
}

function buildDatasetManifest(datasetName: string, ownerEmail: string, files: GenotypeFile[]) {
	const mockFileCount = Math.max(1, Number.parseInt(process.env.BIOPOP_MOCK_FILE_COUNT || '1', 10))
	const mockFiles = files.slice(0, mockFileCount)
	const assetKey = 'genotypes'
	const mockCsvUrl = `syft://${ownerEmail}/public/biovault/datasets/${datasetName}/assets/${assetKey}.csv`
	const privateEntries = files.map((file, index) => ({
		id: `priv-${index}-${file.participantId}`,
		file_path: file.filePath,
		participant_id: file.participantId,
	}))
	const mockEntries = mockFiles.map((file, index) => ({
		id: `mock-${index}-${file.participantId}`,
		url: `syft://${ownerEmail}/public/biovault/datasets/${datasetName}/assets/${path.basename(file.filePath)}`,
		source_path: file.filePath,
		participant_id: file.participantId,
	}))

	return {
		name: datasetName,
		description: 'BioVault_popgen mock cohort for URL-import flow e2e testing',
		author: ownerEmail,
		schema: 'net.biovault.datasets:1.0.0',
		version: '1.0.0',
		shape: 'List[GenotypeRecord]',
		http_relay_servers: ['syftbox.net'],
		public_url: `syft://${ownerEmail}/public/biovault/datasets/${datasetName}/dataset.yaml`,
		private_url: `syft://${ownerEmail}/private/biovault/datasets/${datasetName}/dataset.yaml`,
		assets: {
			[assetKey]: {
				id: `asset-${Date.now()}`,
				type: 'twin_list',
				url: mockCsvUrl,
				private: {
					url: `{root.private_url}#assets.${assetKey}.private`,
					type: 'twin_list',
					entries: privateEntries,
				},
				mock: {
					url: mockCsvUrl,
					type: 'twin_list',
					entries: mockEntries,
				},
				mappings: {
					private: {
						entries: privateEntries,
					},
				},
			},
		},
	}
}

async function importGenotypeFiles(backend: Backend, files: GenotypeFile[]): Promise<void> {
	const fileMetadata: Record<string, any> = {}
	for (const file of files) {
		fileMetadata[file.filePath] = {
			participant_id: file.participantId,
			data_type: 'Genotype',
			source: 'BioVault_popgen',
			grch_version: 'GRCh38',
			reference_path: null,
			reference_index_path: null,
			row_count: null,
			chromosome_count: null,
			inferred_sex: null,
		}
	}
	const result = await backend.invoke('import_files_pending', { fileMetadata }, 300_000)
	expect(result?.success).toBeTruthy()
	console.log(`Imported genotype files: ${files.length}`)
}

async function getImportedFileIds(backend: Backend, files: GenotypeFile[]): Promise<number[]> {
	const expected = new Map(files.map((file) => [file.filePath, file.participantId]))
	const catalogFiles = await backend.invoke('get_files', {}, 120_000)
	const idsByPath = new Map<string, number>()
	for (const record of catalogFiles || []) {
		if (expected.has(record?.file_path) && typeof record?.id === 'number') {
			idsByPath.set(record.file_path, record.id)
		}
	}
	const missing = files.filter((file) => !idsByPath.has(file.filePath))
	if (missing.length > 0) {
		throw new Error(
			`Imported files missing from catalog: ${missing
				.slice(0, 5)
				.map((file) => file.filePath)
				.join(', ')}${missing.length > 5 ? ` (+${missing.length - 5} more)` : ''}`,
		)
	}
	return files.map((file) => idsByPath.get(file.filePath)!)
}

async function importFacets(backend: Backend): Promise<void> {
	if (!fs.existsSync(POPGEN_FACETS_FILE)) {
		throw new Error(`BioVault popgen facets file not found: ${POPGEN_FACETS_FILE}`)
	}
	const content = fs.readFileSync(POPGEN_FACETS_FILE, 'utf8').trim()
	const [headerLine, ...lines] = content.split(/\r?\n/)
	const headers = headerLine.split(',').map((value) => value.trim())
	if (headers[0] !== 'participant_id') {
		throw new Error(`Facet file first column must be participant_id: ${POPGEN_FACETS_FILE}`)
	}
	const rows = []
	for (const line of lines) {
		if (!line.trim()) continue
		const columns = line.split(',')
		const participantId = columns[0]?.trim()
		if (!participantId) continue
		for (let index = 1; index < headers.length; index += 1) {
			const facetName = headers[index]
			if (!facetName) continue
			rows.push({
				participant_id: participantId,
				facet_name: facetName,
				facet_value: columns[index]?.trim() || '',
			})
		}
	}
	expect(rows.length).toBeGreaterThan(0)
	const imported = await backend.invoke('import_participant_facets', {
		rows,
		sourceFile: POPGEN_FACETS_FILE,
	})
	expect(imported).toBeGreaterThan(0)
	console.log(`Imported participant facets: ${imported}`)
}

async function publishDataset(
	backend: Backend,
	datasetName: string,
	ownerEmail: string,
	files: GenotypeFile[],
): Promise<void> {
	const manifest = buildDatasetManifest(datasetName, ownerEmail, files)
	await backend.invoke('save_dataset_with_files', { manifest, originalName: null }, 120_000)
	await backend.invoke(
		'publish_dataset',
		{ manifestPath: null, name: datasetName, copyMock: true },
		180_000,
	)
	const published = await backend.invoke('is_dataset_published', { name: datasetName })
	expect(published).toBeTruthy()
	console.log(`Published dataset: ${datasetName}`)
}

async function importPopgenFlowsFromUrls(backend: Backend): Promise<any[]> {
	for (const flowName of FLOW_NAMES) {
		const url = `${FLOW_URL_ROOT}/${flowName}`
		console.log(`Importing flow from URL: ${url}`)
		await backend.invoke(
			'import_flow_with_deps',
			{ url, nameOverride: null, overwrite: true },
			300_000,
		)
	}

	const flows = await backend.invoke('get_flows', {})
	const imported = FLOW_NAMES.map((name) => {
		const flow = (flows || []).find((entry: any) => entry.name === name)
		if (!flow) throw new Error(`Flow was not imported: ${name}`)
		return flow
	})
	console.log(`Imported URL flows: ${imported.map((flow) => flow.name).join(', ')}`)
	return imported
}

async function triggerBothSync(backend1: Backend, backend2: Backend): Promise<void> {
	await Promise.all([
		backend1.invoke('trigger_syftbox_sync').catch(() => null),
		backend2.invoke('trigger_syftbox_sync').catch(() => null),
		backend1.invoke('sync_messages_with_failures').catch(() => null),
		backend2.invoke('sync_messages_with_failures').catch(() => null),
	])
}

function seedDevstackPeerDids(email1: string, email2: string): void {
	const sandboxRoot = path.join(process.cwd(), 'biovault', 'sandbox')
	const pairs = [
		{ receiver: email1, peer: email2 },
		{ receiver: email2, peer: email1 },
	]

	for (const { receiver, peer } of pairs) {
		const source = path.join(sandboxRoot, peer, 'datasites', peer, 'public', 'crypto', 'did.json')
		const dest = path.join(sandboxRoot, receiver, 'datasites', peer, 'public', 'crypto', 'did.json')
		if (!fs.existsSync(source)) {
			throw new Error(`Peer DID not found for ${peer}: ${source}`)
		}
		fs.mkdirSync(path.dirname(dest), { recursive: true })
		fs.copyFileSync(source, dest)
	}
}

async function importContactWithRetry(
	backend: Backend,
	peerBackend: Backend,
	identity: string,
): Promise<void> {
	const start = Date.now()
	let lastError: unknown = null
	while (Date.now() - start < SYNC_TIMEOUT) {
		try {
			await backend.invoke('network_import_contact', { identity }, 30_000)
			return
		} catch (error) {
			lastError = error
			await Promise.all([
				backend.invoke('trigger_syftbox_sync').catch(() => null),
				peerBackend.invoke('trigger_syftbox_sync').catch(() => null),
				backend.invoke('sync_messages_with_failures').catch(() => null),
				peerBackend.invoke('sync_messages_with_failures').catch(() => null),
			])
			await new Promise((resolve) => setTimeout(resolve, 2000))
		}
	}
	throw new Error(`Timed out importing contact ${identity}: ${lastError}`)
}

async function waitForRequestMessage(backend: Backend, flowName: string): Promise<any> {
	const start = Date.now()
	while (Date.now() - start < SYNC_TIMEOUT) {
		await backend.invoke('sync_messages_with_failures').catch(() => null)
		const threads = await backend
			.invoke('list_message_threads', { scope: 'inbox', limit: 100 })
			.catch(() => [])
		for (const thread of threads || []) {
			if (!String(thread?.subject || '').includes(`Flow Request: ${flowName}`)) continue
			const messages = await backend
				.invoke('get_thread_messages', { threadId: thread.thread_id })
				.catch(() => [])
			const request = (messages || []).find(
				(msg: any) => msg?.metadata?.flow_request?.flow_name === flowName,
			)
			if (request) return request
		}
		await new Promise((resolve) => setTimeout(resolve, 2000))
	}
	throw new Error(`Timed out waiting for request message for ${flowName}`)
}

async function waitForResultsMessage(
	backend: Backend,
	flowName: string,
	syncPeers: Backend[] = [],
): Promise<any> {
	const start = Date.now()
	while (Date.now() - start < SYNC_TIMEOUT) {
		await Promise.all([
			backend.invoke('trigger_syftbox_sync').catch(() => null),
			backend.invoke('sync_messages_with_failures').catch(() => null),
			...syncPeers.flatMap((peer) => [
				peer.invoke('trigger_syftbox_sync').catch(() => null),
				peer.invoke('sync_messages_with_failures').catch(() => null),
			]),
		])
		const threads = await backend
			.invoke('list_message_threads', { scope: 'inbox', limit: 100 })
			.catch(() => [])
		for (const thread of threads || []) {
			const messages = await backend
				.invoke('get_thread_messages', { threadId: thread.thread_id })
				.catch(() => [])
			const result = (messages || []).find(
				(msg: any) => msg?.metadata?.flow_results?.flow_name === flowName,
			)
			if (result) return result
		}
		await new Promise((resolve) => setTimeout(resolve, 2000))
	}
	throw new Error(`Timed out waiting for result message for ${flowName}`)
}

async function waitForRunCompletion(backend: Backend, runId: number): Promise<any> {
	const start = Date.now()
	while (Date.now() - start < RUN_TIMEOUT) {
		const runs = await backend.invoke('get_flow_runs', {})
		const run = (runs || []).find((entry: any) => entry.id === runId)
		if (run && ['success', 'failed', 'error', 'cancelled'].includes(String(run.status))) {
			return run
		}
		await backend.invoke('reconcile_flow_runs').catch(() => null)
		await new Promise((resolve) => setTimeout(resolve, 5000))
	}
	throw new Error(`Timed out waiting for run ${runId}`)
}

async function onboardClient(page: Page, port: number, email: string, logSocket: WebSocket | null) {
	await setWsPort(page, port)
	await page.goto(`${process.env.UI_BASE_URL || 'http://localhost:8082'}?ws=${port}&real=1`)
	await waitForAppReady(page, { timeout: UI_TIMEOUT })
	await completeOnboarding(page, email, logSocket)
}

test.describe('BioVault Popgen URL Flow Collaboration @biopop', () => {
	test('imports local cohort, URL-imports flows, requests real runs, and returns outputs', async ({
		browser,
	}, testInfo) => {
		const wsPort1 = Number.parseInt(process.env.DEV_WS_BRIDGE_PORT_BASE || '3333', 10)
		const wsPort2 = wsPort1 + 1
		const email1 = process.env.CLIENT1_EMAIL || 'client1@sandbox.local'
		const email2 = process.env.CLIENT2_EMAIL || 'client2@sandbox.local'
		const datasetName = process.env.BIOPOP_DATASET_NAME || `biopop_mock_cohort_${Date.now()}`
		const files = listGenotypeFiles(POPGEN_DATA_DIR)
		const logSocket = await ensureLogSocket()

		console.log(`BioPop data dir: ${POPGEN_DATA_DIR}`)
		console.log(`BioPop facets: ${POPGEN_FACETS_FILE}`)
		console.log(`Dataset: ${datasetName}`)
		console.log(`Files: ${files.length}`)

		const context1 = await browser.newContext()
		const context2 = await browser.newContext()
		const page1 = await context1.newPage()
		const page2 = await context2.newPage()
		page1.on('dialog', (dialog) => dialog.accept().catch(() => null))
		page2.on('dialog', (dialog) => dialog.accept().catch(() => null))

		const backend1 = await connectBackend(wsPort1)
		const backend2 = await connectBackend(wsPort2)

		try {
			await Promise.all([
				onboardClient(page1, wsPort1, email1, logSocket),
				onboardClient(page2, wsPort2, email2, logSocket),
			])
			await applyWindowLayout(page1, 0, 'biopop-client1')
			await applyWindowLayout(page2, 1, 'biopop-client2')

			await triggerBothSync(backend1, backend2)
			seedDevstackPeerDids(email1, email2)
			await Promise.all([
				importContactWithRetry(backend1, backend2, email2),
				importContactWithRetry(backend2, backend1, email1),
			])

			log(logSocket, { event: 'biopop-import-data', files: files.length })
			await importGenotypeFiles(backend1, files)
			const fileIds = await getImportedFileIds(backend1, files)
			await importFacets(backend1)
			await publishDataset(backend1, datasetName, email1, files)
			await triggerBothSync(backend1, backend2)

			log(logSocket, { event: 'biopop-import-url-flows' })
			const importedFlows = await importPopgenFlowsFromUrls(backend2)

			for (const flow of importedFlows) {
				console.log(`\n=== BioPop flow request: ${flow.name} ===`)
				const flowUrl = `${FLOW_URL_ROOT}/${flow.name}`
				log(logSocket, { event: 'biopop-request-flow', flow: flow.name })
				await backend2.invoke(
					'send_flow_request',
					{
						flowName: flow.name,
						flowVersion: '0.1.0',
						datasetName,
						recipient: email1,
						message: `Please run ${flow.name} on real BioVault_popgen data and release all outputs.`,
						runId: null,
						datasites: null,
					},
					120_000,
				)
				await triggerBothSync(backend1, backend2)

				const request = await waitForRequestMessage(backend1, flow.name)
				const flowRequest = request.metadata.flow_request
				await backend1.invoke(
					'import_flow_from_request',
					{
						name: flow.name,
						flowLocation: flowRequest.flow_location,
						overwrite: true,
					},
					180_000,
				)

				// The request import validates the message transport path. Importing the same URL
				// on the data-owner side ensures local module dependencies are registered before
				// running, which is required for URL-imported flows whose step `uses` values were
				// rewritten to module names.
				await backend1.invoke(
					'import_flow_with_deps',
					{ url: flowUrl, nameOverride: null, overwrite: true },
					300_000,
				)

				const ownerFlows = await backend1.invoke('get_flows', {})
				const ownerFlow = (ownerFlows || []).find((entry: any) => entry.name === flow.name)
				if (!ownerFlow) throw new Error(`Client1 did not import requested flow: ${flow.name}`)

				const run = await backend1.invoke(
					'run_flow',
					{
						flowId: ownerFlow.id,
						inputOverrides: {},
						resultsDir: null,
						selection: {
							fileIds,
							urls: [],
							participantIds: files.map((file) => file.participantId),
							datasetName,
							datasetShape: 'List[GenotypeRecord]',
							datasetDataType: 'real',
							datasetOwner: email1,
							assetKeys: ['genotypes'],
							dataType: 'real',
							dataSource: 'local_dataset',
						},
						nextflowMaxForks: Number.parseInt(process.env.BIOPOP_NEXTFLOW_MAX_FORKS || '4', 10),
						resume: false,
					},
					120_000,
				)
				console.log(`Client1 started ${flow.name} run ${run.id}`)

				const completed = await waitForRunCompletion(backend1, run.id)
				console.log(`Client1 completed ${flow.name} run ${run.id}: ${completed.status}`)
				expect(completed.status).toBe('success')

				await backend1.invoke(
					'send_flow_request_results',
					{
						requestId: request.id,
						runId: run.id,
						message: `All outputs for ${flow.name} are ready.`,
						outputPaths: null,
					},
					180_000,
				)
				await triggerBothSync(backend1, backend2)
				const resultMessage = await waitForResultsMessage(backend2, flow.name, [backend1])
				const sharedFiles = resultMessage.metadata.flow_results.files || []
				expect(sharedFiles.length).toBeGreaterThan(0)
				console.log(`Client2 received ${flow.name} outputs: ${sharedFiles.length} files`)
			}

			log(logSocket, { event: 'biopop-complete', flows: importedFlows.length })
			await testInfo.attach('biopop-summary', {
				body: JSON.stringify(
					{
						datasetName,
						files: files.length,
						flows: importedFlows.map((flow) => flow.name),
					},
					null,
					2,
				),
				contentType: 'application/json',
			})
		} finally {
			await backend1.close().catch(() => null)
			await backend2.close().catch(() => null)
			await context1.close().catch(() => null)
			await context2.close().catch(() => null)
			if (logSocket && logSocket.readyState === WebSocket.OPEN) {
				logSocket.close()
			}
		}
	})
})
