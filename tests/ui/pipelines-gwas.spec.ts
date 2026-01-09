/**
 * Pipelines GWAS Test
 * Tests GWAS pipeline with PLINK-style dataset mapping:
 * 1. Import GWAS data (.bed/.bim/.fam)
 * 2. Import GWAS pipeline
 * 3. Create dataset with PLINK files
 * 4. Run pipeline on real data
 *
 * Usage:
 *   ./test-scenario.sh --pipelines-gwas
 *
 * @tag pipelines-gwas
 */
import { expect, test, type Page, pauseForInteractive } from './playwright-fixtures'
import WebSocket from 'ws'
import * as fs from 'fs'
import * as path from 'path'
import { waitForAppReady } from './test-helpers.js'
import { setWsPort, completeOnboarding, ensureLogSocket, log } from './onboarding-helper.js'

const TEST_TIMEOUT = 900_000 // 15 minutes max
const UI_TIMEOUT = 10_000
const PIPELINE_RUN_TIMEOUT = 600_000
const PIPELINE_START_TIMEOUT = 60_000

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

async function waitForPipelineRun(
	backend: Backend,
	pipelineId: number,
	createdAfterMs: number,
	timeoutMs: number = PIPELINE_START_TIMEOUT,
): Promise<any> {
	const startTime = Date.now()

	while (Date.now() - startTime < timeoutMs) {
		const runs = await backend.invoke('get_pipeline_runs', {})
		const candidates = runs.filter((run: any) => run.pipeline_id === pipelineId)
		if (candidates.length > 0) {
			const filtered = candidates.filter((run: any) => {
				const createdAt = Date.parse(run.created_at || '')
				if (Number.isNaN(createdAt)) return true
				return createdAt >= createdAfterMs - 1000
			})
			const sorted = (filtered.length > 0 ? filtered : candidates).sort(
				(a: any, b: any) => (b.id || 0) - (a.id || 0),
			)
			if (sorted[0]) return sorted[0]
		}
		await new Promise((resolve) => setTimeout(resolve, 1000))
	}

	throw new Error('Timed out waiting for pipeline run to appear')
}

function collectFiles(root: string, maxDepth: number = 4): string[] {
	const files: string[] = []

	function walk(current: string, depth: number) {
		if (depth > maxDepth) return
		let entries: fs.Dirent[]
		try {
			entries = fs.readdirSync(current, { withFileTypes: true })
		} catch {
			return
		}
		for (const entry of entries) {
			const entryPath = path.join(current, entry.name)
			if (entry.isDirectory()) {
				walk(entryPath, depth + 1)
			} else if (entry.isFile()) {
				files.push(entryPath)
			}
		}
	}

	walk(root, 0)
	return files
}

function assertOutputFile(
	resultsDir: string,
	files: string[],
	pattern: RegExp,
	label: string,
): string {
	const match = files.find((file) => pattern.test(file))
	if (!match) {
		const sample = files
			.slice(0, 20)
			.map((file) => path.relative(resultsDir, file))
			.join(', ')
		throw new Error(`Missing ${label}. Found files: ${sample || '(none)'}`)
	}
	const stats = fs.statSync(match)
	if (!stats.isFile() || stats.size === 0) {
		throw new Error(`Expected ${label} to be a non-empty file: ${match}`)
	}
	return match
}

test.describe('Pipelines GWAS @pipelines-gwas', () => {
	test('import gwas data, create dataset, run pipeline', async ({ browser }, testInfo) => {
		const wsPort = Number.parseInt(process.env.DEV_WS_BRIDGE_PORT_BASE || '3333', 10)
		const email = process.env.TEST_EMAIL || 'client1@sandbox.local'
		const gwasDataDir =
			process.env.GWAS_DATA_DIR || '/Users/madhavajay/dev/biovaults/datasets/jordan_gwas'

		const requiredFiles = [
			'Chechen_qc.bed',
			'Chechen_qc.bim',
			'Chechen_qc.fam',
			'Circassian_qc.bed',
			'Circassian_qc.bim',
			'Circassian_qc.fam',
		]

		const mockFiles = ['mock.bed', 'mock.bim', 'mock.fam']

		console.log('Setting up pipelines GWAS test')
		console.log(`Client: ${email} (port ${wsPort})`)
		console.log(`GWAS data dir: ${gwasDataDir}`)

		if (!fs.existsSync(gwasDataDir)) {
			test.skip(true, `GWAS data directory not found: ${gwasDataDir}`)
		}
		const missingFiles = [...requiredFiles, ...mockFiles].filter((file) => {
			const fullPath = path.join(gwasDataDir, file)
			return !fs.existsSync(fullPath)
		})
		if (missingFiles.length > 0) {
			test.skip(true, `Missing GWAS files: ${missingFiles.join(', ')} (dir: ${gwasDataDir})`)
		}

		const logSocket = await ensureLogSocket()
		const context = await browser.newContext()
		const page = await context.newPage()
		let runStarted = false
		let runId: number | null = null
		let pipelineId: number | null = null

		page.on('console', (msg) => {
			if (msg.type() === 'error') {
				console.log(`[Browser Error] ${msg.text()}`)
			}
		})

		await setWsPort(page, wsPort)
		const backend = await connectBackend(wsPort)
		let caughtError: unknown = null

		try {
			await page.goto(`http://localhost:${process.env.UI_PORT || '8082'}?ws=${wsPort}&real=1`)
			await waitForAppReady(page, { timeout: 10_000 })

			const isOnboarded = await backend.invoke('check_is_onboarded')
			if (!isOnboarded) {
				await completeOnboarding(page, email, logSocket)
			}
			page.on('dialog', async (dialog) => {
				const message = dialog.message()
				console.log(`Dialog: ${message}`)
				if (message.includes('Pipeline started!')) {
					runStarted = true
					const match = message.match(/run id:\s*(\d+)/i)
					if (match) {
						const parsed = Number.parseInt(match[1], 10)
						if (!Number.isNaN(parsed)) {
							runId = parsed
							console.log(`Captured run ID from dialog: ${runId}`)
						}
					}
				}
				try {
					await dialog.accept()
				} catch (error) {
					console.log(`Dialog already handled: ${error}`)
				}
			})

			// ============================================================
			// Step 1: Import GWAS data
			// ============================================================
			log(logSocket, { event: 'step-1', action: 'import-gwas-data' })
			console.log('\n=== Step 1: Import GWAS data ===')

			await page.locator('.nav-item[data-tab="data"]').click()
			await expect(page.locator('#data-view.tab-content.active')).toBeVisible({
				timeout: UI_TIMEOUT,
			})

			const importBtn = page.locator('#open-import-modal-btn')
			await expect(importBtn).toBeVisible()
			await importBtn.click()

			const importModal = page.locator('#import-modal')
			await expect(importModal).not.toHaveAttribute('hidden')

			await page.evaluate((folderPath) => {
				const w = window as any
				w.__TEST_SELECT_FOLDER__ = () => folderPath
			}, gwasDataDir)

			const folderDropzone = page.locator('#folder-dropzone')
			await expect(folderDropzone).toBeVisible()
			await folderDropzone.click()

			await page.waitForTimeout(1000)
			const fileTypeSection = page.locator('#file-types-section')
			await expect(fileTypeSection).toBeVisible({ timeout: 10_000 })

			for (const ext of ['.bed', '.bim', '.fam']) {
				const checkbox = page.locator(`.file-type-checkbox input[value="${ext}"]`)
				if ((await checkbox.count()) > 0) {
					await checkbox.check()
				}
			}

			await page.waitForTimeout(1500)

			const selectAllFiles = page.locator('#select-all-files')
			if ((await selectAllFiles.count()) > 0) {
				await selectAllFiles.check()
			}

			const patternSection = page.locator('#pattern-detection-section')
			if (await patternSection.isVisible().catch(() => false)) {
				await patternSection.scrollIntoViewIfNeeded()
				const randomIdsBtn = page.locator('#random-ids-btn')
				if (await randomIdsBtn.isVisible().catch(() => false)) {
					await randomIdsBtn.click()
					await page.waitForTimeout(500)
				}
			}

			const continueBtn = page.locator('#import-continue-btn')
			await expect(continueBtn).toBeEnabled({ timeout: 10_000 })
			await continueBtn.click()

			const reviewView = page.locator('#import-modal-review')
			await expect(reviewView).toBeVisible({ timeout: 10_000 })

			const detectionProgress = page.locator('#detection-progress')
			if (await detectionProgress.isVisible().catch(() => false)) {
				await expect(detectionProgress).toBeHidden({ timeout: 30_000 })
			}

			const reviewImportBtn = page.locator('#review-import-btn')
			await expect(reviewImportBtn).toBeVisible()
			await reviewImportBtn.click()

			await expect(importModal).toHaveAttribute('hidden', '', { timeout: 30_000 })

			await page.waitForTimeout(2000)
			const dataTable = page.locator('#files-table-body tr, .file-row')
			const importedCount = await dataTable.count()
			console.log(`Imported ${importedCount} files`)
			expect(importedCount).toBeGreaterThanOrEqual(requiredFiles.length)

			// ============================================================
			// Step 2: Import GWAS Pipeline
			// ============================================================
			log(logSocket, { event: 'step-2', action: 'import-gwas-pipeline' })
			console.log('\n=== Step 2: Import GWAS Pipeline ===')

			const pipelinePath = path.join(process.cwd(), 'gwas-nextflow', 'pipeline.yaml')
			const pipeline = await backend.invoke('create_pipeline', {
				request: {
					name: 'gwas-population-analysis',
					pipeline_file: pipelinePath,
					overwrite: true,
				},
			})
			pipelineId = pipeline.id

			await page.locator('.nav-item[data-tab="run"]').click()
			await expect(page.locator('#run-view')).toBeVisible({ timeout: UI_TIMEOUT })

			await page.evaluate(() => {
				const w = window as any
				if (w.pipelineModule?.loadPipelines) {
					w.pipelineModule.loadPipelines()
				}
			})
			await page.waitForTimeout(2000)

			const pipelinesGrid = page.locator('#pipelines-grid')
			await expect(pipelinesGrid).toContainText(/gwas-population-analysis/i, { timeout: 10_000 })
			console.log('GWAS pipeline imported!')

			// ============================================================
			// Step 3: Create dataset with PLINK files
			// ============================================================
			log(logSocket, { event: 'step-3', action: 'create-gwas-dataset' })
			console.log('\n=== Step 3: Create GWAS dataset ===')

			await page.locator('.nav-item[data-tab="data"]').click()
			await expect(page.locator('#data-view.tab-content.active')).toBeVisible({
				timeout: UI_TIMEOUT,
			})
			await page.waitForTimeout(1000)

			const datasetsToggle = page.locator('#data-view-toggle .pill-button[data-view="datasets"]')
			await expect(datasetsToggle).toBeVisible()
			await datasetsToggle.click()
			await page.waitForTimeout(500)

			const newDatasetBtn = page.locator('#new-dataset-btn')
			await expect(newDatasetBtn).toBeVisible()
			await newDatasetBtn.click()

			const datasetEditor = page.locator('#dataset-editor-section')
			await expect(datasetEditor).toBeVisible({ timeout: 5000 })

			await page.locator('#dataset-form-name').fill('gwas_dataset')
			await page.locator('#dataset-form-description').fill('GWAS dataset for PLINK map input')

			async function addAssetByFilename(fileName: string) {
				const addAssetBtn = page.locator('#dataset-add-asset')
				await expect(addAssetBtn).toBeVisible()
				await addAssetBtn.click()
				await page.waitForTimeout(300)

				const assetRows = page.locator('#dataset-assets-list .asset-row')
				const rowCount = await assetRows.count()
				const assetRow = assetRows.nth(rowCount - 1)

				// Add to private side
				const privateExistingFilesBtn = assetRow.locator('.asset-side.private .btn-existing-files')
				await expect(privateExistingFilesBtn).toBeVisible()
				await privateExistingFilesBtn.click()

				const filePickerModal = page.locator('#file-picker-modal')
				await expect(filePickerModal).toBeVisible({ timeout: 5000 })

				const searchInput = page.locator('#file-picker-search')
				await searchInput.fill(fileName)
				await page.waitForTimeout(500)

				const checkbox = filePickerModal.locator('.file-picker-checkbox').first()
				await expect(checkbox).toBeVisible()
				await checkbox.check()

				const addSelectedBtn = page.locator('#file-picker-add')
				await expect(addSelectedBtn).toBeVisible()
				await addSelectedBtn.click()
				await expect(filePickerModal).toBeHidden({ timeout: 3000 })

				// Add to mock side (use mock.* files)
				const ext = fileName.split('.').pop() || ''
				const mockFileName = `mock.${ext}`
				console.log(`Adding mock file: ${mockFileName}`)

				const mockExistingFilesBtn = assetRow.locator('.asset-side.mock .btn-existing-files')
				await expect(mockExistingFilesBtn).toBeVisible()
				await mockExistingFilesBtn.click()

				await expect(filePickerModal).toBeVisible({ timeout: 5000 })
				await searchInput.fill(mockFileName)
				await page.waitForTimeout(500)

				const mockCheckbox = filePickerModal.locator('.file-picker-checkbox').first()
				await expect(mockCheckbox).toBeVisible()
				await mockCheckbox.check()

				await expect(addSelectedBtn).toBeVisible()
				await addSelectedBtn.click()
				await expect(filePickerModal).toBeHidden({ timeout: 3000 })
			}

			for (const fileName of requiredFiles) {
				console.log(`Adding asset for ${fileName}`)
				await addAssetByFilename(fileName)
			}

			const saveDatasetBtn = page.locator('#dataset-editor-save')
			await expect(saveDatasetBtn).toBeVisible()
			await saveDatasetBtn.click()

			await expect(datasetEditor).toBeHidden({ timeout: 5000 })

			const datasetsGrid = page.locator('#datasets-grid')
			await expect(datasetsGrid).toBeVisible()
			await expect(datasetsGrid).toContainText('gwas_dataset', { timeout: 5000 })

			const datasetsFromBackend = await backend.invoke('list_datasets_with_assets', {})
			const ourDataset = datasetsFromBackend.find((d: any) => d.dataset?.name === 'gwas_dataset')
			expect(ourDataset).toBeTruthy()
			expect(ourDataset.dataset.extra?.shape).toBe(
				'Map[String, Record{bed: File, bim: File, fam: File}]',
			)

			// ============================================================
			// Step 4: Run pipeline on real data
			// ============================================================
			log(logSocket, { event: 'step-4', action: 'run-gwas-pipeline' })
			console.log('\n=== Step 4: Run GWAS pipeline ===')

			const datasetsToggle2 = page.locator('#data-view-toggle .pill-button[data-view="datasets"]')
			if (!(await datasetsToggle2.evaluate((el) => el.classList.contains('active')))) {
				await datasetsToggle2.click()
				await page.waitForTimeout(500)
			}

			const datasetCard = page
				.locator('#datasets-grid .dataset-card')
				.filter({ hasText: 'gwas_dataset' })
			await expect(datasetCard).toBeVisible()

			const runPipelineBtn = datasetCard.locator('.btn-run-pipeline')
			await expect(runPipelineBtn).toBeVisible()
			await runPipelineBtn.click()

			const runPipelineModal = page.locator('#run-pipeline-modal')
			await expect(runPipelineModal).toBeVisible({ timeout: 5000 })

			const realDataOption = runPipelineModal.locator(
				'input[name="pipeline-data-type"][value="real"]',
			)
			await realDataOption.check()

			const runPipelineConfirmBtn = runPipelineModal.locator('#run-pipeline-confirm')
			await expect(runPipelineConfirmBtn).toBeVisible()
			const runStartTime = Date.now()
			await runPipelineConfirmBtn.click()

			await expect(runPipelineModal).toBeHidden({ timeout: 5000 })
			await page.waitForTimeout(2000)

			const dataRunModal = page.locator('#data-run-modal, .data-run-modal')
			if (await dataRunModal.isVisible({ timeout: 3000 }).catch(() => false)) {
				console.log('Data run modal visible, selecting GWAS pipeline...')
				const gwasOption = dataRunModal.locator('text=gwas-population-analysis')
				if (await gwasOption.isVisible().catch(() => false)) {
					await gwasOption.click()
					await page.waitForTimeout(1000)
				}

				const runBtn = dataRunModal.locator('#data-run-run-btn')
				if (await runBtn.isVisible().catch(() => false)) {
					await page.evaluate(() => {
						setTimeout(() => {
							document.getElementById('data-run-run-btn')?.click()
						}, 0)
					})
					console.log('Triggered run button click')
				}

				const dockerWarning = page.locator('#docker-warning-modal')
				if (await dockerWarning.isVisible({ timeout: 3000 }).catch(() => false)) {
					await page.evaluate(() => {
						setTimeout(() => {
							document.getElementById('docker-run-anyway')?.click()
						}, 0)
					})
					console.log('Acknowledged docker warning')
				}
			}
			console.log('Exited run modal flow')

			await page.waitForTimeout(1000)
			if (runStarted) {
				console.log('Pipeline run started (alert received)')
			} else {
				console.log('Pipeline started alert not captured yet')
			}

			if (!pipelineId) {
				throw new Error('Pipeline ID missing after import')
			}

			let resolvedRunId = runId
			if (!resolvedRunId) {
				const runRecord = await waitForPipelineRun(backend, pipelineId, runStartTime)
				resolvedRunId = runRecord.id
				console.log(`Resolved run ID from backend: ${resolvedRunId}`)
			}
			if (!resolvedRunId) {
				throw new Error('Unable to resolve pipeline run ID')
			}

			const { status, run } = await waitForRunCompletion(
				page,
				backend,
				resolvedRunId,
				PIPELINE_RUN_TIMEOUT,
			)
			expect(status).toBe('success')

			const resultsDir = run.results_dir || run.work_dir
			if (!resultsDir) {
				throw new Error('Pipeline run missing results directory')
			}
			if (!fs.existsSync(resultsDir)) {
				throw new Error(`Results directory not found: ${resultsDir}`)
			}

			const resultFiles = collectFiles(resultsDir, 6)
			const manhattan = assertOutputFile(
				resultsDir,
				resultFiles,
				/_manhattan\.png$/i,
				'Manhattan plot',
			)
			const qqPlot = assertOutputFile(resultsDir, resultFiles, /_qq\.png$/i, 'QQ plot')
			const assoc = assertOutputFile(
				resultsDir,
				resultFiles,
				/_gwas\.assoc\.logistic$/i,
				'GWAS association results',
			)
			const summary = assertOutputFile(
				resultsDir,
				resultFiles,
				/GWAS_ANALYSIS_INFO\.txt$/i,
				'GWAS analysis summary',
			)

			console.log('Results verified:')
			console.log(`  Manhattan plot: ${path.relative(resultsDir, manhattan)}`)
			console.log(`  QQ plot: ${path.relative(resultsDir, qqPlot)}`)
			console.log(`  GWAS assoc: ${path.relative(resultsDir, assoc)}`)
			console.log(`  Summary: ${path.relative(resultsDir, summary)}`)

			console.log('\n=== GWAS TEST COMPLETED ===')
		} catch (error) {
			caughtError = error
		} finally {
			await pauseForInteractive(testInfo)
			if (process.env.INTERACTIVE_MODE === '1') {
				console.log('Press Enter to close browser (or wait 60 seconds)...')
				await Promise.race([
					new Promise((r) => setTimeout(r, 60000)),
					new Promise<void>((resolve) => {
						if (process.stdin.isTTY) {
							const readline = require('node:readline')
							const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
							rl.question('', () => {
								rl.close()
								resolve()
							})
						} else {
							setTimeout(resolve, 60000)
						}
					}),
				])
			}
			await backend.close()
			await context.close()
		}

		if (caughtError) {
			throw caughtError
		}
	})
})
