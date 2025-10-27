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

export function createProjectsModule({
	invoke,
	dialog,
	open,
	shellApi,
	navigateTo,
	addProjectAsPipelineStep = null,
}) {
	const projectEditorState = {
		projectId: null,
		projectPath: '',
		metadata: null,
		files: [],
		inputs: [],
		outputs: [],
		parameters: [],
		jupyter: {
			running: false,
			port: null,
			url: null,
			token: null,
		},
		editingItem: null,
		editingType: null,
		editingIndex: -1,
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

	// Legacy functions - kept for compatibility but no longer used
	function ensureEditorSpecForm(_section = 'parameters') {
		// No longer needed with new simple editor
	}

	function updateEditorCounts() {
		// No longer needed with new simple editor
	}

	function _updateEditorTitle() {
		// No longer needed with new simple editor
	}

	function switchEditorTab(_tabName) {
		// No longer needed with new simple editor
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
			renderSimpleProjectEditor(payload)
			if (showMessage) {
				const statusEl = document.getElementById('step-status-message')
				if (statusEl) {
					statusEl.textContent = 'Detected external project.yaml changes. Editor reloaded.'
					statusEl.style.color = '#10b981'
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

	function _startSpecDigestPolling() {
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
			const projectsContainer = document.getElementById('steps-list')

			// Update counts
			const stepsCountBadges = document.querySelectorAll('#steps-count, #steps-count-label')
			stepsCountBadges.forEach((badge) => {
				badge.textContent = projects?.length || 0
			})

			// Render steps (formerly projects)
			if (!projects || projects.length === 0) {
				if (projectsContainer) {
					projectsContainer.innerHTML =
						'<p style="color: #666; padding: 20px; text-align: center;">No steps yet. Create or import one to get started.</p>'
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

	async function importProjectFromFolder() {
		const folderPath = await dialog.open({
			directory: true,
			multiple: false,
			title: 'Select Project Folder',
		})

		if (!folderPath) {
			return
		}

		console.log('Import from folder selected:', folderPath)

		const btn = document.getElementById('import-folder-btn')
		btn.disabled = true
		btn.innerHTML = '⏳ Importing...'

		try {
			const result = await invoke('import_project_from_folder', {
				folder_path: folderPath,
			})
			console.log('Import from folder successful:', result)
			await loadProjects()
			alert(`Project "${result.name}" imported successfully!`)
		} catch (error) {
			console.error('Error importing from folder:', error)
			const errorStr = error.toString ? error.toString() : String(error)
			alert(`Error importing project: ${errorStr}`)
		} finally {
			btn.disabled = false
			btn.innerHTML = '📁 Import from Folder'
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

			// Check if we're adding this project as a step to a pipeline
			if (window._addingStepToPipeline && addProjectAsPipelineStep) {
				try {
					await addProjectAsPipelineStep(project.project_path, projectName.trim())
					// Clear the flag
					delete window._addingStepToPipeline
					// Don't open project editor, just reload pipelines
					console.log('Project added as step to pipeline')
				} catch (error) {
					console.error('Failed to add project as pipeline step:', error)
					// Still open the editor as fallback
					await openProjectEditor({ projectId: project.id })
				}
			} else {
				// Normal flow: open the project editor
				await openProjectEditor({ projectId: project.id })
			}
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

			// Use new simple editor
			renderSimpleProjectEditor(payload)
			navigateTo('project-edit')
		} catch (error) {
			console.error('Failed to load project editor:', error)
			alert(`Error loading project: ${error}`)
		}
	}

	function _renderProjectEditor(data) {
		const pathEl = document.getElementById('project-edit-path')
		pathEl.textContent = data.project_path || ''
		clearEditorPreview('Preview updates as you edit.')

		// Update header title
		const titleEl = document.getElementById('project-editor-title')
		if (titleEl) {
			titleEl.textContent = data.metadata.name || 'my-step'
		}

		// Populate form fields
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

		// Set up spec data
		projectEditorState.specData = {
			parameters: data.metadata.parameters || [],
			inputs: data.metadata.inputs || [],
			outputs: data.metadata.outputs || [],
		}

		// Initialize the spec form for the default tab (parameters)
		ensureEditorSpecForm('parameters')
		if (projectEditorState.specForm) {
			projectEditorState.specForm.setSpec(projectEditorState.specData)
		}

		// Update counts
		updateEditorCounts()

		// Set up tab navigation
		setupEditorTabHandlers()

		// Render file tree
		const treeContainer = document.getElementById('project-file-tree')
		treeContainer.innerHTML = ''
		projectEditorState.treeNodes.clear()

		if (!data.file_tree || data.file_tree.length === 0) {
			treeContainer.innerHTML = '<p class="empty-state">No files found in this folder.</p>'
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

	function setupEditorTabHandlers() {
		// Set up tab click handlers
		document.querySelectorAll('.editor-nav-tab').forEach((tab) => {
			// Remove old listeners by cloning
			const newTab = tab.cloneNode(true)
			tab.parentNode.replaceChild(newTab, tab)

			newTab.addEventListener('click', () => {
				switchEditorTab(newTab.dataset.tab)
			})
		})

		// Set up button handlers
		const backBtn = document.getElementById('project-edit-back-btn')
		const saveBtn = document.getElementById('project-edit-save-btn')
		const launchJupyterBtn = document.getElementById('project-edit-launch-jupyter-btn')
		const launchJupyterBtn2 = document.getElementById('project-edit-launch-jupyter-btn-2')
		const resetJupyterBtn = document.getElementById('project-edit-reset-jupyter-btn')
		const openFolderBtn = document.getElementById('project-edit-open-folder-btn')
		const openVSCodeBtn = document.getElementById('project-edit-open-vscode-btn')
		const openVSCodeBtn2 = document.getElementById('project-edit-open-vscode-btn-2')
		const reloadBtn = document.getElementById('project-spec-reload-btn')

		if (backBtn) {
			backBtn.onclick = () => {
				handleLeaveProjectEditor()
				navigateTo('projects')
			}
		}
		if (saveBtn) {
			saveBtn.onclick = () => handleSaveProjectEditor()
		}
		if (launchJupyterBtn) {
			launchJupyterBtn.onclick = () => handleLaunchJupyter()
		}
		if (launchJupyterBtn2) {
			launchJupyterBtn2.onclick = () => handleLaunchJupyter()
		}
		if (resetJupyterBtn) {
			resetJupyterBtn.onclick = () => handleResetJupyter()
		}
		if (openFolderBtn) {
			openFolderBtn.onclick = () => handleOpenProjectFolder()
		} else {
			console.warn('project-edit-open-folder-btn not found - using new editor')
		}
		if (openVSCodeBtn) {
			openVSCodeBtn.onclick = () => handleOpenVSCode()
		}
		if (openVSCodeBtn2) {
			openVSCodeBtn2.onclick = () => handleOpenVSCode()
		}
		if (reloadBtn) {
			reloadBtn.onclick = () => handleReloadProjectSpec()
		}
	}

	async function handleOpenVSCode() {
		if (!projectEditorState.projectPath) {
			alert('Select a project first')
			return
		}

		try {
			await invoke('open_in_vscode', { path: projectEditorState.projectPath })
		} catch (error) {
			console.error('Failed to open VSCode:', error)
			const statusEl = document.getElementById('project-edit-status')
			if (statusEl) {
				statusEl.textContent = `Unable to open VSCode. Make sure "code" command is available.`
				statusEl.style.color = '#dc3545'
			}
		}
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
		const button2 = document.getElementById('project-edit-launch-jupyter-btn-2')
		const statusRow = document.getElementById('project-jupyter-status')

		const isLoading = button?.dataset.loading === 'true'
		const buttonText = projectEditorState.jupyter.running ? 'Stop Jupyter' : 'Launch Jupyter'

		if (button && !isLoading) {
			button.innerHTML = `
				<svg width="16" height="16" viewBox="0 0 20 20" fill="none">
					<circle cx="10" cy="10" r="8" stroke="currentColor" stroke-width="2"/>
					<circle cx="10" cy="10" r="3" fill="currentColor"/>
				</svg>
				Jupyter
			`
		}

		if (button2 && !isLoading) {
			button2.textContent = buttonText
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
				const linkButton = document.createElement('button')
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
				statusRow.textContent = 'Running'
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
		const launchBtn = document.getElementById('step-edit-jupyter-btn')
		const launchBtn2 = document.getElementById('project-edit-launch-jupyter-btn')
		const launchBtn3 = document.getElementById('project-edit-launch-jupyter-btn-2')
		const resetBtn = document.getElementById('project-edit-reset-jupyter-btn')

		if (!projectEditorState.projectPath) {
			alert('Select a project first')
			return
		}

		const statusEl =
			document.getElementById('step-status-message') ||
			document.getElementById('project-edit-status')
		if (statusEl) statusEl.style.color = '#666'

		if (projectEditorState.jupyter.running) {
			const message = 'Stopping Jupyter server...\nCommand: uv run --python .venv jupyter lab stop'
			showOperationModal(message)
			setButtonLoadingState(launchBtn, true, 'Stopping...')
			setButtonLoadingState(launchBtn2, true, 'Stopping...')
			setButtonLoadingState(launchBtn3, true, 'Stopping...')
			if (resetBtn) resetBtn.disabled = true
			if (statusEl) statusEl.textContent = 'Stopping Jupyter (jupyter lab stop)...'
			try {
				const result = await invoke('stop_jupyter', {
					projectPath: projectEditorState.projectPath,
				})
				projectEditorState.jupyter.running = !!result.running
				projectEditorState.jupyter.port = result.port ?? null
				projectEditorState.jupyter.url = result.url ?? null
				projectEditorState.jupyter.token = result.token ?? null
				updateJupyterControls()
				if (statusEl) {
					statusEl.textContent = 'Jupyter server stopped.'
					statusEl.style.color = '#666'
				}
				await refreshJupyterStatus(false)
			} catch (error) {
				console.error('Failed to stop Jupyter:', error)
				if (statusEl) {
					statusEl.textContent = `Error stopping Jupyter: ${error}`
					statusEl.style.color = '#dc3545'
				}
			} finally {
				setButtonLoadingState(launchBtn, false)
				setButtonLoadingState(launchBtn2, false)
				setButtonLoadingState(launchBtn3, false)
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
		setButtonLoadingState(launchBtn2, true, 'Starting...')
		setButtonLoadingState(launchBtn3, true, 'Starting...')
		if (resetBtn) resetBtn.disabled = true
		if (statusEl)
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
				if (statusEl) {
					statusEl.textContent = `Jupyter running at ${launchUrl}`
					statusEl.style.color = '#10b981'
				}
			} else {
				if (statusEl) {
					statusEl.textContent = 'Jupyter server started.'
					statusEl.style.color = '#10b981'
				}
			}
			await refreshJupyterStatus(false)
		} catch (error) {
			console.error('Failed to launch Jupyter:', error)
			if (statusEl) {
				statusEl.textContent = `Error launching Jupyter: ${error}`
				statusEl.style.color = '#dc3545'
			}
		} finally {
			setButtonLoadingState(launchBtn, false)
			setButtonLoadingState(launchBtn2, false)
			setButtonLoadingState(launchBtn3, false)
			if (resetBtn) resetBtn.disabled = false
			updateJupyterControls()
			hideOperationModal()
		}
	}

	async function handleResetJupyter() {
		const resetBtn = document.getElementById('project-edit-reset-jupyter-btn')
		const launchBtn = document.getElementById('step-edit-jupyter-btn')
		const launchBtn2 = document.getElementById('project-edit-launch-jupyter-btn')
		const launchBtn3 = document.getElementById('project-edit-launch-jupyter-btn-2')

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

		const statusEl =
			document.getElementById('step-status-message') ||
			document.getElementById('project-edit-status')
		if (statusEl) {
			statusEl.textContent = 'Resetting Jupyter environment...'
			statusEl.style.color = '#666'
		}
		setButtonLoadingState(resetBtn, true, 'Resetting...')
		if (launchBtn) launchBtn.disabled = true
		if (launchBtn2) launchBtn2.disabled = true
		if (launchBtn3) launchBtn3.disabled = true
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
			if (statusEl) {
				statusEl.textContent = result.message || 'Jupyter environment reset. The server is stopped.'
				statusEl.style.color = '#10b981'
			}
			await refreshJupyterStatus(false)
		} catch (error) {
			console.error('Failed to reset Jupyter:', error)
			if (statusEl) {
				statusEl.textContent = `Error resetting Jupyter: ${error}`
				statusEl.style.color = '#dc3545'
			}
		} finally {
			setButtonLoadingState(resetBtn, false)
			if (launchBtn) launchBtn.disabled = false
			if (launchBtn2) launchBtn2.disabled = false
			if (launchBtn3) launchBtn3.disabled = false
			updateJupyterControls()
			hideOperationModal()
		}
	}

	function showCreatePipelineModal() {
		alert('Pipeline creation wizard coming soon! For now, use the CLI:\n\nbv pipeline create')
	}

	// =============================================================================
	// NEW SIMPLIFIED PROJECT EDITOR
	// =============================================================================

	function renderSimpleProjectEditor(data) {
		// Populate basic info
		document.getElementById('step-name-input').value = data.metadata.name || ''
		document.getElementById('step-author-input').value = data.metadata.author || ''
		document.getElementById('step-version-input').value = data.metadata.version || '1.0.0'
		document.getElementById('step-workflow-input').value = data.metadata.workflow || 'workflow.nf'
		document.getElementById('step-template-select').value =
			data.metadata.template || 'dynamic-nextflow'
		document.getElementById('step-path-display').textContent = data.project_path || ''

		// Store state - use project_id from response (may be null for unregistered projects)
		projectEditorState.projectId = data.project_id ?? null
		projectEditorState.projectPath = data.project_path
		projectEditorState.metadata = data.metadata
		projectEditorState.files = data.metadata.assets || []
		projectEditorState.inputs = data.metadata.inputs || []
		projectEditorState.outputs = data.metadata.outputs || []
		projectEditorState.parameters = data.metadata.parameters || []

		console.log('[Editor] Loaded project:', {
			id: projectEditorState.projectId,
			path: projectEditorState.projectPath,
			name: data.metadata.name,
		})

		// Render lists
		renderFilesList()
		renderIOList('inputs')
		renderIOList('outputs')
		renderParametersList()

		// Setup handlers
		setupSimpleEditorHandlers()

		// Update Jupyter status
		refreshJupyterStatus(false)
	}

	function setupSimpleEditorHandlers() {
		// Back button
		const backBtn = document.getElementById('step-edit-back-btn')
		if (backBtn) {
			backBtn.onclick = () => {
				navigateTo('projects')
			}
		}

		// Jupyter button
		const jupyterBtn = document.getElementById('step-edit-jupyter-btn')
		if (jupyterBtn) {
			jupyterBtn.onclick = () => handleLaunchJupyter()
		}

		// VSCode button
		const vscodeBtn = document.getElementById('step-edit-vscode-btn')
		if (vscodeBtn) {
			vscodeBtn.onclick = () => handleOpenVSCode()
		}

		// Open folder button
		const folderBtn = document.getElementById('open-folder-btn')
		if (folderBtn) {
			folderBtn.onclick = () => handleOpenProjectFolder()
		}

		// Auto-save on blur for text fields
		const autoSaveFields = [
			'step-name-input',
			'step-author-input',
			'step-version-input',
			'step-workflow-input',
		]

		autoSaveFields.forEach((id) => {
			const field = document.getElementById(id)
			if (field) {
				field.addEventListener('blur', () => debouncedAutoSave())
				field.addEventListener('input', () => markUnsaved())
			}
		})

		// Auto-save on template change
		const templateSelect = document.getElementById('step-template-select')
		if (templateSelect) {
			templateSelect.addEventListener('change', () => debouncedAutoSave())
		}

		// File drop zone
		const dropZone = document.getElementById('file-drop-zone')
		const fileInput = document.getElementById('file-input')

		if (dropZone && fileInput) {
			dropZone.onclick = () => fileInput.click()

			dropZone.ondragover = (e) => {
				e.preventDefault()
				dropZone.classList.add('drag-over')
			}

			dropZone.ondragleave = () => {
				dropZone.classList.remove('drag-over')
			}

			dropZone.ondrop = (e) => {
				e.preventDefault()
				dropZone.classList.remove('drag-over')
				// TODO: Handle file drop
				alert('File upload coming soon! For now, add files directly to the project folder.')
			}

			fileInput.onchange = () => {
				alert('File upload coming soon! For now, add files directly to the project folder.')
			}
		}

		// Add buttons
		const addInputBtn = document.getElementById('add-input-btn')
		if (addInputBtn) {
			addInputBtn.onclick = () => showIOModal('input')
		}

		const addOutputBtn = document.getElementById('add-output-btn')
		if (addOutputBtn) {
			addOutputBtn.onclick = () => showIOModal('output')
		}

		const addParamBtn = document.getElementById('add-parameter-btn')
		if (addParamBtn) {
			addParamBtn.onclick = () => showParameterModal()
		}

		// Modal handlers
		setupModalHandlers()
	}

	function setupModalHandlers() {
		// I/O Modal
		const _ioModal = document.getElementById('io-modal')
		const ioClose = document.getElementById('io-modal-close')
		const ioCancel = document.getElementById('io-modal-cancel')
		const ioSave = document.getElementById('io-modal-save')

		if (ioClose) ioClose.onclick = () => hideIOModal()
		if (ioCancel) ioCancel.onclick = () => hideIOModal()
		if (ioSave) ioSave.onclick = () => saveIO()

		// Parameter Modal
		const _paramModal = document.getElementById('param-modal')
		const paramClose = document.getElementById('param-modal-close')
		const paramCancel = document.getElementById('param-modal-cancel')
		const paramSave = document.getElementById('param-modal-save')

		if (paramClose) paramClose.onclick = () => hideParameterModal()
		if (paramCancel) paramCancel.onclick = () => hideParameterModal()
		if (paramSave) paramSave.onclick = () => saveParameter()
	}

	function renderFilesList() {
		const container = document.getElementById('files-list')
		if (!container) return

		if (projectEditorState.files.length === 0) {
			container.innerHTML =
				'<p class="empty-state">No files yet. Add Python, R, or other scripts above.</p>'
			return
		}

		container.innerHTML = projectEditorState.files
			.map(
				(file, index) => `
			<div class="file-item">
				<div class="file-item-info">
					<svg class="file-icon" width="20" height="20" viewBox="0 0 20 20" fill="none">
						<path d="M4 2H10L12 4H16C17.1 4 18 4.9 18 6V16C18 17.1 17.1 18 16 18H4C2.9 18 2 17.1 2 16V4C2 2.9 2.9 2 4 2Z" stroke="currentColor" stroke-width="2"/>
					</svg>
					<span class="file-name">${escapeHtml(file)}</span>
				</div>
				<button class="file-remove-btn" onclick="window.projectEditor.removeFile(${index})">&times;</button>
			</div>
		`,
			)
			.join('')
	}

	function renderIOList(type) {
		const container = document.getElementById(`${type}-list`)
		if (!container) return

		const items = projectEditorState[type]
		const icon =
			type === 'inputs'
				? '<path d="M10 3L3 10L10 17M3 10H17" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>'
				: '<path d="M10 3L17 10L10 17M17 10H3" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>'

		if (items.length === 0) {
			container.innerHTML = `<p class="empty-state">No ${type} defined yet.</p>`
			return
		}

		container.innerHTML = items
			.map(
				(item, index) => `
			<div class="io-item">
				<div class="io-item-content">
					<div class="io-item-header">
						<svg class="io-icon" width="20" height="20" viewBox="0 0 20 20" fill="none">${icon}</svg>
						<span class="io-name">${escapeHtml(item.name)}</span>
						${item.format ? `<span class="io-format">${escapeHtml(item.format)}</span>` : ''}
					</div>
					${item.description ? `<p class="io-description">${escapeHtml(item.description)}</p>` : ''}
				</div>
				<div class="io-item-actions">
					<button class="io-edit-btn" onclick="window.projectEditor.editIO('${type}', ${index})">Edit</button>
					<button class="io-remove-btn" onclick="window.projectEditor.removeIO('${type}', ${index})">Remove</button>
				</div>
			</div>
		`,
			)
			.join('')
	}

	function renderParametersList() {
		const container = document.getElementById('parameters-list')
		const countBadge = document.getElementById('parameters-count')

		if (!container) return

		const items = projectEditorState.parameters

		if (countBadge) {
			countBadge.textContent = items.length
		}

		if (items.length === 0) {
			container.innerHTML = '<p class="empty-state">No parameters defined yet.</p>'
			return
		}

		container.innerHTML = items
			.map(
				(item, index) => `
			<div class="io-item">
				<div class="io-item-content">
					<div class="io-item-header">
						<svg class="io-icon" width="20" height="20" viewBox="0 0 20 20" fill="none">
							<circle cx="5" cy="10" r="2" stroke="currentColor" stroke-width="2"/>
							<circle cx="15" cy="10" r="2" stroke="currentColor" stroke-width="2"/>
							<path d="M7 10H13" stroke="currentColor" stroke-width="2"/>
						</svg>
						<span class="io-name">${escapeHtml(item.name)}</span>
						<span class="io-format">${escapeHtml(item.raw_type || item.type || 'string')}</span>
					</div>
					${item.description ? `<p class="io-description">${escapeHtml(item.description)}</p>` : ''}
					${
						item.default
							? `<p class="io-description">Default: <code>${escapeHtml(item.default)}</code></p>`
							: ''
					}
				</div>
				<div class="io-item-actions">
					<button class="io-edit-btn" onclick="window.projectEditor.editParameter(${index})">Edit</button>
					<button class="io-remove-btn" onclick="window.projectEditor.removeParameter(${index})">Remove</button>
				</div>
			</div>
		`,
			)
			.join('')
	}

	function showIOModal(type, item = null, index = -1) {
		const modal = document.getElementById('io-modal')
		const title = document.getElementById('io-modal-title')

		projectEditorState.editingType = type
		projectEditorState.editingIndex = index
		projectEditorState.editingItem = item

		title.textContent = item
			? `Edit ${type === 'input' ? 'Input' : 'Output'}`
			: `Add ${type === 'input' ? 'Input' : 'Output'}`

		// Populate fields
		document.getElementById('io-name-input').value = item?.name || ''
		document.getElementById('io-description-input').value = item?.description || ''
		document.getElementById('io-format-input').value = item?.format || ''
		document.getElementById('io-type-select').value = item?.raw_type || item?.type || 'File'
		document.getElementById('io-path-input').value = item?.path || ''

		modal.style.display = 'flex'
	}

	function hideIOModal() {
		const modal = document.getElementById('io-modal')
		modal.style.display = 'none'
		projectEditorState.editingType = null
		projectEditorState.editingIndex = -1
		projectEditorState.editingItem = null
	}

	function saveIO() {
		const name = document.getElementById('io-name-input').value.trim()
		const description = document.getElementById('io-description-input').value.trim()
		const format = document.getElementById('io-format-input').value.trim()
		const type = document.getElementById('io-type-select').value
		const path = document.getElementById('io-path-input').value.trim()

		if (!name) {
			alert('Name is required')
			return
		}

		if (!format) {
			alert('File format is required')
			return
		}

		const item = {
			name,
			description: description || undefined,
			format,
			raw_type: type,
			type: type,
			path: path || undefined,
		}

		const listKey = projectEditorState.editingType + 's'

		if (projectEditorState.editingIndex >= 0) {
			// Edit existing
			projectEditorState[listKey][projectEditorState.editingIndex] = item
		} else {
			// Add new
			projectEditorState[listKey].push(item)
		}

		renderIOList(listKey)
		hideIOModal()

		// Auto-save after adding/editing I/O
		debouncedAutoSave()
	}

	function showParameterModal(item = null, index = -1) {
		const modal = document.getElementById('param-modal')
		const title = document.getElementById('param-modal-title')

		projectEditorState.editingIndex = index
		projectEditorState.editingItem = item

		title.textContent = item ? 'Edit Parameter' : 'Add Parameter'

		// Populate fields
		document.getElementById('param-name-input').value = item?.name || ''
		document.getElementById('param-description-input').value = item?.description || ''
		document.getElementById('param-type-select').value = item?.raw_type || item?.type || 'String'
		document.getElementById('param-default-input').value = item?.default || ''

		modal.style.display = 'flex'
	}

	function hideParameterModal() {
		const modal = document.getElementById('param-modal')
		modal.style.display = 'none'
		projectEditorState.editingIndex = -1
		projectEditorState.editingItem = null
	}

	function saveParameter() {
		const name = document.getElementById('param-name-input').value.trim()
		const description = document.getElementById('param-description-input').value.trim()
		const type = document.getElementById('param-type-select').value
		const defaultValue = document.getElementById('param-default-input').value.trim()

		if (!name) {
			alert('Name is required')
			return
		}

		const item = {
			name,
			description: description || undefined,
			raw_type: type,
			type: type,
			default: defaultValue || undefined,
		}

		if (projectEditorState.editingIndex >= 0) {
			// Edit existing
			projectEditorState.parameters[projectEditorState.editingIndex] = item
		} else {
			// Add new
			projectEditorState.parameters.push(item)
		}

		renderParametersList()
		hideParameterModal()

		// Auto-save after adding/editing parameter
		debouncedAutoSave()
	}

	let autoSaveTimeout = null
	let isSaving = false

	function markUnsaved() {
		const indicator = document.getElementById('auto-save-indicator')
		if (indicator && !isSaving) {
			indicator.classList.remove('visible')
		}
	}

	function debouncedAutoSave() {
		if (autoSaveTimeout) {
			clearTimeout(autoSaveTimeout)
		}
		autoSaveTimeout = setTimeout(() => {
			autoSaveProject()
		}, 800) // Save 800ms after user stops typing
	}

	async function autoSaveProject() {
		if (isSaving) return
		isSaving = true

		const indicator = document.getElementById('auto-save-indicator')
		const name = document.getElementById('step-name-input').value.trim()
		const workflow = document.getElementById('step-workflow-input').value.trim()

		// Don't save if required fields are empty
		if (!name || !workflow) {
			isSaving = false
			return
		}

		// Show saving indicator
		if (indicator) {
			indicator.classList.add('visible', 'saving')
			indicator.querySelector('span').textContent = 'Saving...'
		}

		const author = document.getElementById('step-author-input').value.trim()
		const version = document.getElementById('step-version-input').value.trim()
		const template = document.getElementById('step-template-select').value

		// Use the existing buildSpecSavePayload to properly format data for CLI
		const payload = buildSpecSavePayload({
			name,
			author,
			workflow,
			template: template || null,
			assets: projectEditorState.files,
			version: version || '1.0.0',
			spec: {
				parameters: projectEditorState.parameters,
				inputs: projectEditorState.inputs,
				outputs: projectEditorState.outputs,
			},
		})

		try {
			console.log('[Auto-save] Saving:', {
				projectId: projectEditorState.projectId,
				projectPath: projectEditorState.projectPath,
				name: payload.name,
			})

			// Call backend - it will update existing project, not create new one
			const result = await invoke('save_project_editor', {
				projectId: projectEditorState.projectId,
				projectPath: projectEditorState.projectPath,
				payload,
			})

			// Update project ID if it was null before
			if (!projectEditorState.projectId && result.id) {
				projectEditorState.projectId = result.id
				console.log('[Auto-save] Updated project ID:', result.id)
			}

			// Show saved indicator
			if (indicator) {
				indicator.classList.remove('saving')
				indicator.querySelector('span').textContent = 'Saved'
				setTimeout(() => {
					indicator.classList.remove('visible')
				}, 2000)
			}

			// Silently refresh project list
			await loadProjects()
		} catch (error) {
			console.error('Auto-save failed:', error)

			// Show error in indicator
			if (indicator) {
				indicator.classList.remove('saving')
				indicator.style.color = '#dc3545'
				indicator.style.background = '#fee'
				indicator.querySelector('span').textContent = 'Save failed'
				setTimeout(() => {
					indicator.classList.remove('visible')
					indicator.style.color = ''
					indicator.style.background = ''
				}, 3000)
			}
		} finally {
			isSaving = false
		}
	}

	// Expose functions to window for onclick handlers
	window.projectEditor = {
		removeFile: (index) => {
			projectEditorState.files.splice(index, 1)
			renderFilesList()
			debouncedAutoSave()
		},
		editIO: (type, index) => {
			const item = projectEditorState[type][index]
			showIOModal(type.replace(/s$/, ''), item, index)
		},
		removeIO: (type, index) => {
			if (confirm('Remove this item?')) {
				projectEditorState[type].splice(index, 1)
				renderIOList(type)
				debouncedAutoSave()
			}
		},
		editParameter: (index) => {
			const item = projectEditorState.parameters[index]
			showParameterModal(item, index)
		},
		removeParameter: (index) => {
			if (confirm('Remove this parameter?')) {
				projectEditorState.parameters.splice(index, 1)
				renderParametersList()
				debouncedAutoSave()
			}
		},
	}

	return {
		loadProjects,
		importProject,
		importProjectFromFolder,
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
		openProjectEditor, // Export for pipelines module
	}
}
