import { expect, test } from '@playwright/test'
import WebSocket from 'ws'

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
		window.sessionStorage.setItem(storageKey, 'true')

		// Mock Tauri invoke commands for tests
		window.__TEST_INVOKE_OVERRIDE__ = async (cmd, args) => {
			switch (cmd) {
				case 'get_projects':
					return []
				case 'get_participants':
					return []
				case 'get_files':
					return []
				case 'get_runs':
					return []
				case 'get_command_logs':
					return []
				case 'get_settings':
					return {
						docker_path: '/usr/local/bin/docker',
						java_path: '/usr/bin/java',
						syftbox_path: '/usr/local/bin/syftbox',
						biovault_path: 'bv',
						email: 'test@example.com',
						ai_api_url: '',
						ai_api_token: '',
						ai_model: '',
					}
				case 'check_dependencies':
					return { installed: [], missing: [], errors: [] }
				case 'check_is_onboarded':
					return true
				case 'get_default_project_path':
					return '/tmp/biovault-projects'
				case 'preview_project_spec': {
					// Generate YAML from the spec data passed in args
					const spec = args.spec || {}
					const params = (spec.parameters || [])
						.map((p) => `  - name: ${p.name}\n    type: ${p.raw_type}`)
						.join('\n')
					const inputs = (spec.inputs || [])
						.map((i) => `  - name: ${i.name}\n    type: ${i.raw_type}`)
						.join('\n')
					const outputs = (spec.outputs || [])
						.map((o) => `  - name: ${o.name}\n    type: ${o.raw_type}`)
						.join('\n')

					let yaml = `name: ${args.name || 'test'}\nauthor: ${args.author || 'test@example.com'}\nworkflow: ${args.workflow || 'workflow.nf'}\ntemplate: ${args.template || 'dynamic-nextflow'}`

					if (spec.inputs && spec.inputs.length > 0) {
						yaml += `\ninputs:\n${inputs}`
					} else {
						yaml += '\ninputs: []'
					}

					if (spec.outputs && spec.outputs.length > 0) {
						yaml += `\noutputs:\n${outputs}`
					} else {
						yaml += '\noutputs: []'
					}

					if (spec.parameters && spec.parameters.length > 0) {
						yaml += `\nparameters:\n${params}`
					} else {
						yaml += '\nparameters: []'
					}

					return {
						yaml,
						workflow: 'workflow {\n  // Generated workflow stub\n}',
						template: 'workflow {\n  // Template\n}',
					}
				}
				case 'create_project':
					return {
						id: 1,
						name: args.name || 'test-project',
						author: 'test@example.com',
						workflow: 'workflow.nf',
						template: 'dynamic-nextflow',
						project_path: '/tmp/test-project',
						created_at: new Date().toISOString(),
					}
				case 'load_project_editor':
					return {
						project_path: '/tmp/test-project',
						metadata: {
							name: 'test-project',
							author: 'test@example.com',
							workflow: 'workflow.nf',
							template: 'dynamic-nextflow',
							assets: [],
							parameters: [],
							inputs: [],
							outputs: [],
						},
						tree: [],
						digest: 'abc123',
					}
				default:
					console.warn('[Test] Unhandled invoke:', cmd, args)
					return null
			}
		}
	}, STORAGE_KEY)
	await page.goto('/')

	// Wait for main JS to load and execute
	await page.waitForLoadState('networkidle')
	await page.waitForSelector('.sidebar-nav', { state: 'visible', timeout: 10000 })
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
		await page.click('.nav-item[data-tab="projects"]')
		await page.waitForTimeout(500)

		// Click "New Project" button
		await page.click('button:has-text("New Project")')
		await page.waitForSelector('#create-project-modal', { state: 'visible' })

		// Step 1: Project Details
		await expect(page.locator('.project-wizard-step.active')).toHaveAttribute('data-step', '0')
		await page.fill('#new-project-name', 'Test Project')
		await page.locator('#create-project-modal footer button:has-text("Next")').click()

		// Step 2: Inputs
		await expect(page.locator('.project-wizard-step.active')).toHaveAttribute('data-step', '1')
		await page.locator('#create-project-modal footer button:has-text("Next")').click()

		// Step 3: Parameters
		await expect(page.locator('.project-wizard-step.active')).toHaveAttribute('data-step', '2')
		await page.locator('#create-project-modal footer button:has-text("Next")').click()

		// Step 4: Outputs
		await expect(page.locator('.project-wizard-step.active')).toHaveAttribute('data-step', '3')
		await page.locator('#create-project-modal footer button:has-text("Next")').click()

		// Step 5: Preview
		await expect(page.locator('.project-wizard-step.active')).toHaveAttribute('data-step', '4')

		sendUnifiedLog({ test: 'project-wizard-navigation', action: 'complete' })
	})

	test('should add and remove parameters with correct data types', async ({ page }) => {
		sendUnifiedLog({ test: 'project-parameters', action: 'start' })

		await page.click('.nav-item[data-tab="projects"]')
		await page.waitForTimeout(500)
		await page.click('button:has-text("New Project")')
		await page.waitForSelector('#create-project-modal', { state: 'visible' })

		// Fill project name
		await page.fill('#new-project-name', 'Param Test Project')
		await page.locator('#create-project-modal footer button:has-text("Next")').click()
		await page.locator('#create-project-modal footer button:has-text("Next")').click()

		// Now at Parameters step
		await expect(page.locator('.project-wizard-step.active')).toHaveAttribute('data-step', '2')

		// Add first parameter (Bool type)
		await page.click('button:has-text("Add Parameter")')
		await page.waitForTimeout(300)

		const param1 = page.locator('.spec-entry').first()
		await param1.locator('input[data-field="name"]').pressSequentially('enable_filter')
		await param1.locator('input[data-field="raw_type"]').pressSequentially('Bool')
		await param1
			.locator('textarea[data-field="description"]')
			.pressSequentially('Enable filtering step')
		await param1.locator('input[data-field="default"]').pressSequentially('true')
		await page.waitForTimeout(300)

		// Add second parameter (String type)
		await page.click('button:has-text("Add Parameter")')
		await page.waitForTimeout(300)

		const param2 = page.locator('.spec-entry').nth(1)
		await param2.locator('input[data-field="name"]').pressSequentially('output_format')
		await param2.locator('input[data-field="raw_type"]').pressSequentially('String')
		await param2
			.locator('textarea[data-field="description"]')
			.pressSequentially('Output file format')
		await param2.locator('input[data-field="default"]').pressSequentially('csv')
		await page.waitForTimeout(500)

		// Verify both parameters are present
		const paramEntries = await page.locator('.spec-entry').count()
		expect(paramEntries).toBe(2)

		// Navigate to preview
		await page.locator('#create-project-modal footer button:has-text("Next")').click() // Outputs
		await page.locator('#create-project-modal footer button:has-text("Next")').click() // Preview

		await page.waitForTimeout(500)

		// Verify preview step is visible
		await expect(page.locator('.project-wizard-step.active')).toHaveAttribute('data-step', '4')
		await expect(page.locator('#create-project-preview-yaml')).toBeVisible()

		// Go back and test removal
		await page.locator('#create-project-modal footer button:has-text("Back")').click()
		await page.locator('#create-project-modal footer button:has-text("Back")').click()

		// Remove first parameter
		await page.locator('.spec-entry').first().locator('button[data-action="remove"]').click()
		await page.waitForTimeout(200)

		// Verify only one parameter remains
		const remainingParams = await page.locator('.spec-entry').count()
		expect(remainingParams).toBe(1)

		sendUnifiedLog({ test: 'project-parameters', action: 'complete' })
	})

	test('should add inputs and outputs', async ({ page }) => {
		sendUnifiedLog({ test: 'project-inputs-outputs', action: 'start' })

		await page.click('.nav-item[data-tab="projects"]')
		await page.waitForTimeout(500)
		await page.click('button:has-text("New Project")')
		await page.waitForSelector('#create-project-modal', { state: 'visible' })

		await page.fill('#new-project-name', 'IO Test Project')
		await page.locator('#create-project-modal footer button:has-text("Next")').click()

		// At Inputs step
		await expect(page.locator('.project-wizard-step.active')).toHaveAttribute('data-step', '1')

		// Add File input
		await page.click('button:has-text("Add Input")')
		await page.waitForTimeout(300)

		const input1 = page.locator('.spec-entry').first()
		await input1.locator('input[data-field="name"]').pressSequentially('reference_genome')
		await input1.locator('input[data-field="raw_type"]').pressSequentially('File')
		await input1
			.locator('textarea[data-field="description"]')
			.pressSequentially('Reference genome file')
		await page.waitForTimeout(300)

		// Move to parameters
		await page.locator('#create-project-modal footer button:has-text("Next")').click()

		// Move to outputs
		await page.locator('#create-project-modal footer button:has-text("Next")').click()

		// Add output
		await page.click('button:has-text("Add Output")')
		await page.waitForTimeout(300)

		const output1 = page.locator('.spec-entry').first()
		await output1.locator('input[data-field="name"]').pressSequentially('filtered_data')
		await output1.locator('input[data-field="raw_type"]').pressSequentially('File')
		await output1
			.locator('textarea[data-field="description"]')
			.pressSequentially('Filtered dataset')
		await page.waitForTimeout(300)

		// Navigate to preview
		await page.locator('#create-project-modal footer button:has-text("Next")').click()
		await page.waitForTimeout(500)

		// Verify preview step is visible
		await expect(page.locator('.project-wizard-step.active')).toHaveAttribute('data-step', '4')
		await expect(page.locator('#create-project-preview-yaml')).toBeVisible()

		sendUnifiedLog({ test: 'project-inputs-outputs', action: 'complete' })
	})

	test('should handle empty fields gracefully in preview', async ({ page }) => {
		sendUnifiedLog({ test: 'project-empty-fields', action: 'start' })

		await page.click('.nav-item[data-tab="projects"]')
		await page.waitForTimeout(500)
		await page.click('button:has-text("New Project")')
		await page.waitForSelector('#create-project-modal', { state: 'visible' })

		await page.fill('#new-project-name', 'Empty Fields Test')
		await page.locator('#create-project-modal footer button:has-text("Next")').click()

		// Add input with only name (no type)
		await page.click('button:has-text("Add Input")')
		await page.waitForTimeout(200)
		await page.locator('.spec-entry input[data-field="name"]').fill('incomplete_input')
		// Don't fill type

		// Navigate to preview
		await page.locator('#create-project-modal footer button:has-text("Next")').click()
		await page.locator('#create-project-modal footer button:has-text("Next")').click()
		await page.locator('#create-project-modal footer button:has-text("Next")').click()
		await page.waitForTimeout(500)

		// Preview should not error, just not show the incomplete input
		const yamlPreview = await page.locator('#create-project-preview-yaml').textContent()
		expect(yamlPreview).not.toContain('incomplete_input')

		sendUnifiedLog({ test: 'project-empty-fields', action: 'complete' })
	})

	test('should allow clicking on wizard steps to navigate', async ({ page }) => {
		sendUnifiedLog({ test: 'project-wizard-step-clicks', action: 'start' })

		await page.click('.nav-item[data-tab="projects"]')
		await page.waitForTimeout(500)
		await page.click('button:has-text("New Project")')
		await page.waitForSelector('#create-project-modal', { state: 'visible' })

		// Fill project name
		await page.fill('#new-project-name', 'Step Navigation Test')

		// Go forward to step 3 (Outputs)
		await page.locator('#create-project-modal footer button:has-text("Next")').click()
		await page.locator('#create-project-modal footer button:has-text("Next")').click()
		await page.locator('#create-project-modal footer button:has-text("Next")').click()

		await expect(page.locator('.project-wizard-step.active')).toHaveAttribute('data-step', '3')

		// Click on step 1 (Project Details) in the sidebar
		await page.click('.project-wizard-steps li:nth-child(1)')
		await page.waitForTimeout(200)

		await expect(page.locator('.project-wizard-step.active')).toHaveAttribute('data-step', '0')

		// Click on step 4 (Outputs) in sidebar
		await page.click('.project-wizard-steps li:nth-child(4)')
		await page.waitForTimeout(200)

		await expect(page.locator('.project-wizard-step.active')).toHaveAttribute('data-step', '3')

		sendUnifiedLog({ test: 'project-wizard-step-clicks', action: 'complete' })
	})
})
