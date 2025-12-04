/* global pipelineModule */
export function createPipelinesModule({
	invoke,
	dialog,
	open: _open,
	navigateTo,
	openProjectEditor,
}) {
	// Helper function
	function escapeHtml(text) {
		const div = document.createElement('div')
		div.textContent = text
		return div.innerHTML
	}

	async function confirmWithDialog(message, options = {}) {
		if (dialog?.confirm) {
			return await dialog.confirm(message, options)
		}
		return window.confirm(message)
	}

	// State management
	const pipelineState = {
		pipelines: [],
		currentPipeline: null,
		wizardStep: 0,
		wizardData: {
			name: '',
			inputs: {},
			steps: [],
		},
		pendingDataRun: null,
		dataRunModalOpen: false,
	}

	// Load pipelines list
	async function loadPipelines() {
		try {
			// Clear cached context to ensure fresh read from sessionStorage
			pipelineState.pendingDataRun = null

			const pipelines = await invoke('get_pipelines')
			// Pre-load all projects for step resolution
			const projects = await invoke('get_projects')
			const projectsMap = new Map()
			projects.forEach((p) => {
				const key = `${p.name}@${p.version}`
				projectsMap.set(key, p)
				// Also allow lookup by name only (for latest version)
				if (!projectsMap.has(p.name)) {
					projectsMap.set(p.name, p)
				}
			})

			const gridContainer = document.getElementById('pipelines-grid')
			const emptyState = document.getElementById('pipelines-empty-state')

			if (!gridContainer) {
				console.error('pipelines-grid container not found')
				return
			}

			if (!pipelines || pipelines.length === 0) {
				gridContainer.innerHTML = ''
				if (emptyState) emptyState.style.display = 'flex'
				pipelineState.pipelines = []
				// Still render banner (it will clear itself if no selection)
				renderDataRunBanner()
				return
			}

			if (emptyState) emptyState.style.display = 'none'
			gridContainer.innerHTML = ''

			pipelines.forEach((pipeline) => {
				renderPipelineCard(pipeline, gridContainer, projectsMap)
			})

			pipelineState.pipelines = pipelines

			renderDataRunBanner()

			// Don't auto-open modal - let user choose from banner or pipeline cards
		} catch (error) {
			console.error('Error loading pipelines:', error)
		}
	}

	function renderPipelineCard(pipeline, container, projectsMap = new Map()) {
		const stepCount = pipeline.spec?.steps?.length || 0
		const description = pipeline.spec?.description || ''
		const context = getPendingDataRunContext()
		const hasDataSelected = context && context.fileIds && context.fileIds.length > 0
		const acceptsGenotype = pipelineAcceptsGenotypeInput(pipeline)
		const canRunWithData = hasDataSelected && acceptsGenotype

		// Resolve step projects to get names and versions
		const stepDetails = (pipeline.spec?.steps || [])
			.map((step) => {
				if (!step.uses) return null
				const uses = step.uses

				// Try to find project in map
				let project = null
				if (uses.includes('@')) {
					// Has version: name@version
					project = projectsMap.get(uses)
				} else {
					// No version: try by name
					project = projectsMap.get(uses)
				}

				if (project) {
					return {
						id: step.id,
						name: project.name,
						version: project.version,
					}
				}

				// Parse name@version if present
				if (uses.includes('@')) {
					const [name, version] = uses.split('@')
					return { id: step.id, name, version }
				}

				// Fallback: use the uses value as name
				return { id: step.id, name: uses, version: null }
			})
			.filter((s) => s !== null)

		const card = document.createElement('div')
		card.className = 'pipeline-card'
		if (canRunWithData) {
			card.classList.add('pipeline-card-has-data')
			card.style.cssText =
				'border: 2px solid rgba(29,78,216,0.4); box-shadow: 0 4px 12px rgba(29,78,216,0.15);'
		}

		const dataBadge = canRunWithData
			? `<div style="display: flex; align-items: center; gap: 6px; padding: 6px 10px; background: rgba(29,78,216,0.1); border-radius: 6px; margin-bottom: 12px; font-size: 12px; color: #1e40af;">
					<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
						<path d="M9 11l3 3L22 4"></path>
						<path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"></path>
					</svg>
					<span style="font-weight: 600;">Ready to run with selected data</span>
				</div>`
			: ''

		card.innerHTML = `
			<div class="pipeline-card-header">
				<h3 class="pipeline-card-title">${pipeline.name}</h3>
				<button class="pipeline-card-menu" onclick="event.stopPropagation(); pipelineModule.showPipelineMenu(${
					pipeline.id
				}, event)">⋯</button>
			</div>
			${dataBadge}
			${description ? `<p class="pipeline-card-description">${description}</p>` : ''}
			<div class="pipeline-card-footer" style="display: flex; justify-content: space-between; align-items: center; gap: 8px;">
				${
					stepDetails.length > 0
						? `<div style="display: flex; flex-wrap: wrap; gap: 4px; align-items: center;">${stepDetails
								.map((s) => {
									const versionText = s.version ? ` v${s.version}` : ''
									return `<span style="display: inline-block; padding: 4px 8px; background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 4px; font-size: 11px; color: #475569;">${s.name}${versionText}</span>`
								})
								.join('')}</div>`
						: `<span class="pipeline-step-badge">${stepCount} ${
								stepCount === 1 ? 'step' : 'steps'
							}</span>`
				}
				${
					canRunWithData
						? `<button class="pipeline-run-data-btn" data-pipeline-id="${pipeline.id}" style="background: linear-gradient(135deg, #2563eb 0%, #1d4ed8 100%); color: white; border: none; padding: 8px 16px; border-radius: 6px; font-weight: 600; font-size: 13px; cursor: pointer; display: flex; align-items: center; gap: 6px; box-shadow: 0 2px 6px rgba(37,99,235,0.3);">
						<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
							<polygon points="5 3 19 12 5 21 5 3"></polygon>
						</svg>
						Run with Selected Data
					</button>`
						: `<button class="pipeline-run-btn" data-pipeline-id="${pipeline.id}">▶ Run</button>`
				}
			</div>
		`

		// Card click handler removed - cards are not clickable
		container.appendChild(card)

		if (canRunWithData) {
			const runDataBtn = card.querySelector('.pipeline-run-data-btn')
			if (runDataBtn) {
				runDataBtn.addEventListener('click', async (event) => {
					event.stopPropagation()
					await handlePipelineRunClick(pipeline.id)
				})
			}
		} else {
			const runBtn = card.querySelector('.pipeline-run-btn')
			if (runBtn) {
				runBtn.addEventListener('click', async (event) => {
					event.stopPropagation()
					await handlePipelineRunClick(pipeline.id)
				})
			}
		}
	}

	function refreshPipelineCards() {
		const gridContainer = document.getElementById('pipelines-grid')
		if (!gridContainer || !pipelineState.pipelines) return

		const existingCards = Array.from(gridContainer.querySelectorAll('.pipeline-card'))
		if (existingCards.length === 0) return

		// Re-render all cards with updated data selection state
		const fragment = document.createDocumentFragment()
		pipelineState.pipelines.forEach((pipeline) => {
			const existingCard = existingCards.find((card) => {
				const runBtn = card.querySelector('[data-pipeline-id]')
				return runBtn && parseInt(runBtn.dataset.pipelineId) === pipeline.id
			})
			if (existingCard) {
				existingCard.remove()
			}
			renderPipelineCard(pipeline, fragment)
		})

		gridContainer.appendChild(fragment)
	}

	function getPendingDataRunContext() {
		// Always read fresh from sessionStorage - don't use cached state
		// This ensures we see the latest selection state from Data tab
		pipelineState.pendingDataRun = null

		if (typeof sessionStorage === 'undefined') {
			return null
		}

		const fileIdsRaw = sessionStorage.getItem('preselectedFileIds')
		if (!fileIdsRaw) {
			// Explicitly clear cache if no data
			pipelineState.pendingDataRun = null
			return null
		}

		let parsedFileIds
		try {
			parsedFileIds = JSON.parse(fileIdsRaw)
		} catch (error) {
			console.warn('Failed to parse preselectedFileIds:', error)
			sessionStorage.removeItem('preselectedFileIds')
			return null
		}

		if (!Array.isArray(parsedFileIds)) {
			sessionStorage.removeItem('preselectedFileIds')
			return null
		}

		const uniqueFileIds = Array.from(
			new Set(
				parsedFileIds.map((value) => parseInt(value, 10)).filter((value) => Number.isFinite(value)),
			),
		)

		if (uniqueFileIds.length === 0) {
			// Clear sessionStorage and cache if no valid file IDs
			sessionStorage.removeItem('preselectedFileIds')
			pipelineState.pendingDataRun = null
			return null
		}

		let participantIds = []
		const participantsRaw = sessionStorage.getItem('preselectedParticipants')
		if (participantsRaw) {
			try {
				const parsedParticipants = JSON.parse(participantsRaw)
				if (Array.isArray(parsedParticipants)) {
					participantIds = Array.from(
						new Set(
							parsedParticipants
								.map((value) => parseInt(value, 10))
								.filter((value) => Number.isFinite(value)),
						),
					)
				}
			} catch (error) {
				console.warn('Failed to parse preselectedParticipants:', error)
			}
		}

		const context = {
			fileIds: uniqueFileIds,
			participantIds,
		}

		// Cache for performance, but will be cleared on next check if sessionStorage changed
		pipelineState.pendingDataRun = context
		return context
	}

	function clearDataRunContext() {
		pipelineState.pendingDataRun = null

		if (typeof sessionStorage === 'undefined') {
			return
		}

		try {
			sessionStorage.removeItem('preselectedFileIds')
			sessionStorage.removeItem('preselectedParticipants')
		} catch (error) {
			console.warn('Failed to clear preselected session data:', error)
		}

		renderDataRunBanner()
	}

	function renderDataRunBanner() {
		const context = getPendingDataRunContext()
		const mainView = document.getElementById('pipelines-main-view')
		const bannerId = 'pipelines-data-banner'
		let banner = document.getElementById(bannerId)

		if (!context || !context.fileIds || context.fileIds.length === 0) {
			if (banner) {
				banner.remove()
			}
			renderDetailDataRunBanner(null)
			// Refresh pipeline cards to remove data-specific UI
			refreshPipelineCards()
			return
		}

		if (mainView) {
			if (!banner) {
				banner = document.createElement('div')
				banner.id = bannerId
				banner.className = 'data-run-banner'
				banner.style.cssText =
					'margin: 16px 24px 0 24px; padding: 16px 20px; background: linear-gradient(135deg, rgba(29,78,216,0.12) 0%, rgba(59,130,246,0.08) 100%); border: 1.5px solid rgba(29,78,216,0.3); border-radius: 8px; color: #0f172a; box-shadow: 0 2px 8px rgba(29,78,216,0.1);'

				const viewContent = mainView.querySelector('.view-content')
				if (viewContent) {
					viewContent.insertBefore(banner, viewContent.firstChild)
				} else {
					const header = mainView.querySelector('.page-header')
					if (header && header.parentNode) {
						header.parentNode.insertBefore(banner, header.nextSibling)
					} else {
						mainView.insertBefore(banner, mainView.firstChild)
					}
				}
			}

			populateMainDataRunBanner(banner, context)
		}

		renderDetailDataRunBanner(context)
		// Refresh pipeline cards to show data-specific UI
		refreshPipelineCards()
	}

	function renderDetailDataRunBanner(context) {
		const detailView = document.getElementById('pipeline-detail-view')
		if (!detailView) return

		const bannerId = 'pipeline-detail-data-banner'
		let banner = document.getElementById(bannerId)

		if (!context || !context.fileIds || context.fileIds.length === 0) {
			if (banner) {
				banner.remove()
			}
			return
		}

		if (!banner) {
			banner = document.createElement('div')
			banner.id = bannerId
			banner.style.cssText =
				'margin: 12px 0; padding: 12px 16px; background: rgba(29,78,216,0.08); border: 1px solid rgba(29,78,216,0.35); border-radius: 6px; color: #0f172a;'

			const header = detailView.querySelector('.page-header')
			if (header && header.parentNode) {
				header.parentNode.insertBefore(banner, header.nextSibling)
			} else {
				detailView.insertBefore(banner, detailView.firstChild)
			}
		}

		const preselectedPipelineId = pipelineState.currentPipeline?.id ?? null
		populateDataRunBanner(banner, context, preselectedPipelineId)
	}

	function populateMainDataRunBanner(banner, context) {
		const fileCount = context.fileIds.length
		const participantCount =
			context.participantIds && context.participantIds.length > 0
				? context.participantIds.length
				: fileCount

		const eligiblePipelines = (pipelineState.pipelines || []).filter((pipeline) =>
			pipelineAcceptsGenotypeInput(pipeline),
		)

		banner.innerHTML = `
			<div style="display: flex; align-items: center; gap: 24px;">
				<div style="flex: 1; display: flex; flex-direction: column; gap: 8px;">
					<div style="display: flex; align-items: center; gap: 12px;">
						<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="color: #2563eb; flex-shrink: 0;">
							<path d="M9 11l3 3L22 4"></path>
							<path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"></path>
						</svg>
						<strong style="font-size: 15px; color: #1e40af; line-height: 1.4;">Data Selected for Pipeline Run</strong>
					</div>
					<div style="font-size: 14px; color: #475569; line-height: 1.6; margin-left: 32px;">
						<strong style="color: #1e293b;">${fileCount}</strong> file${fileCount === 1 ? '' : 's'} selected
						<span style="margin: 0 8px;">•</span>
						<strong style="color: #1e293b;">${participantCount}</strong> participant${
							participantCount === 1 ? '' : 's'
						}
						${
							eligiblePipelines.length > 0
								? `<span style="margin-left: 12px; padding: 4px 10px; background: rgba(34,197,94,0.1); color: #16a34a; border-radius: 4px; font-size: 13px; font-weight: 500;">
								${eligiblePipelines.length} compatible pipeline${
									eligiblePipelines.length === 1 ? '' : 's'
								} available
							</span>`
								: ''
						}
					</div>
					${
						eligiblePipelines.length > 1
							? `<div style="margin-left: 32px; font-size: 13px; color: #64748b; line-height: 1.5;">
							Select a pipeline below, or click "Choose Pipeline" to see all options.
						</div>`
							: ''
					}
				</div>
				<div style="display: flex; gap: 10px; align-items: center; flex-wrap: wrap; flex-shrink: 0;">
					${
						eligiblePipelines.length > 1
							? `<button type="button" class="btn-primary" data-role="data-run-choose" style="font-size: 13px; padding: 10px 18px; background: linear-gradient(135deg, #2563eb 0%, #1d4ed8 100%); border-radius: 6px; font-weight: 600; display: flex; align-items: center; gap: 6px; white-space: nowrap; border: none; color: white; cursor: pointer; transition: all 0.2s; box-shadow: 0 2px 4px rgba(37,99,235,0.2);">
							<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
								<circle cx="5" cy="12" r="3" />
								<circle cx="19" cy="12" r="3" />
								<line x1="8" y1="12" x2="16" y2="12" />
							</svg>
							Choose Pipeline
						</button>`
							: ''
					}
					<button type="button" class="btn-secondary" data-role="data-run-back" style="font-size: 13px; padding: 10px 16px; border-radius: 6px; font-weight: 600; display: flex; align-items: center; gap: 6px; white-space: nowrap; background: white; border: 1.5px solid #cbd5e1; color: #475569; cursor: pointer; transition: all 0.2s;">
						<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
							<polyline points="15 18 9 12 15 6"></polyline>
						</svg>
						Back to Data
					</button>
					<button
						type="button"
						data-role="data-run-clear"
						style="background: none; border: none; color: #64748b; text-decoration: none; cursor: pointer; font-size: 13px; padding: 10px 12px; line-height: 1.4; white-space: nowrap; font-weight: 500; transition: color 0.2s; text-underline-offset: 2px;"
						title="Clear selection"
						onmouseover="this.style.color='#1e293b'; this.style.textDecoration='underline'"
						onmouseout="this.style.color='#64748b'; this.style.textDecoration='none'"
					>
						Clear
					</button>
				</div>
			</div>
		`

		const backBtn = banner.querySelector('[data-role="data-run-back"]')
		if (backBtn) {
			backBtn.addEventListener('click', () => {
				if (typeof navigateTo === 'function') {
					navigateTo('data')
				}
			})
		}

		const chooseBtn = banner.querySelector('[data-role="data-run-choose"]')
		if (chooseBtn) {
			chooseBtn.addEventListener('click', async () => {
				await startDataDrivenRun(null).catch((error) => {
					console.error('Failed to open pipeline selection modal:', error)
				})
			})
		}

		const clearBtn = banner.querySelector('[data-role="data-run-clear"]')
		if (clearBtn) {
			clearBtn.addEventListener('click', () => {
				// Clear selections in Data tab
				if (typeof window.clearAllDataSelections === 'function') {
					window.clearAllDataSelections()
				}
				// Clear the banner context
				clearDataRunContext()
			})
		}
	}

	function populateDataRunBanner(banner, context, preselectedPipelineId = null) {
		const fileCount = context.fileIds.length
		const participantCount =
			context.participantIds && context.participantIds.length > 0
				? context.participantIds.length
				: fileCount

		banner.innerHTML = `
			<div style="display: flex; justify-content: space-between; align-items: center; gap: 12px;">
				<div style="font-size: 14px;">
					<strong>${fileCount}</strong> file${fileCount === 1 ? '' : 's'} selected
					<span style="color: #1e3a8a; margin-left: 12px;">
						${participantCount} participant${participantCount === 1 ? '' : 's'}
					</span>
				</div>
				<div style="display: flex; gap: 8px; align-items: center;">
					<button type="button" class="btn-secondary" data-role="data-run-back">← Back to Data</button>
					<button type="button" class="btn-primary" data-role="data-run-open">Select Pipeline</button>
					<button
						type="button"
						data-role="data-run-clear"
						style="background: none; border: none; color: #1e3a8a; text-decoration: underline; cursor: pointer; font-size: 13px; padding: 0 4px;"
					>
						Clear
					</button>
				</div>
			</div>
		`

		const backBtn = banner.querySelector('[data-role="data-run-back"]')
		if (backBtn) {
			backBtn.addEventListener('click', () => {
				if (typeof navigateTo === 'function') {
					navigateTo('data')
				}
			})
		}

		const openBtn = banner.querySelector('[data-role="data-run-open"]')
		if (openBtn) {
			openBtn.addEventListener('click', () => {
				startDataDrivenRun(preselectedPipelineId).catch((error) => {
					console.error('Failed to open data-run modal:', error)
				})
			})
		}

		const clearBtn = banner.querySelector('[data-role="data-run-clear"]')
		if (clearBtn) {
			clearBtn.addEventListener('click', () => {
				// Clear selections in Data tab
				if (typeof window.clearAllDataSelections === 'function') {
					window.clearAllDataSelections()
				}
				// Clear the banner context
				clearDataRunContext()
			})
		}
	}

	async function startDataDrivenRun(preselectedPipelineId = null) {
		if (pipelineState.dataRunModalOpen) {
			return true
		}

		const context = getPendingDataRunContext()
		if (!context || !context.fileIds || context.fileIds.length === 0) {
			return false
		}

		// Load pipelines if not already loaded
		if (!pipelineState.pipelines || pipelineState.pipelines.length === 0) {
			await loadPipelines()
		}

		const eligiblePipelines = (pipelineState.pipelines || []).filter((pipeline) =>
			pipelineAcceptsGenotypeInput(pipeline),
		)

		if (eligiblePipelines.length === 0) {
			alert('No pipelines are available that accept a List[GenotypeRecord] input.')
			clearDataRunContext()
			return false
		}

		await showDataRunModal(context, eligiblePipelines, preselectedPipelineId)
		return true
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
						statusEl.textContent = 'Docker is running! Starting pipeline...'
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

	// Public function to show modal directly (called from Data tab)
	async function showDataRunModalDirect() {
		const context = getPendingDataRunContext()
		if (!context || !context.fileIds || context.fileIds.length === 0) {
			return false
		}

		// Load pipelines if not already loaded
		if (!pipelineState.pipelines || pipelineState.pipelines.length === 0) {
			await loadPipelines()
		}

		const eligiblePipelines = (pipelineState.pipelines || []).filter((pipeline) =>
			pipelineAcceptsGenotypeInput(pipeline),
		)

		if (eligiblePipelines.length === 0) {
			if (dialog && dialog.message) {
				await dialog.message(
					'No pipelines are available that accept a List[GenotypeRecord] input. Please create a compatible pipeline first.',
					{ title: 'No Compatible Pipelines', type: 'warning' },
				)
			} else {
				alert('No pipelines are available that accept a List[GenotypeRecord] input.')
			}
			clearDataRunContext()
			return false
		}

		await showDataRunModal(context, eligiblePipelines, null)
		return true
	}

	async function handlePipelineRunClick(pipelineId) {
		// Always use the new data-driven flow
		const handled = await startDataDrivenRun(pipelineId)
		if (!handled) {
			// Check why it wasn't handled
			const context = getPendingDataRunContext()
			const hasData = context && context.fileIds && context.fileIds.length > 0

			if (!hasData) {
				// No data selected - prompt user to select data first
				if (dialog && dialog.confirm) {
					const shouldNavigate = await dialog.confirm(
						'No data selected. Would you like to go to the Data tab to select files before running this pipeline?',
						{ title: 'Select Data First', type: 'info' },
					)
					if (shouldNavigate && navigateTo) {
						navigateTo('data')
					}
				} else {
					const shouldNavigate = confirm(
						'No data selected. Would you like to go to the Data tab to select files before running this pipeline?',
					)
					if (shouldNavigate && navigateTo) {
						navigateTo('data')
					}
				}
			} else {
				// Data is selected but pipeline might not be compatible
				const pipeline = pipelineState.pipelines.find((p) => p.id === pipelineId)
				if (pipeline && !pipelineAcceptsGenotypeInput(pipeline)) {
					if (dialog && dialog.message) {
						await dialog.message(
							'This pipeline does not accept List[GenotypeRecord] input. Please select a compatible pipeline or modify this pipeline to accept genotype data.',
							{ title: 'Incompatible Pipeline', type: 'warning' },
						)
					} else {
						alert(
							'This pipeline does not accept List[GenotypeRecord] input. Please select a compatible pipeline or modify this pipeline to accept genotype data.',
						)
					}
				}
			}
		}
	}

	function describeInputType(inputSpec) {
		if (!inputSpec) return ''
		if (typeof inputSpec === 'string') return inputSpec
		if (typeof inputSpec === 'object') {
			if (inputSpec.type) return inputSpec.type
			if (inputSpec.raw_type) return inputSpec.raw_type
			if (inputSpec.rawType) return inputSpec.rawType
		}
		return ''
	}

	function pipelineAcceptsGenotypeInput(pipeline) {
		const inputs = pipeline?.spec?.inputs || {}
		return Object.values(inputs).some((inputSpec) => {
			const typeStr = describeInputType(inputSpec)
			return typeof typeStr === 'string' && typeStr.toLowerCase() === 'list[genotyperecord]'
		})
	}

	function closeDataRunModal(clearContext = false) {
		const modal = document.getElementById('data-run-modal')
		if (modal) {
			modal.remove()
		}
		pipelineState.dataRunModalOpen = false

		if (clearContext) {
			clearDataRunContext()
		}

		renderDataRunBanner()
	}

	async function showDataRunModal(context, pipelines, preselectedPipelineId = null) {
		if (!context || !pipelines || pipelines.length === 0) {
			return
		}

		pipelineState.dataRunModalOpen = true

		let runsBaseDir = ''
		try {
			runsBaseDir = await invoke('get_runs_base_dir')
		} catch (error) {
			console.warn('Failed to get runs base directory:', error)
		}

		const uniqueParticipantCount =
			context.participantIds && context.participantIds.length > 0
				? context.participantIds.length
				: context.fileIds.length
		const fileCount = context.fileIds.length

		const pipelineOptionsHtml = pipelines
			.map((pipeline, index) => {
				const isPreferred = preselectedPipelineId !== null && pipeline.id === preselectedPipelineId
				const isDefault = isPreferred || (preselectedPipelineId === null && index === 0)
				const isChecked = isDefault ? 'checked' : ''
				const inputs = pipeline?.spec?.inputs || {}

				const inputSummary = Object.entries(inputs)
					.map(([key, value]) => `${key}: ${describeInputType(value)}`)
					.join(', ')

				const description = pipeline?.spec?.description
					? `<div class="option-desc">${escapeHtml(pipeline.spec.description)}</div>`
					: ''

				const stepCount = pipeline.spec?.steps?.length || 0
				return `
					<label class="data-run-pipeline-option" data-pipeline-id="${
						pipeline.id
					}" style="display: flex; align-items: flex-start; gap: 16px; border: 2px solid ${
						isPreferred ? '#2563eb' : '#e2e8f0'
					}; border-radius: 12px; padding: 20px 24px; cursor: pointer; background: ${
						isPreferred ? 'linear-gradient(135deg, #eff6ff 0%, #dbeafe 100%)' : '#ffffff'
					}; transition: all 0.25s cubic-bezier(0.16, 1, 0.3, 1); ${
						isPreferred
							? 'box-shadow: 0 4px 12px rgba(37,99,235,0.15);'
							: 'box-shadow: 0 1px 3px rgba(0, 0, 0, 0.05);'
					};">
						<input type="radio" name="data-run-pipeline" value="${
							pipeline.id
						}" ${isChecked} style="margin-top: 4px; accent-color: #2563eb; width: 18px; height: 18px; cursor: pointer;">
						<div class="option-details" style="flex: 1; min-width: 0;">
							<div style="display: flex; align-items: center; gap: 10px; margin-bottom: 8px; flex-wrap: wrap;">
								<div class="option-title" style="font-weight: 700; font-size: 16px; color: #0f172a; letter-spacing: -0.01em;">
									${escapeHtml(pipeline.name || `Pipeline #${pipeline.id}`)}
								</div>
								${
									isPreferred
										? `<span style="padding: 4px 10px; background: rgba(37,99,235,0.15); color: #2563eb; border-radius: 6px; font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.05em;">Recommended</span>`
										: ''
								}
							</div>
							${
								description
									? `<div class="option-desc" style="color: #64748b; font-size: 14px; margin-bottom: 12px; line-height: 1.6;">${description}</div>`
									: ''
							}
							<div style="display: flex; gap: 16px; align-items: center; font-size: 13px; color: #64748b; flex-wrap: wrap;">
								<span style="display: flex; align-items: center; gap: 6px; font-weight: 500;">
									<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="opacity: 0.7;">
										<circle cx="5" cy="12" r="3" />
										<circle cx="19" cy="12" r="3" />
										<line x1="8" y1="12" x2="16" y2="12" />
									</svg>
									${stepCount} step${stepCount === 1 ? '' : 's'}
								</span>
								<span style="display: flex; align-items: center; gap: 6px; font-weight: 500;">
									<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="opacity: 0.7;">
										<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
										<polyline points="7 10 12 15 17 10" />
										<line x1="12" y1="15" x2="12" y2="3" />
									</svg>
									Inputs: ${escapeHtml(inputSummary || 'None')}
								</span>
							</div>
						</div>
					</label>
				`
			})
			.join('')

		const modal = document.createElement('div')
		modal.id = 'data-run-modal'
		modal.className = 'modal data-run-modal'
		modal.setAttribute('role', 'dialog')
		modal.setAttribute('aria-modal', 'true')
		modal.style.cssText =
			'position: fixed; top: 0; left: 0; width: 100%; height: 100%; display: flex; align-items: center; justify-content: center; z-index: 1000;'

		// Add CSS for backdrop animation if not exists
		if (!document.getElementById('data-run-modal-styles')) {
			const style = document.createElement('style')
			style.id = 'data-run-modal-styles'
			style.textContent = `
				.data-run-modal .modal-backdrop {
					position: absolute;
					top: 0;
					left: 0;
					width: 100%;
					height: 100%;
					background: rgba(0, 0, 0, 0.4);
					backdrop-filter: blur(8px);
					animation: backdropFadeIn 0.2s ease-out;
				}
				@keyframes backdropFadeIn {
					from { opacity: 0; backdrop-filter: blur(0px); }
					to { opacity: 1; backdrop-filter: blur(8px); }
				}
				@keyframes slideUp {
					from { opacity: 0; transform: translateY(24px) scale(0.96); }
					to { opacity: 1; transform: translateY(0) scale(1); }
				}
				.data-run-modal .modal-close-btn:hover {
					background: #f8fafc !important;
					color: #0f172a !important;
					transform: translateY(-1px);
				}
				.data-run-modal .modal-close-btn:active {
					transform: translateY(0);
				}
				.data-run-modal .data-run-pipeline-option:hover {
					border-color: #cbd5e1 !important;
					box-shadow: 0 4px 12px rgba(0, 0, 0, 0.08) !important;
				}
				.data-run-modal #data-run-run-btn:hover {
					background: linear-gradient(135deg, #1d4ed8 0%, #1e40af 100%) !important;
					box-shadow: 0 4px 12px rgba(37,99,235,0.4) !important;
					transform: translateY(-1px);
				}
				.data-run-modal #data-run-run-btn:active {
					transform: translateY(0);
				}
			`
			document.head.appendChild(style)
		}

		modal.innerHTML = `
			<div class="modal-backdrop data-run-backdrop" data-modal-close="data-run"></div>
			<div class="data-run-modal-panel" style="position: relative; width: 800px; max-width: 95vw; height: 85vh; max-height: 800px; background: #ffffff; border-radius: 16px; box-shadow: 0 20px 60px rgba(0, 0, 0, 0.3), 0 0 0 1px rgba(0, 0, 0, 0.05); display: flex; flex-direction: column; overflow: hidden; animation: slideUp 0.3s cubic-bezier(0.16, 1, 0.3, 1);">
				<div class="data-run-modal-header" style="flex-shrink: 0; display: flex; align-items: center; justify-content: space-between; padding: 22px 32px; border-bottom: 1px solid #f1f5f9; background: #ffffff;">
					<h2 class="data-run-modal-title" style="margin: 0; font-size: 22px; font-weight: 700; color: #0f172a; letter-spacing: -0.02em; display: flex; align-items: center; gap: 12px;">
						<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" style="color: #2563eb;">
							<polygon points="5 3 19 12 5 21 5 3"></polygon>
						</svg>
						Run Pipeline with Selected Data
					</h2>
					<button type="button" class="modal-close-btn data-run-cancel" data-modal-close="data-run" aria-label="Close" style="width: 36px; height: 36px; padding: 0; display: flex; align-items: center; justify-content: center; background: transparent; border: none; border-radius: 8px; cursor: pointer; color: #64748b; transition: all 0.2s cubic-bezier(0.16, 1, 0.3, 1);">
						<svg width="20" height="20" viewBox="0 0 16 16" fill="currentColor">
							<path d="M3.72 3.72a.75.75 0 0 1 1.06 0L8 6.94l3.22-3.22a.749.749 0 0 1 1.275.326.749.749 0 0 1-.215.734L9.06 8l3.22 3.22a.749.749 0 0 1-.326 1.275.749.749 0 0 1-.734-.215L8 9.06l-3.22 3.22a.751.751 0 0 1-1.042-.018.751.751 0 0 1-.018-1.042L6.94 8 3.72 4.78a.75.75 0 0 1 0-1.06Z"/>
						</svg>
					</button>
				</div>
				<div class="data-run-modal-body" style="flex: 1; min-height: 0; overflow-y: auto; overflow-x: hidden; padding: 28px 32px; background: #fafbfc;">
					<div class="data-run-summary" style="background: linear-gradient(135deg, #eff6ff 0%, #dbeafe 100%); border: 1.5px solid #3b82f6; border-radius: 12px; padding: 20px 24px; margin-bottom: 28px;">
						<div style="display: flex; align-items: center; gap: 12px; margin-bottom: 12px;">
							<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" style="color: #2563eb;">
								<path d="M9 11l3 3L22 4"></path>
								<path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"></path>
							</svg>
							<strong style="font-size: 16px; font-weight: 700; color: #1e293b; letter-spacing: -0.01em;">Selected Data</strong>
						</div>
						<div style="font-size: 15px; color: #475569; line-height: 1.6; margin-bottom: 8px;">
							<strong style="color: #0f172a; font-weight: 600;">${fileCount}</strong> genotype file${
								fileCount === 1 ? '' : 's'
							} 
							covering <strong style="color: #0f172a; font-weight: 600;">${uniqueParticipantCount}</strong> participant${
								uniqueParticipantCount === 1 ? '' : 's'
							}
						</div>
						<div style="font-size: 13px; color: #64748b; margin-top: 10px; padding-top: 10px; border-top: 1px solid rgba(59,130,246,0.2); line-height: 1.5;">
							We will generate a temporary samplesheet automatically for this run.
						</div>
					</div>
					<div class="data-run-section" style="margin-bottom: 28px;">
						<h3 style="margin: 0 0 16px 0; font-size: 16px; font-weight: 700; color: #0f172a; letter-spacing: -0.01em; display: flex; align-items: center; gap: 10px;">
							<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="color: #475569;">
								<circle cx="5" cy="12" r="3" />
								<circle cx="19" cy="12" r="3" />
								<line x1="8" y1="12" x2="16" y2="12" />
							</svg>
							Select a Pipeline
						</h3>
						<div class="data-run-pipeline-list" style="display: flex; flex-direction: column; gap: 12px; max-height: 320px; overflow-y: auto; padding-right: 4px;">
							${pipelineOptionsHtml}
						</div>
					</div>
					<div class="data-run-section" style="background: #ffffff; border: 1px solid #e2e8f0; border-radius: 12px; padding: 20px 24px;">
						<h3 style="margin: 0 0 12px 0; font-size: 14px; font-weight: 700; color: #475569; letter-spacing: -0.01em; display: flex; align-items: center; gap: 8px;">
							<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="color: #64748b;">
								<path d="M3 7v10a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-6l-2-2H5a2 2 0 0 0-2 2z"></path>
							</svg>
							Results Directory <span style="font-weight: 400; color: #94a3b8; font-size: 13px;">(optional)</span>
						</h3>
						<p style="font-size: 13px; color: #64748b; margin: 0 0 16px 0; line-height: 1.6;">
							Leave blank to create a timestamped folder inside
							${
								runsBaseDir
									? `<code style="background: #f1f5f9; padding: 4px 8px; border-radius: 6px; font-size: 12px; font-family: 'SF Mono', Monaco, monospace; color: #475569;">${escapeHtml(
											runsBaseDir,
										)}</code>`
									: 'the BioVault runs directory'
							}.
						</p>
						<div class="data-run-results-input" style="display: flex; gap: 10px;">
							<input type="text" id="data-run-results-dir" placeholder="Defaults to BioVault runs folder" style="flex: 1; padding: 12px 16px; border: 1px solid #cbd5e1; border-radius: 8px; font-size: 14px; background: #ffffff; color: #0f172a; transition: all 0.2s;">
							<button id="data-run-results-browse" class="secondary-btn" type="button" style="padding: 12px 20px; white-space: nowrap; font-weight: 600; border-radius: 8px;">Browse…</button>
						</div>
					</div>
				</div>
				<div class="data-run-modal-footer" style="flex-shrink: 0; display: flex; align-items: center; justify-content: space-between; padding: 24px 32px; background: linear-gradient(180deg, #fafbfc 0%, #ffffff 100%); border-top: 1px solid #e5e7eb; box-shadow: 0 -1px 3px rgba(0, 0, 0, 0.02);">
					<div class="data-run-footer-status" style="font-size: 14px; color: #64748b;">Ready to run</div>
					<div style="display: flex; gap: 10px;">
						<button class="btn-secondary data-run-cancel" type="button" style="padding: 12px 24px; font-weight: 600; border-radius: 8px;">Cancel</button>
						<button class="btn-primary" id="data-run-run-btn" type="button" style="padding: 12px 28px; background: linear-gradient(135deg, #2563eb 0%, #1d4ed8 100%); font-weight: 700; box-shadow: 0 2px 8px rgba(37,99,235,0.3); border-radius: 8px; color: white; border: none; display: flex; align-items: center; gap: 8px; transition: all 0.2s;">
							<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
								<polygon points="5 3 19 12 5 21 5 3"></polygon>
							</svg>
							Run Pipeline
						</button>
					</div>
				</div>
			</div>
		`

		document.body.appendChild(modal)

		// Add backdrop click handler
		const backdrop = modal.querySelector('.data-run-backdrop')
		if (backdrop) {
			backdrop.addEventListener('click', () => {
				closeDataRunModal()
			})
		}

		// Add hover effects to pipeline options
		const optionLabels = modal.querySelectorAll('.data-run-pipeline-option')
		function refreshOptionStyles() {
			optionLabels.forEach((label) => {
				const radio = label.querySelector('input[type="radio"]')
				if (radio && radio.checked) {
					label.style.borderColor = '#2563eb'
					label.style.background = 'linear-gradient(135deg, #eff6ff 0%, #dbeafe 100%)'
					label.style.boxShadow = '0 4px 12px rgba(37,99,235,0.2)'
					label.style.transform = 'translateY(-1px)'
				} else {
					const isPreferred = label.dataset.pipelineId === preselectedPipelineId?.toString()
					label.style.borderColor = isPreferred ? '#2563eb' : '#e2e8f0'
					label.style.background = isPreferred
						? 'linear-gradient(135deg, #eff6ff 0%, #dbeafe 100%)'
						: '#ffffff'
					label.style.boxShadow = isPreferred
						? '0 2px 8px rgba(37,99,235,0.1)'
						: '0 1px 3px rgba(0, 0, 0, 0.05)'
					label.style.transform = 'translateY(0)'
				}
			})
		}

		// Add hover effects
		optionLabels.forEach((label) => {
			label.addEventListener('mouseenter', () => {
				if (!label.querySelector('input[type="radio"]')?.checked) {
					label.style.borderColor = '#cbd5e1'
					label.style.boxShadow = '0 4px 12px rgba(0, 0, 0, 0.08)'
					label.style.transform = 'translateY(-1px)'
				}
			})
			label.addEventListener('mouseleave', () => {
				if (!label.querySelector('input[type="radio"]')?.checked) {
					refreshOptionStyles()
				}
			})
		})

		optionLabels.forEach((label) => {
			const radio = label.querySelector('input[type="radio"]')
			const activate = () => {
				optionLabels.forEach((other) => other.classList.remove('selected'))
				label.classList.add('selected')
				radio.checked = true
				refreshOptionStyles()
			}

			label.addEventListener('click', (event) => {
				if (event.target.tagName !== 'INPUT') {
					event.preventDefault()
					activate()
				}
			})

			radio.addEventListener('change', () => {
				if (radio.checked) {
					activate()
				}
			})

			if (radio.checked) {
				label.classList.add('selected')
			}
		})
		refreshOptionStyles()

		// Add input focus effects
		const resultsInput = modal.querySelector('#data-run-results-dir')
		if (resultsInput) {
			resultsInput.addEventListener('focus', () => {
				resultsInput.style.borderColor = '#2563eb'
				resultsInput.style.boxShadow = '0 0 0 3px rgba(37,99,235,0.1)'
			})
			resultsInput.addEventListener('blur', () => {
				resultsInput.style.borderColor = '#cbd5e1'
				resultsInput.style.boxShadow = 'none'
			})
		}

		const browseBtn = modal.querySelector('#data-run-results-browse')
		if (browseBtn) {
			browseBtn.addEventListener('click', async () => {
				try {
					const selected = await dialog.open({
						directory: true,
						multiple: false,
					})
					if (selected) {
						if (Array.isArray(selected)) {
							if (selected[0]) {
								resultsInput.value = selected[0]
							}
						} else {
							resultsInput.value = selected
						}
					}
				} catch (error) {
					console.error('Error selecting results directory:', error)
				}
			})
		}

		modal.querySelectorAll('.data-run-cancel').forEach((btn) => {
			btn.addEventListener('click', () => {
				closeDataRunModal()
			})
		})

		const runBtn = modal.querySelector('#data-run-run-btn')
		runBtn.addEventListener('click', async () => {
			const selectedRadio = modal.querySelector('input[name="data-run-pipeline"]:checked')
			if (!selectedRadio) {
				alert('Please select a pipeline to run.')
				return
			}

			const pipelineId = parseInt(selectedRadio.value, 10)
			if (!Number.isFinite(pipelineId)) {
				alert('Invalid pipeline selection.')
				return
			}

			const resultsDir = resultsInput.value.trim() || null
			const doRun = async () => {
				runBtn.disabled = true
				runBtn.textContent = 'Starting…'
				try {
					const run = await invoke('run_pipeline', {
						pipelineId,
						inputOverrides: {},
						resultsDir,
						selection: {
							fileIds: context.fileIds,
							participantIds: context.participantIds,
						},
					})

					clearDataRunContext()
					closeDataRunModal()

					// Store run ID in sessionStorage for auto-expansion on runs page
					if (typeof sessionStorage !== 'undefined') {
						sessionStorage.setItem('autoExpandRunId', run.id.toString())
					}

					alert(`Pipeline started! Run ID: ${run.id}`)

					if (typeof navigateTo === 'function') {
						navigateTo('runs')
					}
				} catch (error) {
					console.error('Failed to start pipeline:', error)
					alert('Failed to run pipeline: ' + error)
				} finally {
					runBtn.disabled = false
					runBtn.textContent = 'Run Pipeline'
				}
			}

			runBtn.disabled = true
			runBtn.textContent = 'Checking Docker…'
			try {
				const running = await invoke('check_docker_running')
				if (running) {
					await doRun()
				} else {
					runBtn.disabled = false
					runBtn.textContent = 'Run Pipeline'
					await showDockerWarningModal(doRun)
				}
			} catch (err) {
				console.warn('Docker check failed (continuing):', err)
				runBtn.disabled = false
				runBtn.textContent = 'Run Pipeline'
				await showDockerWarningModal(doRun)
			}
		})
	}

	// Show pipeline creation options
	async function showCreatePipelineWizard() {
		showTemplatePipelinePicker()
	}

	async function showTemplatePipelinePicker() {
		// Add CSS for the new pipeline modal if not exists
		if (!document.getElementById('new-pipeline-modal-styles')) {
			const style = document.createElement('style')
			style.id = 'new-pipeline-modal-styles'
			style.textContent = `
				.new-pipeline-modal .modal-backdrop {
					position: absolute;
					top: 0;
					left: 0;
					width: 100%;
					height: 100%;
					background: rgba(0, 0, 0, 0.4);
					backdrop-filter: blur(8px);
					animation: backdropFadeIn 0.2s ease-out;
				}
				@keyframes backdropFadeIn {
					from { opacity: 0; backdrop-filter: blur(0px); }
					to { opacity: 1; backdrop-filter: blur(8px); }
				}
				@keyframes slideUp {
					from { opacity: 0; transform: translateY(24px) scale(0.96); }
					to { opacity: 1; transform: translateY(0) scale(1); }
				}
				.new-pipeline-modal .new-pipeline-modal-panel {
					animation: slideUp 0.3s cubic-bezier(0.16, 1, 0.3, 1);
				}
				.new-pipeline-template-card {
					transition: all 0.2s cubic-bezier(0.16, 1, 0.3, 1);
				}
				.new-pipeline-template-card:hover {
					transform: translateY(-2px);
					box-shadow: 0 8px 24px rgba(37,99,235,0.15) !important;
					border-color: #3b82f6 !important;
				}
				.new-pipeline-template-card:active {
					transform: translateY(0);
				}
				.new-pipeline-option-card {
					transition: all 0.2s cubic-bezier(0.16, 1, 0.3, 1);
				}
				.new-pipeline-option-card:hover {
					transform: translateY(-2px);
					box-shadow: 0 8px 24px rgba(0, 0, 0, 0.12) !important;
					border-color: #cbd5e1 !important;
				}
				.new-pipeline-option-card:active {
					transform: translateY(0);
				}
				.new-pipeline-modal .modal-close-btn:hover {
					background: #f8fafc !important;
					color: #0f172a !important;
					transform: translateY(-1px);
				}
			`
			document.head.appendChild(style)
		}

		const modal = document.createElement('div')
		modal.id = 'pipeline-picker-modal'
		modal.className = 'modal new-pipeline-modal'
		modal.setAttribute('role', 'dialog')
		modal.setAttribute('aria-modal', 'true')
		modal.style.cssText =
			'position: fixed; top: 0; left: 0; width: 100%; height: 100%; display: flex; align-items: center; justify-content: center; z-index: 1000;'

		modal.innerHTML = `
			<div class="modal-backdrop" data-modal-close="new-pipeline"></div>
			<div class="new-pipeline-modal-panel" style="position: relative; width: 900px; max-width: 95vw; max-height: 90vh; background: #ffffff; border-radius: 16px; box-shadow: 0 20px 60px rgba(0, 0, 0, 0.3), 0 0 0 1px rgba(0, 0, 0, 0.05); display: flex; flex-direction: column; overflow: hidden;">
				<div class="new-pipeline-modal-header" style="flex-shrink: 0; display: flex; align-items: center; justify-content: space-between; padding: 22px 32px; border-bottom: 1px solid #f1f5f9; background: #ffffff;">
					<h2 class="new-pipeline-modal-title" style="margin: 0; font-size: 22px; font-weight: 700; color: #0f172a; letter-spacing: -0.02em; display: flex; align-items: center; gap: 12px;">
						<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" style="color: #2563eb;">
							<line x1="12" y1="5" x2="12" y2="19"></line>
							<line x1="5" y1="12" x2="19" y2="12"></line>
						</svg>
						Create New Pipeline
					</h2>
					<button type="button" class="modal-close-btn" data-modal-close="new-pipeline" aria-label="Close" style="width: 36px; height: 36px; padding: 0; display: flex; align-items: center; justify-content: center; background: transparent; border: none; border-radius: 8px; cursor: pointer; color: #64748b; transition: all 0.2s cubic-bezier(0.16, 1, 0.3, 1);">
						<svg width="20" height="20" viewBox="0 0 16 16" fill="currentColor">
							<path d="M3.72 3.72a.75.75 0 0 1 1.06 0L8 6.94l3.22-3.22a.749.749 0 0 1 1.275.326.749.749 0 0 1-.215.734L9.06 8l3.22 3.22a.749.749 0 0 1-.326 1.275.749.749 0 0 1-.734-.215L8 9.06l-3.22 3.22a.751.751 0 0 1-1.042-.018.751.751 0 0 1-.018-1.042L6.94 8 3.72 4.78a.75.75 0 0 1 0-1.06Z"/>
						</svg>
					</button>
				</div>
				<div class="new-pipeline-modal-body" style="flex: 1; min-height: 0; overflow-y: auto; overflow-x: hidden; padding: 28px 32px; background: #fafbfc;">
					<div style="margin-bottom: 24px;">
						<p style="font-size: 15px; color: #475569; line-height: 1.6; margin: 0;">
							Choose a template to get started quickly, or import your own pipeline from GitHub or a local folder.
						</p>
					</div>
					
					<div style="margin-bottom: 32px;">
						<h3 style="margin: 0 0 16px 0; font-size: 16px; font-weight: 700; color: #0f172a; letter-spacing: -0.01em; display: flex; align-items: center; gap: 10px;">
							<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="color: #475569;">
								<rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect>
								<line x1="3" y1="9" x2="21" y2="9"></line>
								<line x1="9" y1="21" x2="9" y2="9"></line>
							</svg>
							Template Pipelines
						</h3>
						<div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: 16px;">
							<button type="button" class="new-pipeline-template-card" onclick="pipelineModule.importTemplatePipeline('apol1')" style="background: linear-gradient(135deg, #ffffff 0%, #f8fafc 100%); border: 2px solid #e2e8f0; border-radius: 12px; padding: 20px; cursor: pointer; text-align: left; display: flex; flex-direction: column; gap: 12px; box-shadow: 0 1px 3px rgba(0, 0, 0, 0.05);">
								<div style="display: flex; align-items: center; gap: 12px;">
									<div style="width: 40px; height: 40px; border-radius: 10px; background: linear-gradient(135deg, #3b82f6 0%, #2563eb 100%); display: flex; align-items: center; justify-content: center; flex-shrink: 0;">
										<img src="assets/icons/dna.svg" alt="DNA icon" style="width: 20px; height: 20px; filter: brightness(0) invert(1);">
									</div>
									<div style="flex: 1; min-width: 0;">
										<div style="font-size: 16px; font-weight: 700; color: #0f172a; margin-bottom: 4px;">APOL1 Classifier</div>
										<div style="font-size: 13px; color: #64748b; line-height: 1.4;">Genetic variant analysis</div>
									</div>
								</div>
							</button>
							<button type="button" class="new-pipeline-template-card" onclick="pipelineModule.importTemplatePipeline('brca')" style="background: linear-gradient(135deg, #ffffff 0%, #f8fafc 100%); border: 2px solid #e2e8f0; border-radius: 12px; padding: 20px; cursor: pointer; text-align: left; display: flex; flex-direction: column; gap: 12px; box-shadow: 0 1px 3px rgba(0, 0, 0, 0.05);">
								<div style="display: flex; align-items: center; gap: 12px;">
									<div style="width: 40px; height: 40px; border-radius: 10px; background: linear-gradient(135deg, #8b5cf6 0%, #7c3aed 100%); display: flex; align-items: center; justify-content: center; flex-shrink: 0;">
										<img src="assets/icons/user-round.svg" alt="User icon" style="width: 20px; height: 20px; filter: brightness(0) invert(1);">
									</div>
									<div style="flex: 1; min-width: 0;">
										<div style="font-size: 16px; font-weight: 700; color: #0f172a; margin-bottom: 4px;">BRCA Classifier</div>
										<div style="font-size: 13px; color: #64748b; line-height: 1.4;">Cancer risk assessment</div>
									</div>
								</div>
							</button>
							<button type="button" class="new-pipeline-template-card" onclick="pipelineModule.importTemplatePipeline('herc2')" style="background: linear-gradient(135deg, #ffffff 0%, #f8fafc 100%); border: 2px solid #e2e8f0; border-radius: 12px; padding: 20px; cursor: pointer; text-align: left; display: flex; flex-direction: column; gap: 12px; box-shadow: 0 1px 3px rgba(0, 0, 0, 0.05);">
								<div style="display: flex; align-items: center; gap: 12px;">
									<div style="width: 40px; height: 40px; border-radius: 10px; background: linear-gradient(135deg, #10b981 0%, #059669 100%); display: flex; align-items: center; justify-content: center; flex-shrink: 0;">
										<img src="assets/icons/scan-eye.svg" alt="Scan eye icon" style="width: 20px; height: 20px; filter: brightness(0) invert(1);">
									</div>
									<div style="flex: 1; min-width: 0;">
										<div style="font-size: 16px; font-weight: 700; color: #0f172a; margin-bottom: 4px;">HERC2 Classifier</div>
										<div style="font-size: 13px; color: #64748b; line-height: 1.4;">Pigmentation analysis</div>
									</div>
								</div>
							</button>
						</div>
					</div>

					<div style="border-top: 1.5px solid #e2e8f0; padding-top: 24px;">
						<h3 style="margin: 0 0 16px 0; font-size: 16px; font-weight: 700; color: #0f172a; letter-spacing: -0.01em; display: flex; align-items: center; gap: 10px;">
							<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="color: #475569;">
								<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>
								<polyline points="17 8 12 3 7 8"></polyline>
								<line x1="12" y1="3" x2="12" y2="15"></line>
							</svg>
							Other Options
						</h3>
						<div style="display: flex; flex-direction: column; gap: 12px;">
							<button type="button" class="new-pipeline-option-card" onclick="pipelineModule.showImportOptions()" style="background: #ffffff; border: 1.5px solid #e2e8f0; border-radius: 12px; padding: 20px; cursor: pointer; text-align: left; display: flex; align-items: center; gap: 16px; box-shadow: 0 1px 3px rgba(0, 0, 0, 0.05);">
								<div style="width: 44px; height: 44px; border-radius: 10px; background: linear-gradient(135deg, #f1f5f9 0%, #e2e8f0 100%); display: flex; align-items: center; justify-content: center; flex-shrink: 0;">
									<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="color: #475569;">
										<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>
										<polyline points="17 8 12 3 7 8"></polyline>
										<line x1="12" y1="3" x2="12" y2="15"></line>
									</svg>
								</div>
								<div style="flex: 1; min-width: 0;">
									<div style="font-size: 15px; font-weight: 700; color: #0f172a; margin-bottom: 4px;">Import Your Own</div>
									<div style="font-size: 13px; color: #64748b; line-height: 1.5;">Import from GitHub, local folder, or create a blank pipeline</div>
								</div>
								<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="color: #94a3b8; flex-shrink: 0;">
									<polyline points="9 18 15 12 9 6"></polyline>
								</svg>
							</button>
						</div>
					</div>
				</div>
			</div>
		`

		document.body.appendChild(modal)

		// Handle backdrop click and escape key
		const backdrop = modal.querySelector('.modal-backdrop')
		const closeBtn = modal.querySelector('.modal-close-btn')
		const closeModal = () => closePipelinePickerModal()

		if (backdrop) {
			backdrop.addEventListener('click', closeModal)
		}
		if (closeBtn) {
			closeBtn.addEventListener('click', closeModal)
		}

		document.addEventListener('keydown', function escapeHandler(e) {
			if (e.key === 'Escape' && document.getElementById('pipeline-picker-modal')) {
				closeModal()
				document.removeEventListener('keydown', escapeHandler)
			}
		})
	}

	async function showImportOptions() {
		closePipelinePickerModal()

		const modal = document.createElement('div')
		modal.id = 'pipeline-import-options-modal'
		modal.className = 'modal new-pipeline-modal'
		modal.setAttribute('role', 'dialog')
		modal.setAttribute('aria-modal', 'true')
		modal.style.cssText =
			'position: fixed; top: 0; left: 0; width: 100%; height: 100%; display: flex; align-items: center; justify-content: center; z-index: 1000;'

		modal.innerHTML = `
			<div class="modal-backdrop" data-modal-close="import-options"></div>
			<div class="new-pipeline-modal-panel" style="position: relative; width: 700px; max-width: 95vw; max-height: 90vh; background: #ffffff; border-radius: 16px; box-shadow: 0 20px 60px rgba(0, 0, 0, 0.3), 0 0 0 1px rgba(0, 0, 0, 0.05); display: flex; flex-direction: column; overflow: hidden;">
				<div class="new-pipeline-modal-header" style="flex-shrink: 0; display: flex; align-items: center; justify-content: space-between; padding: 22px 32px; border-bottom: 1px solid #f1f5f9; background: #ffffff;">
					<h2 class="new-pipeline-modal-title" style="margin: 0; font-size: 22px; font-weight: 700; color: #0f172a; letter-spacing: -0.02em; display: flex; align-items: center; gap: 12px;">
						<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" style="color: #2563eb;">
							<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>
							<polyline points="17 8 12 3 7 8"></polyline>
							<line x1="12" y1="3" x2="12" y2="15"></line>
						</svg>
						Import Pipeline
					</h2>
					<button type="button" class="modal-close-btn" data-modal-close="import-options" aria-label="Close" style="width: 36px; height: 36px; padding: 0; display: flex; align-items: center; justify-content: center; background: transparent; border: none; border-radius: 8px; cursor: pointer; color: #64748b; transition: all 0.2s cubic-bezier(0.16, 1, 0.3, 1);">
						<svg width="20" height="20" viewBox="0 0 16 16" fill="currentColor">
							<path d="M3.72 3.72a.75.75 0 0 1 1.06 0L8 6.94l3.22-3.22a.749.749 0 0 1 1.275.326.749.749 0 0 1-.215.734L9.06 8l3.22 3.22a.749.749 0 0 1-.326 1.275.749.749 0 0 1-.734-.215L8 9.06l-3.22 3.22a.751.751 0 0 1-1.042-.018.751.751 0 0 1-.018-1.042L6.94 8 3.72 4.78a.75.75 0 0 1 0-1.06Z"/>
						</svg>
					</button>
				</div>
				<div class="new-pipeline-modal-body" style="flex: 1; min-height: 0; overflow-y: auto; overflow-x: hidden; padding: 28px 32px; background: #fafbfc;">
					<div style="display: flex; flex-direction: column; gap: 14px;">
						<button type="button" class="new-pipeline-option-card" onclick="pipelineModule.importPipelineFromURL()" style="background: #ffffff; border: 1.5px solid #e2e8f0; border-radius: 12px; padding: 22px; cursor: pointer; text-align: left; display: flex; align-items: center; gap: 16px; box-shadow: 0 1px 3px rgba(0, 0, 0, 0.05);">
							<div style="width: 48px; height: 48px; border-radius: 12px; background: linear-gradient(135deg, #eff6ff 0%, #dbeafe 100%); display: flex; align-items: center; justify-content: center; flex-shrink: 0; border: 1px solid #bfdbfe;">
								<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="color: #2563eb;">
									<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"></path>
									<path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"></path>
								</svg>
							</div>
							<div style="flex: 1; min-width: 0;">
								<div style="font-size: 16px; font-weight: 700; color: #0f172a; margin-bottom: 6px;">Import from GitHub</div>
								<div style="font-size: 13px; color: #64748b; line-height: 1.5;">Download a pipeline and all its steps from a GitHub repository URL</div>
							</div>
							<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="color: #94a3b8; flex-shrink: 0;">
								<polyline points="9 18 15 12 9 6"></polyline>
							</svg>
						</button>
						<button type="button" class="new-pipeline-option-card" onclick="pipelineModule.importExistingPipeline()" style="background: #ffffff; border: 1.5px solid #e2e8f0; border-radius: 12px; padding: 22px; cursor: pointer; text-align: left; display: flex; align-items: center; gap: 16px; box-shadow: 0 1px 3px rgba(0, 0, 0, 0.05);">
							<div style="width: 48px; height: 48px; border-radius: 12px; background: linear-gradient(135deg, #f0fdf4 0%, #dcfce7 100%); display: flex; align-items: center; justify-content: center; flex-shrink: 0; border: 1px solid #bbf7d0;">
								<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="color: #16a34a;">
									<path d="M3 7v10a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-6l-2-2H5a2 2 0 0 0-2 2z"></path>
								</svg>
							</div>
							<div style="flex: 1; min-width: 0;">
								<div style="font-size: 16px; font-weight: 700; color: #0f172a; margin-bottom: 6px;">Browse Local Folder</div>
								<div style="font-size: 13px; color: #64748b; line-height: 1.5;">Import an existing pipeline from your computer</div>
							</div>
							<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="color: #94a3b8; flex-shrink: 0;">
								<polyline points="9 18 15 12 9 6"></polyline>
							</svg>
						</button>
						<button type="button" class="new-pipeline-option-card" onclick="pipelineModule.createBlankPipeline()" style="background: #ffffff; border: 1.5px solid #e2e8f0; border-radius: 12px; padding: 22px; cursor: pointer; text-align: left; display: flex; align-items: center; gap: 16px; box-shadow: 0 1px 3px rgba(0, 0, 0, 0.05);">
							<div style="width: 48px; height: 48px; border-radius: 12px; background: linear-gradient(135deg, #fef3c7 0%, #fde68a 100%); display: flex; align-items: center; justify-content: center; flex-shrink: 0; border: 1px solid #fcd34d;">
								<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" style="color: #d97706;">
									<line x1="12" y1="5" x2="12" y2="19"></line>
									<line x1="5" y1="12" x2="19" y2="12"></line>
								</svg>
							</div>
							<div style="flex: 1; min-width: 0;">
								<div style="font-size: 16px; font-weight: 700; color: #0f172a; margin-bottom: 6px;">Create Blank Pipeline</div>
								<div style="font-size: 13px; color: #64748b; line-height: 1.5;">Start from scratch and add steps manually</div>
							</div>
							<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="color: #94a3b8; flex-shrink: 0;">
								<polyline points="9 18 15 12 9 6"></polyline>
							</svg>
						</button>
					</div>
				</div>
			</div>
		`

		document.body.appendChild(modal)

		// Handle backdrop click and escape key
		const backdrop = modal.querySelector('.modal-backdrop')
		const closeBtn = modal.querySelector('.modal-close-btn')
		const closeModal = () => closeImportOptionsModal()

		if (backdrop) {
			backdrop.addEventListener('click', closeModal)
		}
		if (closeBtn) {
			closeBtn.addEventListener('click', closeModal)
		}

		document.addEventListener('keydown', function escapeHandler(e) {
			if (e.key === 'Escape' && document.getElementById('pipeline-import-options-modal')) {
				closeModal()
				document.removeEventListener('keydown', escapeHandler)
			}
		})
	}

	function closeImportOptionsModal() {
		const modal = document.getElementById('pipeline-import-options-modal')
		if (modal) modal.remove()
	}

	async function importTemplatePipeline(templateName) {
		closePipelinePickerModal()

		const templateUrls = {
			apol1:
				'https://github.com/OpenMined/bioscript/blob/main/examples/apol1/apol1-classifier/pipeline.yaml',
			brca: 'https://github.com/OpenMined/bioscript/blob/main/examples/brca/brca-classifier/pipeline.yaml',
			herc2:
				'https://github.com/OpenMined/bioscript/blob/main/examples/herc2/herc2-classifier/pipeline.yaml',
		}

		const url = templateUrls[templateName]
		if (!url) {
			alert('Invalid template selected')
			return
		}

		// Show loading state
		const loadingHtml = `
			<div id="pipeline-loading-modal" class="modal-overlay" style="display: flex;">
				<div class="modal-content" style="width: 400px; text-align: center;">
					<div class="modal-body" style="padding: 40px 20px;">
						<div style="margin-bottom: 16px;">
							<svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="color: #10b981; animation: spin 1s linear infinite;">
								<circle cx="12" cy="12" r="10" opacity="0.25"></circle>
								<path d="M12 2a10 10 0 0 1 10 10" opacity="0.75"></path>
							</svg>
						</div>
						<h3 style="margin: 0 0 8px 0; font-size: 16px; font-weight: 600; color: #111827;">
							Importing ${templateName.toUpperCase()} Pipeline...
						</h3>
						<p style="margin: 0; font-size: 14px; color: #6b7280;">
							Downloading pipeline and all dependencies
						</p>
					</div>
				</div>
			</div>
			<style>
				@keyframes spin {
					from { transform: rotate(0deg); }
					to { transform: rotate(360deg); }
				}
			</style>
		`
		document.body.insertAdjacentHTML('beforeend', loadingHtml)

		try {
			await submitPipelineURL(false, url)
			const loadingModal = document.getElementById('pipeline-loading-modal')
			if (loadingModal) loadingModal.remove()
		} catch (error) {
			const loadingModal = document.getElementById('pipeline-loading-modal')
			if (loadingModal) loadingModal.remove()
			throw error
		}
	}

	function closePipelinePickerModal() {
		const modal = document.getElementById('pipeline-picker-modal')
		if (modal) modal.remove()
	}

	async function createBlankPipeline() {
		closePipelinePickerModal()
		closeImportOptionsModal()

		const modal = document.createElement('div')
		modal.id = 'pipeline-name-modal'
		modal.className = 'modal new-pipeline-modal'
		modal.setAttribute('role', 'dialog')
		modal.setAttribute('aria-modal', 'true')
		modal.style.cssText =
			'position: fixed; top: 0; left: 0; width: 100%; height: 100%; display: flex; align-items: center; justify-content: center; z-index: 1000;'

		modal.innerHTML = `
			<div class="modal-backdrop" data-modal-close="pipeline-name"></div>
			<div class="new-pipeline-modal-panel" style="position: relative; width: 540px; max-width: 95vw; background: #ffffff; border-radius: 16px; box-shadow: 0 20px 60px rgba(0, 0, 0, 0.3), 0 0 0 1px rgba(0, 0, 0, 0.05); display: flex; flex-direction: column; overflow: hidden;">
				<div class="new-pipeline-modal-header" style="flex-shrink: 0; display: flex; align-items: center; justify-content: space-between; padding: 22px 32px; border-bottom: 1px solid #f1f5f9; background: #ffffff;">
					<h2 class="new-pipeline-modal-title" style="margin: 0; font-size: 22px; font-weight: 700; color: #0f172a; letter-spacing: -0.02em; display: flex; align-items: center; gap: 12px;">
						<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" style="color: #2563eb;">
							<line x1="12" y1="5" x2="12" y2="19"></line>
							<line x1="5" y1="12" x2="19" y2="12"></line>
						</svg>
						Create Blank Pipeline
					</h2>
					<button type="button" class="modal-close-btn" data-modal-close="pipeline-name" aria-label="Close" style="width: 36px; height: 36px; padding: 0; display: flex; align-items: center; justify-content: center; background: transparent; border: none; border-radius: 8px; cursor: pointer; color: #64748b; transition: all 0.2s cubic-bezier(0.16, 1, 0.3, 1);">
						<svg width="20" height="20" viewBox="0 0 16 16" fill="currentColor">
							<path d="M3.72 3.72a.75.75 0 0 1 1.06 0L8 6.94l3.22-3.22a.749.749 0 0 1 1.275.326.749.749 0 0 1-.215.734L9.06 8l3.22 3.22a.749.749 0 0 1-.326 1.275.749.749 0 0 1-.734-.215L8 9.06l-3.22 3.22a.751.751 0 0 1-1.042-.018.751.751 0 0 1-.018-1.042L6.94 8 3.72 4.78a.75.75 0 0 1 0-1.06Z"/>
						</svg>
					</button>
				</div>
				<div class="new-pipeline-modal-body" style="flex: 1; min-height: 0; padding: 28px 32px; background: #fafbfc;">
					<div style="margin-bottom: 20px;">
						<label style="display: block; margin-bottom: 10px; font-weight: 700; color: #0f172a; font-size: 14px; letter-spacing: -0.01em;">
							Pipeline Name
						</label>
						<input 
							type="text" 
							id="pipeline-name-input" 
							placeholder="my-analysis-pipeline"
							style="width: 100%; padding: 12px 16px; border: 1.5px solid #cbd5e1; border-radius: 8px; font-size: 14px; box-sizing: border-box; background: #ffffff; color: #0f172a; font-family: 'SF Mono', Monaco, monospace; transition: all 0.2s;"
							onfocus="this.style.borderColor='#3b82f6'; this.style.boxShadow='0 0 0 3px rgba(59,130,246,0.1)'"
							onblur="this.style.borderColor='#cbd5e1'; this.style.boxShadow='none'"
						>
						<p style="font-size: 13px; color: #64748b; margin-top: 10px; line-height: 1.5;">
							A blank pipeline will be created. You can add steps and configure it after creation.
						</p>
					</div>
				</div>
				<div class="new-pipeline-modal-footer" style="flex-shrink: 0; display: flex; align-items: center; justify-content: flex-end; gap: 10px; padding: 24px 32px; background: linear-gradient(180deg, #fafbfc 0%, #ffffff 100%); border-top: 1px solid #e5e7eb; box-shadow: 0 -1px 3px rgba(0, 0, 0, 0.02);">
					<button type="button" onclick="pipelineModule.closePipelineNameModal()" style="padding: 10px 20px; font-weight: 600; border-radius: 8px; background: white; border: 1.5px solid #cbd5e1; color: #475569; cursor: pointer; transition: all 0.2s;">
						Cancel
					</button>
					<button type="button" onclick="pipelineModule.submitPipelineName()" style="padding: 10px 24px; background: linear-gradient(135deg, #2563eb 0%, #1d4ed8 100%); font-weight: 700; box-shadow: 0 2px 8px rgba(37,99,235,0.3); border-radius: 8px; color: white; border: none; cursor: pointer; display: flex; align-items: center; gap: 8px; transition: all 0.2s;">
						<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
							<line x1="12" y1="5" x2="12" y2="19"></line>
							<line x1="5" y1="12" x2="19" y2="12"></line>
						</svg>
						Create Pipeline
					</button>
				</div>
			</div>
		`

		document.body.appendChild(modal)

		// Handle backdrop click and escape key
		const backdrop = modal.querySelector('.modal-backdrop')
		const closeBtn = modal.querySelector('.modal-close-btn')
		const closeModal = () => closePipelineNameModal()

		if (backdrop) {
			backdrop.addEventListener('click', closeModal)
		}
		if (closeBtn) {
			closeBtn.addEventListener('click', closeModal)
		}

		document.addEventListener('keydown', function escapeHandler(e) {
			if (e.key === 'Escape' && document.getElementById('pipeline-name-modal')) {
				closeModal()
				document.removeEventListener('keydown', escapeHandler)
			}
		})

		// Focus on input
		setTimeout(() => {
			const input = document.getElementById('pipeline-name-input')
			if (input) {
				input.focus()
				input.addEventListener('keypress', (e) => {
					if (e.key === 'Enter') {
						pipelineModule.submitPipelineName()
					}
				})
			}
		}, 100)
	}

	function closePipelineNameModal() {
		const modal = document.getElementById('pipeline-name-modal')
		if (modal) modal.remove()
	}

	async function submitPipelineName() {
		const input = document.getElementById('pipeline-name-input')
		if (!input) return

		const name = input.value.trim()
		if (!name) {
			alert('Please enter a pipeline name')
			return
		}

		try {
			closePipelineNameModal()

			// Create pipeline spec
			const spec = {
				name: name,
				inputs: {},
				steps: [],
			}

			// Invoke the create pipeline command
			const result = await invoke('create_pipeline', {
				request: {
					name: name,
					directory: null,
				},
			})

			// Save the pipeline spec
			await invoke('save_pipeline_editor', {
				pipelineId: result.id,
				pipelinePath: result.pipeline_path,
				spec: spec,
			})

			await loadPipelines()
		} catch (error) {
			console.error('Error creating pipeline:', error)
			const errorMsg = error?.message || error?.toString() || String(error) || 'Unknown error'
			alert('Failed to create pipeline: ' + errorMsg)
		}
	}

	async function importPipelineFromURL() {
		closePipelinePickerModal()
		closeImportOptionsModal()

		const modal = document.createElement('div')
		modal.id = 'url-input-modal'
		modal.className = 'modal new-pipeline-modal'
		modal.setAttribute('role', 'dialog')
		modal.setAttribute('aria-modal', 'true')
		modal.style.cssText =
			'position: fixed; top: 0; left: 0; width: 100%; height: 100%; display: flex; align-items: center; justify-content: center; z-index: 1000;'

		modal.innerHTML = `
			<div class="modal-backdrop" data-modal-close="url-input"></div>
			<div class="new-pipeline-modal-panel" style="position: relative; width: 640px; max-width: 95vw; background: #ffffff; border-radius: 16px; box-shadow: 0 20px 60px rgba(0, 0, 0, 0.3), 0 0 0 1px rgba(0, 0, 0, 0.05); display: flex; flex-direction: column; overflow: hidden;">
				<div class="new-pipeline-modal-header" style="flex-shrink: 0; display: flex; align-items: center; justify-content: space-between; padding: 22px 32px; border-bottom: 1px solid #f1f5f9; background: #ffffff;">
					<h2 class="new-pipeline-modal-title" style="margin: 0; font-size: 22px; font-weight: 700; color: #0f172a; letter-spacing: -0.02em; display: flex; align-items: center; gap: 12px;">
						<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" style="color: #2563eb;">
							<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"></path>
							<path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"></path>
						</svg>
						Import Pipeline from GitHub
					</h2>
					<button type="button" class="modal-close-btn" data-modal-close="url-input" aria-label="Close" style="width: 36px; height: 36px; padding: 0; display: flex; align-items: center; justify-content: center; background: transparent; border: none; border-radius: 8px; cursor: pointer; color: #64748b; transition: all 0.2s cubic-bezier(0.16, 1, 0.3, 1);">
						<svg width="20" height="20" viewBox="0 0 16 16" fill="currentColor">
							<path d="M3.72 3.72a.75.75 0 0 1 1.06 0L8 6.94l3.22-3.22a.749.749 0 0 1 1.275.326.749.749 0 0 1-.215.734L9.06 8l3.22 3.22a.749.749 0 0 1-.326 1.275.749.749 0 0 1-.734-.215L8 9.06l-3.22 3.22a.751.751 0 0 1-1.042-.018.751.751 0 0 1-.018-1.042L6.94 8 3.72 4.78a.75.75 0 0 1 0-1.06Z"/>
						</svg>
					</button>
				</div>
				<div class="new-pipeline-modal-body" style="flex: 1; min-height: 0; padding: 28px 32px; background: #fafbfc;">
					<div style="margin-bottom: 20px;">
						<label style="display: block; margin-bottom: 10px; font-weight: 700; color: #0f172a; font-size: 14px; letter-spacing: -0.01em;">
							GitHub URL to pipeline.yaml
						</label>
						<div style="display: flex; gap: 10px; align-items: center;">
							<input 
								type="text" 
								id="pipeline-url-input" 
								placeholder="https://github.com/OpenMined/biovault/blob/main/cli/examples/pipeline/pipeline.yaml"
								style="flex: 1; padding: 12px 16px; border: 1.5px solid #cbd5e1; border-radius: 8px; font-size: 13px; box-sizing: border-box; font-family: 'SF Mono', Monaco, monospace; background: #ffffff; color: #0f172a; transition: all 0.2s;"
								onfocus="this.style.borderColor='#3b82f6'; this.style.boxShadow='0 0 0 3px rgba(59,130,246,0.1)'"
								onblur="this.style.borderColor='#cbd5e1'; this.style.boxShadow='none'"
							>
							<button 
								type="button"
								onclick="document.getElementById('pipeline-url-input').value = 'https://github.com/OpenMined/biovault/blob/main/cli/examples/pipeline/pipeline.yaml'"
								style="padding: 12px 18px; background: white; border: 1.5px solid #cbd5e1; border-radius: 8px; font-size: 13px; font-weight: 600; color: #475569; cursor: pointer; white-space: nowrap; transition: all 0.2s;"
								onmouseover="this.style.background='#f8fafc'; this.style.borderColor='#94a3b8'"
								onmouseout="this.style.background='white'; this.style.borderColor='#cbd5e1'"
								title="Fill with example pipeline URL"
							>
								Example
							</button>
						</div>
						<div style="margin-top: 14px; padding: 14px 16px; background: linear-gradient(135deg, #eff6ff 0%, #dbeafe 100%); border: 1px solid #bfdbfe; border-radius: 8px;">
							<div style="display: flex; align-items: start; gap: 10px;">
								<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="color: #2563eb; flex-shrink: 0; margin-top: 2px;">
									<path d="M12 16v-4"></path>
									<path d="M12 8h.01"></path>
									<circle cx="12" cy="12" r="10"></circle>
								</svg>
								<div style="flex: 1;">
									<div style="font-size: 13px; color: #1e40af; font-weight: 600; margin-bottom: 4px;">Tip</div>
									<div style="font-size: 12px; color: #1e3a8a; line-height: 1.5;">
										Use GitHub raw URLs (<code style="background: rgba(30,58,138,0.1); padding: 2px 6px; border-radius: 4px; font-family: 'SF Mono', Monaco, monospace;">raw.githubusercontent.com</code>) to import pipelines. This will automatically download the pipeline and all referenced steps.
									</div>
								</div>
							</div>
						</div>
					</div>
				</div>
				<div class="new-pipeline-modal-footer" style="flex-shrink: 0; display: flex; align-items: center; justify-content: flex-end; gap: 10px; padding: 24px 32px; background: linear-gradient(180deg, #fafbfc 0%, #ffffff 100%); border-top: 1px solid #e5e7eb; box-shadow: 0 -1px 3px rgba(0, 0, 0, 0.02);">
					<button type="button" onclick="pipelineModule.closeURLInputModal()" style="padding: 10px 20px; font-weight: 600; border-radius: 8px; background: white; border: 1.5px solid #cbd5e1; color: #475569; cursor: pointer; transition: all 0.2s;">
						Cancel
					</button>
					<button type="button" onclick="pipelineModule.submitPipelineURL()" style="padding: 10px 24px; background: linear-gradient(135deg, #2563eb 0%, #1d4ed8 100%); font-weight: 700; box-shadow: 0 2px 8px rgba(37,99,235,0.3); border-radius: 8px; color: white; border: none; cursor: pointer; display: flex; align-items: center; gap: 8px; transition: all 0.2s;">
						<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
							<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>
							<polyline points="17 8 12 3 7 8"></polyline>
							<line x1="12" y1="3" x2="12" y2="15"></line>
						</svg>
						Import Pipeline
					</button>
				</div>
			</div>
		`

		document.body.appendChild(modal)

		// Handle backdrop click and escape key
		const backdrop = modal.querySelector('.modal-backdrop')
		const closeBtn = modal.querySelector('.modal-close-btn')
		const closeModal = () => closeURLInputModal()

		if (backdrop) {
			backdrop.addEventListener('click', closeModal)
		}
		if (closeBtn) {
			closeBtn.addEventListener('click', closeModal)
		}

		document.addEventListener('keydown', function escapeHandler(e) {
			if (e.key === 'Escape' && document.getElementById('url-input-modal')) {
				closeModal()
				document.removeEventListener('keydown', escapeHandler)
			}
		})

		// Focus on input
		setTimeout(() => {
			const input = document.getElementById('pipeline-url-input')
			if (input) {
				input.focus()
				input.addEventListener('keypress', (e) => {
					if (e.key === 'Enter') {
						pipelineModule.submitPipelineURL()
					}
				})
			}
		}, 100)
	}

	function closeURLInputModal() {
		const modal = document.getElementById('url-input-modal')
		if (modal) modal.remove()
	}

	async function submitPipelineURL(overwrite = false, urlOverride = null) {
		const input = document.getElementById('pipeline-url-input')

		let url = urlOverride
		if (!url) {
			if (!input) return
			url = input.value.trim()
			if (!url) {
				alert('Please enter a URL')
				return
			}
		}

		// Convert GitHub blob URLs to raw URLs
		if (url.includes('github.com') && url.includes('/blob/')) {
			const rawUrl = url.replace('github.com', 'raw.githubusercontent.com').replace('/blob/', '/')
			console.log('🔄 Converted GitHub blob URL to raw URL:', rawUrl)
			url = rawUrl
		}

		try {
			closeURLInputModal()

			// Call CLI function that imports pipeline AND all its step dependencies!
			await invoke('import_pipeline_with_deps', {
				url: url,
				nameOverride: null,
				overwrite: overwrite,
			})

			await loadPipelines()

			console.log('✅ Imported pipeline with all dependencies from URL:', url)
			alert('Pipeline and all its steps imported successfully!')
		} catch (error) {
			console.error('Error importing pipeline from URL:', error)
			const errorMsg = error?.message || error?.toString() || String(error) || 'Unknown error'

			if (errorMsg.includes('already exists')) {
				const shouldOverwrite = await confirmWithDialog(
					`${errorMsg}\n\nDo you want to overwrite it?`,
					{ title: 'Overwrite Pipeline?', type: 'warning' },
				)
				if (shouldOverwrite) {
					await submitPipelineURL(true, url)
					return
				}
			} else {
				let userMessage = 'Failed to import pipeline:\n\n' + errorMsg

				if (errorMsg.includes('not found') || errorMsg.includes('404')) {
					userMessage += '\n\n💡 Tip: Make sure the URL points to a valid pipeline.yaml file.'
				}

				if (url.includes('github.com')) {
					userMessage +=
						'\n\n📝 For GitHub URLs, use the raw content URL:\nhttps://raw.githubusercontent.com/...'
				}

				alert(userMessage)
			}
		}
	}

	async function importExistingPipeline(overwrite = false, selectedPath = null) {
		closePipelinePickerModal()
		closeImportOptionsModal()

		let selected = selectedPath
		try {
			if (!selected) {
				selected = await dialog.open({
					multiple: false,
					directory: false,
					filters: [
						{ name: 'Pipeline or Project YAML', extensions: ['yaml', 'yml'] },
						{ name: 'All Files', extensions: ['*'] },
					],
				})
			}

			if (!selected) {
				return
			}

			if (Array.isArray(selected)) {
				selected = selected[0]
			}

			// Normalize path handling for cross-platform compatibility
			const usesBackslash = selected.includes('\\')
			const normalized = usesBackslash ? selected.replace(/\\/g, '/') : selected
			const segments = normalized.split('/')
			let fileName = segments.length > 0 ? segments[segments.length - 1] : ''
			let parentSegments = segments.slice(0, -1)

			if (!fileName && parentSegments.length > 0) {
				fileName = parentSegments[parentSegments.length - 1] || ''
				parentSegments = parentSegments.slice(0, -1)
			}

			const parentNormalized = parentSegments.join('/')
			const parentPath = usesBackslash ? parentNormalized.replace(/\//g, '\\') : parentNormalized
			const getLastNonEmptySegment = (arr) => {
				for (let i = arr.length - 1; i >= 0; i--) {
					if (arr[i]) {
						return arr[i]
					}
				}
				return ''
			}
			const lastParentName = getLastNonEmptySegment(parentSegments)

			const lowerName = fileName.toLowerCase()
			const isPipelineFile = lowerName === 'pipeline.yaml' || lowerName === 'pipeline.yml'
			const isProjectFile = lowerName === 'project.yaml' || lowerName === 'project.yml'
			const isYamlFile = lowerName.endsWith('.yaml') || lowerName.endsWith('.yml')

			let pipelineDir = selected
			let pipelineFile = null
			let inferredName = lastParentName || fileName || 'imported-pipeline'

			if (isYamlFile) {
				if (parentNormalized) {
					pipelineDir = parentPath
				}

				if (isPipelineFile) {
					pipelineFile = selected
					// Prefer folder name if present, otherwise strip extension
					inferredName = lastParentName || fileName.replace(/\.[^.]+$/, '') || 'imported-pipeline'
				} else if (isProjectFile) {
					inferredName = lastParentName || fileName.replace(/\.[^.]+$/, '') || 'imported-pipeline'
				} else {
					// Other YAML file – treat basename as pipeline name
					inferredName = fileName.replace(/\.[^.]+$/, '') || 'imported-pipeline'
				}
			} else if (!fileName) {
				// If the selection ended with a slash, derive name from the last non-empty segment
				inferredName = lastParentName || 'imported-pipeline'
			}

			if (!pipelineDir) {
				pipelineDir = selected
			}

			const request = {
				name: inferredName || 'imported-pipeline',
				directory: pipelineDir,
				overwrite: overwrite,
			}

			if (pipelineFile) {
				request.pipeline_file = pipelineFile
			}

			await invoke('create_pipeline', { request })

			closePipelinePickerModal()
			await loadPipelines()

			console.log('✅ Imported pipeline:', request.name)
		} catch (error) {
			console.error('Error importing pipeline:', error)
			const errorMsg = error?.message || error?.toString() || String(error) || 'Unknown error'
			if (errorMsg.includes('already exists')) {
				const shouldOverwrite = await confirmWithDialog(
					`${errorMsg}\n\nDo you want to overwrite it?`,
					{ title: 'Overwrite Pipeline?', type: 'warning' },
				)
				if (shouldOverwrite) {
					await importExistingPipeline(true, selected)
					return
				}
			} else {
				alert('Failed to import pipeline: ' + errorMsg)
			}
		}
	}

	// Wizard navigation
	function wizardNext() {
		if (pipelineState.wizardStep < 3) {
			// Validate current step
			if (pipelineState.wizardStep === 0) {
				const name = document.getElementById('pipeline-name').value.trim()
				if (!name) {
					alert('Please enter a pipeline name')
					return
				}
				pipelineState.wizardData.name = name
			}

			pipelineState.wizardStep++
			updateWizardView()
		}
	}

	function wizardBack() {
		if (pipelineState.wizardStep > 0) {
			pipelineState.wizardStep--
			updateWizardView()
		}
	}

	function updateWizardView() {
		// Hide all steps
		document.querySelectorAll('.wizard-step').forEach((step) => {
			step.style.display = 'none'
		})

		// Show current step
		document.getElementById(`step-${pipelineState.wizardStep}`).style.display = 'block'

		// Update buttons
		const backBtn = document.getElementById('wizard-back')
		const nextBtn = document.getElementById('wizard-next')
		const createBtn = document.getElementById('wizard-create')

		backBtn.disabled = pipelineState.wizardStep === 0

		if (pipelineState.wizardStep === 3) {
			nextBtn.style.display = 'none'
			createBtn.style.display = 'inline-block'
			updatePipelinePreview()
		} else {
			nextBtn.style.display = 'inline-block'
			createBtn.style.display = 'none'
		}
	}

	// Add pipeline input
	function addPipelineInput() {
		// Suggest common inputs based on steps
		const suggestedInputs = []
		pipelineState.wizardData.steps.forEach((step) => {
			Object.keys(step.with).forEach((inputKey) => {
				const value = step.with[inputKey]
				if (value.startsWith('inputs.')) {
					const inputName = value.replace('inputs.', '')
					if (!pipelineState.wizardData.inputs[inputName] && !suggestedInputs.includes(inputName)) {
						suggestedInputs.push(inputName)
					}
				}
			})
		})

		let inputName
		if (suggestedInputs.length > 0) {
			inputName = prompt(
				'Input name (suggested: ' + suggestedInputs.join(', ') + '):\n' + 'Or enter a custom name:',
			)
		} else {
			inputName = prompt('Input name (e.g., samplesheet, data_dir):')
		}
		if (!inputName) return

		const inputType = prompt('Input type (File, Directory, String):', 'File')
		if (!inputType) return

		pipelineState.wizardData.inputs[inputName] = inputType
		updatePipelineInputsList()
	}

	function updatePipelineInputsList() {
		const container = document.getElementById('pipeline-inputs-list')
		container.innerHTML = ''

		Object.entries(pipelineState.wizardData.inputs).forEach(([name, type]) => {
			const div = document.createElement('div')
			div.style.cssText =
				'padding: 10px; background: #f5f5f5; margin-bottom: 10px; border-radius: 4px;'
			div.innerHTML = `
				<strong>${name}</strong>: ${type}
				<button class="delete-btn" style="float: right; padding: 2px 8px;"
					onclick="pipelineModule.removePipelineInput('${name}')">
					Remove
				</button>
			`
			container.appendChild(div)
		})
	}

	function removePipelineInput(name) {
		delete pipelineState.wizardData.inputs[name]
		updatePipelineInputsList()
	}

	// Add pipeline step
	async function addPipelineStep() {
		try {
			// Get available projects from database
			const projects = await invoke('get_projects')

			// Create a modal for step configuration
			const modalHtml = `
				<div id="add-step-modal" class="modal-overlay" style="display: flex;">
					<div class="modal-content" style="width: 600px;">
						<div class="modal-header">
							<h2>Add Pipeline Step</h2>
							<button class="modal-close" onclick="pipelineModule.closeAddStepModal()">×</button>
						</div>
						<div class="modal-body">
							<label style="display: block; margin-bottom: 15px;">
								<span style="display: block; margin-bottom: 5px;">Step ID *</span>
								<input type="text" id="step-id-input" placeholder="e.g., filter, count, analyze" style="width: 100%;">
							</label>

							<label style="display: block; margin-bottom: 15px;">
								<span style="display: block; margin-bottom: 5px;">Select Project *</span>
								<select id="project-select" style="width: 100%; margin-bottom: 10px;">
									<option value="">-- Select from registered projects --</option>
									${projects
										.map(
											(p) =>
												`<option value="${p.project_path}">${p.name} (${p.project_path})</option>`,
										)
										.join('')}
									<option value="browse">-- Browse for project folder/yaml --</option>
								</select>
							</label>

							<div style="display: flex; align-items: center; gap: 10px; margin-bottom: 15px;">
								<span style="color: #666;">OR</span>
								<button class="secondary-btn" onclick="pipelineModule.browseForProject()">
									Browse for Project...
								</button>
							</div>

							<div id="selected-project-path" style="padding: 10px; background: #f5f5f5; border-radius: 4px; margin-bottom: 15px; display: none;">
								<strong>Selected:</strong> <span id="project-path-display"></span>
							</div>

							<div id="step-bindings" style="display: none;">
								<h4>Configure Input Bindings</h4>
								<div id="step-bindings-list"></div>

								<h4 style="margin-top: 20px;">Published Outputs (Optional)</h4>
								<div id="step-publish-list">
									<div style="margin-bottom: 10px;">
										<input type="text" id="publish-output-name" placeholder="e.g., filtered_sheet, counted_sheet" style="width: 100%;">
										<small style="color: #666;">Comma-separated list of outputs to publish from this step</small>
									</div>
								</div>

								<h4 style="margin-top: 20px;">Store to Database (Optional)</h4>
								<div style="padding: 10px; background: #f9f9f9; border-radius: 4px;">
									<label style="display: flex; align-items: center; margin-bottom: 10px;">
										<input type="checkbox" id="enable-store" style="margin-right: 10px;">
										<span>Store output to SQL database</span>
									</label>
									<div id="store-config" style="display: none;">
										<label style="display: block; margin-bottom: 10px;">
											<span style="display: block; margin-bottom: 3px; font-size: 13px;">Store Name:</span>
											<input type="text" id="store-name" placeholder="e.g., counts_sql" style="width: 100%;">
										</label>
										<label style="display: block; margin-bottom: 10px;">
											<span style="display: block; margin-bottom: 3px; font-size: 13px;">Source Output:</span>
											<input type="text" id="store-source" placeholder="e.g., counted_sheet" style="width: 100%;">
										</label>
										<label style="display: block; margin-bottom: 10px;">
											<span style="display: block; margin-bottom: 3px; font-size: 13px;">Table Name:</span>
											<input type="text" id="store-table" placeholder="e.g., pipeline_counts_{run_id}" style="width: 100%;">
										</label>
										<label style="display: block; margin-bottom: 10px;">
											<span style="display: block; margin-bottom: 3px; font-size: 13px;">Key Column:</span>
											<input type="text" id="store-key" placeholder="e.g., participant_id" style="width: 100%;">
										</label>
									</div>
								</div>
							</div>
						</div>
						<div class="modal-footer">
							<button class="secondary-btn" onclick="pipelineModule.closeAddStepModal()">
								Cancel
							</button>
							<button class="primary-btn" onclick="pipelineModule.confirmAddStep()">
								Add Step
							</button>
						</div>
					</div>
				</div>
			`

			// Add modal to page
			const modalContainer = document.createElement('div')
			modalContainer.innerHTML = modalHtml
			document.body.appendChild(modalContainer)

			// Handle project selection change
			document.getElementById('project-select').addEventListener('change', async (e) => {
				if (e.target.value === 'browse') {
					await browseForProject()
				} else if (e.target.value) {
					showSelectedProject(e.target.value)
					// Auto-populate step ID from project name if empty
					const stepIdInput = document.getElementById('step-id-input')
					if (!stepIdInput.value) {
						const projectName = e.target.options[e.target.selectedIndex].text.split(' ')[0]
						stepIdInput.value = projectName.toLowerCase().replace(/[^a-z0-9]/g, '-')
					}
				}
			})

			// Handle store checkbox
			document.getElementById('enable-store').addEventListener('change', (e) => {
				const storeConfig = document.getElementById('store-config')
				storeConfig.style.display = e.target.checked ? 'block' : 'none'

				// Generate smart defaults when enabling store
				if (e.target.checked) {
					const stepId = document.getElementById('step-id-input').value
					const publishOutputs = document
						.getElementById('publish-outputs')
						.value.split(',')
						.map((s) => s.trim())
						.filter((s) => s)

					// Set default store name based on step name
					const storeNameInput = document.getElementById('store-name')
					if (!storeNameInput.value && stepId) {
						storeNameInput.value = `store_${stepId}`
					}

					// Set default source - prefer CSV/sheet related outputs
					const storeSourceInput = document.getElementById('store-source')
					if (!storeSourceInput.value) {
						if (publishOutputs.length === 1) {
							// Only one output, use it
							storeSourceInput.value = publishOutputs[0]
						} else if (publishOutputs.length > 1) {
							// Multiple outputs, find CSV/sheet related one
							const csvRelated = publishOutputs.find(
								(output) =>
									output.includes('csv') ||
									output.includes('sheet') ||
									output.includes('table') ||
									output.includes('data'),
							)
							storeSourceInput.value = csvRelated || publishOutputs[0]
						}
					}

					// Set default table name
					const storeTableInput = document.getElementById('store-table')
					if (!storeTableInput.value && stepId) {
						storeTableInput.value = `${stepId}_{run_id}`
					}

					// Set default key column
					const storeKeyInput = document.getElementById('store-key')
					if (!storeKeyInput.value) {
						storeKeyInput.value = 'participant_id'
					}
				}
			})

			// Store selected project path in state for later use
			pipelineState.tempStepProject = null
			pipelineState.tempStepBindings = {}
		} catch (error) {
			console.error('Error adding step:', error)
			alert('Error loading projects: ' + error)
		}
	}

	// Browse for project folder or yaml file
	async function browseForProject() {
		try {
			const selected = await dialog.open({
				multiple: false,
				directory: false,
				filters: [
					{ name: 'Project Files', extensions: ['yaml', 'yml'] },
					{ name: 'All Files', extensions: ['*'] },
				],
			})

			if (selected) {
				// If user selected a project.yaml file, use the parent directory
				let projectPath = selected
				if (selected.endsWith('.yaml') || selected.endsWith('.yml')) {
					// Get parent directory
					projectPath = selected.substring(0, selected.lastIndexOf('/'))
				}

				showSelectedProject(projectPath)
				document.getElementById('project-select').value = ''

				// Auto-populate step ID from folder name if empty
				const stepIdInput = document.getElementById('step-id-input')
				if (!stepIdInput.value) {
					// Get the last folder name from the path
					const folderName = projectPath.split('/').pop() || projectPath.split('\\').pop()
					stepIdInput.value = folderName.toLowerCase().replace(/[^a-z0-9]/g, '-')
				}
			}
		} catch (error) {
			console.error('Error browsing for project:', error)
		}
	}

	// Show selected project and load bindings
	function showSelectedProject(projectPath) {
		pipelineState.tempStepProject = projectPath

		// Show selected path
		const display = document.getElementById('selected-project-path')
		const pathDisplay = document.getElementById('project-path-display')
		display.style.display = 'block'
		pathDisplay.textContent = projectPath

		// Show bindings section
		const bindingsSection = document.getElementById('step-bindings')
		bindingsSection.style.display = 'block'

		// Create binding inputs for common project inputs
		const bindingsList = document.getElementById('step-bindings-list')
		bindingsList.innerHTML = ''

		const commonInputs = ['samplesheet', 'data_dir']
		const isFirstStep = pipelineState.wizardData.steps.length === 0

		commonInputs.forEach((inputName) => {
			let defaultBinding = ''

			if (isFirstStep) {
				// First step usually binds to pipeline inputs
				defaultBinding = `inputs.${inputName}`
			} else {
				// Later steps might bind to previous step outputs
				const prevStep = pipelineState.wizardData.steps[pipelineState.wizardData.steps.length - 1]
				if (inputName === 'samplesheet' && prevStep.id.includes('filter')) {
					defaultBinding = `step.${prevStep.id}.outputs.filtered_sheet`
				} else if (inputName === 'data_dir') {
					defaultBinding = 'inputs.data_dir'
				} else {
					defaultBinding = `inputs.${inputName}`
				}
			}

			const bindingDiv = document.createElement('div')
			bindingDiv.style.marginBottom = '10px'
			bindingDiv.innerHTML = `
				<label style="display: block;">
					<span style="display: block; margin-bottom: 3px; font-size: 13px;">${inputName}:</span>
					<input type="text"
						id="binding-${inputName}"
						value="${defaultBinding}"
						placeholder="e.g., inputs.${inputName} or step.filter.outputs.filtered_sheet"
						style="width: 100%; font-size: 13px;">
				</label>
			`
			bindingsList.appendChild(bindingDiv)
		})
	}

	// Close add step modal
	function closeAddStepModal() {
		const modal = document.getElementById('add-step-modal')
		if (modal) {
			modal.parentElement.remove()
		}
		pipelineState.tempStepProject = null
		pipelineState.tempStepBindings = {}
	}

	// Confirm and add the step
	function confirmAddStep() {
		const stepId = document.getElementById('step-id-input')?.value?.trim()

		if (!stepId) {
			alert('Please enter a Step ID')
			return
		}

		if (!pipelineState.tempStepProject) {
			alert('Please select a project')
			return
		}

		const step = {
			id: stepId,
			uses: pipelineState.tempStepProject,
			with: {},
			// Don't include publish/store if they're empty (CLI parity)
		}

		// Collect bindings
		const commonInputs = ['samplesheet', 'data_dir']
		commonInputs.forEach((inputName) => {
			const value = document.getElementById(`binding-${inputName}`)?.value?.trim()
			if (value) {
				step.with[inputName] = value
			}
		})

		// Collect published outputs
		const publishOutputs = document.getElementById('publish-output-name')?.value?.trim()
		if (publishOutputs) {
			step.publish = {}
			// Parse comma-separated outputs
			publishOutputs.split(',').forEach((output) => {
				const outputName = output.trim()
				if (outputName) {
					// For MVP, assume File type for outputs
					step.publish[outputName] = `File(${outputName}.csv)`
				}
			})
		}

		// Collect store configuration if enabled
		if (document.getElementById('enable-store')?.checked) {
			const storeName = document.getElementById('store-name')?.value?.trim() || 'sql_store'
			const storeSource = document.getElementById('store-source')?.value?.trim()
			const storeTable = document.getElementById('store-table')?.value?.trim()
			const storeKey = document.getElementById('store-key')?.value?.trim()

			if (storeSource && storeTable && storeKey) {
				step.store = {}
				step.store[storeName] = {
					kind: 'sql',
					destination: 'SQL()',
					source: storeSource,
					table_name: storeTable,
					key_column: storeKey,
				}
			}
		}

		pipelineState.wizardData.steps.push(step)
		updatePipelineStepsList()
		closeAddStepModal()
	}

	function updatePipelineStepsList() {
		const container = document.getElementById('pipeline-steps-list')
		container.innerHTML = ''

		pipelineState.wizardData.steps.forEach((step, index) => {
			const div = document.createElement('div')
			div.style.cssText =
				'padding: 15px; background: #f5f5f5; margin-bottom: 10px; border-radius: 4px;'

			const bindings = step.with
				? Object.entries(step.with)
						.map(([key, value]) => `${key}: ${value}`)
						.join(', ')
				: ''

			const hasPublish = step.publish && Object.keys(step.publish).length > 0
			const hasStore = step.store && Object.keys(step.store).length > 0

			div.innerHTML = `
				<strong>Step ${index + 1}: ${step.id}</strong><br>
				Uses: ${step.uses}<br>
				${bindings ? `Bindings: ${bindings}` : 'No bindings'}
				${hasPublish ? `<br>📤 Publishes: ${Object.keys(step.publish).join(', ')}` : ''}
				${hasStore ? `<br>💾 Stores to SQL: ${Object.keys(step.store).join(', ')}` : ''}
				<div style="margin-top: 10px;">
					<button class="secondary-btn" style="padding: 2px 8px;"
						onclick="pipelineModule.moveStepUp(${index})">↑</button>
					<button class="secondary-btn" style="padding: 2px 8px;"
						onclick="pipelineModule.moveStepDown(${index})">↓</button>
					<button class="delete-btn" style="float: right; padding: 2px 8px;"
						onclick="pipelineModule.removeStep(${index})">Remove</button>
				</div>
			`
			container.appendChild(div)
		})
	}

	function removeStep(index) {
		pipelineState.wizardData.steps.splice(index, 1)
		updatePipelineStepsList()
	}

	function moveStepUp(index) {
		if (index > 0) {
			const temp = pipelineState.wizardData.steps[index]
			pipelineState.wizardData.steps[index] = pipelineState.wizardData.steps[index - 1]
			pipelineState.wizardData.steps[index - 1] = temp
			updatePipelineStepsList()
		}
	}

	function moveStepDown(index) {
		if (index < pipelineState.wizardData.steps.length - 1) {
			const temp = pipelineState.wizardData.steps[index]
			pipelineState.wizardData.steps[index] = pipelineState.wizardData.steps[index + 1]
			pipelineState.wizardData.steps[index + 1] = temp
			updatePipelineStepsList()
		}
	}

	// Update preview
	function updatePipelinePreview() {
		const preview = document.getElementById('pipeline-preview')

		// Generate YAML-like preview
		let yaml = `name: ${pipelineState.wizardData.name}\n`

		if (Object.keys(pipelineState.wizardData.inputs).length > 0) {
			yaml += 'inputs:\n'
			Object.entries(pipelineState.wizardData.inputs).forEach(([name, type]) => {
				yaml += `  ${name}: ${type}\n`
			})
		}

		if (pipelineState.wizardData.steps.length > 0) {
			yaml += '\nsteps:\n'
			pipelineState.wizardData.steps.forEach((step) => {
				yaml += `  - id: ${step.id}\n`
				yaml += `    uses: ${step.uses}\n`
				if (step.with && Object.keys(step.with).length > 0) {
					yaml += `    with:\n`
					Object.entries(step.with).forEach(([key, value]) => {
						yaml += `      ${key}: ${value}\n`
					})
				}
				if (step.publish && Object.keys(step.publish).length > 0) {
					yaml += `    publish:\n`
					Object.entries(step.publish).forEach(([key, value]) => {
						yaml += `      ${key}: ${value}\n`
					})
				}
				if (step.store && Object.keys(step.store).length > 0) {
					yaml += `    store:\n`
					Object.entries(step.store).forEach(([storeName, storeConfig]) => {
						yaml += `      ${storeName}:\n`
						yaml += `        kind: ${storeConfig.kind}\n`
						yaml += `        destination: ${storeConfig.destination}\n`
						yaml += `        source: ${storeConfig.source}\n`
						yaml += `        table_name: ${storeConfig.table_name}\n`
						yaml += `        key_column: ${storeConfig.key_column}\n`
					})
				}
			})
		}

		preview.textContent = yaml
	}

	// Create pipeline
	async function createPipeline() {
		try {
			const result = await invoke('create_pipeline', {
				request: {
					name: pipelineState.wizardData.name,
					directory: null,
				},
			})

			// Save the pipeline spec
			const spec = {
				name: pipelineState.wizardData.name,
				inputs: pipelineState.wizardData.inputs,
				steps: pipelineState.wizardData.steps,
			}

			await invoke('save_pipeline_editor', {
				pipelineId: result.id,
				pipelinePath: result.pipeline_path,
				spec: spec,
			})

			closeWizard()
			await loadPipelines()
			alert('Pipeline created successfully!')
		} catch (error) {
			alert('Error creating pipeline: ' + error)
		}
	}

	// Close wizard
	function closeWizard() {
		const modal = document.getElementById('pipeline-wizard-modal')
		if (modal) {
			modal.parentElement.remove()
		}
	}

	// Show pipeline detail view
	async function showPipelineDetails(pipelineId) {
		try {
			const pipeline = pipelineState.pipelines.find((p) => p.id === pipelineId)
			if (!pipeline) {
				console.error('Pipeline not found:', pipelineId)
				return
			}

			pipelineState.currentPipeline = pipeline

			// Hide main view, show detail view
			const mainView = document.getElementById('pipelines-main-view')
			const detailView = document.getElementById('pipeline-detail-view')

			if (mainView) mainView.style.display = 'none'
			if (detailView) detailView.style.display = 'flex'

			renderDataRunBanner()

			// Update header
			const nameEl = document.getElementById('pipeline-detail-name')
			if (nameEl) {
				nameEl.textContent = pipeline.name
			}

			// Update metadata badges
			const stepsCount = pipeline.spec?.steps?.length || 0
			const inputsCount = Object.keys(pipeline.spec?.inputs || {}).length

			const stepsCountEl = document.getElementById('pipeline-steps-count')
			if (stepsCountEl) {
				stepsCountEl.textContent = `${stepsCount} step${stepsCount === 1 ? '' : 's'}`
			}

			const inputsCountEl = document.getElementById('pipeline-inputs-count')
			if (inputsCountEl) {
				inputsCountEl.textContent = `${inputsCount} input${inputsCount === 1 ? '' : 's'}`
			}

			// Load and display steps
			await loadPipelineSteps(pipelineId)

			// Populate left panel (information and parameters)
			await renderPipelineMetadata()
			await renderParameterOverrides()
		} catch (error) {
			console.error('Error showing pipeline details:', error)
		}
	}

	// Render pipeline metadata in the left sidebar
	function renderPipelineMetadata() {
		const metadataContainer = document.getElementById('pipeline-metadata')
		if (!metadataContainer || !pipelineState.currentPipeline) return

		const pipeline = pipelineState.currentPipeline
		const stepsCount = pipeline.spec?.steps?.length || 0
		const inputsCount = Object.keys(pipeline.spec?.inputs || {}).length

		metadataContainer.innerHTML = `
			<div style="display: flex; flex-direction: column; gap: 12px;">
				<div style="display: flex; justify-content: space-between; align-items: center;">
					<span style="font-size: 13px; color: #6b7280;">Steps</span>
					<span style="font-size: 13px; font-weight: 600; color: #111827;">${stepsCount}</span>
				</div>
				<div style="display: flex; justify-content: space-between; align-items: center;">
					<span style="font-size: 13px; color: #6b7280;">Inputs</span>
					<span style="font-size: 13px; font-weight: 600; color: #111827;">${inputsCount}</span>
				</div>
			</div>
		`
	}

	// Load and render parameter overrides
	async function renderParameterOverrides() {
		const paramsList = document.getElementById('config-parameters-list')
		const paramCount = document.getElementById('param-override-count')
		if (!paramsList || !pipelineState.currentPipeline) return

		const pipelineSpec = pipelineState.currentPipeline.spec
		const stepParameters = []

		if (pipelineSpec && pipelineSpec.steps) {
			for (const step of pipelineSpec.steps) {
				try {
					const projectSpec = await invoke('load_project_editor', {
						projectPath: step.uses,
					})
					const params = projectSpec.metadata?.parameters || []
					params.forEach((param) => {
						stepParameters.push({
							stepId: step.id,
							paramName: param.name,
							paramType: param.type || 'String',
							default: param.default || '',
							description: param.description || '',
						})
					})
				} catch (e) {
					console.error(`Failed to load parameters for step ${step.id}:`, e)
				}
			}
		}

		if (paramCount) {
			paramCount.textContent = `(${stepParameters.length})`
		}

		if (stepParameters.length === 0) {
			paramsList.innerHTML = '<p class="config-hint">No parameters available to override</p>'
			return
		}

		paramsList.innerHTML = stepParameters
			.map((param) => {
				return `
				<div class="config-parameter-item">
					<div class="config-parameter-label">
						<span>${param.paramName}</span>
						<span class="config-parameter-step">${param.stepId}</span>
					</div>
					<input 
						type="text" 
						class="config-parameter-input"
						id="config-param-${param.stepId}-${param.paramName}"
						placeholder="${param.default || 'Override value...'}"
						title="${param.description}"
						value=""
						autocomplete="off"
					/>
				</div>
			`
			})
			.join('')
	}

	// Show add/edit input modal
	function showPipelineInputModal(existingName = null) {
		const isEdit = existingName !== null
		const existingInput = isEdit ? pipelineState.currentPipeline.spec?.inputs?.[existingName] : null
		const inputType =
			typeof existingInput === 'string' ? existingInput : existingInput?.type || 'File'
		const inputDefault =
			typeof existingInput === 'object' && existingInput?.default ? existingInput.default : ''

		const modalHtml = `
			<div id="pipeline-input-modal" class="modal-overlay" style="display: flex;">
				<div class="modal-content" style="width: 500px;">
					<div class="modal-header">
						<h2>${isEdit ? 'Edit' : 'Add'} Pipeline Input</h2>
						<button class="modal-close" onclick="pipelineModule.closePipelineInputModal()">×</button>
					</div>
					<div class="modal-body">
						<div style="display: flex; flex-direction: column; gap: 16px;">
							<div>
								<label style="display: block; margin-bottom: 6px; font-weight: 600; color: #374151;">
									Input Name
								</label>
								<input 
									type="text" 
									id="input-name-field" 
									value="${existingName || ''}"
									placeholder="samplesheet"
									${isEdit ? 'readonly' : ''}
									autocomplete="off"
									autocorrect="off"
									autocapitalize="off"
									spellcheck="false"
									style="width: 100%; padding: 8px 12px; border: 1px solid #e5e7eb; border-radius: 6px; font-size: 14px; ${
										isEdit ? 'background: #f9fafb; color: #9ca3af;' : ''
									}"
								>
							</div>
							<div>
								<label style="display: block; margin-bottom: 6px; font-weight: 600; color: #374151;">
									Type
								</label>
								<select 
									id="input-type-field"
									style="width: 100%; padding: 8px 12px; border: 1px solid #e5e7eb; border-radius: 6px; font-size: 14px;"
								>
									<option value="File" ${inputType === 'File' ? 'selected' : ''}>File</option>
									<option value="Directory" ${inputType === 'Directory' ? 'selected' : ''}>Directory</option>
									<option value="String" ${inputType === 'String' ? 'selected' : ''}>String</option>
									<option value="Bool" ${inputType === 'Bool' ? 'selected' : ''}>Bool</option>
								</select>
							</div>
							<div>
								<label style="display: block; margin-bottom: 6px; font-weight: 600; color: #374151;">
									Default Value (optional)
								</label>
								<input 
									type="text" 
									id="input-default-field" 
									value="${inputDefault || ''}"
									placeholder="e.g., File(default.csv) or /path/to/file"
									autocomplete="off"
									autocorrect="off"
									autocapitalize="off"
									spellcheck="false"
									style="width: 100%; padding: 8px 12px; border: 1px solid #e5e7eb; border-radius: 6px; font-size: 13px; font-family: 'SF Mono', Monaco, monospace;"
								>
								<p style="font-size: 12px; color: #9ca3af; margin-top: 4px;">Leave empty for required inputs</p>
							</div>
						</div>
					</div>
					<div class="modal-footer">
						<button class="secondary-btn" onclick="pipelineModule.closePipelineInputModal()">Cancel</button>
						<button class="primary-btn" onclick="pipelineModule.savePipelineInput(${isEdit}, '${
							existingName || ''
						}')">${isEdit ? 'Update' : 'Add'} Input</button>
					</div>
				</div>
			</div>
		`

		document.body.insertAdjacentHTML('beforeend', modalHtml)

		setTimeout(() => {
			const nameInput = document.getElementById('input-name-field')
			if (nameInput && !isEdit) nameInput.focus()
		}, 100)
	}

	function closePipelineInputModal() {
		const modal = document.getElementById('pipeline-input-modal')
		if (modal) modal.remove()
	}

	async function savePipelineInput(isEdit, oldName) {
		const nameInput = document.getElementById('input-name-field')
		const typeSelect = document.getElementById('input-type-field')
		const defaultInput = document.getElementById('input-default-field')

		const name = nameInput.value.trim()
		const type = typeSelect.value
		const defaultValue = defaultInput.value.trim()

		if (!name) {
			alert('Please enter an input name')
			return
		}

		try {
			// Load current pipeline
			const editorData = await invoke('load_pipeline_editor', {
				pipelineId: pipelineState.currentPipeline.id,
			})

			// Initialize inputs if needed
			if (!editorData.spec.inputs) {
				editorData.spec.inputs = {}
			}

			// Remove old name if editing
			if (isEdit && oldName && oldName !== name) {
				delete editorData.spec.inputs[oldName]
			}

			// Add/update input
			if (defaultValue) {
				editorData.spec.inputs[name] = {
					type: type,
					default: defaultValue,
				}
			} else {
				editorData.spec.inputs[name] = type
			}

			// Save
			await invoke('save_pipeline_editor', {
				pipelineId: pipelineState.currentPipeline.id,
				pipelinePath: pipelineState.currentPipeline.pipeline_path,
				spec: editorData.spec,
			})

			// Refresh
			await loadPipelines()
			const updated = pipelineState.pipelines.find((p) => p.id === pipelineState.currentPipeline.id)
			if (updated) {
				pipelineState.currentPipeline = updated
			}
			await loadPipelineSteps(pipelineState.currentPipeline.id)

			closePipelineInputModal()
			console.log('✅ Saved pipeline input:', name)
		} catch (error) {
			console.error('Error saving input:', error)
			alert('Failed to save input: ' + error)
		}
	}

	function editPipelineInput(inputName) {
		showPipelineInputModal(inputName)
	}

	// Show pipeline YAML viewer/editor
	async function showPipelineYAMLModal() {
		if (!pipelineState.currentPipeline) return

		try {
			// Get the current YAML
			const spec = pipelineState.currentPipeline.spec
			const yamlContent = `name: ${spec.name}
inputs:${
				Object.keys(spec.inputs || {}).length > 0
					? '\n' +
						Object.entries(spec.inputs)
							.map(([k, v]) => {
								if (typeof v === 'string') {
									return `  ${k}: ${v}`
								} else {
									return `  ${k}:\n    type: ${v.type}\n    default: ${v.default}`
								}
							})
							.join('\n')
					: ' {}'
			}
steps:${
				(spec.steps || []).length > 0
					? '\n' +
						spec.steps
							.map((s) => {
								let stepYaml = `- id: ${s.id}\n  uses: ${s.uses || ''}`
								if (s.with && Object.keys(s.with).length > 0) {
									stepYaml +=
										'\n  with:\n' +
										Object.entries(s.with)
											.map(([k, v]) => `    ${k}: ${v}`)
											.join('\n')
								}
								return stepYaml
							})
							.join('\n')
					: ' []'
			}`

			const yamlPath = pipelineState.currentPipeline.pipeline_path + '/pipeline.yaml'

			const modalHtml = `
				<div id="yaml-viewer-modal" class="modal-overlay" style="display: flex;">
					<div class="modal-content" style="width: 800px; max-height: 85vh;">
						<div class="modal-header">
							<h2>Pipeline YAML</h2>
							<button class="modal-close" onclick="pipelineModule.closeYAMLViewerModal()">×</button>
						</div>
						<div class="modal-body" style="max-height: 65vh; overflow-y: auto;">
							<div style="display: flex; justify-content: flex-end; margin-bottom: 12px;">
								<button class="secondary-btn" onclick="pipelineModule.openYAMLInVSCode('${yamlPath}')">
									<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
										<path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path>
										<path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path>
									</svg>
									Edit in VSCode
								</button>
							</div>
							<pre style="background: #1e1e1e; color: #d4d4d4; padding: 16px; border-radius: 8px; font-size: 13px; font-family: 'SF Mono', Monaco, monospace; line-height: 1.6; overflow-x: auto; margin: 0;">${yamlContent}</pre>
						</div>
						<div class="modal-footer">
							<button class="secondary-btn" onclick="pipelineModule.closeYAMLViewerModal()">Close</button>
						</div>
					</div>
				</div>
			`

			document.body.insertAdjacentHTML('beforeend', modalHtml)
		} catch (error) {
			console.error('Error showing YAML:', error)
			alert('Failed to show YAML: ' + error)
		}
	}

	function closeYAMLViewerModal() {
		const modal = document.getElementById('yaml-viewer-modal')
		if (modal) modal.remove()
	}

	async function openYAMLInVSCode(yamlPath) {
		try {
			await invoke('open_in_vscode', { path: yamlPath })
			closeYAMLViewerModal()
		} catch (error) {
			console.error('Error opening in VSCode:', error)
			alert(error.toString())
		}
	}

	async function openPipelineYAMLInVSCode() {
		if (!pipelineState.currentPipeline) return

		try {
			const yamlPath = pipelineState.currentPipeline.pipeline_path + '/pipeline.yaml'
			await invoke('open_in_vscode', { path: yamlPath })
		} catch (error) {
			console.error('Error opening pipeline YAML in VSCode:', error)
			alert('Failed to open in VSCode: ' + error.toString())
		}
	}

	async function loadPipelineSteps(pipelineId) {
		try {
			const pipeline = pipelineState.pipelines.find((p) => p.id === pipelineId)
			if (!pipeline) return

			const stepsContainer = document.getElementById('pipeline-steps-list')
			if (!stepsContainer) return

			const steps = pipeline.spec?.steps || []

			if (steps.length === 0) {
				stepsContainer.innerHTML = `
				<div style="text-align: center; padding: 40px; color: #9ca3af;">
					<p>No steps in this pipeline yet.</p>
					<p style="font-size: 13px; margin-top: 8px;">Click "+ Add Step" above to add your first step.</p>
				</div>
			`
				return
			}

			stepsContainer.innerHTML = ''

			steps.forEach((step, index) => {
				const stepDiv = document.createElement('div')
				stepDiv.className = 'pipeline-step-item'

				const stepName = step.id || `step-${index + 1}`
				const stepUses = step.uses || 'Unknown step'

				// Parse project name and version from uses field (supports name@version syntax)
				let projectName = stepUses
				let projectVersion = null
				if (stepUses.includes('@')) {
					const parts = stepUses.split('@')
					projectName = parts[0]
					projectVersion = parts[1]
				}

				// Count configuration details
				const bindingCount = Object.keys(step.with || {}).length
				const publishCount = Object.keys(step.publish || {}).length
				const hasSQL = step.store && Object.keys(step.store).length > 0

				// Build status badges
				const statusBadges = []

				if (bindingCount > 0) {
					statusBadges.push(
						`<span class="success-badge">✓ ${bindingCount} input${
							bindingCount === 1 ? '' : 's'
						} bound</span>`,
					)
				} else {
					statusBadges.push(`<span class="warning-badge">⚠️ No inputs bound</span>`)
				}

				if (publishCount > 0) {
					statusBadges.push(
						`<span class="info-badge">📤 ${publishCount} output${
							publishCount === 1 ? '' : 's'
						} published</span>`,
					)
				}

				if (hasSQL) {
					statusBadges.push(`<span class="info-badge">💾 SQL storage</span>`)
				}

				stepDiv.innerHTML = `
			<div class="pipeline-step-header">
				<div class="pipeline-step-number">${index + 1}</div>
				<div class="pipeline-step-info">
					<h4>${stepName}</h4>
					<p>Uses: ${projectName}${
						projectVersion ? `<span class="version-tag">v${projectVersion}</span>` : ''
					}</p>
					<div class="step-status-badges">${statusBadges.join('')}</div>
				</div>
					<button class="pipeline-step-menu-btn" data-step-index="${index}">
						<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
							<circle cx="12" cy="5" r="2"/>
							<circle cx="12" cy="12" r="2"/>
							<circle cx="12" cy="19" r="2"/>
						</svg>
					</button>
				</div>
				<div class="pipeline-step-config" id="step-config-${index}" style="display: none;">
					<!-- Configuration will be loaded here when expanded -->
				</div>
			`

				stepsContainer.appendChild(stepDiv)

				// Add menu button click handler
				const menuBtn = stepDiv.querySelector('.pipeline-step-menu-btn')
				menuBtn?.addEventListener('click', (e) => {
					e.stopPropagation()
					showStepMenu(e, index, step)
				})

				// Add header click handler to toggle accordion
				const header = stepDiv.querySelector('.pipeline-step-header')
				header?.addEventListener('click', (e) => {
					// Don't toggle if clicking the menu button
					if (e.target.closest('.pipeline-step-menu-btn')) return
					toggleStepConfig(index)
				})
			})
		} catch (error) {
			console.error('Error loading pipeline steps:', error)
		}
	}

	// Show step context menu
	function showStepMenu(event, stepIndex) {
		// Remove any existing menu
		const existingMenu = document.querySelector('.step-context-menu')
		if (existingMenu) existingMenu.remove()

		const menu = document.createElement('div')
		menu.className = 'step-context-menu context-menu'
		menu.style.position = 'fixed'
		menu.style.left = `${event.clientX}px`
		menu.style.top = `${event.clientY}px`

		menu.innerHTML = `
		<button class="context-menu-item danger" data-action="remove">
			<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
				<polyline points="3 6 5 6 21 6"></polyline>
				<path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
			</svg>
			Remove Step
		</button>
	`

		document.body.appendChild(menu)

		// Position menu to stay on screen
		const rect = menu.getBoundingClientRect()
		if (rect.right > window.innerWidth) {
			menu.style.left = `${window.innerWidth - rect.width - 10}px`
		}
		if (rect.bottom > window.innerHeight) {
			menu.style.top = `${window.innerHeight - rect.height - 10}px`
		}

		// Add action handlers
		menu.querySelectorAll('.context-menu-item').forEach((item) => {
			item.addEventListener('click', async () => {
				const action = item.getAttribute('data-action')
				menu.remove()

				switch (action) {
					case 'remove':
						removePipelineStep(stepIndex)
						break
				}
			})
		})

		// Close on click outside
		setTimeout(() => {
			document.addEventListener('click', () => menu.remove(), { once: true })
		}, 0)
	}

	// Toggle step configuration accordion
	async function toggleStepConfig(stepIndex) {
		const configDiv = document.getElementById(`step-config-${stepIndex}`)
		if (!configDiv) return

		// Close all other configs
		document.querySelectorAll('.pipeline-step-config').forEach((div, idx) => {
			if (idx !== stepIndex && div.style.display !== 'none') {
				div.style.display = 'none'
				div.innerHTML = ''
			}
		})

		// Toggle this one
		if (configDiv.style.display === 'none') {
			// Load and show config
			await loadStepConfigInline(stepIndex, configDiv)
			configDiv.style.display = 'block'
		} else {
			// Hide config
			configDiv.style.display = 'none'
			configDiv.innerHTML = ''
		}
	}

	// Load step configuration inline
	async function loadStepConfigInline(stepIndex, container) {
		if (!pipelineState.currentPipeline || !pipelineState.currentPipeline.spec) return

		const step = pipelineState.currentPipeline.spec.steps[stepIndex]
		if (!step) return

		// Show loading state
		container.innerHTML = `
			<div class="inline-config-content">
				<div class="inline-config-loading">
					<div class="spinner"></div>
					<p>Loading configuration...</p>
				</div>
			</div>
		`

		try {
			// Load the project spec
			const projectSpec = await invoke('load_project_editor', {
				projectPath: step.uses,
			})

			// Get inputs and parameters
			const projectInputs = projectSpec.metadata?.inputs || []
			const projectParams = projectSpec.metadata?.parameters || []

			// Build bindings status
			const bindingsHtml =
				projectInputs.length > 0
					? projectInputs
							.map((input) => {
								const binding = step.with?.[input.name] || ''
								const isBound = !!binding
								const statusClass = isBound ? 'bound' : 'unbound'
								const statusText = isBound ? binding : 'Not configured'

								return `
						<div class="inline-binding-item ${statusClass}">
							<div class="inline-binding-header">
								<span class="inline-binding-name">${input.name}</span>
								<span class="inline-binding-type">${input.type || 'String'}</span>
							</div>
							<div class="inline-binding-value">${statusText}</div>
						</div>
					`
							})
							.join('')
					: '<p class="inline-empty">No inputs defined</p>'

			// Build parameters display (read-only)
			const paramsHtml =
				projectParams.length > 0
					? `
					<details class="inline-params-section">
						<summary class="inline-section-summary">
							<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
								<circle cx="12" cy="12" r="3" />
								<path d="M12 1v6m0 6v6m6.36-15.36-4.24 4.24m-4.24 4.24-4.24 4.24m15.36 0-4.24-4.24m-4.24-4.24-4.24-4.24" />
							</svg>
							<span>Parameters (${projectParams.length})</span>
						</summary>
						<div class="inline-params-list">
							${projectParams
								.map(
									(param) => `
								<div class="inline-param-item">
									<span class="inline-param-name">${param.name}</span>
									<span class="inline-param-default">${param.default || 'No default'}</span>
								</div>
							`,
								)
								.join('')}
						</div>
					</details>
				`
					: ''

			// Build the inline UI
			container.innerHTML = `
				<div class="inline-config-content">
					<!-- Quick Actions Bar -->
					<div class="inline-actions-bar">
						<button class="inline-action-btn" data-action="jupyter">
							<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
								<circle cx="12" cy="12" r="10"/>
								<circle cx="12" cy="12" r="4" fill="currentColor"/>
							</svg>
							Jupyter
						</button>
						<button class="inline-action-btn" data-action="vscode">
							<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
								<path d="M18 3L6 12L18 21V3Z"/>
							</svg>
							VSCode
						</button>
						<button class="inline-action-btn primary" data-action="configure">
							<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
								<circle cx="12" cy="12" r="3" />
								<path d="M12 1v6m0 6v6" />
							</svg>
							Configure Bindings
						</button>
					</div>

					<!-- Input Bindings -->
					<div class="inline-section">
						<div class="inline-section-header">
							<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
								<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
								<polyline points="7 10 12 15 17 10" />
								<line x1="12" y1="15" x2="12" y2="3" />
							</svg>
							<h4>Input Bindings</h4>
						</div>
						<div class="inline-bindings-list">
							${bindingsHtml}
						</div>
					</div>

					<!-- Parameters (collapsible) -->
					${paramsHtml}
				</div>
			`

			// Attach action handlers
			container.querySelectorAll('.inline-action-btn').forEach((btn) => {
				btn.addEventListener('click', async (e) => {
					e.stopPropagation()
					const action = btn.getAttribute('data-action')

					switch (action) {
						case 'jupyter':
							await openStepInJupyter(step)
							break
						case 'vscode':
							await openStepInVSCode(step)
							break
						case 'configure':
							configureStepBindings(stepIndex)
							break
					}
				})
			})
		} catch (error) {
			console.error('Error loading step config:', error)
			container.innerHTML = `
				<div class="inline-config-content">
					<p class="inline-error">
						Failed to load configuration: ${error.message}
					</p>
				</div>
			`
		}
	}

	// Helper function to open step in Jupyter from menu
	async function openStepInJupyter(step) {
		try {
			// Load the project spec to get the path
			const projectSpec = await invoke('load_project_editor', {
				projectPath: step.uses,
			})

			const projectPath = projectSpec.project_path
			if (!projectPath) {
				throw new Error('Project path not available')
			}

			console.log('🚀 Launching Jupyter for step at:', projectPath)

			await invoke('launch_jupyter', {
				projectPath: projectPath,
			})
		} catch (error) {
			console.error('Error launching Jupyter:', error)
			alert('Failed to launch Jupyter: ' + error.toString())
		}
	}

	// Helper function to open step in VSCode from menu
	async function openStepInVSCode(step) {
		try {
			// Load the project spec to get the path
			const projectSpec = await invoke('load_project_editor', {
				projectPath: step.uses,
			})

			const projectPath = projectSpec.project_path
			if (!projectPath) {
				throw new Error('Project path not available')
			}

			console.log('🚀 Opening VSCode for step at:', projectPath)

			await _open(projectPath)
		} catch (error) {
			console.error('Error opening VSCode:', error)
			alert('Failed to open VSCode: ' + error.toString())
		}
	}

	// Validate pipeline configuration
	async function validatePipelineConfig(spec) {
		const validation = {
			isValid: true,
			issues: [],
			warnings: [],
			steps: [],
		}

		const steps = spec.steps || []

		for (let i = 0; i < steps.length; i++) {
			const step = steps[i]
			const stepValidation = {
				stepId: step.id || `step-${i + 1}`,
				status: 'ok',
				issues: [],
			}

			// Check if step has bindings
			const bindingCount = Object.keys(step.with || {}).length
			if (bindingCount === 0) {
				stepValidation.status = 'warning'
				stepValidation.issues.push('No input bindings configured')
				validation.warnings.push(`Step "${stepValidation.stepId}": No input bindings`)
			}

			// Try to load project spec to validate bindings
			try {
				const projectSpec = await invoke('load_project_editor', {
					projectPath: step.uses,
				})

				const requiredInputs =
					projectSpec.metadata?.inputs?.filter((i) => !i.type?.endsWith('?')) || []
				const boundInputs = Object.keys(step.with || {})

				// Check for missing required inputs
				requiredInputs.forEach((input) => {
					if (!boundInputs.includes(input.name)) {
						stepValidation.status = 'error'
						stepValidation.issues.push(`Missing required input: ${input.name}`)
						validation.issues.push(
							`Step "${stepValidation.stepId}": Missing required input "${input.name}"`,
						)
						validation.isValid = false
					}
				})

				// Check for extra bindings
				boundInputs.forEach((bindingName) => {
					const inputExists = projectSpec.metadata?.inputs?.find((i) => i.name === bindingName)
					if (!inputExists) {
						stepValidation.status = stepValidation.status === 'error' ? 'error' : 'warning'
						stepValidation.issues.push(`Unknown input: ${bindingName}`)
						validation.warnings.push(
							`Step "${stepValidation.stepId}": Unknown input "${bindingName}"`,
						)
					}
				})
			} catch (error) {
				stepValidation.status = 'error'
				stepValidation.issues.push(`Cannot load project: ${step.uses}`)
				validation.issues.push(`Step "${stepValidation.stepId}": Cannot load project`)
				validation.isValid = false
			}

			validation.steps.push(stepValidation)
		}

		return validation
	}

	// Show validation modal
	async function showValidationModal(pipelineName, validation) {
		const statusIcon = validation.isValid
			? '<div style="width: 48px; height: 48px; background: linear-gradient(135deg, #10b981 0%, #059669 100%); border-radius: 50%; display: flex; align-items: center; justify-content: center; color: white; font-size: 24px;">✓</div>'
			: '<div style="width: 48px; height: 48px; background: linear-gradient(135deg, #ef4444 0%, #dc2626 100%); border-radius: 50%; display: flex; align-items: center; justify-content: center; color: white; font-size: 24px;">!</div>'

		const statusText = validation.isValid
			? '<h3 style="color: #065f46; margin: 0;">Ready to Run</h3><p style="color: #6b7280; margin: 4px 0 0 0; font-size: 14px;">All steps are properly configured</p>'
			: '<h3 style="color: #dc2626; margin: 0;">Configuration Issues</h3><p style="color: #6b7280; margin: 4px 0 0 0; font-size: 14px;">Please fix these issues before running</p>'

		const stepsHtml = validation.steps
			.map((step) => {
				const statusBadge =
					step.status === 'ok'
						? '<span class="success-badge">✓ Configured</span>'
						: step.status === 'warning'
							? '<span class="warning-badge">⚠️ Warnings</span>'
							: '<span class="error-badge">❌ Issues</span>'

				const issuesHtml =
					step.issues.length > 0
						? `<ul style="margin: 8px 0 0 20px; font-size: 13px; color: #6b7280;">${step.issues
								.map((issue) => `<li>${escapeHtml(issue)}</li>`)
								.join('')}</ul>`
						: ''

				return `
				<div style="padding: 12px; background: white; border: 1px solid #e5e7eb; border-radius: 6px; margin-bottom: 8px;">
					<div style="display: flex; justify-content: space-between; align-items: center;">
						<strong style="font-size: 14px; color: #111827;">${escapeHtml(step.stepId)}</strong>
						${statusBadge}
					</div>
					${issuesHtml}
				</div>
			`
			})
			.join('')

		const modalHtml = `
			<div id="validation-modal" class="modal-overlay" style="display: flex;">
				<div class="modal-content" style="width: 600px; max-height: 80vh;">
					<div class="modal-header">
						<h2>Pipeline Validation</h2>
						<button class="modal-close" onclick="pipelineModule.closeValidationModal()">×</button>
					</div>
					<div class="modal-body" style="max-height: 60vh; overflow-y: auto;">
						<div style="display: flex; align-items: center; gap: 16px; padding: 20px; background: #f9fafb; border-radius: 8px; margin-bottom: 20px;">
							${statusIcon}
							<div>${statusText}</div>
						</div>

						<h4 style="margin: 0 0 12px 0; font-size: 15px; color: #374151;">Step Configuration Status</h4>
						${stepsHtml}

						${
							validation.warnings.length > 0
								? `
							<div style="margin-top: 16px; padding: 12px; background: #fffbeb; border: 1px solid #fbbf24; border-radius: 6px;">
								<strong style="color: #92400e; font-size: 13px;">⚠️ Warnings:</strong>
								<ul style="margin: 8px 0 0 20px; font-size: 13px; color: #92400e;">
									${validation.warnings.map((w) => `<li>${escapeHtml(w)}</li>`).join('')}
								</ul>
							</div>
						`
								: ''
						}
					</div>
					<div class="modal-footer">
						<button class="secondary-btn" onclick="pipelineModule.closeValidationModal()">Cancel</button>
						<button class="primary-btn" onclick="pipelineModule.confirmValidationAndRun()" ${
							!validation.isValid ? 'disabled' : ''
						}>
							${validation.isValid ? 'Continue to Run' : 'Fix Issues First'}
						</button>
					</div>
				</div>
			</div>
		`

		document.body.insertAdjacentHTML('beforeend', modalHtml)

		return new Promise((resolve) => {
			window.pipelineModule.confirmValidationAndRun = () => {
				closeValidationModal()
				resolve(true)
			}
			window.pipelineModule.closeValidationModal = () => {
				closeValidationModal()
				resolve(false)
			}
		})
	}

	function closeValidationModal() {
		const modal = document.getElementById('validation-modal')
		if (modal) modal.remove()
	}

	// Go back to pipelines list
	function backToPipelinesList() {
		document.getElementById('pipeline-detail-view').style.display = 'none'
		document.getElementById('pipelines-main-view').style.display = 'block'
		pipelineState.currentPipeline = null
		renderDataRunBanner()
	}

	// Run pipeline with validation - reads config from sidebar
	async function runPipeline(pipelineId) {
		const context = getPendingDataRunContext()
		const pipeline = pipelineState.pipelines.find((p) => p.id === pipelineId)

		if (
			context &&
			context.fileIds &&
			context.fileIds.length > 0 &&
			pipeline &&
			pipelineAcceptsGenotypeInput(pipeline)
		) {
			await startDataDrivenRun(pipelineId)
			return
		}

		try {
			if (!pipeline) return

			// Load pipeline to get inputs
			const editorData = await invoke('load_pipeline_editor', {
				pipelineId: pipelineId,
			})

			// Validate pipeline configuration
			const validation = await validatePipelineConfig(editorData.spec)

			// Show validation results
			const proceed = await showValidationModal(pipeline.name, validation)
			if (!proceed) return // User cancelled due to issues

			// Configuration is now data-driven (no sidebar config)
			// If we reach here, it means data-driven flow couldn't be used
			// Return empty config - this path should rarely be reached
			const config = { inputs: {}, parameters: {} }

			// Validate required inputs are filled
			const inputs = editorData.spec?.inputs || {}
			const missingInputs = []

			for (const [name, spec] of Object.entries(inputs)) {
				// Check if input has a default value
				const hasDefault = typeof spec === 'object' && spec.default

				// If no default and not provided in config, it's missing
				if (!hasDefault && !config.inputs[name]) {
					missingInputs.push(name)
				}
			}

			if (missingInputs.length > 0) {
				alert(
					`Cannot run pipeline. Missing required inputs:\n\n${missingInputs
						.map((name) => `• ${name}`)
						.join('\n')}\n\nPlease fill in all required inputs in the configuration panel.`,
				)

				// Highlight missing inputs
				missingInputs.forEach((name) => {
					const input = document.getElementById(`config-input-${name}`)
					if (input) {
						input.style.borderColor = '#dc2626'
						input.style.boxShadow = '0 0 0 3px rgba(220, 38, 38, 0.1)'

						// Remove highlight after a few seconds
						setTimeout(() => {
							input.style.borderColor = ''
							input.style.boxShadow = ''
						}, 3000)
					}
				})

				return
			}

			// Combine inputs and parameters into one override map
			// Format: { "inputs.samplesheet": "/path", "filter.threshold": "0.01" }
			const allOverrides = {}

			// Add input overrides
			for (const [name, value] of Object.entries(config.inputs || {})) {
				allOverrides[`inputs.${name}`] = value
			}

			// Add parameter overrides (already in stepId.paramName format)
			for (const [stepParam, value] of Object.entries(config.parameters || {})) {
				allOverrides[stepParam] = value
			}

			console.log('🚀 Running pipeline with overrides:', allOverrides)

			// Run the pipeline
			const run = await invoke('run_pipeline', {
				pipelineId: pipelineId,
				inputOverrides: allOverrides,
				resultsDir: null,
			})

			// Store run ID in sessionStorage for auto-expansion on runs page
			if (typeof sessionStorage !== 'undefined') {
				sessionStorage.setItem('autoExpandRunId', run.id.toString())
			}

			alert(`Pipeline started! Run ID: ${run.id}`)

			// Navigate to results tab if available
			if (navigateTo) {
				navigateTo('runs')
			}
		} catch (error) {
			alert('Error running pipeline: ' + error)
		}
	}

	// Show pipeline input dialog with file/folder pickers and parameter overrides
	async function _showPipelineInputDialog(pipelineName, requiredInputs, pipelineId, pipelineSpec) {
		// Load saved configurations from CLI database
		let savedConfigs = []
		try {
			savedConfigs = await invoke('list_run_configs', { pipelineId })
		} catch (error) {
			console.error('Failed to load saved configs:', error)
		}

		// Collect all parameters from all steps for override
		const stepParameters = []
		if (pipelineSpec && pipelineSpec.steps) {
			for (const step of pipelineSpec.steps) {
				try {
					const projectSpec = await invoke('load_project_editor', {
						projectPath: step.uses,
					})
					const params = projectSpec.metadata?.parameters || []
					params.forEach((param) => {
						stepParameters.push({
							stepId: step.id,
							paramName: param.name,
							paramType: param.type || 'String',
							default: param.default || '',
							description: param.description || '',
						})
					})
				} catch (e) {
					console.error(`Failed to load parameters for step ${step.id}:`, e)
				}
			}
		}

		const configSelectHtml =
			savedConfigs.length > 0
				? `<div style="margin-bottom: 16px;">
					<label style="display: block; margin-bottom: 6px; font-weight: 600; color: #374151;">
						Load Saved Configuration
					</label>
					<select id="load-saved-config" class="text-input" style="width: 100%;">
						<option value="">-- Start Fresh --</option>
						${savedConfigs
							.map(
								(config) =>
									`<option value="${config.id}">${config.name} (${new Date(
										config.created_at,
									).toLocaleString()})</option>`,
							)
							.join('')}
					</select>
				</div>`
				: ''

		const parametersHtml =
			stepParameters.length > 0
				? `<div style="margin-top: 24px;">
					<h3>Parameter Overrides (Optional)</h3>
					<p style="font-size: 13px; color: #6b7280; margin-bottom: 12px;">Override default parameter values for this run</p>
					<div id="pipeline-parameter-fields"></div>
				</div>`
				: ''

		// Create modal HTML
		const modalHtml = `
			<div id="pipeline-run-modal" class="modal-overlay" style="display: flex;">
				<div class="modal-content" style="width: 600px; max-height: 85vh;">
					<div class="modal-header">
						<h2>Run Pipeline: ${pipelineName}</h2>
						<button class="modal-close" onclick="pipelineModule.closePipelineRunDialog()">×</button>
					</div>
					<div class="modal-body" style="max-height: 65vh; overflow-y: auto;">
						${configSelectHtml}
						<h3>Configure Inputs</h3>
						<div id="pipeline-input-fields"></div>
						${parametersHtml}
						<div style="margin-top: 16px;">
							<label style="display: flex; align-items: center; gap: 8px; cursor: pointer;">
								<input type="checkbox" id="save-config-checkbox" style="width: auto;">
								<span style="font-size: 14px; color: #6b7280;">Save this configuration for future runs</span>
							</label>
							<div id="save-config-name-field" style="display: none; margin-top: 8px;">
								<input
									type="text"
									id="config-name-input"
									placeholder="Configuration name (e.g., 'Production Dataset')"
									style="width: 100%; padding: 8px 12px; border: 1px solid #e5e7eb; border-radius: 6px;"
								>
							</div>
						</div>
					</div>
					<div class="modal-footer">
						<button class="secondary-btn" onclick="pipelineModule.closePipelineRunDialog()">
							Cancel
						</button>
						<button class="primary-btn" onclick="pipelineModule.confirmPipelineRun()">
							Run Pipeline
						</button>
					</div>
				</div>
			</div>
		`

		// Add modal to page
		const modalContainer = document.createElement('div')
		modalContainer.innerHTML = modalHtml
		document.body.appendChild(modalContainer)

		// Create input fields
		const container = document.getElementById('pipeline-input-fields')
		let hasInputs = false

		for (const [name, type] of Object.entries(requiredInputs)) {
			hasInputs = true
			const fieldDiv = document.createElement('div')
			fieldDiv.style.marginBottom = '15px'

			if (type === 'File' || type === 'Directory') {
				fieldDiv.innerHTML = `
					<label style="display: block; margin-bottom: 5px;">
						${name} (${type}) *
					</label>
					<div style="display: flex; gap: 10px;">
						<input type="text" id="input-${name}" style="flex: 1;" placeholder="Select ${type.toLowerCase()}..." readonly autocomplete="off">
						<button class="secondary-btn" onclick="pipelineModule.selectPath('${name}', '${type}')">
							Browse...
						</button>
					</div>
				`
			} else {
				fieldDiv.innerHTML = `
					<label style="display: block; margin-bottom: 5px;">
						${name} (${type})
					</label>
					<input type="text" id="input-${name}" style="width: 100%;" placeholder="Enter value..." autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false">
				`
			}

			container.appendChild(fieldDiv)
		}

		if (!hasInputs) {
			container.innerHTML = '<p style="color: #666;">No inputs required for this pipeline.</p>'
		}

		// Create parameter override fields
		const paramsContainer = document.getElementById('pipeline-parameter-fields')
		if (paramsContainer && stepParameters.length > 0) {
			stepParameters.forEach((param) => {
				const fieldDiv = document.createElement('div')
				fieldDiv.style.marginBottom = '12px'
				fieldDiv.innerHTML = `
					<label style="display: block; margin-bottom: 4px; font-size: 13px; color: #374151;">
						<strong>${escapeHtml(param.stepId)}.${escapeHtml(param.paramName)}</strong>
						<span style="color: #9ca3af;"> (${escapeHtml(param.paramType)})</span>
					</label>
					<input
						type="text"
						id="param-${param.stepId}-${param.paramName}"
						placeholder="${param.default ? 'Default: ' + escapeHtml(param.default) : 'No default'}"
						value="${escapeHtml(param.default)}"
						style="width: 100%; padding: 8px 12px; border: 1px solid #e5e7eb; border-radius: 6px; font-size: 13px;"
						autocomplete="off"
					>
					${
						param.description
							? `<span style="font-size: 12px; color: #9ca3af; display: block; margin-top: 2px;">${escapeHtml(
									param.description,
								)}</span>`
							: ''
					}
				`
				paramsContainer.appendChild(fieldDiv)
			})
		}

		// Handle save config checkbox
		const saveCheckbox = document.getElementById('save-config-checkbox')
		const nameField = document.getElementById('save-config-name-field')
		if (saveCheckbox && nameField) {
			saveCheckbox.addEventListener('change', (e) => {
				nameField.style.display = e.target.checked ? 'block' : 'none'
				if (e.target.checked) {
					document.getElementById('config-name-input')?.focus()
				}
			})
		}

		// Handle load saved config
		const loadConfigSelect = document.getElementById('load-saved-config')
		if (loadConfigSelect) {
			loadConfigSelect.addEventListener('change', async (e) => {
				const configId = e.target.value
				if (configId !== '') {
					try {
						const config = await invoke('get_run_config', { configId: parseInt(configId) })
						if (config && config.config_data) {
							// Populate inputs from saved config
							if (config.config_data.inputs) {
								for (const [name, value] of Object.entries(config.config_data.inputs)) {
									const inputEl = document.getElementById(`input-${name}`)
									if (inputEl) {
										inputEl.value = value
									}
								}
							}
							// Populate parameters from saved config
							if (config.config_data.parameters) {
								for (const [stepParam, value] of Object.entries(config.config_data.parameters)) {
									const paramEl = document.getElementById(`param-${stepParam}`)
									if (paramEl) {
										paramEl.value = value
									}
								}
							}
						}
					} catch (error) {
						console.error('Failed to load config:', error)
						alert('Failed to load configuration: ' + error)
					}
				}
			})
		}

		// Return a promise that resolves with the inputs AND parameter overrides
		return new Promise((resolve) => {
			window.pipelineModule.confirmPipelineRun = async () => {
				const inputs = {}
				for (const name of Object.keys(requiredInputs)) {
					const value = document.getElementById(`input-${name}`)?.value
					if (value) {
						inputs[name] = value
					}
				}

				// Collect parameter overrides (stepId.paramName format)
				const parameters = {}
				stepParameters.forEach((param) => {
					const value = document.getElementById(`param-${param.stepId}-${param.paramName}`)?.value
					if (value && value !== param.default) {
						// Only save if different from default
						parameters[`${param.stepId}.${param.paramName}`] = value
					}
				})

				// Save configuration if checkbox is checked
				const saveCheckbox = document.getElementById('save-config-checkbox')
				if (saveCheckbox?.checked) {
					const configName = document.getElementById('config-name-input')?.value?.trim()
					if (!configName) {
						alert('Please enter a name for this configuration')
						return
					}

					try {
						await invoke('save_run_config', {
							pipelineId,
							name: configName,
							configData: { inputs, parameters },
						})
						console.log('✅ Saved run configuration:', configName)
					} catch (error) {
						console.error('Failed to save config:', error)
						// Don't block the run if save fails
					}
				}

				closePipelineRunDialog()
				resolve({ inputs, parameters })
			}

			window.pipelineModule.closePipelineRunDialog = () => {
				closePipelineRunDialog()
				resolve(null)
			}
		})
	}
	function closePipelineRunDialog() {
		const modal = document.getElementById('pipeline-run-modal')
		if (modal) {
			modal.parentElement.remove()
		}
	}

	async function selectPath(inputName, type) {
		try {
			let path
			if (type === 'File') {
				const selected = await dialog.open({
					multiple: false,
					directory: false,
				})
				path = selected
			} else if (type === 'Directory') {
				const selected = await dialog.open({
					multiple: false,
					directory: true,
				})
				path = selected
			}

			if (path) {
				document.getElementById(`input-${inputName}`).value = path
			}
		} catch (error) {
			console.error('Error selecting path:', error)
		}
	}

	// Delete pipeline
	async function deletePipeline(pipelineId) {
		const confirmed = await confirmWithDialog('Are you sure you want to delete this pipeline?', {
			title: 'Delete Pipeline',
			type: 'warning',
		})
		if (!confirmed) {
			return
		}

		try {
			await invoke('delete_pipeline', { pipelineId: pipelineId })
			await loadPipelines()
		} catch (error) {
			alert('Error deleting pipeline: ' + error)
		}
	}

	// Open pipeline folder
	async function openPipelineFolder(path) {
		try {
			await invoke('open_folder', { path })
		} catch (error) {
			alert('Error opening folder: ' + error)
		}
	}

	// Edit pipeline (placeholder for now)
	async function editPipeline(pipelineId) {
		alert('Pipeline editor coming soon! For now, you can edit the pipeline.yaml file directly.')
		const pipeline = pipelineState.pipelines.find((p) => p.id === pipelineId)
		if (pipeline) {
			await openPipelineFolder(pipeline.pipeline_path)
		}
	}

	// Show pipeline menu (for ... button)
	function showPipelineMenu(pipelineId, event) {
		event.stopPropagation()

		const pipeline = pipelineState.pipelines.find((p) => p.id === pipelineId)
		if (!pipeline) return

		// Create context menu
		const menu = document.createElement('div')
		menu.className = 'context-menu'
		menu.style.position = 'fixed'
		menu.style.left = event.clientX + 'px'
		menu.style.top = event.clientY + 'px'

		menu.innerHTML = `
			<button class="context-menu-item" data-action="open">
				<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
					<path d="M3 7v10a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-6l-2-2H5a2 2 0 0 0-2 2z"></path>
				</svg>
				Open Folder
			</button>
			<button class="context-menu-item danger" data-action="delete">
				<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
					<polyline points="3 6 5 6 21 6"></polyline>
					<path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
				</svg>
				Delete Pipeline
			</button>
		`

		document.body.appendChild(menu)

		// Close on click outside
		const closeMenu = (e) => {
			if (!menu.contains(e.target)) {
				menu.remove()
				document.removeEventListener('click', closeMenu)
			}
		}
		setTimeout(() => document.addEventListener('click', closeMenu), 0)

		// Handle menu actions
		menu.querySelectorAll('.context-menu-item').forEach((item) => {
			item.addEventListener('click', async (e) => {
				const action = e.currentTarget.dataset.action
				menu.remove()

				if (action === 'open') {
					await openPipelineFolder(pipeline.pipeline_path)
				} else if (action === 'delete') {
					await deletePipeline(pipelineId)
				}
			})
		})
	}

	// Attach back button handler
	function attachBackButton() {
		const backBtn = document.getElementById('back-to-pipelines-btn')
		if (backBtn) {
			backBtn.addEventListener('click', backToPipelinesList)
		}
	}

	// Attach detail view button handlers
	function attachDetailViewButtons() {
		const runBtn = document.getElementById('pipeline-detail-run')
		if (runBtn) {
			runBtn.addEventListener('click', async () => {
				if (pipelineState.currentPipeline) {
					await handlePipelineRunClick(pipelineState.currentPipeline.id)
				}
			})
		}

		const editBtn = document.getElementById('pipeline-detail-edit')
		if (editBtn) {
			editBtn.addEventListener('click', () => {
				if (pipelineState.currentPipeline) {
					editPipeline(pipelineState.currentPipeline.id)
				}
			})
		}

		const addStepBtn = document.getElementById('add-step-to-pipeline')
		if (addStepBtn) {
			addStepBtn.addEventListener('click', () => {
				if (pipelineState.currentPipeline) {
					showStepPickerModal()
				} else {
					console.error('Cannot add step: no current pipeline')
				}
			})
		}

		const editPipelineBtn = document.getElementById('edit-pipeline-yaml-btn')
		if (editPipelineBtn) {
			editPipelineBtn.addEventListener('click', () => {
				if (pipelineState.currentPipeline) {
					openPipelineYAMLInVSCode()
				}
			})
		}
	}

	// Initialization function
	function initialize() {
		// Set up listener to refresh banner when sessionStorage changes
		// Use storage event (works across tabs) and also poll when Pipelines view is active
		let bannerCheckInterval = null

		function refreshBannerIfNeeded() {
			const isPipelinesViewActive = document
				.getElementById('run-view')
				?.classList.contains('active')
			if (isPipelinesViewActive) {
				// Clear cached context to force fresh read from sessionStorage
				pipelineState.pendingDataRun = null
				renderDataRunBanner()
			}
		}

		// Listen for storage events (works when Data tab updates sessionStorage)
		window.addEventListener('storage', (e) => {
			if (e.key === 'preselectedFileIds' || e.key === 'preselectedParticipants') {
				refreshBannerIfNeeded()
			}
		})

		// Also poll when Pipelines view is active (since storage events don't fire in same window)
		function startBannerPolling() {
			if (bannerCheckInterval) return
			bannerCheckInterval = setInterval(refreshBannerIfNeeded, 500)
		}

		function stopBannerPolling() {
			if (bannerCheckInterval) {
				clearInterval(bannerCheckInterval)
				bannerCheckInterval = null
			}
		}

		// Check view state periodically
		setInterval(() => {
			const isPipelinesViewActive = document
				.getElementById('run-view')
				?.classList.contains('active')
			if (isPipelinesViewActive) {
				startBannerPolling()
			} else {
				stopBannerPolling()
			}
		}, 1000)

		// Initial check
		setTimeout(() => {
			const isPipelinesViewActive = document
				.getElementById('run-view')
				?.classList.contains('active')
			if (isPipelinesViewActive) {
				startBannerPolling()
			}
		}, 100)

		// Make functions available globally FIRST (before loading pipelines)
		window.pipelineModule = {
			editPipeline,
			runPipeline,
			openPipelineFolder,
			deletePipeline,
			closeWizard,
			wizardNext,
			wizardBack,
			addPipelineInput,
			addPipelineStep,
			removeStep,
			moveStepUp,
			moveStepDown,
			createPipeline,
			selectPath,
			closePipelineRunDialog,
			browseForProject,
			closeAddStepModal,
			confirmAddStep,
			showPipelineDetails,
			configureStepBindings,
			editPipelineStep,
			removePipelineStep,
			editBinding,
			removeBinding,
			removePublishOutput,
			removeSQLStore,
			closeBindingConfigModal,
			updateStepBindings,
			showPipelineMenu,
			backToPipelinesList,
			showCreatePipelineWizard,
			showTemplatePipelinePicker,
			showImportOptions,
			closeImportOptionsModal,
			importTemplatePipeline,
			closePipelinePickerModal,
			createBlankPipeline,
			closePipelineNameModal,
			submitPipelineName,
			importPipelineFromURL,
			closeURLInputModal,
			submitPipelineURL,
			importExistingPipeline,
			importStepFromURL,
			closeStepURLInputModal,
			submitStepURL,
			loadPipelineSteps,
			closeStepPickerModal,
			showDataRunModal: showDataRunModalDirect,
			showExistingProjectsList,
			closeProjectsListModal,
			browseForStepFolder,
			createNewStepProject,
			closeBlankStepModal,
			submitBlankStepName,
			saveStepWithBindings,
			showPipelineInputModal,
			closePipelineInputModal,
			savePipelineInput,
			editPipelineInput,
			removePipelineInput,
			showPipelineYAMLModal,
			closeYAMLViewerModal,
			openYAMLInVSCode,
			openPipelineYAMLInVSCode,
			launchJupyterForStep,
			openVSCodeForStep,
			editParameter,
			resetParameter,
		}

		// Load pipelines after setting up global handlers
		loadPipelines()

		// Attach event handlers to all create pipeline buttons
		const createBtn = document.getElementById('create-pipeline-btn')
		if (createBtn) {
			createBtn.addEventListener('click', showCreatePipelineWizard)
		}

		const emptyCreateBtn = document.getElementById('empty-create-pipeline-btn')
		if (emptyCreateBtn) {
			emptyCreateBtn.addEventListener('click', showCreatePipelineWizard)
		}

		const runCreateBtn = document.getElementById('run-create-pipeline-btn')
		if (runCreateBtn) {
			runCreateBtn.addEventListener('click', showCreatePipelineWizard)
		}

		// Attach back button handler
		attachBackButton()

		// Attach detail view button handlers
		attachDetailViewButtons()
	}

	// Show step picker modal with actions first
	async function showStepPickerModal() {
		const modalHtml = `
			<div id="step-picker-modal" class="modal-overlay" style="display: flex;">
				<div class="modal-content" style="width: 550px;">
					<div class="modal-header">
						<h2>Add Step to Pipeline</h2>
						<button class="modal-close" onclick="pipelineModule.closeStepPickerModal()">×</button>
					</div>
					<div class="modal-body">
						<div style="display: flex; flex-direction: column; gap: 10px;">
							<button class="action-btn-large" onclick="pipelineModule.importStepFromURL()">
								<div class="action-btn-icon">
									<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
										<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"></path>
										<path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"></path>
									</svg>
								</div>
								<div class="action-btn-content">
									<div class="action-btn-title">Import from GitHub</div>
									<div class="action-btn-desc">Download a step from a GitHub URL</div>
								</div>
							</button>
							<button class="action-btn-large" onclick="pipelineModule.showExistingProjectsList()">
								<div class="action-btn-icon">
									<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
										<rect x="3" y="3" width="7" height="7"></rect>
										<rect x="14" y="3" width="7" height="7"></rect>
										<rect x="14" y="14" width="7" height="7"></rect>
										<rect x="3" y="14" width="7" height="7"></rect>
									</svg>
								</div>
								<div class="action-btn-content">
									<div class="action-btn-title">Import Existing Project</div>
									<div class="action-btn-desc">Select from your registered projects</div>
								</div>
							</button>
							<button class="action-btn-large" onclick="pipelineModule.browseForStepFolder()">
								<div class="action-btn-icon">
									<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
										<path d="M3 7v10a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-6l-2-2H5a2 2 0 0 0-2 2z"></path>
									</svg>
								</div>
								<div class="action-btn-content">
									<div class="action-btn-title">Browse Local Folder</div>
									<div class="action-btn-desc">Select a project folder on your computer</div>
								</div>
							</button>
							<button class="action-btn-large" onclick="pipelineModule.createNewStepProject()">
								<div class="action-btn-icon">
									<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
										<line x1="12" y1="5" x2="12" y2="19"></line>
										<line x1="5" y1="12" x2="19" y2="12"></line>
									</svg>
								</div>
								<div class="action-btn-content">
									<div class="action-btn-title">Create New Project</div>
									<div class="action-btn-desc">Build a new step from scratch</div>
								</div>
							</button>
						</div>
					</div>
				</div>
			</div>
		`

		document.body.insertAdjacentHTML('beforeend', modalHtml)
	}

	// Show existing projects list (called from step picker)
	async function showExistingProjectsList() {
		try {
			const projects = await invoke('get_projects')

			const modalHtml = `
				<div id="projects-list-modal" class="modal-overlay" style="display: flex;">
					<div class="modal-content" style="width: 600px; max-height: 80vh;">
						<div class="modal-header">
							<button class="back-button-icon" onclick="pipelineModule.closeProjectsListModal(); pipelineModule.showStepPickerModal()">
								<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
									<polyline points="15 18 9 12 15 6"></polyline>
								</svg>
							</button>
							<h2 style="margin: 0;">Select Project</h2>
							<button class="modal-close" onclick="pipelineModule.closeProjectsListModal()">×</button>
						</div>
						<div class="modal-body" style="max-height: 60vh; overflow-y: auto;">
							${
								projects.length > 0
									? `
								<div class="project-select-list">
									${projects
										.map(
											(p) => `
										<div class="project-select-item" data-path="${p.project_path}" data-name="${p.name}">
											<div class="project-select-info">
												<div class="project-select-name">${p.name}</div>
												<div class="project-select-path">${p.project_path}</div>
											</div>
											<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
												<polyline points="9 18 15 12 9 6"></polyline>
											</svg>
										</div>
									`,
										)
										.join('')}
								</div>
							`
									: '<p style="color: #9ca3af; padding: 40px; text-align: center;">No projects registered yet. Import or create one!</p>'
							}
						</div>
					</div>
				</div>
			`

			closeStepPickerModal()
			document.body.insertAdjacentHTML('beforeend', modalHtml)

			// Add click handlers
			document.querySelectorAll('.project-select-item').forEach((item) => {
				item.addEventListener('click', async () => {
					const path = item.dataset.path
					const name = item.dataset.name
					await addStepFromPath(path, name)
					closeProjectsListModal()
				})
			})
		} catch (error) {
			console.error('Error showing projects list:', error)
			alert('Failed to show projects: ' + error)
		}
	}

	function closeProjectsListModal() {
		const modal = document.getElementById('projects-list-modal')
		if (modal) modal.remove()
	}

	function closeStepPickerModal() {
		const modal = document.getElementById('step-picker-modal')
		if (modal) modal.remove()
	}

	async function importStepFromURL() {
		closeStepPickerModal()

		// Show URL input modal
		const modalHtml = `
			<div id="step-url-input-modal" class="modal-overlay" style="display: flex;">
				<div class="modal-content" style="width: 650px;">
					<div class="modal-header">
						<h2>Import Step from GitHub</h2>
						<button class="modal-close" onclick="pipelineModule.closeStepURLInputModal()">×</button>
					</div>
					<div class="modal-body">
						<label style="display: block; margin-bottom: 8px; font-weight: 600; color: #374151;">
							GitHub URL to project.yaml
						</label>
						<input 
							type="text" 
							id="step-url-input" 
							placeholder="https://raw.githubusercontent.com/OpenMined/biovault/main/cli/examples/pipeline/count-lines/project.yaml"
							style="width: 100%; padding: 10px 12px; border: 1px solid #e5e7eb; border-radius: 6px; font-size: 13px; box-sizing: border-box; font-family: 'SF Mono', Monaco, monospace;"
						>
						<p style="font-size: 13px; color: #6b7280; margin-top: 8px;">
							📝 Use GitHub raw URLs (raw.githubusercontent.com) to import projects.
							<br>
							This will download the project.yaml and assets, then add it as a step.
						</p>
					</div>
					<div class="modal-footer">
						<button class="secondary-btn" onclick="pipelineModule.closeStepURLInputModal()">Cancel</button>
						<button class="primary-btn" onclick="pipelineModule.submitStepURL()">Import & Add Step</button>
					</div>
				</div>
			</div>
		`

		document.body.insertAdjacentHTML('beforeend', modalHtml)

		// Focus on input
		setTimeout(() => {
			const input = document.getElementById('step-url-input')
			if (input) {
				input.focus()
				input.addEventListener('keypress', (e) => {
					if (e.key === 'Enter') {
						pipelineModule.submitStepURL()
					}
				})
			}
		}, 100)
	}

	function closeStepURLInputModal() {
		const modal = document.getElementById('step-url-input-modal')
		if (modal) modal.remove()
	}

	async function submitStepURL(overwrite = false, urlOverride = null) {
		const input = document.getElementById('step-url-input')

		let url = urlOverride
		if (!url) {
			if (!input) return
			url = input.value.trim()
			if (!url) {
				alert('Please enter a URL')
				return
			}
		}

		// Convert GitHub blob URLs to raw URLs
		if (url.includes('github.com') && url.includes('/blob/')) {
			const rawUrl = url.replace('github.com', 'raw.githubusercontent.com').replace('/blob/', '/')
			console.log('🔄 Converted GitHub blob URL to raw URL:', rawUrl)
			url = rawUrl
		}

		try {
			closeStepURLInputModal()

			// Call CLI library to import from URL
			const result = await invoke('import_project', {
				url: url,
				overwrite: overwrite,
			})

			// Validate the result
			if (!result.project_path) {
				throw new Error('Import succeeded but no project path returned')
			}

			// Add the imported project as a step
			await addStepFromPath(result.project_path, result.name)

			console.log('✅ Imported and added step from URL:', url)
			alert(`Successfully imported project: ${result.name}`)
		} catch (error) {
			console.error('Error importing from URL:', error)
			const errorMsg = error?.message || error?.toString() || String(error) || 'Unknown error'

			if (errorMsg.includes('already exists')) {
				const shouldOverwrite = await confirmWithDialog(
					`${errorMsg}\n\nDo you want to overwrite it?`,
					{ title: 'Overwrite Project?', type: 'warning' },
				)
				if (shouldOverwrite) {
					await submitStepURL(true, url)
					return
				}
			} else {
				let userMessage = 'Failed to import project:\n\n' + errorMsg

				if (errorMsg.includes('not found') || errorMsg.includes('404')) {
					userMessage +=
						'\n\n💡 Tip: Make sure the URL points to a valid project.yaml file or project directory.'
				}

				if (url.includes('github.com')) {
					userMessage +=
						'\n\n📝 For GitHub URLs, use the raw content URL:\nhttps://raw.githubusercontent.com/...'
				}

				alert(userMessage)
			}
		}
	}

	async function browseForStepFolder(overwrite = false, selectedPath = null) {
		try {
			let selected = selectedPath
			if (!selected) {
				selected = await dialog.open({
					directory: true,
					multiple: false,
				})
			}

			if (selected) {
				// Import/register the project first so it appears in the list
				try {
					await invoke('import_project_from_folder', {
						folderPath: selected,
						overwrite: overwrite,
					})
				} catch (e) {
					const errorStr = e.toString ? e.toString() : String(e)
					if (errorStr.includes('already exists')) {
						const shouldOverwrite = await confirmWithDialog(
							`${errorStr}\n\nDo you want to overwrite it?`,
							{ title: 'Overwrite Project?', type: 'warning' },
						)
						if (shouldOverwrite) {
							await browseForStepFolder(true, selected)
							return
						} else {
							// User declined overwrite, don't proceed
							return
						}
					}
					// Might already be registered for other reasons, that's ok
					console.log('Project may already be registered:', e)
				}

				// Extract name from path
				const name = selected.split('/').pop() || selected.split('\\').pop() || 'step'
				await addStepFromPath(selected, name)
				closeStepPickerModal()
			}
		} catch (error) {
			console.error('Error browsing for step:', error)
		}
	}

	function createNewStepProject() {
		closeStepPickerModal()

		// Show simple name input (no wizard)
		const modalHtml = `
			<div id="blank-step-modal" class="modal-overlay" style="display: flex;">
				<div class="modal-content" style="width: 450px;">
					<div class="modal-header">
						<h2>Create Blank Step</h2>
						<button class="modal-close" onclick="pipelineModule.closeBlankStepModal()">×</button>
					</div>
					<div class="modal-body">
						<label style="display: block; margin-bottom: 8px; font-weight: 600; color: #374151;">
							Step Name
						</label>
						<input 
							type="text" 
							id="blank-step-name" 
							placeholder="my-analysis-step"
							autocomplete="off"
							autocorrect="off"
							autocapitalize="off"
							spellcheck="false"
							style="width: 100%; padding: 10px 12px; border: 1px solid #e5e7eb; border-radius: 6px; font-size: 14px; box-sizing: border-box;"
						>
						<p style="font-size: 13px; color: #6b7280; margin-top: 8px;">
							A blank step will be created. Configure inputs/outputs in the step editor.
						</p>
					</div>
					<div class="modal-footer">
						<button class="secondary-btn" onclick="pipelineModule.closeBlankStepModal()">Cancel</button>
						<button class="primary-btn" onclick="pipelineModule.submitBlankStepName()">Create Step</button>
					</div>
				</div>
			</div>
		`

		document.body.insertAdjacentHTML('beforeend', modalHtml)

		setTimeout(() => {
			const input = document.getElementById('blank-step-name')
			if (input) {
				input.focus()
				input.addEventListener('keypress', (e) => {
					if (e.key === 'Enter') {
						pipelineModule.submitBlankStepName()
					}
				})
			}
		}, 100)
	}

	function closeBlankStepModal() {
		const modal = document.getElementById('blank-step-modal')
		if (modal) modal.remove()
	}

	async function submitBlankStepName() {
		const input = document.getElementById('blank-step-name')
		if (!input) return

		const name = input.value.trim()
		if (!name) {
			alert('Please enter a step name')
			return
		}

		try {
			closeBlankStepModal()

			// Create blank project
			const result = await invoke('create_project', {
				name: name,
				example: null,
				directory: null,
				createPythonScript: false,
				scriptName: null,
			})

			// Add to pipeline
			await addStepFromPath(result.project_path, result.name)

			console.log('✅ Created blank step:', name)
		} catch (error) {
			console.error('Error creating blank step:', error)
			const errorMsg = error?.message || error?.toString() || String(error) || 'Unknown error'
			alert('Failed to create step: ' + errorMsg)
		}
	}

	async function addStepFromPath(projectPath, projectName) {
		if (!pipelineState.currentPipeline) return

		try {
			console.log('➕ Adding step to pipeline:')
			console.log('   Project Name:', projectName)
			console.log('   Project Path:', projectPath)

			// Ensure the project is registered in the database
			try {
				await invoke('import_project_from_folder', {
					folderPath: projectPath,
					overwrite: false,
				})
				console.log('✅ Project registered in database:', projectName)
			} catch (e) {
				// Might already be registered, that's ok
				console.log('ℹ️ Project may already be registered:', e.toString())
			}

			// Load current pipeline
			const editorData = await invoke('load_pipeline_editor', {
				pipelineId: pipelineState.currentPipeline.id,
			})

			// Create step using project NAME (not path) for portability
			const stepId = projectName.toLowerCase().replace(/[^a-z0-9]/g, '-')
			const newStep = {
				id: stepId,
				uses: projectName, // Use name for database lookup (portable!)
				with: {}, // Empty - configure later via button
			}

			console.log('📝 Adding step to pipeline spec:', newStep)

			// Add step
			if (!editorData.spec.steps) {
				editorData.spec.steps = []
			}
			editorData.spec.steps.push(newStep)

			// Save
			await invoke('save_pipeline_editor', {
				pipelineId: pipelineState.currentPipeline.id,
				pipelinePath: pipelineState.currentPipeline.pipeline_path,
				spec: editorData.spec,
			})

			// Refresh
			await loadPipelines()
			const updated = pipelineState.pipelines.find((p) => p.id === pipelineState.currentPipeline.id)
			if (updated) {
				pipelineState.currentPipeline = updated
			}
			await loadPipelineSteps(pipelineState.currentPipeline.id)

			console.log('✅ Successfully added step:', stepId)
		} catch (error) {
			console.error('Error adding step:', error)
			alert('Failed to add step: ' + error)
		}
	}

	function closeBindingConfigModal() {
		const modal = document.getElementById('binding-config-modal')
		if (modal) modal.remove()
		// Also support new modal
		hideConfigureStepModal()
	}

	async function saveStepWithBindings(projectPath, stepId) {
		try {
			// Collect bindings from inputs
			const bindings = {}
			document.querySelectorAll('.binding-input').forEach((input) => {
				const inputName = input.dataset.input
				const value = input.value.trim()
				if (value) {
					bindings[inputName] = value
				}
			})

			// Load current pipeline
			const editorData = await invoke('load_pipeline_editor', {
				pipelineId: pipelineState.currentPipeline.id,
			})

			// Create step with bindings
			const newStep = {
				id: stepId,
				uses: projectPath,
				with: bindings,
			}

			// Add step
			if (!editorData.spec.steps) {
				editorData.spec.steps = []
			}
			editorData.spec.steps.push(newStep)

			// Save
			await invoke('save_pipeline_editor', {
				pipelineId: pipelineState.currentPipeline.id,
				pipelinePath: pipelineState.currentPipeline.pipeline_path,
				spec: editorData.spec,
			})

			// Refresh
			await loadPipelines()
			const updated = pipelineState.pipelines.find((p) => p.id === pipelineState.currentPipeline.id)
			if (updated) {
				pipelineState.currentPipeline = updated
			}
			await loadPipelineSteps(pipelineState.currentPipeline.id)

			closeBindingConfigModal()
			console.log('✅ Added step with bindings:', stepId)
		} catch (error) {
			console.error('Error saving step:', error)
			alert('Failed to save step: ' + error)
		}
	}

	// =============================================================================
	// VISUAL STEP CONFIGURATION
	// =============================================================================

	let configureStepState = {
		stepIndex: -1,
		step: null,
		projectSpec: null,
		bindings: {},
		parameters: {},
		publish: {},
		store: {},
		editingBindingInput: null,
	}

	// Configure step bindings
	async function configureStepBindings(stepIndex) {
		if (!pipelineState.currentPipeline) return

		const step = pipelineState.currentPipeline.spec?.steps?.[stepIndex]
		if (!step) return

		try {
			console.log('📋 Configuring step:', step.id, '- uses:', step.uses)

			// Load project spec to get inputs
			const projectSpec = await invoke('load_project_editor', {
				projectPath: step.uses,
			})

			console.log('✅ Loaded project spec from path:', projectSpec.project_path)
			console.log('   Inputs:', projectSpec.metadata?.inputs?.length || 0)
			console.log('   Parameters:', projectSpec.metadata?.parameters?.length || 0)
			console.log('   Outputs:', projectSpec.metadata?.outputs?.length || 0)

			// Show new visual config modal
			await showVisualConfigModal(step, stepIndex, projectSpec)
		} catch (error) {
			console.error('Error loading project for configuration:', error)
			alert('Failed to load project: ' + error)
		}
	}

	async function showVisualConfigModal(step, stepIndex, projectSpec) {
		configureStepState.stepIndex = stepIndex
		configureStepState.step = step
		configureStepState.projectSpec = projectSpec
		configureStepState.bindings = { ...(step.with || {}) }
		configureStepState.parameters = { ...(step.parameters || {}) }
		configureStepState.publish = { ...(step.publish || {}) }
		configureStepState.store = { ...(step.store || {}) }

		// Update modal title and info
		document.getElementById('configure-step-name').textContent = step.id || 'Step'
		document.getElementById('configure-step-uses').textContent = `Uses: ${step.uses || 'unknown'}`

		// Render all sections
		renderStepBindingsList()
		renderParametersList()
		renderPublishList()
		renderStoreList()

		// Setup handlers
		setupConfigureStepHandlers()

		// Show modal
		document.getElementById('configure-step-modal').style.display = 'flex'
	}

	function renderParametersList() {
		const container = document.getElementById('step-parameters-list')
		if (!container) return

		const parameters = configureStepState.projectSpec.metadata?.parameters || []

		if (parameters.length === 0) {
			container.innerHTML =
				'<div class="empty-state">This step has no configurable parameters.</div>'
			return
		}

		container.innerHTML = parameters
			.map((param) => {
				return `
					<div class="parameter-item parameter-info-only">
						<div class="parameter-info" style="width: 100%;">
							<div class="parameter-header">
								<span class="parameter-name">${escapeHtml(param.name)}</span>
								<span class="parameter-type-badge">${escapeHtml(param.type || 'String')}</span>
							</div>
							${
								param.description
									? `<div class="parameter-description">${escapeHtml(param.description)}</div>`
									: ''
							}
							<div class="parameter-value-display">
								<span class="value-label">Default:</span>
								<code>${escapeHtml(String(param.default || 'none'))}</code>
							</div>
						</div>
					</div>
				`
			})
			.join('')
	}

	function renderStepBindingsList() {
		const container = document.getElementById('step-bindings-list')
		if (!container) return

		const inputs = configureStepState.projectSpec.metadata?.inputs || []

		if (inputs.length === 0) {
			container.innerHTML = '<div class="empty-state">This step has no inputs to configure.</div>'
			return
		}

		container.innerHTML = inputs
			.map((input) => {
				const binding = configureStepState.bindings[input.name]
				const isBound = !!binding
				const bindingText = binding || 'Not configured'

				return `
					<div class="binding-item ${isBound ? '' : 'unbound'}">
						<div class="binding-info">
							<div>
								<span class="binding-input-name">${escapeHtml(input.name)}</span>
								<span class="binding-type-badge">${escapeHtml(input.type || 'File')}</span>
							</div>
							<div class="binding-value">${isBound ? escapeHtml(bindingText) : '⚠️ ' + bindingText}</div>
						</div>
						<div class="binding-actions">
							<button class="btn-bind" onclick="pipelineModule.editBinding('${escapeHtml(input.name)}')">
								${isBound ? 'Change' : 'Set Binding'}
							</button>
							${
								isBound
									? `<button class="btn-unbind" onclick="pipelineModule.removeBinding('${escapeHtml(
											input.name,
										)}')">Clear</button>`
									: ''
							}
						</div>
					</div>
				`
			})
			.join('')
	}

	function setupConfigureStepHandlers() {
		const closeBtn = document.getElementById('configure-step-close')
		const cancelBtn = document.getElementById('configure-step-cancel')
		const saveBtn = document.getElementById('configure-step-save')

		if (closeBtn) closeBtn.onclick = () => hideConfigureStepModal()
		if (cancelBtn) cancelBtn.onclick = () => hideConfigureStepModal()
		if (saveBtn) saveBtn.onclick = () => saveStepConfiguration()

		// Launch buttons
		const jupyterBtn = document.getElementById('configure-step-jupyter')
		const vscodeBtn = document.getElementById('configure-step-vscode')

		if (jupyterBtn) jupyterBtn.onclick = () => launchJupyterForStep()
		if (vscodeBtn) vscodeBtn.onclick = () => openVSCodeForStep()

		// Add buttons
		const addPublishBtn = document.getElementById('add-publish-output-btn')
		const addStoreBtn = document.getElementById('add-store-btn')

		if (addPublishBtn) addPublishBtn.onclick = () => showPublishEditor()
		if (addStoreBtn) addStoreBtn.onclick = () => showStoreEditor()

		// Binding editor handlers
		const bindingSourceType = document.getElementById('binding-source-type')
		if (bindingSourceType) {
			bindingSourceType.onchange = () => updateBindingSelectors()
		}

		const bindingStepSelect = document.getElementById('binding-step-select')
		if (bindingStepSelect) {
			bindingStepSelect.onchange = () => updateBindingOutputOptions()
		}

		// Setup all close buttons
		const bindingClose = document.getElementById('binding-editor-close')
		const bindingCancel = document.getElementById('binding-editor-cancel')
		const bindingSave = document.getElementById('binding-editor-save')

		if (bindingClose) bindingClose.onclick = () => hideBindingEditor()
		if (bindingCancel) bindingCancel.onclick = () => hideBindingEditor()
		if (bindingSave) bindingSave.onclick = () => saveBindingFromEditor()

		// Publish editor handlers
		const publishClose = document.getElementById('publish-editor-close')
		const publishCancel = document.getElementById('publish-editor-cancel')
		const publishSave = document.getElementById('publish-editor-save')

		if (publishClose) publishClose.onclick = () => hidePublishEditor()
		if (publishCancel) publishCancel.onclick = () => hidePublishEditor()
		if (publishSave) publishSave.onclick = () => savePublishOutput()

		// Store editor handlers
		const storeClose = document.getElementById('store-editor-close')
		const storeCancel = document.getElementById('store-editor-cancel')
		const storeSave = document.getElementById('store-editor-save')

		if (storeClose) storeClose.onclick = () => hideStoreEditor()
		if (storeCancel) storeCancel.onclick = () => hideStoreEditor()
		if (storeSave) storeSave.onclick = () => saveSQLStore()
	}

	function editParameter(paramName) {
		const param = configureStepState.projectSpec.metadata?.parameters?.find(
			(p) => p.name === paramName,
		)
		if (!param) return

		const currentValue =
			configureStepState.parameters[paramName] !== undefined
				? configureStepState.parameters[paramName]
				: param.default || ''

		const newValue = prompt(
			`Set value for ${paramName}:\n\nType: ${param.type}\nDefault: ${param.default || 'none'}\n${
				param.description ? '\n' + param.description : ''
			}`,
			currentValue,
		)

		if (newValue !== null) {
			configureStepState.parameters[paramName] = newValue
			renderParametersList()
		}
	}

	function resetParameter(paramName) {
		delete configureStepState.parameters[paramName]
		renderParametersList()
	}

	function hideConfigureStepModal() {
		document.getElementById('configure-step-modal').style.display = 'none'
		configureStepState = {
			stepIndex: -1,
			step: null,
			projectSpec: null,
			bindings: {},
			parameters: {},
			publish: {},
			store: {},
			editingBindingInput: null,
		}
	}

	async function launchJupyterForStep() {
		if (!configureStepState.projectSpec) return

		try {
			// Use the resolved project path from projectSpec, not step.uses
			const projectPath = configureStepState.projectSpec.project_path
			if (!projectPath) {
				throw new Error('Project path not available')
			}

			console.log('🚀 Launching Jupyter for project at:', projectPath)

			await invoke('launch_jupyter', {
				projectPath: projectPath,
			})
		} catch (error) {
			console.error('Error launching Jupyter:', error)
			alert('Failed to launch Jupyter: ' + error.toString())
		}
	}

	async function openVSCodeForStep() {
		if (!configureStepState.projectSpec) return

		try {
			// Use the resolved project path from projectSpec, not step.uses
			const projectPath = configureStepState.projectSpec.project_path
			if (!projectPath) {
				throw new Error('Project path not available')
			}

			console.log('📂 Opening VSCode for project at:', projectPath)

			await invoke('open_in_vscode', {
				path: projectPath,
			})
		} catch (error) {
			console.error('Error opening VSCode:', error)
			alert('Failed to open VSCode: ' + error.toString())
		}
	}

	async function saveStepConfiguration() {
		try {
			// Load current pipeline
			const editorData = await invoke('load_pipeline_editor', {
				pipelineId: pipelineState.currentPipeline.id,
			})

			// Update step
			if (editorData.spec.steps[configureStepState.stepIndex]) {
				editorData.spec.steps[configureStepState.stepIndex].with = configureStepState.bindings

				// NOTE: Parameters are NOT saved to pipeline.yaml per spec
				// They are runtime overrides only (--set step.param=value)
				// We save them to run_configs for convenience

				// Add publish and store if they exist
				if (Object.keys(configureStepState.publish).length > 0) {
					editorData.spec.steps[configureStepState.stepIndex].publish = configureStepState.publish
				} else {
					delete editorData.spec.steps[configureStepState.stepIndex].publish
				}
				if (Object.keys(configureStepState.store).length > 0) {
					editorData.spec.steps[configureStepState.stepIndex].store = configureStepState.store
				} else {
					delete editorData.spec.steps[configureStepState.stepIndex].store
				}
			}

			// Save
			await invoke('save_pipeline_editor', {
				pipelineId: pipelineState.currentPipeline.id,
				pipelinePath: pipelineState.currentPipeline.pipeline_path,
				spec: editorData.spec,
			})

			// Refresh
			await loadPipelines()
			const updated = pipelineState.pipelines.find((p) => p.id === pipelineState.currentPipeline.id)
			if (updated) {
				pipelineState.currentPipeline = updated
			}
			await loadPipelineSteps(pipelineState.currentPipeline.id)

			hideConfigureStepModal()
		} catch (error) {
			console.error('Error saving step configuration:', error)
			alert('Failed to save configuration: ' + error)
		}
	}

	function editBinding(inputName) {
		configureStepState.editingBindingInput = inputName
		const currentBinding = configureStepState.bindings[inputName] || ''

		// Get input type for compatibility checking
		const input = configureStepState.projectSpec.metadata?.inputs?.find((i) => i.name === inputName)
		const expectedType = input?.type || 'File'

		// Set input name and show expected type
		document.getElementById('binding-input-name').value = `${inputName} (expects: ${expectedType})`

		// Parse current binding if it exists
		if (currentBinding) {
			parseAndPopulateBinding(currentBinding)
		} else {
			// Clear all selectors
			document.getElementById('binding-source-type').value = ''
			updateBindingSelectors()
		}

		// Show binding editor
		document.getElementById('binding-editor-modal').style.display = 'flex'
	}

	function parseAndPopulateBinding(binding) {
		const sourceTypeSelect = document.getElementById('binding-source-type')

		if (binding.startsWith('inputs.')) {
			// Pipeline input
			sourceTypeSelect.value = 'pipeline-input'
			updateBindingSelectors()
			const inputName = binding.replace('inputs.', '')
			document.getElementById('binding-pipeline-input-select').value = inputName
		} else if (binding.startsWith('step.')) {
			// Step output: step.stepId.outputs.outputName
			sourceTypeSelect.value = 'step-output'
			updateBindingSelectors()
			const match = binding.match(/^step\.([^.]+)\.outputs\.(.+)$/)
			if (match) {
				document.getElementById('binding-step-select').value = match[1]
				updateBindingOutputOptions()
				document.getElementById('binding-output-select').value = match[2]
			}
		} else if (binding.startsWith('File(') || binding.startsWith('Directory(')) {
			// Literal
			const isFile = binding.startsWith('File(')
			sourceTypeSelect.value = isFile ? 'literal-file' : 'literal-dir'
			updateBindingSelectors()
			const path = binding.match(/\(([^)]+)\)/)?.[1] || ''
			document.getElementById('binding-literal-path').value = path
		}

		updateBindingPreview()
	}

	function updateBindingSelectors() {
		const sourceType = document.getElementById('binding-source-type').value

		// Hide all selectors
		document.getElementById('binding-pipeline-input-selector').style.display = 'none'
		document.getElementById('binding-step-output-selector').style.display = 'none'
		document.getElementById('binding-literal-selector').style.display = 'none'
		document.getElementById('binding-preview').style.display = 'none'

		if (sourceType === 'pipeline-input') {
			// Populate pipeline inputs with type checking
			const pipelineInputs = pipelineState.currentPipeline.spec?.inputs || {}
			const select = document.getElementById('binding-pipeline-input-select')

			// Get expected input type
			const inputName = configureStepState.editingBindingInput
			const input = configureStepState.projectSpec.metadata?.inputs?.find(
				(i) => i.name === inputName,
			)
			const expectedType = input?.type?.replace('?', '') || 'File'

			select.innerHTML =
				'<option value="">-- Select Input --</option>' +
				Object.entries(pipelineInputs)
					.map(([key, spec]) => {
						const pipelineInputType = typeof spec === 'string' ? spec : spec.type || 'File'
						const cleanType = pipelineInputType.replace('?', '')
						const isCompatible =
							cleanType === expectedType ||
							expectedType.startsWith('String') ||
							cleanType.startsWith('String')
						const indicator = isCompatible ? '✅' : '❌'
						const className = isCompatible ? 'compatible' : 'incompatible'

						return `<option value="${escapeHtml(
							key,
						)}" class="${className}">${indicator} ${escapeHtml(key)} (${escapeHtml(
							cleanType,
						)})</option>`
					})
					.join('')
			document.getElementById('binding-pipeline-input-selector').style.display = 'block'
			select.onchange = () => updateBindingPreview()
		} else if (sourceType === 'step-output') {
			// Populate previous steps
			const steps = pipelineState.currentPipeline.spec?.steps || []
			const currentIndex = configureStepState.stepIndex
			const previousSteps = steps.slice(0, currentIndex)

			const select = document.getElementById('binding-step-select')
			select.innerHTML =
				'<option value="">-- Select Step --</option>' +
				previousSteps
					.map((s) => `<option value="${escapeHtml(s.id)}">${escapeHtml(s.id)}</option>`)
					.join('')
			document.getElementById('binding-step-output-selector').style.display = 'block'
			updateBindingOutputOptions()
		} else if (sourceType === 'literal-file' || sourceType === 'literal-dir') {
			document.getElementById('binding-literal-selector').style.display = 'block'
			const pathInput = document.getElementById('binding-literal-path')
			pathInput.oninput = () => updateBindingPreview()
		}

		updateBindingPreview()
	}

	async function updateBindingOutputOptions() {
		const stepId = document.getElementById('binding-step-select').value
		const outputSelect = document.getElementById('binding-output-select')

		if (!stepId) {
			outputSelect.innerHTML = '<option value="">-- First select a step --</option>'
			return
		}

		// Find the step and load its project to get outputs
		const step = pipelineState.currentPipeline.spec?.steps?.find((s) => s.id === stepId)
		if (!step) return

		try {
			// Get expected input type for compatibility checking
			const inputName = configureStepState.editingBindingInput
			const input = configureStepState.projectSpec.metadata?.inputs?.find(
				(i) => i.name === inputName,
			)
			const expectedType = input?.type?.replace('?', '') || 'File' // Remove optional marker

			const projectSpec = await invoke('load_project_editor', {
				projectPath: step.uses,
			})

			const outputs = projectSpec.metadata?.outputs || []
			outputSelect.innerHTML =
				'<option value="">-- Select Output --</option>' +
				outputs
					.map((output) => {
						const outputType = output.type?.replace('?', '') || 'File'
						const isCompatible =
							outputType === expectedType ||
							expectedType.startsWith('String') || // String can accept anything
							outputType.startsWith('String')
						const indicator = isCompatible ? '✅' : '❌'
						const className = isCompatible ? 'compatible' : 'incompatible'

						return `<option value="${escapeHtml(
							output.name,
						)}" class="${className}">${indicator} ${escapeHtml(output.name)} (${escapeHtml(
							outputType,
						)})</option>`
					})
					.join('')
			outputSelect.onchange = () => updateBindingPreview()
		} catch (error) {
			console.error('Failed to load project outputs:', error)
			outputSelect.innerHTML = '<option value="">-- Error loading outputs --</option>'
		}
	}

	function updateBindingPreview() {
		const sourceType = document.getElementById('binding-source-type').value
		const previewDiv = document.getElementById('binding-preview')
		const previewCode = document.getElementById('binding-preview-code')

		let binding = ''

		if (sourceType === 'pipeline-input') {
			const inputName = document.getElementById('binding-pipeline-input-select').value
			if (inputName) {
				binding = `inputs.${inputName}`
			}
		} else if (sourceType === 'step-output') {
			const stepId = document.getElementById('binding-step-select').value
			const outputName = document.getElementById('binding-output-select').value
			if (stepId && outputName) {
				binding = `step.${stepId}.outputs.${outputName}`
			}
		} else if (sourceType === 'literal-file') {
			const path = document.getElementById('binding-literal-path').value.trim()
			if (path) {
				binding = `File(${path})`
			}
		} else if (sourceType === 'literal-dir') {
			const path = document.getElementById('binding-literal-path').value.trim()
			if (path) {
				binding = `Directory(${path})`
			}
		}

		if (binding) {
			previewDiv.style.display = 'block'
			previewCode.textContent = binding
		} else {
			previewDiv.style.display = 'none'
		}
	}

	function saveBindingFromEditor() {
		const inputName = configureStepState.editingBindingInput
		if (!inputName) return

		const sourceType = document.getElementById('binding-source-type').value
		let binding = ''

		if (sourceType === 'pipeline-input') {
			const pipelineInput = document.getElementById('binding-pipeline-input-select').value
			if (!pipelineInput) {
				alert('Please select a pipeline input')
				return
			}
			binding = `inputs.${pipelineInput}`
		} else if (sourceType === 'step-output') {
			const stepId = document.getElementById('binding-step-select').value
			const outputName = document.getElementById('binding-output-select').value
			if (!stepId || !outputName) {
				alert('Please select both a step and an output')
				return
			}
			binding = `step.${stepId}.outputs.${outputName}`
		} else if (sourceType === 'literal-file') {
			const path = document.getElementById('binding-literal-path').value.trim()
			if (!path) {
				alert('Please enter a file path')
				return
			}
			binding = `File(${path})`
		} else if (sourceType === 'literal-dir') {
			const path = document.getElementById('binding-literal-path').value.trim()
			if (!path) {
				alert('Please enter a directory path')
				return
			}
			binding = `Directory(${path})`
		} else {
			alert('Please select a data source')
			return
		}

		// Save binding
		configureStepState.bindings[inputName] = binding
		renderStepBindingsList()
		hideBindingEditor()
	}

	function removeBinding(inputName) {
		delete configureStepState.bindings[inputName]
		renderStepBindingsList()
	}

	function hideBindingEditor() {
		document.getElementById('binding-editor-modal').style.display = 'none'
		configureStepState.editingBindingInput = null
	}

	// Publish Output Functions
	function showPublishEditor() {
		document.getElementById('publish-output-name').value = ''
		document.getElementById('publish-output-type').value = 'File'
		document.getElementById('publish-output-path').value = ''
		document.getElementById('publish-editor-modal').style.display = 'flex'
	}

	function hidePublishEditor() {
		document.getElementById('publish-editor-modal').style.display = 'none'
	}

	function savePublishOutput() {
		const name = document.getElementById('publish-output-name').value.trim()
		const type = document.getElementById('publish-output-type').value
		const path = document.getElementById('publish-output-path').value.trim()

		if (!name || !path) {
			alert('Output name and path are required')
			return
		}

		// Add to publish object: name: Type(path)
		configureStepState.publish[name] = `${type}(${path})`
		renderPublishList()
		hidePublishEditor()
	}

	function renderPublishList() {
		const container = document.getElementById('step-publish-list')
		if (!container) return

		const items = Object.entries(configureStepState.publish)

		if (items.length === 0) {
			container.innerHTML = '<div class="empty-state">No outputs published yet</div>'
			return
		}

		container.innerHTML = items
			.map(
				([name, value]) => `
			<div class="publish-item">
				<div class="publish-item-info">
					<div class="publish-item-name">${escapeHtml(name)}</div>
					<div class="publish-item-value">${escapeHtml(value)}</div>
				</div>
				<button class="publish-item-remove" onclick="pipelineModule.removePublishOutput('${escapeHtml(
					name,
				)}')">&times;</button>
			</div>
		`,
			)
			.join('')
	}

	function removePublishOutput(name) {
		delete configureStepState.publish[name]
		renderPublishList()
	}

	// SQL Store Functions
	function showStoreEditor() {
		document.getElementById('store-name').value = ''
		document.getElementById('store-table-name').value = ''
		document.getElementById('store-key-column').value = ''

		// Populate source select with available outputs
		const sourceSelect = document.getElementById('store-source')
		const outputs = configureStepState.projectSpec.metadata?.outputs || []
		const publishedOutputs = Object.keys(configureStepState.publish)

		const allOutputs = [...outputs.map((o) => o.name), ...publishedOutputs]

		sourceSelect.innerHTML =
			'<option value="">-- Select Output --</option>' +
			allOutputs
				.map((name) => `<option value="${escapeHtml(name)}">${escapeHtml(name)}</option>`)
				.join('')

		document.getElementById('store-editor-modal').style.display = 'flex'
	}

	function hideStoreEditor() {
		document.getElementById('store-editor-modal').style.display = 'none'
	}

	function saveSQLStore() {
		const storeName = document.getElementById('store-name').value.trim()
		const source = document.getElementById('store-source').value
		const tableName = document.getElementById('store-table-name').value.trim()
		const keyColumn = document.getElementById('store-key-column').value.trim()

		if (!storeName || !source) {
			alert('Store name and source output are required')
			return
		}

		// Create store config
		const storeConfig = {
			kind: 'sql',
			destination: 'SQL()',
			source: source,
		}

		if (tableName) {
			storeConfig.table_name = tableName
		}

		if (keyColumn) {
			storeConfig.key_column = keyColumn
		}

		configureStepState.store[storeName] = storeConfig
		renderStoreList()
		hideStoreEditor()
	}

	function renderStoreList() {
		const container = document.getElementById('step-store-list')
		if (!container) return

		const items = Object.entries(configureStepState.store)

		if (items.length === 0) {
			container.innerHTML = '<div class="empty-state">No SQL stores configured</div>'
			return
		}

		container.innerHTML = items
			.map(([name, config]) => {
				const details = [
					`Source: ${config.source}`,
					config.table_name ? `Table: ${config.table_name}` : null,
					config.key_column ? `Key: ${config.key_column}` : null,
				]
					.filter(Boolean)
					.join(' • ')

				return `
				<div class="store-item">
					<div class="store-item-info">
						<div class="store-item-name">${escapeHtml(name)}</div>
						<div class="store-item-value">${escapeHtml(details)}</div>
					</div>
					<button class="store-item-remove" onclick="pipelineModule.removeSQLStore('${escapeHtml(
						name,
					)}')">&times;</button>
				</div>
			`
			})
			.join('')
	}

	function removeSQLStore(name) {
		delete configureStepState.store[name]
		renderStoreList()
	}

	async function updateStepBindings(_stepIndex) {
		// Legacy function - redirects to new implementation
		await saveStepConfiguration()
	}

	// Edit a pipeline step - opens the project editor for that step
	async function editPipelineStep(stepIndex) {
		if (!pipelineState.currentPipeline) {
			console.error('No current pipeline')
			return
		}

		const step = pipelineState.currentPipeline.spec?.steps?.[stepIndex]
		if (!step) {
			console.error('Step not found at index:', stepIndex)
			return
		}

		// Open the project editor for this step's project
		if (openProjectEditor && step.uses) {
			await openProjectEditor({ projectPath: step.uses })
		} else {
			console.error('Cannot open project editor: missing function or project path')
		}
	}

	// Remove a pipeline step
	async function removePipelineStep(stepIndex) {
		if (!pipelineState.currentPipeline) {
			console.error('No current pipeline')
			return
		}

		if (!confirm('Are you sure you want to remove this step from the pipeline?')) {
			return
		}

		try {
			// Load current pipeline spec
			const editorData = await invoke('load_pipeline_editor', {
				pipelineId: pipelineState.currentPipeline.id,
			})

			// Remove the step
			editorData.spec.steps.splice(stepIndex, 1)

			// Save updated pipeline
			await invoke('save_pipeline_editor', {
				pipelineId: pipelineState.currentPipeline.id,
				pipelinePath: pipelineState.currentPipeline.pipeline_path,
				spec: editorData.spec,
			})

			// Reload pipelines and steps
			await loadPipelines()

			const updatedPipeline = pipelineState.pipelines.find(
				(p) => p.id === pipelineState.currentPipeline.id,
			)
			if (updatedPipeline) {
				pipelineState.currentPipeline = updatedPipeline
			}

			await loadPipelineSteps(pipelineState.currentPipeline.id)

			console.log('✅ Removed step from pipeline')
		} catch (error) {
			console.error('Error removing step:', error)
			alert('Failed to remove step: ' + error.message)
		}
	}

	// Add a newly created project as a step to the current pipeline
	async function addProjectAsStep(projectPath, projectName) {
		if (!pipelineState.currentPipeline) {
			console.error('No current pipeline to add step to')
			return
		}

		try {
			console.log('🔧 Adding step to pipeline:', pipelineState.currentPipeline.name)

			// Load current pipeline spec
			const editorData = await invoke('load_pipeline_editor', {
				pipelineId: pipelineState.currentPipeline.id,
			})

			console.log('📄 Loaded pipeline spec:', editorData.spec)

			// Create new step (CLI parity - only include non-empty fields)
			const stepId = projectName.toLowerCase().replace(/[^a-z0-9]/g, '-')
			const newStep = {
				id: stepId,
				uses: projectPath,
				with: {},
				// Don't include publish/store unless they have values (CLI parity)
			}

			console.log('➕ New step:', newStep)

			// Add step to pipeline
			if (!editorData.spec.steps) {
				editorData.spec.steps = []
			}
			editorData.spec.steps.push(newStep)

			console.log('📝 Updated spec with', editorData.spec.steps.length, 'steps')

			// Save updated pipeline
			await invoke('save_pipeline_editor', {
				pipelineId: pipelineState.currentPipeline.id,
				pipelinePath: pipelineState.currentPipeline.pipeline_path,
				spec: editorData.spec,
			})

			console.log('💾 Saved pipeline')

			// Reload pipelines list (now includes spec from YAML files)
			await loadPipelines()
			console.log('🔄 Reloaded pipelines list')

			// Update current pipeline reference with fresh data
			const updatedPipeline = pipelineState.pipelines.find(
				(p) => p.id === pipelineState.currentPipeline.id,
			)
			if (updatedPipeline) {
				pipelineState.currentPipeline = updatedPipeline
				console.log(
					'✅ Updated current pipeline, steps count:',
					updatedPipeline.spec?.steps?.length || 0,
				)
			}

			// Reload the steps display
			await loadPipelineSteps(pipelineState.currentPipeline.id)
			console.log('🎉 Refreshed step display')

			console.log(`✅ Added step "${stepId}" to pipeline "${pipelineState.currentPipeline.name}"`)
		} catch (error) {
			console.error('Error adding step to pipeline:', error)
			alert('Failed to add step to pipeline: ' + error.message)
		}
	}

	return {
		initialize,
		loadPipelines,
		showPipelineDetails,
		backToPipelinesList,
		addProjectAsStep, // Expose for project creation to call
	}
}
