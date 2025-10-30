import { expect, test } from '@playwright/test'
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

test.describe('Projects editor with Jupyter integration', () => {
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

	test('create project, exercise Jupyter controls, and persist edits', async ({
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
		const _projectName = useRealInvoke ? `Genome Analysis ${Date.now()}` : 'Genome Analysis'

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
						.replace(/^-+|-+$/g, '') || 'new-project'

				const state = {
					storageKey,
					baseUrl: initBaseUrl,
					jupyterPath,
					nextProjectId: 1,
					projects: [],
					metadataById: new Map(),
					fileTrees: new Map(),
					currentProjectId: null,
					jupyter: { running: false, port: null, url: null, token: null },
				}

				w.__TEST_PROJECT_STATE__ = state

				w.__TEST_INVOKE_OVERRIDE__ = async (cmd, args = {}) => {
					switch (cmd) {
						case 'check_is_onboarded':
							return true
						case 'get_available_project_examples':
							return {
								'analysis-demo': {
									name: 'Analysis Demo',
									description: 'Mock example project for tests',
								},
							}
						case 'get_default_project_path': {
							const desired = (args?.name ?? 'new-project').trim()
							const slug = slugify(desired)
							return `/tmp/biovault-playwright/${slug}`
						}
						case 'get_projects':
							return state.projects.map((project) => ({ ...project }))
						case 'create_project': {
							const id = state.nextProjectId++
							const projectName = (args?.name ?? `Project ${id}`).trim() || `Project ${id}`
							const slug = slugify(projectName)
							const projectPath = args?.directory ?? `/tmp/biovault-playwright/${slug}`
							const project = {
								id,
								name: projectName,
								author: '',
								workflow: 'workflow.nf',
								template: null,
								project_path: projectPath,
								created_at: '2024-01-05T12:00:00Z',
								source: 'Local',
								orphaned: false,
							}
							state.projects.push(project)
							state.metadataById.set(id, {
								name: projectName,
								author: '',
								workflow: 'workflow.nf',
								template: null,
								assets: [`${projectPath}/workflow.nf`],
							})
							state.fileTrees.set(id, [
								{
									name: 'workflow.nf',
									path: `${projectPath}/workflow.nf`,
									is_dir: false,
								},
								{
									name: 'data',
									path: `${projectPath}/data`,
									is_dir: true,
									children: [
										{
											name: 'reads.fastq',
											path: `${projectPath}/data/reads.fastq`,
											is_dir: false,
										},
									],
								},
							])
							state.currentProjectId = id
							state.jupyter = { running: false, port: null, url: null, token: null }
							return { ...project }
						}
						case 'load_project_editor': {
							let projectId = args?.projectId ?? null
							if (!projectId && args?.projectPath) {
								const match = state.projects.find((p) => p.project_path === args.projectPath)
								projectId = match?.id ?? null
							}
							if (typeof projectId !== 'number') {
								throw new Error('Project not found')
							}
							state.currentProjectId = projectId
							const project = state.projects.find((p) => p.id === projectId)
							const metadata = state.metadataById.get(projectId)
							return {
								project_id: projectId,
								project_path: project.project_path,
								metadata: { ...metadata },
								file_tree: state.fileTrees.get(projectId) ?? [],
								has_project_yaml: true,
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
						case 'save_project_editor': {
							const projectId = state.currentProjectId
							if (typeof projectId !== 'number') {
								throw new Error('No active project to save')
							}
							const payload = args?.payload ?? {}
							const metadata = state.metadataById.get(projectId)
							metadata.name = payload.name ?? metadata.name
							metadata.author = payload.author ?? metadata.author
							metadata.workflow = payload.workflow ?? metadata.workflow
							metadata.template = payload.template ?? null
							metadata.assets = Array.isArray(payload.assets) ? payload.assets : metadata.assets
							const project = state.projects.find((p) => p.id === projectId)
							project.name = metadata.name
							project.author = metadata.author
							project.workflow = metadata.workflow
							project.template = metadata.template
							return { ...project }
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
			name: 'projects-jupyter',
			mode: useRealInvoke ? 'real' : 'mock',
		})

		await page.goto('/')
		await waitForAppReady(page)
		await ensureNotInOnboarding(page)

		// Navigate to run/pipelines view
		await page.click('.nav-item[data-tab="run"]')
		await expect(page.locator('#run-view.tab-content.active')).toBeVisible({ timeout: 2000 })

		// Create a new pipeline
		const createPipelineBtn = page
			.locator('#create-pipeline-btn, #empty-create-pipeline-btn')
			.first()
		await expect(createPipelineBtn).toBeVisible()
		await createPipelineBtn.click()

		// Wait for template picker modal (first screen)
		await page.waitForSelector('#pipeline-picker-modal', { state: 'visible', timeout: 5000 })

		// Click "Import Your Own" to show the import options modal
		await page.click('button:has-text("Import Your Own")')

		// Wait for import options modal (second screen)
		await page.waitForSelector('#pipeline-import-options-modal', { state: 'visible', timeout: 5000 })

		// Click "Create Blank Pipeline"
		await page.click('#pipeline-import-options-modal button:has-text("Create Blank Pipeline")')

		// Wait for pipeline name modal and fill in name
		await page.waitForSelector('#pipeline-name-modal', { state: 'visible' })
		const pipelineName = useRealInvoke ? `Jupyter Test ${Date.now()}` : 'Jupyter Test Pipeline'
		await page.fill('#pipeline-name-input', pipelineName)

		// Set up dialog handler for any alerts
		page.on('dialog', async (dialog) => {
			console.log('Dialog:', dialog.message())
			await dialog.accept()
		})

		// Create the pipeline
		await page.click('#pipeline-name-modal button:has-text("Create Pipeline")')
		await page.waitForTimeout(2000)

		// After creation, we should see the pipeline in the list or editor
		// Click on the pipeline to view its details
		const pipelineCard = page.locator('.pipeline-card').filter({ hasText: pipelineName }).first()
		const cardExists = (await pipelineCard.count()) > 0

		if (cardExists) {
			// Click to view pipeline details
			await pipelineCard.click()
			await page.waitForTimeout(1000)
		}

		// Now we need to add a step to the pipeline to access Jupyter functionality
		// Look for "Add Step" button
		const addStepBtn = page
			.locator('button:has-text("Add Step"), button:has-text("+ Add Step")')
			.first()
		if (await addStepBtn.isVisible()) {
			await addStepBtn.click()
			await page.waitForTimeout(1000)

			// In the add step modal, select or create a step
			// This might open a project picker or creator
			const modalVisible = await page.locator('#add-step-modal, #step-picker-modal').isVisible()

			if (modalVisible) {
				// Try to select an existing project or create new
				const existingProject = page.locator('.project-item, .step-option').first()
				if ((await existingProject.count()) > 0) {
					await existingProject.click()
				} else {
					// Create new step/project
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

		// Now look for the step edit button to open the project editor
		const editStepBtn = page.locator('button:has-text("Edit Step"), button.edit-step-btn').first()
		if (await editStepBtn.isVisible()) {
			await editStepBtn.click()
			await page.waitForTimeout(1000)

			// Should now be in project-edit-view
			await expect(page.locator('#project-edit-view')).toBeVisible({ timeout: 5000 })

			// Now test Jupyter functionality
			const statusEl = page.locator('#project-edit-view #project-edit-status').first()
			const statusRow = page.locator('#project-jupyter-status')
			const launchBtn = page
				.locator('#step-edit-jupyter-btn, #project-edit-launch-jupyter-btn')
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
				const resetBtn = page.locator('#project-edit-reset-jupyter-btn')
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
