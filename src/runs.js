export function createRunsModule({ invoke, listen, dialog, refreshLogs = () => {} }) {
	let selectedParticipants = []
	let selectedModule = null
	let currentRunLogListeners = []
	let currentLogWorkDir = null
	let navigateTo = () => {}
	// Track runs that user has manually collapsed
	let manuallyCollapsedRunIds = new Set()
	const flowLogIntervals = new Map()
	const flowLogCache = new Map()
	const flowStepStatusAt = new Map()
	const flowProgressCache = new Map()
	const flowProgressTiming = new Map()

	function parseConcurrencyInput(value) {
		if (value === null || value === undefined) return null
		const trimmed = String(value).trim()
		if (!trimmed) return null
		const parsed = parseInt(trimmed, 10)
		if (!Number.isFinite(parsed) || parsed <= 0) return null
		return parsed
	}

	function stripAnsi(text) {
		if (!text) return ''
		const ansiEsc = String.fromCharCode(27)
		const ansiPattern = new RegExp(`${ansiEsc}\\[[0-9;]*[a-zA-Z]`, 'g')
		return text.replace(ansiPattern, '')
	}

	function parseNextflowProgress(logText) {
		if (!logText) return null
		const lines = stripAnsi(logText).split('\n')
		let progressMatch = null
		for (let i = lines.length - 1; i >= 0; i -= 1) {
			const line = lines[i]
			const match = line.match(/\|\s*(\d+)\s+of\s+(\d+)/)
			if (match) {
				progressMatch = { completed: parseInt(match[1], 10), total: parseInt(match[2], 10) }
				break
			}
		}
		if (progressMatch && Number.isFinite(progressMatch.total) && progressMatch.total > 0) {
			return progressMatch
		}

		let submitted = 0
		let completed = 0
		lines.forEach((line) => {
			if (line.includes('Submitted process >')) submitted += 1
			if (line.includes('Cached process >') || line.includes('Completed process >')) completed += 1
		})
		if (submitted > 0) {
			return { completed: Math.min(completed, submitted), total: submitted }
		}
		return null
	}

	function filterNextflowTaskLogs(logText) {
		if (!logText) return ''
		const lines = stripAnsi(logText).split('\n')
		const filtered = lines.filter((line) => {
			if (!line) return false
			if (line.includes('[Task')) return true
			if (line.includes('executor >')) return true
			if (line.match(/\|\s*\d+\s+of\s+\d+/)) return true
			return false
		})
		return filtered.join('\n')
	}

	function updateFlowProgressUI(progress, progressEl, runId) {
		if (!progressEl) return
		const elements = Array.isArray(progressEl)
			? progressEl
			: progressEl instanceof NodeList
				? Array.from(progressEl)
				: [progressEl]
		elements.forEach((el) => {
			if (!el) return
			const label = el.querySelector('.flow-progress-label')
			const fill = el.querySelector('.flow-progress-fill')
			const count = el.querySelector('.flow-progress-count')
			const eta = el.querySelector('.flow-progress-eta')
			if (!label || !fill || !count) return
			if (!progress || !progress.total) {
				label.textContent = 'Progress unavailable'
				fill.style.width = '0%'
				count.textContent = '--'
				if (eta) eta.textContent = ''
				return
			}
			const pct = Math.max(
				0,
				Math.min(100, Math.round((progress.completed / progress.total) * 100)),
			)
			label.textContent = 'Nextflow progress'
			fill.style.width = `${pct}%`
			count.textContent = `${progress.completed}/${progress.total}`
			if (eta) {
				const key = runId || el.dataset.runId || 'unknown'
				const now = Date.now()
				const timing = flowProgressTiming.get(key) || {
					firstMs: now,
					lastMs: now,
					lastCompleted: 0,
				}
				if (progress.completed > timing.lastCompleted) {
					if (timing.lastCompleted === 0) {
						timing.firstMs = now
					}
					timing.lastMs = now
					timing.lastCompleted = progress.completed
					flowProgressTiming.set(key, timing)
				}
				if (progress.total === progress.completed) {
					eta.textContent = 'ETA ~ done'
				} else if (timing.lastCompleted > 0) {
					const elapsedMs = Math.max(0, timing.lastMs - timing.firstMs)
					if (elapsedMs > 0 && progress.total > progress.completed) {
						const avgPerUnit = elapsedMs / timing.lastCompleted
						const remainingMs = Math.max(
							0,
							Math.round(avgPerUnit * (progress.total - progress.completed)),
						)
						const cappedMs = Math.min(remainingMs, 24 * 60 * 60 * 1000)
						eta.textContent = `ETA ~ ${formatDuration(cappedMs)}`
					} else {
						eta.textContent = ''
					}
				} else {
					eta.textContent = ''
				}
			}
			el.style.display = 'flex'
		})
	}

	function formatDuration(ms) {
		if (!Number.isFinite(ms) || ms <= 0) return '—'
		const totalSeconds = Math.round(ms / 1000)
		const minutes = Math.floor(totalSeconds / 60)
		const seconds = totalSeconds % 60
		if (minutes > 0) {
			return `${minutes}m ${seconds}s`
		}
		return `${seconds}s`
	}

	function updateStepRowStatus(stepRow, status) {
		if (!stepRow) return
		const icon = stepRow.querySelector('.step-status-indicator')
		const badge = stepRow.querySelector('.step-status-badge')
		if (!icon || !badge) return
		stepRow.dataset.stepStatus = status
		if (status === 'done') {
			icon.textContent = '✓'
			icon.style.background = 'linear-gradient(135deg, #d1fae5 0%, #a7f3d0 100%)'
			icon.style.color = '#047857'
			icon.style.borderColor = 'rgba(5, 150, 105, 0.25)'
			badge.textContent = 'Done'
			badge.style.background = '#d1fae5'
			badge.style.color = '#047857'
			return
		}
		if (status === 'failed') {
			icon.textContent = '✗'
			icon.style.background = 'linear-gradient(135deg, #fee2e2 0%, #fecaca 100%)'
			icon.style.color = '#b91c1c'
			icon.style.borderColor = 'rgba(220, 38, 38, 0.25)'
			badge.textContent = 'Failed'
			badge.style.background = '#fee2e2'
			badge.style.color = '#b91c1c'
			return
		}
		icon.textContent = '⋯'
		icon.style.background = '#f8fafc'
		icon.style.color = '#64748b'
		icon.style.borderColor = 'rgba(148, 163, 184, 0.4)'
		badge.textContent = 'Pending'
		badge.style.background = '#f1f5f9'
		badge.style.color = '#64748b'
	}

	function updateStepsProgressBadge(runId, doneCount, totalCount) {
		const badge = document.querySelector(`.steps-progress-badge[data-run-id="${runId}"]`)
		if (!badge) return
		if (!totalCount) {
			badge.textContent = 'No steps'
			return
		}
		badge.textContent = `${doneCount}/${totalCount} done`
	}

	async function refreshFlowStepStatus(run, stepRows) {
		if (!run || !stepRows || stepRows.length === 0) return
		const runId = run.id
		const lastCheck = flowStepStatusAt.get(runId) || 0
		const now = Date.now()
		if (run.status === 'running' && now - lastCheck < 6000) return
		flowStepStatusAt.set(runId, now)

		if (run.status === 'success') {
			stepRows.forEach((row) => updateStepRowStatus(row, 'done'))
			updateStepsProgressBadge(runId, stepRows.length, stepRows.length)
			return
		}

		const rows = Array.isArray(stepRows)
			? stepRows
			: stepRows instanceof NodeList
				? Array.from(stepRows)
				: []
		const statuses = await Promise.all(
			rows.map((row) => invoke('path_exists', { path: row.dataset.stepPath })),
		)
		let doneCount = 0
		rows.forEach((row, idx) => {
			const exists = Boolean(statuses[idx])
			const status = exists ? 'done' : run.status === 'failed' ? 'failed' : 'pending'
			if (exists) doneCount += 1
			updateStepRowStatus(row, status)
		})
		updateStepsProgressBadge(runId, doneCount, rows.length)
	}

	async function refreshFlowRunLogs(run, logEl, progressEl, stepRows) {
		if (!logEl || !run) return
		try {
			const logs = await invoke('get_flow_run_logs_tail', { runId: run.id, lines: 800 })
			const filteredLogs = filterNextflowTaskLogs(logs)
			const cacheKey = flowLogCache.get(run.id)
			if (cacheKey !== filteredLogs) {
				flowLogCache.set(run.id, filteredLogs)
				const wasAtBottom = logEl.scrollHeight - logEl.scrollTop - logEl.clientHeight < 24
				if (filteredLogs) {
					logEl.textContent = filteredLogs
					if (wasAtBottom) {
						logEl.scrollTop = logEl.scrollHeight
					}
				} else if (!logEl.textContent || logEl.textContent === 'Loading logs...') {
					logEl.textContent = 'Waiting for task logs...'
				}
				let progress = parseNextflowProgress(logs)
				const cached = flowProgressCache.get(run.id)
				if (progress && progress.total) {
					if (cached && cached.total) {
						if (progress.total < cached.total) {
							progress = {
								total: cached.total,
								completed: Math.max(cached.completed || 0, progress.completed || 0),
							}
						} else if (progress.total === cached.total) {
							progress = {
								total: progress.total,
								completed: Math.max(cached.completed || 0, progress.completed || 0),
							}
						}
					}
					flowProgressCache.set(run.id, progress)
				} else if (cached) {
					progress = cached
				}
				if (run.status === 'success' && progress && progress.total) {
					progress = { ...progress, completed: progress.total }
					flowProgressCache.set(run.id, progress)
				}
				updateFlowProgressUI(progress, progressEl, run.id)
			}
			if (stepRows && stepRows.length > 0) {
				try {
					await refreshFlowStepStatus(run, stepRows)
				} catch (stepError) {
					console.warn('Failed to refresh step status:', stepError)
				}
			}
		} catch (error) {
			logEl.textContent = `Failed to load logs: ${error?.message || error}`
		}
	}

	function startFlowLogPolling(run, logEl, progressEl, stepRows) {
		if (!run || !logEl) return
		const runId = run.id
		stopFlowLogPolling(runId)
		refreshFlowRunLogs(run, logEl, progressEl, stepRows)
		if (run.status === 'running') {
			const interval = setInterval(() => {
				refreshFlowRunLogs(run, logEl, progressEl, stepRows)
			}, 2000)
			flowLogIntervals.set(runId, interval)
		}
	}

	function stopFlowLogPolling(runId) {
		const interval = flowLogIntervals.get(runId)
		if (interval) {
			clearInterval(interval)
			flowLogIntervals.delete(runId)
		}
	}

	async function confirmWithDialog(message, options = {}) {
		if (dialog?.confirm) {
			return await dialog.confirm(message, options)
		}
		return window.confirm(message)
	}

	// Listen for flow logs and completion
	listen('flow-log-line', () => {
		refreshLogs()
	})

	listen('flow-complete', async (event) => {
		const status = event.payload
		console.log('Flow completed with status:', status)

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

	async function loadRunModules() {
		try {
			const modules = await invoke('get_modules')
			const container = document.getElementById('run-modules-list')
			container.innerHTML = ''

			modules.forEach((p) => {
				const item = document.createElement('div')
				item.className = 'selection-item'
				item.dataset.id = p.id
				item.innerHTML = `<strong>${p.name}</strong> - ${p.workflow}`

				item.addEventListener('click', () => {
					document
						.querySelectorAll('#run-modules-list .selection-item')
						.forEach((i) => i.classList.remove('selected'))
					item.classList.add('selected')
					selectedModule = parseInt(item.dataset.id)
					updateRunButton()
				})

				container.appendChild(item)
			})
		} catch (error) {
			console.error('Error loading modules:', error)
		}
	}

	function updateRunButton() {
		const btn = document.getElementById('run-btn')
		btn.disabled = selectedParticipants.length === 0 || selectedModule === null
	}

	function prepareRunView() {
		selectedParticipants = []
		selectedModule = null
		const selectAll = document.getElementById('select-all-participants')
		if (selectAll) {
			selectAll.checked = false
		}
		loadRunParticipants()
		loadRunModules()
		updateRunButton()
	}

	async function loadRuns() {
		try {
			await invoke('reconcile_flow_runs').catch((error) => {
				console.warn('Failed to reconcile flow runs:', error)
			})
			flowLogIntervals.forEach((_, runId) => stopFlowLogPolling(runId))
			// Check for auto-expand run ID
			let autoExpandRunId = null
			if (typeof sessionStorage !== 'undefined') {
				const storedRunId = sessionStorage.getItem('autoExpandRunId')
				if (storedRunId) {
					autoExpandRunId = parseInt(storedRunId, 10)
					sessionStorage.removeItem('autoExpandRunId') // Clear after reading
				}
			}

			// Load only flow runs (steps are now called modules)
			const flowRuns = await invoke('get_flow_runs')
			const flows = await invoke('get_flows') // Get flow names

			const container = document.getElementById('runs-list')

			if (flowRuns.length === 0) {
				container.innerHTML = `
					<div style="display: flex; flex-direction: column; align-items: center; justify-content: center; padding: 80px 32px; text-align: center;">
						<svg width="64" height="64" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" style="color: #cbd5e1; margin-bottom: 20px;">
							<polyline points="9 18 15 12 9 6"></polyline>
						</svg>
						<h3 style="margin: 0 0 8px 0; font-size: 18px; font-weight: 600; color: #475569;">No flow runs yet</h3>
						<p style="margin: 0; font-size: 14px; color: #94a3b8; line-height: 1.5;">Run a flow to see results here</p>
					</div>
				`
				return
			}

			container.innerHTML = ''

			// Display flow runs (sorted by most recent first)
			// The first run (latest) should be expanded by default unless user collapsed it
			flowRuns.forEach((run, index) => {
				// Find flow name
				const flow = flows.find((p) => p.id === run.flow_id)
				const flowName = flow ? flow.name : `Flow #${run.flow_id}`
				let runMetadata = {}
				try {
					runMetadata = run.metadata ? JSON.parse(run.metadata) : {}
				} catch (error) {
					console.warn('Failed to parse run metadata:', error)
				}
				const nextflowMaxForks =
					Number.isFinite(runMetadata?.nextflow_max_forks) && runMetadata.nextflow_max_forks > 0
						? runMetadata.nextflow_max_forks
						: null
				const dataSelection = runMetadata.data_selection || {}
				const titleParts = [flowName]
				if (dataSelection.dataset_name) titleParts.push(dataSelection.dataset_name)
				if (Array.isArray(dataSelection.asset_keys) && dataSelection.asset_keys.length > 0) {
					titleParts.push(dataSelection.asset_keys.join(', '))
				}
				if (dataSelection.data_type) {
					const typeLabel = dataSelection.data_type === 'private' ? 'real' : dataSelection.data_type
					titleParts.push(typeLabel)
				}
				const runTitle = titleParts.join(' - ')
				const card = document.createElement('div')
				card.className = 'flow-run-card'
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
				} else if (run.status === 'paused') {
					statusClass = 'paused'
					statusIcon = 'Ⅱ'
					statusColor = '#f59e0b'
					statusBg = 'linear-gradient(135deg, #fef3c7 0%, #fde68a 100%)'
					statusBadgeStyle =
						'background: linear-gradient(135deg, #fef3c7 0%, #fde68a 100%); color: #b45309; border: 1px solid rgba(245, 158, 11, 0.25);'
					statusBadge = `<span class="status-badge status-paused" style="padding: 6px 14px; border-radius: 8px; font-size: 12px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.05em; white-space: nowrap; ${statusBadgeStyle}">Ⅱ Paused</span>`
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
				};" onmouseover="if(this.closest('.flow-run-card').dataset.expanded !== 'true') { this.style.background='#f8fafc' }" onmouseout="if(this.closest('.flow-run-card').dataset.expanded !== 'true') { this.style.background='${
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
							runTitle,
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
							${
								nextflowMaxForks
									? `<span style="color: #cbd5e1;">•</span><span>Concurrency: ${nextflowMaxForks}</span>`
									: ''
							}
						</div>
						<div class="flow-progress flow-progress-inline" data-run-id="${run.id}" data-start-ms="${Date.parse(
							run.created_at,
						)}" style="margin-top: 8px; display: ${
							run.status === 'running' || run.status === 'paused' ? 'flex' : 'none'
						}; align-items: center; gap: 10px;">
							<div class="flow-progress-label" style="font-size: 11px; font-weight: 600; color: #64748b;">Progress unavailable</div>
							<div style="flex: 1; background: #e2e8f0; border-radius: 999px; height: 6px; overflow: hidden;">
								<div class="flow-progress-fill" style="height: 100%; width: 0%; background: linear-gradient(90deg, #38bdf8, #22c55e); transition: width 0.3s ease;"></div>
							</div>
							<div class="flow-progress-count" style="font-size: 11px; color: #94a3b8;">--</div>
							<div class="flow-progress-eta" style="font-size: 11px; color: #94a3b8;"></div>
						</div>
					</div>
					${statusBadge}
					<div style="display: flex; align-items: center; gap: 6px; flex-shrink: 0;">
						${
							run.status === 'paused' || run.status === 'failed'
								? `<div style="display: flex; align-items: center; gap: 6px; padding: 4px 8px; border-radius: 8px; background: #f8fafc; border: 1px solid #e2e8f0;">
									<span style="font-size: 11px; color: #64748b; font-weight: 600;">Concurrency</span>
									<input class="run-concurrency-input" data-run-id="${run.id}" type="number" min="1" step="1" value="${
										nextflowMaxForks ? nextflowMaxForks : ''
									}" placeholder="auto" style="width: 64px; padding: 4px 6px; border-radius: 6px; border: 1px solid #cbd5e1; font-size: 12px; color: #0f172a;" />
								</div>`
								: ''
						}
						${
							run.status === 'running'
								? `<button class="run-pause-btn" data-run-id="${run.id}" title="Pause run" style="width: 32px; height: 32px; display: flex; align-items: center; justify-content: center; background: transparent; border: none; color: #64748b; cursor: pointer; border-radius: 6px; transition: all 0.2s;" onmouseover="this.style.background='#fff7ed'; this.style.color='#f59e0b'; this.querySelector('img').style.filter='invert(60%) sepia(89%) saturate(473%) hue-rotate(1deg) brightness(95%) contrast(94%)'" onmouseout="this.style.background='transparent'; this.style.color='#64748b'; this.querySelector('img').style.filter='invert(50%) sepia(6%) saturate(340%) hue-rotate(183deg) brightness(90%) contrast(91%)'">
									<img src="assets/icons/pause.svg" width="18" height="18" style="filter: invert(50%) sepia(6%) saturate(340%) hue-rotate(183deg) brightness(90%) contrast(91%);" />
								</button>`
								: ''
						}
						${
							run.status === 'paused'
								? `<button class="run-resume-btn" data-run-id="${run.id}" title="Resume run" style="width: 32px; height: 32px; display: flex; align-items: center; justify-content: center; background: transparent; border: none; color: #64748b; cursor: pointer; border-radius: 6px; transition: all 0.2s;" onmouseover="this.style.background='#ecfdf3'; this.style.color='#10b981'; this.querySelector('img').style.filter='invert(63%) sepia(76%) saturate(436%) hue-rotate(108deg) brightness(93%) contrast(94%)'" onmouseout="this.style.background='transparent'; this.style.color='#64748b'; this.querySelector('img').style.filter='invert(50%) sepia(6%) saturate(340%) hue-rotate(183deg) brightness(90%) contrast(91%)'">
									<img src="assets/icons/play.svg" width="18" height="18" style="filter: invert(50%) sepia(6%) saturate(340%) hue-rotate(183deg) brightness(90%) contrast(91%);" />
								</button>`
								: ''
						}
						${
							run.status === 'failed'
								? `<button class="run-retry-btn" data-run-id="${run.id}" title="Retry with resume" style="width: 32px; height: 32px; display: flex; align-items: center; justify-content: center; background: transparent; border: none; color: #64748b; cursor: pointer; border-radius: 6px; transition: all 0.2s;" onmouseover="this.style.background='#f8fafc'; this.style.color='#2563eb'; this.querySelector('img').style.filter='invert(32%) sepia(94%) saturate(1352%) hue-rotate(212deg) brightness(99%) contrast(96%)'" onmouseout="this.style.background='transparent'; this.style.color='#64748b'; this.querySelector('img').style.filter='invert(50%) sepia(6%) saturate(340%) hue-rotate(183deg) brightness(90%) contrast(91%)'">
									<img src="assets/icons/rerun.svg" width="18" height="18" style="filter: invert(50%) sepia(6%) saturate(340%) hue-rotate(183deg) brightness(90%) contrast(91%);" />
								</button>`
								: ''
						}
						${
							run.status === 'success'
								? `<button class="run-share-btn" data-run-id="${run.id}" data-flow-name="${escapeHtml(flowName)}" data-results-dir="${run.results_dir || run.work_dir || ''}" title="Share results" style="width: 32px; height: 32px; display: flex; align-items: center; justify-content: center; background: transparent; border: none; color: #64748b; cursor: pointer; border-radius: 6px; transition: all 0.2s;" onmouseover="this.style.background='#f0fdf4'; this.style.color='#10b981'; this.querySelector('img').style.filter='invert(63%) sepia(76%) saturate(436%) hue-rotate(108deg) brightness(93%) contrast(94%)'" onmouseout="this.style.background='transparent'; this.style.color='#64748b'; this.querySelector('img').style.filter='invert(50%) sepia(6%) saturate(340%) hue-rotate(183deg) brightness(90%) contrast(91%)'">
									<img src="assets/icons/mail.svg" width="18" height="18" style="filter: invert(50%) sepia(6%) saturate(340%) hue-rotate(183deg) brightness(90%) contrast(91%);" />
								</button>`
								: ''
						}
						<button class="run-work-folder-btn" data-run-id="${run.id}" title="View work cache" style="width: 32px; height: 32px; display: flex; align-items: center; justify-content: center; background: transparent; border: none; color: #64748b; cursor: pointer; border-radius: 6px; transition: all 0.2s;" onmouseover="this.style.background='#fefce8'; this.style.color='#ca8a04'" onmouseout="this.style.background='transparent'; this.style.color='#64748b'">
							<img src="assets/icons/drive.svg" width="18" height="18" style="filter: invert(50%) sepia(6%) saturate(340%) hue-rotate(183deg) brightness(90%) contrast(91%);" onmouseover="this.style.filter='invert(56%) sepia(70%) saturate(387%) hue-rotate(7deg) brightness(96%) contrast(92%)'" onmouseout="this.style.filter='invert(50%) sepia(6%) saturate(340%) hue-rotate(183deg) brightness(90%) contrast(91%)'" />
						</button>
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
					loadFlowRunSteps(run, flow, detailsContainer).catch(console.error)
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
					if (
						e.target.closest('.run-delete-btn') ||
						e.target.closest('.run-view-folder-btn') ||
						e.target.closest('.run-work-folder-btn') ||
						e.target.closest('.run-pause-btn') ||
						e.target.closest('.run-resume-btn') ||
						e.target.closest('.run-retry-btn')
					) {
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
						await loadFlowRunSteps(run, flow, detailsContainer)
					} else {
						detailsContainer.style.display = 'none'
						stopFlowLogPolling(run.id)
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

				// Handle work folder button
				const workFolderBtn = card.querySelector('.run-work-folder-btn')
				if (workFolderBtn) {
					workFolderBtn.addEventListener('click', async (e) => {
						e.stopPropagation()
						try {
							const workPath = await invoke('get_flow_run_work_dir', { runId: run.id })
							if (workPath) {
								await invoke('open_folder', { path: workPath })
							}
						} catch (error) {
							alert(`Error opening work folder: ${error}`)
						}
					})
				}

				const pauseBtn = card.querySelector('.run-pause-btn')
				if (pauseBtn) {
					pauseBtn.addEventListener('click', async (e) => {
						e.stopPropagation()
						try {
							await invoke('pause_flow_run', { runId: run.id })
							await loadRuns()
						} catch (error) {
							alert(`Error pausing run: ${error}`)
						}
					})
				}

				const resumeBtn = card.querySelector('.run-resume-btn')
				if (resumeBtn) {
					resumeBtn.addEventListener('click', async (e) => {
						e.stopPropagation()
						try {
							const input = card.querySelector('.run-concurrency-input')
							const nextflowMaxForks = parseConcurrencyInput(input?.value)
							await invoke('resume_flow_run', { runId: run.id, nextflowMaxForks })
							await loadRuns()
						} catch (error) {
							alert(`Error resuming run: ${error}`)
						}
					})
				}

				const retryBtn = card.querySelector('.run-retry-btn')
				if (retryBtn) {
					retryBtn.addEventListener('click', async (e) => {
						e.stopPropagation()
						try {
							const input = card.querySelector('.run-concurrency-input')
							const nextflowMaxForks = parseConcurrencyInput(input?.value)
							await invoke('resume_flow_run', { runId: run.id, nextflowMaxForks })
							await loadRuns()
						} catch (error) {
							alert(`Error retrying run: ${error}`)
						}
					})
				}

				const concurrencyInput = card.querySelector('.run-concurrency-input')
				if (concurrencyInput) {
					concurrencyInput.addEventListener('click', (e) => e.stopPropagation())
					concurrencyInput.addEventListener('dblclick', (e) => e.stopPropagation())
					concurrencyInput.addEventListener('mousedown', (e) => e.stopPropagation())
				}

				// Handle delete
				const deleteBtn = card.querySelector('.run-delete-btn')
				if (deleteBtn) {
					deleteBtn.addEventListener('click', async (e) => {
						e.stopPropagation()
						const confirmed = await confirmWithDialog(
							`Delete flow run "${flowName}" (Run #${run.id}) and all its results? This action cannot be undone.`,
							{ title: 'Delete Run', type: 'warning' },
						)
						if (confirmed) {
							try {
								await invoke('delete_flow_run', { runId: run.id })
								await loadRuns()
							} catch (error) {
								alert(`Error deleting run: ${error}`)
							}
						}
					})
				}

				// Handle share results
				const shareBtn = card.querySelector('.run-share-btn')
				if (shareBtn) {
					shareBtn.addEventListener('click', async (e) => {
						e.stopPropagation()
						await showShareResultsModal(run, flow, flowName)
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

	// Load steps for an expanded flow run
	async function loadFlowRunSteps(run, flow, container) {
		try {
			const steps = flow && flow.spec && flow.spec.steps ? flow.spec.steps : []
			const resultsDir = run.results_dir || run.work_dir

			// Parse run metadata if available (stored when run was created)
			let runMetadata = {}
			try {
				runMetadata = run.metadata ? JSON.parse(run.metadata) : {}
			} catch (error) {
				console.warn('Failed to parse run metadata:', error)
			}
			const inputOverrides = runMetadata.input_overrides || {}
			const paramOverrides = runMetadata.parameter_overrides || {}
			const dataSelection = runMetadata.data_selection || {}
			const nextflowMaxForks =
				Number.isFinite(runMetadata?.nextflow_max_forks) && runMetadata.nextflow_max_forks > 0
					? runMetadata.nextflow_max_forks
					: null

			const dataSummaryParts = []
			if (dataSelection.dataset_name) {
				dataSummaryParts.push(`Dataset: ${dataSelection.dataset_name}`)
			}
			if (Array.isArray(dataSelection.asset_keys) && dataSelection.asset_keys.length > 0) {
				dataSummaryParts.push(`Asset: ${dataSelection.asset_keys.join(', ')}`)
			}
			if (dataSelection.data_type) {
				const label = dataSelection.data_type === 'private' ? 'real' : dataSelection.data_type
				dataSummaryParts.push(`Type: ${label}`)
			}
			if (dataSelection.participant_count) {
				dataSummaryParts.push(
					`${dataSelection.participant_count} participant${
						dataSelection.participant_count === 1 ? '' : 's'
					}`,
				)
			}

			const selectionFiles = Array.isArray(dataSelection.file_paths)
				? dataSelection.file_paths
				: Array.isArray(dataSelection.urls)
					? dataSelection.urls
					: []
			const maxFiles = 6
			const fileItems = selectionFiles.slice(0, maxFiles).map((path) => {
				const cleaned = typeof path === 'string' ? path.replace(/^file:\/\//, '') : ''
				const parts = cleaned.split('/')
				const name = parts[parts.length - 1] || cleaned
				return name || path
			})

			const dataSelectionHtml =
				dataSummaryParts.length > 0 || fileItems.length > 0
					? `<div class="run-data-selection" style="margin-bottom: 24px;">
						<div style="display: flex; align-items: center; gap: 10px; margin-bottom: 12px;">
							<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" style="color: #0ea5e9;">
								<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>
								<polyline points="7 10 12 15 17 10"></polyline>
								<line x1="12" y1="15" x2="12" y2="3"></line>
							</svg>
							<h3 style="margin: 0; font-size: 16px; font-weight: 700; color: #0f172a; letter-spacing: -0.01em;">Data Selection</h3>
						</div>
						${
							dataSummaryParts.length > 0
								? `<div style="margin-bottom: 12px; font-size: 13px; color: #475569; display: flex; flex-wrap: wrap; gap: 8px;">
									${dataSummaryParts
										.map(
											(part) =>
												`<span style="padding: 4px 8px; background: #f1f5f9; border-radius: 6px; border: 1px solid #e2e8f0;">${escapeHtml(
													part,
												)}</span>`,
										)
										.join('')}
								</div>`
								: ''
						}
						${
							fileItems.length > 0
								? `<div style="display: flex; flex-direction: column; gap: 6px;">
									${fileItems
										.map(
											(name) =>
												`<div style="padding: 8px 10px; background: #ffffff; border: 1px solid #e2e8f0; border-radius: 6px; font-size: 12px; color: #64748b; font-family: 'SF Mono', Monaco, monospace;">${escapeHtml(
													name,
												)}</div>`,
										)
										.join('')}
									${
										selectionFiles.length > maxFiles
											? `<div style="font-size: 12px; color: #94a3b8;">+${
													selectionFiles.length - maxFiles
												} more file${selectionFiles.length - maxFiles === 1 ? '' : 's'}</div>`
											: ''
									}
								</div>`
								: ''
						}
					</div>`
					: ''

			const logsExpanded = run.status === 'running'
			const logsHtml = `
				<div class="run-log-section" style="margin-bottom: 24px;">
					<button class="run-log-toggle" data-run-id="${run.id}" style="width: 100%; display: flex; align-items: center; gap: 10px; padding: 14px 16px; background: #f8fafc; border: 1.5px solid #e2e8f0; border-radius: 10px; cursor: pointer; transition: all 0.2s; text-align: left; font-size: 14px; font-weight: 600; color: #475569;" onmouseover="this.style.background='#f1f5f9'; this.style.borderColor='#cbd5e1'" onmouseout="this.style.background='#f8fafc'; this.style.borderColor='#e2e8f0'">
						<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" style="transition: transform 0.3s; color: #94a3b8; transform: ${logsExpanded ? 'rotate(90deg)' : 'rotate(0deg)'};">
							<polyline points="9 18 15 12 9 6"></polyline>
						</svg>
						<span>Logs</span>
						${
							nextflowMaxForks
								? `<span style="padding: 4px 8px; background: #e2e8f0; color: #475569; border-radius: 999px; font-size: 11px; font-weight: 600;">Concurrency: ${nextflowMaxForks}</span>`
								: ''
						}
						<span style="margin-left: auto; font-size: 12px; color: #94a3b8;">Nextflow output</span>
					</button>
					<div class="run-log-content" style="display: ${logsExpanded ? 'block' : 'none'}; padding: 16px; background: #ffffff; border: 1.5px solid #e2e8f0; border-top: none; border-radius: 0 0 10px 10px;">
						<pre class="run-log-stream" data-run-id="${run.id}" style="max-height: 260px; overflow: auto; background: #f8fafc; color: #1f2937; border-radius: 8px; padding: 12px; font-size: 12px; line-height: 1.5; font-family: 'SF Mono', Monaco, monospace; border: 1px solid #e2e8f0;">Loading logs...</pre>
					</div>
				</div>
			`

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
					${logsHtml}
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

					${dataSelectionHtml}

					${inputsHtml}

					<div class="run-steps-section" style="margin-top: 28px;">
						<button class="run-steps-toggle" onclick="this.nextElementSibling.style.display = this.nextElementSibling.style.display === 'none' ? 'block' : 'none'; this.querySelector('svg').style.transform = this.nextElementSibling.style.display === 'none' ? 'rotate(0deg)' : 'rotate(90deg)';" style="width: 100%; display: flex; align-items: center; gap: 10px; padding: 14px 16px; background: #f8fafc; border: 1.5px solid #e2e8f0; border-radius: 10px; cursor: pointer; transition: all 0.2s; text-align: left; font-size: 14px; font-weight: 600; color: #475569;" onmouseover="this.style.background='#f1f5f9'; this.style.borderColor='#cbd5e1'" onmouseout="this.style.background='#f8fafc'; this.style.borderColor='#e2e8f0'">
							<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" style="transition: transform 0.3s; color: #64748b; transform: rotate(0deg);">
								<polyline points="9 18 15 12 9 6"></polyline>
							</svg>
							<span>Flow Steps</span>
							<span style="margin-left: auto; padding: 4px 10px; background: #e2e8f0; color: #64748b; border-radius: 6px; font-size: 12px; font-weight: 600;">${
								steps.length
							} step${steps.length === 1 ? '' : 's'}</span>
							<span class="steps-progress-badge" data-run-id="${run.id}" style="padding: 4px 10px; background: #eef2ff; color: #4338ca; border-radius: 6px; font-size: 12px; font-weight: 700;">${
								run.status === 'success'
									? `${steps.length}/${steps.length} done`
									: `0/${steps.length} done`
							}</span>
						</button>
						<div class="run-steps-content" style="display: none; padding: 16px; background: white; border: 1.5px solid #e2e8f0; border-top: none; border-radius: 0 0 10px 10px;">
					<div style="display: flex; flex-direction: column; gap: 12px;">
						${steps
							.map(
								(step) => `
							<div class="step-row-enhanced" data-run-id="${run.id}" data-step-id="${escapeHtml(
								step.id,
							)}" data-step-path="${escapeHtml(`${resultsDir}/${step.id}`)}" data-step-status="${
								run.status === 'success' ? 'done' : run.status === 'failed' ? 'failed' : 'pending'
							}" style="background: white; border: 1.5px solid #e2e8f0; border-radius: 10px; padding: 18px 20px; transition: all 0.2s;" onmouseover="this.style.borderColor='#cbd5e1'; this.style.boxShadow='0 2px 8px rgba(0, 0, 0, 0.06)'" onmouseout="this.style.borderColor='#e2e8f0'; this.style.boxShadow='none'">
								<div class="step-main" style="display: flex; align-items: center; gap: 14px; margin-bottom: 16px;">
									<div class="step-icon step-status-indicator" style="width: 32px; height: 32px; border-radius: 8px; display: flex; align-items: center; justify-content: center; font-size: 14px; font-weight: 700; flex-shrink: 0; background: ${
										run.status === 'success'
											? 'linear-gradient(135deg, #d1fae5 0%, #a7f3d0 100%)'
											: run.status === 'failed'
												? 'linear-gradient(135deg, #fee2e2 0%, #fecaca 100%)'
												: '#f8fafc'
									}; color: ${
										run.status === 'success'
											? '#047857'
											: run.status === 'failed'
												? '#b91c1c'
												: '#64748b'
									}; border: 1.5px solid ${
										run.status === 'success'
											? 'rgba(5, 150, 105, 0.25)'
											: run.status === 'failed'
												? 'rgba(220, 38, 38, 0.25)'
												: 'rgba(148, 163, 184, 0.4)'
									};">
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
									<span class="step-status-badge" style="padding: 4px 10px; background: ${
										run.status === 'success'
											? '#d1fae5'
											: run.status === 'failed'
												? '#fee2e2'
												: '#f1f5f9'
									}; color: ${
										run.status === 'success'
											? '#047857'
											: run.status === 'failed'
												? '#b91c1c'
												: '#64748b'
									}; border-radius: 999px; font-size: 11px; font-weight: 700; margin-right: 6px;">${
										run.status === 'success'
											? 'Done'
											: run.status === 'failed'
												? 'Failed'
												: 'Pending'
									}</span>
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

			const logToggle = container.querySelector(`.run-log-toggle[data-run-id="${run.id}"]`)
			const logContent = container.querySelector('.run-log-content')
			const logStream = container.querySelector(`.run-log-stream[data-run-id="${run.id}"]`)
			const card = container.closest('.flow-run-card')
			const progressEls = card
				? card.querySelectorAll(`.flow-progress[data-run-id="${run.id}"]`)
				: container.querySelectorAll(`.flow-progress[data-run-id="${run.id}"]`)
			const stepRows = container.querySelectorAll(`.step-row-enhanced[data-run-id="${run.id}"]`)

			if (logToggle && logContent) {
				const setExpanded = (expanded) => {
					logContent.style.display = expanded ? 'block' : 'none'
					const icon = logToggle.querySelector('svg')
					if (icon) {
						icon.style.transform = expanded ? 'rotate(90deg)' : 'rotate(0deg)'
					}
					if (expanded || run.status === 'running') {
						startFlowLogPolling(run, logStream, progressEls, stepRows)
					} else {
						stopFlowLogPolling(run.id)
					}
				}
				logToggle.addEventListener('click', () => {
					const isOpen = logContent.style.display !== 'none'
					setExpanded(!isOpen)
				})
				if (logsExpanded) {
					setExpanded(true)
				} else if (run.status === 'running') {
					startFlowLogPolling(run, logStream, progressEls, stepRows)
				}
			}

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
		if (selectedParticipants.length === 0 || selectedModule === null) return

		const btn = document.getElementById('run-btn')
		btn.disabled = true
		btn.textContent = 'Starting...'

		try {
			// First, create the run record
			const result = await invoke('start_analysis', {
				participantIds: selectedParticipants,
				moduleId: selectedModule,
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

	// Show modal to share flow run results
	async function showShareResultsModal(run, flow, flowName) {
		const steps = flow && flow.spec && flow.spec.steps ? flow.spec.steps : []
		const resultsDir = run.results_dir || run.work_dir

		// Collect all published outputs
		const publishedOutputs = []
		steps.forEach((step) => {
			if (step.publish && Object.keys(step.publish).length > 0) {
				Object.entries(step.publish).forEach(([name, spec]) => {
					const fileName = spec.match(/\(([^)]+)\)/)?.[1] || name
					const outputPath = `${resultsDir}/${step.id}/${fileName}`
					publishedOutputs.push({
						name,
						fileName,
						path: outputPath,
						stepId: step.id,
					})
				})
			}
		})

		if (publishedOutputs.length === 0) {
			alert('This run has no published outputs to share.')
			return
		}

		// Get known contacts for recipient selection
		let contacts = []
		try {
			contacts = await invoke('key_list_contacts', { currentEmail: null })
		} catch (error) {
			console.error('Error loading contacts:', error)
		}

		// Create modal
		const modal = document.createElement('div')
		modal.id = 'share-results-modal'
		modal.style.cssText =
			'position: fixed; top: 0; left: 0; right: 0; bottom: 0; background: rgba(0,0,0,0.5); display: flex; align-items: center; justify-content: center; z-index: 1000;'

		modal.innerHTML = `
			<div style="background: white; border-radius: 16px; max-width: 560px; width: 90%; max-height: 80vh; overflow-y: auto; box-shadow: 0 20px 40px rgba(0, 0, 0, 0.2);">
				<div style="padding: 24px 28px; border-bottom: 1px solid #e2e8f0;">
					<div style="display: flex; align-items: center; justify-content: space-between;">
						<h2 style="margin: 0; font-size: 20px; font-weight: 700; color: #0f172a;">Share Results</h2>
						<button id="share-modal-close" style="width: 32px; height: 32px; display: flex; align-items: center; justify-content: center; background: transparent; border: none; cursor: pointer; border-radius: 8px; transition: background 0.2s;" onmouseover="this.style.background='#f1f5f9'" onmouseout="this.style.background='transparent'">
							<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" style="color: #64748b;">
								<line x1="18" y1="6" x2="6" y2="18"></line>
								<line x1="6" y1="6" x2="18" y2="18"></line>
							</svg>
						</button>
					</div>
					<p style="margin: 8px 0 0; font-size: 14px; color: #64748b;">Share flow results from <strong>${escapeHtml(flowName)}</strong> (Run #${run.id})</p>
				</div>

				<div style="padding: 24px 28px;">
					<div style="margin-bottom: 20px;">
						<label style="display: block; font-size: 13px; font-weight: 600; color: #475569; margin-bottom: 8px;">Recipient</label>
						<select id="share-recipient" style="width: 100%; padding: 12px 16px; border: 1.5px solid #e2e8f0; border-radius: 10px; font-size: 14px; background: white; cursor: pointer; transition: border-color 0.2s;" onfocus="this.style.borderColor='#3b82f6'" onblur="this.style.borderColor='#e2e8f0'">
							<option value="">Select recipient...</option>
							${contacts.map((c) => `<option value="${escapeHtml(c.identity)}">${escapeHtml(c.identity)}</option>`).join('')}
						</select>
					</div>

					<div style="margin-bottom: 20px;">
						<label style="display: block; font-size: 13px; font-weight: 600; color: #475569; margin-bottom: 8px;">Select outputs to share</label>
						<div id="share-outputs-list" style="display: flex; flex-direction: column; gap: 8px; max-height: 200px; overflow-y: auto; padding: 4px;">
							${publishedOutputs
								.map(
									(output, idx) => `
								<label style="display: flex; align-items: center; gap: 12px; padding: 14px 16px; background: #f8fafc; border: 1.5px solid #e2e8f0; border-radius: 10px; cursor: pointer; transition: all 0.2s;" onmouseover="this.style.borderColor='#10b981'; this.style.background='#f0fdf4'" onmouseout="if(!this.querySelector('input').checked) { this.style.borderColor='#e2e8f0'; this.style.background='#f8fafc' }">
									<input type="checkbox" id="share-output-${idx}" data-path="${escapeHtml(output.path)}" data-filename="${escapeHtml(output.fileName)}" checked style="width: 18px; height: 18px; accent-color: #10b981;" />
									<div style="flex: 1;">
										<div style="font-size: 14px; font-weight: 600; color: #0f172a;">${escapeHtml(output.fileName)}</div>
										<div style="font-size: 12px; color: #64748b; font-family: 'SF Mono', Monaco, monospace;">${escapeHtml(output.stepId)}</div>
									</div>
									<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="color: #10b981;">
										<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>
										<polyline points="17 8 12 3 7 8"></polyline>
										<line x1="12" y1="3" x2="12" y2="15"></line>
									</svg>
								</label>
							`,
								)
								.join('')}
						</div>
					</div>

					<div style="margin-bottom: 20px;">
						<label style="display: block; font-size: 13px; font-weight: 600; color: #475569; margin-bottom: 8px;">Message (optional)</label>
						<textarea id="share-message" placeholder="Add a message about the results..." style="width: 100%; padding: 12px 16px; border: 1.5px solid #e2e8f0; border-radius: 10px; font-size: 14px; min-height: 80px; resize: vertical; font-family: inherit; transition: border-color 0.2s;" onfocus="this.style.borderColor='#3b82f6'" onblur="this.style.borderColor='#e2e8f0'"></textarea>
					</div>
				</div>

				<div style="padding: 16px 28px 24px; display: flex; gap: 12px; justify-content: flex-end;">
					<button id="share-cancel-btn" style="padding: 12px 24px; background: #f1f5f9; color: #475569; border: none; border-radius: 10px; font-size: 14px; font-weight: 600; cursor: pointer; transition: background 0.2s;" onmouseover="this.style.background='#e2e8f0'" onmouseout="this.style.background='#f1f5f9'">Cancel</button>
					<button id="share-send-btn" style="padding: 12px 24px; background: linear-gradient(135deg, #10b981 0%, #059669 100%); color: white; border: none; border-radius: 10px; font-size: 14px; font-weight: 600; cursor: pointer; transition: all 0.2s; box-shadow: 0 2px 8px rgba(16, 185, 129, 0.3);" onmouseover="this.style.transform='translateY(-1px)'; this.style.boxShadow='0 4px 12px rgba(16, 185, 129, 0.4)'" onmouseout="this.style.transform='translateY(0)'; this.style.boxShadow='0 2px 8px rgba(16, 185, 129, 0.3)'">Send Results</button>
				</div>
			</div>
		`

		document.body.appendChild(modal)

		// Close handlers
		const closeModal = () => {
			modal.remove()
		}

		modal.querySelector('#share-modal-close').addEventListener('click', closeModal)
		modal.querySelector('#share-cancel-btn').addEventListener('click', closeModal)
		modal.addEventListener('click', (e) => {
			if (e.target === modal) closeModal()
		})

		// Send handler
		modal.querySelector('#share-send-btn').addEventListener('click', async () => {
			const recipient = modal.querySelector('#share-recipient').value
			if (!recipient) {
				alert('Please select a recipient.')
				return
			}

			const selectedOutputs = []
			modal.querySelectorAll('#share-outputs-list input[type="checkbox"]:checked').forEach((cb) => {
				selectedOutputs.push({
					path: cb.dataset.path,
					fileName: cb.dataset.filename,
				})
			})

			if (selectedOutputs.length === 0) {
				alert('Please select at least one output to share.')
				return
			}

			const message = modal.querySelector('#share-message').value.trim()

			try {
				await invoke('send_flow_results', {
					recipient,
					flowName,
					runId: run.id,
					outputs: selectedOutputs,
					message,
				})
				closeModal()
				alert('Results sent successfully!')
			} catch (error) {
				alert('Error sending results: ' + error)
			}
		})
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
