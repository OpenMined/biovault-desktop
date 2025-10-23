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
				case 'get_available_project_examples':
					return {
						'count-lines': {
							name: 'Count Lines',
							inputs: [{ name: 'samplesheet', type: 'File', description: 'Sample data' }],
							outputs: [{ name: 'results', type: 'File', description: 'Line counts' }],
							parameters: [],
						},
					}
				case 'get_supported_input_types':
					return {
						base_types: ['File', 'Directory', 'String', 'List[File]', 'ParticipantSheet'],
						common_types: ['File', 'Directory', 'String', 'List[File]'],
					}
				case 'get_supported_output_types':
					return {
						base_types: ['File', 'Directory', 'ParticipantSheet'],
						common_types: ['File', 'Directory'],
					}
				case 'get_supported_parameter_types':
					return ['String', 'Bool', 'Enum[...]']
				case 'get_common_formats':
					return ['csv', 'tsv', 'txt', 'json', 'vcf']
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

					let yaml = `name: ${args.name || 'test'}\nauthor: ${
						args.author || 'test@example.com'
					}\nworkflow: ${args.workflow || 'workflow.nf'}\ntemplate: ${
						args.template || 'dynamic-nextflow'
					}`

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

test.describe('Project Creation Modal', () => {
	test('should open create project modal and navigate through tabs', async ({ page }) => {
		sendUnifiedLog({ test: 'project-tab-navigation', action: 'start' })

		// Navigate to projects view
		await page.click('.nav-item[data-tab="projects"]')
		await page.waitForTimeout(500)

		// Click "New Project" button
		await page.click('button:has-text("New Project")')
		await page.waitForSelector('#create-project-modal', { state: 'visible' })

		// Details tab active by default
		await expect(page.locator('.create-tab-content.active')).toHaveAttribute(
			'data-content',
			'details',
		)
		await page.fill('#new-project-name', 'Test Project')

		// Navigate using Next button
		await page.locator('#create-project-next').click()
		await expect(page.locator('.create-tab-content.active')).toHaveAttribute(
			'data-content',
			'inputs',
		)

		await page.locator('#create-project-next').click()
		await expect(page.locator('.create-tab-content.active')).toHaveAttribute(
			'data-content',
			'parameters',
		)

		await page.locator('#create-project-next').click()
		await expect(page.locator('.create-tab-content.active')).toHaveAttribute(
			'data-content',
			'outputs',
		)

		// Back button works
		await page.locator('#create-project-back').click()
		await expect(page.locator('.create-tab-content.active')).toHaveAttribute(
			'data-content',
			'parameters',
		)

		// Click tabs directly
		await page.locator('.create-tab[data-tab="details"]').click()
		await expect(page.locator('.create-tab-content.active')).toHaveAttribute(
			'data-content',
			'details',
		)

		sendUnifiedLog({ test: 'project-tab-navigation', action: 'complete' })
	})

	test('should add and remove parameters using modal', async ({ page }) => {
		sendUnifiedLog({ test: 'project-parameters', action: 'start' })

		await page.click('.nav-item[data-tab="projects"]')
		await page.waitForTimeout(500)
		await page.click('button:has-text("New Project")')
		await page.waitForSelector('#create-project-modal', { state: 'visible' })

		// Fill project name
		await page.fill('#new-project-name', 'Param Test Project')

		// Navigate to Parameters tab
		await page.locator('.create-tab[data-tab="parameters"]').click()
		await expect(page.locator('.create-tab-content.active')).toHaveAttribute(
			'data-content',
			'parameters',
		)

		// Wait for form to initialize and add zone to appear in active tab
		await page.waitForTimeout(500) // Give form time to render

		// Click add zone to open modal (within active tab content)
		await page.locator('.create-tab-content.active .spec-add-zone').click()
		await page.waitForSelector('#spec-item-modal', { state: 'visible' })

		// Fill parameter 1 in modal
		await page.fill('#modal-field-name', 'enable_filter')
		await page.selectOption('#modal-field-type', 'Bool')
		await page.fill('#modal-field-description', 'Enable filtering step')

		// Expand advanced and fill default
		await page.locator('.modal-advanced-section summary').click()
		await page.fill('#modal-field-default', 'true')

		// Submit modal
		await page.click('#spec-item-modal-submit')
		await page.waitForTimeout(300)

		// Verify parameter appears in list
		await expect(page.locator('.spec-list-item')).toHaveCount(1)
		await expect(page.locator('.spec-item-title')).toContainText('enable_filter')

		// Add second parameter
		await page.locator('.create-tab-content.active .spec-add-zone').click()
		await page.waitForSelector('#spec-item-modal', { state: 'visible' })
		await page.fill('#modal-field-name', 'output_format')
		await page.selectOption('#modal-field-type', 'String')
		await page.fill('#modal-field-description', 'Output file format')
		await page.click('#spec-item-modal-submit')
		await page.waitForTimeout(300)

		// Verify both parameters are present
		await expect(page.locator('.spec-list-item')).toHaveCount(2)

		// Remove first parameter
		await page.locator('.spec-list-item').first().locator('.spec-item-remove').click()
		await page.waitForTimeout(200)

		// Verify only one parameter remains
		await expect(page.locator('.spec-list-item')).toHaveCount(1)
		await expect(page.locator('.spec-item-title')).toContainText('output_format')

		sendUnifiedLog({ test: 'project-parameters', action: 'complete' })
	})

	test('should add inputs and outputs using modals', async ({ page }) => {
		sendUnifiedLog({ test: 'project-inputs-outputs', action: 'start' })

		await page.click('.nav-item[data-tab="projects"]')
		await page.waitForTimeout(500)
		await page.click('button:has-text("New Project")')
		await page.waitForSelector('#create-project-modal', { state: 'visible' })

		await page.fill('#new-project-name', 'IO Test Project')

		// Navigate to Inputs tab
		await page.locator('.create-tab[data-tab="inputs"]').click()
		await expect(page.locator('.create-tab-content.active')).toHaveAttribute(
			'data-content',
			'inputs',
		)

		// Wait for form to initialize
		await page.waitForTimeout(500)

		// Add input using modal (within active tab)
		await page.locator('.create-tab-content.active .spec-add-zone').click()
		await page.waitForSelector('#spec-item-modal', { state: 'visible' })
		await page.fill('#modal-field-name', 'reference_genome')
		await page.selectOption('#modal-field-type', 'File')
		await page.fill('#modal-field-description', 'Reference genome file')
		await page.click('#spec-item-modal-submit')
		await page.waitForTimeout(300)

		// Verify input appears in list
		await expect(page.locator('.spec-list-item')).toHaveCount(1)
		await expect(page.locator('.spec-item-title')).toContainText('reference_genome')

		// Navigate to Outputs tab
		await page.locator('.create-tab[data-tab="outputs"]').click()
		await expect(page.locator('.create-tab-content.active')).toHaveAttribute(
			'data-content',
			'outputs',
		)

		// Wait for form to initialize
		await page.waitForTimeout(500)

		// Add output using modal (within active tab)
		await page.locator('.create-tab-content.active .spec-add-zone').click()
		await page.waitForSelector('#spec-item-modal', { state: 'visible' })
		await page.fill('#modal-field-name', 'filtered_data')
		await page.selectOption('#modal-field-type', 'File')
		await page.fill('#modal-field-description', 'Filtered dataset')
		await page.click('#spec-item-modal-submit')
		await page.waitForTimeout(300)

		// Verify output appears in list
		await expect(page.locator('.spec-list-item')).toHaveCount(1)
		await expect(page.locator('.spec-item-title')).toContainText('filtered_data')

		// Verify preview is visible
		await expect(page.locator('#create-project-preview-yaml')).toBeVisible()

		sendUnifiedLog({ test: 'project-inputs-outputs', action: 'complete' })
	})

	test('should validate required fields in modal', async ({ page }) => {
		sendUnifiedLog({ test: 'project-validation', action: 'start' })

		await page.click('.nav-item[data-tab="projects"]')
		await page.waitForTimeout(500)
		await page.click('button:has-text("New Project")')
		await page.waitForSelector('#create-project-modal', { state: 'visible' })

		await page.fill('#new-project-name', 'Validation Test')

		// Navigate to Inputs tab
		await page.locator('.create-tab[data-tab="inputs"]').click()

		// Wait for form to initialize
		await page.waitForTimeout(500)

		// Try to add input with only name (no type) - should show alert
		await page.locator('.create-tab-content.active .spec-add-zone').click()
		await page.waitForSelector('#spec-item-modal', { state: 'visible' })
		await page.fill('#modal-field-name', 'incomplete_input')
		// Don't select type

		page.on('dialog', (dialog) => dialog.accept()) // Auto-accept alert
		await page.click('#spec-item-modal-submit')
		await page.waitForTimeout(200)

		// Modal should still be open due to validation
		await expect(page.locator('#spec-item-modal')).toBeVisible()

		// Now fill type properly
		await page.selectOption('#modal-field-type', 'File')
		await page.click('#spec-item-modal-submit')
		await page.waitForTimeout(300)

		// Modal should close and item should be added
		await expect(page.locator('#spec-item-modal')).not.toBeVisible()
		await expect(page.locator('.spec-list-item')).toHaveCount(1)

		sendUnifiedLog({ test: 'project-validation', action: 'complete' })
	})

	test('should allow editing items via modal', async ({ page }) => {
		sendUnifiedLog({ test: 'project-edit-modal', action: 'start' })

		await page.click('.nav-item[data-tab="projects"]')
		await page.waitForTimeout(500)
		await page.click('button:has-text("New Project")')
		await page.waitForSelector('#create-project-modal', { state: 'visible' })

		await page.fill('#new-project-name', 'Edit Test Project')

		// Navigate to Inputs tab
		await page.locator('.create-tab[data-tab="inputs"]').click()

		// Wait for form to initialize
		await page.waitForTimeout(500)

		// Add an input (within active tab)
		await page.locator('.create-tab-content.active .spec-add-zone').click()
		await page.waitForSelector('#spec-item-modal', { state: 'visible' })
		await page.fill('#modal-field-name', 'data_file')
		await page.selectOption('#modal-field-type', 'File')
		await page.fill('#modal-field-description', 'Initial description')
		await page.click('#spec-item-modal-submit')
		await page.waitForTimeout(300)

		// Edit the input
		await page.locator('.spec-item-edit').click()
		await page.waitForSelector('#spec-item-modal', { state: 'visible' })

		// Modal should have existing values
		await expect(page.locator('#modal-field-name')).toHaveValue('data_file')

		// Change description
		await page.fill('#modal-field-description', 'Updated description')
		await page.click('#spec-item-modal-submit')
		await page.waitForTimeout(300)

		// Verify changes
		await expect(page.locator('.spec-item-details')).toContainText('Updated description')

		sendUnifiedLog({ test: 'project-edit-modal', action: 'complete' })
	})

	test('should select workflow engine and script language with cards', async ({ page }) => {
		sendUnifiedLog({ test: 'project-option-cards', action: 'start' })

		await page.click('.nav-item[data-tab="projects"]')
		await page.waitForTimeout(500)
		await page.click('button:has-text("New Project")')
		await page.waitForSelector('#create-project-modal', { state: 'visible' })

		// Verify default selections
		await expect(page.locator('.option-card[data-value="nextflow"]')).toHaveClass(/active/)
		await expect(page.locator('.option-card[data-value="python"]')).toHaveClass(/active/)

		// Click "None" for scripting language
		await page.locator('.option-card[data-value="none"]').click()
		await expect(page.locator('.option-card[data-value="none"]')).toHaveClass(/active/)
		await expect(page.locator('.option-card[data-value="python"]')).not.toHaveClass(/active/)

		// Click Python again
		await page.locator('.option-card[data-value="python"]').click()
		await expect(page.locator('.option-card[data-value="python"]')).toHaveClass(/active/)

		sendUnifiedLog({ test: 'project-option-cards', action: 'complete' })
	})
})
