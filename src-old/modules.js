import { createModuleSpecForm, generateContractAscii } from './module-spec-form-modal.js'

const CREATE_TAB_CONFIG = {
	inputs: { containerId: 'create-module-inputs', sections: ['inputs'], defaultTab: 'inputs' },
	parameters: {
		containerId: 'create-module-parameters',
		sections: ['parameters'],
		defaultTab: 'parameters',
	},
	outputs: { containerId: 'create-module-outputs', sections: ['outputs'], defaultTab: 'outputs' },
}

let wizardPreviewRequestId = 0
let editorPreviewRequestId = 0
let wizardPreviewScheduled = false
let editorPreviewScheduled = false

export function createModulesModule({
	invoke,
	dialog,
	open,
	shellApi,
	navigateTo,
	addModuleAsFlowStep = null,
}) {
	const moduleEditorState = {
		moduleId: null,
		modulePath: '',
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

	const moduleCreateState = {
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
	function _ensureEditorSpecForm() {
		// No longer needed with new simple editor
	}

	function _updateEditorCounts() {
		// No longer needed with new simple editor
	}

	function _updateEditorTitle() {
		// No longer needed with new simple editor
	}

	function _switchEditorTab() {
		// No longer needed with new simple editor
	}

	function _updateEditorSpecSummary() {
		if (!moduleEditorState.specSummaryEl) return
		const nameInput = document.getElementById('module-edit-name')
		const moduleName = nameInput ? nameInput.value.trim() : moduleEditorState.metadata?.name || ''
		const ascii = generateContractAscii({
			name: moduleName,
			parameters: moduleEditorState.specData.parameters,
			inputs: moduleEditorState.specData.inputs,
			outputs: moduleEditorState.specData.outputs,
		})
		moduleEditorState.specSummaryEl.textContent = ascii
		scheduleEditorPreview()
	}

	function getEditorSpecPayload() {
		return {
			parameters: moduleEditorState.specData.parameters || [],
			inputs: moduleEditorState.specData.inputs || [],
			outputs: moduleEditorState.specData.outputs || [],
		}
	}

	function clearWizardPreview(message) {
		const yamlEl = document.getElementById('create-module-preview-yaml')
		const templateEl = document.getElementById('create-module-preview-template')
		if (yamlEl) yamlEl.textContent = message
		if (templateEl) templateEl.textContent = message
	}

	function clearEditorPreview(message) {
		const yamlEl = document.getElementById('module-edit-preview-yaml')
		const templateEl = document.getElementById('module-edit-preview-template')
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
			const preview = await invoke('preview_module_spec', { payload })
			if (requestId !== wizardPreviewRequestId) return
			const yamlEl = document.getElementById('create-module-preview-yaml')
			const workflowEl = document.getElementById('create-module-preview-template')
			if (yamlEl) yamlEl.innerHTML = highlightYaml(preview.yaml)
			if (workflowEl) workflowEl.innerHTML = highlightGroovy(preview.workflow || preview.template)
		} catch (error) {
			if (requestId !== wizardPreviewRequestId) return
			console.error('Failed to generate module preview:', error)
			clearWizardPreview('Unable to generate preview. Check your inputs.')
		}
	}

	async function requestEditorPreview(payload) {
		editorPreviewRequestId += 1
		const requestId = editorPreviewRequestId
		try {
			const preview = await invoke('preview_module_spec', { payload })
			if (requestId !== editorPreviewRequestId) return
			const yamlEl = document.getElementById('module-edit-preview-yaml')
			const workflowEl = document.getElementById('module-edit-preview-template')
			if (yamlEl) yamlEl.innerHTML = highlightYaml(preview.yaml)
			if (workflowEl) workflowEl.innerHTML = highlightGroovy(preview.workflow || preview.template)
		} catch (error) {
			if (requestId !== editorPreviewRequestId) return
			console.error('Failed to generate editor preview:', error)
			clearEditorPreview('Unable to generate preview. Check module fields.')
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
		const nameInput = document.getElementById('new-module-name')
		const templateSelect = document.getElementById('new-module-template')
		const versionInput = document.getElementById('new-module-version')
		const moduleName = nameInput ? nameInput.value.trim() : ''
		const versionValue = versionInput ? versionInput.value.trim() || '1.0.0' : '1.0.0'

		// Use placeholder name if empty for preview purposes
		const previewName = moduleName || 'my-module'

		// Get scripting language selection for preview
		const selectedScriptCard = document.querySelector(
			'#blank-module-options .option-card.active[data-type="script"]',
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
		const nameInput = document.getElementById('module-edit-name')
		const workflowInput = document.getElementById('module-edit-workflow')
		if (!nameInput || !workflowInput) {
			return
		}
		const nameValue = nameInput.value.trim()
		const workflowValue = workflowInput.value.trim() || 'workflow.nf'
		if (!nameValue || !workflowInput.value.trim()) {
			editorPreviewRequestId += 1
			clearEditorPreview('Enter a module name and workflow to generate a preview.')
			return
		}
		const authorValue = document.getElementById('module-edit-author')?.value.trim() || ''
		const templateValue = document.getElementById('module-edit-template')?.value.trim() || ''
		const versionValue = document.getElementById('module-edit-version')?.value.trim() || '1.0.0'
		const payload = buildSpecSavePayload({
			name: nameValue,
			author: authorValue,
			workflow: workflowValue,
			template: templateValue || null,
			assets: Array.from(moduleEditorState.selectedAssets).map((entry) =>
				typeof entry === 'string' ? entry.replace(/\\/g, '/') : entry,
			),
			version: versionValue,
			spec: getEditorSpecPayload(),
		})
		requestEditorPreview(payload)
	}

	function ensureCreateSpecForm(config) {
		const targetId = config?.containerId || 'create-module-parameters'
		const target = document.getElementById(targetId)
		if (!moduleCreateState.specForm) {
			if (target) {
				moduleCreateState.specForm = createModuleSpecForm({
					container: target,
					invoke,
					onChange: (parameters, inputs, outputs) => {
						moduleCreateState.specData = { parameters, inputs, outputs }
						updateTabCounts()
						scheduleWizardPreview()
					},
				})
			} else {
				return
			}
		} else if (target) {
			moduleCreateState.specForm.mount(target)
		}

		if (moduleCreateState.specForm && config) {
			moduleCreateState.specForm.configureSections(config.sections, config.defaultTab)
		}
		if (moduleCreateState.specForm) {
			moduleCreateState.specForm.setSpec(moduleCreateState.specData)
		}

		if (!moduleCreateState.nameListenerBound) {
			const nameInput = document.getElementById('new-module-name')
			if (nameInput) {
				nameInput.addEventListener('input', () => {
					updateCreateSpecSummary()
					scheduleWizardPreview()
				})
				moduleCreateState.nameListenerBound = true
			}
		}
	}

	function updateCreateSpecSummary() {
		// Update preview when spec data changes
		scheduleWizardPreview()
	}

	function updateTabCounts() {
		const counts = {
			inputs: moduleCreateState.specData.inputs.length,
			parameters: moduleCreateState.specData.parameters.length,
			outputs: moduleCreateState.specData.outputs.length,
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
		moduleCreateState.specData = {
			parameters: (templateData.parameters || []).map(normalizeSpec),
			inputs: (templateData.inputs || []).map(normalizeSpec),
			outputs: (templateData.outputs || []).map(normalizeSpec),
		}

		console.log('Loaded template data:', moduleCreateState.specData)

		// Update form if it exists
		if (moduleCreateState.specForm) {
			moduleCreateState.specForm.setSpec(moduleCreateState.specData)
		}

		// Update tab counts
		updateTabCounts()

		// Update version if template has one
		const versionInput = document.getElementById('new-module-version')
		if (versionInput && templateData.version) {
			versionInput.value = templateData.version
		}
	}

	function resetWizardToBlank() {
		// Reset spec data
		moduleCreateState.specData = {
			parameters: [],
			inputs: [],
			outputs: [],
		}

		// Update form if it exists
		if (moduleCreateState.specForm) {
			moduleCreateState.specForm.setSpec(moduleCreateState.specData)
		}

		// Update tab counts
		updateTabCounts()

		// Reset version
		const versionInput = document.getElementById('new-module-version')
		if (versionInput) {
			versionInput.value = '1.0.0'
		}
	}

	function getCreateSpecPayload() {
		return {
			parameters: moduleCreateState.specData.parameters || [],
			inputs: moduleCreateState.specData.inputs || [],
			outputs: moduleCreateState.specData.outputs || [],
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
		moduleCreateState.activeTab = tabName

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
		const currentIndex = tabOrder.indexOf(moduleCreateState.activeTab)

		const backBtn = document.getElementById('create-module-back')
		const nextBtn = document.getElementById('create-module-next')
		const confirmBtn = document.getElementById('create-module-confirm')

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
			// Last tab - show Create Module button
			nextBtn.style.display = 'none'
			confirmBtn.style.display = 'inline-flex'
		}
	}

	function handleCreateTabNext() {
		const tabOrder = ['details', 'inputs', 'parameters', 'outputs']
		const currentIndex = tabOrder.indexOf(moduleCreateState.activeTab)

		if (currentIndex < tabOrder.length - 1) {
			switchCreateTab(tabOrder[currentIndex + 1])
		}
	}

	function handleCreateTabBack() {
		const tabOrder = ['details', 'inputs', 'parameters', 'outputs']
		const currentIndex = tabOrder.indexOf(moduleCreateState.activeTab)

		if (currentIndex > 0) {
			switchCreateTab(tabOrder[currentIndex - 1])
		}
	}

	async function reloadSpecFromDisk(showMessage = true) {
		if (!moduleEditorState.modulePath) return
		try {
			const payload = await invoke('load_module_editor', {
				moduleId: moduleEditorState.moduleId,
				modulePath: moduleEditorState.modulePath,
			})
			renderSimpleModuleEditor(payload)
			if (showMessage) {
				const statusEl = document.getElementById('step-status-message')
				if (statusEl) {
					statusEl.textContent = 'Detected external module.yaml changes. Editor reloaded.'
					statusEl.style.color = '#10b981'
				}
			}
		} catch (error) {
			console.error('Failed to reload module metadata:', error)
		}
	}

	async function handleReloadModuleSpec() {
		await reloadSpecFromDisk(false)
		const statusEl = document.getElementById('module-edit-status')
		if (statusEl) {
			statusEl.textContent = 'Reloaded module.yaml from disk.'
			statusEl.style.color = '#666'
		}
		await checkSpecDigest(true)
	}

	async function checkSpecDigest(force = false) {
		if (!moduleEditorState.modulePath) return
		try {
			const digest = await invoke('get_module_spec_digest', {
				modulePath: moduleEditorState.modulePath,
			})
			const digestStr = digest ?? null
			if (force) {
				moduleEditorState.lastSpecDigest = digestStr
				return
			}
			if (moduleEditorState.skipNextDigestReload) {
				moduleEditorState.skipNextDigestReload = false
				moduleEditorState.lastSpecDigest = digestStr
				return
			}
			if (
				moduleEditorState.lastSpecDigest &&
				digestStr &&
				digestStr !== moduleEditorState.lastSpecDigest
			) {
				await reloadSpecFromDisk(true)
			}
			moduleEditorState.lastSpecDigest = digestStr
		} catch (error) {
			console.error('Failed to compute module.yaml digest:', error)
		}
	}

	function stopSpecDigestPolling() {
		if (moduleEditorState.specDigestTimer) {
			clearInterval(moduleEditorState.specDigestTimer)
			moduleEditorState.specDigestTimer = null
		}
	}

	function handleLeaveModuleEditor() {
		stopSpecDigestPolling()
	}

	function setOperationButtonsDisabled(disabled) {
		const launchBtn = document.getElementById('module-edit-launch-jupyter-btn')
		const resetBtn = document.getElementById('module-edit-reset-jupyter-btn')
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

	async function handleDeleteModule(module) {
		const name = module.name || module.module_path
		const prompt = module.orphaned
			? `Are you sure you want to delete the folder "${module.module_path}"? This cannot be undone.`
			: `Are you sure you want to delete module "${name}"? This will remove the module directory and cannot be undone.`

		const confirmed = await confirmWithDialog(prompt, {
			title: 'Delete Module',
			type: 'warning',
		})

		if (!confirmed) return

		const modalMsg = module.orphaned
			? 'Deleting module folder...'
			: 'Deleting module (database + folder)...'
		showOperationModal(modalMsg)

		try {
			if (module.orphaned) {
				await invoke('delete_module_folder', { modulePath: module.module_path })
			} else if (module.id !== null && module.id !== undefined) {
				await invoke('delete_module', { moduleId: module.id })
			}
			await loadModules()
		} catch (error) {
			alert(`Error deleting module: ${error}`)
		} finally {
			hideOperationModal()
		}
	}

	async function loadModules() {
		try {
			const modules = await invoke('get_modules')
			const modulesContainer = document.getElementById('steps-list')

			// Update counts
			const stepsCountBadges = document.querySelectorAll('#steps-count, #steps-count-label')
			stepsCountBadges.forEach((badge) => {
				badge.textContent = modules?.length || 0
			})

			// Render steps (formerly modules)
			if (!modules || modules.length === 0) {
				if (modulesContainer) {
					modulesContainer.innerHTML =
						'<p style="color: #666; padding: 20px; text-align: center;">No steps yet. Create or import one to get started.</p>'
				}
			} else {
				if (modulesContainer) {
					modulesContainer.innerHTML = ''

					modules.forEach((module) => {
						const card = document.createElement('div')
						card.className = 'module-card'

						const info = document.createElement('div')
						info.className = 'module-info'

						const title = document.createElement('h3')
						title.textContent = module.name || '(unnamed module)'
						if (module.orphaned) {
							const badge = document.createElement('span')
							badge.className = 'module-badge module-badge-orphan'
							badge.textContent = 'Unregistered folder'
							title.appendChild(badge)
						}
						info.appendChild(title)

						const author = document.createElement('p')
						author.innerHTML = `<strong>Author:</strong> ${module.author ?? '—'}`
						info.appendChild(author)

						const workflow = document.createElement('p')
						workflow.innerHTML = `<strong>Workflow:</strong> ${module.workflow ?? '—'}`
						info.appendChild(workflow)

						const template = document.createElement('p')
						template.innerHTML = `<strong>Template:</strong> ${module.template ?? '—'}`
						info.appendChild(template)

						const path = document.createElement('p')
						path.innerHTML = `<strong>Path:</strong> ${module.module_path}`
						info.appendChild(path)

						const created = document.createElement('p')
						const meta = module.created_at
							? `${module.source} | Created: ${module.created_at}`
							: module.source
						created.innerHTML = `<strong>Source:</strong> ${meta}`
						info.appendChild(created)

						card.appendChild(info)

						const actions = document.createElement('div')
						actions.className = 'module-card-actions'

						const editBtn = document.createElement('button')
						editBtn.className = 'secondary-btn'
						editBtn.textContent = module.orphaned ? 'Open in Editor' : 'Edit'
						editBtn.addEventListener('click', async () => {
							if (module.orphaned) {
								await openModuleEditor({ modulePath: module.module_path })
							} else if (module.id !== null && module.id !== undefined) {
								await openModuleEditor({ moduleId: module.id })
							}
						})
						actions.appendChild(editBtn)

						const openBtn = document.createElement('button')
						openBtn.className = 'open-folder-btn'
						openBtn.textContent = 'Open Folder'
						openBtn.addEventListener('click', async () => {
							try {
								await invoke('open_folder', { path: module.module_path })
							} catch (error) {
								alert(`Error opening folder: ${error}`)
							}
						})
						actions.appendChild(openBtn)

						const deleteBtn = document.createElement('button')
						deleteBtn.className = 'delete-btn'
						deleteBtn.textContent = 'Delete'
						deleteBtn.addEventListener('click', async () => {
							await handleDeleteModule(module)
						})
						actions.appendChild(deleteBtn)

						card.appendChild(actions)
						modulesContainer.appendChild(card)
					})
				}
			}
		} catch (error) {
			console.error('Error loading modules:', error)
		}
	}

	async function importModule(overwrite = false) {
		const input = document.getElementById('module-url-input')
		const url = input.value.trim()

		if (!url) {
			alert('Please enter a GitHub URL')
			return
		}

		console.log('Import button clicked, URL:', url)

		const btn = document.getElementById('import-module-btn')
		btn.disabled = true
		btn.textContent = 'Importing...'

		try {
			console.log('Calling invoke with:', { url, overwrite })
			const result = await invoke('import_module', { url, overwrite })
			console.log('Import successful:', result)
			input.value = ''
			await loadModules()
			alert('Module imported successfully!')
		} catch (error) {
			console.error('Import error:', error)
			const errorStr = String(error)
			if (errorStr.includes('already exists')) {
				const shouldOverwrite = await confirmWithDialog(
					`${errorStr}\n\nDo you want to overwrite it?`,
					{ title: 'Overwrite Module?', type: 'warning' },
				)
				if (shouldOverwrite) {
					btn.disabled = false
					btn.textContent = 'Import'
					await importModule(true)
					return
				}
			} else {
				alert(`Error importing module: ${errorStr}`)
			}
		} finally {
			console.log('Import finally block')
			btn.disabled = false
			btn.textContent = 'Import'
		}
	}

	async function importModuleFromFolder(overwrite = false, folderPath = null) {
		if (!folderPath) {
			folderPath = await dialog.open({
				directory: true,
				multiple: false,
				title: 'Select Module Folder',
			})
		}

		if (!folderPath) {
			return
		}

		console.log('Import from folder selected:', folderPath)

		const btn = document.getElementById('import-folder-btn')
		if (btn) {
			btn.disabled = true
			btn.innerHTML = '⏳ Importing...'
		}

		try {
			const result = await invoke('import_module_from_folder', {
				folder_path: folderPath,
				overwrite,
			})
			console.log('Import from folder successful:', result)
			await loadModules()
			alert(`Module "${result.name}" imported successfully!`)
		} catch (error) {
			console.error('Error importing from folder:', error)
			const errorStr = error.toString ? error.toString() : String(error)
			if (errorStr.includes('already exists')) {
				const shouldOverwrite = await confirmWithDialog(
					`${errorStr}\n\nDo you want to overwrite it?`,
					{ title: 'Overwrite Module?', type: 'warning' },
				)
				if (shouldOverwrite) {
					if (btn) {
						btn.disabled = false
						btn.innerHTML = '📁 Import from Folder'
					}
					await importModuleFromFolder(true, folderPath)
					return
				}
			} else {
				alert(`Error importing module: ${errorStr}`)
			}
		} finally {
			if (btn) {
				btn.disabled = false
				btn.innerHTML = '📁 Import from Folder'
			}
		}
	}

	async function fetchDefaultModulePath(name) {
		const trimmed = name ? name.trim() : ''
		try {
			return await invoke('get_default_module_path', {
				name: trimmed ? trimmed : null,
			})
		} catch (error) {
			console.error('Failed to fetch default module path:', error)
			return ''
		}
	}

	async function showCreateModuleModal() {
		const modal = document.getElementById('create-module-modal')
		const nameInput = document.getElementById('new-module-name')
		const templateSelect = document.getElementById('new-module-template')
		const pathInput = document.getElementById('new-module-path')
		const versionInput = document.getElementById('new-module-version')

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
		moduleCreateState.selectedDir = null
		moduleCreateState.usingDefault = true

		// Load available templates from CLI
		let availableExamples = {}
		if (templateSelect) {
			try {
				const examples = await invoke('get_available_module_examples')
				availableExamples = examples || {}
				let optionsHtml = '<option value="">Blank Module</option>'

				if (Object.keys(examples).length > 0) {
					Object.entries(examples).forEach(([key, example]) => {
						const displayName = example.name || key
						optionsHtml += `<option value="${key}">${displayName}</option>`
					})
				}

				templateSelect.innerHTML = optionsHtml
			} catch (error) {
				console.warn('Failed to load module examples:', error)
				templateSelect.innerHTML = '<option value="">Blank Module</option>'
			}

			// Handle template selection changes
			templateSelect.onchange = async () => {
				const selectedTemplate = templateSelect.value
				const blankOptions = document.getElementById('blank-module-options')

				if (selectedTemplate && availableExamples[selectedTemplate]) {
					// Hide blank module options
					if (blankOptions) blankOptions.style.display = 'none'
					await loadTemplateIntoWizard(availableExamples[selectedTemplate])
				} else {
					// Show blank module options
					if (blankOptions) blankOptions.style.display = 'block'
					resetWizardToBlank()
				}
				scheduleWizardPreview()
			}
		}

		const defaultPath = await fetchDefaultModulePath('')
		moduleCreateState.defaultDir = defaultPath
		if (pathInput) {
			pathInput.value = defaultPath
		}

		// Initialize form state
		moduleCreateState.specData = { parameters: [], inputs: [], outputs: [] }
		moduleCreateState.activeTab = 'details'

		// Initialize inputs tab
		ensureCreateSpecForm(CREATE_TAB_CONFIG.inputs)
		moduleCreateState.specForm?.setSpec(moduleCreateState.specData)

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
		const cancelBtn = document.getElementById('create-module-cancel')
		const backBtn = document.getElementById('create-module-back')
		const nextBtn = document.getElementById('create-module-next')
		const confirmBtn = document.getElementById('create-module-confirm')

		if (cancelBtn) {
			cancelBtn.onclick = () => hideCreateModuleModal()
		}
		if (backBtn) {
			backBtn.onclick = () => handleCreateTabBack()
		}
		if (nextBtn) {
			nextBtn.onclick = () => handleCreateTabNext()
		}
		if (confirmBtn) {
			confirmBtn.onclick = () => createModuleFromModal()
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

	function hideCreateModuleModal() {
		const modal = document.getElementById('create-module-modal')
		modal.style.display = 'none'
		document.body.classList.remove('modal-open')
	}

	function validateModuleName(name) {
		const trimmed = name.trim()

		// Cannot be empty
		if (trimmed.length === 0) {
			return { valid: false, error: 'Module name cannot be empty' }
		}

		// Cannot be . or ..
		if (trimmed === '.' || trimmed === '..') {
			return { valid: false, error: 'Module name cannot be "." or ".."' }
		}

		// Cannot contain / or \
		if (trimmed.includes('/') || trimmed.includes('\\')) {
			return { valid: false, error: 'Module name cannot contain / or \\' }
		}

		return { valid: true, error: null }
	}

	async function handleModuleNameInputChange() {
		const nameInput = document.getElementById('new-module-name')
		const errorEl = document.getElementById('module-name-error')
		const nameValue = nameInput.value
		const validation = validateModuleName(nameValue)

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
		if (moduleCreateState.usingDefault && validation.valid) {
			const defaultPath = await fetchDefaultModulePath(nameValue.trim())
			moduleCreateState.defaultDir = defaultPath
			document.getElementById('new-module-path').value = defaultPath
		}

		updateCreateSpecSummary()
	}

	async function chooseModuleDirectory() {
		try {
			const selection = await open({ directory: true, multiple: false })
			if (!selection) {
				return
			}

			const chosen = Array.isArray(selection) ? selection[0] : selection
			if (!chosen) {
				return
			}

			moduleCreateState.selectedDir = chosen
			moduleCreateState.usingDefault = false
			document.getElementById('new-module-path').value = chosen
			scheduleWizardPreview()
		} catch (error) {
			console.error('Folder selection cancelled or failed:', error)
		}
	}

	async function resetModuleDirectory() {
		moduleCreateState.selectedDir = null
		moduleCreateState.usingDefault = true
		const nameValue = document.getElementById('new-module-name').value.trim()
		const defaultPath = await fetchDefaultModulePath(nameValue)
		moduleCreateState.defaultDir = defaultPath
		document.getElementById('new-module-path').value = defaultPath
		scheduleWizardPreview()
	}

	async function createModuleFromModal() {
		const nameInput = document.getElementById('new-module-name')
		const templateSelect = document.getElementById('new-module-template')
		const confirmBtn = document.getElementById('create-module-confirm')
		const versionInput = document.getElementById('new-module-version')

		const moduleName = nameInput.value
		const validation = validateModuleName(moduleName)

		if (!validation.valid) {
			await dialog.message(validation.error, {
				title: 'Invalid Module Name',
				type: 'warning',
			})
			// Switch to details tab to show error
			switchCreateTab('details')
			nameInput.focus()
			return
		}

		// Validate destination path
		let destination = document.getElementById('new-module-path').value.trim()
		if (!destination) {
			destination = await fetchDefaultModulePath(moduleName.trim())
			document.getElementById('new-module-path').value = destination
			moduleCreateState.defaultDir = destination
			moduleCreateState.selectedDir = null
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
		const directory = moduleCreateState.selectedDir
		const versionValue = versionInput ? versionInput.value.trim() || '1.0.0' : '1.0.0'
		const spec = getCreateSpecPayload()
		const hasContract =
			spec.parameters.length > 0 || spec.inputs.length > 0 || spec.outputs.length > 0

		// Get scripting language option (only for blank modules)
		const selectedScriptCard = document.querySelector(
			'#blank-module-options .option-card.active[data-type="script"]',
		)
		const scriptLang = selectedScriptCard ? selectedScriptCard.dataset.value : 'none'
		const createPythonScript = !example && scriptLang === 'python'
		const scriptName = createPythonScript ? 'process.py' : null

		confirmBtn.disabled = true
		confirmBtn.textContent = 'Creating...'

		try {
			const module = await invoke('create_module', {
				name: moduleName.trim(),
				example,
				directory: directory || null,
				createPythonScript: createPythonScript,
				scriptName: scriptName,
			})
			if (hasContract) {
				try {
					const editorPayload = await invoke('load_module_editor', {
						moduleId: module.id,
					})
					const metadata = editorPayload.metadata
					const payload = buildSpecSavePayload({
						name: metadata.name || moduleName.trim(),
						author: metadata.author,
						workflow: metadata.workflow,
						template: metadata.template || null,
						assets: metadata.assets || [],
						version: versionValue,
						spec,
					})
					await invoke('save_module_editor', {
						moduleId: module.id,
						modulePath: editorPayload.module_path,
						payload,
					})
				} catch (specError) {
					console.error('Failed to apply module contract during creation:', specError)
				}
			}
			hideCreateModuleModal()
			await loadModules()

			// Check if we're adding this module as a step to a flow
			if (window._addingStepToFlow && addModuleAsFlowStep) {
				try {
					await addModuleAsFlowStep(module.module_path, moduleName.trim())
					// Clear the flag
					delete window._addingStepToFlow
					// Don't open module editor, just reload flows
					console.log('Module added as step to flow')
				} catch (error) {
					console.error('Failed to add module as flow step:', error)
					// Still open the editor as fallback
					await openModuleEditor({ moduleId: module.id })
				}
			} else {
				// Normal flow: open the module editor
				await openModuleEditor({ moduleId: module.id })
			}
		} catch (error) {
			const errorStr = String(error)
			console.error('Create module error:', errorStr)
			const targetPath = directory || moduleCreateState.defaultDir
			if (errorStr.includes('module.yaml already exists') && targetPath) {
				const shouldOpen = confirm(`${errorStr}\n\nOpen the module editor for ${targetPath}?`)
				if (shouldOpen) {
					hideCreateModuleModal()
					await openModuleEditor({ modulePath: targetPath })
				}
			} else {
				await dialog.message(`Error creating module: ${errorStr}`, {
					title: 'Error',
					type: 'error',
				})
			}
		} finally {
			confirmBtn.disabled = false
			confirmBtn.textContent = 'Create Module'
		}
	}

	async function openModuleEditor({ moduleId = null, modulePath = null }) {
		if (!moduleId && !modulePath) {
			alert('Unable to open module editor: missing module identifier')
			return
		}

		try {
			const payload = await invoke('load_module_editor', {
				moduleId,
				modulePath,
			})

			// Use new simple editor
			renderSimpleModuleEditor(payload)
			navigateTo('module-edit')
		} catch (error) {
			console.error('Failed to load module editor:', error)
			alert(`Error loading module: ${error}`)
		}
	}

	function _setupEditorTabHandlers() {
		// Set up tab click handlers
		document.querySelectorAll('.editor-nav-tab').forEach((tab) => {
			// Remove old listeners by cloning
			const newTab = tab.cloneNode(true)
			tab.parentNode.replaceChild(newTab, tab)

			newTab.addEventListener('click', () => {
				_switchEditorTab(newTab.dataset.tab)
			})
		})

		// Set up button handlers
		const backBtn = document.getElementById('module-edit-back-btn')
		const saveBtn = document.getElementById('module-edit-save-btn')
		const launchJupyterBtn = document.getElementById('module-edit-launch-jupyter-btn')
		const launchJupyterBtn2 = document.getElementById('module-edit-launch-jupyter-btn-2')
		const resetJupyterBtn = document.getElementById('module-edit-reset-jupyter-btn')
		const openFolderBtn = document.getElementById('module-edit-open-folder-btn')
		const openVSCodeBtn = document.getElementById('module-edit-open-vscode-btn')
		const openVSCodeBtn2 = document.getElementById('module-edit-open-vscode-btn-2')
		const reloadBtn = document.getElementById('module-spec-reload-btn')

		if (backBtn) {
			backBtn.onclick = () => {
				handleLeaveModuleEditor()
				navigateTo('modules')
			}
		}
		if (saveBtn) {
			saveBtn.onclick = () => handleSaveModuleEditor()
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
			openFolderBtn.onclick = () => handleOpenModuleFolder()
		} else {
			console.warn('module-edit-open-folder-btn not found - using new editor')
		}
		if (openVSCodeBtn) {
			openVSCodeBtn.onclick = () => handleOpenVSCode()
		}
		if (openVSCodeBtn2) {
			openVSCodeBtn2.onclick = () => handleOpenVSCode()
		}
		if (reloadBtn) {
			reloadBtn.onclick = () => handleReloadModuleSpec()
		}
	}

	async function handleOpenVSCode() {
		if (!moduleEditorState.modulePath) {
			alert('Select a module first')
			return
		}

		try {
			await invoke('open_in_vscode', { path: moduleEditorState.modulePath })
		} catch (error) {
			console.error('Failed to open VSCode:', error)
			const statusEl = document.getElementById('module-edit-status')
			if (statusEl) {
				statusEl.textContent = `Unable to open VSCode. Make sure "code" command is available.`
				statusEl.style.color = '#dc3545'
			}
		}
	}

	function _renderModuleTree(nodes, container, parentPath) {
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
					const info = moduleEditorState.treeNodes.get(path)
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

				moduleEditorState.treeNodes.set(path, {
					checkbox,
					isDir: true,
					parent: parentPath,
					children: children.map((child) => child.path),
				})

				_renderModuleTree(children, childrenContainer, path)
			} else {
				const leaf = document.createElement('div')
				leaf.className = 'tree-leaf'
				const checkbox = document.createElement('input')
				checkbox.type = 'checkbox'
				checkbox.dataset.path = path
				checkbox.addEventListener('change', (e) => {
					if (e.target.checked) {
						moduleEditorState.selectedAssets.add(path)
					} else {
						moduleEditorState.selectedAssets.delete(path)
					}
					const info = moduleEditorState.treeNodes.get(path)
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

				moduleEditorState.treeNodes.set(path, {
					checkbox,
					isDir: false,
					parent: parentPath,
					children: [],
				})
			}
		})
	}

	function setNodeAndChildren(path, isChecked) {
		const node = moduleEditorState.treeNodes.get(path)
		if (!node) return

		node.checkbox.checked = isChecked
		node.checkbox.indeterminate = false

		if (node.isDir) {
			node.children.forEach((childPath) => {
				setNodeAndChildren(childPath, isChecked)
			})
		} else if (isChecked) {
			moduleEditorState.selectedAssets.add(path)
		} else {
			moduleEditorState.selectedAssets.delete(path)
		}
		scheduleEditorPreview()
	}

	function updateAncestorStates(startPath) {
		let currentPath = startPath
		while (currentPath) {
			const node = moduleEditorState.treeNodes.get(currentPath)
			if (!node) break
			if (!node.isDir) {
				currentPath = node.parent
				continue
			}

			let allChecked = true
			let anyChecked = false
			node.children.forEach((childPath) => {
				const childNode = moduleEditorState.treeNodes.get(childPath)
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
		const button = document.getElementById('module-edit-launch-jupyter-btn')
		const button2 = document.getElementById('module-edit-launch-jupyter-btn-2')
		const statusRow = document.getElementById('module-jupyter-status')

		const isLoading = button?.dataset.loading === 'true'
		const buttonText = moduleEditorState.jupyter.running ? 'Stop Jupyter' : 'Launch Jupyter'

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

		if (moduleEditorState.jupyter.running) {
			let linkUrl =
				moduleEditorState.jupyter.url ||
				(moduleEditorState.jupyter.port
					? `http://localhost:${moduleEditorState.jupyter.port}`
					: null)

			// Append token if available
			if (linkUrl && moduleEditorState.jupyter.token) {
				const separator = linkUrl.includes('?') ? '&' : '?'
				linkUrl = `${linkUrl}${separator}token=${moduleEditorState.jupyter.token}`
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
		if (!moduleEditorState.modulePath) return
		const statusEl = document.getElementById('module-edit-status')

		try {
			const result = await invoke('get_jupyter_status', {
				modulePath: moduleEditorState.modulePath,
			})
			moduleEditorState.jupyter.running = !!result.running
			moduleEditorState.jupyter.port = result.port ?? null
			moduleEditorState.jupyter.url = result.url ?? null
			moduleEditorState.jupyter.token = result.token ?? null
			updateJupyterControls()
			if (showMessage) {
				if (moduleEditorState.jupyter.running) {
					const linkUrl =
						moduleEditorState.jupyter.url ||
						(moduleEditorState.jupyter.port
							? `http://localhost:${moduleEditorState.jupyter.port}`
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

	async function handleSaveModuleEditor() {
		if (!moduleEditorState.modulePath) {
			alert('Select or create a module first')
			return
		}

		const statusEl = document.getElementById('module-edit-status')
		statusEl.textContent = ''
		statusEl.style.color = '#666'

		const nameValue = document.getElementById('module-edit-name').value.trim()
		const authorInputEl = document.getElementById('module-edit-author')
		const authorValue = authorInputEl.value.trim()
		const workflowValue = document.getElementById('module-edit-workflow').value.trim()
		const templateValue = document.getElementById('module-edit-template').value.trim()
		const versionValue = document.getElementById('module-edit-version').value.trim()

		if (!nameValue) {
			alert('Module name cannot be empty')
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

		statusEl.textContent = 'Saving module...'
		statusEl.style.color = '#666'

		try {
			const assets = Array.from(moduleEditorState.selectedAssets)
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
			moduleEditorState.skipNextDigestReload = true

			const saved = await invoke('save_module_editor', {
				moduleId: moduleEditorState.moduleId,
				modulePath: moduleEditorState.modulePath,
				payload,
			})
			moduleEditorState.moduleId = saved.id
			moduleEditorState.modulePath = saved.module_path
			moduleEditorState.metadata = {
				...(moduleEditorState.metadata || {}),
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
			statusEl.textContent = '✅ Module saved'
			statusEl.style.color = '#28a745'
			await loadModules()
			await checkSpecDigest(true)
		} catch (error) {
			console.error('Failed to save module:', error)
			statusEl.textContent = `Error saving module: ${error}`
			statusEl.style.color = '#dc3545'
		}
	}

	async function handleOpenModuleFolder() {
		if (!moduleEditorState.modulePath) {
			alert('Select a module first')
			return
		}

		try {
			await invoke('open_folder', { path: moduleEditorState.modulePath })
		} catch (error) {
			console.error('Failed to open module folder:', error)
			alert(`Failed to open folder: ${error}`)
		}
	}

	async function handleLaunchJupyter() {
		const launchBtn = document.getElementById('step-edit-jupyter-btn')
		const launchBtn2 = document.getElementById('module-edit-launch-jupyter-btn')
		const launchBtn3 = document.getElementById('module-edit-launch-jupyter-btn-2')
		const resetBtn = document.getElementById('module-edit-reset-jupyter-btn')

		if (!moduleEditorState.modulePath) {
			alert('Select a module first')
			return
		}

		const statusEl =
			document.getElementById('step-status-message') ||
			document.getElementById('module-edit-status')
		if (statusEl) statusEl.style.color = '#666'

		if (moduleEditorState.jupyter.running) {
			const message = 'Stopping Jupyter server...\nCommand: uv run --python .venv jupyter lab stop'
			showOperationModal(message)
			setButtonLoadingState(launchBtn, true, 'Stopping...')
			setButtonLoadingState(launchBtn2, true, 'Stopping...')
			setButtonLoadingState(launchBtn3, true, 'Stopping...')
			if (resetBtn) resetBtn.disabled = true
			if (statusEl) statusEl.textContent = 'Stopping Jupyter (jupyter lab stop)...'
			try {
				const result = await invoke('stop_jupyter', {
					modulePath: moduleEditorState.modulePath,
				})
				moduleEditorState.jupyter.running = !!result.running
				moduleEditorState.jupyter.port = result.port ?? null
				moduleEditorState.jupyter.url = result.url ?? null
				moduleEditorState.jupyter.token = result.token ?? null
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
			'Launching Jupyter...\nCommands:\n- uv pip install -U --python .venv jupyterlab cleon\n- uv run --python .venv jupyter lab'
		showOperationModal(launchMessage)
		setButtonLoadingState(launchBtn, true, 'Starting...')
		setButtonLoadingState(launchBtn2, true, 'Starting...')
		setButtonLoadingState(launchBtn3, true, 'Starting...')
		if (resetBtn) resetBtn.disabled = true
		if (statusEl)
			statusEl.textContent =
				'Launching Jupyter... (uv pip install -U --python .venv jupyterlab cleon)'

		try {
			const result = await invoke('launch_jupyter', {
				modulePath: moduleEditorState.modulePath,
				pythonVersion: null,
			})
			moduleEditorState.jupyter.running = !!result.running
			moduleEditorState.jupyter.port = result.port ?? null
			moduleEditorState.jupyter.url = result.url ?? null
			moduleEditorState.jupyter.token = result.token ?? null
			updateJupyterControls()

			const launchUrl =
				moduleEditorState.jupyter.url ||
				(moduleEditorState.jupyter.port
					? `http://localhost:${moduleEditorState.jupyter.port}`
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
		const resetBtn = document.getElementById('module-edit-reset-jupyter-btn')
		const launchBtn = document.getElementById('step-edit-jupyter-btn')
		const launchBtn2 = document.getElementById('module-edit-launch-jupyter-btn')
		const launchBtn3 = document.getElementById('module-edit-launch-jupyter-btn-2')

		if (!moduleEditorState.modulePath) {
			alert('Select a module first')
			return
		}

		const confirmed = await dialog.confirm(
			'Resetting will delete and recreate the module virtual environment. This will remove any additional packages you installed. Continue?',
			{ title: 'Reset Jupyter Environment', type: 'warning' },
		)

		if (!confirmed) {
			return
		}

		const statusEl =
			document.getElementById('step-status-message') ||
			document.getElementById('module-edit-status')
		if (statusEl) {
			statusEl.textContent = 'Resetting Jupyter environment...'
			statusEl.style.color = '#666'
		}
		setButtonLoadingState(resetBtn, true, 'Resetting...')
		if (launchBtn) launchBtn.disabled = true
		if (launchBtn2) launchBtn2.disabled = true
		if (launchBtn3) launchBtn3.disabled = true
		const modalMessage =
			'Resetting Jupyter environment...\nSteps:\n- Remove existing .venv\n- uv pip install -U --python .venv jupyterlab cleon'
		showOperationModal(modalMessage)

		try {
			const result = await invoke('reset_jupyter', {
				modulePath: moduleEditorState.modulePath,
				pythonVersion: null,
			})
			moduleEditorState.jupyter.running = !!result.status.running
			moduleEditorState.jupyter.port = result.status.port ?? null
			moduleEditorState.jupyter.url = result.status.url ?? null
			moduleEditorState.jupyter.token = result.status.token ?? null
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

	function showCreateFlowModal() {
		alert('Flow creation wizard coming soon! For now, use the CLI:\n\nbv flow create')
	}

	// =============================================================================
	// NEW SIMPLIFIED PROJECT EDITOR
	// =============================================================================

	function renderSimpleModuleEditor(data) {
		// Populate basic info
		document.getElementById('step-name-input').value = data.metadata.name || ''
		document.getElementById('step-author-input').value = data.metadata.author || ''
		document.getElementById('step-version-input').value = data.metadata.version || '1.0.0'
		document.getElementById('step-workflow-input').value = data.metadata.workflow || 'workflow.nf'
		document.getElementById('step-template-select').value =
			data.metadata.template || 'dynamic-nextflow'
		document.getElementById('step-path-display').textContent = data.module_path || ''

		// Store state - use module_id from response (may be null for unregistered modules)
		moduleEditorState.moduleId = data.module_id ?? null
		moduleEditorState.modulePath = data.module_path
		moduleEditorState.metadata = data.metadata
		moduleEditorState.files = data.metadata.assets || []
		moduleEditorState.inputs = data.metadata.inputs || []
		moduleEditorState.outputs = data.metadata.outputs || []
		moduleEditorState.parameters = data.metadata.parameters || []

		console.log('[Editor] Loaded module:', {
			id: moduleEditorState.moduleId,
			path: moduleEditorState.modulePath,
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
				navigateTo('modules')
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
			folderBtn.onclick = () => handleOpenModuleFolder()
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
				alert('File upload coming soon! For now, add files directly to the module folder.')
			}

			fileInput.onchange = () => {
				alert('File upload coming soon! For now, add files directly to the module folder.')
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
		const ioClose = document.getElementById('io-modal-close')
		const ioCancel = document.getElementById('io-modal-cancel')
		const ioSave = document.getElementById('io-modal-save')

		if (ioClose) ioClose.onclick = () => hideIOModal()
		if (ioCancel) ioCancel.onclick = () => hideIOModal()
		if (ioSave) ioSave.onclick = () => saveIO()

		// Parameter Modal
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

		if (moduleEditorState.files.length === 0) {
			container.innerHTML =
				'<p class="empty-state">No files yet. Add Python, R, or other scripts above.</p>'
			return
		}

		container.innerHTML = moduleEditorState.files
			.map(
				(file, index) => `
			<div class="file-item">
				<div class="file-item-info">
					<svg class="file-icon" width="20" height="20" viewBox="0 0 20 20" fill="none">
						<path d="M4 2H10L12 4H16C17.1 4 18 4.9 18 6V16C18 17.1 17.1 18 16 18H4C2.9 18 2 17.1 2 16V4C2 2.9 2.9 2 4 2Z" stroke="currentColor" stroke-width="2"/>
					</svg>
					<span class="file-name">${escapeHtml(file)}</span>
				</div>
				<button class="file-remove-btn" onclick="window.moduleEditor.removeFile(${index})">&times;</button>
			</div>
		`,
			)
			.join('')
	}

	function renderIOList(type) {
		const container = document.getElementById(`${type}-list`)
		if (!container) return

		const items = moduleEditorState[type]
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
					<button class="io-edit-btn" onclick="window.moduleEditor.editIO('${type}', ${index})">Edit</button>
					<button class="io-remove-btn" onclick="window.moduleEditor.removeIO('${type}', ${index})">Remove</button>
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

		const items = moduleEditorState.parameters

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
					<button class="io-edit-btn" onclick="window.moduleEditor.editParameter(${index})">Edit</button>
					<button class="io-remove-btn" onclick="window.moduleEditor.removeParameter(${index})">Remove</button>
				</div>
			</div>
		`,
			)
			.join('')
	}

	function showIOModal(type, item = null, index = -1) {
		const modal = document.getElementById('io-modal')
		const title = document.getElementById('io-modal-title')

		moduleEditorState.editingType = type
		moduleEditorState.editingIndex = index
		moduleEditorState.editingItem = item

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
		moduleEditorState.editingType = null
		moduleEditorState.editingIndex = -1
		moduleEditorState.editingItem = null
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

		const listKey = moduleEditorState.editingType + 's'

		if (moduleEditorState.editingIndex >= 0) {
			// Edit existing
			moduleEditorState[listKey][moduleEditorState.editingIndex] = item
		} else {
			// Add new
			moduleEditorState[listKey].push(item)
		}

		renderIOList(listKey)
		hideIOModal()

		// Auto-save after adding/editing I/O
		debouncedAutoSave()
	}

	function showParameterModal(item = null, index = -1) {
		const modal = document.getElementById('param-modal')
		const title = document.getElementById('param-modal-title')

		moduleEditorState.editingIndex = index
		moduleEditorState.editingItem = item

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
		moduleEditorState.editingIndex = -1
		moduleEditorState.editingItem = null
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

		if (moduleEditorState.editingIndex >= 0) {
			// Edit existing
			moduleEditorState.parameters[moduleEditorState.editingIndex] = item
		} else {
			// Add new
			moduleEditorState.parameters.push(item)
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
			autoSaveModule()
		}, 800) // Save 800ms after user stops typing
	}

	async function autoSaveModule() {
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
			assets: moduleEditorState.files,
			version: version || '1.0.0',
			spec: {
				parameters: moduleEditorState.parameters,
				inputs: moduleEditorState.inputs,
				outputs: moduleEditorState.outputs,
			},
		})

		try {
			console.log('[Auto-save] Saving:', {
				moduleId: moduleEditorState.moduleId,
				modulePath: moduleEditorState.modulePath,
				name: payload.name,
			})

			// Call backend - it will update existing module, not create new one
			const result = await invoke('save_module_editor', {
				moduleId: moduleEditorState.moduleId,
				modulePath: moduleEditorState.modulePath,
				payload,
			})

			// Update module ID if it was null before
			if (!moduleEditorState.moduleId && result.id) {
				moduleEditorState.moduleId = result.id
				console.log('[Auto-save] Updated module ID:', result.id)
			}

			// Show saved indicator
			if (indicator) {
				indicator.classList.remove('saving')
				indicator.querySelector('span').textContent = 'Saved'
				setTimeout(() => {
					indicator.classList.remove('visible')
				}, 2000)
			}

			// Silently refresh module list
			await loadModules()
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
	window.moduleEditor = {
		removeFile: (index) => {
			moduleEditorState.files.splice(index, 1)
			renderFilesList()
			debouncedAutoSave()
		},
		editIO: (type, index) => {
			const item = moduleEditorState[type][index]
			showIOModal(type.replace(/s$/, ''), item, index)
		},
		removeIO: (type, index) => {
			if (confirm('Remove this item?')) {
				moduleEditorState[type].splice(index, 1)
				renderIOList(type)
				debouncedAutoSave()
			}
		},
		editParameter: (index) => {
			const item = moduleEditorState.parameters[index]
			showParameterModal(item, index)
		},
		removeParameter: (index) => {
			if (confirm('Remove this parameter?')) {
				moduleEditorState.parameters.splice(index, 1)
				renderParametersList()
				debouncedAutoSave()
			}
		},
	}

	return {
		loadModules,
		importModule,
		importModuleFromFolder,
		showCreateModuleModal,
		showCreateFlowModal,
		hideCreateModuleModal,
		handleModuleNameInputChange,
		chooseModuleDirectory,
		resetModuleDirectory,
		createModuleFromModal,
		handleSaveModuleEditor,
		handleLaunchJupyter,
		handleResetJupyter,
		handleOpenModuleFolder,
		handleLeaveModuleEditor,
		handleReloadModuleSpec,
		handleCreateTabNext,
		handleCreateTabBack,
		openModuleEditor, // Export for flows module
	}
}
