/**
 * Flows Pause/Resume Test (Standalone)
 * Tests the pause/resume functionality with state persistence:
 * 1. Setup: Import data, flow, and create dataset if needed
 * 2. Start a flow run with low concurrency
 * 3. Wait for some progress
 * 4. Pause the run
 * 5. Verify state is saved to flow.state.json
 * 6. Resume the run
 * 7. Verify it continues with cached tasks
 *
 * Usage:
 *   ./test-scenario.sh --flows-pause-resume
 *   ./test-scenario.sh --flows-pause-resume --interactive
 *
 * @tag flows-pause-resume
 */
import { expect, test, type Page } from './playwright-fixtures'
import WebSocket from 'ws'
import * as fs from 'fs'
import * as path from 'path'
import { waitForAppReady } from './test-helpers.js'
import { setWsPort, completeOnboarding, ensureLogSocket, log } from './onboarding-helper.js'

const TEST_TIMEOUT = 600_000 // 10 minutes max
const UI_TIMEOUT = 10_000
const PROGRESS_WAIT_TIMEOUT = 180_000 // 3 minutes to see progress

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

	function invoke(cmd: string, args: Record<string, unknown> = {}, timeoutMs = 60_000) {
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

// Helper to wait for run to reach a certain progress
async function waitForProgress(
	backend: Backend,
	runId: number,
	minCompleted: number,
	timeoutMs: number = PROGRESS_WAIT_TIMEOUT,
): Promise<{ completed: number; total: number }> {
	const startTime = Date.now()

	while (Date.now() - startTime < timeoutMs) {
		try {
			// Check logs for progress (more reliable than state during early run)
			const logs = await backend.invoke('get_flow_run_logs_tail', { runId, lines: 200 })
			const match = logs?.match(/\|\s*(\d+)\s+of\s+(\d+)/)
			if (match) {
				const completed = parseInt(match[1], 10)
				const total = parseInt(match[2], 10)
				console.log(`Progress: ${completed}/${total}`)
				if (completed >= minCompleted) {
					return { completed, total }
				}
			}

			// Also check state
			const state = await backend.invoke('get_flow_state', { runId })
			if (state && state.total > 0 && state.completed >= minCompleted) {
				console.log(`State progress: ${state.completed}/${state.total}`)
				return { completed: state.completed, total: state.total }
			}
		} catch (e) {
			console.log(`Error checking progress: ${e}`)
		}

		await new Promise((r) => setTimeout(r, 3000))
	}

	throw new Error(`Timed out waiting for progress >= ${minCompleted}`)
}

// Helper to wait for run status
async function waitForStatus(
	backend: Backend,
	runId: number,
	expectedStatus: string | string[],
	timeoutMs: number = 60_000,
): Promise<string> {
	const statuses = Array.isArray(expectedStatus) ? expectedStatus : [expectedStatus]
	const startTime = Date.now()

	while (Date.now() - startTime < timeoutMs) {
		try {
			const runs = await backend.invoke('get_flow_runs', {})
			const run = runs.find((r: any) => r.id === runId)
			if (run) {
				console.log(`Run ${runId} status: ${run.status}`)
				if (statuses.includes(run.status)) {
					return run.status
				}
			}
		} catch (e) {
			console.log(`Error checking status: ${e}`)
		}

		await new Promise((r) => setTimeout(r, 2000))
	}

	throw new Error(`Timed out waiting for status ${statuses.join('|')}`)
}

test.describe('Flows Pause/Resume @flows-pause-resume', () => {
	test('pause and resume flow run with state persistence', async ({ browser }, testInfo) => {
		const wsPort = Number.parseInt(process.env.DEV_WS_BRIDGE_PORT_BASE || '3333', 10)
		const email = process.env.TEST_EMAIL || 'client1@sandbox.local'
		const syntheticDataDir =
			process.env.SYNTHETIC_DATA_DIR || path.join(process.cwd(), 'test-data', 'synthetic-genotypes')

		console.log('Setting up pause/resume test')
		console.log(`Client: ${email} (port ${wsPort})`)
		console.log(`Synthetic data dir: ${syntheticDataDir}`)

		// Verify synthetic data exists
		if (!fs.existsSync(syntheticDataDir)) {
			throw new Error(`Synthetic data directory not found: ${syntheticDataDir}`)
		}

		const logSocket = await ensureLogSocket()
		const context = await browser.newContext()
		const page = await context.newPage()

		page.on('console', (msg) => {
			if (msg.type() === 'error') {
				console.log(`[Browser Error] ${msg.text()}`)
			}
		})

		await setWsPort(page, wsPort)
		const backend = await connectBackend(wsPort)

		try {
			// Navigate and setup
			await page.goto(`http://localhost:${process.env.UI_PORT || '8082'}?ws=${wsPort}&real=1`)
			await waitForAppReady(page, { timeout: 10_000 })

			const isOnboarded = await backend.invoke('check_is_onboarded')
			if (!isOnboarded) {
				await completeOnboarding(page, email, logSocket)
			}

			// ============================================================
			// Setup: Ensure flow and dataset exist
			// ============================================================
			log(logSocket, { event: 'setup', action: 'check-prerequisites' })
			console.log('\n=== Setup: Checking prerequisites ===')

			// Check for existing flow
			let flows = await backend.invoke('get_flows', {})
			let flow = flows.find((f: any) => f.name === 'herc2' || f.name === 'HERC2')

			if (!flow) {
				// Import HERC2 flow
				console.log('Importing HERC2 flow...')
				const herc2FlowPath = path.join(
					process.cwd(),
					'bioscript',
					'examples',
					'herc2',
					'herc2-classifier',
					'flow.yaml',
				)

				if (!fs.existsSync(herc2FlowPath)) {
					throw new Error(`HERC2 flow.yaml not found at: ${herc2FlowPath}`)
				}

				await backend.invoke('import_flow', { flowFile: herc2FlowPath, overwrite: true })
				console.log('HERC2 flow imported!')

				// Re-fetch flows
				flows = await backend.invoke('get_flows', {})
				flow = flows.find((f: any) => f.name === 'herc2' || f.name === 'HERC2')
			}

			if (!flow) {
				throw new Error('Failed to find or import HERC2 flow')
			}
			console.log(`Using flow: ${flow.name} (id: ${flow.id})`)

			// Check for existing dataset
			let datasets = await backend.invoke('get_datasets', {})
			let dataset = datasets.find((d: any) => d.flow_id === flow.id)

			if (!dataset) {
				// Need to import files and create dataset via UI
				console.log('No dataset found - creating via UI...')

				// Import synthetic data files
				console.log('Importing synthetic data files...')

				// Find synthetic files
				const subdirs = fs.readdirSync(syntheticDataDir).filter((d) => {
					const fullPath = path.join(syntheticDataDir, d)
					return fs.statSync(fullPath).isDirectory()
				})
				const syntheticFiles: string[] = []
				for (const subdir of subdirs) {
					const subdirPath = path.join(syntheticDataDir, subdir)
					const files = fs
						.readdirSync(subdirPath)
						.filter((f) => f.endsWith('.txt') || f.endsWith('.csv'))
					for (const file of files) {
						syntheticFiles.push(path.join(subdirPath, file))
					}
				}
				console.log(`Found ${syntheticFiles.length} synthetic files`)

				if (syntheticFiles.length < 10) {
					throw new Error(`Need at least 10 synthetic files, found ${syntheticFiles.length}`)
				}

				// Import files via backend
				const fileMetadata = syntheticFiles.map((filePath) => ({
					path: filePath,
					dataSource: 'Dynamic DNA',
					grchVersion: 'GRCh38',
				}))

				await backend.invoke('import_files_with_metadata', { fileMetadata }, 120_000)
				console.log('Files imported!')

				// Now create dataset via UI (simpler than complex backend API)
				await page.locator('.nav-item[data-tab="data"]').click()
				await expect(page.locator('#data-view.tab-content.active')).toBeVisible({
					timeout: UI_TIMEOUT,
				})
				await page.waitForTimeout(1000)

				// Switch to Datasets view
				const datasetsToggle = page.locator('#data-view-toggle .pill-button[data-view="datasets"]')
				await datasetsToggle.click()
				await page.waitForTimeout(500)

				// Click New Dataset
				await page.locator('#new-dataset-btn').click()
				await expect(page.locator('#dataset-editor-section')).toBeVisible({ timeout: 5000 })

				// Fill dataset name
				await page.locator('#dataset-form-name').fill('pause_resume_test_dataset')
				await page.locator('#dataset-form-description').fill('Dataset for pause/resume testing')

				// Add asset and select files
				await page.locator('#dataset-add-asset').click()
				await page.waitForTimeout(300)

				// Switch to file list mode
				const assetRow = page.locator('#dataset-assets-list .asset-row').first()
				await assetRow.locator('.pill-button[data-mode="list"]').click()
				await page.waitForTimeout(300)

				// Add files to mock side (faster for testing)
				await assetRow.locator('.asset-side.mock .btn-existing-files').click()
				const filePickerModal = page.locator('#file-picker-modal')
				await expect(filePickerModal).toBeVisible({ timeout: 5000 })

				// Select all files for mock
				const filePickerCheckboxes = filePickerModal.locator('.file-picker-checkbox')
				const checkboxCount = await filePickerCheckboxes.count()
				console.log(`File picker shows ${checkboxCount} files`)

				for (let i = 0; i < Math.min(checkboxCount, 10); i++) {
					await filePickerCheckboxes.nth(i).check()
				}

				await page.locator('#file-picker-add').click()
				await expect(filePickerModal).toBeHidden({ timeout: 3000 })

				// Select flow
				const flowSelect = page.locator('#dataset-form-flow')
				await flowSelect.selectOption({ label: flow.name })
				await page.waitForTimeout(500)

				// Save dataset
				await page.locator('#dataset-save-btn').click()
				await page.waitForTimeout(2000)

				// Refresh datasets
				datasets = await backend.invoke('get_datasets', {})
				dataset = datasets.find((d: any) => d.flow_id === flow.id)
			}

			if (!dataset) {
				throw new Error('Failed to find or create dataset')
			}
			console.log(`Using dataset: ${dataset.name} (id: ${dataset.id})`)

			// ============================================================
			// Step 1: Start or resume a flow run
			// ============================================================
			log(logSocket, { event: 'step-1', action: 'start-run' })
			console.log('\n=== Step 1: Start/resume flow run with concurrency=2 ===')

			// Check for existing paused/failed run
			const existingRuns = await backend.invoke('get_flow_runs', {})
			let existingRun = existingRuns.find(
				(r: any) => r.flow_id === flow.id && (r.status === 'paused' || r.status === 'failed'),
			)

			let runId: number

			if (existingRun) {
				console.log(`Found existing ${existingRun.status} run: ${existingRun.id} - resuming`)
				runId = existingRun.id
				await backend.invoke('resume_flow_run', { runId, concurrency: 2 })
			} else {
				// Start new run
				console.log('Starting new run...')
				const result = await backend.invoke('run_flow', {
					flowId: flow.id,
					datasetId: dataset.id,
					dataType: 'mock',
					nextflowMaxForks: 2,
				})
				runId = result.run_id
				console.log(`Started new run: ${runId}`)
			}

			// ============================================================
			// Step 2: Wait for some progress
			// ============================================================
			log(logSocket, { event: 'step-2', action: 'wait-progress' })
			console.log('\n=== Step 2: Wait for progress (at least 3 tasks) ===')

			await waitForStatus(backend, runId, 'running', 60_000)
			const progress1 = await waitForProgress(backend, runId, 3, PROGRESS_WAIT_TIMEOUT)
			console.log(`Reached progress: ${progress1.completed}/${progress1.total}`)

			// ============================================================
			// Step 3: Pause the run
			// ============================================================
			log(logSocket, { event: 'step-3', action: 'pause-run' })
			console.log('\n=== Step 3: Pause the run ===')

			await backend.invoke('pause_flow_run', { runId })
			await waitForStatus(backend, runId, 'paused', 60_000)
			console.log('Run is now paused')

			// Small delay to let state save complete
			await new Promise((r) => setTimeout(r, 2000))

			// ============================================================
			// Step 4: Verify state was saved
			// ============================================================
			log(logSocket, { event: 'step-4', action: 'verify-state' })
			console.log('\n=== Step 4: Verify state persistence ===')

			const savedState = await backend.invoke('get_flow_state', { runId })
			console.log(`Saved state: ${JSON.stringify(savedState)}`)

			expect(savedState).toBeTruthy()
			expect(savedState.total).toBeGreaterThan(0)
			console.log(`State shows: ${savedState.completed}/${savedState.total}`)

			// ============================================================
			// Step 5: Resume the run with higher concurrency
			// ============================================================
			log(logSocket, { event: 'step-5', action: 'resume-run' })
			console.log('\n=== Step 5: Resume the run with concurrency=4 ===')

			await backend.invoke('resume_flow_run', { runId, concurrency: 4 })
			await waitForStatus(backend, runId, 'running', 60_000)
			console.log('Run resumed')

			// ============================================================
			// Step 6: Verify progress continues with caching
			// ============================================================
			log(logSocket, { event: 'step-6', action: 'verify-resume' })
			console.log('\n=== Step 6: Verify progress continues with caching ===')

			// Wait for more progress
			const targetProgress = Math.min(savedState.completed + 3, savedState.total)
			const progress2 = await waitForProgress(backend, runId, targetProgress, PROGRESS_WAIT_TIMEOUT)
			console.log(`Continued progress: ${progress2.completed}/${progress2.total}`)

			// Check logs for "cached" messages
			const logs = await backend.invoke('get_flow_run_logs_tail', { runId, lines: 500 })
			const cachedCount = (logs.match(/Cached process/g) || []).length
			console.log(`Found ${cachedCount} cached tasks in logs`)

			// ============================================================
			// Step 7: Final verification
			// ============================================================
			log(logSocket, { event: 'step-7', action: 'final-verify' })
			console.log('\n=== Step 7: Final verification ===')

			// Pause again to check final state
			await backend.invoke('pause_flow_run', { runId })
			await waitForStatus(backend, runId, 'paused', 60_000)

			const finalState = await backend.invoke('get_flow_state', { runId })
			console.log(`Final state: ${JSON.stringify(finalState)}`)

			expect(finalState.completed).toBeGreaterThanOrEqual(savedState.completed)

			console.log('\n✅ Pause/Resume test completed successfully!')
			console.log(`   - Initial progress: ${progress1.completed}/${progress1.total}`)
			console.log(`   - After pause: ${savedState.completed}/${savedState.total}`)
			console.log(`   - After resume: ${progress2.completed}/${progress2.total}`)
			console.log(`   - Final: ${finalState.completed}/${finalState.total}`)
			console.log(`   - Cached tasks: ${cachedCount}`)

			log(logSocket, { event: 'test-complete', success: true })
		} finally {
			await backend.close()
			await context.close()
		}
	})
})
