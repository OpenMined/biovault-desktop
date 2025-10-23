import { createProjectSpecForm, generateContractAscii } from './project-spec-form-modal.js'

const CREATE_TAB_CONFIG = {
	inputs: { containerId: 'create-project-inputs', sections: ['inputs'], defaultTab: 'inputs' },
	parameters: {
		containerId: 'create-project-parameters',
		sections: ['parameters'],
		defaultTab: 'parameters',
	},
	outputs: { containerId: 'create-project-outputs', sections: ['outputs'], defaultTab: 'outputs' },
}

let wizardPreviewRequestId = 0
let editorPreviewRequestId = 0
let wizardPreviewScheduled = false
let editorPreviewScheduled = false

export function createProjectsModule({ invoke, dialog, open, shellApi, navigateTo }) {
	const projectEditorState = {
		projectId: null,
		projectPath: '',
		metadata: null,
		selectedAssets: new Set(),
		treeNodes: new Map(),
		jupyter: {
			running: false,
			port: null,
			url: null,
			token: null,
		},
		specForm: null,
		specData: {
			parameters: [],
			inputs: [],
			outputs: [],
		},
		specSummaryEl: null,
		lastSpecDigest: null,
		specDigestTimer: null,
		skipNextDigestReload: false,
		nameListenerBound: false,
	}

	const projectCreateState = {
		selectedDir: null,
		usingDefault: true,
		defaultDir: '',
		specForm: null,
		specData: {
			parameters: [],
			inputs: [],
			outputs: [],
		},
		nameListenerBound: false,
		activeTab: 'details',
	}

	let operationModalDepth = 0

	function isLikelyEmail(value) {
		const trimmed = value ? value.trim() : ''
		if (!trimmed) return false
		const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
		return emailRegex.test(trimmed)
	}

	async function openInExternalBrowser(url) {
		if (shellApi && typeof shellApi.open === 'function') {
			try {
				await shellApi.open(url)
				return
			} catch (err) {
				console.warn('shell.open failed, falling back to window.open:', err)
			}
		}

		try {
			await invoke('open_url', { url })
			return
		} catch (error) {
			console.warn('invoke("open_url") failed, fallback to window.open:', error)
		}

		window.open(url, '_blank', 'noopener,noreferrer')
	}

	async function confirmWithDialog(message, options = {}) {
		if (dialog?.confirm) {
			return await dialog.confirm(message, options)
		}
		return window.confirm(message)
	}

	function ensureEditorSpecForm() {
		const container = document.getElementById('project-spec-editor')
		if (!projectEditorState.specForm) {
			if (container) {
				projectEditorState.specForm = createProjectSpecForm({
					container,
					invoke,
					onChange: (parameters, inputs, outputs) => {
						projectEditorState.specData = { parameters, inputs, outputs }
						updateEditorSpecSummary()
					},
				})
			}
		} else if (container) {
			projectEditorState.specForm.mount(container)
		}
		if (projectEditorState.specForm) {
			projectEditorState.specForm.configureSections(
				['parameters', 'inputs', 'outputs'],
				'parameters',
			)
		}
		if (!projectEditorState.specSummaryEl) {
			projectEditorState.specSummaryEl = document.getElementById('project-spec-summary')
		}
		if (!projectEditorState.nameListenerBound) {
			const nameInput = document.getElementById('project-edit-name')
			if (nameInput) {
				nameInput.addEventListener('input', () => updateEditorSpecSummary())
				projectEditorState.nameListenerBound = true
			}
		}
	}

	function updateEditorSpecSummary() {
		if (!projectEditorState.specSummaryEl) return
		const nameInput = document.getElementById('project-edit-name')
		const projectName = nameInput ? nameInput.value.trim() : projectEditorState.metadata?.name || ''
		const ascii = generateContractAscii({
			name: projectName,
			parameters: projectEditorState.specData.parameters,
			inputs: projectEditorState.specData.inputs,
			outputs: projectEditorState.specData.outputs,
		})
		projectEditorState.specSummaryEl.textContent = ascii
		scheduleEditorPreview()
	}

	function getEditorSpecPayload() {
		return {
			parameters: projectEditorState.specData.parameters || [],
			inputs: projectEditorState.specData.inputs || [],
			outputs: projectEditorState.specData.outputs || [],
		}
	}

	function clearWizardPreview(message) {
		const yamlEl = document.getElementById('create-project-preview-yaml')
		const templateEl = document.getElementById('create-project-preview-template')
		if (yamlEl) yamlEl.textContent = message
		if (templateEl) templateEl.textContent = message
	}

	function clearEditorPreview(message) {
		const yamlEl = document.getElementById('project-edit-preview-yaml')
		const templateEl = document.getElementById('project-edit-preview-template')
		if (yamlEl) yamlEl.textContent = message
		if (templateEl) templateEl.textContent = message
	}

	function escapeHtml(text) {
		const div = document.createElement('div')
		div.textContent = text
		return div.innerHTML
	}

	function highlightYaml(code) {
		const escaped = escapeHtml(code)
		return escaped
			.replace(/^(\s*)([\w_-]+)(\s*):/gm, '$1<span class="yaml-key">$2</span>$3:')
			.replace(/:\s*([^\n]+)/g, ': <span class="yaml-value">$1</span>')
			.replace(/(#[^\n]*)/g, '<span class="yaml-comment">$1</span>')
	}

	function highlightGroovy(code) {
		const lines = code.split('\n')
		const highlighted = lines.map((line) => {
			// Skip if line is a comment
			if (line.trim().startsWith('//')) {
				return `<span class="groovy-comment">${escapeHtml(line)}</span>`
			}
			// Escape HTML first
			let result = escapeHtml(line)
			// Highlight strings
			result = result.replace(
				/(&quot;[^&]*&quot;|&#39;[^&#]*&#39;)/g,
				'<span class="groovy-string">$1</span>',
			)
			// Highlight keywords (must be whole words)
			result = result.replace(
				/\b(workflow|process|params|def|if|else|return|include|from|nextflow|enable|dsl|instanceof|Map|Collection)\b/g,
				'<span class="groovy-keyword">$1</span>',
			)
			return result
		})
		return highlighted.join('\n')
	}

	async function requestWizardPreview(payload) {
		wizardPreviewRequestId += 1
		const requestId = wizardPreviewRequestId
		try {
			const preview = await invoke('preview_project_spec', { payload })
			if (requestId !== wizardPreviewRequestId) return
			const yamlEl = document.getElementById('create-project-preview-yaml')
			const workflowEl = document.getElementById('create-project-preview-template')
			if (yamlEl) yamlEl.innerHTML = highlightYaml(preview.yaml)
			if (workflowEl) workflowEl.innerHTML = highlightGroovy(preview.workflow || preview.template)
		} catch (error) {
			if (requestId !== wizardPreviewRequestId) return
			console.error('Failed to generate project preview:', error)
			clearWizardPreview('Unable to generate preview. Check your inputs.')
		}
	}

	async function requestEditorPreview(payload) {
		editorPreviewRequestId += 1
		const requestId = editorPreviewRequestId
		try {
			const preview = await invoke('preview_project_spec', { payload })
			if (requestId !== editorPreviewRequestId) return
			const yamlEl = document.getElementById('project-edit-preview-yaml')
			const workflowEl = document.getElementById('project-edit-preview-template')
			if (yamlEl) yamlEl.innerHTML = highlightYaml(preview.yaml)
			if (workflowEl) workflowEl.innerHTML = highlightGroovy(preview.workflow || preview.template)
		} catch (error) {
			if (requestId !== editorPreviewRequestId) return
			console.error('Failed to generate editor preview:', error)
			clearEditorPreview('Unable to generate preview. Check project fields.')
		}
	}

	function scheduleEditorPreview() {
		if (editorPreviewScheduled) {
			return
		}
		editorPreviewScheduled = true
		setTimeout(() => {
			editorPreviewScheduled = false
			updateEditorPreview()
		}, 0)
	}

	function updateWizardPreview() {
		const nameInput = document.getElementById('new-project-name')
		const templateSelect = document.getElementById('new-project-template')
		const versionInput = document.getElementById('new-project-version')
		const projectName = nameInput ? nameInput.value.trim() : ''
		const versionValue = versionInput ? versionInput.value.trim() || '1.0.0' : '1.0.0'

		// Use placeholder name if empty for preview purposes
		const previewName = projectName || 'my-project'

		// Get scripting language selection for preview
		const selectedScriptCard = document.querySelector(
			'#blank-project-options .option-card.active[data-type="script"]',
		)
		const scriptLang = selectedScriptCard ? selectedScriptCard.dataset.value : 'none'
		const assets = !templateSelect?.value && scriptLang === 'python' ? ['process.py'] : []

		const spec = getCreateSpecPayload()
		const payload = buildSpecSavePayload({
			name: previewName,
			author: '',
			workflow: 'workflow.nf',
			template: templateSelect && templateSelect.value ? templateSelect.value : null,
			assets: assets,
			version: versionValue,
			spec,
		})
		requestWizardPreview(payload)
	}

	function scheduleWizardPreview() {
		if (wizardPreviewScheduled) {
			return
		}
		wizardPreviewScheduled = true
		setTimeout(() => {
			wizardPreviewScheduled = false
			updateWizardPreview()
		}, 0)
	}

	function updateEditorPreview() {
		const nameInput = document.getElementById('project-edit-name')
		const workflowInput = document.getElementById('project-edit-workflow')
		if (!nameInput || !workflowInput) {
			return
		}
		const nameValue = nameInput.value.trim()
		const workflowValue = workflowInput.value.trim() || 'workflow.nf'
		if (!nameValue || !workflowInput.value.trim()) {
			editorPreviewRequestId += 1
			clearEditorPreview('Enter a project name and workflow to generate a preview.')
			return
		}
		const authorValue = document.getElementById('project-edit-author')?.value.trim() || ''
		const templateValue = document.getElementById('project-edit-template')?.value.trim() || ''
		const versionValue = document.getElementById('project-edit-version')?.value.trim() || '1.0.0'
		const payload = buildSpecSavePayload({
			name: nameValue,
			author: authorValue,
			workflow: workflowValue,
			template: templateValue || null,
			assets: Array.from(projectEditorState.selectedAssets).map((entry) =>
				typeof entry === 'string' ? entry.replace(/\\/g, '/') : entry,
			),
			version: versionValue,
			spec: getEditorSpecPayload(),
		})
		requestEditorPreview(payload)
	}

	function ensureCreateSpecForm(config) {
		const targetId = config?.containerId || 'create-project-parameters'
		const target = document.getElementById(targetId)
		if (!projectCreateState.specForm) {
			if (target) {
				projectCreateState.specForm = createProjectSpecForm({
					container: target,
					invoke,
					onChange: (parameters, inputs, outputs) => {
						projectCreateState.specData = { parameters, inputs, outputs }
						updateTabCounts()
						scheduleWizardPreview()
					},
				})
			} else {
				return
			}
		} else if (target) {
			projectCreateState.specForm.mount(target)
		}

		if (projectCreateState.specForm && config) {
			projectCreateState.specForm.configureSections(config.sections, config.defaultTab)
		}
		if (projectCreateState.specForm) {
			projectCreateState.specForm.setSpec(projectCreateState.specData)
		}

		if (!projectCreateState.nameListenerBound) {
			const nameInput = document.getElementById('new-project-name')
			if (nameInput) {
				nameInput.addEventListener('input', () => {
					updateCreateSpecSummary()
					scheduleWizardPreview()
				})
				projectCreateState.nameListenerBound = true
			}
		}
	}

	function updateCreateSpecSummary() {
		// Update preview when spec data changes
		scheduleWizardPreview()
	}

	function updateTabCounts() {
		const counts = {
			inputs: projectCreateState.specData.inputs.length,
			parameters: projectCreateState.specData.parameters.length,
			outputs: projectCreateState.specData.outputs.length,
		}

		Object.entries(counts).forEach(([key, value]) => {
			const countEl = document.querySelector(`[data-count="${key}"]`)
			if (countEl) {
				countEl.textContent = value
				countEl.style.display = value > 0 ? 'inline-flex' : 'none'
			}
		})
	}

	async function loadTemplateIntoWizard(templateData) {
		// Normalize template data - convert 'type' to 'raw_type' for UI compatibility
		const normalizeSpec = (spec) => {
			if (!spec) return spec
			const normalized = { ...spec }
			// Convert 'type' field to 'raw_type' for UI
			if (normalized.type) {
				normalized.raw_type = normalized.type
				delete normalized.type
			}
			return normalized
		}

		// Update spec data from template
		projectCreateState.specData = {
			parameters: (templateData.parameters || []).map(normalizeSpec),
			inputs: (templateData.inputs || []).map(normalizeSpec),
			outputs: (templateData.outputs || []).map(normalizeSpec),
		}

		console.log('Loaded template data:', projectCreateState.specData)

		// Update form if it exists
		if (projectCreateState.specForm) {
			projectCreateState.specForm.setSpec(projectCreateState.specData)
		}

		// Update tab counts
		updateTabCounts()

		// Update version if template has one
		const versionInput = document.getElementById('new-project-version')
		if (versionInput && templateData.version) {
			versionInput.value = templateData.version
		}
	}

	function resetWizardToBlank() {
		// Reset spec data
		projectCreateState.specData = {
			parameters: [],
			inputs: [],
			outputs: [],
		}

		// Update form if it exists
		if (projectCreateState.specForm) {
			projectCreateState.specForm.setSpec(projectCreateState.specData)
		}

		// Update tab counts
		updateTabCounts()

		// Reset version
		const versionInput = document.getElementById('new-project-version')
		if (versionInput) {
			versionInput.value = '1.0.0'
		}
	}

	function getCreateSpecPayload() {
		return {
			parameters: projectCreateState.specData.parameters || [],
			inputs: projectCreateState.specData.inputs || [],
			outputs: projectCreateState.specData.outputs || [],
		}
	}

	function buildSpecSavePayload({ name, author, workflow, template, assets, version, spec }) {
		const nameValue = name && name.trim() ? name.trim() : ''
		const workflowValue = workflow && workflow.trim() ? workflow.trim() : 'workflow.nf'
		const templateValue =
			template && typeof template === 'string' && template.trim().length ? template.trim() : null
		const assetsValue = Array.isArray(assets)
			? assets
					.map((entry) => (typeof entry === 'string' ? entry.trim() : ''))
					.filter((entry) => entry.length)
			: []
		const versionValue =
			version && typeof version === 'string' && version.trim().length ? version.trim() : null

		const parameters = (spec.parameters || [])
			.filter((param) => param.name && param.name.trim() && param.raw_type && param.raw_type.trim())
			.map((param) => ({
				name: param.name,
				type: param.raw_type,
				raw_type: param.raw_type,
				description: param.description || null,
				default: param.default && param.default.trim() ? param.default.trim() : null,
				choices: param.choices && param.choices.length ? param.choices : null,
				advanced: param.advanced ? true : null,
			}))

		const inputs = (spec.inputs || [])
			.filter((input) => input.name && input.name.trim() && input.raw_type && input.raw_type.trim())
			.map((input) => ({
				name: input.name,
				type: input.raw_type,
				raw_type: input.raw_type,
				description: input.description || null,
				format: input.format || null,
				path: input.path || null,
				mapping: input.mapping || null,
			}))

		const outputs = (spec.outputs || [])
			.filter(
				(output) => output.name && output.name.trim() && output.raw_type && output.raw_type.trim(),
			)
			.map((output) => ({
				name: output.name,
				type: output.raw_type,
				raw_type: output.raw_type,
				description: output.description || null,
				format: output.format || null,
				path: output.path || null,
			}))

		return {
			name: nameValue,
			author,
			workflow: workflowValue,
			template: templateValue,
			assets: assetsValue,
			version: versionValue,
			parameters,
			inputs,
			outputs,
		}
	}

	function switchCreateTab(tabName) {
		projectCreateState.activeTab = tabName

		// Update tab buttons
		document.querySelectorAll('.create-tab').forEach((tab) => {
			tab.classList.toggle('active', tab.dataset.tab === tabName)
		})

		// Update content sections
		document.querySelectorAll('.create-tab-content').forEach((content) => {
			content.classList.toggle('active', content.dataset.content === tabName)
		})

		// Initialize spec form if switching to inputs/parameters/outputs
		const config = CREATE_TAB_CONFIG[tabName]
		if (config) {
			ensureCreateSpecForm(config)
		}

		// Update footer navigation
		updateCreateFooter()
	}

	function updateCreateFooter() {
		const tabOrder = ['details', 'inputs', 'parameters', 'outputs']
		const currentIndex = tabOrder.indexOf(projectCreateState.activeTab)

		const backBtn = document.getElementById('create-project-back')
		const nextBtn = document.getElementById('create-project-next')
		const confirmBtn = document.getElementById('create-project-confirm')

		if (!backBtn || !nextBtn || !confirmBtn) return

		// Back button
		backBtn.disabled = currentIndex === 0

		// Next button - show appropriate label
		if (currentIndex < tabOrder.length - 1) {
			const nextTab = tabOrder[currentIndex + 1]
			const labels = {
				details: 'Details',
				inputs: 'Inputs',
				parameters: 'Parameters',
				outputs: 'Outputs',
			}
			nextBtn.textContent = `Next: ${labels[nextTab]} →`
			nextBtn.style.display = 'inline-flex'
			confirmBtn.style.display = 'none'
		} else {
			// Last tab - show Create Project button
			nextBtn.style.display = 'none'
			confirmBtn.style.display = 'inline-flex'
		}
	}

	function handleCreateTabNext() {
		const tabOrder = ['details', 'inputs', 'parameters', 'outputs']
		const currentIndex = tabOrder.indexOf(projectCreateState.activeTab)

		if (currentIndex < tabOrder.length - 1) {
			switchCreateTab(tabOrder[currentIndex + 1])
		}
	}

	function handleCreateTabBack() {
		const tabOrder = ['details', 'inputs', 'parameters', 'outputs']
		const currentIndex = tabOrder.indexOf(projectCreateState.activeTab)

		if (currentIndex > 0) {
			switchCreateTab(tabOrder[currentIndex - 1])
		}
	}

	async function reloadSpecFromDisk(showMessage = true) {
		if (!projectEditorState.projectPath) return
		try {
			const payload = await invoke('load_project_editor', {
				projectId: projectEditorState.projectId,
				projectPath: projectEditorState.projectPath,
			})
			projectEditorState.metadata = payload.metadata
			projectEditorState.selectedAssets = new Set(
				(payload.metadata.assets || []).map((asset) => asset.replace(/\\/g, '/')),
			)
			renderProjectEditor(payload)
			if (showMessage) {
				const statusEl = document.getElementById('project-edit-status')
				if (statusEl) {
					statusEl.textContent = 'Detected external project.yaml changes. Editor reloaded.'
					statusEl.style.color = '#28a745'
				}
			}
		} catch (error) {
			console.error('Failed to reload project metadata:', error)
		}
	}

	async function handleReloadProjectSpec() {
		await reloadSpecFromDisk(false)
		const statusEl = document.getElementById('project-edit-status')
		if (statusEl) {
			statusEl.textContent = 'Reloaded project.yaml from disk.'
			statusEl.style.color = '#666'
		}
		await checkSpecDigest(true)
	}

	async function checkSpecDigest(force = false) {
		if (!projectEditorState.projectPath) return
		try {
			const digest = await invoke('get_project_spec_digest', {
				projectPath: projectEditorState.projectPath,
			})
			const digestStr = digest ?? null
			if (force) {
				projectEditorState.lastSpecDigest = digestStr
				return
			}
			if (projectEditorState.skipNextDigestReload) {
				projectEditorState.skipNextDigestReload = false
				projectEditorState.lastSpecDigest = digestStr
				return
			}
			if (
				projectEditorState.lastSpecDigest &&
				digestStr &&
				digestStr !== projectEditorState.lastSpecDigest
			) {
				await reloadSpecFromDisk(true)
			}
			projectEditorState.lastSpecDigest = digestStr
		} catch (error) {
			console.error('Failed to compute project.yaml digest:', error)
		}
	}

	function startSpecDigestPolling() {
		if (projectEditorState.specDigestTimer) {
			clearInterval(projectEditorState.specDigestTimer)
		}
		projectEditorState.specDigestTimer = setInterval(() => {
			checkSpecDigest(false)
		}, 4000)
	}

	function stopSpecDigestPolling() {
		if (projectEditorState.specDigestTimer) {
			clearInterval(projectEditorState.specDigestTimer)
			projectEditorState.specDigestTimer = null
		}
	}

	function handleLeaveProjectEditor() {
		stopSpecDigestPolling()
	}

	function setOperationButtonsDisabled(disabled) {
		const launchBtn = document.getElementById('project-edit-launch-jupyter-btn')
		const resetBtn = document.getElementById('project-edit-reset-jupyter-btn')
		if (launchBtn) launchBtn.disabled = disabled
		if (resetBtn) resetBtn.disabled = disabled
	}

	function setButtonLoadingState(button, isLoading, loadingLabel) {
		if (!button) return
		if (isLoading) {
			if (!button.dataset.originalLabel) {
				button.dataset.originalLabel = button.textContent
			}
			button.dataset.loading = 'true'
			button.classList.add('btn-loading')
			button.disabled = true
			const label = loadingLabel || button.dataset.originalLabel || ''
			button.innerHTML =
				'<span class="button-spinner"></span><span class="button-spinner-label">' +
				label +
				'</span>'
		} else {
			button.classList.remove('btn-loading')
			button.disabled = false
			if (button.dataset.originalLabel) {
				button.textContent = button.dataset.originalLabel
				delete button.dataset.originalLabel
			}
			delete button.dataset.loading
		}
	}

	function updateOperationModal(message) {
		const textEl = document.getElementById('operation-modal-text')
		if (textEl) {
			textEl.textContent = message
		}
	}

	function showOperationModal(message) {
		operationModalDepth += 1
		const modal = document.getElementById('operation-modal')
		if (modal) {
			modal.style.display = 'flex'
		}
		setOperationButtonsDisabled(true)
		updateOperationModal(message)
	}

	function hideOperationModal() {
		if (operationModalDepth > 0) {
			operationModalDepth -= 1
		}
		if (operationModalDepth === 0) {
			const modal = document.getElementById('operation-modal')
			if (modal) {
				modal.style.display = 'none'
			}
			setOperationButtonsDisabled(false)
		}
	}

	async function handleDeleteProject(project) {
		const name = project.name || project.project_path
		const prompt = project.orphaned
			? `Are you sure you want to delete the folder "${project.project_path}"? This cannot be undone.`
			: `Are you sure you want to delete project "${name}"? This will remove the project directory and cannot be undone.`

		const confirmed = await confirmWithDialog(prompt, {
			title: 'Delete Project',
			type: 'warning',
		})

		if (!confirmed) return

		const modalMsg = project.orphaned
			? 'Deleting project folder...'
			: 'Deleting project (database + folder)...'
		showOperationModal(modalMsg)

		try {
			if (project.orphaned) {
				await invoke('delete_project_folder', { projectPath: project.project_path })
			} else if (project.id !== null && project.id !== undefined) {
				await invoke('delete_project', { projectId: project.id })
			}
			await loadProjects()
		} catch (error) {
			alert(`Error deleting project: ${error}`)
		} finally {
			hideOperationModal()
		}
	}

	async function loadProjects() {
		try {
			const projects = await invoke('get_projects')
			const projectsContainer = document.getElementById('projects-list')

			// Update counts
			const projectsCount = document.getElementById('projects-count')
			const pipelinesCount = document.getElementById('pipelines-count')

			if (projectsCount) projectsCount.textContent = projects?.length || 0
			if (pipelinesCount) pipelinesCount.textContent = 0 // TODO: Load actual pipelines

			// Render projects
			if (!projects || projects.length === 0) {
				if (projectsContainer) {
					projectsContainer.innerHTML =
						'<p style="color: #666; padding: 20px; text-align: center;">No projects imported yet.</p>'
				}
			} else {
				if (projectsContainer) {
					projectsContainer.innerHTML = ''

					projects.forEach((project) => {
						const card = document.createElement('div')
						card.className = 'project-card'

						const info = document.createElement('div')
						info.className = 'project-info'

						const title = document.createElement('h3')
						title.textContent = project.name || '(unnamed project)'
						if (project.orphaned) {
							const badge = document.createElement('span')
							badge.className = 'project-badge project-badge-orphan'
							badge.textContent = 'Unregistered folder'
							title.appendChild(badge)
						}
						info.appendChild(title)

						const author = document.createElement('p')
						author.innerHTML = `<strong>Author:</strong> ${project.author ?? '—'}`
						info.appendChild(author)

						const workflow = document.createElement('p')
						workflow.innerHTML = `<strong>Workflow:</strong> ${project.workflow ?? '—'}`
						info.appendChild(workflow)

						const template = document.createElement('p')
						template.innerHTML = `<strong>Template:</strong> ${project.template ?? '—'}`
						info.appendChild(template)

						const path = document.createElement('p')
						path.innerHTML = `<strong>Path:</strong> ${project.project_path}`
						info.appendChild(path)

						const created = document.createElement('p')
						const meta = project.created_at
							? `${project.source} | Created: ${project.created_at}`
							: project.source
						created.innerHTML = `<strong>Source:</strong> ${meta}`
						info.appendChild(created)

						card.appendChild(info)

						const actions = document.createElement('div')
						actions.className = 'project-card-actions'

						const editBtn = document.createElement('button')
						editBtn.className = 'secondary-btn'
						editBtn.textContent = project.orphaned ? 'Open in Editor' : 'Edit'
						editBtn.addEventListener('click', async () => {
							if (project.orphaned) {
								await openProjectEditor({ projectPath: project.project_path })
							} else if (project.id !== null && project.id !== undefined) {
								await openProjectEditor({ projectId: project.id })
							}
						})
						actions.appendChild(editBtn)

						const openBtn = document.createElement('button')
						openBtn.className = 'open-folder-btn'
						openBtn.textContent = 'Open Folder'
						openBtn.addEventListener('click', async () => {
							try {
								await invoke('open_folder', { path: project.project_path })
							} catch (error) {
								alert(`Error opening folder: ${error}`)
							}
						})
						actions.appendChild(openBtn)

						const deleteBtn = document.createElement('button')
						deleteBtn.className = 'delete-btn'
						deleteBtn.textContent = 'Delete'
						deleteBtn.addEventListener('click', async () => {
							await handleDeleteProject(project)
						})
						actions.appendChild(deleteBtn)

						card.appendChild(actions)
						projectsContainer.appendChild(card)
					})
				}
			}
		} catch (error) {
			console.error('Error loading projects:', error)
		}
	}

	async function importProject(overwrite = false) {
		const input = document.getElementById('project-url-input')
		const url = input.value.trim()

		if (!url) {
			alert('Please enter a GitHub URL')
			return
		}

		console.log('Import button clicked, URL:', url)

		const btn = document.getElementById('import-project-btn')
		btn.disabled = true
		btn.textContent = 'Importing...'

		try {
			console.log('Calling invoke with:', { url, overwrite })
			const result = await invoke('import_project', { url, overwrite })
			console.log('Import successful:', result)
			input.value = ''
			await loadProjects()
			alert('Project imported successfully!')
		} catch (error) {
			console.error('Import error:', error)
			const errorStr = String(error)
			if (errorStr.includes('already exists')) {
				const shouldOverwrite = confirm(`${errorStr}\n\nDo you want to overwrite it?`)
				if (shouldOverwrite) {
					btn.disabled = false
					btn.textContent = 'Import'
					await importProject(true)
					return
				}
			} else {
				alert(`Error importing project: ${errorStr}`)
			}
		} finally {
			console.log('Import finally block')
			btn.disabled = false
			btn.textContent = 'Import'
		}
	}

	async function fetchDefaultProjectPath(name) {
		const trimmed = name ? name.trim() : ''
		try {
			return await invoke('get_default_project_path', {
				name: trimmed ? trimmed : null,
			})
		} catch (error) {
			console.error('Failed to fetch default project path:', error)
			return ''
		}
	}

	async function showCreateProjectModal() {
		const modal = document.getElementById('create-project-modal')
		const nameInput = document.getElementById('new-project-name')
		const templateSelect = document.getElementById('new-project-template')
		const pathInput = document.getElementById('new-project-path')
		const versionInput = document.getElementById('new-project-version')

		if (nameInput) {
			nameInput.value = ''
			nameInput.autocapitalize = 'none'
			nameInput.autocorrect = 'off'
			nameInput.spellcheck = false
		}
		if (templateSelect) {
			templateSelect.value = ''
			templateSelect.onchange = () => scheduleWizardPreview()
		}
		if (versionInput) {
			versionInput.value = '1.0.0'
			versionInput.oninput = () => scheduleWizardPreview()
		}
		projectCreateState.selectedDir = null
		projectCreateState.usingDefault = true

		// Load available templates from CLI
		let availableExamples = {}
		if (templateSelect) {
			try {
				const examples = await invoke('get_available_project_examples')
				availableExamples = examples || {}
				let optionsHtml = '<option value="">Blank Project</option>'

				if (Object.keys(examples).length > 0) {
					Object.entries(examples).forEach(([key, example]) => {
						const displayName = example.name || key
						optionsHtml += `<option value="${key}">${displayName}</option>`
					})
				}

				templateSelect.innerHTML = optionsHtml
			} catch (error) {
				console.warn('Failed to load project examples:', error)
				templateSelect.innerHTML = '<option value="">Blank Project</option>'
			}

			// Handle template selection changes
			templateSelect.onchange = async () => {
				const selectedTemplate = templateSelect.value
				const blankOptions = document.getElementById('blank-project-options')

				if (selectedTemplate && availableExamples[selectedTemplate]) {
					// Hide blank project options
					if (blankOptions) blankOptions.style.display = 'none'
					await loadTemplateIntoWizard(availableExamples[selectedTemplate])
				} else {
					// Show blank project options
					if (blankOptions) blankOptions.style.display = 'block'
					resetWizardToBlank()
				}
				scheduleWizardPreview()
			}
		}

		const defaultPath = await fetchDefaultProjectPath('')
		projectCreateState.defaultDir = defaultPath
		if (pathInput) {
			pathInput.value = defaultPath
		}

		// Initialize form state
		projectCreateState.specData = { parameters: [], inputs: [], outputs: [] }
		projectCreateState.activeTab = 'details'

		// Initialize inputs tab
		ensureCreateSpecForm(CREATE_TAB_CONFIG.inputs)
		projectCreateState.specForm?.setSpec(projectCreateState.specData)

		// Switch to Details tab
		switchCreateTab('details')
		updateTabCounts()

		// Setup tab click handlers
		setupCreateTabHandlers()

		// Setup option card handlers
		setupOptionCardHandlers()

		// Initialize footer buttons
		updateCreateFooter()

		// Generate initial preview
		scheduleWizardPreview()

		modal.style.display = 'flex'
		document.body.classList.add('modal-open')
		setTimeout(() => nameInput?.focus(), 100)
	}

	function setupCreateTabHandlers() {
		document.querySelectorAll('.create-tab').forEach((tab) => {
			// Remove old listeners by cloning
			const newTab = tab.cloneNode(true)
			tab.parentNode.replaceChild(newTab, tab)

			newTab.addEventListener('click', () => {
				switchCreateTab(newTab.dataset.tab)
			})
		})

		// Setup navigation button handlers
		const cancelBtn = document.getElementById('create-project-cancel')
		const backBtn = document.getElementById('create-project-back')
		const nextBtn = document.getElementById('create-project-next')
		const confirmBtn = document.getElementById('create-project-confirm')

		if (cancelBtn) {
			cancelBtn.onclick = () => hideCreateProjectModal()
		}
		if (backBtn) {
			backBtn.onclick = () => handleCreateTabBack()
		}
		if (nextBtn) {
			nextBtn.onclick = () => handleCreateTabNext()
		}
		if (confirmBtn) {
			confirmBtn.onclick = () => createProjectFromModal()
		}
	}

	function setupOptionCardHandlers() {
		document.querySelectorAll('.option-card').forEach((card) => {
			card.addEventListener('click', () => {
				if (card.classList.contains('disabled')) return

				// Get parent group to only deselect siblings of same type
				const group = card.closest('.option-group')
				const cardType = card.dataset.type

				if (group && cardType) {
					// Deselect all cards of the same type within this group
					group.querySelectorAll(`.option-card[data-type="${cardType}"]`).forEach((c) => {
						c.classList.remove('active')
					})
				}

				card.classList.add('active')

				// Update preview when selection changes
				scheduleWizardPreview()
			})
		})
	}

	function hideCreateProjectModal() {
		const modal = document.getElementById('create-project-modal')
		modal.style.display = 'none'
		document.body.classList.remove('modal-open')
	}

	function validateProjectName(name) {
		const trimmed = name.trim()

		// Cannot be empty
		if (trimmed.length === 0) {
			return { valid: false, error: 'Project name cannot be empty' }
		}

		// Cannot be . or ..
		if (trimmed === '.' || trimmed === '..') {
			return { valid: false, error: 'Project name cannot be "." or ".."' }
		}

		// Cannot contain / or \
		if (trimmed.includes('/') || trimmed.includes('\\')) {
			return { valid: false, error: 'Project name cannot contain / or \\' }
		}

		return { valid: true, error: null }
	}

	async function handleProjectNameInputChange() {
		const nameInput = document.getElementById('new-project-name')
		const errorEl = document.getElementById('project-name-error')
		const nameValue = nameInput.value
		const validation = validateProjectName(nameValue)

		// Show/hide error
		if (!validation.valid) {
			nameInput.classList.add('invalid')
			errorEl.textContent = validation.error
			errorEl.style.display = 'block'
		} else {
			nameInput.classList.remove('invalid')
			errorEl.style.display = 'none'
		}

		// Update path if using default
		if (projectCreateState.usingDefault && validation.valid) {
			const defaultPath = await fetchDefaultProjectPath(nameValue.trim())
			projectCreateState.defaultDir = defaultPath
			document.getElementById('new-project-path').value = defaultPath
		}

		updateCreateSpecSummary()
	}

	async function chooseProjectDirectory() {
		try {
			const selection = await open({ directory: true, multiple: false })
			if (!selection) {
				return
			}

			const chosen = Array.isArray(selection) ? selection[0] : selection
			if (!chosen) {
				return
			}

			projectCreateState.selectedDir = chosen
			projectCreateState.usingDefault = false
			document.getElementById('new-project-path').value = chosen
			scheduleWizardPreview()
		} catch (error) {
			console.error('Folder selection cancelled or failed:', error)
		}
	}

	async function resetProjectDirectory() {
		projectCreateState.selectedDir = null
		projectCreateState.usingDefault = true
		const nameValue = document.getElementById('new-project-name').value.trim()
		const defaultPath = await fetchDefaultProjectPath(nameValue)
		projectCreateState.defaultDir = defaultPath
		document.getElementById('new-project-path').value = defaultPath
		scheduleWizardPreview()
	}

	async function createProjectFromModal() {
		const nameInput = document.getElementById('new-project-name')
		const templateSelect = document.getElementById('new-project-template')
		const confirmBtn = document.getElementById('create-project-confirm')
		const versionInput = document.getElementById('new-project-version')

		const projectName = nameInput.value
		const validation = validateProjectName(projectName)

		if (!validation.valid) {
			await dialog.message(validation.error, {
				title: 'Invalid Project Name',
				type: 'warning',
			})
			// Switch to details tab to show error
			switchCreateTab('details')
			nameInput.focus()
			return
		}

		// Validate destination path
		let destination = document.getElementById('new-project-path').value.trim()
		if (!destination) {
			destination = await fetchDefaultProjectPath(projectName.trim())
			document.getElementById('new-project-path').value = destination
			projectCreateState.defaultDir = destination
			projectCreateState.selectedDir = null
		}

		if (!destination) {
			await dialog.message(
				'Unable to determine a destination folder. Please choose one manually.',
				{
					title: 'Destination Required',
					type: 'warning',
				},
			)
			switchCreateTab('details')
			return
		}

		const example = templateSelect.value || null
		const directory = projectCreateState.selectedDir
		const versionValue = versionInput ? versionInput.value.trim() || '1.0.0' : '1.0.0'
		const spec = getCreateSpecPayload()
		const hasContract =
			spec.parameters.length > 0 || spec.inputs.length > 0 || spec.outputs.length > 0

		// Get scripting language option (only for blank projects)
		const selectedScriptCard = document.querySelector(
			'#blank-project-options .option-card.active[data-type="script"]',
		)
		const scriptLang = selectedScriptCard ? selectedScriptCard.dataset.value : 'none'
		const createPythonScript = !example && scriptLang === 'python'
		const scriptName = createPythonScript ? 'process.py' : null

		confirmBtn.disabled = true
		confirmBtn.textContent = 'Creating...'

		try {
			const project = await invoke('create_project', {
				name: projectName.trim(),
				example,
				directory: directory || null,
				createPythonScript: createPythonScript,
				scriptName: scriptName,
			})
			if (hasContract) {
				try {
					const editorPayload = await invoke('load_project_editor', {
						projectId: project.id,
					})
					const metadata = editorPayload.metadata
					const payload = buildSpecSavePayload({
						name: metadata.name || projectName.trim(),
						author: metadata.author,
						workflow: metadata.workflow,
						template: metadata.template || null,
						assets: metadata.assets || [],
						version: versionValue,
						spec,
					})
					await invoke('save_project_editor', {
						projectId: project.id,
						projectPath: editorPayload.project_path,
						payload,
					})
				} catch (specError) {
					console.error('Failed to apply project contract during creation:', specError)
				}
			}
			hideCreateProjectModal()
			await loadProjects()
			await openProjectEditor({ projectId: project.id })
		} catch (error) {
			const errorStr = String(error)
			console.error('Create project error:', errorStr)
			const targetPath = directory || projectCreateState.defaultDir
			if (errorStr.includes('project.yaml already exists') && targetPath) {
				const shouldOpen = confirm(`${errorStr}\n\nOpen the project editor for ${targetPath}?`)
				if (shouldOpen) {
					hideCreateProjectModal()
					await openProjectEditor({ projectPath: targetPath })
				}
			} else {
				await dialog.message(`Error creating project: ${errorStr}`, {
					title: 'Error',
					type: 'error',
				})
			}
		} finally {
			confirmBtn.disabled = false
			confirmBtn.textContent = 'Create Project'
		}
	}

	async function openProjectEditor({ projectId = null, projectPath = null }) {
		if (!projectId && !projectPath) {
			alert('Unable to open project editor: missing project identifier')
			return
		}

		try {
			const payload = await invoke('load_project_editor', {
				projectId,
				projectPath,
			})

			projectEditorState.projectId = payload.project_id ?? null
			projectEditorState.projectPath = payload.project_path
			projectEditorState.metadata = payload.metadata
			projectEditorState.selectedAssets = new Set(
				(payload.metadata.assets || []).map((asset) => asset.replace(/\\/g, '/')),
			)
			projectEditorState.treeNodes = new Map()
			projectEditorState.jupyter = {
				running: false,
				port: null,
				url: null,
				token: null,
			}

			renderProjectEditor(payload)
			await refreshJupyterStatus(true)
			await checkSpecDigest(true)
			startSpecDigestPolling()
			navigateTo('project-edit')
		} catch (error) {
			console.error('Failed to load project editor:', error)
			alert(`Error loading project: ${error}`)
		}
	}

	function renderProjectEditor(data) {
		const pathEl = document.getElementById('project-edit-path')
		pathEl.textContent = data.project_path || ''
		clearEditorPreview('Preview updates as you edit.')

		document.getElementById('project-edit-name').value = data.metadata.name || ''
		document.getElementById('project-edit-author').value = data.metadata.author || ''
		document.getElementById('project-edit-workflow').value = data.metadata.workflow || ''
		document.getElementById('project-edit-template').value = data.metadata.template || ''
		document.getElementById('project-edit-version').value = data.metadata.version || ''

		const previewFields = [
			'project-edit-author',
			'project-edit-workflow',
			'project-edit-template',
			'project-edit-version',
		]
		previewFields.forEach((id) => {
			const el = document.getElementById(id)
			if (el && !el.dataset.previewBound) {
				el.addEventListener('input', () => scheduleEditorPreview())
				el.dataset.previewBound = 'true'
			}
		})

		ensureEditorSpecForm()
		projectEditorState.specData = {
			parameters: data.metadata.parameters || [],
			inputs: data.metadata.inputs || [],
			outputs: data.metadata.outputs || [],
		}
		if (projectEditorState.specForm) {
			projectEditorState.specForm.setSpec(projectEditorState.specData)
		}

		const treeContainer = document.getElementById('project-file-tree')
		treeContainer.innerHTML = ''
		projectEditorState.treeNodes.clear()

		if (!data.file_tree || data.file_tree.length === 0) {
			treeContainer.innerHTML =
				'<p style="color: #666; font-size: 13px;">No files found in this folder.</p>'
		} else {
			renderProjectTree(data.file_tree, treeContainer, null)
			projectEditorState.selectedAssets.forEach((assetPath) => {
				const info = projectEditorState.treeNodes.get(assetPath)
				if (!info) return
				setNodeAndChildren(assetPath, true)
				updateAncestorStates(info.parent)
			})
		}

		const statusEl = document.getElementById('project-edit-status')
		if (data.has_project_yaml) {
			statusEl.textContent = ''
			statusEl.style.color = '#666'
		} else {
			statusEl.textContent = 'No project.yaml detected. Saving will create one automatically.'
			statusEl.style.color = '#ff9800'
		}

		updateJupyterControls()
		updateEditorSpecSummary()
	}

	function renderProjectTree(nodes, container, parentPath) {
		nodes.forEach((node) => {
			const path = node.path
			if (node.is_dir) {
				if (node.name === '.venv') {
					return
				}
				const details = document.createElement('details')
				details.open = true
				const summary = document.createElement('summary')
				summary.className = 'tree-node'

				const children = Array.isArray(node.children) ? node.children : []

				const checkbox = document.createElement('input')
				checkbox.type = 'checkbox'
				checkbox.dataset.path = path
				checkbox.addEventListener('click', (e) => e.stopPropagation())
				checkbox.addEventListener('change', (e) => {
					setNodeAndChildren(path, e.target.checked)
					const info = projectEditorState.treeNodes.get(path)
					if (info) {
						updateAncestorStates(info.parent)
					}
				})

				const label = document.createElement('span')
				label.textContent = `${node.name}/`
				summary.appendChild(checkbox)
				summary.appendChild(label)
				details.appendChild(summary)

				const childrenContainer = document.createElement('div')
				details.appendChild(childrenContainer)
				container.appendChild(details)

				projectEditorState.treeNodes.set(path, {
					checkbox,
					isDir: true,
					parent: parentPath,
					children: children.map((child) => child.path),
				})

				renderProjectTree(children, childrenContainer, path)
			} else {
				const leaf = document.createElement('div')
				leaf.className = 'tree-leaf'
				const checkbox = document.createElement('input')
				checkbox.type = 'checkbox'
				checkbox.dataset.path = path
				checkbox.addEventListener('change', (e) => {
					if (e.target.checked) {
						projectEditorState.selectedAssets.add(path)
					} else {
						projectEditorState.selectedAssets.delete(path)
					}
					const info = projectEditorState.treeNodes.get(path)
					if (info) {
						info.checkbox.indeterminate = false
						updateAncestorStates(info.parent)
					}
				})

				const label = document.createElement('span')
				label.textContent = node.name
				leaf.appendChild(checkbox)
				leaf.appendChild(label)
				container.appendChild(leaf)

				projectEditorState.treeNodes.set(path, {
					checkbox,
					isDir: false,
					parent: parentPath,
					children: [],
				})
			}
		})
	}

	function setNodeAndChildren(path, isChecked) {
		const node = projectEditorState.treeNodes.get(path)
		if (!node) return

		node.checkbox.checked = isChecked
		node.checkbox.indeterminate = false

		if (node.isDir) {
			node.children.forEach((childPath) => {
				setNodeAndChildren(childPath, isChecked)
			})
		} else if (isChecked) {
			projectEditorState.selectedAssets.add(path)
		} else {
			projectEditorState.selectedAssets.delete(path)
		}
		scheduleEditorPreview()
	}

	function updateAncestorStates(startPath) {
		let currentPath = startPath
		while (currentPath) {
			const node = projectEditorState.treeNodes.get(currentPath)
			if (!node) break
			if (!node.isDir) {
				currentPath = node.parent
				continue
			}

			let allChecked = true
			let anyChecked = false
			node.children.forEach((childPath) => {
				const childNode = projectEditorState.treeNodes.get(childPath)
				if (!childNode) return
				if (childNode.checkbox.indeterminate) {
					anyChecked = true
					allChecked = false
				} else if (childNode.checkbox.checked) {
					anyChecked = true
				} else {
					allChecked = false
				}
			})

			node.checkbox.checked = anyChecked && allChecked
			node.checkbox.indeterminate = anyChecked && !allChecked
			currentPath = node.parent
		}
	}

	function updateJupyterControls() {
		const button = document.getElementById('project-edit-launch-jupyter-btn')
		const statusRow = document.getElementById('project-jupyter-status')
		if (!button) return

		const isLoading = button.dataset.loading === 'true'
		if (!isLoading) {
			button.textContent = projectEditorState.jupyter.running ? 'Stop Jupyter' : 'Launch Jupyter'
		}

		if (!statusRow) return

		if (projectEditorState.jupyter.running) {
			let linkUrl =
				projectEditorState.jupyter.url ||
				(projectEditorState.jupyter.port
					? `http://localhost:${projectEditorState.jupyter.port}`
					: null)

			// Append token if available
			if (linkUrl && projectEditorState.jupyter.token) {
				const separator = linkUrl.includes('?') ? '&' : '?'
				linkUrl = `${linkUrl}${separator}token=${projectEditorState.jupyter.token}`
			}

			if (linkUrl) {
				statusRow.style.display = 'block'
				statusRow.innerHTML = ''
				statusRow.append('Running at ')
				const linkButton = document.createElement('button')
				linkButton.id = 'jupyter-open-link'
				linkButton.className = 'link-button'
				linkButton.type = 'button'
				// Display URL without token for cleaner UI
				const displayUrl = linkUrl.split('?')[0]
				linkButton.textContent = `🔗 ${displayUrl}`
				linkButton.addEventListener('click', async () => {
					console.log('[Jupyter] Opening lab URL:', linkUrl)
					await openInExternalBrowser(linkUrl)
				})
				statusRow.appendChild(linkButton)
			} else {
				statusRow.style.display = 'block'
				statusRow.textContent = 'Jupyter server is running.'
			}
		} else {
			statusRow.style.display = 'none'
			statusRow.innerHTML = ''
		}
	}

	async function refreshJupyterStatus(showMessage = false) {
		if (!projectEditorState.projectPath) return
		const statusEl = document.getElementById('project-edit-status')

		try {
			const result = await invoke('get_jupyter_status', {
				projectPath: projectEditorState.projectPath,
			})
			projectEditorState.jupyter.running = !!result.running
			projectEditorState.jupyter.port = result.port ?? null
			projectEditorState.jupyter.url = result.url ?? null
			projectEditorState.jupyter.token = result.token ?? null
			updateJupyterControls()
			if (showMessage) {
				if (projectEditorState.jupyter.running) {
					const linkUrl =
						projectEditorState.jupyter.url ||
						(projectEditorState.jupyter.port
							? `http://localhost:${projectEditorState.jupyter.port}`
							: null)
					statusEl.textContent = linkUrl
						? `Jupyter is running at ${linkUrl}.`
						: 'Jupyter server is running.'
					statusEl.style.color = '#28a745'
				} else {
					statusEl.textContent = 'Jupyter server is not running.'
					statusEl.style.color = '#666'
				}
			}
		} catch (error) {
			console.error('Failed to fetch Jupyter status:', error)
			if (showMessage) {
				statusEl.textContent = `Unable to determine Jupyter status: ${error}`
				statusEl.style.color = '#dc3545'
			}
		}
	}

	async function handleSaveProjectEditor() {
		if (!projectEditorState.projectPath) {
			alert('Select or create a project first')
			return
		}

		const statusEl = document.getElementById('project-edit-status')
		statusEl.textContent = ''
		statusEl.style.color = '#666'

		const nameValue = document.getElementById('project-edit-name').value.trim()
		const authorInputEl = document.getElementById('project-edit-author')
		const authorValue = authorInputEl.value.trim()
		const workflowValue = document.getElementById('project-edit-workflow').value.trim()
		const templateValue = document.getElementById('project-edit-template').value.trim()
		const versionValue = document.getElementById('project-edit-version').value.trim()

		if (!nameValue) {
			alert('Project name cannot be empty')
			return
		}

		if (!workflowValue) {
			alert('Workflow cannot be empty')
			return
		}

		if (authorValue && !isLikelyEmail(authorValue)) {
			statusEl.textContent = 'Please enter a valid email address.'
			statusEl.style.color = '#dc3545'
			authorInputEl.focus()
			return
		}

		statusEl.textContent = 'Saving project...'
		statusEl.style.color = '#666'

		try {
			const assets = Array.from(projectEditorState.selectedAssets)
			const spec = getEditorSpecPayload()
			const payload = buildSpecSavePayload({
				name: nameValue,
				author: authorValue,
				workflow: workflowValue,
				template: templateValue,
				assets,
				version: versionValue,
				spec,
			})
			projectEditorState.skipNextDigestReload = true

			const saved = await invoke('save_project_editor', {
				projectId: projectEditorState.projectId,
				projectPath: projectEditorState.projectPath,
				payload,
			})
			projectEditorState.projectId = saved.id
			projectEditorState.projectPath = saved.project_path
			projectEditorState.metadata = {
				...(projectEditorState.metadata || {}),
				name: payload.name,
				author: payload.author,
				workflow: payload.workflow,
				template: payload.template,
				version: payload.version,
				parameters: payload.parameters,
				inputs: payload.inputs,
				outputs: payload.outputs,
				assets: payload.assets,
			}
			statusEl.textContent = '✅ Project saved'
			statusEl.style.color = '#28a745'
			await loadProjects()
			await checkSpecDigest(true)
		} catch (error) {
			console.error('Failed to save project:', error)
			statusEl.textContent = `Error saving project: ${error}`
			statusEl.style.color = '#dc3545'
		}
	}

	async function handleOpenProjectFolder() {
		if (!projectEditorState.projectPath) {
			alert('Select a project first')
			return
		}

		try {
			await invoke('open_folder', { path: projectEditorState.projectPath })
		} catch (error) {
			console.error('Failed to open project folder:', error)
			alert(`Failed to open folder: ${error}`)
		}
	}

	async function handleLaunchJupyter() {
		const launchBtn = document.getElementById('project-edit-launch-jupyter-btn')
		const resetBtn = document.getElementById('project-edit-reset-jupyter-btn')

		if (!projectEditorState.projectPath) {
			alert('Select a project first')
			return
		}

		const statusEl = document.getElementById('project-edit-status')
		statusEl.style.color = '#666'

		if (projectEditorState.jupyter.running) {
			const message = 'Stopping Jupyter server...\nCommand: uv run --python .venv jupyter lab stop'
			showOperationModal(message)
			setButtonLoadingState(launchBtn, true, 'Stopping...')
			if (resetBtn) resetBtn.disabled = true
			statusEl.textContent = 'Stopping Jupyter (jupyter lab stop)...'
			try {
				const result = await invoke('stop_jupyter', {
					projectPath: projectEditorState.projectPath,
				})
				projectEditorState.jupyter.running = !!result.running
				projectEditorState.jupyter.port = result.port ?? null
				projectEditorState.jupyter.url = result.url ?? null
				projectEditorState.jupyter.token = result.token ?? null
				updateJupyterControls()
				statusEl.textContent = 'Jupyter server stopped.'
				statusEl.style.color = '#666'
				await refreshJupyterStatus(false)
			} catch (error) {
				console.error('Failed to stop Jupyter:', error)
				statusEl.textContent = `Error stopping Jupyter: ${error}`
				statusEl.style.color = '#dc3545'
			} finally {
				setButtonLoadingState(launchBtn, false)
				if (resetBtn) resetBtn.disabled = false
				updateJupyterControls()
				hideOperationModal()
			}
			return
		}

		const launchMessage =
			'Launching Jupyter...\nCommands:\n- uv pip install -U --python .venv jupyterlab bioscript\n- uv run --python .venv jupyter lab'
		showOperationModal(launchMessage)
		setButtonLoadingState(launchBtn, true, 'Starting...')
		if (resetBtn) resetBtn.disabled = true
		statusEl.textContent =
			'Launching Jupyter... (uv pip install -U --python .venv jupyterlab bioscript)'

		try {
			const result = await invoke('launch_jupyter', {
				projectPath: projectEditorState.projectPath,
				pythonVersion: null,
			})
			projectEditorState.jupyter.running = !!result.running
			projectEditorState.jupyter.port = result.port ?? null
			projectEditorState.jupyter.url = result.url ?? null
			projectEditorState.jupyter.token = result.token ?? null
			updateJupyterControls()

			const launchUrl =
				projectEditorState.jupyter.url ||
				(projectEditorState.jupyter.port
					? `http://localhost:${projectEditorState.jupyter.port}`
					: null)
			if (launchUrl) {
				updateOperationModal('Opening browser...')
				await openInExternalBrowser(launchUrl)
				statusEl.textContent = `Jupyter running at ${launchUrl}`
				statusEl.style.color = '#28a745'
			} else {
				statusEl.textContent = 'Jupyter server started.'
				statusEl.style.color = '#28a745'
			}
			await refreshJupyterStatus(false)
		} catch (error) {
			console.error('Failed to launch Jupyter:', error)
			statusEl.textContent = `Error launching Jupyter: ${error}`
			statusEl.style.color = '#dc3545'
		} finally {
			setButtonLoadingState(launchBtn, false)
			if (resetBtn) resetBtn.disabled = false
			updateJupyterControls()
			hideOperationModal()
		}
	}

	async function handleResetJupyter() {
		const resetBtn = document.getElementById('project-edit-reset-jupyter-btn')
		const launchBtn = document.getElementById('project-edit-launch-jupyter-btn')
		if (!projectEditorState.projectPath) {
			alert('Select a project first')
			return
		}

		const confirmed = await dialog.confirm(
			'Resetting will delete and recreate the project virtual environment. This will remove any additional packages you installed. Continue?',
			{ title: 'Reset Jupyter Environment', type: 'warning' },
		)

		if (!confirmed) {
			return
		}

		const statusEl = document.getElementById('project-edit-status')
		statusEl.textContent = 'Resetting Jupyter environment...'
		statusEl.style.color = '#666'
		setButtonLoadingState(resetBtn, true, 'Resetting...')
		if (launchBtn) launchBtn.disabled = true
		const modalMessage =
			'Resetting Jupyter environment...\nSteps:\n- Remove existing .venv\n- uv pip install -U --python .venv jupyterlab bioscript'
		showOperationModal(modalMessage)

		try {
			const result = await invoke('reset_jupyter', {
				projectPath: projectEditorState.projectPath,
				pythonVersion: null,
			})
			projectEditorState.jupyter.running = !!result.status.running
			projectEditorState.jupyter.port = result.status.port ?? null
			projectEditorState.jupyter.url = result.status.url ?? null
			projectEditorState.jupyter.token = result.status.token ?? null
			updateJupyterControls()
			statusEl.textContent = result.message || 'Jupyter environment reset. The server is stopped.'
			statusEl.style.color = '#28a745'
			await refreshJupyterStatus(false)
		} catch (error) {
			console.error('Failed to reset Jupyter:', error)
			statusEl.textContent = `Error resetting Jupyter: ${error}`
			statusEl.style.color = '#dc3545'
		} finally {
			setButtonLoadingState(resetBtn, false)
			if (launchBtn) launchBtn.disabled = false
			updateJupyterControls()
			hideOperationModal()
		}
	}

	function showCreatePipelineModal() {
		alert('Pipeline creation wizard coming soon! For now, use the CLI:\n\nbv pipeline create')
	}

	return {
		loadProjects,
		importProject,
		showCreateProjectModal,
		showCreatePipelineModal,
		hideCreateProjectModal,
		handleProjectNameInputChange,
		chooseProjectDirectory,
		resetProjectDirectory,
		createProjectFromModal,
		handleSaveProjectEditor,
		handleLaunchJupyter,
		handleResetJupyter,
		handleOpenProjectFolder,
		handleLeaveProjectEditor,
		handleReloadProjectSpec,
		handleCreateTabNext,
		handleCreateTabBack,
	}
}
