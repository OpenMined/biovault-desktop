export function createRunsModule({ invoke, listen }) {
	let selectedParticipants = []
	let selectedProject = null
	let currentRunLogListeners = []
	let currentLogRunId = null
	let currentLogWorkDir = null
	let navigateTo = () => {}

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
			const runs = await invoke('get_runs')
			const container = document.getElementById('runs-list')

			if (runs.length === 0) {
				container.innerHTML = '<p style="color: #666;">No runs yet.</p>'
				return
			}

			container.innerHTML = ''
			runs.forEach((run) => {
				const card = document.createElement('div')
				card.className = `run-card ${run.status}`
				card.style.cursor = 'pointer'
				card.dataset.runId = run.id
				card.dataset.projectName = run.project_name

				let statusBadge
				if (run.status === 'success') {
					statusBadge =
						'<span style="background: #28a745; color: white; padding: 4px 8px; border-radius: 4px; font-size: 12px;">Success</span>'
				} else if (run.status === 'failed') {
					statusBadge =
						'<span style="background: #dc3545; color: white; padding: 4px 8px; border-radius: 4px; font-size: 12px;">Failed</span>'
				} else {
					statusBadge =
						'<span style="background: #ffc107; color: black; padding: 4px 8px; border-radius: 4px; font-size: 12px;">Running</span>'
				}

				card.innerHTML = `
					<div style="display: flex; justify-content: space-between; align-items: start;">
						<div class="run-info">
							<h3>${run.project_name} ${statusBadge}</h3>
							<p><strong>Participants:</strong> ${run.participant_count}</p>
							<p><strong>Work Directory:</strong> ${run.work_dir}</p>
							<p><strong>Created:</strong> ${run.created_at}</p>
						</div>
						<div style="display: flex; gap: 10px;">
							<button class="open-folder-btn" data-path="${run.work_dir}">Open Folder</button>
							<button class="delete-btn" data-run-id="${run.id}">Delete</button>
						</div>
					</div>
				`

				// Make card clickable to show logs
				card.addEventListener('click', async (e) => {
					// Don't trigger if clicking buttons
					if (e.target.tagName === 'BUTTON') return
					await showRunLogs(run.id, run.project_name, run.work_dir)
				})

				container.appendChild(card)
			})

			document.querySelectorAll('.open-folder-btn').forEach((btn) => {
				btn.addEventListener('click', async (e) => {
					try {
						await invoke('open_folder', { path: e.target.dataset.path })
					} catch (error) {
						alert(`Error opening folder: ${error}`)
					}
				})
			})

			document.querySelectorAll('.run-card .delete-btn').forEach((btn) => {
				btn.addEventListener('click', async (e) => {
					const runId = parseInt(e.target.dataset.runId)
					if (
						confirm(
							'Are you sure you want to delete this run? This will remove all files and the database entry.',
						)
					) {
						try {
							await invoke('delete_run', { runId })

							// Hide log viewer if it's showing logs for the deleted run
							if (currentLogRunId === runId) {
								document.getElementById('log-viewer').classList.remove('active')
								currentLogRunId = null
								currentLogWorkDir = null
							}

							await loadRuns()
						} catch (error) {
							alert(`Error deleting run: ${error}`)
						}
					}
				})
			})
		} catch (error) {
			console.error('Error loading runs:', error)
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
