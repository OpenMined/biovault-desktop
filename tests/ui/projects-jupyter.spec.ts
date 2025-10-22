import { expect, test } from '@playwright/test'
import WebSocket from 'ws'

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
		if (useRealInvoke) {
			testInfo.setTimeout(180_000)
		}

		await ensureLogSocket()
		page.on('console', (msg) => {
			sendUnifiedLog({ source: 'browser', type: msg.type(), text: msg.text() })
		})

		const baseUrl = process.env.UI_BASE_URL ?? 'http://localhost:8082'
		const jupyterUrl = useRealInvoke ? null : `${baseUrl}${JUPYTER_PATH}`
		const projectName = useRealInvoke ? `Genome Analysis ${Date.now()}` : 'Genome Analysis'

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
		await expect(page.locator('#home-view')).toBeVisible()

		await page.locator('button.tab[data-tab="projects"]').click()
		await expect(page.locator('#projects-view')).toBeVisible()

		// Clean up any existing projects (mock mode only - real backend doesn't support delete_project via WebSocket)
		if (!useRealInvoke) {
			const projectCards = page.locator('.project-card')
			const projectCount = await projectCards.count()
			if (projectCount > 0) {
				sendUnifiedLog({ event: 'cleanup-existing-projects', count: projectCount })
				for (let i = 0; i < projectCount; i++) {
					const deleteBtn = projectCards.first().locator('.delete-btn')
					await deleteBtn.click()
					const confirmDialog = page.waitForEvent('dialog')
					await (await confirmDialog).accept()
					// Wait for deletion to complete
					await page.waitForTimeout(500)
				}
			}
			await expect(page.locator('#projects-list')).toContainText('No projects found in BioVault.')
		}

		await page.locator('#create-project-btn').click()
		await expect(page.locator('#create-project-modal')).toBeVisible()
		await page.fill('#new-project-name', projectName)
		await page.locator('#create-project-confirm').click()

		await expect(page.locator('#project-edit-view')).toBeVisible()
		await expect(page.locator('#project-edit-name')).toHaveValue(projectName)

		const statusEl = page.locator('#project-edit-status')
		const statusRow = page.locator('#project-jupyter-status')

		await page.locator('#project-edit-launch-jupyter-btn').click()

		if (useRealInvoke) {
			await expect(statusEl).toHaveText(/Jupyter running at http:\/\/localhost:/, {
				timeout: 180_000,
			})
		} else if (jupyterUrl) {
			await expect(statusEl).toHaveText(`Jupyter running at ${jupyterUrl}`, { timeout: 10_000 })
		}
		await expect(statusRow).toContainText('Running at')

		if (!useRealInvoke && jupyterUrl) {
			const [jupyterPage] = await Promise.all([
				page.context().waitForEvent('page'),
				page.locator('#jupyter-open-link').click(),
			])
			await jupyterPage.waitForLoadState('domcontentloaded')
			await expect(jupyterPage.locator('h1')).toHaveText('Test Jupyter Lab')
			await jupyterPage.locator('#create-notebook').click()
			await expect(jupyterPage.locator('#status')).toHaveText('Notebook created!')
			await jupyterPage.close()
		}

		await page.locator('#project-edit-launch-jupyter-btn').click()
		await expect(statusEl).toHaveText('Jupyter server stopped.')
		await expect(statusRow).toBeHidden()

		await page.locator('#project-edit-launch-jupyter-btn').click()
		if (useRealInvoke) {
			await expect(statusEl).toHaveText(/Jupyter running at http:\/\/localhost:/)
		} else if (jupyterUrl) {
			await expect(statusEl).toHaveText(`Jupyter running at ${jupyterUrl}`)
		}
		await expect(statusRow).toContainText('Running at')

		if (!useRealInvoke && jupyterUrl) {
			const [reopenedJupyter] = await Promise.all([
				page.context().waitForEvent('page'),
				page.locator('#jupyter-open-link').click(),
			])
			await reopenedJupyter.waitForLoadState('domcontentloaded')
			await reopenedJupyter.close()
			await expect(statusEl).toHaveText(`Jupyter running at ${jupyterUrl}`)
			await expect(statusRow).toContainText('Running at')
		}

		const resetDialog = page.waitForEvent('dialog')
		await page.locator('#project-edit-reset-jupyter-btn').click()
		await (await resetDialog).accept()
		// Real backend says "rebuilt", mock says "reset"
		await expect(statusEl).toHaveText(
			/Jupyter environment (reset|rebuilt)\. The server is stopped\./,
		)
		await expect(statusRow).toBeHidden()

		const updatedProjectName = useRealInvoke ? `Updated ${projectName}` : 'Updated Genome Analysis'
		await page.fill('#project-edit-name', updatedProjectName)
		await page.fill('#project-edit-author', 'scientist@example.com')
		await page.fill('#project-edit-workflow', 'analysis.nf')
		await page.fill('#project-edit-template', 'demo-template')

		await page.locator('#project-edit-save-btn').click()
		await expect(statusEl).toHaveText('✅ Project saved')

		await page.locator('#project-edit-back-btn').click()
		await expect(page.locator('#projects-view')).toBeVisible()

		// Find the specific project by name (don't use .first() as other projects may exist)
		const projectCard = page.locator('.project-card', { hasText: updatedProjectName })
		await expect(projectCard.locator('h3')).toHaveText(updatedProjectName)
		await expect(projectCard).toContainText('Author: scientist@example.com')
		await expect(projectCard).toContainText('Workflow: analysis.nf')
		await expect(projectCard).toContainText('Template: demo-template')

		// Cleanup: Close any open Jupyter tabs and stop the server
		sendUnifiedLog({ event: 'cleanup-start' })

		// Close all Jupyter tabs (context.pages() includes all tabs)
		const allPages = page.context().pages()
		for (const p of allPages) {
			if (p !== page && p.url().includes('jupyter')) {
				sendUnifiedLog({ event: 'closing-jupyter-tab', url: p.url() })
				await p.close()
			}
		}

		// Go back to project editor and stop Jupyter
		await projectCard.locator('button', { hasText: 'Edit' }).click()
		await expect(page.locator('#project-edit-view')).toBeVisible()

		// If Jupyter is still running, stop it
		const launchBtn = page.locator('#project-edit-launch-jupyter-btn')
		const btnText = await launchBtn.textContent()
		if (btnText?.includes('Stop')) {
			sendUnifiedLog({ event: 'stopping-jupyter' })
			await launchBtn.click()
			await expect(statusEl).toHaveText('Jupyter server stopped.')
			await expect(statusRow).toBeHidden()
			sendUnifiedLog({ event: 'jupyter-stopped' })
		}

		sendUnifiedLog({ event: 'cleanup-complete' })

		// Note: Project cleanup skipped - real backend doesn't support delete_project via WebSocket
		// Test data will remain in ~/.biovault/projects/
	})
})
