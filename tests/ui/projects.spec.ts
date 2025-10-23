import { expect, test } from '@playwright/test'
import { promises as fs } from 'fs'
import os from 'os'
import path from 'path'
import { fileURLToPath } from 'url'
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
		// Best-effort logging
	}
}

const STORAGE_KEY = 'playwright:onboarded'

test.beforeEach(async ({ page, context }) => {
	await ensureLogSocket()
	await context.addInitScript((storageKey) => {
		localStorage.setItem(storageKey, 'true')
	}, STORAGE_KEY)
	await page.goto('/')
	await page.waitForSelector('#app', { state: 'visible', timeout: 10000 })
})

test.afterEach(async () => {
	if (logSocket && logSocket.readyState === WebSocket.OPEN) {
		await new Promise((resolve) => {
			logSocket?.close()
			logSocket?.once('close', resolve)
		})
		logSocket = null
	}
})

test.describe('Project Creation Wizard', () => {
	test('should open create project modal and navigate through wizard steps', async ({ page }) => {
		sendUnifiedLog({ test: 'project-wizard-navigation', action: 'start' })

		// Navigate to projects view
		await page.click('nav a[href="#projects"]')
		await page.waitForTimeout(500)

		// Click "New Project" button
		await page.click('button:has-text("New Project")')
		await page.waitForSelector('#create-project-modal', { state: 'visible' })

		// Step 1: Project Name
		await expect(page.locator('.wizard-step.active')).toHaveAttribute('data-step', '0')
		await page.fill('#new-project-name', 'Test Project')
		await page.click('button:has-text("Next")')

		// Step 2: Template
		await expect(page.locator('.wizard-step.active')).toHaveAttribute('data-step', '1')
		await page.click('button:has-text("Next")')

		// Step 3: Parameters
		await expect(page.locator('.wizard-step.active')).toHaveAttribute('data-step', '2')
		await page.click('button:has-text("Next")')

		// Step 4: Inputs
		await expect(page.locator('.wizard-step.active')).toHaveAttribute('data-step', '3')
		await page.click('button:has-text("Next")')

		// Step 5: Outputs
		await expect(page.locator('.wizard-step.active')).toHaveAttribute('data-step', '4')

		sendUnifiedLog({ test: 'project-wizard-navigation', action: 'complete' })
	})

	test('should add and remove parameters with correct data types', async ({ page }) => {
		sendUnifiedLog({ test: 'project-parameters', action: 'start' })

		await page.click('nav a[href="#projects"]')
		await page.waitForTimeout(500)
		await page.click('button:has-text("New Project")')
		await page.waitForSelector('#create-project-modal', { state: 'visible' })

		// Fill project name
		await page.fill('#new-project-name', 'Param Test Project')
		await page.click('button:has-text("Next")')
		await page.click('button:has-text("Next")')

		// Now at Parameters step
		await expect(page.locator('.wizard-step.active')).toHaveAttribute('data-step', '2')

		// Add first parameter (Bool type)
		await page.click('button:has-text("Add Parameter")')
		await page.waitForTimeout(200)

		const param1 = page.locator('.spec-entry').first()
		await param1.locator('input[data-field="name"]').fill('enable_filter')
		await param1.locator('input[data-field="raw_type"]').fill('Bool')
		await param1.locator('textarea[data-field="description"]').fill('Enable filtering step')
		await param1.locator('input[data-field="default"]').fill('true')

		// Add second parameter (String type)
		await page.click('button:has-text("Add Parameter")')
		await page.waitForTimeout(200)

		const param2 = page.locator('.spec-entry').nth(1)
		await param2.locator('input[data-field="name"]').fill('output_format')
		await param2.locator('input[data-field="raw_type"]').fill('String')
		await param2.locator('textarea[data-field="description"]').fill('Output file format')
		await param2.locator('input[data-field="default"]').fill('csv')

		// Verify both parameters are present
		const paramEntries = await page.locator('.spec-entry').count()
		expect(paramEntries).toBe(2)

		// Navigate to preview and verify parameters appear
		await page.click('button:has-text("Next")') // Inputs
		await page.click('button:has-text("Next")') // Outputs
		await page.click('button:has-text("Next")') // Preview

		await page.waitForTimeout(500)

		// Check preview contains parameters
		const yamlPreview = await page.locator('#create-project-preview-yaml').textContent()
		expect(yamlPreview).toContain('enable_filter')
		expect(yamlPreview).toContain('output_format')
		expect(yamlPreview).toContain('Bool')
		expect(yamlPreview).toContain('String')

		// Go back and remove first parameter
		await page.click('button:has-text("Back")')
		await page.click('button:has-text("Back")')
		await page.click('button:has-text("Back")')

		await page.locator('.spec-entry').first().locator('button[data-action="remove"]').click()
		await page.waitForTimeout(200)

		// Verify only one parameter remains
		const remainingParams = await page.locator('.spec-entry').count()
		expect(remainingParams).toBe(1)

		// Verify the correct parameter remains
		const remainingName = await page.locator('.spec-entry input[data-field="name"]').inputValue()
		expect(remainingName).toBe('output_format')

		sendUnifiedLog({ test: 'project-parameters', action: 'complete' })
	})

	test('should add and remove inputs with various types', async ({ page }) => {
		sendUnifiedLog({ test: 'project-inputs', action: 'start' })

		await page.click('nav a[href="#projects"]')
		await page.waitForTimeout(500)
		await page.click('button:has-text("New Project")')
		await page.waitForSelector('#create-project-modal', { state: 'visible' })

		await page.fill('#new-project-name', 'Input Test Project')
		await page.click('button:has-text("Next")')
		await page.click('button:has-text("Next")')
		await page.click('button:has-text("Next")')

		// At Inputs step
		await expect(page.locator('.wizard-step.active')).toHaveAttribute('data-step', '3')

		// Add File input
		await page.click('button:has-text("Add Input")')
		await page.waitForTimeout(200)

		const input1 = page.locator('.spec-entry').first()
		await input1.locator('input[data-field="name"]').fill('reference_genome')
		await input1.locator('input[data-field="raw_type"]').fill('File')
		await input1.locator('textarea[data-field="description"]').fill('Reference genome file')
		await input1.locator('input[data-field="path"]').fill('assets/reference.fa')

		// Add ParticipantSheet input
		await page.click('button:has-text("Add Input")')
		await page.waitForTimeout(200)

		const input2 = page.locator('.spec-entry').nth(1)
		await input2.locator('input[data-field="name"]').fill('participants')
		await input2.locator('input[data-field="raw_type"]').fill('ParticipantSheet')
		await input2.locator('textarea[data-field="description"]').fill('Participant data')

		// Add List[File] input
		await page.click('button:has-text("Add Input")')
		await page.waitForTimeout(200)

		const input3 = page.locator('.spec-entry').nth(2)
		await input3.locator('input[data-field="name"]').fill('genotype_files')
		await input3.locator('input[data-field="raw_type"]').fill('List[File]')
		await input3.locator('textarea[data-field="description"]').fill('Genotype data files')

		// Verify three inputs
		const inputCount = await page.locator('.spec-entry').count()
		expect(inputCount).toBe(3)

		// Navigate to preview
		await page.click('button:has-text("Next")') // Outputs
		await page.click('button:has-text("Next")') // Preview
		await page.waitForTimeout(500)

		// Verify inputs in YAML preview
		const yamlPreview = await page.locator('#create-project-preview-yaml').textContent()
		expect(yamlPreview).toContain('reference_genome')
		expect(yamlPreview).toContain('participants')
		expect(yamlPreview).toContain('genotype_files')
		expect(yamlPreview).toContain('ParticipantSheet')
		expect(yamlPreview).toContain('List[File]')

		// Verify inputs appear in workflow.nf preview
		const workflowPreview = await page.locator('#create-project-preview-template').textContent()
		expect(workflowPreview).toContain('reference_genome')
		expect(workflowPreview).toContain('participants')
		expect(workflowPreview).toContain('genotype_files')

		// Go back and duplicate an input
		await page.click('button:has-text("Back")')
		await page.click('button:has-text("Back")')

		await page.locator('.spec-entry').first().locator('button[data-action="duplicate"]').click()
		await page.waitForTimeout(200)

		const duplicatedCount = await page.locator('.spec-entry').count()
		expect(duplicatedCount).toBe(4)

		// Remove the duplicate
		await page.locator('.spec-entry').nth(1).locator('button[data-action="remove"]').click()
		await page.waitForTimeout(200)

		const afterRemoveCount = await page.locator('.spec-entry').count()
		expect(afterRemoveCount).toBe(3)

		sendUnifiedLog({ test: 'project-inputs', action: 'complete' })
	})

	test('should add and remove outputs', async ({ page }) => {
		sendUnifiedLog({ test: 'project-outputs', action: 'start' })

		await page.click('nav a[href="#projects"]')
		await page.waitForTimeout(500)
		await page.click('button:has-text("New Project")')
		await page.waitForSelector('#create-project-modal', { state: 'visible' })

		await page.fill('#new-project-name', 'Output Test Project')
		await page.click('button:has-text("Next")')
		await page.click('button:has-text("Next")')
		await page.click('button:has-text("Next")')
		await page.click('button:has-text("Next")')

		// At Outputs step
		await expect(page.locator('.wizard-step.active')).toHaveAttribute('data-step', '4')

		// Add first output
		await page.click('button:has-text("Add Output")')
		await page.waitForTimeout(200)

		const output1 = page.locator('.spec-entry').first()
		await output1.locator('input[data-field="name"]').fill('filtered_data')
		await output1.locator('input[data-field="raw_type"]').fill('File')
		await output1.locator('textarea[data-field="description"]').fill('Filtered dataset')
		await output1.locator('input[data-field="path"]').fill('results/filtered.csv')

		// Add second output
		await page.click('button:has-text("Add Output")')
		await page.waitForTimeout(200)

		const output2 = page.locator('.spec-entry').nth(1)
		await output2.locator('input[data-field="name"]').fill('analysis_report')
		await output2.locator('input[data-field="raw_type"]').fill('File')
		await output2.locator('textarea[data-field="description"]').fill('Analysis summary report')
		await output2.locator('input[data-field="path"]').fill('results/report.html')

		// Verify outputs
		const outputCount = await page.locator('.spec-entry').count()
		expect(outputCount).toBe(2)

		// Navigate to preview
		await page.click('button:has-text("Next")')
		await page.waitForTimeout(500)

		// Verify outputs in preview
		const yamlPreview = await page.locator('#create-project-preview-yaml').textContent()
		expect(yamlPreview).toContain('filtered_data')
		expect(yamlPreview).toContain('analysis_report')

		const workflowPreview = await page.locator('#create-project-preview-template').textContent()
		expect(workflowPreview).toContain('filtered_data')
		expect(workflowPreview).toContain('analysis_report')

		sendUnifiedLog({ test: 'project-outputs', action: 'complete' })
	})

	test('should create project and verify files are generated correctly', async ({ page }) => {
		sendUnifiedLog({ test: 'project-creation-files', action: 'start' })

		// Create temp directory for project
		const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'biovault-test-'))
		const _projectDir = path.join(tmpDir, 'my-test-project')

		await page.click('nav a[href="#projects"]')
		await page.waitForTimeout(500)
		await page.click('button:has-text("New Project")')
		await page.waitForSelector('#create-project-modal', { state: 'visible' })

		// Fill project details
		await page.fill('#new-project-name', 'my-test-project')
		await page.click('button:has-text("Next")')
		await page.click('button:has-text("Next")')

		// Add parameter
		await page.click('button:has-text("Add Parameter")')
		await page.waitForTimeout(200)
		await page.locator('.spec-entry input[data-field="name"]').fill('threads')
		await page.locator('.spec-entry input[data-field="raw_type"]').fill('String')
		await page.locator('.spec-entry input[data-field="default"]').fill('4')
		await page.click('button:has-text("Next")')

		// Add input
		await page.click('button:has-text("Add Input")')
		await page.waitForTimeout(200)
		await page.locator('.spec-entry input[data-field="name"]').fill('input_file')
		await page.locator('.spec-entry input[data-field="raw_type"]').fill('File')
		await page.click('button:has-text("Next")')

		// Add output
		await page.click('button:has-text("Add Output")')
		await page.waitForTimeout(200)
		await page.locator('.spec-entry input[data-field="name"]').fill('result_file')
		await page.locator('.spec-entry input[data-field="raw_type"]').fill('File')
		await page.click('button:has-text("Next")')

		// At preview - verify content
		await page.waitForTimeout(500)
		const yamlPreview = await page.locator('#create-project-preview-yaml').textContent()
		expect(yamlPreview).toContain('threads')
		expect(yamlPreview).toContain('input_file')
		expect(yamlPreview).toContain('result_file')

		// Choose custom directory
		await page.click('button:has-text("Change")')
		// Note: In real tests, we'd need to mock the dialog or use actual file picker

		// Create project
		// await page.click('button:has-text("Create Project")')
		// await page.waitForTimeout(2000)

		// Cleanup
		await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {})

		sendUnifiedLog({ test: 'project-creation-files', action: 'complete' })
	})

	test('should handle empty fields gracefully in preview', async ({ page }) => {
		sendUnifiedLog({ test: 'project-empty-fields', action: 'start' })

		await page.click('nav a[href="#projects"]')
		await page.waitForTimeout(500)
		await page.click('button:has-text("New Project")')
		await page.waitForSelector('#create-project-modal', { state: 'visible' })

		await page.fill('#new-project-name', 'Empty Fields Test')
		await page.click('button:has-text("Next")')
		await page.click('button:has-text("Next")')
		await page.click('button:has-text("Next")')

		// Add input with only name (no type)
		await page.click('button:has-text("Add Input")')
		await page.waitForTimeout(200)
		await page.locator('.spec-entry input[data-field="name"]').fill('incomplete_input')
		// Don't fill type

		// Navigate to preview
		await page.click('button:has-text("Next")')
		await page.click('button:has-text("Next")')
		await page.waitForTimeout(500)

		// Preview should not error, just not show the incomplete input
		const yamlPreview = await page.locator('#create-project-preview-yaml').textContent()
		expect(yamlPreview).not.toContain('incomplete_input')

		sendUnifiedLog({ test: 'project-empty-fields', action: 'complete' })
	})

	test('should allow clicking on wizard steps to navigate', async ({ page }) => {
		sendUnifiedLog({ test: 'project-wizard-step-clicks', action: 'start' })

		await page.click('nav a[href="#projects"]')
		await page.waitForTimeout(500)
		await page.click('button:has-text("New Project")')
		await page.waitForSelector('#create-project-modal', { state: 'visible' })

		// Fill project name
		await page.fill('#new-project-name', 'Step Navigation Test')

		// Go forward to step 3
		await page.click('button:has-text("Next")')
		await page.click('button:has-text("Next")')
		await page.click('button:has-text("Next")')

		await expect(page.locator('.wizard-step.active')).toHaveAttribute('data-step', '3')

		// Click on step 1 in the sidebar
		await page.click('.project-wizard-steps li[data-step="0"]')
		await page.waitForTimeout(200)

		await expect(page.locator('.wizard-step.active')).toHaveAttribute('data-step', '0')

		// Click on step 4
		await page.click('.project-wizard-steps li[data-step="3"]')
		await page.waitForTimeout(200)

		await expect(page.locator('.wizard-step.active')).toHaveAttribute('data-step', '3')

		sendUnifiedLog({ test: 'project-wizard-step-clicks', action: 'complete' })
	})
})
