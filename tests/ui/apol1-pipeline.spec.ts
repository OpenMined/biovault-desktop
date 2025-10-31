import { expect, test } from '@playwright/test'
import { promises as fs } from 'fs'
import os from 'os'
import path from 'path'
import { fileURLToPath } from 'url'
import { waitForAppReady, ensureNotInOnboarding, navigateToTab } from './test-helpers.js'
import WebSocket from 'ws'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

/** @type {WebSocket | null} */
let logSocket = null

async function ensureLogSocket() {
	if (logSocket || !process.env.UNIFIED_LOG_WS) return
	logSocket = new WebSocket(process.env.UNIFIED_LOG_WS)
	await new Promise((resolve, reject) => {
		logSocket?.once('open', resolve)
		logSocket?.once('error', reject)
	})
}

/**
 * @param {Record<string, unknown>} payload
 */
function sendUnifiedLog(payload) {
	if (!logSocket || logSocket.readyState !== WebSocket.OPEN) return
	try {
		logSocket.send(JSON.stringify({ timestamp: new Date().toISOString(), ...payload }))
	} catch (error) {
		// Best-effort logging; swallow errors to avoid test failures
	}
}

const STORAGE_KEY = 'playwright:onboarded'
const SAMPLE_DIR = path.resolve(__dirname, '../../biovault/cli/tests/data/genotype_files')

const FILE_TEMPLATES = [
	{ id: '000000', name: 'carika.txt' },
	{ id: '103704', name: 'X_X_GSAv3-DTC_GRCh38-07-01-2025.txt' },
	{ id: '111442', name: 'X_X_GSAv3-DTC_GRCh38-07-01-2025.txt' },
	{ id: '117292', name: 'X_X_GSAv3-DTC_GRCh38-07-01-2025.txt' },
	{ id: '123364', name: 'X_X_GSAv3-DTC_GRCh38-07-01-2025.txt' },
	{ id: '256789', name: 'Combined_Genome.txt' },
	{ id: '356789', name: 'Eric_Uhden_Full_20110718111059.txt' },
	{ id: '456789', name: '20120718021406.csv' },
]

function toPosix(p) {
	return p.replace(/\\/g, '/')
}

test.describe('APOL1 Classifier Pipeline E2E', () => {
	test.beforeAll(async () => {
		await ensureLogSocket()
	})

	test.afterAll(async () => {
		if (logSocket) {
			await new Promise((resolve) => {
				logSocket?.once('close', resolve)
				logSocket?.close()
			})
			logSocket = null
		}
	})

	test('end-to-end APOL1 classifier pipeline workflow', async ({ page }, testInfo) => {
		testInfo.setTimeout(120000) // 2 minutes for full e2e test
		await ensureLogSocket()
		page.on('console', (msg) => {
			sendUnifiedLog({ source: 'browser', type: msg.type(), text: msg.text() })
		})
		sendUnifiedLog({ event: 'test-start', name: 'apol1-pipeline-flow' })

		// Prepare test data files (same as import test)
		const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'biovault-apol1-'))
		const sourceEntries = await fs.readdir(SAMPLE_DIR, { withFileTypes: true })
		const sourceFiles = sourceEntries.filter((entry) => entry.isFile()).map((entry) => entry.name)
		if (sourceFiles.length === 0) {
			throw new Error('Sample data directory is empty')
		}

		/** @type {{ path: string; id: string; extension: string }[]} */
		const preparedFiles = []

		for (let i = 0; i < FILE_TEMPLATES.length; i += 1) {
			const template = FILE_TEMPLATES[i]
			const sourceName = sourceFiles[i % sourceFiles.length]
			const sourcePath = path.join(SAMPLE_DIR, sourceName)
			const targetDir = path.join(tempRoot, template.id)
			await fs.mkdir(targetDir, { recursive: true })
			const targetPath = path.join(targetDir, `${template.id}_${template.name}`)
			await fs.copyFile(sourcePath, targetPath)
			preparedFiles.push({
				path: toPosix(targetPath),
				id: template.id,
				extension: path.extname(targetPath),
			})
		}

		const folderPathPosix = toPosix(tempRoot)

		// Set up test state
		const state = {
			storageKey: STORAGE_KEY,
			folderPath: folderPathPosix,
			files: preparedFiles.map((file) => ({ ...file })),
			importedFiles: [],
			participants: [],
			nextFileId: 1,
			nextParticipantId: 1,
			nextPipelineId: 1,
			nextRunId: 1,
			pipelines: [],
			runs: [],
		}

		await page.addInitScript(
			({ storageKey, testData, initialState }) => {
				const w = /** @type {any} */ window

				// Initialize state
				const state = {
					...initialState,
					files: testData.files.map((file) => ({ ...file })),
				}

				const ensureSessionOnboarded = () => {
					window.sessionStorage.setItem(storageKey, 'true')
				}

				const normalizeExt = (ext) => {
					if (!ext) return ''
					return ext.startsWith('.') ? ext : `.${ext}`
				}

				const getCandidateId = (filePath) => {
					const match = /\/(\d{6})_[^/]+$/.exec(filePath)
					return match ? match[1] : null
				}

				w.__TEST_STATE__ = state
				w.__TEST_SELECT_FOLDER__ = () => state.folderPath
				w.__TEST_INVOKE_OVERRIDE__ = async (cmd, args = {}) => {
					switch (cmd) {
						case 'check_is_onboarded':
							return true
						case 'get_participants':
							return state.participants.map((p) => ({ ...p }))
						case 'get_files':
							return state.importedFiles.map((f) => ({ ...f }))
						case 'get_projects':
						case 'get_command_logs':
							return []
						case 'get_desktop_log_text':
							return ''
						case 'clear_desktop_log':
							return null
						case 'get_desktop_log_dir':
							return '/tmp'
						case 'get_pipelines':
							return state.pipelines.map((p) => ({ ...p }))
						case 'get_runs':
						case 'get_pipeline_runs':
							return state.runs.map((r) => ({ ...r }))
						case 'get_runs_base_dir':
							return '/tmp/runs'
						case 'get_config_path':
							return `${state.folderPath}/config.yaml`
						case 'get_queue_processor_status':
							return false
						case 'get_saved_dependency_states':
							return { dependencies: [] }
						case 'get_syftbox_state':
							return { is_authenticated: false }
						case 'get_syftbox_config_info':
							return { exists: false, path: null }
						case 'get_extensions': {
							const counts = new Map()
							state.files.forEach((file) => {
								const ext = normalizeExt(file.extension)
								counts.set(ext, (counts.get(ext) || 0) + 1)
							})
							return Array.from(counts.entries()).map(([extension, count]) => ({
								extension,
								count,
							}))
						}
						case 'search_txt_files': {
							const extensions = (args.extensions || []).map((ext) => normalizeExt(ext))
							if (extensions.length === 0) return []
							return state.files
								.filter((file) => extensions.includes(normalizeExt(file.extension)))
								.map((file) => file.path)
						}
						case 'suggest_patterns': {
							const sample = state.files
								.slice(0, 2)
								.map((file) => ({ path: file.path, participant_id: getCandidateId(file.path) }))
							return [
								{
									description: 'Parent folder → Participant ID',
									pattern: '{parent:{id}}',
									regex_pattern: '',
									example: sample[0]?.path || '',
									sample_extractions: sample,
								},
							]
						}
						case 'extract_ids_for_files': {
							const result = {}
							;(args.files || []).forEach((filePath) => {
								const id = getCandidateId(filePath)
								if (id) result[filePath] = id
							})
							return result
						}
						case 'detect_file_types': {
							const detections = {}
							;(args.files || []).forEach((filePath) => {
								const isCsv = filePath.endsWith('.csv')
								if (isCsv) return
								detections[filePath] = {
									data_type: 'Genotype',
									source: '23andMe',
									grch_version: 'GRCh38',
								}
							})
							return detections
						}
						case 'import_files_pending': {
							const metadata = args.fileMetadata || {}
							Object.entries(metadata).forEach(([filePath, meta]) => {
								const participantId = meta.participant_id
								state.importedFiles.push({
									id: state.nextFileId++,
									participant_name: participantId,
									participant_id: participantId,
									file_path: filePath,
									status: 'complete',
									data_type: meta.data_type || 'Unknown',
									source: meta.source || 'Unknown',
									grch_version: meta.grch_version || 'Unknown',
									created_at: new Date().toISOString(),
								})

								if (!state.participants.some((p) => p.participant_id === participantId)) {
									state.participants.push({
										id: state.nextParticipantId++,
										participant_id: participantId,
										created_at: new Date().toISOString(),
									})
								}
							})
							return { success: true, conflicts: [], errors: [] }
						}
						case 'import_pipeline_from_url':
						case 'import_pipeline_with_deps': {
							const _url = args.url || ''
							// Check if pipeline already exists (for overwrite scenario)
							const existingPipeline = state.pipelines.find((p) => p.name === 'APOL1 Classifier')

							if (existingPipeline && !args.overwrite) {
								// Simulate "already exists" error
								throw new Error(
									`Pipeline "APOL1 Classifier" already exists. Do you want to overwrite it?`,
								)
							}

							// Remove existing if overwriting
							if (existingPipeline && args.overwrite) {
								state.pipelines = state.pipelines.filter((p) => p.id !== existingPipeline.id)
							}

							const pipelineId = state.nextPipelineId++
							const pipeline = {
								id: pipelineId,
								name: 'APOL1 Classifier',
								pipeline_path: `/tmp/pipelines/apol1-classifier`,
								spec: {
									name: 'APOL1 Classifier',
									inputs: {
										genotypes: {
											type: 'List[GenotypeRecord]',
										},
									},
									steps: [
										{
											id: 'classify',
											uses: 'apol1-classifier-project@1.0.0',
											publish: {
												results: 'File(results.csv)',
											},
										},
									],
								},
								created_at: new Date().toISOString(),
							}
							state.pipelines.push(pipeline)
							return pipeline
						}
						case 'run_pipeline': {
							const pipelineId = args.pipelineId
							const pipeline = state.pipelines.find((p) => p.id === pipelineId)
							if (!pipeline) {
								throw new Error(`Pipeline ${pipelineId} not found`)
							}

							const runId = state.nextRunId++
							const run = {
								id: runId,
								pipeline_id: pipelineId,
								pipeline_name: pipeline.name,
								status: 'running',
								created_at: new Date().toISOString(),
								results_dir: `/tmp/runs/${runId}`,
								metadata: JSON.stringify({
									data_selection: {
										fileIds: args.selection?.fileIds || [],
										participantIds: args.selection?.participantIds || [],
									},
									input_overrides: args.inputOverrides || {},
									parameter_overrides: {},
								}),
							}
							state.runs.push(run)

							// For test, set status to success immediately (in real app this would take time)
							// But simulate it being 'running' first, then success
							// Set to success right away so it's visible when runs page loads
							run.status = 'success'
							run.completed_at = new Date().toISOString()

							return run
						}
						case 'load_pipelines': {
							// Return pipelines (used internally by loadPipelines)
							return state.pipelines.map((p) => ({ ...p }))
						}
						case 'get_pipeline_run_steps': {
							const runId = args.runId
							const run = state.runs.find((r) => r.id === runId)
							if (!run) {
								return []
							}

							// Return steps with published output (only for successful runs)
							if (run.status === 'success') {
								return [
									{
										id: 'classify',
										uses: 'apol1-classifier-project@1.0.0',
										status: 'success',
										publish: {
											results: 'File(results.csv)',
										},
									},
								]
							}

							// For running runs, return steps without publish yet
							return [
								{
									id: 'classify',
									uses: 'apol1-classifier-project@1.0.0',
									status: 'running',
								},
							]
						}
						case 'load_pipeline_editor': {
							const pipeline = state.pipelines.find((p) => p.id === args.pipelineId)
							return {
								pipeline_path: pipeline?.pipeline_path || '/tmp/pipeline',
								spec: pipeline?.spec || { name: '', inputs: {}, steps: [] },
							}
						}
						case 'load_project_editor': {
							// Mock project editor for steps
							return {
								project_path: '/tmp/project',
								metadata: {
									name: 'apol1-classifier-project',
									inputs: [],
									outputs: [
										{ name: 'results', type: 'File', description: 'Classification results' },
									],
									parameters: [],
								},
								tree: [],
								digest: 'abc123',
							}
						}
						default:
							console.warn('[Test] Unhandled invoke:', cmd, args)
							return null
					}
				}

				ensureSessionOnboarded()
			},
			{
				storageKey: STORAGE_KEY,
				testData: { folderPath: folderPathPosix, files: preparedFiles },
				initialState: state,
			},
		)

		await page.goto('/')
		await waitForAppReady(page)
		await ensureNotInOnboarding(page)

		sendUnifiedLog({ event: 'step-1', action: 'import-pipeline' })

		// Step 1: Navigate to pipelines and create APOL1 pipeline
		await navigateToTab(page, 'run')
		await page.waitForTimeout(500)
		await expect(page.locator('#run-view')).toBeVisible()

		// Click create pipeline button
		const createBtn = page.locator('#create-pipeline-btn, #empty-create-pipeline-btn').first()
		await expect(createBtn).toBeVisible()
		await createBtn.click()

		// Wait for template picker modal
		await page.waitForSelector('#pipeline-picker-modal', { state: 'visible', timeout: 5000 })
		await expect(page.locator('#pipeline-picker-modal')).toContainText('APOL1 Classifier')

		// Set up dialog handler before clicking (for overwrite confirmation)
		page.on('dialog', async (dialog) => {
			sendUnifiedLog({ event: 'dialog', message: dialog.message() })
			const message = dialog.message().toLowerCase()
			if (message.includes('overwrite') || message.includes('already exists')) {
				await dialog.accept() // Click overwrite/yes
			} else {
				await dialog.accept() // Accept other dialogs too
			}
		})

		// Click APOL1 Classifier template
		const apol1Card = page.locator('button.new-pipeline-template-card:has-text("APOL1 Classifier")')
		await expect(apol1Card).toBeVisible()
		await apol1Card.click()

		// Wait for loading modal (if any), then pipeline import
		await page.waitForTimeout(3000)

		// Check if pipeline was created by looking for it in the pipelines list
		const pipelinesGrid = page.locator('#pipelines-grid')
		// Refresh pipelines list
		await page.evaluate(() => {
			if (window.pipelineModule?.loadPipelines) {
				window.pipelineModule.loadPipelines()
			}
		})
		await page.waitForTimeout(1000)

		if ((await pipelinesGrid.count()) > 0) {
			await expect(pipelinesGrid).toContainText('APOL1 Classifier', { timeout: 5000 })
		}

		sendUnifiedLog({ event: 'step-2', action: 'import-data' })

		// Step 2: Import example data (same as import test)
		await navigateToTab(page, 'data')
		await expect(page.locator('#data-view.tab-content.active')).toBeVisible()

		// Click import button
		const openImportBtn = page.locator('#open-import-modal-btn')
		await expect(openImportBtn).toBeVisible()
		await openImportBtn.click()

		// Wait for import modal
		const importModal = page.locator('#import-modal')
		await expect(importModal).not.toHaveAttribute('hidden')

		// Click folder dropzone
		const folderDropzone = page.locator('#folder-dropzone')
		await expect(folderDropzone).toBeVisible()
		await folderDropzone.click()

		// Wait for folder selection to complete and file types section to appear
		await page.waitForTimeout(500)
		const fileTypeSection = page.locator('#file-types-section')
		await expect(fileTypeSection).toBeVisible({ timeout: 5000 })

		// Select file types
		const txtCheckbox = page.locator('.file-type-checkbox input[value=".txt"]')
		const csvCheckbox = page.locator('.file-type-checkbox input[value=".csv"]')
		await txtCheckbox.check()
		await csvCheckbox.check()

		// Verify file list
		const fileList = page.locator('#file-list tr')
		await expect(fileList).toHaveCount(preparedFiles.length)

		// Wait for pattern suggestions
		const patternSection = page.locator('#pattern-detection-section')
		await expect(patternSection).toBeVisible()
		const patternSuggestions = page.locator('.pattern-suggestion')
		await expect(patternSuggestions.first()).toBeVisible({ timeout: 5000 })

		// Select pattern
		const patternButton = patternSuggestions.first()
		await patternButton.click()

		// Fill participant IDs (they should be auto-filled from pattern)
		const participantInputs = page.locator('.participant-id-input')
		await expect(participantInputs).toHaveCount(preparedFiles.length)

		// Click Continue button to go to review step
		const continueBtn = page.locator('#import-continue-btn')
		await expect(continueBtn).toBeEnabled({ timeout: 5000 })
		await continueBtn.click()

		// Wait for review view to appear
		const reviewView = page.locator('#import-modal-review')
		await expect(reviewView).toBeVisible({ timeout: 5000 })

		// Wait for file type detection to complete (if any)
		const detectionProgress = page.locator('#detection-progress')
		if ((await detectionProgress.count()) > 0) {
			await expect(detectionProgress).toBeHidden({ timeout: 10000 })
		}

		// Click Import Files button in review step
		const importBtn = page.locator('#review-import-btn')
		await expect(importBtn).toBeVisible({ timeout: 5000 })
		await importBtn.click()

		// Wait for modal to close after successful import
		await expect(importModal).toHaveAttribute('hidden', '', { timeout: 10000 })

		// Verify files are imported by checking the data table
		const dataTable = page.locator('#data-table, .file-row')
		await expect(dataTable.first()).toBeVisible({ timeout: 5000 })

		sendUnifiedLog({ event: 'step-3', action: 'select-all-and-run' })

		// Step 3: Select all files on Data page and run pipeline via modal
		// Make sure we're on the Data page (should already be there after import)
		await navigateToTab(page, 'data')
		await expect(page.locator('#data-view.tab-content.active')).toBeVisible()
		await page.waitForTimeout(1000)

		// Select all files checkbox
		const selectAllCheckbox = page.locator('#select-all-data-files, #select-all-files-checkbox')
		await expect(selectAllCheckbox).toBeVisible({ timeout: 5000 })
		await selectAllCheckbox.check()
		await page.waitForTimeout(500)

		// Verify files are selected
		const selectedCount = await page.locator('.file-row.selected, tr.file-row.selected').count()
		expect(selectedCount).toBeGreaterThan(0)

		// Click Run Pipeline button on Data page (this opens the modal)
		const runPipelineBtn = page.locator('#run-analysis-btn')
		await expect(runPipelineBtn).toBeVisible()
		await expect(runPipelineBtn).toBeEnabled()
		await runPipelineBtn.click()

		// Wait for data run modal to appear
		const dataRunModal = page.locator('#data-run-modal')
		await expect(dataRunModal).toBeVisible({ timeout: 5000 })

		// Find and select APOL1 Classifier pipeline radio button
		// The radio buttons are within the modal, find by pipeline name in label
		const apol1Option = dataRunModal.locator('label').filter({ hasText: /APOL1/i })

		if ((await apol1Option.count()) > 0) {
			// Click the label which will select the radio
			await apol1Option.click()
		} else {
			// Fallback: try to find radio by value or just select first pipeline
			const pipelineRadios = dataRunModal.locator('input[type="radio"][name="data-run-pipeline"]')
			if ((await pipelineRadios.count()) > 0) {
				await pipelineRadios.first().check()
			}
		}

		await page.waitForTimeout(500)

		// Click Run Pipeline button in the modal
		const modalRunBtn = dataRunModal.locator('#data-run-run-btn')
		await expect(modalRunBtn).toBeVisible()
		await expect(modalRunBtn).toBeEnabled()
		await modalRunBtn.click()

		// Wait for modal to close (dialog is auto-handled by earlier handler)
		await expect(dataRunModal).toBeHidden({ timeout: 5000 })
		await page.waitForTimeout(1000)

		sendUnifiedLog({ event: 'step-4', action: 'verify-run' })

		// Step 4: Navigate to runs and verify the published CSV
		await navigateToTab(page, 'runs')
		await page.waitForTimeout(1000)
		await expect(page.locator('#runs-view')).toBeVisible({ timeout: 5000 })

		// Trigger runs load if needed
		await page.evaluate(() => {
			if (window.runsModule?.loadRuns) {
				window.runsModule.loadRuns()
			}
		})

		// Wait for runs to load and appear
		await page.waitForTimeout(2000)

		// Find the latest run (should be first in the list)
		const runCards = page.locator('.pipeline-run-card')
		await expect(runCards.first()).toBeVisible({ timeout: 10000 })

		const latestRun = runCards.first()

		// Check that the run is for APOL1 Classifier
		await expect(latestRun).toContainText(/APOL1|apol1/i, { timeout: 5000 })

		// Wait for run to complete (simulated in mock, but wait a bit for UI to update)
		await page.waitForTimeout(3000)

		// Poll for published outputs (they only appear when status is success)
		await expect
			.poll(
				async () => {
					// Reload runs to get updated status
					await page.evaluate(() => {
						if (window.runsModule?.loadRuns) {
							window.runsModule.loadRuns()
						}
					})
					await page.waitForTimeout(1000)

					// Look for published output cards within the latest run
					const publishedCards = latestRun.locator('.published-output-card')
					return await publishedCards.count()
				},
				{ timeout: 10000 },
			)
			.toBeGreaterThan(0)

		// Verify CSV file is listed in published outputs
		const publishedCards = latestRun.locator('.published-output-card')
		await expect(publishedCards.first()).toBeVisible()
		await expect(publishedCards.first()).toContainText(/results\.csv|csv/i, {
			timeout: 5000,
		})

		sendUnifiedLog({ event: 'step-5', action: 'verified-published-output' })

		sendUnifiedLog({ event: 'test-complete', name: 'apol1-pipeline-flow' })
	})
})
