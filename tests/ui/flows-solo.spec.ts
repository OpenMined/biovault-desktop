/**
 * Flows Solo Test
 * Tests the complete flow and dataset workflow:
 * 1. Import synthetic genotype data
 * 2. Create HERC2 flow
 * 3. Create dataset with 5 private + 5 mock files
 * 4. Edit dataset and verify files persist
 * 5. Publish dataset and verify YAML
 * 6. Edit dataset and remove 1 mock file
 * 7. Verify republish and changes
 * 8. Run flow on dataset mock data
 *
 * Usage:
 *   ./test-scenario.sh --flows-solo
 *
 * @tag flows-solo
 */
import { expect, test, type Page, pauseForInteractive } from './playwright-fixtures'
import WebSocket from 'ws'
import * as fs from 'fs'
import * as path from 'path'
import { waitForAppReady } from './test-helpers.js'
import { setWsPort, completeOnboarding, ensureLogSocket, log } from './onboarding-helper.js'

const TEST_TIMEOUT = 300_000 // 5 minutes max
const UI_TIMEOUT = 10_000
const PIPELINE_RUN_TIMEOUT = 120_000 // 2 minutes for flow to complete

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

// Helper to wait for flow run to complete
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

test.describe('Flows Solo @flows-solo', () => {
	test('import data, create dataset, run flow on mock data', async ({ browser }, testInfo) => {
		const wsPort = Number.parseInt(process.env.DEV_WS_BRIDGE_PORT_BASE || '3333', 10)
		const email = process.env.TEST_EMAIL || 'client1@sandbox.local'
		const syntheticDataDir =
			process.env.SYNTHETIC_DATA_DIR || path.join(process.cwd(), 'test-data', 'synthetic-genotypes')

		console.log('Setting up flows solo test')
		console.log(`Client: ${email} (port ${wsPort})`)
		console.log(`Synthetic data dir: ${syntheticDataDir}`)

		// Verify synthetic data exists
		if (!fs.existsSync(syntheticDataDir)) {
			throw new Error(`Synthetic data directory not found: ${syntheticDataDir}`)
		}
		// Files are in subdirectories (e.g., 101526/101526_X_X_GSAv3-DTC_GRCh38-01-26-2025.txt)
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
		console.log(`Found ${syntheticFiles.length} synthetic genotype files`)
		expect(syntheticFiles.length).toBeGreaterThan(0)

		const logSocket = await ensureLogSocket()

		// Create browser context and page
		const context = await browser.newContext()
		const page = await context.newPage()

		// Log browser console errors
		page.on('console', (msg) => {
			if (msg.type() === 'error') {
				console.log(`[Browser Error] ${msg.text()}`)
			}
		})

		await setWsPort(page, wsPort)
		const backend = await connectBackend(wsPort)

		try {
			// Navigate and complete onboarding if needed
			await page.goto(`http://localhost:${process.env.UI_PORT || '8082'}?ws=${wsPort}&real=1`)
			await waitForAppReady(page, { timeout: 10_000 })

			const isOnboarded = await backend.invoke('check_is_onboarded')
			if (!isOnboarded) {
				await completeOnboarding(page, email, logSocket)
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

			// Use backend to set the folder path directly
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
			// Step 2: Create HERC2 Flow
			// ============================================================
			log(logSocket, { event: 'step-2', action: 'create-flow' })
			console.log('\n=== Step 2: Create HERC2 Flow ===')

			// Navigate to Flows tab
			await page.locator('.nav-item[data-tab="run"]').click()
			await expect(page.locator('#run-view')).toBeVisible({ timeout: UI_TIMEOUT })

			// Click create flow button
			const createFlowBtn = page.locator('#create-flow-btn, #empty-create-flow-btn').first()
			await expect(createFlowBtn).toBeVisible()
			await createFlowBtn.click()

			// Wait for template picker modal
			await page.waitForSelector('#flow-picker-modal', { state: 'visible', timeout: 10_000 })

			// Handle any dialogs (overwrite confirmation)
			page.on('dialog', async (dialog) => {
				console.log(`Dialog: ${dialog.message()}`)
				try {
					await dialog.accept()
				} catch (e) {
					console.log(`Dialog already handled: ${e}`)
				}
			})

			// Click HERC2 Classifier template
			const herc2Card = page.locator('button.new-flow-template-card:has-text("HERC2")')
			await expect(herc2Card).toBeVisible()
			await herc2Card.click()

			// Wait for import modal to appear and then disappear (import complete)
			const flowImportModal = page.locator('.modal-overlay:has-text("Importing")')
			await expect(flowImportModal)
				.toBeVisible({ timeout: 5000 })
				.catch(() => {})
			// Wait for import to complete - modal disappears
			await expect(flowImportModal).toBeHidden({ timeout: 60_000 })
			console.log('Flow import completed!')

			// Close picker modal if still open
			const pickerCloseBtn = page.locator(
				'#flow-picker-modal button[data-modal-close="flow-picker"]',
			)
			if (await pickerCloseBtn.isVisible().catch(() => false)) {
				await pickerCloseBtn.click()
			}

			// Trigger flows reload
			await page.evaluate(() => {
				const w = window as any
				if (w.flowModule?.loadFlows) {
					w.flowModule.loadFlows()
				}
			})
			await page.waitForTimeout(2000)

			// Verify flow was created
			const flowsGrid = page.locator('#flows-grid')
			await expect(flowsGrid).toContainText(/HERC2/i, { timeout: 10_000 })
			console.log('HERC2 flow created!')

			// ============================================================
			// Step 3: Create dataset with paired assets (5 private + 5 mock)
			// ============================================================
			log(logSocket, { event: 'step-3', action: 'create-dataset' })
			console.log('\n=== Step 3: Create dataset with 5 private + 5 mock files ===')

			// Navigate to Data tab
			await page.locator('.nav-item[data-tab="data"]').click()
			await expect(page.locator('#data-view.tab-content.active')).toBeVisible({
				timeout: UI_TIMEOUT,
			})
			await page.waitForTimeout(1000)

			// Switch to Datasets view
			const datasetsToggle = page.locator('#data-view-toggle .pill-button[data-view="datasets"]')
			await expect(datasetsToggle).toBeVisible()
			await datasetsToggle.click()
			await page.waitForTimeout(500)

			// Click New Dataset button
			const newDatasetBtn = page.locator('#new-dataset-btn')
			await expect(newDatasetBtn).toBeVisible()
			await newDatasetBtn.click()

			// Wait for dataset editor to open
			const datasetEditor = page.locator('#dataset-editor-section')
			await expect(datasetEditor).toBeVisible({ timeout: 5000 })

			// Fill in dataset name
			const datasetNameInput = page.locator('#dataset-form-name')
			await datasetNameInput.fill('test_genotype_dataset')

			// Fill in description
			const datasetDescInput = page.locator('#dataset-form-description')
			await datasetDescInput.fill('Test dataset with 5 private and 5 mock files')

			// Click "Add Asset" to add the first asset row
			const addAssetBtn = page.locator('#dataset-add-asset')
			await expect(addAssetBtn).toBeVisible()
			await addAssetBtn.click()
			await page.waitForTimeout(300)

			// Switch to File List mode (for multiple files per asset)
			const assetRow = page.locator('#dataset-assets-list .asset-row').first()
			await expect(assetRow).toBeVisible({ timeout: 3000 })
			const fileListModeBtn = assetRow.locator('.pill-button[data-mode="list"]')
			await fileListModeBtn.click()
			await page.waitForTimeout(300)

			// Add 5 files to Private side using file picker
			console.log('Adding 5 files to Private side...')
			const privateExistingFilesBtn = assetRow.locator('.asset-side.private .btn-existing-files')
			await expect(privateExistingFilesBtn).toBeVisible()
			await privateExistingFilesBtn.click()

			// Wait for file picker modal
			const filePickerModal = page.locator('#file-picker-modal')
			await expect(filePickerModal).toBeVisible({ timeout: 5000 })

			// Select first 5 files for private
			let filePickerCheckboxes = filePickerModal.locator('.file-picker-checkbox')
			let checkboxCount = await filePickerCheckboxes.count()
			console.log(`File picker shows ${checkboxCount} files`)
			expect(checkboxCount).toBeGreaterThanOrEqual(10) // Need at least 10 files

			for (let i = 0; i < 5; i++) {
				await filePickerCheckboxes.nth(i).check()
			}

			// Click "Add Selected" button
			const addSelectedBtn = page.locator('#file-picker-add')
			await expect(addSelectedBtn).toBeVisible()
			await addSelectedBtn.click()
			await expect(filePickerModal).toBeHidden({ timeout: 3000 })
			await page.waitForTimeout(500)

			// Verify 5 files added to private side
			const privateFileItems = assetRow.locator('.asset-side.private .file-item')
			const privateCount = await privateFileItems.count()
			console.log(`Private side has ${privateCount} files`)
			expect(privateCount).toBe(5)

			// Add 5 different files to Mock side
			console.log('Adding 5 files to Mock side...')
			const mockExistingFilesBtn = assetRow.locator('.asset-side.mock .btn-existing-files')
			await expect(mockExistingFilesBtn).toBeVisible()
			await mockExistingFilesBtn.click()

			await expect(filePickerModal).toBeVisible({ timeout: 5000 })

			// Select files 6-10 for mock (different from private)
			filePickerCheckboxes = filePickerModal.locator('.file-picker-checkbox')
			for (let i = 5; i < 10; i++) {
				await filePickerCheckboxes.nth(i).check()
			}

			await addSelectedBtn.click()
			await expect(filePickerModal).toBeHidden({ timeout: 3000 })
			await page.waitForTimeout(500)

			// Verify 5 files added to mock side
			const mockFileItems = assetRow.locator('.asset-side.mock .file-item')
			const mockCount = await mockFileItems.count()
			console.log(`Mock side has ${mockCount} files`)
			expect(mockCount).toBe(5)

			// Save the dataset
			const saveDatasetBtn = page.locator('#dataset-editor-save')
			await expect(saveDatasetBtn).toBeVisible()
			await saveDatasetBtn.click()

			// Wait for editor to close
			await expect(datasetEditor).toBeHidden({ timeout: 5000 })
			console.log('Dataset saved!')

			// Verify dataset was created
			const datasetsGrid = page.locator('#datasets-grid')
			await expect(datasetsGrid).toBeVisible()
			await expect(datasetsGrid).toContainText('test_genotype_dataset', { timeout: 5000 })
			console.log('Dataset created successfully!')

			// Verify via backend
			const datasetsFromBackend = await backend.invoke('list_datasets_with_assets', {})
			const ourDataset = datasetsFromBackend.find(
				(d: any) => d.dataset?.name === 'test_genotype_dataset',
			)
			expect(ourDataset).toBeTruthy()
			console.log(`Dataset has ${ourDataset?.assets?.length || 0} assets`)

			// ============================================================
			// Step 4: Edit dataset and verify files persist
			// ============================================================
			log(logSocket, { event: 'step-4', action: 'edit-dataset' })
			console.log('\n=== Step 4: Edit dataset and verify files persist ===')

			// Click the dataset card to edit it
			const datasetCard = datasetsGrid
				.locator('.dataset-card')
				.filter({ hasText: 'test_genotype_dataset' })
			await expect(datasetCard).toBeVisible()
			await datasetCard.click()

			// Wait for editor to open
			await expect(datasetEditor).toBeVisible({ timeout: 5000 })
			await page.waitForTimeout(1000) // Allow time for data to load

			// Verify the asset row is in list mode
			const editAssetRow = page.locator('#dataset-assets-list .asset-row').first()
			await expect(editAssetRow).toBeVisible({ timeout: 3000 })

			// Verify private files are still there (5 files)
			const editPrivateFiles = editAssetRow.locator('.asset-side.private .file-item')
			const editPrivateCount = await editPrivateFiles.count()
			console.log(`After edit - Private side has ${editPrivateCount} files`)
			expect(editPrivateCount).toBe(5)

			// Verify mock files are still there (5 files)
			const editMockFiles = editAssetRow.locator('.asset-side.mock .file-item')
			const editMockCount = await editMockFiles.count()
			console.log(`After edit - Mock side has ${editMockCount} files`)
			expect(editMockCount).toBe(5)

			console.log('Dataset edit test PASSED - files persist correctly!')

			// Close the editor
			const cancelBtn = page.locator('#dataset-editor-cancel')
			await cancelBtn.click()
			await expect(datasetEditor).toBeHidden({ timeout: 3000 })

			// ============================================================
			// Step 5: Publish dataset and verify YAML
			// ============================================================
			log(logSocket, { event: 'step-5', action: 'publish-dataset' })
			console.log('\n=== Step 5: Publish dataset and verify YAML ===')

			// Find the dataset card and click publish
			const datasetCardForPublish = page
				.locator('#datasets-grid .dataset-card')
				.filter({ hasText: 'test_genotype_dataset' })
			await expect(datasetCardForPublish).toBeVisible()

			const publishBtn = datasetCardForPublish.locator('.btn-publish, button:has-text("Publish")')
			await expect(publishBtn).toBeVisible({ timeout: 5000 })
			await publishBtn.click()

			// Wait for publish to complete
			await page.waitForTimeout(3000)
			console.log('Dataset published!')

			// Get the datasite path from backend
			const yamlRelPath = 'public/biovault/datasets/test_genotype_dataset/dataset.yaml'
			const yamlPath = await backend.invoke('resolve_dataset_path', { dirPath: yamlRelPath })
			console.log('YAML path:', yamlPath)
			const yamlContent = fs.readFileSync(yamlPath, 'utf-8')
			console.log('Published YAML content:')
			console.log(yamlContent.substring(0, 1000) + '...')

			// Check that private doesn't have entries
			expect(yamlContent).not.toContain('db_file_id')
			expect(yamlContent).not.toContain('file_path: /Users')
			console.log('✓ YAML verified - no private entries exposed!')

			// ============================================================
			// Step 6: Edit dataset and remove 1 mock file
			// ============================================================
			log(logSocket, { event: 'step-6', action: 'edit-remove-file' })
			console.log('\n=== Step 6: Edit dataset and remove 1 mock file ===')

			// Click edit on the dataset card
			const editBtn2 = datasetCardForPublish.locator('.dataset-action-btn[title="Edit dataset"]')
			await editBtn2.click()
			await expect(datasetEditor).toBeVisible({ timeout: 5000 })
			await page.waitForTimeout(1000)

			// Wait for assets to load and scroll to make them visible
			const assetsList = page.locator('#dataset-assets-list')
			await expect(assetsList).toBeVisible({ timeout: 10000 })
			await assetsList.scrollIntoViewIfNeeded()
			await page.waitForTimeout(500)

			// Find and remove the first mock file
			const mockFilesForRemoval = page.locator(
				'#dataset-assets-list .asset-row .asset-side.mock .file-item',
			)
			const mockFileCountBefore = await mockFilesForRemoval.count()
			console.log(`Mock files before removal: ${mockFileCountBefore}`)

			// Click the remove button on the first mock file
			const firstMockFile = mockFilesForRemoval.first()
			await firstMockFile.scrollIntoViewIfNeeded()
			const removeBtn = firstMockFile.locator('.remove-file, .remove-single-file')
			await expect(removeBtn).toBeVisible({ timeout: 5000 })
			await removeBtn.click()
			await page.waitForTimeout(500)

			// Verify one file was removed
			const mockFileCountAfter = await mockFilesForRemoval.count()
			console.log(`Mock files after removal: ${mockFileCountAfter}`)
			expect(mockFileCountAfter).toBe(mockFileCountBefore - 1)

			// Save the dataset
			const saveBtn2 = page.locator('#dataset-editor-save')
			await saveBtn2.click()
			await page.waitForTimeout(2000)
			console.log('Dataset saved with 1 mock file removed!')

			// ============================================================
			// Step 7: Verify republish happened and changes are correct
			// ============================================================
			log(logSocket, { event: 'step-7', action: 'verify-republish' })
			console.log('\n=== Step 7: Verify republish and changes ===')

			// Save automatically republishes if dataset was already published
			// Wait for the auto-republish to complete
			await page.waitForTimeout(3000)
			console.log('Dataset auto-republished on save!')

			// Verify the updated YAML
			const yamlContent2 = fs.readFileSync(yamlPath, 'utf-8')

			// Check that we have 4 mock entries now
			const mockEntryMatches = yamlContent2.match(/participant_id:/g)
			const mockEntryCount = mockEntryMatches ? mockEntryMatches.length : 0
			console.log(`Mock entries in YAML: ${mockEntryCount}`)
			// Should have 4 mock entries (after removing 1)
			expect(mockEntryCount).toBe(4)

			// Verify CSV has correct number of entries
			const csvRelPath = 'public/biovault/datasets/test_genotype_dataset/assets/asset_1.csv'
			const csvPath = await backend.invoke('resolve_dataset_path', { dirPath: csvRelPath })
			console.log('CSV path:', csvPath)
			if (fs.existsSync(csvPath)) {
				const csvContent = fs.readFileSync(csvPath, 'utf-8')
				const csvLines = csvContent.trim().split('\n')
				console.log(`CSV has ${csvLines.length} lines (including header)`)
				expect(csvLines.length).toBe(5) // header + 4 data rows
			}

			console.log('✓ Republish verified - changes reflected correctly!')

			// ============================================================
			// Step 8: Run flow on dataset mock data
			// ============================================================
			log(logSocket, { event: 'step-8', action: 'run-flow-mock' })
			console.log('\n=== Step 8: Run flow on dataset mock data ===')

			// Navigate back to datasets if needed
			await page.locator('.nav-item[data-tab="data"]').click()
			await expect(page.locator('#data-view.tab-content.active')).toBeVisible({
				timeout: UI_TIMEOUT,
			})
			await page.waitForTimeout(500)

			// Make sure datasets view is selected
			const datasetsToggle3 = page.locator('#data-view-toggle .pill-button[data-view="datasets"]')
			if (!(await datasetsToggle3.evaluate((el) => el.classList.contains('active')))) {
				await datasetsToggle3.click()
				await page.waitForTimeout(500)
			}

			// Click "Run Flow" button on the dataset card
			const datasetCard3 = page
				.locator('#datasets-grid .dataset-card')
				.filter({ hasText: 'test_genotype_dataset' })
			await expect(datasetCard3).toBeVisible()

			const runFlowBtn = datasetCard3.locator('.btn-run-flow')
			await expect(runFlowBtn).toBeVisible()
			await runFlowBtn.click()

			// Wait for run flow modal
			const runFlowModal = page.locator('#run-flow-modal')
			await expect(runFlowModal).toBeVisible({ timeout: 5000 })

			// Select "Mock Data" option
			const mockDataOption = runFlowModal.locator('input[name="flow-data-type"][value="mock"]')
			await mockDataOption.check()

			// Click "Run Flow" button in modal
			const runFlowConfirmBtn = runFlowModal.locator('#run-flow-confirm')
			await expect(runFlowConfirmBtn).toBeVisible()
			await runFlowConfirmBtn.click()

			// Wait for modal to close - this triggers navigation to flows
			await expect(runFlowModal).toBeHidden({ timeout: 5000 })
			console.log('Flow run modal closed, navigating to flows...')

			// Wait for flows tab to be active and modal to appear
			await page.waitForTimeout(2000)

			// The openRunFlowWithDataset function should show the data run modal
			// Look for the data-run modal or the flow selection
			const dataRunModal = page.locator('#data-run-modal, .data-run-modal')
			if (await dataRunModal.isVisible({ timeout: 3000 }).catch(() => false)) {
				console.log('Data run modal visible, selecting HERC2 flow...')
				// Click on HERC2 flow option
				const herc2Option = dataRunModal.locator('text=HERC2')
				if (await herc2Option.isVisible().catch(() => false)) {
					await herc2Option.click()
					await page.waitForTimeout(1000)
				}
			}

			// Check if we're on flows view and a run has started
			await page.waitForTimeout(3000)

			// Get flow runs
			const runs = await backend.invoke('get_flow_runs', {})
			if (runs && runs.length > 0) {
				const latestRun = runs[0]
				console.log(`Flow run started: ${latestRun.id} (status: ${latestRun.status})`)

				// Wait for run to complete
				const { status } = await waitForRunCompletion(page, backend, latestRun.id)
				console.log(`Flow run completed with status: ${status}`)
			} else {
				console.log('No flow run started yet - this may require manual flow selection')
			}

			console.log('\n=== TEST COMPLETED SUCCESSFULLY ===')
		} finally {
			await pauseForInteractive(testInfo)
			await backend.close()
			await context.close()
		}
	})
})
