import { createProjectSpecForm, generateContractAscii } from './project-spec-form.js'

const CREATE_WIZARD_STEP_COUNT = 6
const CREATE_WIZARD_STEP_LABELS = [
	'Project Details',
	'Inputs',
	'Parameters',
	'Outputs',
	'Preview',
	'Review & Create',
]
const CREATE_SPEC_STEP_CONFIG = {
	1: { containerId: 'create-project-inputs', sections: ['inputs'], defaultTab: 'inputs' },
	2: {
		containerId: 'create-project-parameters',
		sections: ['parameters'],
		defaultTab: 'parameters',
	},
	3: { containerId: 'create-project-outputs', sections: ['outputs'], defaultTab: 'outputs' },
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
		currentStep: 0,
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
		if (!projectName) {
			wizardPreviewRequestId += 1
			clearWizardPreview('Enter a project name to generate a preview.')
			return
		}
		const spec = getCreateSpecPayload()
		const payload = buildSpecSavePayload({
			name: projectName,
			author: '',
			workflow: 'workflow.nf',
			template: templateSelect && templateSelect.value ? templateSelect.value : null,
			assets: [],
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
					onChange: (parameters, inputs, outputs) => {
						projectCreateState.specData = { parameters, inputs, outputs }
						renderCreateReview()
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
				nameInput.addEventListener('input', () => updateCreateSpecSummary())
				projectCreateState.nameListenerBound = true
			}
		}
	}

	function updateCreateSpecSummary() {
		renderCreateReview()
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

	function renderCreateReview() {
		const nameEl = document.getElementById('create-project-review-name')
		if (!nameEl) return
		const nameInput = document.getElementById('new-project-name')
		const versionInput = document.getElementById('new-project-version')
		const pathInput = document.getElementById('new-project-path')

		const nameValue = nameInput ? nameInput.value.trim() : ''
		const versionValue = versionInput ? versionInput.value.trim() || '1.0.0' : '1.0.0'
		const pathValue = pathInput ? pathInput.value.trim() : ''

		nameEl.textContent = nameValue || '—'
		const templateLabel = document.querySelector('#new-project-template option:checked')
		const templateText = templateLabel?.textContent?.trim() || 'Blank project'
		const templateEl = document.getElementById('create-project-review-template')
		if (templateEl) {
			templateEl.textContent = templateText
		}
		const versionEl = document.getElementById('create-project-review-version')
		if (versionEl) {
			versionEl.textContent = versionValue || '—'
		}
		const pathEl = document.getElementById('create-project-review-path')
		if (pathEl) {
			pathEl.textContent = pathValue || '—'
		}

		const spec = getCreateSpecPayload()
		const ascii = generateContractAscii({
			name: nameValue || 'New Project',
			parameters: spec.parameters,
			inputs: spec.inputs,
			outputs: spec.outputs,
		})
		const asciiEl = document.getElementById('create-project-review-ascii')
		if (asciiEl) {
			asciiEl.textContent = ascii
		}
		scheduleWizardPreview()
	}

	function setCreateWizardStep(step) {
		projectCreateState.currentStep = step
		const sections = document.querySelectorAll('.project-wizard-step')
		sections.forEach((section) => {
			const idx = Number(section.dataset.step)
			section.classList.toggle('active', idx === step)
		})
		const indicators = document.querySelectorAll('.project-wizard-steps li')
		indicators.forEach((indicator) => {
			indicator.classList.toggle('active', Number(indicator.dataset.step) === step)
		})

		// Auto-collapse preview panels when entering step 4
		if (step === 4) {
			const yamlWrapper = document.getElementById('create-project-preview-yaml-wrapper')
			const templateWrapper = document.getElementById('create-project-preview-template-wrapper')
			if (yamlWrapper) yamlWrapper.open = true
			if (templateWrapper) templateWrapper.open = false
		}

		const backBtn = document.getElementById('create-project-back')
		const nextBtn = document.getElementById('create-project-next')
		const confirmBtn = document.getElementById('create-project-confirm')
		if (backBtn) backBtn.disabled = step === 0
		if (nextBtn) {
			if (step >= CREATE_WIZARD_STEP_COUNT - 1) {
				nextBtn.style.display = 'none'
			} else {
				nextBtn.style.display = 'inline-flex'
				const nextLabel = CREATE_WIZARD_STEP_LABELS[step + 1] || 'Next'
				nextBtn.textContent = `Next: ${nextLabel}`
			}
		}
		if (confirmBtn) {
			confirmBtn.style.display = step === CREATE_WIZARD_STEP_COUNT - 1 ? 'inline-flex' : 'none'
		}

		const specConfig = CREATE_SPEC_STEP_CONFIG[step]
		if (specConfig) {
			ensureCreateSpecForm(specConfig)
			scheduleWizardPreview()
		} else if (step === 4) {
			// Preview step - update code previews
			scheduleWizardPreview()
		} else if (step === CREATE_WIZARD_STEP_COUNT - 1) {
			// Final review step
			renderCreateReview()
		} else {
			scheduleWizardPreview()
		}
	}

	async function handleCreateWizardNext() {
		const current = projectCreateState.currentStep || 0

		if (current === 0) {
			const projectName = document.getElementById('new-project-name').value.trim()
			if (!projectName) {
				await dialog.message('Please enter a project name to continue.', {
					title: 'Name Required',
					type: 'warning',
				})
				document.getElementById('new-project-name').focus()
				return
			}

			let destination = document.getElementById('new-project-path').value.trim()
			if (!destination) {
				destination = await fetchDefaultProjectPath(projectName)
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
				return
			}
		}

		if (current < CREATE_WIZARD_STEP_COUNT - 1) {
			setCreateWizardStep(current + 1)
		}
	}

	function handleCreateWizardBack() {
		const current = projectCreateState.currentStep || 0
		if (current > 0) {
			setCreateWizardStep(current - 1)
		}
	}

	function handleWizardStepClick(targetStep) {
		if (targetStep >= 0 && targetStep < CREATE_WIZARD_STEP_COUNT) {
			setCreateWizardStep(targetStep)
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
			const container = document.getElementById('projects-list')

			if (!projects || projects.length === 0) {
				container.innerHTML = '<p style="color: #666;">No projects found in BioVault.</p>'
				return
			}

			container.innerHTML = ''

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
				container.appendChild(card)
			})
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
			templateSelect.onchange = () => renderCreateReview()
		}
		if (versionInput) {
			versionInput.value = '1.0.0'
			versionInput.oninput = () => renderCreateReview()
		}
		projectCreateState.selectedDir = null
		projectCreateState.usingDefault = true

		// Supported templates list intentionally left blank for now
		if (templateSelect) {
			templateSelect.innerHTML = '<option value="">Blank Project</option>'
		}

		const defaultPath = await fetchDefaultProjectPath('')
		projectCreateState.defaultDir = defaultPath
		if (pathInput) {
			pathInput.value = defaultPath
		}

		ensureCreateSpecForm(CREATE_SPEC_STEP_CONFIG[1])
		projectCreateState.specData = { parameters: [], inputs: [], outputs: [] }
		projectCreateState.specForm?.setSpec(projectCreateState.specData)
		projectCreateState.specForm?.configureSections(['inputs'], 'inputs')
		updateCreateSpecSummary()
		clearWizardPreview('Preview will appear once details are filled in.')
		setCreateWizardStep(0)
		modal.style.display = 'flex'
		document.body.classList.add('modal-open')
		setTimeout(() => nameInput?.focus(), 100)
	}

	function hideCreateProjectModal() {
		const modal = document.getElementById('create-project-modal')
		modal.style.display = 'none'
		document.body.classList.remove('modal-open')
	}

	async function handleProjectNameInputChange() {
		const nameValue = document.getElementById('new-project-name').value.trim()
		if (projectCreateState.usingDefault) {
			const defaultPath = await fetchDefaultProjectPath(nameValue)
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
			renderCreateReview()
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
		renderCreateReview()
	}

	async function createProjectFromModal() {
		ensureCreateSpecForm()
		const nameInput = document.getElementById('new-project-name')
		const templateSelect = document.getElementById('new-project-template')
		const confirmBtn = document.getElementById('create-project-confirm')
		const versionInput = document.getElementById('new-project-version')

		const projectName = nameInput.value.trim()
		if (!projectName) {
			await dialog.message('Please enter a project name', {
				title: 'Name Required',
				type: 'warning',
			})
			nameInput.focus()
			return
		}

		const example = templateSelect.value || null
		const directory = projectCreateState.selectedDir
		const versionValue = versionInput ? versionInput.value.trim() || '1.0.0' : '1.0.0'
		const spec = getCreateSpecPayload()
		const hasContract =
			spec.parameters.length > 0 || spec.inputs.length > 0 || spec.outputs.length > 0

		confirmBtn.disabled = true
		confirmBtn.textContent = 'Creating...'

		try {
			const project = await invoke('create_project', {
				name: projectName,
				example,
				directory: directory || null,
			})
			if (hasContract) {
				try {
					const editorPayload = await invoke('load_project_editor', {
						projectId: project.id,
					})
					const metadata = editorPayload.metadata
					const payload = buildSpecSavePayload({
						name: metadata.name || projectName,
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

		button.textContent = projectEditorState.jupyter.running ? 'Stop Jupyter' : 'Launch Jupyter'

		if (!statusRow) return

		if (projectEditorState.jupyter.running && projectEditorState.jupyter.port) {
			const url = `http://localhost:${projectEditorState.jupyter.port}`
			statusRow.style.display = 'block'
			statusRow.innerHTML =
				'Running at <button id="jupyter-open-link" class="link-button" type="button">🔗 ' +
				url +
				'</button>'
			const linkButton = document.getElementById('jupyter-open-link')
			if (linkButton) {
				linkButton.onclick = async () => {
					console.log('[Jupyter] Opening lab URL:', url)
					await openInExternalBrowser(url)
				}
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
			updateJupyterControls()
			if (showMessage) {
				if (projectEditorState.jupyter.running) {
					const portInfo = projectEditorState.jupyter.port
					statusEl.textContent = portInfo
						? `Jupyter is running on port ${portInfo}.`
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
		if (!projectEditorState.projectPath) {
			alert('Select a project first')
			return
		}

		const statusEl = document.getElementById('project-edit-status')
		statusEl.style.color = '#666'

		if (projectEditorState.jupyter.running) {
			const message = 'Stopping Jupyter server...\nCommand: uv run --python .venv jupyter lab stop'
			showOperationModal(message)
			statusEl.textContent = 'Stopping Jupyter (jupyter lab stop)...'
			try {
				const result = await invoke('stop_jupyter', {
					projectPath: projectEditorState.projectPath,
				})
				projectEditorState.jupyter.running = !!result.running
				projectEditorState.jupyter.port = result.port ?? null
				updateJupyterControls()
				statusEl.textContent = 'Jupyter server stopped.'
				statusEl.style.color = '#666'
				await refreshJupyterStatus(false)
			} catch (error) {
				console.error('Failed to stop Jupyter:', error)
				statusEl.textContent = `Error stopping Jupyter: ${error}`
				statusEl.style.color = '#dc3545'
			} finally {
				hideOperationModal()
			}
			return
		}

		const launchMessage =
			'Launching Jupyter...\nCommands:\n- uv pip install -U --python .venv jupyterlab bioscript\n- uv run --python .venv jupyter lab'
		showOperationModal(launchMessage)
		statusEl.textContent =
			'Launching Jupyter... (uv pip install -U --python .venv jupyterlab bioscript)'

		try {
			const result = await invoke('launch_jupyter', {
				projectPath: projectEditorState.projectPath,
				pythonVersion: null,
			})
			projectEditorState.jupyter.running = !!result.running
			projectEditorState.jupyter.port = result.port ?? null
			updateJupyterControls()

			if (projectEditorState.jupyter.port) {
				const url = `http://localhost:${projectEditorState.jupyter.port}`
				updateOperationModal('Opening browser...')
				await openInExternalBrowser(url)
				statusEl.textContent = `Jupyter running at ${url}`
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
			hideOperationModal()
		}
	}

	async function handleResetJupyter() {
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
			updateJupyterControls()
			statusEl.textContent = result.message || 'Jupyter environment reset. The server is stopped.'
			statusEl.style.color = '#28a745'
			await refreshJupyterStatus(true)
		} catch (error) {
			console.error('Failed to reset Jupyter:', error)
			statusEl.textContent = `Error resetting Jupyter: ${error}`
			statusEl.style.color = '#dc3545'
		} finally {
			hideOperationModal()
		}
	}

	return {
		loadProjects,
		importProject,
		showCreateProjectModal,
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
		handleCreateWizardNext,
		handleCreateWizardBack,
		handleWizardStepClick,
	}
}
