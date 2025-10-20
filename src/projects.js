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
	}

	const projectCreateState = {
		selectedDir: null,
		usingDefault: true,
		defaultDir: '',
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

		nameInput.value = ''
		nameInput.autocapitalize = 'none'
		nameInput.autocorrect = 'off'
		nameInput.spellcheck = false
		templateSelect.value = ''
		projectCreateState.selectedDir = null
		projectCreateState.usingDefault = true

		const defaultPath = await fetchDefaultProjectPath('')
		projectCreateState.defaultDir = defaultPath
		pathInput.value = defaultPath

		modal.style.display = 'flex'
		setTimeout(() => nameInput.focus(), 100)
	}

	function hideCreateProjectModal() {
		const modal = document.getElementById('create-project-modal')
		modal.style.display = 'none'
	}

	async function handleProjectNameInputChange() {
		if (!projectCreateState.usingDefault) {
			return
		}

		const nameValue = document.getElementById('new-project-name').value.trim()
		const defaultPath = await fetchDefaultProjectPath(nameValue)
		projectCreateState.defaultDir = defaultPath
		document.getElementById('new-project-path').value = defaultPath
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
	}

	async function createProjectFromModal() {
		const nameInput = document.getElementById('new-project-name')
		const templateSelect = document.getElementById('new-project-template')
		const confirmBtn = document.getElementById('create-project-confirm')

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

		confirmBtn.disabled = true
		confirmBtn.textContent = 'Creating...'

		try {
			const project = await invoke('create_project', {
				name: projectName,
				example,
				directory: directory || null,
			})
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
			navigateTo('project-edit')
		} catch (error) {
			console.error('Failed to load project editor:', error)
			alert(`Error loading project: ${error}`)
		}
	}

	function renderProjectEditor(data) {
		const pathEl = document.getElementById('project-edit-path')
		pathEl.textContent = data.project_path || ''

		document.getElementById('project-edit-name').value = data.metadata.name || ''
		document.getElementById('project-edit-author').value = data.metadata.author || ''
		document.getElementById('project-edit-workflow').value = data.metadata.workflow || ''
		document.getElementById('project-edit-template').value = data.metadata.template || ''

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
			const payload = {
				name: nameValue,
				author: authorValue,
				workflow: workflowValue,
				template: templateValue || null,
				assets,
			}

			const saved = await invoke('save_project_editor', {
				projectId: projectEditorState.projectId,
				projectPath: projectEditorState.projectPath,
				payload,
			})
			projectEditorState.projectId = saved.id
			projectEditorState.projectPath = saved.project_path
			statusEl.textContent = '✅ Project saved'
			statusEl.style.color = '#28a745'
			await loadProjects()
		} catch (error) {
			console.error('Failed to save project:', error)
			statusEl.textContent = `Error saving project: ${error}`
			statusEl.style.color = '#dc3545'
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
	}
}
