export function createRunsModule({ invoke, listen }) {
	let selectedParticipants = []
	let selectedProject = null
	let currentRunLogListeners = []
	let _currentLogRunId = null
	let currentLogWorkDir = null
	let navigateTo = () => {}

	let _currentPipelineLogRunId = null

	// Listen for pipeline logs and completion
	listen('pipeline-log-line', (event) => {
		// Show in workbench logs panel
		const logsContent = document.getElementById('logs-content')
		if (logsContent) {
			logsContent.textContent += event.payload + '\n'
			logsContent.scrollTop = logsContent.scrollHeight
		}
	})

	listen('pipeline-complete', async (event) => {
		const status = event.payload
		console.log('Pipeline completed with status:', status)

		// Append completion message to logs
		const logsContent = document.getElementById('logs-content')
		if (logsContent) {
			logsContent.textContent += `\n${status === 'success' ? '✅' : '❌'} Pipeline ${status}\n`
		}

		// Refresh runs list to show updated status
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
			const resultsDir = run.results_dir || run.work_dir

			// Parse run metadata if available (stored when run was created)
			const runMetadata = run.metadata ? JSON.parse(run.metadata) : {}
			const inputOverrides = runMetadata.input_overrides || {}
			const paramOverrides = runMetadata.parameter_overrides || {}

			// Show input values used
			const inputsHtml =
				Object.keys(inputOverrides).length > 0
					? `<div class="run-metadata-section">
						<h4>Input Values</h4>
						<div class="metadata-list">
							${Object.entries(inputOverrides)
								.map(
									([key, value]) => `
									<div class="metadata-item">
										<span class="metadata-key">${escapeHtml(key)}:</span>
										<span class="metadata-value">${escapeHtml(value)}</span>
									</div>
								`,
								)
								.join('')}
						</div>
					</div>`
					: ''

			// Show parameter overrides used
			const paramsHtml =
				Object.keys(paramOverrides).length > 0
					? `<div class="run-metadata-section">
						<h4>Parameter Overrides</h4>
						<div class="metadata-list">
							${Object.entries(paramOverrides)
								.map(
									([key, value]) => `
									<div class="metadata-item">
										<span class="metadata-key">${escapeHtml(key)}:</span>
										<span class="metadata-value">${escapeHtml(value)}</span>
									</div>
								`,
								)
								.join('')}
						</div>
					</div>`
					: ''

			container.innerHTML = `
				<div class="steps-container">
					<div class="run-results-header">
						<button class="view-results-btn" data-results-path="${resultsDir}">
							<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
								<path d="M3 7v10a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-6l-2-2H5a2 2 0 0 0-2 2z"></path>
							</svg>
							View All Results
						</button>
						<button class="rerun-btn" data-run-id="${run.id}" data-pipeline-id="${run.pipeline_id}">
							<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
								<polyline points="23 4 23 10 17 10"></polyline>
								<path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"></path>
							</svg>
							Re-run
						</button>
					</div>

					${inputsHtml}
					${paramsHtml}

					<h4 style="margin: 20px 0 12px 0; font-size: 15px; color: #374151;">Pipeline Steps</h4>
					${steps
						.map(
							(step, _index) => `
						<div class="step-row-enhanced">
							<div class="step-main">
								<div class="step-icon ${statusClass}">
									${run.status === 'success' ? '✓' : run.status === 'failed' ? '✗' : '⋯'}
								</div>
								<div class="step-content">
									<div class="step-title">${step.id}</div>
									<div class="step-path">${step.uses}</div>
								</div>
							</div>
							<div class="step-outputs">
								${
									step.publish && Object.keys(step.publish).length > 0
										? `<div class="outputs-section">
											<strong>📤 Published Outputs:</strong>
											${Object.entries(step.publish)
												.map(
													([name, spec]) => `
													<div class="output-item">
														<span class="output-name">${escapeHtml(name)}</span>
														<button class="view-output-btn" data-output-path="${resultsDir}/${step.id}/${
															spec.match(/\(([^)]+)\)/)?.[1] || name
														}">
															View
														</button>
													</div>
												`,
												)
												.join('')}
										</div>`
										: ''
								}
								${
									step.store && Object.keys(step.store).length > 0
										? `<div class="sql-section">
											<strong>💾 SQL Storage:</strong>
											${Object.entries(step.store)
												.map(([storeName, storeConfig]) => {
													const tableName = storeConfig.table_name || `${storeName}_{run_id}`
													const resolvedTableName = tableName.replace('{run_id}', run.id)
													return `
														<div class="sql-item">
															<span class="sql-table-name">z_results_${escapeHtml(resolvedTableName)}</span>
															<button class="query-sql-btn" data-table="z_results_${escapeHtml(resolvedTableName)}">
																Query
															</button>
														</div>
													`
												})
												.join('')}
										</div>`
										: ''
								}
							</div>
							<div class="step-actions">
								<button class="step-result-btn" data-step-path="${resultsDir}/${step.id}" title="View step results">
									View Results
								</button>
							</div>
						</div>
					`,
						)
						.join('')}
				</div>
			`

			// Attach event listeners after innerHTML is set
			const viewAllBtn = container.querySelector('.view-results-btn')
			if (viewAllBtn) {
				viewAllBtn.addEventListener('click', async () => {
					try {
						await invoke('open_folder', { path: viewAllBtn.dataset.resultsPath })
					} catch (e) {
						console.error('Error opening folder:', e)
					}
				})
			}

			// Re-run button
			const rerunBtn = container.querySelector('.rerun-btn')
			if (rerunBtn) {
				rerunBtn.addEventListener('click', async () => {
					try {
						const pipelineId = parseInt(rerunBtn.dataset.pipelineId)
						// Reuse the saved configuration by creating a run config from this run
						await invoke('save_run_config', {
							pipelineId,
							name: `Re-run of ${run.id}`,
							configData: {
								inputs: inputOverrides,
								parameters: paramOverrides,
							},
						})
						// Navigate to pipelines tab and trigger run
						if (navigateTo) {
							navigateTo('pipelines')
						}
						alert('Saved configuration from this run. Go to Pipelines tab to run it.')
					} catch (e) {
						console.error('Error preparing re-run:', e)
						alert('Error: ' + e)
					}
				})
			}

			// Step results buttons
			container.querySelectorAll('.step-result-btn').forEach((btn) => {
				btn.addEventListener('click', async () => {
					try {
						await invoke('open_folder', { path: btn.dataset.stepPath })
					} catch (e) {
						console.error('Error opening folder:', e)
					}
				})
			})

			// View output buttons
			container.querySelectorAll('.view-output-btn').forEach((btn) => {
				btn.addEventListener('click', async () => {
					try {
						await invoke('open_folder', { path: btn.dataset.outputPath })
					} catch (e) {
						console.error('Error opening output:', e)
						alert('Output file may not exist yet or path is invalid')
					}
				})
			})

			// Query SQL buttons
			container.querySelectorAll('.query-sql-btn').forEach((btn) => {
				btn.addEventListener('click', async () => {
					const tableName = btn.dataset.table
					// Navigate to SQL tab and run query
					if (navigateTo) {
						navigateTo('sql')
						// Set the query after a small delay to ensure tab is loaded
						setTimeout(() => {
							const sqlInput = document.getElementById('sql-query-input')
							if (sqlInput) {
								sqlInput.value = `SELECT * FROM ${tableName} LIMIT 100;`
								// Trigger the query
								const runQueryBtn = document.getElementById('run-query-btn')
								if (runQueryBtn) {
									runQueryBtn.click()
								}
							}
						}, 300)
					}
				})
			})
		} catch (error) {
			container.innerHTML = `<p class="error-message">Error loading steps: ${error}</p>`
		}
	}

	// Helper function for escaping HTML
	function escapeHtml(text) {
		const div = document.createElement('div')
		div.textContent = text
		return div.innerHTML
	}

	async function _showRunLogs(runId, projectName, workDir = null) {
		const logViewer = document.getElementById('log-viewer')
		const logContent = document.getElementById('log-content')
		const logRunName = document.getElementById('log-run-name')
		const shareBtn = document.getElementById('share-logs-btn')

		_currentLogRunId = runId
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

			_currentLogRunId = result.run_id
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
