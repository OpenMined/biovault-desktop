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
	const flowReconcileAt = new Map()
	const flowNfCommandCache = new Map()
	const flowTimerIntervals = new Map()
	let flowReconcileInFlight = false
	const multipartyPollingIntervals = new Map()
	const multipartyActiveTabs = new Map()
	const multipartyLastSyncAt = new Map()
	const multipartyStepExpanded = new Map()
	const multipartyCodeExpanded = new Map()
	const multipartyLogExpanded = new Map()
	const multipartyStepLogIntervals = new Map()
	const multipartyStepLogCache = new Map()
	const multipartyStepTimerIntervals = new Map()
	const multipartyRenderedHtml = new Map()
	const multipartyRenderKeys = new Map()
	const multipartyStepTimers = new Map()
	const multipartyParticipantStatusMemory = new Map()
	const multipartyDiagnosticsSamples = new Map()
	const multipartyLoadInFlight = new Map()
	let runsRenderKey = ''

	function getNestedState(map, sessionId) {
		let nested = map.get(sessionId)
		if (!nested) {
			nested = new Map()
			map.set(sessionId, nested)
		}
		return nested
	}

	// Start polling for multiparty state updates
	function startMultipartyPolling(sessionId, runId) {
		stopMultipartyPolling(sessionId)
		// Poll every 3 seconds for state updates from other participants
		const interval = setInterval(async () => {
			if (multipartyLoadInFlight.get(sessionId)) return
			multipartyLoadInFlight.set(sessionId, true)
			try {
				await loadMultipartySteps(sessionId, runId)
			} catch (err) {
				console.warn('Multiparty polling error:', err)
			} finally {
				multipartyLoadInFlight.set(sessionId, false)
			}
		}, 3000)
		multipartyPollingIntervals.set(sessionId, interval)
		const timerInterval = setInterval(() => {
			refreshStepTimerNodes(sessionId)
		}, 1000)
		multipartyStepTimerIntervals.set(sessionId, timerInterval)
	}

	function stopMultipartyPolling(sessionId) {
		const interval = multipartyPollingIntervals.get(sessionId)
		if (interval) {
			clearInterval(interval)
			multipartyPollingIntervals.delete(sessionId)
		}
		const timerInterval = multipartyStepTimerIntervals.get(sessionId)
		if (timerInterval) {
			clearInterval(timerInterval)
			multipartyStepTimerIntervals.delete(sessionId)
		}
		stopAllStepLogPolling(sessionId)
		multipartyLoadInFlight.delete(sessionId)
		for (const key of multipartyDiagnosticsSamples.keys()) {
			if (key.startsWith(`${sessionId}::`)) {
				multipartyDiagnosticsSamples.delete(key)
			}
		}
	}

	function stopAllMultipartyPolling() {
		multipartyPollingIntervals.forEach((_, sessionId) => stopMultipartyPolling(sessionId))
		multipartyStepLogIntervals.forEach((interval) => clearInterval(interval))
		multipartyStepLogIntervals.clear()
		multipartyStepTimerIntervals.forEach((interval) => clearInterval(interval))
		multipartyStepTimerIntervals.clear()
		multipartyRenderedHtml.clear()
		multipartyRenderKeys.clear()
		multipartyStepTimers.clear()
		multipartyParticipantStatusMemory.clear()
		multipartyDiagnosticsSamples.clear()
		multipartyLoadInFlight.clear()
	}

	function getStepLogKey(sessionId, stepId) {
		return `${sessionId}::${stepId}`
	}

	function getStepTimerKey(sessionId, stepId) {
		return `${sessionId}::${stepId}`
	}

	async function showDockerWarningModal(runAction) {
		return new Promise((resolve) => {
			const existing = document.getElementById('docker-warning-modal')
			if (existing) existing.remove()

			const overlay = document.createElement('div')
			overlay.id = 'docker-warning-modal'
			overlay.style.cssText =
				'position: fixed; inset: 0; background: rgba(15,23,42,0.45); display: flex; align-items: center; justify-content: center; z-index: 9999;'

			const modal = document.createElement('div')
			modal.style.cssText =
				'background: #ffffff; color: #0f172a; width: min(460px, 92vw); border-radius: 14px; box-shadow: 0 18px 50px rgba(0,0,0,0.25); padding: 22px 24px; display: flex; flex-direction: column; gap: 14px;'

			modal.innerHTML = `
				<div style="display:flex; gap:12px; align-items:flex-start;">
					<div style="width:14px; height:14px; margin-top:2px; color:#b91c1c;">⚠️</div>
					<div style="flex:1;">
						<div style="font-weight:700; font-size:16px; margin-bottom:6px;">Docker isn’t running</div>
						<div style="font-size:13px; line-height:1.4; color:#334155;">
							Start Docker Desktop, then re-check. You can also choose to run anyway (it may fail).
						</div>
						<div id="docker-check-status" style="margin-top:8px; font-size:12px; color:#b91c1c;"></div>
					</div>
				</div>
				<div style="display:flex; gap:8px; justify-content:flex-end; margin-top:8px;">
					<button id="docker-cancel" style="padding:10px 14px; border-radius:8px; border:1px solid #e2e8f0; background:#f8fafc; color:#0f172a; font-weight:600; cursor:pointer;">Cancel</button>
					<button id="docker-run-anyway" style="padding:10px 14px; border-radius:8px; border:1px solid #e2e8f0; background:#fff; color:#0f172a; font-weight:700; cursor:pointer;">Run anyway</button>
					<button id="docker-recheck" style="padding:10px 14px; border-radius:8px; border:none; background:linear-gradient(135deg,#16a34a 0%,#15803d 100%); color:#fff; font-weight:700; cursor:pointer;">I started Docker, re-check</button>
				</div>
			`

			const statusEl = modal.querySelector('#docker-check-status')

			function close() {
				overlay.remove()
			}

			modal.querySelector('#docker-cancel').addEventListener('click', () => {
				close()
				resolve(false)
			})

			modal.querySelector('#docker-run-anyway').addEventListener('click', async () => {
				close()
				await runAction()
				resolve(true)
			})

			modal.querySelector('#docker-recheck').addEventListener('click', async () => {
				statusEl.textContent = 'Checking Docker...'
				statusEl.style.color = '#0f172a'
				try {
					const running = await invoke('check_docker_running')
					if (running) {
						statusEl.textContent = 'Docker is running! Running step...'
						statusEl.style.color = '#15803d'
						close()
						await runAction()
						resolve(true)
					} else {
						statusEl.textContent = 'Still not running. Please start Docker then click re-check.'
						statusEl.style.color = '#b91c1c'
					}
				} catch (err) {
					console.error('Docker re-check failed:', err)
					statusEl.textContent = 'Could not check Docker (see console).'
					statusEl.style.color = '#b91c1c'
				}
			})

			overlay.addEventListener('click', (e) => {
				if (e.target === overlay) {
					close()
					resolve(false)
				}
			})

			overlay.appendChild(modal)
			document.body.appendChild(overlay)
		})
	}

	function formatClockDuration(ms) {
		const totalSeconds = Math.max(0, Math.floor(ms / 1000))
		const hours = Math.floor(totalSeconds / 3600)
		const minutes = Math.floor((totalSeconds % 3600) / 60)
		const seconds = totalSeconds % 60
		if (hours > 0) {
			return `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
		}
		return `${minutes}:${String(seconds).padStart(2, '0')}`
	}

	function updateStepTimer(sessionId, stepId, status) {
		const key = getStepTimerKey(sessionId, stepId)
		const now = Date.now()
		const running = status === 'Running'
		const done = status === 'Completed' || status === 'Shared' || status === 'Failed'
		const reset = status === 'Pending' || status === 'Ready' || status === 'WaitingForInputs'
		const existing = multipartyStepTimers.get(key)

		if (!existing) {
			if (running || done) {
				multipartyStepTimers.set(key, {
					startedAt: now,
					stoppedAt: done ? now : null,
				})
			}
			return
		}

		if (running) {
			// Keep completed timers frozen if a stale refresh briefly reports Running again.
			if (existing.stoppedAt) {
				return
			}
			if (!existing.startedAt) {
				existing.startedAt = now
			}
			existing.stoppedAt = null
			return
		}

		if (done) {
			if (!existing.startedAt) {
				existing.startedAt = now
			}
			if (!existing.stoppedAt) {
				existing.stoppedAt = now
			}
			return
		}

		if (reset) {
			// Preserve frozen durations for already-completed steps even if a stale
			// status refresh briefly reports Pending/Ready.
			if (existing.stoppedAt) {
				return
			}
			multipartyStepTimers.delete(key)
		}
	}

	function getStepTimerLabel(sessionId, stepId) {
		const timer = multipartyStepTimers.get(getStepTimerKey(sessionId, stepId))
		if (!timer?.startedAt) return ''
		const end = timer.stoppedAt || Date.now()
		return formatClockDuration(end - timer.startedAt)
	}

	function refreshStepTimerNodes(sessionId) {
		const nodes = document.querySelectorAll(
			`.mp-step-timer[data-session-id="${sessionId}"][data-step-id]`,
		)
		nodes.forEach((node) => {
			const stepId = node.dataset.stepId
			if (!stepId) return
			const label = getStepTimerLabel(sessionId, stepId)
			node.textContent = label ? `⏱ ${label}` : ''
		})
	}

	function stopStepLogPolling(sessionId, stepId) {
		const key = getStepLogKey(sessionId, stepId)
		const interval = multipartyStepLogIntervals.get(key)
		if (interval) {
			clearInterval(interval)
			multipartyStepLogIntervals.delete(key)
		}
	}

	function stopAllStepLogPolling(sessionId) {
		const prefix = `${sessionId}::`
		for (const [key, interval] of multipartyStepLogIntervals.entries()) {
			if (key.startsWith(prefix)) {
				clearInterval(interval)
				multipartyStepLogIntervals.delete(key)
			}
		}
		for (const key of multipartyStepLogCache.keys()) {
			if (key.startsWith(prefix)) {
				multipartyStepLogCache.delete(key)
			}
		}
	}

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
						eta.textContent = `ETA ~ ${formatEtaDuration(cappedMs)}`
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

	function formatEtaDuration(ms) {
		if (!Number.isFinite(ms) || ms <= 0) return '—'
		const totalSeconds = Math.round(ms / 1000)
		const minutes = Math.floor(totalSeconds / 60)
		const seconds = totalSeconds % 60
		if (minutes > 0) {
			return `${minutes}m ${seconds}s`
		}
		return `${seconds}s`
	}

	async function updateContainerCount(progressEl) {
		if (!progressEl) return
		try {
			const count = await invoke('get_container_count')
			const elements = Array.isArray(progressEl)
				? progressEl
				: progressEl instanceof NodeList
					? Array.from(progressEl)
					: [progressEl]
			elements.forEach((el) => {
				if (!el) return
				const containerCountEl = el.querySelector('.container-count-value')
				if (containerCountEl) {
					containerCountEl.textContent = count > 0 ? count : '-'
					// Change color based on count
					const containerDiv = el.querySelector('.flow-container-count')
					if (containerDiv) {
						containerDiv.style.color = count > 0 ? '#3b82f6' : '#94a3b8'
					}
				}
			})
		} catch (error) {
			console.warn('Failed to get container count:', error)
		}
	}

	// Save flow state to backend for persistence across restarts
	async function saveFlowState(runId, progress, concurrency, containerCount, nextflowCommand) {
		if (!runId || !progress || !progress.total) return
		try {
			await invoke('save_flow_state_cmd', {
				runId,
				completed: progress.completed || 0,
				total: progress.total,
				concurrency: concurrency || null,
				containerCount: containerCount || 0,
				nextflowCommand: nextflowCommand || null,
			})
		} catch (error) {
			console.warn('Failed to save flow state:', error)
		}
	}

	// Load saved flow state from backend
	async function loadFlowState(runId) {
		if (!runId) return null
		try {
			const state = await invoke('get_flow_state', { runId })
			return state
		} catch (error) {
			console.warn('Failed to load flow state:', error)
			return null
		}
	}

	// Load and display saved flow state for paused/failed/success runs
	async function loadAndDisplaySavedState(runId, progressEl, concurrencyInput, runStatus) {
		const state = await loadFlowState(runId)
		if (!state) return null

		// Update progress display if we have saved progress
		if (state.total && state.total > 0) {
			let progress = { completed: state.completed || 0, total: state.total }
			if (runStatus === 'success') {
				progress = { completed: state.total, total: state.total }
			}
			flowProgressCache.set(runId, progress)
			updateFlowProgressUI(progress, progressEl, runId)
		}

		// Pre-fill concurrency input if we have a saved value
		if (state.concurrency && concurrencyInput) {
			concurrencyInput.value = state.concurrency
		}

		// Restore saved nextflow command
		if (state.nextflow_command) {
			flowNfCommandCache.set(runId, state.nextflow_command)
			populateNfCommand(runId, state.nextflow_command)
		}

		return state
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

	function populateNfCommand(runId, nfCmd) {
		const nfEl = document.querySelector(`.actual-nf-command[data-run-id="${runId}"]`)
		if (nfEl && nfCmd) {
			nfEl.style.display = 'block'
			const pre = nfEl.querySelector('.actual-nf-command-text')
			if (pre) pre.textContent = nfCmd
			const copyBtn = nfEl.querySelector('.copy-nf-cmd-btn')
			if (copyBtn) copyBtn.dataset.command = nfCmd
		}
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
				// Update container count for running jobs
				let containerCount = 0
				if (run.status === 'running') {
					try {
						containerCount = await invoke('get_container_count')
					} catch (e) {
						// Ignore
					}
					updateContainerCount(progressEl)
				}
				// Save state for persistence/recovery
				if (progress && progress.total && run.status === 'running') {
					saveFlowState(run.id, progress, null, containerCount)
				}
			}
			// Extract actual nextflow command from logs and persist it
			if (logs) {
				const nfCmdMatch = logs.match(/\[Pipeline\] Nextflow command:\s*(.+)/)
				if (nfCmdMatch) {
					const nfCmd = nfCmdMatch[1].trim()
					flowNfCommandCache.set(run.id, nfCmd)
					populateNfCommand(run.id, nfCmd)
					// Persist to state file so it survives re-renders
					if (progress && progress.total) {
						saveFlowState(run.id, progress, null, 0, nfCmd)
					}
				}
			}
			if (run.status === 'running') {
				const now = Date.now()
				const lastReconcile = flowReconcileAt.get(run.id) || 0
				if (!flowReconcileInFlight && now - lastReconcile > 15000) {
					flowReconcileInFlight = true
					flowReconcileAt.set(run.id, now)
					invoke('reconcile_flow_runs')
						.then(async () => {
							try {
								const runs = await invoke('get_flow_runs')
								const updated = Array.isArray(runs)
									? runs.find((entry) => entry && entry.id === run.id)
									: null
								if (updated && updated.status && updated.status !== run.status) {
									await loadRuns()
								}
							} catch (lookupError) {
								console.warn('Failed to check reconciled run status:', lookupError)
							}
						})
						.catch((reconcileError) => {
							console.warn('Failed to reconcile flow runs:', reconcileError)
						})
						.finally(() => {
							flowReconcileInFlight = false
						})
				}
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

	// Render multiparty details section for a run
	function renderMultipartyDetails(runMetadata, runId) {
		const { session_id, my_role, participants } = runMetadata
		if (!session_id || !participants) return ''
		const inputOverrides = runMetadata?.input_overrides || {}
		const inputEntries = Object.entries(inputOverrides).filter(([key]) => key.startsWith('inputs.'))

		const participantsHtml = participants
			.map((p) => {
				const isMe = p.role === my_role
				return `<span class="mp-participant ${isMe ? 'is-me' : ''}">
					<span class="mp-participant-role">${escapeHtml(p.role)}</span>
					<span class="mp-participant-email">${escapeHtml(p.email)}${isMe ? ' (you)' : ''}</span>
				</span>`
			})
			.join('')

		const inputsHtml =
			inputEntries.length > 0
				? `
				<div class="mp-section mp-inputs-section">
					<button class="mp-inputs-toggle" type="button" data-run-id="${runId}">
						<span>⚙ Inputs</span>
						<span class="mp-inputs-count">${inputEntries.length}</span>
					</button>
					<div class="mp-inputs-body" data-run-id="${runId}" style="display: none;">
						${inputEntries
							.map(
								([key, value]) => `
								<div class="mp-input-row">
									<span class="mp-input-key">${escapeHtml(key)}</span>
									<span class="mp-input-value">${escapeHtml(String(value))}</span>
								</div>
							`,
							)
							.join('')}
					</div>
				</div>`
				: ''

		return `
			<div class="multiparty-details" data-session-id="${escapeHtml(session_id)}">
				<div class="mp-section">
					<div class="mp-section-title">👥 Participants</div>
					<div class="mp-participants">${participantsHtml}</div>
				</div>
				${inputsHtml}
				<div class="mp-section">
					<div class="mp-section-title">📋 Steps</div>
					<div class="mp-steps-list" data-run-id="${runId}">
						<div class="mp-steps-loading">Loading steps...</div>
					</div>
				</div>
			</div>
		`
	}

	function updateMultipartyRunCardState(runId, isComplete) {
		const runCard = document.querySelector(`.flow-run-card[data-run-id="${runId}"]`)
		if (!runCard) return
		runCard.classList.toggle('mp-run-complete', !!isComplete)

		const statusBadge = runCard.querySelector('.status-badge')
		if (statusBadge && runCard.dataset.isMultiparty === 'true') {
			if (isComplete) {
				statusBadge.textContent = '✓ Complete'
				statusBadge.classList.add('mp-run-status-complete')
			} else {
				statusBadge.classList.remove('mp-run-status-complete')
				if (statusBadge.textContent?.includes('Complete')) {
					statusBadge.textContent = '⋯ Running'
				}
			}
		}
	}

	// Load and render multiparty steps for a run
	async function loadMultipartySteps(sessionId, runId) {
		const stepsContainer = document.querySelector(`.mp-steps-list[data-run-id="${runId}"]`)
		if (!stepsContainer) return

		// Preserve active tab state before refresh
		const activeTab =
			multipartyActiveTabs.get(sessionId) ||
			stepsContainer.querySelector('.mp-tab.active')?.dataset?.tab ||
			'steps'
		const previousScrollTop = stepsContainer.scrollTop

		try {
			// Keep shared _progress state fresh across peers without spamming sync requests.
			const now = Date.now()
			const lastSync = multipartyLastSyncAt.get(sessionId) || 0
			if (now - lastSync > 2000) {
				multipartyLastSyncAt.set(sessionId, now)
				await invoke('trigger_syftbox_sync').catch(() => null)
			}

			// Fetch flow state, participant progress, and shared activity logs.
			const [state, allProgress, activityLogs] = await Promise.all([
				invoke('get_multiparty_flow_state', { sessionId }),
				invoke('get_all_participant_progress', { sessionId }).catch(() => []),
				invoke('get_participant_logs', { sessionId }).catch(() => []),
			])

			if (!state || !state.steps) {
				multipartyRenderedHtml.delete(sessionId)
				multipartyRenderKeys.delete(sessionId)
				stepsContainer.innerHTML = '<div class="mp-no-steps">No steps found</div>'
				return
			}

			const diagnosticStepIds = [
				...new Set(
					(state.steps || [])
						.filter((step) => {
							const id = String(step?.id || '').toLowerCase()
							const modulePath = String(step?.module_path || '').toLowerCase()
							return id === 'secure_aggregate' || modulePath.includes('secure-aggregate')
						})
						.map((step) => step.id),
				),
			]
			const diagnosticsByStepId = new Map()
			if (diagnosticStepIds.length > 0) {
				const diagnosticResults = await Promise.all(
					diagnosticStepIds.map((stepId) =>
						invoke('get_multiparty_step_diagnostics', { sessionId, stepId }).catch(() => null),
					),
				)
				for (const diagnostics of diagnosticResults) {
					if (diagnostics && diagnostics.step_id) {
						diagnosticsByStepId.set(diagnostics.step_id, diagnostics)
					}
				}
			}

			const normalizeKey = (value) => String(value || '').toLowerCase()
			const parseTimestampMs = (value) => {
				if (!value) return null
				const ts = Date.parse(String(value))
				return Number.isFinite(ts) ? ts : null
			}
			const normalizeProgressStatus = (rawStatus) => {
				const raw = String(rawStatus || '')
				const normalized = raw.trim().toLowerCase()
				if (
					normalized === 'completed' ||
					normalized === 'complete' ||
					normalized === 'done' ||
					normalized === 'success' ||
					normalized === 'succeeded'
				) {
					return 'Completed'
				}
				if (normalized === 'shared') return 'Shared'
				if (normalized === 'sharing') return 'Sharing'
				if (
					normalized === 'running' ||
					normalized === 'in_progress' ||
					normalized === 'in-progress'
				)
					return 'Running'
				if (normalized === 'ready') return 'Ready'
				if (
					normalized === 'waitingforinputs' ||
					normalized === 'waiting_for_inputs' ||
					normalized === 'waiting-for-inputs'
				) {
					return 'WaitingForInputs'
				}
				if (normalized === 'failed' || normalized === 'error') return 'Failed'
				return raw || 'Pending'
			}
			const progressStatusRank = (statusValue) => {
				const normalized = normalizeProgressStatus(statusValue)
				if (normalized === 'Failed') return 100
				if (normalized === 'Shared') return 90
				if (normalized === 'Completed') return 80
				if (normalized === 'Sharing') return 70
				if (normalized === 'Running') return 60
				if (normalized === 'Ready') return 50
				if (normalized === 'WaitingForInputs') return 40
				return 10
			}
			const statusMemory = getNestedState(multipartyParticipantStatusMemory, sessionId)
			const memoryKey = (stepId, email) => `${stepId}::${normalizeKey(email)}`
			const isDoneForStep = (step, status) => {
				if (!status) return false
				if (step.shares_output) return status === 'Shared'
				return status === 'Completed' || status === 'Shared'
			}
			// Build a map of step -> participant email -> progress record
			const stepParticipants = {}
			for (const p of allProgress) {
				for (const s of p.steps || []) {
					if (!stepParticipants[s.step_id]) stepParticipants[s.step_id] = {}
					stepParticipants[s.step_id][normalizeKey(p.email)] = {
						email: p.email,
						role: p.role,
						status: normalizeProgressStatus(s.status),
						output_dir: s.output_dir || null,
					}
				}
			}
			// Fallback: infer per-participant step completion from shared activity logs.
			for (const log of activityLogs || []) {
				if (!log?.step_id || !log?.participant) continue
				if (log.event !== 'step_completed' && log.event !== 'step_shared') continue
				if (!stepParticipants[log.step_id]) stepParticipants[log.step_id] = {}
				const key = normalizeKey(log.participant)
				const existing = stepParticipants[log.step_id][key]
				const existingStatus = existing?.status
				const inferredStatus =
					log.event === 'step_shared' || existingStatus === 'Shared' ? 'Shared' : 'Completed'
				stepParticipants[log.step_id][key] = {
					email: existing?.email || log.participant,
					role: existing?.role || null,
					status: normalizeProgressStatus(inferredStatus),
					output_dir: existing?.output_dir || null,
				}
			}

			// Seed/freeze step timers from local participant activity logs so completed
			// cards retain elapsed time across rerenders and sync refreshes.
			const myEmailKey = normalizeKey(state.my_email)
			for (const log of activityLogs || []) {
				const stepId = String(log?.step_id || '').trim()
				if (!stepId) continue
				if (normalizeKey(log?.participant) !== myEmailKey) continue
				const event = String(log?.event || '')
				if (!['step_started', 'step_completed', 'step_shared'].includes(event)) continue
				const tsMs = parseTimestampMs(log?.timestamp)
				if (!tsMs) continue

				const timerKey = getStepTimerKey(sessionId, stepId)
				const current = multipartyStepTimers.get(timerKey) || {
					startedAt: null,
					stoppedAt: null,
				}
				if (event === 'step_started') {
					if (!current.startedAt || tsMs < current.startedAt) current.startedAt = tsMs
				} else {
					if (!current.startedAt) current.startedAt = tsMs
					if (!current.stoppedAt || tsMs > current.stoppedAt) current.stoppedAt = tsMs
				}
				multipartyStepTimers.set(timerKey, current)
			}
			// Ensure current participant's latest in-memory state is reflected immediately.
			const myEmail = state.my_email
			if (myEmail) {
				for (const step of state.steps || []) {
					if (!stepParticipants[step.id]) stepParticipants[step.id] = {}
					const existing = stepParticipants[step.id][normalizeKey(myEmail)] || {}
					stepParticipants[step.id][normalizeKey(myEmail)] = {
						email: myEmail,
						role: state.my_role,
						status: normalizeProgressStatus(step.status),
						output_dir: step.output_dir || existing.output_dir || null,
					}
				}
			}

			// Keep participant completion states monotonic within a session so transient
			// sync lag does not regress chips (e.g. Shared -> Pending flicker).
			for (const [stepId, participantsByEmail] of Object.entries(stepParticipants)) {
				for (const [emailKey, record] of Object.entries(participantsByEmail || {})) {
					const participantEmail = record?.email || emailKey
					const normalizedStatus = normalizeProgressStatus(record?.status)
					const key = memoryKey(stepId, participantEmail)
					const cached = statusMemory.get(key)
					const mergedStatus =
						cached && progressStatusRank(cached.status) > progressStatusRank(normalizedStatus)
							? cached.status
							: normalizedStatus
					participantsByEmail[emailKey] = {
						...record,
						email: participantEmail,
						status: mergedStatus,
						output_dir: record?.output_dir || cached?.output_dir || null,
					}
					statusMemory.set(key, {
						status: mergedStatus,
						output_dir: participantsByEmail[emailKey].output_dir || null,
					})
				}
			}

			const getParticipantStepStatus = (stepId, email) => {
				const key = normalizeKey(email)
				const direct = stepParticipants[stepId]?.[key]
				if (direct) return direct
				const cached = statusMemory.get(memoryKey(stepId, email))
				if (!cached) return null
				return {
					email,
					role: null,
					status: cached.status,
					output_dir: cached.output_dir || null,
				}
			}

			const isParticipantDoneForStep = (step, email) => {
				const directStatus = getParticipantStepStatus(step.id, email)?.status
				if (isDoneForStep(step, directStatus)) return true
				if (!step.is_barrier) return false

				const deps = Array.isArray(step?.depends_on) ? step.depends_on : []
				if (deps.length === 0) return isDoneForStep(step, step.status)
				const depsDone = deps.every((depId) => {
					const depStep = stepById.get(depId)
					if (!depStep) return true
					const depStatus = getParticipantStepStatus(depId, email)?.status
					return isDoneForStep(depStep, depStatus)
				})
				if (depsDone) return true

				// Fallback for distributed lag: if a downstream dependent step already started for this participant,
				// treat this barrier as satisfied for chip/status purposes.
				const downstreamStarted = (state.steps || []).some((candidate) => {
					if (!Array.isArray(candidate?.depends_on) || !candidate.depends_on.includes(step.id)) {
						return false
					}
					if (Array.isArray(candidate?.target_emails) && !candidate.target_emails.includes(email)) {
						return false
					}
					const participantStatus = getParticipantStepStatus(candidate.id, email)?.status
					if (participantStatus) {
						return (
							participantStatus === 'Running' ||
							participantStatus === 'Completed' ||
							participantStatus === 'Shared' ||
							participantStatus === 'Failed'
						)
					}
					return false
				})
				return downstreamStarted
			}

			const getStepCompletion = (step) => {
				const requiredEmails = (step.target_emails || []).filter(Boolean)
				if (step.is_barrier) {
					const doneByParticipants =
						requiredEmails.length > 0
							? requiredEmails.every((email) => isParticipantDoneForStep(step, email))
							: false
					const done = doneByParticipants || isDoneForStep(step, step.status)
					return {
						requiredEmails,
						allDone: done,
						anyShared: step.status === 'Shared',
					}
				}
				if (requiredEmails.length === 0) {
					const done = isDoneForStep(step, step.status)
					return {
						requiredEmails,
						allDone: done,
						anyShared: step.status === 'Shared',
					}
				}
				const participantRecords = requiredEmails
					.map((email) => getParticipantStepStatus(step.id, email))
					.filter(Boolean)
				const allParticipantsDone = requiredEmails.every((email) => {
					const status = getParticipantStepStatus(step.id, email)?.status
					return isDoneForStep(step, status)
				})
				// For targeted collaborative steps, completion must come from participant records.
				// Local non-owner step.status can be stale and should not override participant truth.
				const allDone = allParticipantsDone
				return {
					requiredEmails,
					allDone,
					anyShared:
						step.status === 'Shared' || participantRecords.some((p) => p.status === 'Shared'),
				}
			}

			const getEffectiveStepStatus = (step, completion) => {
				if (step.status === 'Failed' || step.status === 'Running' || step.status === 'Sharing') {
					return step.status
				}
				if (completion.allDone) {
					return completion.anyShared ? 'Shared' : 'Completed'
				}
				return step.status
			}
			const stepById = new Map((state.steps || []).map((s) => [s.id, s]))
			const areDependenciesSatisfied = (step) => {
				const deps = Array.isArray(step?.depends_on) ? step.depends_on : []
				if (deps.length === 0) return true
				return deps.every((depId) => {
					const depStep = stepById.get(depId)
					if (!depStep) return true
					return getStepCompletion(depStep).allDone
				})
			}
			const isMyStepActionable = (step) => {
				if (!step?.my_action) return false
				const readyToShare =
					step.shares_output && step.status === 'Completed' && !step.outputs_shared
				const readyToRun =
					step.status === 'Ready' || (step.status === 'Pending' && areDependenciesSatisfied(step))
				if (!readyToRun && !readyToShare) return false
				return areDependenciesSatisfied(step)
			}

			// Find next actionable step for "Run Next" button
			const myNextStep = state.steps.find((s) => isMyStepActionable(s))
			const totalSteps = state.steps.length
			let completedSteps = state.steps.filter((step) => getStepCompletion(step).allDone).length
			let allComplete = completedSteps === totalSteps && totalSteps > 0

			if (!allComplete && state.thread_id) {
				const myAssignedDone = (state.steps || [])
					.filter((s) => s.my_action)
					.every((s) => {
						if (s.shares_output) return s.status === 'Shared' || s.outputs_shared
						return s.status === 'Completed' || s.status === 'Shared'
					})
				const finalShareStepId = [...(state.steps || [])].reverse().find((s) => s.shares_output)?.id
				if (myAssignedDone && finalShareStepId) {
					try {
						const threadMessages = await invoke('get_thread_messages', {
							threadId: state.thread_id,
						})
						const sawFinalShare = (threadMessages || []).some((msg) => {
							const metadataRaw = msg?.metadata
							if (!metadataRaw) return false
							let metadata = metadataRaw
							if (typeof metadataRaw === 'string') {
								try {
									metadata = JSON.parse(metadataRaw)
								} catch (_e) {
									return false
								}
							}
							return metadata?.flow_results?.step_id === finalShareStepId
						})
						if (sawFinalShare) {
							completedSteps = totalSteps
							allComplete = totalSteps > 0
						}
					} catch (_e) {
						// Ignore message-query errors; primary completion logic still applies.
					}
				}
			}

			const progressPercent = totalSteps > 0 ? Math.round((completedSteps / totalSteps) * 100) : 0
			updateMultipartyRunCardState(runId, allComplete)

			const waitingOnMeStep = (state.steps || []).find((s) => isMyStepActionable(s))
			const dependencyBlockersForStep = (step) => {
				const deps = Array.isArray(step?.depends_on) ? step.depends_on : []
				if (!deps.length) return []
				const blockers = []
				for (const depId of deps) {
					const depStep = stepById.get(depId)
					if (!depStep) continue
					const depCompletion = getStepCompletion(depStep)
					for (const email of depCompletion.requiredEmails || []) {
						const status = getParticipantStepStatus(depStep.id, email)?.status
						if (!isDoneForStep(depStep, status)) blockers.push(email)
					}
				}
				return [...new Set(blockers)]
			}
			const waitingOnOthers = waitingOnMeStep
				? dependencyBlockersForStep(waitingOnMeStep).filter((e) => e !== state.my_email)
				: (() => {
						const waitingParticipants = []
						for (const step of state.steps || []) {
							const completion = getStepCompletion(step)
							if (completion.allDone) continue
							for (const email of completion.requiredEmails || []) {
								const status = getParticipantStepStatus(step.id, email)?.status
								if (!isDoneForStep(step, status)) waitingParticipants.push(email)
							}
						}
						return [...new Set(waitingParticipants)].filter((e) => e !== state.my_email)
					})()
			waitingOnOthers.sort((a, b) => String(a).localeCompare(String(b)))
			const waitingOnMeLabel =
				waitingOnMeStep &&
				waitingOnMeStep.shares_output &&
				waitingOnMeStep.status === 'Completed' &&
				!waitingOnMeStep.outputs_shared
					? `share ${waitingOnMeStep.name}`
					: waitingOnMeStep?.name || 'next step'

			const waitingBannerHtml = waitingOnMeStep
				? `<div class="mp-waiting-banner is-you">⚠ Waiting on YOU: ${escapeHtml(waitingOnMeLabel)}${waitingOnOthers.length ? ` | Others waiting: ${waitingOnOthers.map((e) => `<span class="mp-waiting-chip">${escapeHtml(e)}</span>`).join(' ')}` : ''}</div>`
				: waitingOnOthers.length
					? `<div class="mp-waiting-banner">Waiting on: ${waitingOnOthers.map((e) => `<span class="mp-waiting-chip">${escapeHtml(e)}</span>`).join(' ')}</div>`
					: `<div class="mp-waiting-banner is-clear">No blockers</div>`

			// Progress bar and Run Next button
			const progressHtml = `
				<div class="mp-progress-section">
					<div class="mp-progress-bar">
						<div class="mp-progress-fill" style="width: ${progressPercent}%"></div>
					</div>
					<div class="mp-progress-text">${allComplete ? '✓ Done' : `${completedSteps}/${totalSteps} steps complete`}</div>
					${waitingBannerHtml}
					<div class="mp-progress-actions">
						<button type="button" class="mp-btn mp-collapse-btn" onclick="window.runsModule?.setAllStepsExpanded('${sessionId}', true)">Open All</button>
						<button type="button" class="mp-btn mp-collapse-btn" onclick="window.runsModule?.setAllStepsExpanded('${sessionId}', false)">Close All</button>
					</div>
					${
						myNextStep
							? `<button type="button" class="mp-btn mp-run-next-btn" onclick="window.runsModule?.runStep('${sessionId}', '${myNextStep.id}')">
						▶ Run Next: ${escapeHtml(myNextStep.name)}
					</button>`
							: ''
					}
				</div>
			`

			// Render participant chips showing ALL participants for each step
			// Shows checkbox status: ☑ = completed/shared, ☐ = not done yet, greyed = not involved
			const renderParticipantChips = (step, stepId, stepTargetEmails) => {
				const allParticipants = state.participants || []

				return `<div class="mp-step-participants">
						${allParticipants
							.map((p) => {
								// Check if this participant's email is in the step's target emails
								const isInvolved = stepTargetEmails.includes(p.email)
								if (!isInvolved) {
									// Greyed out - not involved in this step
									return `<span class="mp-participant-chip not-involved" title="${escapeHtml(p.email)} - Not involved">
									☐ ${escapeHtml(p.email)}
								</span>`
								}

								// Check if this participant has completed/shared this step
								const completed = getParticipantStepStatus(stepId, p.email)
								const isComplete = isParticipantDoneForStep(step, p.email)
								const isShared = completed?.status === 'Shared'
								const isReadyToShare = step.shares_output && completed?.status === 'Completed'

								const checkbox = isComplete ? '☑' : '☐'
								const statusClass = isComplete
									? isShared
										? 'shared'
										: 'completed'
									: isReadyToShare
										? 'ready-share'
										: 'pending'
								const statusText = isShared
									? 'Shared'
									: isComplete
										? 'Completed'
										: isReadyToShare
											? 'Ready to share'
											: 'Pending'

								return `<span class="mp-participant-chip ${statusClass}" title="${escapeHtml(p.email)} - ${statusText}">
								${checkbox} ${escapeHtml(p.email)}
							</span>`
							})
							.join('')}
					</div>`
			}

			const renderStepContributions = (step, completion) => {
				const rows = completion.requiredEmails
					.map((email) => {
						const record = getParticipantStepStatus(step.id, email)
						const sharedEnough = step.shares_output
							? record?.status === 'Shared'
							: record && (record.status === 'Completed' || record.status === 'Shared')
						if (!record || !sharedEnough || !record.output_dir) return ''
						const escapedPath = String(record.output_dir)
							.replace(/\\/g, '\\\\')
							.replace(/'/g, "\\'")
						return `<div class="mp-step-contrib-row">
							<span class="mp-step-contrib-label">${escapeHtml(record.email)} (${escapeHtml(record.status)})</span>
							<button type="button" class="mp-btn mp-preview-btn mp-contrib-open-btn" onclick="window.runsModule?.openFolderPath('${escapedPath}')">📁 Show in Finder</button>
						</div>`
					})
					.filter(Boolean)
					.join('')
				if (!rows) return ''
				return `<div class="mp-step-contribs">${rows}</div>`
			}

			const stepsHtml = state.steps
				.map((step) => {
					const completion = getStepCompletion(step)
					const effectiveStatus = getEffectiveStepStatus(step, completion)
					updateStepTimer(sessionId, step.id, effectiveStatus)
					const stepTimerLabel = getStepTimerLabel(sessionId, step.id)
					const statusClass = `mp-step-${effectiveStatus.toLowerCase()}`
					let statusIcon = getStepStatusIcon(effectiveStatus)
					const isMyAction = step.my_action
					const isNextStep = myNextStep && step.id === myNextStep.id
					if (
						isMyAction &&
						step.shares_output &&
						effectiveStatus === 'Completed' &&
						!step.outputs_shared
					) {
						statusIcon = '📤'
					}
					const stepExpandedState = getNestedState(multipartyStepExpanded, sessionId)
					const codeExpandedState = getNestedState(multipartyCodeExpanded, sessionId)
					const logExpandedState = getNestedState(multipartyLogExpanded, sessionId)
					const defaultExpanded =
						!!isNextStep || effectiveStatus === 'Running' || effectiveStatus === 'Failed'
					const isExpanded = stepExpandedState.has(step.id)
						? stepExpandedState.get(step.id)
						: defaultExpanded
					const defaultLogExpanded = effectiveStatus === 'Running' || effectiveStatus === 'Failed'
					const isLogExpanded = logExpandedState.has(step.id)
						? logExpandedState.get(step.id) === true
						: defaultLogExpanded
					const isCompleted = effectiveStatus === 'Completed' || effectiveStatus === 'Shared'
					const dependenciesSatisfied = areDependenciesSatisfied(step)

					// Only show auto toggle for pending/ready steps that are mine
					const showAutoToggle = isMyAction && !isCompleted

					return `
						<div class="mp-step ${statusClass} ${isMyAction ? 'my-action' : 'other-action'} ${isNextStep ? 'next-step' : ''} ${isExpanded ? 'expanded' : 'collapsed'}" data-step-id="${escapeHtml(step.id)}">
							<button type="button" class="mp-step-header mp-step-toggle" onclick="window.runsModule?.toggleStepExpanded('${sessionId}', '${escapeHtml(step.id)}')">
								<span class="mp-step-chevron">${isExpanded ? '▾' : '▸'}</span>
								<span class="mp-step-status">${statusIcon}</span>
								<span class="mp-step-name">${escapeHtml(step.name)}</span>
								<span class="mp-step-timer" data-session-id="${escapeHtml(sessionId)}" data-step-id="${escapeHtml(step.id)}">${stepTimerLabel ? `⏱ ${escapeHtml(stepTimerLabel)}` : ''}</span>
								${isMyAction ? '<span class="mp-step-badge">Your step</span>' : ''}
								${isNextStep ? '<span class="mp-step-badge mp-next-badge">Next</span>' : ''}
							</button>
								<div class="mp-step-body">
									${renderParticipantChips(step, step.id, step.target_emails || [])}
									${renderStepConnectivity(step, sessionId, diagnosticsByStepId.get(step.id))}
									<div class="mp-step-desc">${escapeHtml(step.description)}</div>
								${
									step.code_preview
										? `<details class="mp-step-code" ${codeExpandedState.get(step.id) ? 'open' : ''} ontoggle="window.runsModule?.rememberCodeToggle('${sessionId}','${escapeHtml(step.id)}', this.open)">
								<summary>Show code</summary>
								<pre class="mp-code-block">${escapeHtml(step.code_preview)}</pre>
							</details>`
										: ''
								}
								<details class="mp-step-logs" data-step-id="${escapeHtml(step.id)}" ${isLogExpanded ? 'open' : ''} ontoggle="window.runsModule?.toggleStepLogs(this, '${sessionId}', '${escapeHtml(step.id)}', this.open)">
									<summary>
										<span>Show logs</span>
										<button type="button" class="mp-log-copy-btn" onclick="window.runsModule?.copyStepLogs(event, this, '${sessionId}', '${escapeHtml(step.id)}')">Copy logs</button>
									</summary>
									<pre class="mp-step-log-block">Loading logs...</pre>
								</details>
								<div class="mp-step-controls">
								${
									showAutoToggle
										? `<label class="mp-auto-toggle" title="Auto-run when ready">
									<input type="checkbox"
										${step.auto_run ? 'checked' : ''}
										data-session="${escapeHtml(sessionId)}"
										data-step="${escapeHtml(step.id)}"
										onchange="window.runsModule?.toggleStepAutoRun(this)"
									/>
									<span>Auto</span>
									</label>`
										: ''
								}
									${renderStepActions(step, sessionId, isMyAction, effectiveStatus, dependenciesSatisfied)}
									</div>
								${renderStepContributions(step, completion)}
							</div>
						</div>
					`
				})
				.join('')

			// Build tabbed interface with Steps and Activity Log
			const tabsHtml = `
				<div class="mp-tabs-container" data-session="${escapeHtml(sessionId)}">
					<div class="mp-tabs-header">
						<button type="button" class="mp-tab ${activeTab === 'steps' ? 'active' : ''}" data-tab="steps" onclick="window.runsModule?.switchTab(this, 'steps')">Steps</button>
						<button type="button" class="mp-tab ${activeTab === 'logs' ? 'active' : ''}" data-tab="logs" onclick="window.runsModule?.switchTab(this, 'logs')">Activity Log</button>
					</div>
					<div class="mp-tab-content mp-tab-steps ${activeTab === 'steps' ? 'active' : ''}" data-tab-content="steps">
						${stepsHtml}
					</div>
					<div class="mp-tab-content mp-tab-logs ${activeTab === 'logs' ? 'active' : ''}" data-tab-content="logs">
						<div class="mp-logs-content" data-session="${escapeHtml(sessionId)}">
							<div class="mp-logs-loading">Loading logs...</div>
						</div>
					</div>
				</div>
			`

			const nextHtml = progressHtml + tabsHtml
			const renderSnapshot = {
				activeTab,
				progressPercent,
				completedSteps,
				totalSteps,
				allComplete,
				waitingOnMeStepId: waitingOnMeStep?.id || '',
				waitingOnOthers: waitingOnOthers.slice().sort(),
				diagnostics: Array.from(diagnosticsByStepId.values())
					.map((diag) => ({
						stepId: diag.step_id,
						channels: (diag.channels || []).map((channel) => ({
							id: channel.channel_id,
							status: channel.status,
							listener: channel.listener_up === true ? 1 : channel.listener_up === false ? -1 : 0,
						})),
						peers: (diag.peers || [])
							.map((peer) => ({
								email: peer.email,
								status: peer.status,
								mode: peer.mode_short || peer.mode || '',
							}))
							.sort((a, b) => String(a.email).localeCompare(String(b.email))),
					}))
					.sort((a, b) => String(a.stepId).localeCompare(String(b.stepId))),
				steps: (state.steps || []).map((step) => {
					const completion = getStepCompletion(step)
					const effectiveStatus = getEffectiveStepStatus(step, completion)
					const participants = (step.target_emails || [])
						.map((email) => ({
							email,
							status: getParticipantStepStatus(step.id, email)?.status || '',
						}))
						.sort((a, b) => a.email.localeCompare(b.email))
					return {
						id: step.id,
						effectiveStatus,
						autoRun: !!step.auto_run,
						myAction: !!step.my_action,
						outputsShared: !!step.outputs_shared,
						participants,
					}
				}),
			}
			const renderKey = JSON.stringify(renderSnapshot)
			const previousRenderKey = multipartyRenderKeys.get(sessionId)
			const hasRenderedTabs = !!stepsContainer.querySelector('.mp-tabs-container')
			const shouldRerender = !hasRenderedTabs || previousRenderKey !== renderKey

			if (shouldRerender) {
				stopAllStepLogPolling(sessionId)
				stepsContainer.innerHTML = nextHtml
				stepsContainer.scrollTop = previousScrollTop
				multipartyRenderedHtml.set(sessionId, nextHtml)
				multipartyRenderKeys.set(sessionId, renderKey)

				stepsContainer.querySelectorAll('.mp-step-logs[open]').forEach((detailsEl) => {
					const stepId = detailsEl.dataset.stepId
					if (stepId) {
						window.runsModule?.toggleStepLogs(detailsEl, sessionId, stepId, true)
					}
				})
			}
			stepsContainer.querySelector('.mp-steps-transient-error')?.remove()
			refreshStepTimerNodes(sessionId)

			// Load logs asynchronously
			loadParticipantLogs(sessionId)
		} catch (error) {
			console.error('Failed to load multiparty steps:', error)
			const hasRenderedSteps = !!stepsContainer.querySelector('.mp-tabs-container')
			if (!hasRenderedSteps) {
				multipartyRenderedHtml.delete(sessionId)
				multipartyRenderKeys.delete(sessionId)
				stepsContainer.innerHTML = `<div class="mp-error">Failed to load steps: ${escapeHtml(String(error))}</div>`
				return
			}
			// Keep last good render and surface a non-blocking warning.
			const existing = stepsContainer.querySelector('.mp-steps-transient-error')
			const message = `Temporary refresh issue: ${escapeHtml(String(error))}`
			if (existing) {
				existing.innerHTML = message
			} else {
				const banner = document.createElement('div')
				banner.className = 'mp-steps-transient-error'
				banner.innerHTML = message
				banner.style.cssText =
					'margin: 8px 0 12px; padding: 8px 10px; border: 1px solid #fecaca; background: #fef2f2; color: #991b1b; border-radius: 8px; font-size: 12px;'
				stepsContainer.prepend(banner)
			}
		}
	}

	// Load and display participant logs
	async function loadParticipantLogs(sessionId) {
		const logsContainer = document.querySelector(`.mp-logs-content[data-session="${sessionId}"]`)
		if (!logsContainer) return

		try {
			const logs = await invoke('get_participant_logs', { sessionId })
			if (!logs || logs.length === 0) {
				logsContainer.innerHTML = '<div class="mp-no-logs">No activity yet</div>'
				return
			}
			const sortedLogs = [...logs].sort(
				(a, b) => new Date(b.timestamp || 0).getTime() - new Date(a.timestamp || 0).getTime(),
			)

			const logsHtml = sortedLogs
				.map((log) => {
					const time = log.timestamp ? new Date(log.timestamp).toLocaleTimeString() : ''
					const participant = log.participant || log.role
					const rawStepId = log.step_id == null ? '' : String(log.step_id).trim()
					const normalizedStepId =
						rawStepId && rawStepId !== 'null' && rawStepId !== 'undefined' ? rawStepId : ''
					const stepLabel = normalizedStepId ? `"${normalizedStepId}"` : 'a step'
					const eventText =
						log.event === 'joined'
							? `${participant} joined the flow`
							: log.event === 'step_completed'
								? `${participant} completed ${stepLabel}`
								: log.event === 'step_shared'
									? `${participant} shared outputs from ${stepLabel}`
									: log.event === 'step_started'
										? `${participant} started ${stepLabel}`
										: log.event === 'barrier_completed'
											? `${participant} completed barrier ${stepLabel}`
											: `${participant}: ${log.event}`
					return `<div class="mp-log-entry">
						<span class="mp-log-time">${time}</span>
						<span class="mp-log-event">${escapeHtml(eventText)}</span>
					</div>`
				})
				.join('')

			logsContainer.innerHTML = logsHtml
		} catch (error) {
			logsContainer.innerHTML = `<div class="mp-error">Failed to load logs</div>`
		}
	}

	function getStepStatusIcon(status) {
		const icons = {
			Pending: '⏳',
			WaitingForInputs: '📥',
			Ready: '✅',
			Running: '🔄',
			Completed: '✓',
			Sharing: '📤',
			Shared: '📨',
			Failed: '❌',
		}
		return icons[status] || '❓'
	}

	function renderStepActions(
		step,
		sessionId,
		isMyAction,
		effectiveStatus = step.status,
		dependenciesSatisfied = true,
	) {
		if (!isMyAction) {
			if (effectiveStatus === 'Shared') {
				return '<span class="mp-shared">📨 Shared</span>'
			}
			if (effectiveStatus === 'Completed') {
				if (step.shares_output) {
					return '<span class="mp-pending">⏳ Ready to share</span>'
				}
				return '<span class="mp-done">✓ Done</span>'
			}
			return '<span class="mp-waiting">Waiting for participant</span>'
		}

		const actions = []
		if (step.module_path) {
			actions.push(
				`<button type="button" class="mp-btn mp-module-btn" onclick="window.runsModule?.viewStepModule('${step.module_path.replace(/'/g, "\\'")}')">📦 View Module</button>`,
			)
		}
		if ((effectiveStatus === 'Ready' || effectiveStatus === 'Pending') && dependenciesSatisfied) {
			actions.push(
				`<button type="button" class="mp-btn mp-run-btn" onclick="window.runsModule?.runStep('${sessionId}', '${step.id}')">▶ Run</button>`,
			)
		}
		if ((effectiveStatus === 'Ready' || effectiveStatus === 'Pending') && !dependenciesSatisfied) {
			actions.push('<span class="mp-pending">⏳ Waiting for dependencies</span>')
		}
		if (effectiveStatus === 'Running') {
			actions.push('<span class="mp-running">Running...</span>')
		}
		if (effectiveStatus === 'Completed' && step.shares_output && !step.outputs_shared) {
			actions.push(
				`<button type="button" class="mp-btn mp-preview-btn" onclick="window.runsModule?.previewStepOutputs('${sessionId}', '${step.id}')">📁 Show in Finder</button>`,
			)
			actions.push(
				`<button type="button" class="mp-btn mp-share-btn" onclick="window.runsModule?.shareStepOutputs('${sessionId}', '${step.id}')">📤 Share</button>`,
			)
		}
		if (step.shares_output && step.outputs_shared && effectiveStatus !== 'Shared') {
			actions.push(
				`<button type="button" class="mp-btn mp-preview-btn" onclick="window.runsModule?.previewStepOutputs('${sessionId}', '${step.id}')">📁 Show in Finder</button>`,
			)
			actions.push('<span class="mp-shared">📨 Shared</span>')
			actions.push(
				`<button type="button" class="mp-btn mp-chat-share-btn" onclick="window.runsModule?.shareStepOutputsToChat('${sessionId}', '${step.id}')">💬 Share to Chat</button>`,
			)
		}
		if (effectiveStatus === 'Completed' && !step.shares_output) {
			actions.push('<span class="mp-done">✓ Done</span>')
		}
		if (effectiveStatus === 'Shared') {
			// Preview should remain available after sharing
			actions.push(
				`<button type="button" class="mp-btn mp-preview-btn" onclick="window.runsModule?.previewStepOutputs('${sessionId}', '${step.id}')">📁 Show in Finder</button>`,
			)
			actions.push('<span class="mp-shared">📨 Shared</span>')
			actions.push(
				`<button type="button" class="mp-btn mp-chat-share-btn" onclick="window.runsModule?.shareStepOutputsToChat('${sessionId}', '${step.id}')">💬 Share to Chat</button>`,
			)
		}
		if (effectiveStatus === 'Failed') {
			actions.push(
				`<button type="button" class="mp-btn mp-retry-btn" onclick="window.runsModule?.runStep('${sessionId}', '${step.id}')">🔄 Retry</button>`,
			)
		}
		if (step.status === 'WaitingForInputs') {
			actions.push('<span class="mp-waiting">Waiting for inputs...</span>')
		}
		if (!actions.length) {
			if (effectiveStatus === 'Shared') return '<span class="mp-shared">📨 Shared</span>'
			if (effectiveStatus === 'Completed') {
				if (step.shares_output) return '<span class="mp-pending">⏳ Ready to share</span>'
				return '<span class="mp-done">✓ Done</span>'
			}
		}

		return actions.join('')
	}

	function escapeHtml(text) {
		if (!text) return ''
		const div = document.createElement('div')
		div.textContent = text
		return div.innerHTML
	}

	function formatByteCount(bytes) {
		const value = Number(bytes || 0)
		if (!Number.isFinite(value) || value <= 0) return '0 B'
		const units = ['B', 'KB', 'MB', 'GB', 'TB']
		let unitIndex = 0
		let scaled = value
		while (scaled >= 1024 && unitIndex < units.length - 1) {
			scaled /= 1024
			unitIndex += 1
		}
		const digits = scaled >= 100 || unitIndex === 0 ? 0 : 1
		return `${scaled.toFixed(digits)} ${units[unitIndex]}`
	}

	function formatRate(bytesPerSec) {
		const value = Number(bytesPerSec || 0)
		if (!Number.isFinite(value) || value <= 0) return '0 B/s'
		return `${formatByteCount(value)}/s`
	}

	function shortIdentity(value) {
		const text = String(value || '')
		if (!text) return 'unknown'
		return text.split('@')[0] || text
	}

	function getDiagnosticsSampleKey(sessionId, stepId) {
		return `${sessionId}::${stepId}::diag`
	}

	function getPeerRateMap(sessionId, stepId, peers) {
		const key = getDiagnosticsSampleKey(sessionId, stepId)
		const previous = multipartyDiagnosticsSamples.get(key) || {}
		const next = {}
		const rateMap = {}
		const nowMs = Date.now()

		for (const peer of peers || []) {
			const email = String(peer?.email || '')
			if (!email) continue
			const txBytes = Number(peer?.tx_bytes || 0)
			const rxBytes = Number(peer?.rx_bytes || 0)
			const updatedMsRaw = Number(peer?.updated_ms || 0)
			const updatedMs = Number.isFinite(updatedMsRaw) && updatedMsRaw > 0 ? updatedMsRaw : nowMs
			let txRate = 0
			let rxRate = 0
			const prev = previous[email]
			if (prev) {
				const deltaMs = Math.max(1, updatedMs - Number(prev.updatedMs || prev.seenMs || 0))
				txRate = (Math.max(0, txBytes - Number(prev.txBytes || 0)) * 1000) / deltaMs
				rxRate = (Math.max(0, rxBytes - Number(prev.rxBytes || 0)) * 1000) / deltaMs
			}
			next[email] = {
				txBytes,
				rxBytes,
				updatedMs,
				seenMs: nowMs,
			}
			rateMap[email] = { txRate, rxRate }
		}

		multipartyDiagnosticsSamples.set(key, next)
		return rateMap
	}

	function renderStepConnectivity(step, sessionId, diagnostics) {
		if (!diagnostics) return ''
		const channels = Array.isArray(diagnostics.channels) ? diagnostics.channels : []
		const peers = Array.isArray(diagnostics.peers) ? diagnostics.peers : []
		if (!channels.length && !peers.length) return ''

		const peerRates = getPeerRateMap(sessionId, step.id, peers)
		const anyConnected = channels.some((channel) => channel?.status === 'connected')
		const anyEstablishing = channels.some((channel) => channel?.status === 'establishing')
		const liveLabel = anyConnected ? 'Connected' : anyEstablishing ? 'Establishing' : 'Waiting'
		const liveClass = anyConnected ? 'connected' : anyEstablishing ? 'establishing' : 'waiting'

		const linksHtml = channels
			.map((channel) => {
				const status = String(channel?.status || 'waiting')
				const fromLabel = shortIdentity(channel?.from_email || '')
				const toLabel = shortIdentity(channel?.to_email || '')
				const portLabel = channel?.port ? `port ${channel.port}` : 'port pending'
				const listenerLabel =
					channel?.listener_up === true
						? 'listener up'
						: channel?.listener_up === false
							? 'listener down'
							: 'listener pending'
				return `<div class="mp-link-row is-${escapeHtml(status)}">
					<span class="mp-net-dot"></span>
					<span class="mp-link-end">${escapeHtml(fromLabel)}</span>
					<span class="mp-link-arrow">→</span>
					<span class="mp-link-end">${escapeHtml(toLabel)}</span>
					<span class="mp-link-meta">${escapeHtml(portLabel)} · ${escapeHtml(listenerLabel)} · req ${escapeHtml(String(channel?.requests || 0))} / res ${escapeHtml(String(channel?.responses || 0))}</span>
				</div>`
			})
			.join('')

		const peersHtml = peers
			.map((peer) => {
				const email = String(peer?.email || '')
				const status = String(peer?.status || 'pending')
				const rates = peerRates[email] || { txRate: 0, rxRate: 0 }
				const mode = String(peer?.mode_short || peer?.mode || 'unknown')
				const txAvg = Number(peer?.tx_avg_send_ms || 0)
				const rxAvg = Number(peer?.rx_avg_write_ms || 0)
				const latencyParts = []
				if (txAvg > 0) latencyParts.push(`TX ${txAvg.toFixed(1)}ms`)
				if (rxAvg > 0) latencyParts.push(`RX ${rxAvg.toFixed(1)}ms`)
				const latencyLabel = latencyParts.length ? latencyParts.join(' · ') : 'Latency n/a'
				const ageMs = Number(peer?.age_ms || 0)
				const freshness =
					status === 'connected'
						? 'live'
						: status === 'stale'
							? `${Math.round(ageMs / 1000)}s old`
							: 'pending'
				return `<div class="mp-peer-card is-${escapeHtml(status)}">
					<div class="mp-peer-head">
						<span class="mp-net-dot"></span>
						<span class="mp-peer-name">${escapeHtml(shortIdentity(email))}</span>
						<span class="mp-peer-mode">${escapeHtml(mode)}</span>
					</div>
					<div class="mp-peer-metric-row">
						<span>TX ${escapeHtml(formatRate(rates.txRate))}</span>
						<span>RX ${escapeHtml(formatRate(rates.rxRate))}</span>
					</div>
					<div class="mp-peer-metric-row subtle">
						<span>${escapeHtml(latencyLabel)}</span>
						<span>${escapeHtml(freshness)}</span>
					</div>
					<div class="mp-peer-metric-row subtle">
						<span>Total TX ${escapeHtml(formatByteCount(peer?.tx_bytes || 0))}</span>
						<span>Total RX ${escapeHtml(formatByteCount(peer?.rx_bytes || 0))}</span>
					</div>
				</div>`
			})
			.join('')

		return `<div class="mp-net-panel">
			<div class="mp-net-header">
				<span class="mp-net-title">Transport connectivity</span>
				<span class="mp-net-live is-${escapeHtml(liveClass)}">${escapeHtml(liveLabel)}</span>
			</div>
			${linksHtml ? `<div class="mp-net-links">${linksHtml}</div>` : ''}
			${peersHtml ? `<div class="mp-peer-grid">${peersHtml}</div>` : ''}
		</div>`
	}

	// Expose multiparty step controls to window
	window.runsModule = window.runsModule || {}
	window.runsModule.toggleStepAutoRun = async function (checkbox) {
		const sessionId = checkbox.dataset.session
		const stepId = checkbox.dataset.step
		try {
			await invoke('set_step_auto_run', { sessionId, stepId, autoRun: checkbox.checked })
		} catch (error) {
			console.error('Failed to toggle auto-run:', error)
			checkbox.checked = !checkbox.checked
		}
	}
	window.runsModule.toggleStepExpanded = function (sessionId, stepId) {
		const expandedState = getNestedState(multipartyStepExpanded, sessionId)
		const current = expandedState.get(stepId) ?? false
		expandedState.set(stepId, !current)
		const runCard = document
			.querySelector(`[data-session-id="${sessionId}"]`)
			?.closest('.flow-run-card')
		if (runCard) {
			const runId = runCard.dataset.runId
			loadMultipartySteps(sessionId, runId).catch(() => {})
		}
	}
	window.runsModule.setAllStepsExpanded = function (sessionId, expand) {
		const runCard = document
			.querySelector(`[data-session-id="${sessionId}"]`)
			?.closest('.flow-run-card')
		if (!runCard) return
		const runId = runCard.dataset.runId
		const steps = runCard.querySelectorAll('.mp-step[data-step-id]')
		const expandedState = getNestedState(multipartyStepExpanded, sessionId)
		steps.forEach((el) => {
			const stepId = el.getAttribute('data-step-id')
			if (stepId) expandedState.set(stepId, !!expand)
		})
		loadMultipartySteps(sessionId, runId).catch(() => {})
	}
	window.runsModule.rememberCodeToggle = function (sessionId, stepId, isOpen) {
		const codeState = getNestedState(multipartyCodeExpanded, sessionId)
		codeState.set(stepId, !!isOpen)
	}
	window.runsModule.toggleStepLogs = function (detailsEl, sessionId, stepId, isOpen) {
		const logState = getNestedState(multipartyLogExpanded, sessionId)
		logState.set(stepId, !!isOpen)
		stopStepLogPolling(sessionId, stepId)
		if (!isOpen) return

		const preEl = detailsEl?.querySelector('.mp-step-log-block')
		if (!preEl) return
		const cacheKey = getStepLogKey(sessionId, stepId)

		const refreshLogs = async () => {
			try {
				const text = await invoke('get_multiparty_step_logs', {
					sessionId,
					stepId,
					lines: 240,
				})
				const rendered = String(text || '').trim() || 'No step-specific logs yet.'
				const previous = multipartyStepLogCache.get(cacheKey)
				if (previous === rendered) return
				const wasAtBottom = preEl.scrollHeight - preEl.scrollTop - preEl.clientHeight < 24
				const previousScrollTop = preEl.scrollTop
				preEl.textContent = rendered
				multipartyStepLogCache.set(cacheKey, rendered)
				if (wasAtBottom) {
					preEl.scrollTop = preEl.scrollHeight
				} else {
					const maxScrollTop = Math.max(0, preEl.scrollHeight - preEl.clientHeight)
					preEl.scrollTop = Math.min(previousScrollTop, maxScrollTop)
				}
			} catch (error) {
				const renderedError = `Failed to load logs: ${error}`
				if (multipartyStepLogCache.get(cacheKey) !== renderedError) {
					preEl.textContent = renderedError
					multipartyStepLogCache.set(cacheKey, renderedError)
				}
			}
		}

		refreshLogs()
		const interval = setInterval(refreshLogs, 2000)
		multipartyStepLogIntervals.set(getStepLogKey(sessionId, stepId), interval)
	}
	window.runsModule.copyStepLogs = async function (event, buttonEl, sessionId, stepId) {
		try {
			event?.preventDefault?.()
			event?.stopPropagation?.()
			const cacheKey = getStepLogKey(sessionId, stepId)
			let text = String(multipartyStepLogCache.get(cacheKey) || '').trim()
			if (!text) {
				const fetched = await invoke('get_multiparty_step_logs', {
					sessionId,
					stepId,
					lines: 240,
				})
				text = String(fetched || '').trim()
				if (text) multipartyStepLogCache.set(cacheKey, text)
			}
			if (!text) text = 'No step-specific logs yet.'
			await navigator.clipboard.writeText(text)
			if (buttonEl) {
				const original = buttonEl.textContent
				buttonEl.textContent = 'Copied'
				setTimeout(() => {
					buttonEl.textContent = original || 'Copy logs'
				}, 1200)
			}
		} catch (error) {
			console.error('Failed to copy step logs:', error)
			if (buttonEl) {
				const original = buttonEl.textContent
				buttonEl.textContent = 'Copy failed'
				setTimeout(() => {
					buttonEl.textContent = original || 'Copy logs'
				}, 1600)
			}
		}
	}
	window.runsModule.runStep = async function (sessionId, stepId) {
		const executeStep = async () => {
			await invoke('run_flow_step', { sessionId, stepId })
			// Refresh the steps display
			const runCard = document
				.querySelector(`[data-session-id="${sessionId}"]`)
				?.closest('.flow-run-card')
			if (runCard) {
				const runId = runCard.dataset.runId
				await loadMultipartySteps(sessionId, runId)
			}
		}

		try {
			let dockerRunning = true
			try {
				dockerRunning = await invoke('check_docker_running')
			} catch (checkError) {
				console.warn('Docker check failed before multiparty step run:', checkError)
				dockerRunning = false
			}

			if (dockerRunning) {
				await executeStep()
			} else {
				await showDockerWarningModal(executeStep)
			}
		} catch (error) {
			console.error('Failed to run step:', error)
			alert(`Failed to run step: ${error}`)
		}
	}
	window.runsModule.previewStepOutputs = async function (sessionId, stepId) {
		try {
			const files = await invoke('get_step_output_files', { sessionId, stepId })
			if (files && files.length > 0) {
				// Get the folder path from the first file
				const firstFile = files[0]
				const folderPath = firstFile.substring(0, firstFile.lastIndexOf('/'))
				// Open the folder in OS file manager
				await invoke('open_folder', { path: folderPath })
			} else {
				alert('No output files found')
			}
		} catch (error) {
			console.error('Failed to preview outputs:', error)
			alert(`Failed to open folder: ${error}`)
		}
	}
	window.runsModule.shareStepOutputs = async function (sessionId, stepId) {
		try {
			await invoke('share_step_outputs', { sessionId, stepId })
			const runCard = document
				.querySelector(`[data-session-id="${sessionId}"]`)
				?.closest('.flow-run-card')
			if (runCard) {
				const runId = runCard.dataset.runId
				await loadMultipartySteps(sessionId, runId)
			}
		} catch (error) {
			console.error('Failed to share outputs:', error)
			alert(`Failed to share: ${error}`)
		}
	}
	window.runsModule.shareStepOutputsToChat = async function (sessionId, stepId) {
		try {
			const result = await invoke('share_step_outputs_to_chat', { sessionId, stepId })
			alert(
				`Results shared to chat! ${result.files_shared} file(s) sent to ${result.recipients.length} participant(s).`,
			)
			const runCard = document
				.querySelector(`[data-session-id="${sessionId}"]`)
				?.closest('.flow-run-card')
			if (runCard) {
				const runId = runCard.dataset.runId
				await loadMultipartySteps(sessionId, runId)
			}
		} catch (error) {
			console.error('Failed to share outputs to chat:', error)
			alert(`Failed to share to chat: ${error}`)
		}
	}
	window.runsModule.viewStepModule = async function (modulePath) {
		if (!modulePath) return
		try {
			await invoke('open_folder', { path: modulePath })
		} catch (error) {
			console.error('Failed to open module path:', error)
			alert(`Failed to open module path: ${error}`)
		}
	}
	window.runsModule.openFolderPath = async function (folderPath) {
		if (!folderPath) return
		try {
			await invoke('open_folder', { path: folderPath })
		} catch (error) {
			console.error('Failed to open folder path:', error)
			alert(`Failed to open folder: ${error}`)
		}
	}
	window.runsModule.switchTab = function (tabButton, tabName) {
		const container = tabButton.closest('.mp-tabs-container')
		if (!container) return
		const sessionId = container.dataset.session
		if (sessionId) {
			multipartyActiveTabs.set(sessionId, tabName)
		}

		// Update tab buttons
		container.querySelectorAll('.mp-tab').forEach((tab) => tab.classList.remove('active'))
		tabButton.classList.add('active')

		// Update tab content
		container
			.querySelectorAll('.mp-tab-content')
			.forEach((content) => content.classList.remove('active'))
		const targetContent = container.querySelector(`[data-tab-content="${tabName}"]`)
		if (targetContent) {
			targetContent.classList.add('active')
		}

		if (tabName === 'logs' && sessionId) {
			loadParticipantLogs(sessionId).catch(() => {})
		}
	}

	async function loadRuns() {
		try {
			await invoke('reconcile_flow_runs').catch((error) => {
				console.warn('Failed to reconcile flow runs:', error)
			})
			flowLogIntervals.forEach((_, runId) => stopFlowLogPolling(runId))
			flowTimerIntervals.forEach((_, runId) => stopRunTimer(runId))
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
			const nextRunsRenderKey = JSON.stringify(
				(flowRuns || []).map((run) => ({
					id: run.id,
					status: run.status,
					flow_id: run.flow_id,
					created_at: run.created_at,
					results_dir: run.results_dir || null,
					work_dir: run.work_dir || null,
					metadata: run.metadata || null,
				})),
			)
			if (
				!autoExpandRunId &&
				container?.children?.length > 0 &&
				runsRenderKey === nextRunsRenderKey
			) {
				return
			}
			runsRenderKey = nextRunsRenderKey

			if (flowRuns.length === 0) {
				runsRenderKey = ''
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
				const titleParts = []

				// Add multiparty indicator if applicable
				if (runMetadata.type === 'multiparty') {
					titleParts.push('👥')
				}

				titleParts.push(flowName)

				// Add role for multiparty runs
				if (runMetadata.type === 'multiparty' && runMetadata.my_role) {
					titleParts.push(`(${runMetadata.my_role})`)
				}

				if (dataSelection.dataset_name) titleParts.push(dataSelection.dataset_name)
				if (Array.isArray(dataSelection.asset_keys) && dataSelection.asset_keys.length > 0) {
					titleParts.push(dataSelection.asset_keys.join(', '))
				}
				if (dataSelection.data_type) {
					const typeLabel = dataSelection.data_type === 'private' ? 'real' : dataSelection.data_type
					titleParts.push(typeLabel)
				}
				const runTitle = titleParts.join(' ')
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

				const timeAgo = getTimeAgo(new Date(parseUTCTimestamp(run.created_at)))
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
						<div class="run-subtitle" style="font-size: 13px; color: #64748b; display: flex; align-items: center; gap: 8px; flex-wrap: wrap;">
							<span>Run #${run.id}</span>
							<span style="color: #cbd5e1;">•</span>
							<span>${timeAgo}</span>
							<span style="color: #cbd5e1;">•</span>
							${(() => {
								const startMs = parseUTCTimestamp(run.created_at)
								if (run.status === 'running') {
									return `<span class="run-timer" data-run-id="${run.id}" style="font-variant-numeric: tabular-nums; color: #2563eb; font-weight: 600;">${formatElapsed(Date.now() - startMs)}</span>`
								}
								const endMs = run.completed_at ? parseUTCTimestamp(run.completed_at) : Date.now()
								const dur = formatElapsed(endMs - startMs)
								const durColor =
									run.status === 'success'
										? '#059669'
										: run.status === 'failed'
											? '#dc2626'
											: '#64748b'
								return `<span class="run-timer" data-run-id="${run.id}" style="font-variant-numeric: tabular-nums; color: ${durColor}; font-weight: 600;">${dur}</span>`
							})()}
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
						<div class="flow-progress flow-progress-inline" data-run-id="${run.id}" data-start-ms="${parseUTCTimestamp(
							run.created_at,
						)}" style="margin-top: 8px; display: ${
							run.status === 'running' || run.status === 'paused' || run.status === 'failed'
								? 'flex'
								: 'none'
						}; align-items: center; gap: 10px;">
							<div class="flow-progress-label" style="font-size: 11px; font-weight: 600; color: #64748b;">Progress unavailable</div>
							<div style="flex: 1; background: #e2e8f0; border-radius: 999px; height: 6px; overflow: hidden;">
								<div class="flow-progress-fill" style="height: 100%; width: 0%; background: linear-gradient(90deg, #38bdf8, #22c55e); transition: width 0.3s ease;"></div>
							</div>
							<div class="flow-progress-count" style="font-size: 11px; color: #94a3b8;">--</div>
							<div class="flow-progress-eta" style="font-size: 11px; color: #94a3b8;"></div>
							<div class="flow-container-count" style="font-size: 11px; color: #94a3b8; display: flex; align-items: center; gap: 3px;" title="Running containers">
								<span style="font-size: 13px;">🐳</span>
								<span class="container-count-value">-</span>
							</div>
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
					${
						runMetadata.type === 'multiparty'
							? renderMultipartyDetails(runMetadata, run.id)
							: '<div class="loading-steps" style="padding: 40px 20px; text-align: center; color: #64748b; font-size: 14px;">Loading steps...</div>'
					}
				</div>
			`

				const isMultiparty = runMetadata.type === 'multiparty'
				card.dataset.isMultiparty = isMultiparty ? 'true' : 'false'

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

				// Start live timer for running runs
				if (run.status === 'running') {
					startRunTimer(run.id, parseUTCTimestamp(run.created_at))
				}

				// Auto-expand if this is newly created OR currently running
				if (shouldAutoExpand) {
					updateExpandedState(true)
				} else {
					updateExpandedState(false)
				}

				// Store data for post-append loading
				card.dataset.shouldLoadSteps = shouldAutoExpand && isMultiparty ? 'true' : 'false'
				card.dataset.shouldLoadFlowSteps = shouldAutoExpand && !isMultiparty ? 'true' : 'false'
				card.dataset.sessionId = isMultiparty ? runMetadata.session_id || '' : ''
				card.dataset.isNewlyCreated = isNewlyCreated ? 'true' : 'false'

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
						if (isMultiparty) {
							await loadMultipartySteps(runMetadata.session_id, run.id)
							// Start polling for updates from other participants
							startMultipartyPolling(runMetadata.session_id, run.id)
						} else {
							await loadFlowRunSteps(run, flow, detailsContainer)
						}
					} else {
						detailsContainer.style.display = 'none'
						stopFlowLogPolling(run.id)
						if (isMultiparty) {
							stopMultipartyPolling(runMetadata.session_id)
						}
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
						// Disable button and show stopping state
						pauseBtn.disabled = true
						pauseBtn.style.opacity = '0.6'
						pauseBtn.style.cursor = 'wait'
						const originalHtml = pauseBtn.innerHTML
						pauseBtn.innerHTML = `<span style="display: flex; align-items: center; gap: 4px; font-size: 11px; color: #f59e0b;">
							<svg width="16" height="16" viewBox="0 0 24 24" style="animation: bv-spin 1s linear infinite;">
								<circle cx="12" cy="12" r="10" stroke="currentColor" stroke-width="2" fill="none" stroke-dasharray="31.4 31.4" stroke-linecap="round"/>
							</svg>
							Stopping
						</span>`
						// Add keyframes if not present
						if (!document.getElementById('bv-spin-keyframes')) {
							const style = document.createElement('style')
							style.id = 'bv-spin-keyframes'
							style.textContent =
								'@keyframes bv-spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }'
							document.head.appendChild(style)
						}
						pauseBtn.title = 'Stopping...'
						try {
							await invoke('pause_flow_run', { runId: run.id })
							await loadRuns()
						} catch (error) {
							// Restore button on error
							pauseBtn.innerHTML = originalHtml
							pauseBtn.disabled = false
							pauseBtn.style.opacity = '1'
							pauseBtn.style.cursor = 'pointer'
							pauseBtn.title = 'Pause run'
							alert(`Error pausing run: ${error}`)
						}
					})
				}

				const resumeBtn = card.querySelector('.run-resume-btn')
				if (resumeBtn) {
					resumeBtn.addEventListener('click', async (e) => {
						e.stopPropagation()
						try {
							const confirmed = await confirmWithDialog(
								'Try to resume this run from the last checkpoint?',
								{ title: 'Resume Run', type: 'warning' },
							)
							if (!confirmed) return
							if (run.status === 'failed') {
								try {
									await invoke('cleanup_flow_run_state', { runId: run.id })
									console.log('🧹 Cleaned stale run state for retry', run.id)
								} catch (cleanupError) {
									alert(`Failed to clean up stale run state: ${cleanupError}`)
									return
								}
							}
							const input = card.querySelector('.run-concurrency-input')
							const nextflowMaxForks = parseConcurrencyInput(input?.value)
							await invoke('resume_flow_run', { runId: run.id, nextflowMaxForks })
							await loadRuns()
						} catch (error) {
							const message = `${error?.message || error}`
							// Handle lock files remaining
							if (message.includes('NEXTFLOW_LOCKS_REMAIN')) {
								const details = message.split('NEXTFLOW_LOCKS_REMAIN:').pop()?.trim()
								const confirmed = await confirmWithDialog(
									`Nextflow lock files are still present.${details ? `\n\n${details}` : ''}\n\nForce remove locks and resume?`,
									{ title: 'Nextflow Lock Detected', type: 'warning' },
								)
								if (confirmed) {
									const input = card.querySelector('.run-concurrency-input')
									const nextflowMaxForks = parseConcurrencyInput(input?.value)
									await invoke('resume_flow_run', {
										runId: run.id,
										nextflowMaxForks,
										forceRemoveLock: true,
									})
									await loadRuns()
									return
								}
							}
							// Handle corrupted cache DB (happens after ungraceful pause)
							else if (
								message.includes("Can't open cache DB") ||
								message.includes('Unable to acquire lock') ||
								message.includes('NEXTFLOW_CACHE_CORRUPTED')
							) {
								const confirmed = await confirmWithDialog(
									`Nextflow cache appears corrupted from a previous interrupted run.\n\nClear cache and start fresh? (Previous progress will be lost)`,
									{ title: 'Nextflow Cache Corrupted', type: 'warning' },
								)
								if (confirmed) {
									const input = card.querySelector('.run-concurrency-input')
									const nextflowMaxForks = parseConcurrencyInput(input?.value)
									await invoke('resume_flow_run', {
										runId: run.id,
										nextflowMaxForks,
										forceRemoveLock: true,
									})
									await loadRuns()
									return
								}
							}
							alert(`Error resuming run: ${error}`)
						}
					})
				}

				const retryBtn = card.querySelector('.run-retry-btn')
				if (retryBtn) {
					retryBtn.addEventListener('click', async (e) => {
						e.stopPropagation()
						try {
							const confirmed = await confirmWithDialog(
								'Retry this run and attempt to resume from cache? This will clear stale PID/state files if needed.',
								{ title: 'Retry Run', type: 'warning' },
							)
							if (!confirmed) return
							const input = card.querySelector('.run-concurrency-input')
							const nextflowMaxForks = parseConcurrencyInput(input?.value)

							// For failed runs, check the log for cache corruption errors BEFORE attempting resume
							if (run.status === 'failed') {
								try {
									const logs = await invoke('get_flow_run_logs_tail', { runId: run.id, lines: 100 })
									if (
										logs &&
										(logs.includes("Can't open cache DB") ||
											logs.includes('Unable to acquire lock'))
									) {
										const confirmed = await confirmWithDialog(
											`The previous run failed due to Nextflow cache corruption (common after pausing).\n\nClear cache and start fresh? (Previous progress will be lost)`,
											{ title: 'Nextflow Cache Corrupted', type: 'warning' },
										)
										if (confirmed) {
											await invoke('resume_flow_run', {
												runId: run.id,
												nextflowMaxForks,
												forceRemoveLock: true,
											})
											await loadRuns()
											return
										} else {
											return // User cancelled
										}
									}
								} catch (logError) {
									console.warn('Failed to check logs for cache errors:', logError)
								}
							}

							await invoke('resume_flow_run', { runId: run.id, nextflowMaxForks })
							await loadRuns()
						} catch (error) {
							const message = `${error?.message || error}`
							// Handle lock files remaining
							if (message.includes('NEXTFLOW_LOCKS_REMAIN')) {
								const details = message.split('NEXTFLOW_LOCKS_REMAIN:').pop()?.trim()
								const confirmed = await confirmWithDialog(
									`Nextflow lock files are still present.${details ? `\n\n${details}` : ''}\n\nForce remove locks and retry?`,
									{ title: 'Nextflow Lock Detected', type: 'warning' },
								)
								if (confirmed) {
									const input = card.querySelector('.run-concurrency-input')
									const nextflowMaxForks = parseConcurrencyInput(input?.value)
									await invoke('resume_flow_run', {
										runId: run.id,
										nextflowMaxForks,
										forceRemoveLock: true,
									})
									await loadRuns()
									return
								}
							}
							// Handle corrupted cache DB (happens after ungraceful pause)
							else if (
								message.includes("Can't open cache DB") ||
								message.includes('Unable to acquire lock') ||
								message.includes('NEXTFLOW_CACHE_CORRUPTED')
							) {
								const confirmed = await confirmWithDialog(
									`Nextflow cache appears corrupted from a previous interrupted run.\n\nClear cache and start fresh? (Previous progress will be lost)`,
									{ title: 'Nextflow Cache Corrupted', type: 'warning' },
								)
								if (confirmed) {
									const input = card.querySelector('.run-concurrency-input')
									const nextflowMaxForks = parseConcurrencyInput(input?.value)
									await invoke('resume_flow_run', {
										runId: run.id,
										nextflowMaxForks,
										forceRemoveLock: true,
									})
									await loadRuns()
									return
								}
							}
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

				const mpInputsToggle = card.querySelector('.mp-inputs-toggle')
				if (mpInputsToggle) {
					mpInputsToggle.addEventListener('click', () => {
						const runId = mpInputsToggle.dataset.runId
						const body = card.querySelector(`.mp-inputs-body[data-run-id="${runId}"]`)
						if (!body) return
						const expanded = body.style.display !== 'none'
						body.style.display = expanded ? 'none' : 'block'
					})
				}

				// Load steps AFTER card is in DOM
				if (card.dataset.shouldLoadSteps === 'true') {
					const sessionId = card.dataset.sessionId
					loadMultipartySteps(sessionId, run.id).catch(console.error)
					// Start polling for updates from other participants
					startMultipartyPolling(sessionId, run.id)
				} else if (card.dataset.shouldLoadFlowSteps === 'true') {
					const detailsContainer = card.querySelector('.run-details')
					loadFlowRunSteps(run, flow, detailsContainer).catch(console.error)
				}

				// Scroll to newly created cards
				if (card.dataset.isNewlyCreated === 'true') {
					setTimeout(() => {
						card.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
					}, 100)
				}
			})
		} catch (error) {
			console.error('Error loading runs:', error)
		}
	}

	function parseUTCTimestamp(ts) {
		if (!ts) return NaN
		const s = String(ts).trim()
		if (
			/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(s) &&
			!s.includes('T') &&
			!s.includes('+') &&
			!s.includes('Z')
		) {
			return Date.parse(s.replace(' ', 'T') + 'Z')
		}
		return Date.parse(s)
	}

	function formatElapsed(ms) {
		const totalSec = Math.max(0, Math.floor(ms / 1000))
		const h = Math.floor(totalSec / 3600)
		const m = Math.floor((totalSec % 3600) / 60)
		const s = totalSec % 60
		if (h > 0) return `${h}h ${String(m).padStart(2, '0')}m ${String(s).padStart(2, '0')}s`
		if (m > 0) return `${m}m ${String(s).padStart(2, '0')}s`
		return `${s}s`
	}

	function startRunTimer(runId, startMs) {
		stopRunTimer(runId)
		const update = () => {
			const el = document.querySelector(`.run-timer[data-run-id="${runId}"]`)
			if (!el) {
				stopRunTimer(runId)
				return
			}
			el.textContent = formatElapsed(Date.now() - startMs)
		}
		update()
		flowTimerIntervals.set(runId, setInterval(update, 1000))
	}

	function stopRunTimer(runId) {
		const iv = flowTimerIntervals.get(runId)
		if (iv) {
			clearInterval(iv)
			flowTimerIntervals.delete(runId)
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
			const configRowHtml = (label, value) => `
				<div style="display: flex; gap: 12px; padding: 10px 12px; background: #f8fafc; border-radius: 6px; border: 1px solid #e2e8f0;">
					<span style="font-size: 12px; color: #64748b; font-family: 'SF Mono', Monaco, monospace; font-weight: 600; flex-shrink: 0; min-width: 160px;">${escapeHtml(label)}</span>
					<span style="color: #cbd5e1;">:</span>
					<span style="font-size: 12px; color: #475569; font-family: 'SF Mono', Monaco, monospace; word-break: break-all;">${escapeHtml(value)}</span>
				</div>`

			const envItems = []
			if (flow?.flow_path) envItems.push(configRowHtml('Flow Path', flow.flow_path))
			if (resultsDir) envItems.push(configRowHtml('Results Dir', resultsDir))
			if (nextflowMaxForks)
				envItems.push(configRowHtml('Max Concurrency', String(nextflowMaxForks)))
			const containerRuntime = runMetadata.container_runtime || null
			if (containerRuntime) envItems.push(configRowHtml('Container Runtime', containerRuntime))
			const isWindows = navigator.platform?.toLowerCase().includes('win')
			if (!isWindows)
				envItems.push(
					configRowHtml(
						'Container Mode',
						containerRuntime ? `Using ${containerRuntime}` : 'Native (no container)',
					),
				)

			const hasInputsOrParams =
				Object.keys(inputOverrides).length > 0 || Object.keys(paramOverrides).length > 0
			const hasConfig = hasInputsOrParams || envItems.length > 0
			const settingCount =
				Object.keys(inputOverrides).length + Object.keys(paramOverrides).length + envItems.length

			const inputsHtml = hasConfig
				? `<div class="run-config-section" style="margin-bottom: 24px;">
					<button class="run-config-toggle" onclick="this.nextElementSibling.style.display = this.nextElementSibling.style.display === 'none' ? 'block' : 'none'; this.querySelector('svg').style.transform = this.nextElementSibling.style.display === 'none' ? 'rotate(0deg)' : 'rotate(90deg)';" style="width: 100%; display: flex; align-items: center; gap: 10px; padding: 14px 16px; background: #f8fafc; border: 1.5px solid #e2e8f0; border-radius: 10px; cursor: pointer; transition: all 0.2s; text-align: left; font-size: 14px; font-weight: 600; color: #475569;" onmouseover="this.style.background='#f1f5f9'; this.style.borderColor='#cbd5e1'" onmouseout="this.style.background='#f8fafc'; this.style.borderColor='#e2e8f0'">
						<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" style="transition: transform 0.3s; color: #64748b; transform: rotate(0deg);">
							<polyline points="9 18 15 12 9 6"></polyline>
						</svg>
						<span>Configuration</span>
						<span style="margin-left: auto; font-size: 12px; color: #94a3b8;">${settingCount} item${settingCount === 1 ? '' : 's'}</span>
					</button>
					<div class="run-config-content" style="display: none; padding: 16px; background: white; border: 1.5px solid #e2e8f0; border-top: none; border-radius: 0 0 10px 10px;">
						${
							envItems.length > 0
								? `<div style="margin-bottom: ${hasInputsOrParams ? '16px' : '0'};">
								<div style="font-size: 12px; font-weight: 700; color: #475569; margin-bottom: 10px; text-transform: uppercase; letter-spacing: 0.05em;">Environment</div>
								<div style="display: flex; flex-direction: column; gap: 8px;">
									${envItems.join('')}
								</div>
							</div>`
								: ''
						}
						${
							Object.keys(inputOverrides).length > 0
								? `<div style="margin-bottom: ${
										Object.keys(paramOverrides).length > 0 ? '16px' : '0'
									};">
								<div style="font-size: 12px; font-weight: 700; color: #475569; margin-bottom: 10px; text-transform: uppercase; letter-spacing: 0.05em;">Input Values</div>
								<div style="display: flex; flex-direction: column; gap: 8px;">
									${Object.entries(inputOverrides)
										.map(([key, value]) => configRowHtml(key, value))
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
										.map(([key, value]) => configRowHtml(key, value))
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

					${(() => {
						const flowPath = flow?.flow_path ? `${flow.flow_path}/flow.yaml` : null
						if (!flowPath) return ''
						let cmd = `bv flow run ${flowPath}`
						Object.entries(inputOverrides).forEach(([key, value]) => {
							const needsQuote = value.includes(' ') || value.includes('"')
							cmd += ` --set ${key}=${needsQuote ? `"${value}"` : value}`
						})
						if (nextflowMaxForks) {
							cmd += ` --nxf-max-forks ${nextflowMaxForks}`
						}
						if (resultsDir) {
							cmd += ` --results-dir ${resultsDir}`
						}
						return `<div class="run-command-section" style="margin-bottom: 24px;">
							<button class="run-command-toggle" onclick="this.nextElementSibling.style.display = this.nextElementSibling.style.display === 'none' ? 'block' : 'none'; this.querySelector('.chevron-icon').style.transform = this.nextElementSibling.style.display === 'none' ? 'rotate(0deg)' : 'rotate(90deg)';" style="width: 100%; display: flex; align-items: center; gap: 10px; padding: 14px 16px; background: #f8fafc; border: 1.5px solid #e2e8f0; border-radius: 10px; cursor: pointer; transition: all 0.2s; text-align: left; font-size: 14px; font-weight: 600; color: #475569;" onmouseover="this.style.background='#f1f5f9'; this.style.borderColor='#cbd5e1'" onmouseout="this.style.background='#f8fafc'; this.style.borderColor='#e2e8f0'">
								<svg class="chevron-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" style="transition: transform 0.3s; color: #64748b; transform: rotate(0deg);">
									<polyline points="9 18 15 12 9 6"></polyline>
								</svg>
								<img src="assets/icons/terminal.svg" width="16" height="16" style="opacity: 0.6;" />
								<span>Nextflow Command</span>
								<span style="margin-left: auto; font-size: 12px; color: #94a3b8;">CLI debug</span>
							</button>
							<div style="display: none; padding: 16px; background: #1e293b; border: 1.5px solid #e2e8f0; border-top: none; border-radius: 0 0 10px 10px; position: relative;">
								<button class="copy-command-btn" data-command="${escapeHtml(cmd)}" style="position: absolute; top: 12px; right: 12px; background: #334155; color: #94a3b8; border: 1px solid #475569; border-radius: 6px; padding: 4px 10px; font-size: 11px; cursor: pointer; display: flex; align-items: center; gap: 4px; transition: all 0.2s;" onmouseover="this.style.background='#475569'; this.style.color='#e2e8f0'" onmouseout="this.style.background='#334155'; this.style.color='#94a3b8'">
									<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
										<rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
										<path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
									</svg>
									Copy
								</button>
								<div style="margin-bottom: 8px; font-size: 11px; color: #94a3b8; font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em;">BioVault CLI</div>
								<pre style="margin: 0; padding: 0; padding-right: 80px; color: #e2e8f0; font-size: 12px; line-height: 1.6; font-family: 'SF Mono', Monaco, 'Cascadia Code', monospace; white-space: pre-wrap; word-break: break-all;">${escapeHtml(cmd)}</pre>
								${(() => {
									const cachedNfCmd = flowNfCommandCache.get(run.id) || ''
									return `<div class="actual-nf-command" data-run-id="${run.id}" style="margin-top: 16px; padding-top: 16px; border-top: 1px solid #334155; display: ${cachedNfCmd ? 'block' : 'none'};">
									<div style="margin-bottom: 8px; font-size: 11px; color: #94a3b8; font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em;">Actual Nextflow Command</div>
									<div style="position: relative;">
										<button class="copy-command-btn copy-nf-cmd-btn" data-command="${escapeHtml(cachedNfCmd)}" style="position: absolute; top: 0; right: 0; background: #334155; color: #94a3b8; border: 1px solid #475569; border-radius: 6px; padding: 4px 10px; font-size: 11px; cursor: pointer; display: flex; align-items: center; gap: 4px; transition: all 0.2s;" onmouseover="this.style.background='#475569'; this.style.color='#e2e8f0'" onmouseout="this.style.background='#334155'; this.style.color='#94a3b8'">
											<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
												<rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
												<path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
											</svg>
											Copy
										</button>
										<pre class="actual-nf-command-text" style="margin: 0; padding: 0; padding-right: 80px; color: #e2e8f0; font-size: 12px; line-height: 1.6; font-family: 'SF Mono', Monaco, 'Cascadia Code', monospace; white-space: pre-wrap; word-break: break-all;">${escapeHtml(cachedNfCmd)}</pre>
									</div>
								</div>`
								})()}
							</div>
						</div>`
					})()}

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

			// Load saved state for completed/failed/paused runs (progress, concurrency, nf command)
			if (run.status === 'failed' || run.status === 'paused' || run.status === 'success') {
				const concurrencyInput = card
					? card.querySelector(`.run-concurrency-input[data-run-id="${run.id}"]`)
					: null
				loadAndDisplaySavedState(run.id, progressEls, concurrencyInput, run.status).then(
					(savedState) => {
						// Also refresh logs once for failed/paused to show what happened
						if (logStream && (run.status === 'failed' || run.status === 'paused')) {
							refreshFlowRunLogs(run, logStream, progressEls, stepRows)
						}
						// For success runs, also try to extract nf command from logs if not in state
						if (logStream && run.status === 'success' && !savedState?.nextflow_command) {
							refreshFlowRunLogs(run, logStream, progressEls, stepRows)
						}
					},
				)
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

			// Copy command button
			container.querySelectorAll('.copy-command-btn').forEach((btn) => {
				btn.addEventListener('click', async (e) => {
					e.stopPropagation()
					const cmd = btn.dataset.command
					if (cmd) {
						try {
							await navigator.clipboard.writeText(cmd)
							const orig = btn.innerHTML
							btn.innerHTML = '<span style="color: #4ade80;">Copied!</span>'
							setTimeout(() => {
								btn.innerHTML = orig
							}, 1500)
						} catch (err) {
							console.error('Copy failed:', err)
						}
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
