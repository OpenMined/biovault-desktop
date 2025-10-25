export function createRunsModule({ invoke, listen }) {
	let selectedParticipants = []
	let selectedProject = null
	let currentRunLogListeners = []
	let currentLogRunId = null
	let currentLogWorkDir = null
	let navigateTo = () => {}

	// Listen for pipeline completion to refresh runs list
	listen('pipeline-complete', async () => {
		await loadRuns()
	})

	async function loadRunParticipants() {
		try {
			const participants = await invoke('get_participants')
			const container = document.getElementById('run-participants-list')
			container.innerHTML = ''

			// Check for preselected participants from Data view
			const preselectedJson = sessionStorage.getItem('preselectedParticipants')
			const preselectedIds = preselectedJson ? JSON.parse(preselectedJson) : []

			// Clear from session storage after reading
			if (preselectedIds.length > 0) {
				sessionStorage.removeItem('preselectedParticipants')
				selectedParticipants = [...preselectedIds]
			}

			participants.forEach((p) => {
				const item = document.createElement('div')
				item.className = 'selection-item'
				item.dataset.id = p.id

				const isPreselected = preselectedIds.includes(p.id)
				if (isPreselected) {
					item.classList.add('selected')
				}

				item.innerHTML = `
					<input type="checkbox" id="part-${p.id}" ${isPreselected ? 'checked' : ''} />
					<label for="part-${p.id}">${p.participant_id}</label>
				`

				item.addEventListener('click', (e) => {
					if (e.target.tagName !== 'INPUT') {
						const checkbox = item.querySelector('input')
						checkbox.checked = !checkbox.checked
					}

					const participantId = parseInt(item.dataset.id)
					if (item.querySelector('input').checked) {
						if (!selectedParticipants.includes(participantId)) {
							selectedParticipants.push(participantId)
						}
						item.classList.add('selected')
					} else {
						selectedParticipants = selectedParticipants.filter((id) => id !== participantId)
						item.classList.remove('selected')
					}
					updateRunButton()
				})

				container.appendChild(item)
			})

			// Update button after loading with preselections
			updateRunButton()
		} catch (error) {
			console.error('Error loading participants:', error)
		}
	}

	async function loadRunProjects() {
		try {
			const projects = await invoke('get_projects')
			const container = document.getElementById('run-projects-list')
			container.innerHTML = ''

			projects.forEach((p) => {
				const item = document.createElement('div')
				item.className = 'selection-item'
				item.dataset.id = p.id
				item.innerHTML = `<strong>${p.name}</strong> - ${p.workflow}`

				item.addEventListener('click', () => {
					document
						.querySelectorAll('#run-projects-list .selection-item')
						.forEach((i) => i.classList.remove('selected'))
					item.classList.add('selected')
					selectedProject = parseInt(item.dataset.id)
					updateRunButton()
				})

				container.appendChild(item)
			})
		} catch (error) {
			console.error('Error loading projects:', error)
		}
	}

	function updateRunButton() {
		const btn = document.getElementById('run-btn')
		btn.disabled = selectedParticipants.length === 0 || selectedProject === null
	}

	function prepareRunView() {
		selectedParticipants = []
		selectedProject = null
		const selectAll = document.getElementById('select-all-participants')
		if (selectAll) {
			selectAll.checked = false
		}
		loadRunParticipants()
		loadRunProjects()
		updateRunButton()
	}

	async function loadRuns() {
		try {
			// Load only pipeline runs (steps are now called projects)
			const pipelineRuns = await invoke('get_pipeline_runs')
			const pipelines = await invoke('get_pipelines') // Get pipeline names

			const container = document.getElementById('runs-list')

			if (pipelineRuns.length === 0) {
				container.innerHTML =
					'<p style="color: #666;">No pipeline runs yet. Run a pipeline to see results here.</p>'
				return
			}

			container.innerHTML = ''

			// Display pipeline runs
			pipelineRuns.forEach((run) => {
				// Find pipeline name
				const pipeline = pipelines.find((p) => p.id === run.pipeline_id)
				const pipelineName = pipeline ? pipeline.name : `Pipeline #${run.pipeline_id}`
				const card = document.createElement('div')
				card.className = 'pipeline-run-card'
				card.dataset.runId = run.id
				card.dataset.expanded = 'false'

				let statusBadge, statusClass
				if (run.status === 'success') {
					statusBadge = '<span class="status-badge status-success">✓ Success</span>'
					statusClass = 'success'
				} else if (run.status === 'failed') {
					statusBadge = '<span class="status-badge status-failed">✗ Failed</span>'
					statusClass = 'failed'
				} else {
					statusBadge = '<span class="status-badge status-running">⋯ Running</span>'
					statusClass = 'running'
				}

				const timeAgo = getTimeAgo(new Date(run.created_at))

				card.innerHTML = `
				<div class="run-header" data-run-id="${run.id}">
					<svg class="run-chevron" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
						<polyline points="9 18 15 12 9 6"></polyline>
					</svg>
					<div class="run-status-icon ${statusClass}">
						${run.status === 'success' ? '✓' : run.status === 'failed' ? '✗' : '⋯'}
					</div>
					<div class="run-main-info">
						<div class="run-title">${pipelineName}</div>
						<div class="run-subtitle">Run #${run.id} • ${timeAgo}</div>
					</div>
					${statusBadge}
					<button class="run-delete-btn" data-run-id="${run.id}" title="Delete run">
						<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
							<path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
						</svg>
					</button>
				</div>
				<div class="run-details" style="display: none;">
					<div class="loading-steps">Loading steps...</div>
				</div>
			`

				// Handle expand/collapse
				const header = card.querySelector('.run-header')
				header.addEventListener('click', async (e) => {
					if (e.target.closest('.run-delete-btn')) return

					const isExpanded = card.dataset.expanded === 'true'
					card.dataset.expanded = isExpanded ? 'false' : 'true'

					const detailsContainer = card.querySelector('.run-details')
					if (!isExpanded) {
						detailsContainer.style.display = 'block'
						await loadPipelineRunSteps(run, pipeline, detailsContainer, statusClass)
					} else {
						detailsContainer.style.display = 'none'
					}
				})

				// Handle delete
				const deleteBtn = card.querySelector('.run-delete-btn')
				deleteBtn.addEventListener('click', async (e) => {
					e.stopPropagation()
					if (confirm('Delete this pipeline run and all its results?')) {
						try {
							await invoke('delete_pipeline_run', { runId: run.id })
							await loadRuns()
						} catch (error) {
							alert(`Error deleting run: ${error}`)
						}
					}
				})

				container.appendChild(card)
			})
		} catch (error) {
			console.error('Error loading runs:', error)
		}
	}

	// Helper function for relative time
	function getTimeAgo(date) {
		const seconds = Math.floor((new Date() - date) / 1000)
		const minutes = Math.floor(seconds / 60)
		const hours = Math.floor(minutes / 60)
		const days = Math.floor(hours / 24)

		if (days > 0) return `${days}d ago`
		if (hours > 0) return `${hours}h ago`
		if (minutes > 0) return `${minutes}m ago`
		return 'Just now'
	}

	// Load steps for an expanded pipeline run
	async function loadPipelineRunSteps(run, pipeline, container, statusClass) {
		try {
			const steps = pipeline && pipeline.spec && pipeline.spec.steps ? pipeline.spec.steps : []

			container.innerHTML = `
				<div class="steps-container">
					${steps
						.map(
							(step, index) => `
						<div class="step-row">
							<div class="step-icon ${statusClass}">
								${run.status === 'success' ? '✓' : run.status === 'failed' ? '✗' : '⋯'}
							</div>
							<div class="step-content">
								<div class="step-title">${step.id}</div>
								<div class="step-path">${step.uses}</div>
							</div>
							<div class="step-actions">
								<button class="step-btn" onclick="window.invoke('open_folder', { path: '${
									run.results_dir || run.work_dir
								}' })" title="Open results">
									<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
										<path d="M3 7v10a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-6l-2-2H5a2 2 0 0 0-2 2z"></path>
									</svg>
								</button>
							</div>
						</div>
					`,
						)
						.join('')}
				</div>
			`
		} catch (error) {
			container.innerHTML = `<p class="error-message">Error loading steps: ${error}</p>`
		}
	}

	async function showRunLogs(runId, projectName, workDir = null) {
		const logViewer = document.getElementById('log-viewer')
		const logContent = document.getElementById('log-content')
		const logRunName = document.getElementById('log-run-name')
		const shareBtn = document.getElementById('share-logs-btn')

		currentLogRunId = runId
		currentLogWorkDir = workDir

		logViewer.classList.add('active')
		logContent.textContent = 'Loading logs...'
		logRunName.textContent = `(${projectName})`

		// Show share button if we have a work dir
		if (workDir) {
			shareBtn.style.display = 'block'
		} else {
			shareBtn.style.display = 'none'
		}

		try {
			const logs = await invoke('get_run_logs', { runId })
			logContent.textContent = logs
			logContent.scrollTop = logContent.scrollHeight
		} catch (error) {
			logContent.textContent = `Error loading logs: ${error}`
		}
	}

	async function runAnalysis() {
		if (selectedParticipants.length === 0 || selectedProject === null) return

		const btn = document.getElementById('run-btn')
		btn.disabled = true
		btn.textContent = 'Starting...'

		try {
			// First, create the run record
			const result = await invoke('start_analysis', {
				participantIds: selectedParticipants,
				projectId: selectedProject,
			})

			// Navigate to Results tab BEFORE starting execution
			navigateTo('runs')
			await loadRuns()

			// Show log viewer and set it up
			const logViewer = document.getElementById('log-viewer')
			const logContent = document.getElementById('log-content')
			const logRunName = document.getElementById('log-run-name')
			const shareBtn = document.getElementById('share-logs-btn')

			logViewer.classList.add('active')
			logContent.textContent = ''
			logContent.dataset.runId = result.run_id
			logRunName.textContent = ''
			shareBtn.style.display = 'block'

			currentLogRunId = result.run_id
			currentLogWorkDir = result.work_dir

			// Load initial log content
			try {
				const initialLogs = await invoke('get_run_logs', { runId: result.run_id })
				logContent.textContent = initialLogs + '\n'
				logContent.scrollTop = logContent.scrollHeight
			} catch (error) {
				logContent.textContent = 'Initializing...\n'
			}

			// Clean up old listeners
			currentRunLogListeners.forEach((unlisten) => unlisten())
			currentRunLogListeners = []

			// Set up event listeners for logs
			const unlisten = await listen('log-line', (event) => {
				logContent.textContent += event.payload + '\n'
				logContent.scrollTop = logContent.scrollHeight
			})

			const unlistenComplete = await listen('analysis-complete', async (event) => {
				logContent.textContent += `\n=== Analysis ${event.payload} ===\n`
				await loadRuns()
				unlisten()
				unlistenComplete()
				currentRunLogListeners = []
			})

			currentRunLogListeners = [unlisten, unlistenComplete]

			// Use setTimeout to ensure UI updates before starting execution
			setTimeout(() => {
				invoke('execute_analysis', { runId: result.run_id }).catch((error) => {
					logContent.textContent += `\nError: ${error}\n`
					console.error('Analysis failed:', error)
				})
			}, 100)
		} catch (error) {
			alert(`Error: ${error}`)
		} finally {
			btn.disabled = false
			btn.textContent = 'Run Analysis'
		}
	}

	function toggleSelectAllParticipants(checked) {
		const checkboxes = document.querySelectorAll('#run-participants-list input[type="checkbox"]')
		const items = document.querySelectorAll('#run-participants-list .selection-item')

		checkboxes.forEach((checkbox, index) => {
			checkbox.checked = checked
			const item = items[index]
			if (!item) return
			const participantId = parseInt(item.dataset.id)

			if (checked) {
				if (!selectedParticipants.includes(participantId)) {
					selectedParticipants.push(participantId)
				}
				item.classList.add('selected')
			} else {
				selectedParticipants = selectedParticipants.filter((id) => id !== participantId)
				item.classList.remove('selected')
			}
		})

		updateRunButton()
	}

	async function shareCurrentRunLogs() {
		if (!currentLogWorkDir) return
		try {
			await invoke('open_folder', { path: currentLogWorkDir })
		} catch (error) {
			alert(`Error opening folder: ${error}`)
		}
	}

	function setNavigateTo(fn) {
		navigateTo = typeof fn === 'function' ? fn : () => {}
	}

	return {
		prepareRunView,
		loadRuns,
		runAnalysis,
		toggleSelectAllParticipants,
		shareCurrentRunLogs,
		setNavigateTo,
	}
}
