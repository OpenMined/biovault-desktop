export function createRunsModule({ invoke, listen, dialog, refreshLogs = () => {} }) {
	let selectedParticipants = []
	let selectedProject = null
	let currentRunLogListeners = []
	let currentLogWorkDir = null
	let navigateTo = () => {}
	// Track runs that user has manually collapsed
	let manuallyCollapsedRunIds = new Set()

	async function confirmWithDialog(message, options = {}) {
		if (dialog?.confirm) {
			return await dialog.confirm(message, options)
		}
		return window.confirm(message)
	}

	// Listen for pipeline logs and completion
	listen('pipeline-log-line', () => {
		refreshLogs()
	})

	listen('pipeline-complete', async (event) => {
		const status = event.payload
		console.log('Pipeline completed with status:', status)

		refreshLogs({ force: true })

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
			// Check for auto-expand run ID
			let autoExpandRunId = null
			if (typeof sessionStorage !== 'undefined') {
				const storedRunId = sessionStorage.getItem('autoExpandRunId')
				if (storedRunId) {
					autoExpandRunId = parseInt(storedRunId, 10)
					sessionStorage.removeItem('autoExpandRunId') // Clear after reading
				}
			}

			// Load only pipeline runs (steps are now called projects)
			const pipelineRuns = await invoke('get_pipeline_runs')
			const pipelines = await invoke('get_pipelines') // Get pipeline names

			const container = document.getElementById('runs-list')

			if (pipelineRuns.length === 0) {
				container.innerHTML = `
					<div style="display: flex; flex-direction: column; align-items: center; justify-content: center; padding: 80px 32px; text-align: center;">
						<svg width="64" height="64" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" style="color: #cbd5e1; margin-bottom: 20px;">
							<polyline points="9 18 15 12 9 6"></polyline>
						</svg>
						<h3 style="margin: 0 0 8px 0; font-size: 18px; font-weight: 600; color: #475569;">No pipeline runs yet</h3>
						<p style="margin: 0; font-size: 14px; color: #94a3b8; line-height: 1.5;">Run a pipeline to see results here</p>
					</div>
				`
				return
			}

			container.innerHTML = ''

			// Display pipeline runs (sorted by most recent first)
			// The first run (latest) should be expanded by default unless user collapsed it
			pipelineRuns.forEach((run, index) => {
				// Find pipeline name
				const pipeline = pipelines.find((p) => p.id === run.pipeline_id)
				const pipelineName = pipeline ? pipeline.name : `Pipeline #${run.pipeline_id}`
				const card = document.createElement('div')
				card.className = 'pipeline-run-card'
				card.dataset.runId = run.id
				card.style.cssText =
					'background: #ffffff; border: 1.5px solid #e2e8f0; border-radius: 12px; margin-bottom: 16px; overflow: hidden; transition: all 0.3s cubic-bezier(0.16, 1, 0.3, 1); box-shadow: 0 1px 3px rgba(0, 0, 0, 0.06);'

				// Add hover effect and update expanded state styling
				const updateCardExpandedStyle = (isExpanded) => {
					if (isExpanded) {
						card.style.boxShadow = '0 4px 16px rgba(0, 0, 0, 0.12)'
						card.style.borderColor = '#cbd5e1'
					} else {
						card.style.boxShadow = '0 1px 3px rgba(0, 0, 0, 0.06)'
						card.style.borderColor = '#e2e8f0'
					}
				}

				card.addEventListener('mouseenter', () => {
					if (card.dataset.expanded !== 'true') {
						card.style.boxShadow = '0 4px 12px rgba(0, 0, 0, 0.1)'
						card.style.borderColor = '#cbd5e1'
						card.style.transform = 'translateY(-1px)'
					}
				})
				card.addEventListener('mouseleave', () => {
					if (card.dataset.expanded !== 'true') {
						card.style.boxShadow = '0 1px 3px rgba(0, 0, 0, 0.06)'
						card.style.borderColor = '#e2e8f0'
						card.style.transform = 'translateY(0)'
					}
				})

				// Check if this run should be auto-expanded
				// Expand if: newly created OR currently running OR it's the latest run (first in list)
				// But don't expand if user has manually collapsed it
				const isLatestRun = index === 0
				const shouldAutoExpand =
					(autoExpandRunId === run.id || run.status === 'running' || isLatestRun) &&
					!manuallyCollapsedRunIds.has(run.id)
				card.dataset.expanded = shouldAutoExpand ? 'true' : 'false'

				// Update style when expanded state changes
				updateCardExpandedStyle(shouldAutoExpand)

				let statusBadge, statusClass, statusIcon, statusColor, statusBg, statusBadgeStyle
				if (run.status === 'success') {
					statusClass = 'success'
					statusIcon = '✓'
					statusColor = '#059669'
					statusBg = 'linear-gradient(135deg, #d1fae5 0%, #a7f3d0 100%)'
					statusBadgeStyle =
						'background: linear-gradient(135deg, #d1fae5 0%, #a7f3d0 100%); color: #047857; border: 1px solid rgba(5, 150, 105, 0.2);'
					statusBadge = `<span class="status-badge status-success" style="padding: 6px 14px; border-radius: 8px; font-size: 12px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.05em; white-space: nowrap; ${statusBadgeStyle}">✓ Success</span>`
				} else if (run.status === 'failed') {
					statusClass = 'failed'
					statusIcon = '✗'
					statusColor = '#dc2626'
					statusBg = 'linear-gradient(135deg, #fee2e2 0%, #fecaca 100%)'
					statusBadgeStyle =
						'background: linear-gradient(135deg, #fee2e2 0%, #fecaca 100%); color: #b91c1c; border: 1px solid rgba(220, 38, 38, 0.2);'
					statusBadge = `<span class="status-badge status-failed" style="padding: 6px 14px; border-radius: 8px; font-size: 12px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.05em; white-space: nowrap; ${statusBadgeStyle}">✗ Failed</span>`
				} else {
					statusClass = 'running'
					statusIcon = '⋯'
					statusColor = '#2563eb'
					statusBg = 'linear-gradient(135deg, #dbeafe 0%, #bfdbfe 100%)'
					statusBadgeStyle =
						'background: linear-gradient(135deg, #dbeafe 0%, #bfdbfe 100%); color: #1d4ed8; border: 1px solid rgba(37, 99, 235, 0.2);'
					statusBadge = `<span class="status-badge status-running" style="padding: 6px 14px; border-radius: 8px; font-size: 12px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.05em; white-space: nowrap; ${statusBadgeStyle}">⋯ Running</span>`
				}

				const timeAgo = getTimeAgo(new Date(run.created_at))
				const isNewlyCreated = autoExpandRunId === run.id

				card.innerHTML = `
				<div class="run-header" data-run-id="${
					run.id
				}" style="display: flex; align-items: center; gap: 14px; padding: 18px 20px; cursor: pointer; transition: all 0.2s cubic-bezier(0.16, 1, 0.3, 1); background: ${
					isNewlyCreated ? 'linear-gradient(135deg, #eff6ff 0%, #dbeafe 100%)' : '#ffffff'
				}; border-bottom: ${isNewlyCreated ? '2px' : '1px'} solid ${
					isNewlyCreated ? 'rgba(37,99,235,0.2)' : '#f1f5f9'
				};" onmouseover="if(this.closest('.pipeline-run-card').dataset.expanded !== 'true') { this.style.background='#f8fafc' }" onmouseout="if(this.closest('.pipeline-run-card').dataset.expanded !== 'true') { this.style.background='${
					isNewlyCreated ? 'linear-gradient(135deg, #eff6ff 0%, #dbeafe 100%)' : '#ffffff'
				}' }">
					<svg class="run-chevron" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" style="color: #64748b; transition: transform 0.3s cubic-bezier(0.16, 1, 0.3, 1); flex-shrink: 0;">
						<polyline points="9 18 15 12 9 6"></polyline>
					</svg>
					<div class="run-status-icon ${statusClass}" style="width: 36px; height: 36px; border-radius: 10px; display: flex; align-items: center; justify-content: center; font-size: 16px; font-weight: 700; flex-shrink: 0; background: ${statusBg}; color: ${statusColor}; border: 2px solid ${statusColor}20; box-shadow: 0 2px 8px ${statusColor}15;">
						${statusIcon}
					</div>
					<div class="run-main-info" style="flex: 1; min-width: 0;">
						<div class="run-title" style="font-size: 16px; font-weight: 700; color: #0f172a; margin-bottom: 4px; line-height: 1.3; letter-spacing: -0.01em;">${escapeHtml(
							pipelineName,
						)}</div>
						<div class="run-subtitle" style="font-size: 13px; color: #64748b; display: flex; align-items: center; gap: 8px;">
							<span>Run #${run.id}</span>
							<span style="color: #cbd5e1;">•</span>
							<span>${timeAgo}</span>
							${
								run.participant_count
									? `<span style="color: #cbd5e1;">•</span><span>${
											run.participant_count
										} participant${run.participant_count === 1 ? '' : 's'}</span>`
									: ''
							}
						</div>
					</div>
					${statusBadge}
					<div style="display: flex; align-items: center; gap: 6px; flex-shrink: 0;">
						<button class="run-view-folder-btn" data-results-path="${
							run.results_dir || run.work_dir || ''
						}" title="View results folder" style="width: 32px; height: 32px; display: flex; align-items: center; justify-content: center; background: transparent; border: none; color: #64748b; cursor: pointer; border-radius: 6px; transition: all 0.2s;" onmouseover="this.style.background='#f1f5f9'; this.style.color='#2563eb'" onmouseout="this.style.background='transparent'; this.style.color='#64748b'">
							<img src="assets/icons/folder.svg" width="18" height="18" style="filter: invert(50%) sepia(6%) saturate(340%) hue-rotate(183deg) brightness(90%) contrast(91%);" onmouseover="this.style.filter='invert(32%) sepia(94%) saturate(1352%) hue-rotate(212deg) brightness(99%) contrast(96%)'" onmouseout="this.style.filter='invert(50%) sepia(6%) saturate(340%) hue-rotate(183deg) brightness(90%) contrast(91%)'" />
						</button>
						<button class="run-delete-btn" data-run-id="${
							run.id
						}" title="Delete run" style="width: 32px; height: 32px; display: flex; align-items: center; justify-content: center; background: transparent; border: none; color: #94a3b8; cursor: pointer; border-radius: 6px; transition: all 0.2s;" onmouseover="this.style.background='#fef2f2'; this.style.color='#dc2626'; this.querySelector('img').style.filter='invert(28%) sepia(93%) saturate(3338%) hue-rotate(340deg) brightness(95%) contrast(92%)'" onmouseout="this.style.background='transparent'; this.style.color='#94a3b8'; this.querySelector('img').style.filter='invert(65%) sepia(6%) saturate(307%) hue-rotate(183deg) brightness(93%) contrast(86%)'">
							<img src="assets/icons/trash.svg" width="18" height="18" style="filter: invert(65%) sepia(6%) saturate(307%) hue-rotate(183deg) brightness(93%) contrast(86%);" />
						</button>
					</div>
				</div>
				<div class="run-details" style="display: ${
					shouldAutoExpand ? 'block' : 'none'
				}; background: linear-gradient(180deg, #fafbfc 0%, #ffffff 100%); border-top: 1px solid #e2e8f0;">
					<div class="loading-steps" style="padding: 40px 20px; text-align: center; color: #64748b; font-size: 14px;">Loading steps...</div>
				</div>
			`

				// Handle expand/collapse
				const header = card.querySelector('.run-header')
				const chevron = card.querySelector('.run-chevron')

				const updateExpandedState = (isExpanded) => {
					card.dataset.expanded = isExpanded ? 'true' : 'false'
					if (chevron) {
						chevron.style.transform = isExpanded ? 'rotate(90deg)' : 'rotate(0deg)'
					}
					// Update card styling based on expanded state
					if (isExpanded) {
						card.style.boxShadow = '0 4px 16px rgba(0, 0, 0, 0.12)'
						card.style.borderColor = '#cbd5e1'
					} else {
						card.style.boxShadow = '0 1px 3px rgba(0, 0, 0, 0.06)'
						card.style.borderColor = '#e2e8f0'
					}
				}

				// Auto-expand if this is newly created OR currently running
				if (shouldAutoExpand) {
					const detailsContainer = card.querySelector('.run-details')
					updateExpandedState(true)
					// Load steps immediately for auto-expanded run
					loadPipelineRunSteps(run, pipeline, detailsContainer, statusClass).catch(console.error)
					// Scroll to this card after a brief delay (only for newly created, not all running)
					if (isNewlyCreated) {
						setTimeout(() => {
							card.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
						}, 100)
					}
				} else {
					updateExpandedState(false)
				}

				header.addEventListener('click', async (e) => {
					// Don't expand if clicking action buttons
					if (e.target.closest('.run-delete-btn') || e.target.closest('.run-view-folder-btn')) {
						return
					}

					const isExpanded = card.dataset.expanded === 'true'
					const newExpandedState = !isExpanded

					// Track user's manual collapse/expand actions
					if (newExpandedState) {
						manuallyCollapsedRunIds.delete(run.id)
					} else {
						manuallyCollapsedRunIds.add(run.id)
					}

					updateExpandedState(newExpandedState)

					const detailsContainer = card.querySelector('.run-details')
					if (newExpandedState) {
						detailsContainer.style.display = 'block'
						await loadPipelineRunSteps(run, pipeline, detailsContainer, statusClass)
					} else {
						detailsContainer.style.display = 'none'
					}
				})

				// Handle view folder button
				const viewFolderBtn = card.querySelector('.run-view-folder-btn')
				if (viewFolderBtn) {
					viewFolderBtn.addEventListener('click', async (e) => {
						e.stopPropagation()
						const resultsPath = viewFolderBtn.dataset.resultsPath
						if (resultsPath) {
							try {
								await invoke('open_folder', { path: resultsPath })
							} catch (error) {
								alert(`Error opening folder: ${error}`)
							}
						}
					})
				}

				// Handle delete
				const deleteBtn = card.querySelector('.run-delete-btn')
				if (deleteBtn) {
					deleteBtn.addEventListener('click', async (e) => {
						e.stopPropagation()
						const confirmed = await confirmWithDialog(
							`Delete pipeline run "${pipelineName}" (Run #${run.id}) and all its results? This action cannot be undone.`,
							{ title: 'Delete Run', type: 'warning' },
						)
						if (confirmed) {
							try {
								await invoke('delete_pipeline_run', { runId: run.id })
								await loadRuns()
							} catch (error) {
								alert(`Error deleting run: ${error}`)
							}
						}
					})
				}

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

			// Determine status colors and backgrounds based on run status
			let statusBg, statusColor
			if (run.status === 'success') {
				statusBg = 'linear-gradient(135deg, #d1fae5 0%, #a7f3d0 100%)'
				statusColor = '#059669'
			} else if (run.status === 'failed') {
				statusBg = 'linear-gradient(135deg, #fee2e2 0%, #fecaca 100%)'
				statusColor = '#dc2626'
			} else {
				statusBg = 'linear-gradient(135deg, #dbeafe 0%, #bfdbfe 100%)'
				statusColor = '#2563eb'
			}

			// Parse run metadata if available (stored when run was created)
			const runMetadata = run.metadata ? JSON.parse(run.metadata) : {}
			const inputOverrides = runMetadata.input_overrides || {}
			const paramOverrides = runMetadata.parameter_overrides || {}

			// Collect all published outputs from all steps - make them prominent
			// Only show published outputs if the run has completed successfully
			const allPublishedOutputs = []
			if (run.status === 'success') {
				steps.forEach((step) => {
					if (step.publish && Object.keys(step.publish).length > 0) {
						Object.entries(step.publish).forEach(([name, spec]) => {
							const fileName = spec.match(/\(([^)]+)\)/)?.[1] || name
							const outputPath = `${resultsDir}/${step.id}/${fileName}`
							// Extract file extension
							const extension = fileName.includes('.')
								? fileName.substring(fileName.lastIndexOf('.'))
								: ''
							allPublishedOutputs.push({
								name,
								fileName,
								extension,
								path: outputPath,
								stepId: step.id,
							})
						})
					}
				})
			}

			// Collapsible inputs section (collapsed by default)
			const hasInputsOrParams =
				Object.keys(inputOverrides).length > 0 || Object.keys(paramOverrides).length > 0
			const inputsHtml = hasInputsOrParams
				? `<div class="run-config-section" style="margin-bottom: 24px;">
					<button class="run-config-toggle" onclick="this.nextElementSibling.style.display = this.nextElementSibling.style.display === 'none' ? 'block' : 'none'; this.querySelector('svg').style.transform = this.nextElementSibling.style.display === 'none' ? 'rotate(0deg)' : 'rotate(90deg)';" style="width: 100%; display: flex; align-items: center; gap: 10px; padding: 14px 16px; background: #f8fafc; border: 1.5px solid #e2e8f0; border-radius: 10px; cursor: pointer; transition: all 0.2s; text-align: left; font-size: 14px; font-weight: 600; color: #475569;" onmouseover="this.style.background='#f1f5f9'; this.style.borderColor='#cbd5e1'" onmouseout="this.style.background='#f8fafc'; this.style.borderColor='#e2e8f0'">
						<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" style="transition: transform 0.3s; color: #64748b; transform: rotate(0deg);">
							<polyline points="9 18 15 12 9 6"></polyline>
						</svg>
						<span>Configuration</span>
						<span style="margin-left: auto; font-size: 12px; color: #94a3b8;">${
							Object.keys(inputOverrides).length + Object.keys(paramOverrides).length
						} setting${
							Object.keys(inputOverrides).length + Object.keys(paramOverrides).length === 1
								? ''
								: 's'
						}</span>
					</button>
					<div class="run-config-content" style="display: none; padding: 16px; background: white; border: 1.5px solid #e2e8f0; border-top: none; border-radius: 0 0 10px 10px;">
						${
							Object.keys(inputOverrides).length > 0
								? `<div style="margin-bottom: ${
										Object.keys(paramOverrides).length > 0 ? '16px' : '0'
									};">
								<div style="font-size: 12px; font-weight: 700; color: #475569; margin-bottom: 10px; text-transform: uppercase; letter-spacing: 0.05em;">Input Values</div>
								<div style="display: flex; flex-direction: column; gap: 8px;">
									${Object.entries(inputOverrides)
										.map(
											([key, value]) => `
											<div style="display: flex; gap: 12px; padding: 10px 12px; background: #f8fafc; border-radius: 6px; border: 1px solid #e2e8f0;">
												<span style="font-size: 12px; color: #64748b; font-family: 'SF Mono', Monaco, monospace; font-weight: 600; flex-shrink: 0; min-width: 160px;">${escapeHtml(
													key,
												)}</span>
												<span style="color: #cbd5e1;">:</span>
												<span style="font-size: 12px; color: #475569; font-family: 'SF Mono', Monaco, monospace; word-break: break-all;">${escapeHtml(
													value,
												)}</span>
											</div>
										`,
										)
										.join('')}
								</div>
							</div>`
								: ''
						}
						${
							Object.keys(paramOverrides).length > 0
								? `<div>
								<div style="font-size: 12px; font-weight: 700; color: #475569; margin-bottom: 10px; text-transform: uppercase; letter-spacing: 0.05em;">Parameter Overrides</div>
								<div style="display: flex; flex-direction: column; gap: 8px;">
									${Object.entries(paramOverrides)
										.map(
											([key, value]) => `
											<div style="display: flex; gap: 12px; padding: 10px 12px; background: #f8fafc; border-radius: 6px; border: 1px solid #e2e8f0;">
												<span style="font-size: 12px; color: #64748b; font-family: 'SF Mono', Monaco, monospace; font-weight: 600; flex-shrink: 0; min-width: 160px;">${escapeHtml(
													key,
												)}</span>
												<span style="color: #cbd5e1;">:</span>
												<span style="font-size: 12px; color: #475569; font-family: 'SF Mono', Monaco, monospace; word-break: break-all;">${escapeHtml(
													value,
												)}</span>
											</div>
										`,
										)
										.join('')}
								</div>
							</div>`
								: ''
						}
					</div>
				</div>`
				: ''

			container.innerHTML = `
				<div class="steps-container" style="padding: 24px 28px;">
					${
						allPublishedOutputs.length > 0
							? `<div style="margin-bottom: 28px;">
							<div style="display: flex; align-items: center; gap: 10px; margin-bottom: 16px;">
								<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" style="color: #059669;">
									<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>
									<polyline points="17 8 12 3 7 8"></polyline>
									<line x1="12" y1="3" x2="12" y2="15"></line>
								</svg>
								<h3 style="margin: 0; font-size: 18px; font-weight: 700; color: #0f172a; letter-spacing: -0.01em;">Published Outputs</h3>
								<span style="padding: 4px 10px; background: #d1fae5; color: #047857; border-radius: 6px; font-size: 12px; font-weight: 700; margin-left: auto;">${
									allPublishedOutputs.length
								} file${allPublishedOutputs.length === 1 ? '' : 's'}</span>
							</div>
							<div style="display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: 12px;">
								${allPublishedOutputs
									.map(
										(output) => `
									<button class="published-output-card" data-output-path="${
										output.path
									}" style="padding: 18px 20px; background: linear-gradient(135deg, #f0fdf4 0%, #dcfce7 100%); border: 2.5px solid #10b981; border-radius: 12px; cursor: pointer; transition: all 0.2s; text-align: left; display: flex; flex-direction: column; gap: 10px; box-shadow: 0 4px 12px rgba(16,185,129,0.2); position: relative;" onmouseover="this.style.transform='translateY(-2px)'; this.style.boxShadow='0 6px 20px rgba(16,185,129,0.35)'; this.style.borderColor='#059669'" onmouseout="this.style.transform='translateY(0)'; this.style.boxShadow='0 4px 12px rgba(16,185,129,0.2)'; this.style.borderColor='#10b981'">
										<div style="display: flex; align-items: center; gap: 12px;">
											<div style="width: 40px; height: 40px; border-radius: 10px; background: linear-gradient(135deg, #10b981 0%, #059669 100%); display: flex; align-items: center; justify-content: center; flex-shrink: 0; box-shadow: 0 2px 8px rgba(16,185,129,0.3); overflow: hidden;">
												<img src="assets/icons/upload.svg" width="22" height="22" style="filter: brightness(0) invert(1);" />
											</div>
											<div style="flex: 1; min-width: 0;">
												<span style="font-size: 15px; font-weight: 700; color: #065f46; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; line-height: 1.3; display: block;">${escapeHtml(
													output.fileName,
												)}</span>
												<div style="font-size: 11px; color: #047857; font-family: 'SF Mono', Monaco, monospace; margin-top: 4px; opacity: 0.8;">${escapeHtml(
													output.stepId,
												)}</div>
											</div>
											<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" style="color: #059669; flex-shrink: 0; opacity: 0.7;">
												<polyline points="9 18 15 12 9 6"></polyline>
											</svg>
										</div>
									</button>
								`,
									)
									.join('')}
							</div>
						</div>`
							: ''
					}

					${inputsHtml}

					<div class="run-steps-section" style="margin-top: 28px;">
						<button class="run-steps-toggle" onclick="this.nextElementSibling.style.display = this.nextElementSibling.style.display === 'none' ? 'block' : 'none'; this.querySelector('svg').style.transform = this.nextElementSibling.style.display === 'none' ? 'rotate(0deg)' : 'rotate(90deg)';" style="width: 100%; display: flex; align-items: center; gap: 10px; padding: 14px 16px; background: #f8fafc; border: 1.5px solid #e2e8f0; border-radius: 10px; cursor: pointer; transition: all 0.2s; text-align: left; font-size: 14px; font-weight: 600; color: #475569;" onmouseover="this.style.background='#f1f5f9'; this.style.borderColor='#cbd5e1'" onmouseout="this.style.background='#f8fafc'; this.style.borderColor='#e2e8f0'">
							<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" style="transition: transform 0.3s; color: #64748b; transform: rotate(0deg);">
								<polyline points="9 18 15 12 9 6"></polyline>
							</svg>
							<span>Pipeline Steps</span>
							<span style="margin-left: auto; padding: 4px 10px; background: #e2e8f0; color: #64748b; border-radius: 6px; font-size: 12px; font-weight: 600;">${
								steps.length
							} step${steps.length === 1 ? '' : 's'}</span>
						</button>
						<div class="run-steps-content" style="display: none; padding: 16px; background: white; border: 1.5px solid #e2e8f0; border-top: none; border-radius: 0 0 10px 10px;">
					<div style="display: flex; flex-direction: column; gap: 12px;">
						${steps
							.map(
								(step) => `
							<div class="step-row-enhanced" style="background: white; border: 1.5px solid #e2e8f0; border-radius: 10px; padding: 18px 20px; transition: all 0.2s;" onmouseover="this.style.borderColor='#cbd5e1'; this.style.boxShadow='0 2px 8px rgba(0, 0, 0, 0.06)'" onmouseout="this.style.borderColor='#e2e8f0'; this.style.boxShadow='none'">
								<div class="step-main" style="display: flex; align-items: center; gap: 14px; margin-bottom: 16px;">
									<div class="step-icon ${statusClass}" style="width: 32px; height: 32px; border-radius: 8px; display: flex; align-items: center; justify-content: center; font-size: 14px; font-weight: 700; flex-shrink: 0; background: ${statusBg}; color: ${statusColor}; border: 1.5px solid ${statusColor}20;">
										${run.status === 'success' ? '✓' : run.status === 'failed' ? '✗' : '⋯'}
									</div>
									<div class="step-content" style="flex: 1; min-width: 0;">
										<div class="step-title" style="font-size: 15px; font-weight: 700; color: #0f172a; margin-bottom: 6px; letter-spacing: -0.01em;">${escapeHtml(
											step.id,
										)}</div>
										<div class="step-path" style="font-size: 12px; color: #64748b; font-family: 'SF Mono', Monaco, monospace; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${escapeHtml(
											step.uses,
										)}</div>
									</div>
									<div class="step-actions" style="flex-shrink: 0;">
										<button class="step-result-btn" data-step-path="${resultsDir}/${
											step.id
										}" title="View step results" style="padding: 8px 16px; background: linear-gradient(135deg, #10b981 0%, #059669 100%); color: white; border: none; border-radius: 8px; font-size: 13px; font-weight: 600; cursor: pointer; transition: all 0.2s; box-shadow: 0 2px 6px rgba(16,185,129,0.3);" onmouseover="this.style.transform='translateY(-1px)'; this.style.boxShadow='0 4px 10px rgba(16,185,129,0.4)'" onmouseout="this.style.transform='translateY(0)'; this.style.boxShadow='0 2px 6px rgba(16,185,129,0.3)'">
											View Results
										</button>
									</div>
								</div>
								${
									(step.publish && Object.keys(step.publish).length > 0) ||
									(step.store && Object.keys(step.store).length > 0)
										? `
								<div class="step-outputs" style="display: flex; flex-direction: column; gap: 12px; padding-left: 46px;">
									${
										step.store && Object.keys(step.store).length > 0
											? `<div class="sql-section" style="padding: 14px 16px; background: linear-gradient(135deg, #eff6ff 0%, #dbeafe 100%); border: 1.5px solid #bfdbfe; border-radius: 8px;">
												<div style="font-size: 13px; font-weight: 700; color: #1e40af; margin-bottom: 10px; display: flex; align-items: center; gap: 8px;">
													<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" style="color: #2563eb;">
														<rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect>
														<line x1="3" y1="9" x2="21" y2="9"></line>
														<line x1="9" y1="21" x2="9" y2="9"></line>
													</svg>
													SQL Storage
												</div>
												<div style="display: flex; flex-direction: column; gap: 8px;">
													${Object.entries(step.store)
														.map(([storeName, storeConfig]) => {
															const tableName = storeConfig.table_name || `${storeName}_{run_id}`
															const resolvedTableName = tableName.replace('{run_id}', run.id)
															return `
																<div class="sql-item" style="display: flex; align-items: center; justify-content: space-between; padding: 10px 12px; background: white; border-radius: 6px; border: 1px solid #bfdbfe;">
																	<span class="sql-table-name" style="font-size: 13px; color: #1e40af; font-family: 'SF Mono', Monaco, monospace; font-weight: 600;">z_results_${escapeHtml(
																		resolvedTableName,
																	)}</span>
																	<button class="query-sql-btn" data-table="z_results_${escapeHtml(
																		resolvedTableName,
																	)}" style="padding: 6px 14px; background: #2563eb; color: white; border: none; border-radius: 6px; font-size: 12px; font-weight: 600; cursor: pointer; transition: all 0.2s;" onmouseover="this.style.background='#1d4ed8'" onmouseout="this.style.background='#2563eb'">
																		Query
																	</button>
																</div>
															`
														})
														.join('')}
												</div>
											</div>`
											: ''
									}
								</div>
								`
										: ''
								}
							</div>
						`,
							)
							.join('')}
					</div>
						</div>
					</div>
				</div>
			`

			// Attach event listeners for published outputs
			const publishedOutputCards = container.querySelectorAll('.published-output-card')
			publishedOutputCards.forEach((card) => {
				card.addEventListener('click', async () => {
					try {
						const outputPath = card.dataset.outputPath
						await invoke('open_folder', { path: outputPath })
					} catch (e) {
						console.error('Error opening output:', e)
						alert(`Error opening output: ${e}`)
					}
				})
			})

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
