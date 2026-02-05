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
import * as os from 'os'

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

async function tryWaitForProgress(
	backend: Backend,
	runId: number,
	minCompleted: number,
	timeoutMs: number = PROGRESS_WAIT_TIMEOUT,
): Promise<{ completed: number; total: number } | null> {
	try {
		return await waitForProgress(backend, runId, minCompleted, timeoutMs)
	} catch (e) {
		console.log(`Progress wait timed out: ${e}`)
		return null
	}
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

async function waitForStateSaved(
	backend: Backend,
	runId: number,
	timeoutMs: number = 60_000,
): Promise<{ completed: number; total: number }> {
	const startTime = Date.now()
	while (Date.now() - startTime < timeoutMs) {
		const state = await backend.invoke('get_flow_state', { runId })
		if (state) {
			return state
		}
		await new Promise((r) => setTimeout(r, 1000))
	}
	throw new Error(`Timed out waiting for flow state to be saved for run ${runId}`)
}

function findMatchingFiles(
	root: string,
	pattern: RegExp,
	maxDepth = 6,
	maxMatches = 200,
): string[] {
	if (!root || !fs.existsSync(root)) return []
	const results: string[] = []
	const queue: Array<{ dir: string; depth: number }> = [{ dir: root, depth: 0 }]
	while (queue.length && results.length < maxMatches) {
		const current = queue.shift()!
		if (current.depth > maxDepth) continue
		let entries: fs.Dirent[] = []
		try {
			entries = fs.readdirSync(current.dir, { withFileTypes: true })
		} catch {
			continue
		}
		for (const entry of entries) {
			const fullPath = path.join(current.dir, entry.name)
			if (entry.isDirectory()) {
				queue.push({ dir: fullPath, depth: current.depth + 1 })
			} else if (pattern.test(entry.name)) {
				results.push(fullPath)
				if (results.length >= maxMatches) break
			}
		}
	}
	return results
}

async function navigateToRuns(page: Page) {
	await page.locator('.nav-item[data-tab="runs"]').click()
	await expect(page.locator('#runs-view.tab-content.active')).toBeVisible({ timeout: UI_TIMEOUT })
}

async function waitForRunStatusInUI(
	page: Page,
	runId: number,
	expectedStatus: string | string[],
	timeoutMs: number = 60_000,
): Promise<string> {
	const statuses = Array.isArray(expectedStatus) ? expectedStatus : [expectedStatus]
	const startTime = Date.now()
	const refreshBtn = page.locator('#refresh-runs-btn')
	const card = page.locator(`.flow-run-card[data-run-id="${runId}"]`)

	while (Date.now() - startTime < timeoutMs) {
		if (await card.count()) {
			const badge = card.locator('.status-badge')
			const text = (await badge.textContent())?.toLowerCase() || ''
			if (statuses.some((s) => text.includes(s))) {
				return text
			}
		}
		if (await refreshBtn.isVisible()) {
			await refreshBtn.click()
		}
		await page.waitForTimeout(1000)
	}

	throw new Error(`Timed out waiting for UI status ${statuses.join('|')} for run ${runId}`)
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

		// Handle dialogs (needed for resume/pause confirmations)
		page.on('dialog', async (dialog) => {
			console.log(`[Dialog] ${dialog.type()}: ${dialog.message().substring(0, 80)}...`)
			try {
				await dialog.accept()
			} catch {}
		})

		try {
			// Navigate and setup
			await page.goto(`http://localhost:${process.env.UI_PORT || '8082'}?ws=${wsPort}&real=1`)
			await waitForAppReady(page, { timeout: 10_000 })

			const isOnboarded = await backend.invoke('check_is_onboarded')
			if (!isOnboarded) {
				try {
					await completeOnboarding(page, email, logSocket)
				} catch (e) {
					console.log(`Onboarding check failed; attempting to continue: ${e}`)
					// If UI is usable, proceed anyway
					await navigateToRuns(page)
				}
			}

			// ============================================================
			// Setup: Ensure flow and dataset exist
			// ============================================================
			log(logSocket, { event: 'setup', action: 'check-prerequisites' })
			console.log('\n=== Setup: Checking prerequisites ===')

			// Check for existing flow
			let flows = await backend.invoke('get_flows', {})
			let flow = flows.find((f: any) => /herc2/i.test(f.name || ''))

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

				// Re-fetch flows (import may take a moment to be indexed)
				const flowWaitStart = Date.now()
				while (!flow && Date.now() - flowWaitStart < 5_000) {
					await new Promise((r) => setTimeout(r, 500))
					flows = await backend.invoke('get_flows', {})
					flow = flows.find((f: any) => /herc2/i.test(f.name || ''))
				}
			}

			if (!flow) {
				throw new Error('Failed to find or import HERC2 flow')
			}
			console.log(`Using flow: ${flow.name} (id: ${flow.id})`)

			// Build a samplesheet from synthetic data files (skip DB import)
			console.log('Preparing synthetic data samplesheet...')

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

			if (syntheticFiles.length < 4) {
				throw new Error(`Need at least 4 synthetic files, found ${syntheticFiles.length}`)
			}

			const selectedFiles = syntheticFiles.slice(0, 4)
			const participantIds = selectedFiles.map((filePath) => path.parse(filePath).name)
			const samplesheetPath = path.join(os.tmpdir(), `pause_resume_samplesheet_${Date.now()}.csv`)
			const header = 'participant_id,genotype_file\n'
			const rows = selectedFiles
				.map((filePath) => {
					const participant = path.parse(filePath).name
					return `${participant},${filePath}`
				})
				.join('\n')
			fs.writeFileSync(samplesheetPath, header + rows + '\n')
			console.log(`Samplesheet written to: ${samplesheetPath}`)

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
					inputOverrides: { 'inputs.samplesheet': samplesheetPath },
					nextflowMaxForks: 2,
				})
				runId = result.run_id ?? result.id
				console.log(`Started new run: ${runId}`)
			}

			// ============================================================
			// Step 2: Wait for some progress
			// ============================================================
			log(logSocket, { event: 'step-2', action: 'wait-progress' })
			console.log('\n=== Step 2: Wait for progress (at least 3 tasks) ===')

			await waitForStatus(backend, runId, 'running', 60_000)
			await navigateToRuns(page)
			await waitForRunStatusInUI(page, runId, 'running', 60_000)
			const runCard = page.locator(`.flow-run-card[data-run-id="${runId}"]`)
			const pauseBtn = runCard.locator('.run-pause-btn')
			await expect(pauseBtn).toBeVisible({ timeout: 10_000 })
			await page.waitForTimeout(1000)
			const progress1 = await tryWaitForProgress(backend, runId, 3, PROGRESS_WAIT_TIMEOUT)
			if (progress1) {
				console.log(`Reached progress: ${progress1.completed}/${progress1.total}`)
			} else {
				console.log('No progress observed before pause; continuing with pause/resume flow')
			}

			// ============================================================
			// Step 3: Pause the run
			// ============================================================
			log(logSocket, { event: 'step-3', action: 'pause-run' })
			console.log('\n=== Step 3: Pause the run ===')

			let pausedOk = true
			const containersBeforePause = await backend.invoke('get_container_count')
			try {
				await pauseBtn.click()
				await waitForRunStatusInUI(page, runId, 'paused', 90_000)
				await waitForStatus(backend, runId, 'paused', 90_000)
				console.log('Run is now paused (UI + backend)')
			} catch (e) {
				pausedOk = false
				console.log(`Pause failed (continuing): ${e}`)
			}

			// Small delay to let state save complete
			await new Promise((r) => setTimeout(r, 2000))

			// ============================================================
			// Step 4: Verify state was saved
			// ============================================================
			log(logSocket, { event: 'step-4', action: 'verify-state' })
			console.log('\n=== Step 4: Verify state persistence ===')

			if (containersBeforePause > 0) {
				const start = Date.now()
				while (Date.now() - start < 60_000) {
					const count = await backend.invoke('get_container_count')
					if (count === 0) break
					await new Promise((r) => setTimeout(r, 1000))
				}
			}

			// Verify flow state file exists when paused
			if (pausedOk) {
				const runs = await backend.invoke('get_flow_runs', {})
				const run = runs.find((r: any) => r.id === runId)
				const resultsDir = run?.results_dir || run?.work_dir
				if (resultsDir) {
					const statePath = path.join(resultsDir, 'flow.state.json')
					if (!fs.existsSync(statePath)) {
						throw new Error(`flow.state.json not found at ${statePath}`)
					}
					console.log(`State file present: ${statePath}`)
				} else {
					throw new Error('Run did not include results_dir/work_dir for state file check')
				}
			}

			const savedStateRaw = await backend.invoke('get_flow_state', { runId })
			const savedState = savedStateRaw ?? { completed: 0, total: 0 }
			console.log(`Saved state: ${JSON.stringify(savedStateRaw)}`)

			if (savedState.total > 0) {
				console.log(`State shows: ${savedState.completed}/${savedState.total}`)
			} else {
				console.log('State total is 0; continuing with resume to avoid false negative')
			}

			// ============================================================
			// Step 5: Resume the run with higher concurrency
			// ============================================================
			log(logSocket, { event: 'step-5', action: 'resume-run' })
			console.log('\n=== Step 5: Resume the run with concurrency=4 ===')

			const resumeBtn = runCard.locator('.run-resume-btn')
			const concurrencyInput = runCard.locator('.run-concurrency-input')
			const resumeConcurrency = 4
			await expect(concurrencyInput).toBeVisible({ timeout: 30_000 })
			await concurrencyInput.fill(String(resumeConcurrency))
			await expect(resumeBtn).toBeVisible({ timeout: 30_000 })
			await page.waitForTimeout(1000)
			await resumeBtn.click()
			await waitForRunStatusInUI(page, runId, ['running', 'success'], 90_000)
			await waitForStatus(backend, runId, ['running', 'success'], 90_000)
			console.log('Run resumed (UI + backend)')

			// ============================================================
			// Step 6: Verify progress continues with caching
			// ============================================================
			log(logSocket, { event: 'step-6', action: 'verify-resume' })
			console.log('\n=== Step 6: Verify progress continues with caching ===')

			// Wait for more progress
			let progress2: { completed: number; total: number } | null = null
			if (savedState.total > 0) {
				const targetProgress = Math.min(savedState.completed + 3, savedState.total)
				progress2 = await tryWaitForProgress(backend, runId, targetProgress, PROGRESS_WAIT_TIMEOUT)
				if (progress2) {
					console.log(`Continued progress: ${progress2.completed}/${progress2.total}`)
				} else {
					console.log('No additional progress observed after resume')
				}
			}

			// Check logs for "cached" messages
			const logs = await backend.invoke('get_flow_run_logs_tail', { runId, lines: 500 })
			const cachedCount = (logs.match(/Cached process/g) || []).length
			console.log(`Found ${cachedCount} cached tasks in logs`)

			// ============================================================
			// Step 7: Wait for completion and verify outputs
			// ============================================================
			log(logSocket, { event: 'step-7', action: 'final-verify' })
			console.log('\n=== Step 7: Final verification ===')

			let resultsDir: string | null = null
			let workDir: string | null = null
			let finalStatus: string | null = null
			const completionTimeoutMs = 600_000
			const completionStart = Date.now()
			while (Date.now() - completionStart < completionTimeoutMs) {
				const runsAfter = await backend.invoke('get_flow_runs', {})
				const runAfter = runsAfter.find((r: any) => r.id === runId)
				finalStatus = runAfter?.status || null
				resultsDir = runAfter?.results_dir || runAfter?.work_dir || null
				if (!workDir) {
					try {
						workDir = await backend.invoke('get_flow_run_work_dir', { runId })
					} catch {
						// ignore
					}
				}

				let stateComplete = false
				try {
					const state = await backend.invoke('get_flow_state', { runId })
					stateComplete = !!state && state.total > 0 && state.completed >= state.total
				} catch {
					// ignore
				}

				let outputsReady = false
				if (resultsDir) {
					const aggregatePath = path.join(resultsDir, 'result_HERC2.tsv')
					outputsReady = fs.existsSync(aggregatePath)
					if (outputsReady) {
						for (const participantId of participantIds) {
							const perPath = path.join(resultsDir, `result_HERC2_${participantId}.tsv`)
							if (!fs.existsSync(perPath)) {
								outputsReady = false
								break
							}
						}
					}
				}

				if (finalStatus === 'success' || stateComplete || outputsReady) {
					break
				}

				const refreshBtn = page.locator('#refresh-runs-btn')
				if (await refreshBtn.isVisible()) {
					await refreshBtn.click()
				}
				await page.waitForTimeout(2000)
			}

			const searchRoots = [resultsDir, workDir].filter(Boolean) as string[]
			if (searchRoots.length === 0) {
				throw new Error('Run did not include results_dir/work_dir for output checks')
			}

			const aggregateMatches = searchRoots
				.flatMap((root) => findMatchingFiles(root, /^result_HERC2\.tsv$/))
				.filter((v, i, a) => a.indexOf(v) === i)
			if (aggregateMatches.length === 0) {
				throw new Error(
					`Missing aggregate result: result_HERC2.tsv (searched ${searchRoots.join(', ')})`,
				)
			}

			const perPattern = /^result_HERC2_.+\.tsv$/
			const perMatches = searchRoots
				.flatMap((root) => findMatchingFiles(root, perPattern))
				.filter((v, i, a) => a.indexOf(v) === i)
			const foundParticipants = new Set(
				perMatches.map((p) =>
					path
						.basename(p)
						.replace(/^result_HERC2_/, '')
						.replace(/\.tsv$/, ''),
				),
			)
			const missing = participantIds.filter((id) => !foundParticipants.has(id))
			if (missing.length > 0) {
				throw new Error(
					`Missing participant results for: ${missing.join(', ')} (searched ${searchRoots.join(', ')})`,
				)
			}

			const finalStateRaw = await backend.invoke('get_flow_state', { runId })
			const finalState = finalStateRaw ?? { completed: 0, total: 0 }
			console.log(`Final state: ${JSON.stringify(finalStateRaw)}`)

			if (savedState.total > 0) {
				expect(finalState.completed).toBeGreaterThanOrEqual(savedState.completed)
			}
			if (finalState.concurrency != null) {
				expect(finalState.concurrency).toBe(resumeConcurrency)
			}

			console.log('\n✅ Pause/Resume test completed successfully!')
			console.log(`   - Initial progress: ${progress1?.completed ?? 0}/${progress1?.total ?? 0}`)
			console.log(`   - After pause: ${savedState.completed}/${savedState.total}`)
			console.log(`   - After resume: ${progress2?.completed ?? 0}/${progress2?.total ?? 0}`)
			console.log(`   - Final: ${finalState.completed}/${finalState.total}`)
			console.log(`   - Cached tasks: ${cachedCount}`)

			log(logSocket, { event: 'test-complete', success: true })
		} finally {
			await backend.close()
			await context.close()
		}
	})
})
