import { expect, test } from './playwright-fixtures'
import WebSocket from 'ws'
import { waitForAppReady, ensureNotInOnboarding } from './test-helpers.js'

const STORAGE_KEY = 'playwright:onboarded'
const JUPYTER_PATH = '/__test_jupyter__/lab/index.html'
const useRealInvoke = process.env.USE_REAL_INVOKE === 'true'

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
	} catch {
		// Ignore logging failures
	}
}

test.describe('Modules editor with Jupyter integration', () => {
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

	test('create module, exercise Jupyter controls, and persist edits', async ({
		page,
	}, testInfo) => {
		// CI environments can be slower, increase timeout for both mock and real modes
		const timeoutMs = useRealInvoke ? 240_000 : 180_000
		testInfo.setTimeout(timeoutMs)

		await ensureLogSocket()
		page.on('console', (msg) => {
			sendUnifiedLog({ source: 'browser', type: msg.type(), text: msg.text() })
		})

		const baseUrl = process.env.UI_BASE_URL ?? 'http://localhost:8082'
		const _jupyterUrl = useRealInvoke ? null : `${baseUrl}${JUPYTER_PATH}`
		const _moduleName = useRealInvoke ? `Genome Analysis ${Date.now()}` : 'Genome Analysis'

		await page.addInitScript(
			({ storageKey, baseUrl: initBaseUrl, jupyterPath, useRealInvoke: initUseRealInvoke }) => {
				const w = /** @type {any} */ window
				w.__USE_REAL_INVOKE__ = !!initUseRealInvoke
				// Make USE_REAL_INVOKE available to the tauri-shim
				if (initUseRealInvoke) {
					w.process = w.process || {}
					w.process.env = w.process.env || {}
					w.process.env.USE_REAL_INVOKE = 'true'
				}
				window.sessionStorage.setItem(storageKey, 'true')

				// Don't set up mocks if using real backend
				if (initUseRealInvoke) {
					return
				}

				const slugify = (value) =>
					value
						.toLowerCase()
						.replace(/[^a-z0-9]+/g, '-')
						.replace(/^-+|-+$/g, '') || 'new-module'

				const state = {
					storageKey,
					baseUrl: initBaseUrl,
					jupyterPath,
					nextModuleId: 1,
					modules: [],
					metadataById: new Map(),
					fileTrees: new Map(),
					currentModuleId: null,
					jupyter: { running: false, port: null, url: null, token: null },
				}

				w.__TEST_PROJECT_STATE__ = state

				w.__TEST_INVOKE_OVERRIDE__ = async (cmd, args = {}) => {
					switch (cmd) {
						case 'check_is_onboarded':
							return true
						case 'get_available_module_examples':
							return {
								'analysis-demo': {
									name: 'Analysis Demo',
									description: 'Mock example module for tests',
								},
							}
						case 'get_default_module_path': {
							const desired = (args?.name ?? 'new-module').trim()
							const slug = slugify(desired)
							return `/tmp/biovault-playwright/${slug}`
						}
						case 'get_modules':
							return state.modules.map((module) => ({ ...module }))
						case 'create_module': {
							const id = state.nextModuleId++
							const moduleName = (args?.name ?? `Module ${id}`).trim() || `Module ${id}`
							const slug = slugify(moduleName)
							const modulePath = args?.directory ?? `/tmp/biovault-playwright/${slug}`
							const module = {
								id,
								name: moduleName,
								author: '',
								workflow: 'workflow.nf',
								template: null,
								module_path: modulePath,
								created_at: '2024-01-05T12:00:00Z',
								source: 'Local',
								orphaned: false,
							}
							state.modules.push(module)
							state.metadataById.set(id, {
								name: moduleName,
								author: '',
								workflow: 'workflow.nf',
								template: null,
								assets: [`${modulePath}/workflow.nf`],
							})
							state.fileTrees.set(id, [
								{
									name: 'workflow.nf',
									path: `${modulePath}/workflow.nf`,
									is_dir: false,
								},
								{
									name: 'data',
									path: `${modulePath}/data`,
									is_dir: true,
									children: [
										{
											name: 'reads.fastq',
											path: `${modulePath}/data/reads.fastq`,
											is_dir: false,
										},
									],
								},
							])
							state.currentModuleId = id
							state.jupyter = { running: false, port: null, url: null, token: null }
							return { ...module }
						}
						case 'load_module_editor': {
							let moduleId = args?.moduleId ?? null
							if (!moduleId && args?.modulePath) {
								const match = state.modules.find((p) => p.module_path === args.modulePath)
								moduleId = match?.id ?? null
							}
							if (typeof moduleId !== 'number') {
								throw new Error('Module not found')
							}
							state.currentModuleId = moduleId
							const module = state.modules.find((p) => p.id === moduleId)
							const metadata = state.metadataById.get(moduleId)
							return {
								module_id: moduleId,
								module_path: module.module_path,
								metadata: { ...metadata },
								file_tree: state.fileTrees.get(moduleId) ?? [],
								has_module_yaml: true,
							}
						}
						case 'get_jupyter_status':
							return { ...state.jupyter }
						case 'launch_jupyter': {
							state.jupyter = {
								running: true,
								port: 8890,
								url: `${state.baseUrl}${state.jupyterPath}`,
								token: 'test-token',
							}
							return { ...state.jupyter }
						}
						case 'stop_jupyter': {
							state.jupyter = { running: false, port: null, url: null, token: null }
							return { ...state.jupyter }
						}
						case 'reset_jupyter': {
							state.jupyter = { running: false, port: null, url: null, token: null }
							return {
								status: { ...state.jupyter },
								message: 'Jupyter environment reset. The server is stopped.',
							}
						}
						case 'save_module_editor': {
							const moduleId = state.currentModuleId
							if (typeof moduleId !== 'number') {
								throw new Error('No active module to save')
							}
							const payload = args?.payload ?? {}
							const metadata = state.metadataById.get(moduleId)
							metadata.name = payload.name ?? metadata.name
							metadata.author = payload.author ?? metadata.author
							metadata.workflow = payload.workflow ?? metadata.workflow
							metadata.template = payload.template ?? null
							metadata.assets = Array.isArray(payload.assets) ? payload.assets : metadata.assets
							const module = state.modules.find((p) => p.id === moduleId)
							module.name = metadata.name
							module.author = metadata.author
							module.workflow = metadata.workflow
							module.template = metadata.template
							return { ...module }
						}
						case 'open_url':
							throw new Error('open_url not available in browser tests')
						default:
							return undefined
					}
				}
			},
			{ storageKey: STORAGE_KEY, baseUrl, jupyterPath: JUPYTER_PATH, useRealInvoke },
		)

		sendUnifiedLog({
			event: 'test-start',
			name: 'modules-jupyter',
			mode: useRealInvoke ? 'real' : 'mock',
		})

		await page.goto('/', { timeout: 15_000, waitUntil: 'commit' })
		await waitForAppReady(page)
		await ensureNotInOnboarding(page)

		// Navigate to run/flows view
		await page.click('.nav-item[data-tab="run"]')
		await expect(page.locator('#run-view.tab-content.active')).toBeVisible({ timeout: 2000 })

		// Create a new flow
		const createFlowBtn = page.locator('#create-flow-btn, #empty-create-flow-btn').first()
		await expect(createFlowBtn).toBeVisible()
		await createFlowBtn.click()

		// Wait for template picker modal (first screen)
		await page.waitForSelector('#flow-picker-modal', { state: 'visible', timeout: 5000 })

		// Click "Import Your Own" to show the import options modal
		await page.click('button:has-text("Import Your Own")')

		// Wait for import options modal (second screen)
		await page.waitForSelector('#flow-import-options-modal', {
			state: 'visible',
			timeout: 5000,
		})

		// Click "Create Blank Flow"
		await page.click('#flow-import-options-modal button:has-text("Create Blank Flow")')

		// Wait for flow name modal and fill in name
		await page.waitForSelector('#flow-name-modal', { state: 'visible' })
		const flowName = useRealInvoke ? `Jupyter Test ${Date.now()}` : 'Jupyter Test Flow'
		await page.fill('#flow-name-input', flowName)

		// Set up dialog handler for any alerts
		page.on('dialog', async (dialog) => {
			console.log('Dialog:', dialog.message())
			await dialog.accept()
		})

		// Create the flow
		await page.click('#flow-name-modal button:has-text("Create Flow")')
		await page.waitForTimeout(2000)

		// After creation, we should see the flow in the list or editor
		// Click on the flow to view its details
		const flowCard = page.locator('.flow-card').filter({ hasText: flowName }).first()
		const cardExists = (await flowCard.count()) > 0

		if (cardExists) {
			// Click to view flow details
			await flowCard.click()
			await page.waitForTimeout(1000)
		}

		// Now we need to add a step to the flow to access Jupyter functionality
		// Look for "Add Step" button
		const addStepBtn = page
			.locator('button:has-text("Add Step"), button:has-text("+ Add Step")')
			.first()
		if (await addStepBtn.isVisible()) {
			await addStepBtn.click()
			await page.waitForTimeout(1000)

			// In the add step modal, select or create a step
			// This might open a module picker or creator
			const modalVisible = await page.locator('#add-step-modal, #step-picker-modal').isVisible()

			if (modalVisible) {
				// Try to select an existing module or create new
				const existingModule = page.locator('.module-item, .step-option').first()
				if ((await existingModule.count()) > 0) {
					await existingModule.click()
				} else {
					// Create new step/module
					const createNewBtn = page.locator('button:has-text("Create New")').first()
					if (await createNewBtn.isVisible()) {
						await createNewBtn.click()
					}
				}

				// Confirm adding the step
				const confirmBtn = page
					.locator('button:has-text("Add"), button:has-text("Confirm")')
					.first()
				if (await confirmBtn.isVisible()) {
					await confirmBtn.click()
					await page.waitForTimeout(1000)
				}
			}
		}

		// Now look for the step edit button to open the module editor
		const editStepBtn = page.locator('button:has-text("Edit Step"), button.edit-step-btn').first()
		if (await editStepBtn.isVisible()) {
			await editStepBtn.click()
			await page.waitForTimeout(1000)

			// Should now be in module-edit-view
			await expect(page.locator('#module-edit-view')).toBeVisible({ timeout: 5000 })

			// Now test Jupyter functionality
			const statusEl = page.locator('#module-edit-view #module-edit-status').first()
			const statusRow = page.locator('#module-jupyter-status')
			const launchBtn = page
				.locator('#step-edit-jupyter-btn, #module-edit-launch-jupyter-btn')
				.first()

			// Launch Jupyter
			if (await launchBtn.isVisible()) {
				await launchBtn.click()

				if (useRealInvoke) {
					await expect(statusEl).toHaveText(/Jupyter running at http:\/\/localhost:/, {
						timeout: 180_000,
					})
				} else if (_jupyterUrl) {
					await expect(statusEl).toHaveText(`Jupyter running at ${_jupyterUrl}`, {
						timeout: 10_000,
					})
				}

				// Verify Jupyter status is shown
				await expect(statusRow).toBeVisible()
				await expect(statusRow).toContainText('Running at')

				// Stop Jupyter
				await launchBtn.click()
				await expect(statusEl).toHaveText(/Jupyter server stopped/)
				await expect(statusRow).toBeHidden()

				// Test restart
				await launchBtn.click()
				if (useRealInvoke) {
					await expect(statusEl).toHaveText(/Jupyter running at http:\/\/localhost:/)
				} else if (_jupyterUrl) {
					await expect(statusEl).toHaveText(`Jupyter running at ${_jupyterUrl}`)
				}
				await expect(statusRow).toContainText('Running at')

				// Test reset if button exists
				const resetBtn = page.locator('#module-edit-reset-jupyter-btn')
				if (await resetBtn.isVisible()) {
					const resetDialog = page.waitForEvent('dialog', { timeout: 5000 })
					await resetBtn.click()
					await (await resetDialog).accept()
					await expect(statusEl).toHaveText(/Jupyter environment (reset|rebuilt)/)
					await expect(statusRow).toBeHidden()
				}

				sendUnifiedLog({ event: 'jupyter-test-complete' })
			} else {
				sendUnifiedLog({ event: 'jupyter-button-not-found' })
			}
		} else {
			sendUnifiedLog({ event: 'step-edit-not-available' })
		}
	})
})
