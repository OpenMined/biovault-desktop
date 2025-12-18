/**
 * Pipelines Solo Test
 * Tests the complete pipeline workflow:
 * 1. Import synthetic genotype data
 * 2. Create Thalassemia pipeline
 * 3. Select all data and run pipeline
 * 4. Wait for run to complete with success
 * 5. Verify results in SQL Query tab
 *
 * Usage:
 *   ./test-scenario.sh --pipelines-solo
 *
 * @tag pipelines-solo
 */
import { expect, test, type Page } from '@playwright/test'
import WebSocket from 'ws'
import * as fs from 'fs'
import * as path from 'path'
import { waitForAppReady } from './test-helpers.js'
import { setWsPort, completeOnboarding, ensureLogSocket, log } from './onboarding-helper.js'

const TEST_TIMEOUT = 300_000 // 5 minutes max
const UI_TIMEOUT = 10_000
const PIPELINE_RUN_TIMEOUT = 120_000 // 2 minutes for pipeline to complete

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

// Helper to wait for pipeline run to complete
async function waitForRunCompletion(
	page: Page,
	backend: Backend,
	runId: number,
	timeoutMs: number = PIPELINE_RUN_TIMEOUT,
): Promise<{ status: string; run: any }> {
	const startTime = Date.now()
	let lastStatus = ''

	while (Date.now() - startTime < timeoutMs) {
		try {
			const runs = await backend.invoke('get_pipeline_runs', {})
			const run = runs?.find((r: any) => r.id === runId)

			if (run) {
				lastStatus = run.status
				console.log(`Run ${runId} status: ${run.status}`)

				if (run.status === 'success' || run.status === 'completed') {
					return { status: 'success', run }
				}
				if (run.status === 'failed' || run.status === 'error') {
					throw new Error(`Pipeline run failed: ${JSON.stringify(run)}`)
				}
			}
		} catch (err) {
			if ((err as Error).message?.includes('Pipeline run failed')) {
				throw err
			}
			console.log(`Error checking run status: ${err}`)
		}

		await page.waitForTimeout(2000)
	}

	throw new Error(`Pipeline run timed out after ${timeoutMs}ms. Last status: ${lastStatus}`)
}

test.describe('Pipelines Solo @pipelines-solo', () => {
	test('import data, create Thalassemia pipeline, run and verify results', async ({ browser }) => {
		const wsPort = Number.parseInt(process.env.DEV_WS_BRIDGE_PORT_BASE || '3333', 10)
		const email = process.env.CLIENT1_EMAIL || 'client1@sandbox.local'
		const syntheticDataDir = process.env.SYNTHETIC_DATA_DIR || ''

		console.log(`Setting up pipelines solo test`)
		console.log(`Client: ${email} (port ${wsPort})`)
		console.log(`Synthetic data dir: ${syntheticDataDir}`)

		if (!syntheticDataDir || !fs.existsSync(syntheticDataDir)) {
			throw new Error(`SYNTHETIC_DATA_DIR not set or directory does not exist: ${syntheticDataDir}`)
		}

		// Count synthetic files
		const syntheticFiles = fs
			.readdirSync(syntheticDataDir, { withFileTypes: true })
			.filter((d) => d.isDirectory())
			.flatMap((d) => {
				const subDir = path.join(syntheticDataDir, d.name)
				return fs.readdirSync(subDir).filter((f) => f.endsWith('.txt'))
			})
		console.log(`Found ${syntheticFiles.length} synthetic genotype files`)

		const logSocket = await ensureLogSocket()
		const context = await browser.newContext()
		const page = await context.newPage()

		// Monitor console for errors
		page.on('console', (msg) => {
			if (msg.type() === 'error') {
				console.log(`[Browser Error] ${msg.text()}`)
			}
		})

		await setWsPort(page, wsPort)
		const backend = await connectBackend(wsPort)

		const baseUrl = process.env.UI_BASE_URL || 'http://localhost:8082'
		await page.goto(baseUrl)

		// Check if onboarding is needed
		const isOnboarded = await backend.invoke('check_is_onboarded')
		if (!isOnboarded) {
			log(logSocket, { event: 'onboarding-required' })
			await completeOnboarding(page, email, logSocket)
		} else {
			await waitForAppReady(page, { timeout: 10_000 })
		}

		// ============================================================
		// Step 1: Import synthetic data
		// ============================================================
		log(logSocket, { event: 'step-1', action: 'import-data' })
		console.log('\n=== Step 1: Import synthetic data ===')

		// Navigate to Data tab
		await page.locator('.nav-item[data-tab="data"]').click()
		await expect(page.locator('#data-view.tab-content.active')).toBeVisible({
			timeout: UI_TIMEOUT,
		})

		// Click import button
		const importBtn = page.locator('#open-import-modal-btn')
		await expect(importBtn).toBeVisible()
		await importBtn.click()

		// Wait for import modal
		const importModal = page.locator('#import-modal')
		await expect(importModal).not.toHaveAttribute('hidden')

		// Use backend to set the folder path directly (simulates folder selection)
		// The UI needs the folder path injected since we can't use native file dialogs
		await page.evaluate((folderPath) => {
			const w = window as any
			w.__TEST_SELECT_FOLDER__ = () => folderPath
		}, syntheticDataDir)

		// Click folder dropzone
		const folderDropzone = page.locator('#folder-dropzone')
		await expect(folderDropzone).toBeVisible()
		await folderDropzone.click()

		// Wait for file types section
		await page.waitForTimeout(1000)
		const fileTypeSection = page.locator('#file-types-section')
		await expect(fileTypeSection).toBeVisible({ timeout: 10_000 })

		// Select .txt files
		const txtCheckbox = page.locator('.file-type-checkbox input[value=".txt"]')
		if ((await txtCheckbox.count()) > 0) {
			await txtCheckbox.check()
		}

		// Wait for files to load
		await page.waitForTimeout(2000)

		// Wait for pattern suggestions
		const patternSection = page.locator('#pattern-detection-section')
		if (await patternSection.isVisible().catch(() => false)) {
			const patternSuggestions = page.locator('.pattern-suggestion')
			if ((await patternSuggestions.count()) > 0) {
				await patternSuggestions.first().click()
			}
		}

		// Select all files
		const selectAllFiles = page.locator('#select-all-files')
		if ((await selectAllFiles.count()) > 0) {
			await selectAllFiles.check()
		}

		// Click Continue to review
		const continueBtn = page.locator('#import-continue-btn')
		await expect(continueBtn).toBeEnabled({ timeout: 10_000 })
		await continueBtn.click()

		// Wait for review view
		const reviewView = page.locator('#import-modal-review')
		await expect(reviewView).toBeVisible({ timeout: 10_000 })

		// Wait for file type detection
		const detectionProgress = page.locator('#detection-progress')
		if (await detectionProgress.isVisible().catch(() => false)) {
			await expect(detectionProgress).toBeHidden({ timeout: 30_000 })
		}

		// Click Import button
		const reviewImportBtn = page.locator('#review-import-btn')
		await expect(reviewImportBtn).toBeVisible()
		await reviewImportBtn.click()

		// Wait for modal to close
		await expect(importModal).toHaveAttribute('hidden', '', { timeout: 30_000 })

		// Verify files are imported
		await page.waitForTimeout(2000)
		const dataTable = page.locator('#files-table-body tr, .file-row')
		const importedCount = await dataTable.count()
		console.log(`Imported ${importedCount} files`)
		expect(importedCount).toBeGreaterThan(0)

		// ============================================================
		// Step 2: Create Thalassemia Pipeline
		// ============================================================
		log(logSocket, { event: 'step-2', action: 'create-pipeline' })
		console.log('\n=== Step 2: Create Thalassemia Pipeline ===')

		// Navigate to Pipelines tab
		await page.locator('.nav-item[data-tab="run"]').click()
		await expect(page.locator('#run-view')).toBeVisible({ timeout: UI_TIMEOUT })

		// Click create pipeline button
		const createPipelineBtn = page
			.locator('#create-pipeline-btn, #empty-create-pipeline-btn')
			.first()
		await expect(createPipelineBtn).toBeVisible()
		await createPipelineBtn.click()

		// Wait for template picker modal
		await page.waitForSelector('#pipeline-picker-modal', { state: 'visible', timeout: 10_000 })

		// Handle any dialogs (overwrite confirmation)
		page.on('dialog', async (dialog) => {
			console.log(`Dialog: ${dialog.message()}`)
			try {
				await dialog.accept()
			} catch (e) {
				// Dialog may already be handled
				console.log(`Dialog already handled: ${e}`)
			}
		})

		// Click Thalassemia Classifier template
		const thalassemiaCard = page.locator(
			'button.new-pipeline-template-card:has-text("Thalassemia")',
		)
		await expect(thalassemiaCard).toBeVisible()
		await thalassemiaCard.click()

		// Wait for pipeline import to complete
		await page.waitForTimeout(5000)

		// Close picker modal if still open
		const pickerCloseBtn = page.locator(
			'#pipeline-picker-modal button[data-modal-close="pipeline-picker"]',
		)
		if (await pickerCloseBtn.isVisible().catch(() => false)) {
			await pickerCloseBtn.click()
		}

		// Trigger pipelines reload
		await page.evaluate(() => {
			const w = window as any
			if (w.pipelineModule?.loadPipelines) {
				w.pipelineModule.loadPipelines()
			}
		})
		await page.waitForTimeout(2000)

		// Verify pipeline was created
		const pipelinesGrid = page.locator('#pipelines-grid')
		await expect(pipelinesGrid).toContainText(/thalassemia/i, { timeout: 10_000 })
		console.log('Thalassemia pipeline created!')

		// ============================================================
		// Step 3: Select all data and run pipeline
		// ============================================================
		log(logSocket, { event: 'step-3', action: 'run-pipeline' })
		console.log('\n=== Step 3: Select all data and run pipeline ===')

		// Navigate to Data tab
		await page.locator('.nav-item[data-tab="data"]').click()
		await expect(page.locator('#data-view.tab-content.active')).toBeVisible({
			timeout: UI_TIMEOUT,
		})
		await page.waitForTimeout(1000)

		// Select all files
		const selectAllDataFiles = page.locator('#select-all-data-files')
		await expect(selectAllDataFiles).toBeVisible()
		await selectAllDataFiles.check()
		await page.waitForTimeout(500)

		// Click Run Pipeline button
		const runAnalysisBtn = page.locator('#run-analysis-btn')
		await expect(runAnalysisBtn).toBeVisible()
		await expect(runAnalysisBtn).toBeEnabled()
		await runAnalysisBtn.click()

		// Wait for run modal
		const dataRunModal = page.locator('#data-run-modal')
		await expect(dataRunModal).toBeVisible({ timeout: 5000 })

		// Select Thalassemia pipeline
		const thalassemiaOption = dataRunModal.locator('label').filter({ hasText: /thalassemia/i })
		if ((await thalassemiaOption.count()) > 0) {
			await thalassemiaOption.click()
		} else {
			// Fallback: select first pipeline
			const pipelineRadios = dataRunModal.locator('input[type="radio"][name="data-run-pipeline"]')
			if ((await pipelineRadios.count()) > 0) {
				await pipelineRadios.first().check()
			}
		}

		await page.waitForTimeout(500)

		// Click Run button in modal
		const modalRunBtn = dataRunModal.locator('#data-run-run-btn')
		await expect(modalRunBtn).toBeVisible()
		await expect(modalRunBtn).toBeEnabled()
		await modalRunBtn.click()

		// Handle Docker warning modal if Docker is not available (common in CI)
		// Wait a bit for either the modal to close (Docker available) or warning to appear (no Docker)
		const dockerWarningModal = page.locator('#docker-warning-modal')
		try {
			await dockerWarningModal.waitFor({ state: 'visible', timeout: 3000 })
			console.log('Docker warning modal appeared, clicking "Run anyway"...')
			const runAnywayBtn = dockerWarningModal.locator('#docker-run-anyway')
			await runAnywayBtn.click()
		} catch {
			// Docker warning didn't appear - Docker is running, modal should close automatically
			console.log('Docker is available, proceeding...')
		}

		// Wait for modal to close
		await expect(dataRunModal).toBeHidden({ timeout: 30_000 })
		console.log('Pipeline run started!')

		// ============================================================
		// Step 4: Navigate to Runs tab and wait for completion
		// ============================================================
		log(logSocket, { event: 'step-4', action: 'wait-for-completion' })
		console.log('\n=== Step 4: Wait for pipeline run to complete ===')

		// Navigate to Runs tab
		await page.locator('.nav-item[data-tab="runs"]').click()
		await expect(page.locator('#runs-view')).toBeVisible({ timeout: UI_TIMEOUT })

		// Wait for run to appear
		await page.waitForTimeout(2000)

		// Get the latest run from backend
		let latestRun: any = null
		const runs = await backend.invoke('get_pipeline_runs', {})
		if (runs && runs.length > 0) {
			latestRun = runs[0]
			console.log(`Found run: ${latestRun.id} (status: ${latestRun.status})`)
		}

		if (!latestRun) {
			throw new Error('No pipeline runs found')
		}

		// Wait for run to complete
		const { status, run } = await waitForRunCompletion(page, backend, latestRun.id)
		console.log(`Pipeline run completed with status: ${status}`)
		expect(status).toBe('success')

		// Verify success in UI
		const runCards = page.locator('.pipeline-run-card')
		await expect(runCards.first()).toBeVisible()
		await expect(runCards.first()).toContainText(/thalassemia/i)

		// Refresh the UI to see updated status
		await page.reload()
		await waitForAppReady(page, { timeout: 10_000 })
		await page.locator('.nav-item[data-tab="runs"]').click()
		await page.waitForTimeout(2000)

		// Check for success indicator
		const successIndicator = page.locator('.pipeline-run-card .run-status-icon')
		await expect(successIndicator.first()).toBeVisible()

		// ============================================================
		// Step 5: Verify results in SQL Query tab
		// ============================================================
		log(logSocket, { event: 'step-5', action: 'verify-results' })
		console.log('\n=== Step 5: Verify results in SQL Query tab ===')

		// Navigate to SQL tab
		await page.locator('.nav-item[data-tab="sql"]').click()
		await expect(page.locator('#sql-view')).toBeVisible({ timeout: UI_TIMEOUT })

		// Refresh tables
		const refreshTablesBtn = page.locator('#sql-refresh-tables-btn')
		if (await refreshTablesBtn.isVisible().catch(() => false)) {
			await refreshTablesBtn.click()
			await page.waitForTimeout(2000)
		}

		// Look for thalassemia results table in the tables list
		const tablesList = page.locator('#sql-table-list')
		await expect(tablesList).toBeVisible()

		// Wait for tables to load and check for results table
		await page.waitForTimeout(3000)
		const tablesListItems = page.locator('#sql-table-list li')
		const tableCount = await tablesListItems.count()
		console.log(`Found ${tableCount} tables in SQL view`)

		// Look for thalassemia results table
		const thalassemiaResultsTable = page.locator('#sql-table-list li:has-text("thalassemia")')
		const thalassemiaTableCount = await thalassemiaResultsTable.count()
		console.log(`Found ${thalassemiaTableCount} Thalassemia results table(s)`)

		// The test MUST find thalassemia results to verify the pipeline works
		expect(thalassemiaTableCount).toBeGreaterThan(0)
		console.log('✓ Found Thalassemia results table')

		// Click on the results table to select it - this auto-fills a SELECT query
		await thalassemiaResultsTable.first().click()
		await page.waitForTimeout(1000)

		// Click run button to execute the auto-filled query
		const runQueryBtn = page.locator('#sql-run-btn')
		await expect(runQueryBtn).toBeVisible()
		await runQueryBtn.click()
		await page.waitForTimeout(2000)

		// Check for results - this verifies that the overlay_variants.json
		// contains variants that match the synthetic genotype data
		const resultsTable = page.locator('#sql-result-table')
		await expect(resultsTable).toBeVisible({ timeout: 5000 })

		const resultRows = resultsTable.locator('tbody tr')
		const rowCount = await resultRows.count()
		console.log(`Query returned ${rowCount} variant match rows`)

		// CRITICAL: Verify that variant matches were found
		// This confirms the thalassemia RSIDs in overlay_variants.json
		// are being properly detected in the synthetic data
		expect(rowCount).toBeGreaterThan(0)
		console.log('✓ Verified variant matches found in thalassemia results')

		// ============================================================
		// Step 6: Verify Nextflow used bundled Java in logs
		// ============================================================
		log(logSocket, { event: 'step-6', action: 'verify-logs' })
		console.log('\n=== Step 6: Verify Nextflow used bundled Java in logs ===')

		// Get desktop log to verify Java/Nextflow paths
		try {
			const logText = await backend.invoke('get_desktop_log_text', {})
			if (logText) {
				// Check that bundled java is being used
				const bundledJavaPattern = /bundled\/java.*\/bin\/java/
				const hasBundledJava = bundledJavaPattern.test(logText)

				// Check that Nextflow started successfully
				const nextflowStartPattern = /N E X T F L O W.*version/
				const hasNextflowStart = nextflowStartPattern.test(logText)

				// Check for augmented PATH containing bundled paths
				const augmentedPathPattern = /Final augmented PATH.*bundled/
				const hasAugmentedPath = augmentedPathPattern.test(logText)

				console.log(`Log contains bundled Java path: ${hasBundledJava}`)
				console.log(`Log contains Nextflow start: ${hasNextflowStart}`)
				console.log(`Log contains augmented PATH: ${hasAugmentedPath}`)

				// These should all be true for a successful pipeline run
				if (hasNextflowStart) {
					console.log('✓ Nextflow started successfully')
				}

				if (hasBundledJava) {
					console.log('✓ Using bundled Java')
				}

				// Check that external JAVA_HOME was NOT used (we set it to something bad in the test)
				const externalJavaUsed = /JAVA_HOME.*\/bad-java/.test(logText)
				if (externalJavaUsed) {
					console.log('⚠ Warning: External JAVA_HOME was referenced in logs')
				} else {
					console.log('✓ External JAVA_HOME was correctly overridden')
				}

				// Extract and log key pipeline info
				const pipelineLogLines = logText
					.split('\n')
					.filter(
						(line: string) =>
							line.includes('[Pipeline]') || line.includes('nextflow') || line.includes('java'),
					)
					.slice(0, 20)
				if (pipelineLogLines.length > 0) {
					console.log('\nPipeline log excerpt:')
					pipelineLogLines.forEach((line: string) => console.log(`  ${line}`))
				}
			}
		} catch (err) {
			console.log(`Warning: Could not read desktop log: ${err}`)
		}

		// ============================================================
		// Cleanup
		// ============================================================
		console.log('\n=== Test Complete ===')
		log(logSocket, { event: 'test-complete' })

		await backend.close()
		await context.close()
		if (logSocket) {
			logSocket.close()
		}
	})
})
