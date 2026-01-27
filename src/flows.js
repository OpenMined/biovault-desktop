/* global flowModule */
export function createFlowsModule({ invoke, dialog, open: _open, navigateTo, openModuleEditor }) {
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
	const flowState = {
		flows: [],
		currentFlow: null,
		wizardStep: 0,
		wizardData: {
			name: '',
			inputs: {},
			steps: [],
		},
		pendingDataRun: null,
		dataRunModalOpen: false,
		lastAutoOpenKey: null,
	}

	// Load flows list
	async function loadFlows() {
		try {
			// Clear cached context to ensure fresh read from sessionStorage
			flowState.pendingDataRun = null

			const flows = await invoke('get_flows')
			// Pre-load all modules for step resolution
			const modules = await invoke('get_modules')
			const modulesMap = new Map()
			modules.forEach((p) => {
				const key = `${p.name}@${p.version}`
				modulesMap.set(key, p)
				// Also allow lookup by name only (for latest version)
				if (!modulesMap.has(p.name)) {
					modulesMap.set(p.name, p)
				}
			})

			const gridContainer = document.getElementById('flows-grid')
			const emptyState = document.getElementById('flows-empty-state')

			if (!gridContainer) {
				console.error('flows-grid container not found')
				return
			}

			if (!flows || flows.length === 0) {
				gridContainer.innerHTML = ''
				if (emptyState) emptyState.style.display = 'flex'
				flowState.flows = []
				// Still render banner (it will clear itself if no selection)
				renderDataRunBanner()
				return
			}

			if (emptyState) emptyState.style.display = 'none'
			gridContainer.innerHTML = ''

			flows.forEach((flow) => {
				renderFlowCard(flow, gridContainer, modulesMap)
			})

			flowState.flows = flows
			logFlowDebug('loadFlows', flows)

			renderDataRunBanner()

			// Don't auto-open modal - let user choose from banner or flow cards
		} catch (error) {
			console.error('Error loading flows:', error)
		}
	}

	function renderFlowCard(flow, container, modulesMap = new Map()) {
		const stepCount = flow.spec?.steps?.length || 0
		const description = flow.spec?.description || ''
		const context = getPendingDataRunContext()
		const hasDataSelected = hasPendingData(context)
		const canRunWithData = hasDataSelected && flowAcceptsShape(flow, context?.datasetShape || null)

		// Resolve step modules to get names and versions
		const stepDetails = (flow.spec?.steps || [])
			.map((step) => {
				if (!step.uses) return null
				const uses = step.uses

				// Try to find module in map
				let module = null
				if (uses.includes('@')) {
					// Has version: name@version
					module = modulesMap.get(uses)
				} else {
					// No version: try by name
					module = modulesMap.get(uses)
				}

				if (module) {
					return {
						id: step.id,
						name: module.name,
						version: module.version,
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
		card.className = 'flow-card'
		if (canRunWithData) {
			card.classList.add('flow-card-has-data')
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
			<div class="flow-card-header">
				<h3 class="flow-card-title">${flow.name}</h3>
				<button class="flow-card-menu" onclick="event.stopPropagation(); flowModule.showFlowMenu(${
					flow.id
				}, event)">⋯</button>
			</div>
			${dataBadge}
			${description ? `<p class="flow-card-description">${description}</p>` : ''}
			<div class="flow-card-footer" style="display: flex; justify-content: space-between; align-items: center; gap: 8px;">
				${
					stepDetails.length > 0
						? `<div style="display: flex; flex-wrap: wrap; gap: 4px; align-items: center;">${stepDetails
								.map((s) => {
									const versionText = s.version ? ` v${s.version}` : ''
									return `<span style="display: inline-block; padding: 4px 8px; background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 4px; font-size: 11px; color: #475569;">${s.name}${versionText}</span>`
								})
								.join('')}</div>`
						: `<span class="flow-step-badge">${stepCount} ${
								stepCount === 1 ? 'step' : 'steps'
							}</span>`
				}
				${
					canRunWithData
						? `<button class="flow-run-data-btn" data-flow-id="${flow.id}" style="background: linear-gradient(135deg, #2563eb 0%, #1d4ed8 100%); color: white; border: none; padding: 8px 16px; border-radius: 6px; font-weight: 600; font-size: 13px; cursor: pointer; display: flex; align-items: center; gap: 6px; box-shadow: 0 2px 6px rgba(37,99,235,0.3);">
						<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
							<polygon points="5 3 19 12 5 21 5 3"></polygon>
						</svg>
						Run with Selected Data
					</button>`
						: `<button class="flow-run-btn" data-flow-id="${flow.id}">▶ Run</button>`
				}
			</div>
		`

		// Card click handler removed - cards are not clickable
		container.appendChild(card)

		if (canRunWithData) {
			const runDataBtn = card.querySelector('.flow-run-data-btn')
			if (runDataBtn) {
				runDataBtn.addEventListener('click', async (event) => {
					event.stopPropagation()
					await handleFlowRunClick(flow.id)
				})
			}
		} else {
			const runBtn = card.querySelector('.flow-run-btn')
			if (runBtn) {
				runBtn.addEventListener('click', async (event) => {
					event.stopPropagation()
					await handleFlowRunClick(flow.id)
				})
			}
		}
	}

	function refreshFlowCards() {
		const gridContainer = document.getElementById('flows-grid')
		if (!gridContainer || !flowState.flows) return

		const existingCards = Array.from(gridContainer.querySelectorAll('.flow-card'))
		if (existingCards.length === 0) return

		// Re-render all cards with updated data selection state
		const fragment = document.createDocumentFragment()
		flowState.flows.forEach((flow) => {
			const existingCard = existingCards.find((card) => {
				const runBtn = card.querySelector('[data-flow-id]')
				return runBtn && parseInt(runBtn.dataset.flowId) === flow.id
			})
			if (existingCard) {
				existingCard.remove()
			}
			renderFlowCard(flow, fragment)
		})

		gridContainer.appendChild(fragment)
	}

	function getPendingDataRunContext() {
		// Always read fresh from sessionStorage - don't use cached state
		// This ensures we see the latest selection state from Data tab
		flowState.pendingDataRun = null

		if (typeof sessionStorage === 'undefined') {
			return null
		}

		const datasetNameRaw = sessionStorage.getItem('preselectedDatasetName')
		const datasetShapeRaw = sessionStorage.getItem('preselectedDatasetShape')
		const datasetDataTypeRaw = sessionStorage.getItem('preselectedDatasetDataType')

		// Check for URLs first (new approach), then fall back to file IDs (legacy)
		const urlsRaw = sessionStorage.getItem('preselectedUrls')
		const fileIdsRaw = sessionStorage.getItem('preselectedFileIds')

		if (!urlsRaw && !fileIdsRaw && !datasetNameRaw) {
			// Explicitly clear cache if no data
			flowState.pendingDataRun = null
			return null
		}

		let urls = []
		let fileIds = []

		// Parse URLs (new approach)
		if (urlsRaw) {
			try {
				const parsedUrls = JSON.parse(urlsRaw)
				if (Array.isArray(parsedUrls)) {
					// Accept syft://, file://, and absolute paths (starting with /)
					urls = [
						...new Set(
							parsedUrls.filter(
								(u) =>
									typeof u === 'string' &&
									(u.startsWith('syft://') || u.startsWith('file://') || u.startsWith('/')),
							),
						),
					]
				}
			} catch (error) {
				console.warn('Failed to parse preselectedUrls:', error)
				sessionStorage.removeItem('preselectedUrls')
			}
		}

		// Parse file IDs (legacy fallback)
		if (fileIdsRaw && urls.length === 0) {
			try {
				const parsedFileIds = JSON.parse(fileIdsRaw)
				if (Array.isArray(parsedFileIds)) {
					fileIds = Array.from(
						new Set(
							parsedFileIds
								.map((value) => parseInt(value, 10))
								.filter((value) => Number.isFinite(value)),
						),
					)
				}
			} catch (error) {
				console.warn('Failed to parse preselectedFileIds:', error)
				sessionStorage.removeItem('preselectedFileIds')
			}
		}

		if (urls.length === 0 && fileIds.length === 0 && !datasetNameRaw) {
			// Clear sessionStorage and cache if no valid data
			sessionStorage.removeItem('preselectedUrls')
			sessionStorage.removeItem('preselectedFileIds')
			flowState.pendingDataRun = null
			return null
		}

		// Parse participant IDs (strings, not ints - can be participant labels)
		let participantIds = []
		const participantsRaw = sessionStorage.getItem('preselectedParticipants')
		if (participantsRaw) {
			try {
				const parsedParticipants = JSON.parse(participantsRaw)
				if (Array.isArray(parsedParticipants)) {
					participantIds = parsedParticipants
						.map((p) => (p == null ? '' : String(p)))
						.filter((p) => p.length > 0)
				}
			} catch (error) {
				console.warn('Failed to parse preselectedParticipants:', error)
			}
		}

		const datasetName =
			datasetNameRaw && datasetNameRaw !== 'null' ? datasetNameRaw.trim() || null : null
		const datasetShape =
			datasetShapeRaw && datasetShapeRaw !== 'null' ? datasetShapeRaw.trim() || null : null
		const datasetDataType =
			datasetDataTypeRaw && datasetDataTypeRaw !== 'null' ? datasetDataTypeRaw.trim() || null : null

		const parseUrlList = (rawValue, label) => {
			if (!rawValue) return []
			try {
				const parsed = JSON.parse(rawValue)
				if (!Array.isArray(parsed)) return []
				return [
					...new Set(
						parsed.filter(
							(u) =>
								typeof u === 'string' &&
								(u.startsWith('syft://') || u.startsWith('file://') || u.startsWith('/')),
						),
					),
				]
			} catch (error) {
				console.warn(`Failed to parse ${label}:`, error)
				return []
			}
		}

		const mockUrls = parseUrlList(
			sessionStorage.getItem('preselectedUrlsMock'),
			'preselectedUrlsMock',
		)
		const realUrls = parseUrlList(
			sessionStorage.getItem('preselectedUrlsReal'),
			'preselectedUrlsReal',
		)

		let mockParticipantIds = []
		const mockParticipantsRaw = sessionStorage.getItem('preselectedParticipantsMock')
		if (mockParticipantsRaw) {
			try {
				const parsedParticipants = JSON.parse(mockParticipantsRaw)
				if (Array.isArray(parsedParticipants)) {
					mockParticipantIds = parsedParticipants
						.map((p) => (p == null ? '' : String(p)))
						.filter((p) => p.length > 0)
				}
			} catch (error) {
				console.warn('Failed to parse preselectedParticipantsMock:', error)
			}
		}

		let realParticipantIds = []
		const realParticipantsRaw = sessionStorage.getItem('preselectedParticipantsReal')
		if (realParticipantsRaw) {
			try {
				const parsedParticipants = JSON.parse(realParticipantsRaw)
				if (Array.isArray(parsedParticipants)) {
					realParticipantIds = parsedParticipants
						.map((p) => (p == null ? '' : String(p)))
						.filter((p) => p.length > 0)
				}
			} catch (error) {
				console.warn('Failed to parse preselectedParticipantsReal:', error)
			}
		}

		let assetKeys = []
		const assetKeysRaw = sessionStorage.getItem('preselectedAssetKeys')
		if (assetKeysRaw) {
			try {
				const parsedKeys = JSON.parse(assetKeysRaw)
				if (Array.isArray(parsedKeys)) {
					assetKeys = parsedKeys.filter((value) => typeof value === 'string' && value)
				}
			} catch (error) {
				console.warn('Failed to parse preselectedAssetKeys:', error)
			}
		}

		const datasetOwnerRaw = sessionStorage.getItem('preselectedDatasetOwner')
		const dataTypeRaw = sessionStorage.getItem('preselectedDataType')
		const dataSourceRaw = sessionStorage.getItem('preselectedDataSource')

		const context = {
			urls: urls.length > 0 ? urls : null,
			fileIds: fileIds.length > 0 ? fileIds : null,
			participantIds,
			datasetName,
			datasetShape,
			datasetDataType,
			datasetOwner: datasetOwnerRaw && datasetOwnerRaw.trim() ? datasetOwnerRaw : null,
			assetKeys,
			dataType: dataTypeRaw && dataTypeRaw.trim() ? dataTypeRaw : null,
			dataSource: dataSourceRaw && dataSourceRaw.trim() ? dataSourceRaw : null,
			mockUrls: mockUrls.length > 0 ? mockUrls : null,
			realUrls: realUrls.length > 0 ? realUrls : null,
			mockParticipantIds: mockParticipantIds.length > 0 ? mockParticipantIds : null,
			realParticipantIds: realParticipantIds.length > 0 ? realParticipantIds : null,
		}

		// Cache for performance, but will be cleared on next check if sessionStorage changed
		flowState.pendingDataRun = context
		return context
	}

	function clearDataRunContext() {
		flowState.pendingDataRun = null

		if (typeof sessionStorage === 'undefined') {
			return
		}

		try {
			sessionStorage.removeItem('preselectedUrls')
			sessionStorage.removeItem('preselectedFileIds')
			sessionStorage.removeItem('preselectedParticipants')
			sessionStorage.removeItem('preselectedDatasetName')
			sessionStorage.removeItem('preselectedDatasetShape')
			sessionStorage.removeItem('preselectedDatasetDataType')
			sessionStorage.removeItem('preselectedUrlsMock')
			sessionStorage.removeItem('preselectedUrlsReal')
			sessionStorage.removeItem('preselectedParticipantsMock')
			sessionStorage.removeItem('preselectedParticipantsReal')
			sessionStorage.removeItem('preselectedDatasetOwner')
			sessionStorage.removeItem('preselectedAssetKeys')
			sessionStorage.removeItem('preselectedDataType')
			sessionStorage.removeItem('preselectedDataSource')
		} catch (error) {
			console.warn('Failed to clear preselected session data:', error)
		}

		renderDataRunBanner()
	}

	function renderDataRunBanner() {
		const context = getPendingDataRunContext()
		const mainView = document.getElementById('flows-main-view')
		const bannerId = 'flows-data-banner'
		let banner = document.getElementById(bannerId)

		// Check for either URLs (new approach) or fileIds (legacy)
		const hasData = hasPendingData(context)
		if (!hasData) {
			if (banner) {
				banner.remove()
			}
			renderDetailDataRunBanner(null)
			// Refresh flow cards to remove data-specific UI
			refreshFlowCards()
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
		// Refresh flow cards to show data-specific UI
		refreshFlowCards()
	}

	function renderDetailDataRunBanner(context) {
		const detailView = document.getElementById('flow-detail-view')
		if (!detailView) return

		const bannerId = 'flow-detail-data-banner'
		let banner = document.getElementById(bannerId)

		const hasData = hasPendingData(context)
		if (!hasData) {
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

		const preselectedFlowId = flowState.currentFlow?.id ?? null
		populateDataRunBanner(banner, context, preselectedFlowId)
	}

	function populateMainDataRunBanner(banner, context) {
		const fileCount =
			(context.urls && context.urls.length) || (context.fileIds && context.fileIds.length) || 0
		const participantCount =
			context.participantIds && context.participantIds.length > 0
				? context.participantIds.length
				: fileCount

		const eligibleFlows = (flowState.flows || []).filter((flow) =>
			flowAcceptsShape(flow, context?.datasetShape || null),
		)

		banner.innerHTML = `
			<div style="display: flex; align-items: center; gap: 24px;">
				<div style="flex: 1; display: flex; flex-direction: column; gap: 8px;">
					<div style="display: flex; align-items: center; gap: 12px;">
						<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="color: #2563eb; flex-shrink: 0;">
							<path d="M9 11l3 3L22 4"></path>
							<path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"></path>
						</svg>
						<strong style="font-size: 15px; color: #1e40af; line-height: 1.4;">Data Selected for Flow Run</strong>
					</div>
					<div style="font-size: 14px; color: #475569; line-height: 1.6; margin-left: 32px;">
						<strong style="color: #1e293b;">${fileCount}</strong> file${fileCount === 1 ? '' : 's'} selected
						<span style="margin: 0 8px;">•</span>
						<strong style="color: #1e293b;">${participantCount}</strong> participant${
							participantCount === 1 ? '' : 's'
						}
						${
							eligibleFlows.length > 0
								? `<span style="margin-left: 12px; padding: 4px 10px; background: rgba(34,197,94,0.1); color: #16a34a; border-radius: 4px; font-size: 13px; font-weight: 500;">
								${eligibleFlows.length} compatible flow${eligibleFlows.length === 1 ? '' : 's'} available
							</span>`
								: ''
						}
					</div>
					${
						eligibleFlows.length > 1
							? `<div style="margin-left: 32px; font-size: 13px; color: #64748b; line-height: 1.5;">
							Select a flow below, or click "Choose Flow" to see all options.
						</div>`
							: ''
					}
				</div>
				<div style="display: flex; gap: 10px; align-items: center; flex-wrap: wrap; flex-shrink: 0;">
					${
						eligibleFlows.length > 1
							? `<button type="button" class="btn-primary" data-role="data-run-choose" style="font-size: 13px; padding: 10px 18px; background: linear-gradient(135deg, #2563eb 0%, #1d4ed8 100%); border-radius: 6px; font-weight: 600; display: flex; align-items: center; gap: 6px; white-space: nowrap; border: none; color: white; cursor: pointer; transition: all 0.2s; box-shadow: 0 2px 4px rgba(37,99,235,0.2);">
							<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
								<circle cx="5" cy="12" r="3" />
								<circle cx="19" cy="12" r="3" />
								<line x1="8" y1="12" x2="16" y2="12" />
							</svg>
							Choose Flow
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
					console.error('Failed to open flow selection modal:', error)
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

	function populateDataRunBanner(banner, context, preselectedFlowId = null) {
		const fileCount =
			(context.urls && context.urls.length) || (context.fileIds && context.fileIds.length) || 0
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
					<button type="button" class="btn-primary" data-role="data-run-open">Select Flow</button>
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
				startDataDrivenRun(preselectedFlowId).catch((error) => {
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

	async function startDataDrivenRun(preselectedFlowId = null) {
		if (flowState.dataRunModalOpen) {
			return true
		}

		const context = getPendingDataRunContext()
		logDataRunContext('startDataDrivenRun', context)
		const hasData = hasPendingData(context)
		if (!hasData) {
			return false
		}

		// Load flows if not already loaded
		if (!flowState.flows || flowState.flows.length === 0) {
			await loadFlows()
		}

		const selectionShape = context?.datasetShape || 'List[GenotypeRecord]'
		const eligibleFlows = (flowState.flows || []).filter((flow) =>
			flowAcceptsShape(flow, selectionShape),
		)

		if (eligibleFlows.length === 0) {
			logFlowDebug('startDataDrivenRun no eligible flows', flowState.flows || [])
			alert(`No flows are available that accept a ${selectionShape} input.`)
			clearDataRunContext()
			return false
		}

		await showDataRunModal(context, eligibleFlows, preselectedFlowId)
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
						statusEl.textContent = 'Docker is running! Starting flow...'
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
	async function showDataRunModalDirect(preselectedFlowId = null) {
		const context = getPendingDataRunContext()
		logDataRunContext('showDataRunModalDirect', context)
		const hasData = hasPendingData(context)
		if (!hasData) {
			return false
		}

		// Load flows if not already loaded
		if (!flowState.flows || flowState.flows.length === 0) {
			await loadFlows()
		}

		const selectionShape = context?.datasetShape || 'List[GenotypeRecord]'
		const eligibleFlows = (flowState.flows || []).filter((flow) =>
			flowAcceptsShape(flow, selectionShape),
		)

		if (eligibleFlows.length === 0) {
			logFlowDebug('showDataRunModalDirect no eligible flows', flowState.flows || [])
			if (dialog && dialog.message) {
				await dialog.message(
					`No flows are available that accept a ${selectionShape} input. Please create a compatible flow first.`,
					{ title: 'No Compatible Flows', type: 'warning' },
				)
			} else {
				alert(`No flows are available that accept a ${selectionShape} input.`)
			}
			clearDataRunContext()
			return false
		}

		await showDataRunModal(context, eligibleFlows, preselectedFlowId)
		return true
	}

	async function handleFlowRunClick(flowId) {
		// Always use the new data-driven flow
		const handled = await startDataDrivenRun(flowId)
		if (!handled) {
			// Check why it wasn't handled
			const context = getPendingDataRunContext()
			const hasData = hasPendingData(context)

			if (!hasData) {
				// No data selected - prompt user to select data first
				if (dialog && dialog.confirm) {
					const shouldNavigate = await dialog.confirm(
						'No data selected. Would you like to go to the Data tab to select files before running this flow?',
						{ title: 'Select Data First', type: 'info' },
					)
					if (shouldNavigate && navigateTo) {
						navigateTo('data')
					}
				} else {
					const shouldNavigate = confirm(
						'No data selected. Would you like to go to the Data tab to select files before running this flow?',
					)
					if (shouldNavigate && navigateTo) {
						navigateTo('data')
					}
				}
			} else {
				// Data is selected but flow might not be compatible
				const flow = flowState.flows.find((p) => p.id === flowId)
				const selectionShape = context?.datasetShape || 'List[GenotypeRecord]'
				if (flow && !flowAcceptsShape(flow, selectionShape)) {
					if (dialog && dialog.message) {
						await dialog.message(
							`This flow does not accept ${selectionShape} input. Please select a compatible flow or modify this flow to accept the selected data.`,
							{ title: 'Incompatible Flow', type: 'warning' },
						)
					} else {
						alert(
							`This flow does not accept ${selectionShape} input. Please select a compatible flow or modify this flow to accept the selected data.`,
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

	function splitTypeTopLevel(value, delimiter) {
		if (!value) return []
		const parts = []
		let depth = 0
		let start = 0
		for (let i = 0; i < value.length; i++) {
			const ch = value[i]
			if (ch === '[' || ch === '{') depth += 1
			if (ch === ']' || ch === '}') depth = Math.max(0, depth - 1)
			if (ch === delimiter && depth === 0) {
				parts.push(value.slice(start, i).trim())
				start = i + 1
			}
		}
		parts.push(value.slice(start).trim())
		return parts.filter((part) => part)
	}

	function splitTypeTopLevelOnce(value, delimiter) {
		if (!value) return null
		let depth = 0
		for (let i = 0; i < value.length; i++) {
			const ch = value[i]
			if (ch === '[' || ch === '{') depth += 1
			if (ch === ']' || ch === '}') depth = Math.max(0, depth - 1)
			if (ch === delimiter && depth === 0) {
				return [value.slice(0, i).trim(), value.slice(i + 1).trim()]
			}
		}
		return null
	}

	function normalizeTypeName(typeName) {
		if (!typeName) return null
		switch (typeName.toLowerCase()) {
			case 'string':
				return 'String'
			case 'bool':
				return 'Bool'
			case 'file':
				return 'File'
			case 'directory':
				return 'Directory'
			case 'participantsheet':
				return 'ParticipantSheet'
			case 'genotyperecord':
				return 'GenotypeRecord'
			case 'biovaultcontext':
				return 'BiovaultContext'
			default:
				return typeName
		}
	}

	function parseTypeExpr(raw) {
		if (!raw || typeof raw !== 'string') return null
		let trimmed = raw.trim()
		if (!trimmed) return null
		let optional = false
		if (trimmed.endsWith('?')) {
			optional = true
			trimmed = trimmed.slice(0, -1).trim()
		}
		const lowered = trimmed.toLowerCase()
		if (lowered.startsWith('list[') && trimmed.endsWith(']')) {
			const inner = trimmed.slice(5, -1)
			return { kind: 'List', optional, inner: parseTypeExpr(inner) }
		}
		if (lowered.startsWith('map[') && trimmed.endsWith(']')) {
			const inner = trimmed.slice(4, -1)
			const parts = splitTypeTopLevel(inner, ',')
			if (parts.length !== 2 || parts[0].toLowerCase() !== 'string') return null
			return { kind: 'Map', optional, value: parseTypeExpr(parts[1]) }
		}
		if ((lowered.startsWith('record{') || lowered.startsWith('dict{')) && trimmed.endsWith('}')) {
			const inner = trimmed.slice(trimmed.indexOf('{') + 1, -1).trim()
			if (!inner) return null
			const fields = splitTypeTopLevel(inner, ',')
				.map((field) => {
					const parts = splitTypeTopLevelOnce(field, ':')
					if (!parts) return null
					return { name: parts[0], type: parseTypeExpr(parts[1]) }
				})
				.filter((field) => field && field.name)
			return { kind: 'Record', optional, fields }
		}
		return { kind: normalizeTypeName(trimmed), optional }
	}

	function typeExprsCompatible(expected, actual) {
		if (!expected || !actual) return false
		if (expected.optional) return typeExprsCompatible({ ...expected, optional: false }, actual)
		if (actual.optional) return typeExprsCompatible(expected, { ...actual, optional: false })
		if (expected.kind !== actual.kind) return false
		switch (expected.kind) {
			case 'List':
				return typeExprsCompatible(expected.inner, actual.inner)
			case 'Map':
				return typeExprsCompatible(expected.value, actual.value)
			case 'Record': {
				const expectedFields = expected.fields || []
				const actualFields = actual.fields || []
				if (expectedFields.length !== actualFields.length) return false
				for (const field of expectedFields) {
					const match = actualFields.find((candidate) => candidate.name === field.name)
					if (!match) return false
					if (!typeExprsCompatible(field.type, match.type)) return false
				}
				return true
			}
			default:
				return true
		}
	}

	function typesCompatible(expectedRaw, actualRaw) {
		const expected = parseTypeExpr(expectedRaw)
		const actual = parseTypeExpr(actualRaw)
		if (expected && actual) {
			return typeExprsCompatible(expected, actual)
		}
		if (!expectedRaw || !actualRaw) return false
		return (
			expectedRaw.trim().replace(/\?$/, '').toLowerCase() ===
			actualRaw.trim().replace(/\?$/, '').toLowerCase()
		)
	}

	function extractAssetFilename(filePath) {
		if (!filePath) return null
		const trimmed = String(filePath).split('#')[0].replace(/\/+$/, '')
		const parts = trimmed.split('/')
		const name = parts[parts.length - 1]
		return name || null
	}

	function parseAssetRef(raw) {
		if (!raw) return null
		if (typeof raw === 'object') return raw
		if (typeof raw !== 'string') return null
		try {
			return JSON.parse(raw)
		} catch {
			return null
		}
	}

	function assetHasEntries(raw) {
		const parsed = parseAssetRef(raw)
		return Array.isArray(parsed?.entries) && parsed.entries.length > 0
	}

	function isTwinListAsset(asset) {
		const kind = (asset?.kind || asset?.type || '').toString().toLowerCase()
		return (
			kind === 'twin_list' ||
			assetHasEntries(asset?.private_ref) ||
			assetHasEntries(asset?.mock_ref)
		)
	}

	function collectDatasetAssetPaths(assets, dataType) {
		const paths = []
		const includePrivate = dataType === 'real' || dataType === 'both' || !dataType
		const includeMock = dataType === 'mock' || dataType === 'both'

		;(assets || []).forEach((asset) => {
			if (!asset) return
			if (includePrivate) {
				const privatePath = asset.resolved_private_path || asset.private_path
				if (privatePath) paths.push(privatePath)
			}
			if (includeMock) {
				const mockPath = asset.resolved_mock_path || asset.mock_path || asset.mock_url
				if (mockPath) paths.push(mockPath)
			}
		})

		return paths
	}

	function inferDatasetShapeFromAssets(assets, dataType) {
		if (!Array.isArray(assets) || assets.length === 0) return null
		if (assets.some((asset) => isTwinListAsset(asset))) {
			return 'List[GenotypeRecord]'
		}

		const filePaths = collectDatasetAssetPaths(assets, dataType)
		if (filePaths.length === 0) return null

		const groups = new Map()
		filePaths.forEach((path) => {
			const filename = extractAssetFilename(path)
			if (!filename) return
			const dot = filename.lastIndexOf('.')
			if (dot <= 0) return
			const stem = filename.slice(0, dot)
			const ext = filename.slice(dot + 1).toLowerCase()
			if (!['bed', 'bim', 'fam'].includes(ext)) return
			if (!groups.has(stem)) {
				groups.set(stem, new Set())
			}
			groups.get(stem).add(ext)
		})

		if (groups.size > 0) {
			const allComplete = Array.from(groups.values()).every(
				(exts) => exts.has('bed') && exts.has('bim') && exts.has('fam'),
			)
			if (allComplete) {
				return 'Map[String, Record{bed: File, bim: File, fam: File}]'
			}
		}

		if (filePaths.length === 1) return 'File'
		return 'Map[String, File]'
	}

	function resolveDatasetShape(entry, assets, dataType) {
		const extra = entry?.dataset?.extra
		if (extra && typeof extra === 'object') {
			const extraShape = extra.shape
			if (typeof extraShape === 'string' && extraShape.trim()) {
				return extraShape.trim()
			}
		} else if (typeof extra === 'string') {
			try {
				const parsed = JSON.parse(extra)
				if (parsed && typeof parsed.shape === 'string' && parsed.shape.trim()) {
					return parsed.shape.trim()
				}
			} catch {
				// ignore
			}
		}

		const manifestShape = entry?.manifest?.shape || entry?.shape
		if (typeof manifestShape === 'string' && manifestShape.trim()) {
			return manifestShape.trim()
		}

		return inferDatasetShapeFromAssets(assets, dataType)
	}

	function flowAcceptsShape(flow, shape) {
		if (!flow) return false
		const inputs = flow?.spec?.inputs || {}
		const expectedShape = shape || 'List[GenotypeRecord]'
		return Object.values(inputs).some((inputSpec) => {
			const typeStr = describeInputType(inputSpec)
			return typeof typeStr === 'string' && typesCompatible(expectedShape, typeStr)
		})
	}

	function flowAcceptsGenotypeInput(flow) {
		return flowAcceptsShape(flow, 'List[GenotypeRecord]')
	}

	function logFlowDebug(label, flows) {
		if (!flows || flows.length === 0) {
			console.log(`[Flows Debug] ${label}: no flows`)
			return
		}

		const summary = flows.map((flow) => {
			const inputs = flow?.spec?.inputs || {}
			const inputTypes = Object.entries(inputs).map(([key, spec]) => {
				const typeStr = describeInputType(spec)
				return typeStr ? `${key}:${typeStr}` : key
			})

			return {
				id: flow?.id,
				name: flow?.name,
				inputs: inputTypes,
				steps: flow?.spec?.steps?.length || 0,
				acceptsGenotype: flowAcceptsGenotypeInput(flow),
			}
		})

		console.log(`[Flows Debug] ${label}`, summary)
	}

	function logDataRunContext(label, context) {
		console.log(`[Flows Debug] ${label} context`, {
			hasContext: Boolean(context),
			urls: context?.urls?.length || 0,
			mockUrls: context?.mockUrls?.length || 0,
			realUrls: context?.realUrls?.length || 0,
			fileIds: context?.fileIds?.length || 0,
			participantIds: context?.participantIds?.length || 0,
			dataType: context?.dataType || null,
		})
	}

	function hasPendingData(context) {
		return (
			!!context &&
			((context.urls && context.urls.length > 0) ||
				(context.fileIds && context.fileIds.length > 0) ||
				context.datasetName)
		)
	}

	function closeDataRunModal(clearContext = false) {
		const modal = document.getElementById('data-run-modal')
		if (modal) {
			modal.remove()
		}
		flowState.dataRunModalOpen = false

		if (clearContext) {
			clearDataRunContext()
		}

		renderDataRunBanner()
	}

	async function showDataRunModal(context, flows, preselectedFlowId = null) {
		if (!context || !flows || flows.length === 0) {
			return
		}

		flowState.dataRunModalOpen = true

		let runsBaseDir = ''
		try {
			runsBaseDir = await invoke('get_runs_base_dir')
		} catch (error) {
			console.warn('Failed to get runs base directory:', error)
		}

		const selectionShape = context?.datasetShape || 'List[GenotypeRecord]'
		const isDatasetSelection =
			!!context.datasetName &&
			!(context.urls && context.urls.length) &&
			!(context.fileIds && context.fileIds.length)
		const dataCount = isDatasetSelection
			? 0
			: (context.urls && context.urls.length) || (context.fileIds && context.fileIds.length) || 0
		const uniqueParticipantCount =
			!isDatasetSelection && context.participantIds && context.participantIds.length > 0
				? context.participantIds.filter((p) => p).length // Filter out empty strings
				: dataCount
		const fileCount = dataCount
		const datasetLabel = context.datasetName ? escapeHtml(context.datasetName) : null
		const datasetTypeLabel = context.datasetDataType ? escapeHtml(context.datasetDataType) : null
		const summaryDetailHtml = isDatasetSelection
			? `<div style="font-size: 15px; color: #475569; line-height: 1.6; margin-bottom: 8px;">
					Dataset <strong style="color: #0f172a; font-weight: 600;">${datasetLabel}</strong>${
						datasetTypeLabel ? ` (${datasetTypeLabel})` : ''
					}
				</div>
				<div style="font-size: 13px; color: #64748b;">
					Shape: <strong style="color: #0f172a; font-weight: 600;">${escapeHtml(selectionShape)}</strong>
				</div>`
			: `<div style="font-size: 15px; color: #475569; line-height: 1.6; margin-bottom: 8px;">
					<strong style="color: #0f172a; font-weight: 600;">${fileCount}</strong> genotype file${
						fileCount === 1 ? '' : 's'
					} 
					covering <strong style="color: #0f172a; font-weight: 600;">${uniqueParticipantCount}</strong> participant${
						uniqueParticipantCount === 1 ? '' : 's'
					}
				</div>`
		const summaryFooterHtml = isDatasetSelection
			? `<div style="font-size: 13px; color: #64748b; margin-top: 10px; padding-top: 10px; border-top: 1px solid rgba(59,130,246,0.2); line-height: 1.5;">
					We will pass the dataset map directly to the flow.
				</div>`
			: `<div style="font-size: 13px; color: #64748b; margin-top: 10px; padding-top: 10px; border-top: 1px solid rgba(59,130,246,0.2); line-height: 1.5;">
					We will generate a temporary samplesheet automatically for this run.
				</div>`

		const flowOptionsHtml = flows
			.map((flow, index) => {
				const isPreferred = preselectedFlowId !== null && flow.id === preselectedFlowId
				const isDefault = isPreferred || (preselectedFlowId === null && index === 0)
				const isChecked = isDefault ? 'checked' : ''
				const inputs = flow?.spec?.inputs || {}

				const inputSummary = Object.entries(inputs)
					.map(([key, value]) => `${key}: ${describeInputType(value)}`)
					.join(', ')

				const description = flow?.spec?.description
					? `<div class="option-desc">${escapeHtml(flow.spec.description)}</div>`
					: ''

				const stepCount = flow.spec?.steps?.length || 0
				return `
					<label class="data-run-flow-option" data-flow-id="${
						flow.id
					}" style="display: flex; align-items: flex-start; gap: 16px; border: 2px solid ${
						isPreferred ? '#2563eb' : '#e2e8f0'
					}; border-radius: 12px; padding: 20px 24px; cursor: pointer; background: ${
						isPreferred ? 'linear-gradient(135deg, #eff6ff 0%, #dbeafe 100%)' : '#ffffff'
					}; transition: all 0.25s cubic-bezier(0.16, 1, 0.3, 1); ${
						isPreferred
							? 'box-shadow: 0 4px 12px rgba(37,99,235,0.15);'
							: 'box-shadow: 0 1px 3px rgba(0, 0, 0, 0.05);'
					};">
						<input type="radio" name="data-run-flow" value="${
							flow.id
						}" ${isChecked} style="margin-top: 4px; accent-color: #2563eb; width: 18px; height: 18px; cursor: pointer;">
						<div class="option-details" style="flex: 1; min-width: 0;">
							<div style="display: flex; align-items: center; gap: 10px; margin-bottom: 8px; flex-wrap: wrap;">
								<div class="option-title" style="font-weight: 700; font-size: 16px; color: #0f172a; letter-spacing: -0.01em;">
									${escapeHtml(flow.name || `Flow #${flow.id}`)}
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
				.data-run-modal .data-run-flow-option:hover {
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
						Run Flow with Selected Data
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
						${summaryDetailHtml}
						${summaryFooterHtml}
					</div>
					<div class="data-run-section" style="margin-bottom: 28px;">
						<h3 style="margin: 0 0 16px 0; font-size: 16px; font-weight: 700; color: #0f172a; letter-spacing: -0.01em; display: flex; align-items: center; gap: 10px;">
							<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="color: #475569;">
								<circle cx="5" cy="12" r="3" />
								<circle cx="19" cy="12" r="3" />
								<line x1="8" y1="12" x2="16" y2="12" />
							</svg>
							Select a Flow
						</h3>
						<div class="data-run-flow-list" style="display: flex; flex-direction: column; gap: 12px; max-height: 320px; overflow-y: auto; padding-right: 4px;">
							${flowOptionsHtml}
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
							Run Flow
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

		// Add hover effects to flow options
		const optionLabels = modal.querySelectorAll('.data-run-flow-option')
		function refreshOptionStyles() {
			optionLabels.forEach((label) => {
				const radio = label.querySelector('input[type="radio"]')
				if (radio && radio.checked) {
					label.style.borderColor = '#2563eb'
					label.style.background = 'linear-gradient(135deg, #eff6ff 0%, #dbeafe 100%)'
					label.style.boxShadow = '0 4px 12px rgba(37,99,235,0.2)'
					label.style.transform = 'translateY(-1px)'
				} else {
					const isPreferred = label.dataset.flowId === preselectedFlowId?.toString()
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
			const selectedRadio = modal.querySelector('input[name="data-run-flow"]:checked')
			if (!selectedRadio) {
				alert('Please select a flow to run.')
				return
			}

			const flowId = parseInt(selectedRadio.value, 10)
			if (!Number.isFinite(flowId)) {
				alert('Invalid flow selection.')
				return
			}

			const resultsDir = resultsInput.value.trim() || null
			const performRuns = async () => {
				runBtn.disabled = true
				runBtn.textContent = 'Starting…'

				// Build input overrides from test config if available
				const inputOverrides = {}
				const testOverrides =
					typeof window !== 'undefined' ? window.__TEST_PIPELINE_OVERRIDES__ : null
				if (testOverrides && typeof testOverrides === 'object') {
					for (const [key, value] of Object.entries(testOverrides)) {
						inputOverrides[key] = value
					}
				}

				const baseResultsDir = resultsDir ? resultsDir.replace(/[\\/]+$/, '') : null
				const hasSplitUrls =
					(context.mockUrls && context.mockUrls.length > 0) ||
					(context.realUrls && context.realUrls.length > 0)

				let runSets = []
				if (context.dataType === 'both' && hasSplitUrls) {
					if (context.mockUrls && context.mockUrls.length > 0) {
						runSets.push({
							label: 'mock',
							dataType: 'mock',
							urls: context.mockUrls,
							participantIds: context.mockParticipantIds || [],
						})
					}
					if (context.realUrls && context.realUrls.length > 0) {
						runSets.push({
							label: 'real',
							dataType: 'real',
							urls: context.realUrls,
							participantIds: context.realParticipantIds || [],
						})
					}
				} else {
					runSets = [
						{
							label: context.dataType || 'data',
							dataType: context.dataType || null,
							urls: context.urls || [],
							fileIds: context.fileIds || [],
							participantIds: context.participantIds || [],
							datasetName: context.datasetName || null,
							datasetShape: context.datasetShape || null,
							datasetDataType: context.datasetDataType || null,
						},
					]
				}

				runSets = runSets.filter(
					(runSet) =>
						(runSet.urls && runSet.urls.length > 0) ||
						(runSet.fileIds && runSet.fileIds.length > 0),
				)

				if (runSets.length === 0) {
					runBtn.disabled = false
					runBtn.textContent = 'Run Flow'
					alert('No data selected to run.')
					return
				}

				if (context.dataType === 'both' && runSets.length === 1 && dialog?.message) {
					await dialog.message(
						'Only one data side is available. Running the available data selection.',
						{ title: 'Partial Selection', type: 'warning' },
					)
				}

				try {
					const runs = []
					for (const [index, runSet] of runSets.entries()) {
						const label = runSet.label || `run-${index + 1}`
						runBtn.textContent = `Running ${label}…`

						const resolvedResultsDir =
							baseResultsDir && runSets.length > 1 ? `${baseResultsDir}/${label}` : baseResultsDir

						const run = await invoke('run_flow', {
							flowId,
							inputOverrides,
							resultsDir: resolvedResultsDir,
							selection: {
								urls: runSet.urls || [],
								fileIds: runSet.fileIds || [],
								participantIds: runSet.participantIds || [],
								datasetName: context.datasetName || null,
								datasetShape: context.datasetShape || null,
								datasetDataType: runSet.dataType || context.datasetDataType || null,
								datasetOwner: context.datasetOwner || null,
								assetKeys: context.assetKeys || [],
								dataType: runSet.dataType || context.dataType || null,
								dataSource: context.dataSource || null,
							},
						})
						runs.push(run)
					}

					clearDataRunContext()
					closeDataRunModal()

					if (typeof sessionStorage !== 'undefined' && runs.length > 0) {
						sessionStorage.setItem('autoExpandRunId', runs[runs.length - 1].id.toString())
					}

					const runIds = runs.map((run) => run.id).join(', ')
					alert(`Flow started! Run ID${runs.length === 1 ? '' : 's'}: ${runIds}`)

					if (typeof navigateTo === 'function') {
						navigateTo('runs')
					}
				} catch (error) {
					console.error('Failed to start flow:', error)
					alert('Failed to run flow: ' + error)
				} finally {
					runBtn.disabled = false
					runBtn.textContent = 'Run Flow'
				}
			}

			runBtn.disabled = true
			runBtn.textContent = 'Checking Docker…'
			try {
				const running = await invoke('check_docker_running')
				if (running) {
					await performRuns()
				} else {
					runBtn.disabled = false
					runBtn.textContent = 'Run Flow'
					await showDockerWarningModal(performRuns)
				}
			} catch (err) {
				console.warn('Docker check failed (continuing):', err)
				runBtn.disabled = false
				runBtn.textContent = 'Run Flow'
				await showDockerWarningModal(performRuns)
			}
		})
	}

	// Show flow creation options
	async function showCreateFlowWizard() {
		showTemplateFlowPicker()
	}

	async function showTemplateFlowPicker() {
		// Add CSS for the new flow modal if not exists
		if (!document.getElementById('new-flow-modal-styles')) {
			const style = document.createElement('style')
			style.id = 'new-flow-modal-styles'
			style.textContent = `
				.new-flow-modal .modal-backdrop {
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
				.new-flow-modal .new-flow-modal-panel {
					animation: slideUp 0.3s cubic-bezier(0.16, 1, 0.3, 1);
				}
				.new-flow-template-card {
					transition: all 0.2s cubic-bezier(0.16, 1, 0.3, 1);
				}
				.new-flow-template-card:hover {
					transform: translateY(-2px);
					box-shadow: 0 8px 24px rgba(37,99,235,0.15) !important;
					border-color: #3b82f6 !important;
				}
				.new-flow-template-card:active {
					transform: translateY(0);
				}
				.new-flow-option-card {
					transition: all 0.2s cubic-bezier(0.16, 1, 0.3, 1);
				}
				.new-flow-option-card:hover {
					transform: translateY(-2px);
					box-shadow: 0 8px 24px rgba(0, 0, 0, 0.12) !important;
					border-color: #cbd5e1 !important;
				}
				.new-flow-option-card:active {
					transform: translateY(0);
				}
				.new-flow-modal .modal-close-btn:hover {
					background: #f8fafc !important;
					color: #0f172a !important;
					transform: translateY(-1px);
				}
			`
			document.head.appendChild(style)
		}

		const modal = document.createElement('div')
		modal.id = 'flow-picker-modal'
		modal.className = 'modal new-flow-modal'
		modal.setAttribute('role', 'dialog')
		modal.setAttribute('aria-modal', 'true')
		modal.style.cssText =
			'position: fixed; top: 0; left: 0; width: 100%; height: 100%; display: flex; align-items: center; justify-content: center; z-index: 1000;'

		modal.innerHTML = `
			<div class="modal-backdrop" data-modal-close="new-flow"></div>
			<div class="new-flow-modal-panel" style="position: relative; width: 900px; max-width: 95vw; max-height: 90vh; background: #ffffff; border-radius: 16px; box-shadow: 0 20px 60px rgba(0, 0, 0, 0.3), 0 0 0 1px rgba(0, 0, 0, 0.05); display: flex; flex-direction: column; overflow: hidden;">
				<div class="new-flow-modal-header" style="flex-shrink: 0; display: flex; align-items: center; justify-content: space-between; padding: 22px 32px; border-bottom: 1px solid #f1f5f9; background: #ffffff;">
					<h2 class="new-flow-modal-title" style="margin: 0; font-size: 22px; font-weight: 700; color: #0f172a; letter-spacing: -0.02em; display: flex; align-items: center; gap: 12px;">
						<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" style="color: #2563eb;">
							<line x1="12" y1="5" x2="12" y2="19"></line>
							<line x1="5" y1="12" x2="19" y2="12"></line>
						</svg>
						Create New Flow
					</h2>
					<button type="button" class="modal-close-btn" data-modal-close="new-flow" aria-label="Close" style="width: 36px; height: 36px; padding: 0; display: flex; align-items: center; justify-content: center; background: transparent; border: none; border-radius: 8px; cursor: pointer; color: #64748b; transition: all 0.2s cubic-bezier(0.16, 1, 0.3, 1);">
						<svg width="20" height="20" viewBox="0 0 16 16" fill="currentColor">
							<path d="M3.72 3.72a.75.75 0 0 1 1.06 0L8 6.94l3.22-3.22a.749.749 0 0 1 1.275.326.749.749 0 0 1-.215.734L9.06 8l3.22 3.22a.749.749 0 0 1-.326 1.275.749.749 0 0 1-.734-.215L8 9.06l-3.22 3.22a.751.751 0 0 1-1.042-.018.751.751 0 0 1-.018-1.042L6.94 8 3.72 4.78a.75.75 0 0 1 0-1.06Z"/>
						</svg>
					</button>
				</div>
				<div class="new-flow-modal-body" style="flex: 1; min-height: 0; overflow-y: auto; overflow-x: hidden; padding: 28px 32px; background: #fafbfc;">
					<div style="margin-bottom: 24px;">
						<p style="font-size: 15px; color: #475569; line-height: 1.6; margin: 0;">
							Choose a template to get started quickly, or import your own flow from GitHub or a local folder.
						</p>
					</div>
					
					<div style="margin-bottom: 32px;">
						<h3 style="margin: 0 0 16px 0; font-size: 16px; font-weight: 700; color: #0f172a; letter-spacing: -0.01em; display: flex; align-items: center; gap: 10px;">
							<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="color: #475569;">
								<rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect>
								<line x1="3" y1="9" x2="21" y2="9"></line>
								<line x1="9" y1="21" x2="9" y2="9"></line>
							</svg>
							Template Flows
						</h3>
						<div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: 16px;">
							<button type="button" class="new-flow-template-card" onclick="flowModule.importTemplateFlow('apol1')" style="background: linear-gradient(135deg, #ffffff 0%, #f8fafc 100%); border: 2px solid #e2e8f0; border-radius: 12px; padding: 20px; cursor: pointer; text-align: left; display: flex; flex-direction: column; gap: 12px; box-shadow: 0 1px 3px rgba(0, 0, 0, 0.05);">
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
							<button type="button" class="new-flow-template-card" onclick="flowModule.importTemplateFlow('brca')" style="background: linear-gradient(135deg, #ffffff 0%, #f8fafc 100%); border: 2px solid #e2e8f0; border-radius: 12px; padding: 20px; cursor: pointer; text-align: left; display: flex; flex-direction: column; gap: 12px; box-shadow: 0 1px 3px rgba(0, 0, 0, 0.05);">
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
							<button type="button" class="new-flow-template-card" onclick="flowModule.importTemplateFlow('herc2')" style="background: linear-gradient(135deg, #ffffff 0%, #f8fafc 100%); border: 2px solid #e2e8f0; border-radius: 12px; padding: 20px; cursor: pointer; text-align: left; display: flex; flex-direction: column; gap: 12px; box-shadow: 0 1px 3px rgba(0, 0, 0, 0.05);">
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
							<button type="button" class="new-flow-template-card" onclick="flowModule.importTemplateFlow('thalassemia')" style="background: linear-gradient(135deg, #ffffff 0%, #f8fafc 100%); border: 2px solid #e2e8f0; border-radius: 12px; padding: 20px; cursor: pointer; text-align: left; display: flex; flex-direction: column; gap: 12px; box-shadow: 0 1px 3px rgba(0, 0, 0, 0.05);">
								<div style="display: flex; align-items: center; gap: 12px;">
									<div style="width: 40px; height: 40px; border-radius: 10px; background: linear-gradient(135deg, #ef4444 0%, #dc2626 100%); display: flex; align-items: center; justify-content: center; flex-shrink: 0;">
										<img src="assets/icons/dna.svg" alt="DNA icon" style="width: 20px; height: 20px; filter: brightness(0) invert(1);">
									</div>
									<div style="flex: 1; min-width: 0;">
										<div style="font-size: 16px; font-weight: 700; color: #0f172a; margin-bottom: 4px;">Thalassemia Classifier</div>
										<div style="font-size: 13px; color: #64748b; line-height: 1.4;">Blood disorder variants</div>
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
							<button type="button" class="new-flow-option-card" onclick="flowModule.showImportOptions()" style="background: #ffffff; border: 1.5px solid #e2e8f0; border-radius: 12px; padding: 20px; cursor: pointer; text-align: left; display: flex; align-items: center; gap: 16px; box-shadow: 0 1px 3px rgba(0, 0, 0, 0.05);">
								<div style="width: 44px; height: 44px; border-radius: 10px; background: linear-gradient(135deg, #f1f5f9 0%, #e2e8f0 100%); display: flex; align-items: center; justify-content: center; flex-shrink: 0;">
									<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="color: #475569;">
										<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>
										<polyline points="17 8 12 3 7 8"></polyline>
										<line x1="12" y1="3" x2="12" y2="15"></line>
									</svg>
								</div>
								<div style="flex: 1; min-width: 0;">
									<div style="font-size: 15px; font-weight: 700; color: #0f172a; margin-bottom: 4px;">Import Your Own</div>
									<div style="font-size: 13px; color: #64748b; line-height: 1.5;">Import from GitHub, local folder, or create a blank flow</div>
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
		const closeModal = () => closeFlowPickerModal()

		if (backdrop) {
			backdrop.addEventListener('click', closeModal)
		}
		if (closeBtn) {
			closeBtn.addEventListener('click', closeModal)
		}

		document.addEventListener('keydown', function escapeHandler(e) {
			if (e.key === 'Escape' && document.getElementById('flow-picker-modal')) {
				closeModal()
				document.removeEventListener('keydown', escapeHandler)
			}
		})
	}

	async function showImportOptions() {
		closeFlowPickerModal()

		const modal = document.createElement('div')
		modal.id = 'flow-import-options-modal'
		modal.className = 'modal new-flow-modal'
		modal.setAttribute('role', 'dialog')
		modal.setAttribute('aria-modal', 'true')
		modal.style.cssText =
			'position: fixed; top: 0; left: 0; width: 100%; height: 100%; display: flex; align-items: center; justify-content: center; z-index: 1000;'

		modal.innerHTML = `
			<div class="modal-backdrop" data-modal-close="import-options"></div>
			<div class="new-flow-modal-panel" style="position: relative; width: 700px; max-width: 95vw; max-height: 90vh; background: #ffffff; border-radius: 16px; box-shadow: 0 20px 60px rgba(0, 0, 0, 0.3), 0 0 0 1px rgba(0, 0, 0, 0.05); display: flex; flex-direction: column; overflow: hidden;">
				<div class="new-flow-modal-header" style="flex-shrink: 0; display: flex; align-items: center; justify-content: space-between; padding: 22px 32px; border-bottom: 1px solid #f1f5f9; background: #ffffff;">
					<h2 class="new-flow-modal-title" style="margin: 0; font-size: 22px; font-weight: 700; color: #0f172a; letter-spacing: -0.02em; display: flex; align-items: center; gap: 12px;">
						<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" style="color: #2563eb;">
							<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>
							<polyline points="17 8 12 3 7 8"></polyline>
							<line x1="12" y1="3" x2="12" y2="15"></line>
						</svg>
						Import Flow
					</h2>
					<button type="button" class="modal-close-btn" data-modal-close="import-options" aria-label="Close" style="width: 36px; height: 36px; padding: 0; display: flex; align-items: center; justify-content: center; background: transparent; border: none; border-radius: 8px; cursor: pointer; color: #64748b; transition: all 0.2s cubic-bezier(0.16, 1, 0.3, 1);">
						<svg width="20" height="20" viewBox="0 0 16 16" fill="currentColor">
							<path d="M3.72 3.72a.75.75 0 0 1 1.06 0L8 6.94l3.22-3.22a.749.749 0 0 1 1.275.326.749.749 0 0 1-.215.734L9.06 8l3.22 3.22a.749.749 0 0 1-.326 1.275.749.749 0 0 1-.734-.215L8 9.06l-3.22 3.22a.751.751 0 0 1-1.042-.018.751.751 0 0 1-.018-1.042L6.94 8 3.72 4.78a.75.75 0 0 1 0-1.06Z"/>
						</svg>
					</button>
				</div>
				<div class="new-flow-modal-body" style="flex: 1; min-height: 0; overflow-y: auto; overflow-x: hidden; padding: 28px 32px; background: #fafbfc;">
					<div style="display: flex; flex-direction: column; gap: 14px;">
						<button type="button" class="new-flow-option-card" onclick="flowModule.importFlowFromURL()" style="background: #ffffff; border: 1.5px solid #e2e8f0; border-radius: 12px; padding: 22px; cursor: pointer; text-align: left; display: flex; align-items: center; gap: 16px; box-shadow: 0 1px 3px rgba(0, 0, 0, 0.05);">
							<div style="width: 48px; height: 48px; border-radius: 12px; background: linear-gradient(135deg, #eff6ff 0%, #dbeafe 100%); display: flex; align-items: center; justify-content: center; flex-shrink: 0; border: 1px solid #bfdbfe;">
								<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="color: #2563eb;">
									<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"></path>
									<path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"></path>
								</svg>
							</div>
							<div style="flex: 1; min-width: 0;">
								<div style="font-size: 16px; font-weight: 700; color: #0f172a; margin-bottom: 6px;">Import from GitHub</div>
								<div style="font-size: 13px; color: #64748b; line-height: 1.5;">Download a flow and all its steps from a GitHub repository URL</div>
							</div>
							<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="color: #94a3b8; flex-shrink: 0;">
								<polyline points="9 18 15 12 9 6"></polyline>
							</svg>
						</button>
						<button type="button" class="new-flow-option-card" onclick="flowModule.importExistingFlow()" style="background: #ffffff; border: 1.5px solid #e2e8f0; border-radius: 12px; padding: 22px; cursor: pointer; text-align: left; display: flex; align-items: center; gap: 16px; box-shadow: 0 1px 3px rgba(0, 0, 0, 0.05);">
							<div style="width: 48px; height: 48px; border-radius: 12px; background: linear-gradient(135deg, #f0fdf4 0%, #dcfce7 100%); display: flex; align-items: center; justify-content: center; flex-shrink: 0; border: 1px solid #bbf7d0;">
								<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="color: #16a34a;">
									<path d="M3 7v10a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-6l-2-2H5a2 2 0 0 0-2 2z"></path>
								</svg>
							</div>
							<div style="flex: 1; min-width: 0;">
								<div style="font-size: 16px; font-weight: 700; color: #0f172a; margin-bottom: 6px;">Browse Local Folder</div>
								<div style="font-size: 13px; color: #64748b; line-height: 1.5;">Import an existing flow from your computer</div>
							</div>
							<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="color: #94a3b8; flex-shrink: 0;">
								<polyline points="9 18 15 12 9 6"></polyline>
							</svg>
						</button>
						<button type="button" class="new-flow-option-card" onclick="flowModule.createBlankFlow()" style="background: #ffffff; border: 1.5px solid #e2e8f0; border-radius: 12px; padding: 22px; cursor: pointer; text-align: left; display: flex; align-items: center; gap: 16px; box-shadow: 0 1px 3px rgba(0, 0, 0, 0.05);">
							<div style="width: 48px; height: 48px; border-radius: 12px; background: linear-gradient(135deg, #fef3c7 0%, #fde68a 100%); display: flex; align-items: center; justify-content: center; flex-shrink: 0; border: 1px solid #fcd34d;">
								<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" style="color: #d97706;">
									<line x1="12" y1="5" x2="12" y2="19"></line>
									<line x1="5" y1="12" x2="19" y2="12"></line>
								</svg>
							</div>
							<div style="flex: 1; min-width: 0;">
								<div style="font-size: 16px; font-weight: 700; color: #0f172a; margin-bottom: 6px;">Create Blank Flow</div>
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
			if (e.key === 'Escape' && document.getElementById('flow-import-options-modal')) {
				closeModal()
				document.removeEventListener('keydown', escapeHandler)
			}
		})
	}

	function closeImportOptionsModal() {
		const modal = document.getElementById('flow-import-options-modal')
		if (modal) modal.remove()
	}

	async function importTemplateFlow(templateName) {
		closeFlowPickerModal()

		// Try to get local flow templates first (for development/testing)
		let localTemplates = {}
		try {
			localTemplates = await invoke('get_local_flow_templates')
			console.log('🔍 Found local flow templates:', localTemplates)
		} catch (e) {
			console.log('No local flow templates available, using GitHub URLs')
		}

		const templateUrls = {
			apol1:
				'https://github.com/OpenMined/bioscript/blob/main/examples/apol1/apol1-classifier/flow.yaml',
			brca: 'https://github.com/OpenMined/bioscript/blob/main/examples/brca/brca-classifier/flow.yaml',
			herc2:
				'https://github.com/OpenMined/bioscript/blob/main/examples/herc2/herc2-classifier/flow.yaml',
			thalassemia:
				'https://github.com/OpenMined/bioscript/blob/main/examples/thalassemia/thalassemia-classifier/flow.yaml',
		}

		// Use local path if available, otherwise use GitHub URL
		const url = localTemplates[templateName] || templateUrls[templateName]
		if (!url) {
			alert('Invalid template selected')
			return
		}

		// Show loading state
		const loadingHtml = `
			<div id="flow-loading-modal" class="modal-overlay" style="display: flex;">
				<div class="modal-content" style="width: 400px; text-align: center;">
					<div class="modal-body" style="padding: 40px 20px;">
						<div style="margin-bottom: 16px;">
							<svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="color: #10b981; animation: spin 1s linear infinite;">
								<circle cx="12" cy="12" r="10" opacity="0.25"></circle>
								<path d="M12 2a10 10 0 0 1 10 10" opacity="0.75"></path>
							</svg>
						</div>
						<h3 style="margin: 0 0 8px 0; font-size: 16px; font-weight: 600; color: #111827;">
							Importing ${templateName.toUpperCase()} Flow...
						</h3>
						<p style="margin: 0; font-size: 14px; color: #6b7280;">
							Downloading flow and all dependencies
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
			// Use overwrite=true for template flows since they're predefined
			// and user explicitly wants this specific template
			await submitFlowURL(true, url)
			const loadingModal = document.getElementById('flow-loading-modal')
			if (loadingModal) loadingModal.remove()
		} catch (error) {
			const loadingModal = document.getElementById('flow-loading-modal')
			if (loadingModal) loadingModal.remove()
			throw error
		}
	}

	function closeFlowPickerModal() {
		const modal = document.getElementById('flow-picker-modal')
		if (modal) modal.remove()
	}

	async function createBlankFlow() {
		closeFlowPickerModal()
		closeImportOptionsModal()

		const modal = document.createElement('div')
		modal.id = 'flow-name-modal'
		modal.className = 'modal new-flow-modal'
		modal.setAttribute('role', 'dialog')
		modal.setAttribute('aria-modal', 'true')
		modal.style.cssText =
			'position: fixed; top: 0; left: 0; width: 100%; height: 100%; display: flex; align-items: center; justify-content: center; z-index: 1000;'

		modal.innerHTML = `
			<div class="modal-backdrop" data-modal-close="flow-name"></div>
			<div class="new-flow-modal-panel" style="position: relative; width: 540px; max-width: 95vw; background: #ffffff; border-radius: 16px; box-shadow: 0 20px 60px rgba(0, 0, 0, 0.3), 0 0 0 1px rgba(0, 0, 0, 0.05); display: flex; flex-direction: column; overflow: hidden;">
				<div class="new-flow-modal-header" style="flex-shrink: 0; display: flex; align-items: center; justify-content: space-between; padding: 22px 32px; border-bottom: 1px solid #f1f5f9; background: #ffffff;">
					<h2 class="new-flow-modal-title" style="margin: 0; font-size: 22px; font-weight: 700; color: #0f172a; letter-spacing: -0.02em; display: flex; align-items: center; gap: 12px;">
						<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" style="color: #2563eb;">
							<line x1="12" y1="5" x2="12" y2="19"></line>
							<line x1="5" y1="12" x2="19" y2="12"></line>
						</svg>
						Create Blank Flow
					</h2>
					<button type="button" class="modal-close-btn" data-modal-close="flow-name" aria-label="Close" style="width: 36px; height: 36px; padding: 0; display: flex; align-items: center; justify-content: center; background: transparent; border: none; border-radius: 8px; cursor: pointer; color: #64748b; transition: all 0.2s cubic-bezier(0.16, 1, 0.3, 1);">
						<svg width="20" height="20" viewBox="0 0 16 16" fill="currentColor">
							<path d="M3.72 3.72a.75.75 0 0 1 1.06 0L8 6.94l3.22-3.22a.749.749 0 0 1 1.275.326.749.749 0 0 1-.215.734L9.06 8l3.22 3.22a.749.749 0 0 1-.326 1.275.749.749 0 0 1-.734-.215L8 9.06l-3.22 3.22a.751.751 0 0 1-1.042-.018.751.751 0 0 1-.018-1.042L6.94 8 3.72 4.78a.75.75 0 0 1 0-1.06Z"/>
						</svg>
					</button>
				</div>
				<div class="new-flow-modal-body" style="flex: 1; min-height: 0; padding: 28px 32px; background: #fafbfc;">
					<div style="margin-bottom: 20px;">
						<label style="display: block; margin-bottom: 10px; font-weight: 700; color: #0f172a; font-size: 14px; letter-spacing: -0.01em;">
							Flow Name
						</label>
						<input 
							type="text" 
							id="flow-name-input" 
							placeholder="my-analysis-flow"
							style="width: 100%; padding: 12px 16px; border: 1.5px solid #cbd5e1; border-radius: 8px; font-size: 14px; box-sizing: border-box; background: #ffffff; color: #0f172a; font-family: 'SF Mono', Monaco, monospace; transition: all 0.2s;"
							onfocus="this.style.borderColor='#3b82f6'; this.style.boxShadow='0 0 0 3px rgba(59,130,246,0.1)'"
							onblur="this.style.borderColor='#cbd5e1'; this.style.boxShadow='none'"
						>
						<p style="font-size: 13px; color: #64748b; margin-top: 10px; line-height: 1.5;">
							A blank flow will be created. You can add steps and configure it after creation.
						</p>
					</div>
				</div>
				<div class="new-flow-modal-footer" style="flex-shrink: 0; display: flex; align-items: center; justify-content: flex-end; gap: 10px; padding: 24px 32px; background: linear-gradient(180deg, #fafbfc 0%, #ffffff 100%); border-top: 1px solid #e5e7eb; box-shadow: 0 -1px 3px rgba(0, 0, 0, 0.02);">
					<button type="button" onclick="flowModule.closeFlowNameModal()" style="padding: 10px 20px; font-weight: 600; border-radius: 8px; background: white; border: 1.5px solid #cbd5e1; color: #475569; cursor: pointer; transition: all 0.2s;">
						Cancel
					</button>
					<button type="button" onclick="flowModule.submitFlowName()" style="padding: 10px 24px; background: linear-gradient(135deg, #2563eb 0%, #1d4ed8 100%); font-weight: 700; box-shadow: 0 2px 8px rgba(37,99,235,0.3); border-radius: 8px; color: white; border: none; cursor: pointer; display: flex; align-items: center; gap: 8px; transition: all 0.2s;">
						<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
							<line x1="12" y1="5" x2="12" y2="19"></line>
							<line x1="5" y1="12" x2="19" y2="12"></line>
						</svg>
						Create Flow
					</button>
				</div>
			</div>
		`

		document.body.appendChild(modal)

		// Handle backdrop click and escape key
		const backdrop = modal.querySelector('.modal-backdrop')
		const closeBtn = modal.querySelector('.modal-close-btn')
		const closeModal = () => closeFlowNameModal()

		if (backdrop) {
			backdrop.addEventListener('click', closeModal)
		}
		if (closeBtn) {
			closeBtn.addEventListener('click', closeModal)
		}

		document.addEventListener('keydown', function escapeHandler(e) {
			if (e.key === 'Escape' && document.getElementById('flow-name-modal')) {
				closeModal()
				document.removeEventListener('keydown', escapeHandler)
			}
		})

		// Focus on input
		setTimeout(() => {
			const input = document.getElementById('flow-name-input')
			if (input) {
				input.focus()
				input.addEventListener('keypress', (e) => {
					if (e.key === 'Enter') {
						flowModule.submitFlowName()
					}
				})
			}
		}, 100)
	}

	function closeFlowNameModal() {
		const modal = document.getElementById('flow-name-modal')
		if (modal) modal.remove()
	}

	async function submitFlowName() {
		const input = document.getElementById('flow-name-input')
		if (!input) return

		const name = input.value.trim()
		if (!name) {
			alert('Please enter a flow name')
			return
		}

		try {
			closeFlowNameModal()

			// Create flow spec
			const spec = {
				name: name,
				inputs: {},
				steps: [],
			}

			// Invoke the create flow command
			const result = await invoke('create_flow', {
				request: {
					name: name,
					directory: null,
				},
			})

			// Save the flow spec
			await invoke('save_flow_editor', {
				flowId: result.id,
				flowPath: result.flow_path,
				spec: spec,
			})

			await loadFlows()
		} catch (error) {
			console.error('Error creating flow:', error)
			const errorMsg = error?.message || error?.toString() || String(error) || 'Unknown error'
			alert('Failed to create flow: ' + errorMsg)
		}
	}

	async function importFlowFromURL() {
		closeFlowPickerModal()
		closeImportOptionsModal()

		const modal = document.createElement('div')
		modal.id = 'url-input-modal'
		modal.className = 'modal new-flow-modal'
		modal.setAttribute('role', 'dialog')
		modal.setAttribute('aria-modal', 'true')
		modal.style.cssText =
			'position: fixed; top: 0; left: 0; width: 100%; height: 100%; display: flex; align-items: center; justify-content: center; z-index: 1000;'

		modal.innerHTML = `
			<div class="modal-backdrop" data-modal-close="url-input"></div>
			<div class="new-flow-modal-panel" style="position: relative; width: 640px; max-width: 95vw; background: #ffffff; border-radius: 16px; box-shadow: 0 20px 60px rgba(0, 0, 0, 0.3), 0 0 0 1px rgba(0, 0, 0, 0.05); display: flex; flex-direction: column; overflow: hidden;">
				<div class="new-flow-modal-header" style="flex-shrink: 0; display: flex; align-items: center; justify-content: space-between; padding: 22px 32px; border-bottom: 1px solid #f1f5f9; background: #ffffff;">
					<h2 class="new-flow-modal-title" style="margin: 0; font-size: 22px; font-weight: 700; color: #0f172a; letter-spacing: -0.02em; display: flex; align-items: center; gap: 12px;">
						<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" style="color: #2563eb;">
							<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"></path>
							<path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"></path>
						</svg>
						Import Flow from GitHub
					</h2>
					<button type="button" class="modal-close-btn" data-modal-close="url-input" aria-label="Close" style="width: 36px; height: 36px; padding: 0; display: flex; align-items: center; justify-content: center; background: transparent; border: none; border-radius: 8px; cursor: pointer; color: #64748b; transition: all 0.2s cubic-bezier(0.16, 1, 0.3, 1);">
						<svg width="20" height="20" viewBox="0 0 16 16" fill="currentColor">
							<path d="M3.72 3.72a.75.75 0 0 1 1.06 0L8 6.94l3.22-3.22a.749.749 0 0 1 1.275.326.749.749 0 0 1-.215.734L9.06 8l3.22 3.22a.749.749 0 0 1-.326 1.275.749.749 0 0 1-.734-.215L8 9.06l-3.22 3.22a.751.751 0 0 1-1.042-.018.751.751 0 0 1-.018-1.042L6.94 8 3.72 4.78a.75.75 0 0 1 0-1.06Z"/>
						</svg>
					</button>
				</div>
				<div class="new-flow-modal-body" style="flex: 1; min-height: 0; padding: 28px 32px; background: #fafbfc;">
					<div style="margin-bottom: 20px;">
						<label style="display: block; margin-bottom: 10px; font-weight: 700; color: #0f172a; font-size: 14px; letter-spacing: -0.01em;">
							GitHub URL to flow.yaml
						</label>
						<div style="display: flex; gap: 10px; align-items: center;">
							<input 
								type="text" 
								id="flow-url-input" 
								placeholder="https://github.com/OpenMined/biovault/blob/main/cli/examples/flow/flow.yaml"
								style="flex: 1; padding: 12px 16px; border: 1.5px solid #cbd5e1; border-radius: 8px; font-size: 13px; box-sizing: border-box; font-family: 'SF Mono', Monaco, monospace; background: #ffffff; color: #0f172a; transition: all 0.2s;"
								onfocus="this.style.borderColor='#3b82f6'; this.style.boxShadow='0 0 0 3px rgba(59,130,246,0.1)'"
								onblur="this.style.borderColor='#cbd5e1'; this.style.boxShadow='none'"
							>
							<button 
								type="button"
								onclick="document.getElementById('flow-url-input').value = 'https://github.com/OpenMined/biovault/blob/main/cli/examples/flow/flow.yaml'"
								style="padding: 12px 18px; background: white; border: 1.5px solid #cbd5e1; border-radius: 8px; font-size: 13px; font-weight: 600; color: #475569; cursor: pointer; white-space: nowrap; transition: all 0.2s;"
								onmouseover="this.style.background='#f8fafc'; this.style.borderColor='#94a3b8'"
								onmouseout="this.style.background='white'; this.style.borderColor='#cbd5e1'"
								title="Fill with example flow URL"
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
										Use GitHub raw URLs (<code style="background: rgba(30,58,138,0.1); padding: 2px 6px; border-radius: 4px; font-family: 'SF Mono', Monaco, monospace;">raw.githubusercontent.com</code>) to import flows. This will automatically download the flow and all referenced steps.
									</div>
								</div>
							</div>
						</div>
					</div>
				</div>
				<div class="new-flow-modal-footer" style="flex-shrink: 0; display: flex; align-items: center; justify-content: flex-end; gap: 10px; padding: 24px 32px; background: linear-gradient(180deg, #fafbfc 0%, #ffffff 100%); border-top: 1px solid #e5e7eb; box-shadow: 0 -1px 3px rgba(0, 0, 0, 0.02);">
					<button type="button" onclick="flowModule.closeURLInputModal()" style="padding: 10px 20px; font-weight: 600; border-radius: 8px; background: white; border: 1.5px solid #cbd5e1; color: #475569; cursor: pointer; transition: all 0.2s;">
						Cancel
					</button>
					<button type="button" onclick="flowModule.submitFlowURL()" style="padding: 10px 24px; background: linear-gradient(135deg, #2563eb 0%, #1d4ed8 100%); font-weight: 700; box-shadow: 0 2px 8px rgba(37,99,235,0.3); border-radius: 8px; color: white; border: none; cursor: pointer; display: flex; align-items: center; gap: 8px; transition: all 0.2s;">
						<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
							<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>
							<polyline points="17 8 12 3 7 8"></polyline>
							<line x1="12" y1="3" x2="12" y2="15"></line>
						</svg>
						Import Flow
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
			const input = document.getElementById('flow-url-input')
			if (input) {
				input.focus()
				input.addEventListener('keypress', (e) => {
					if (e.key === 'Enter') {
						flowModule.submitFlowURL()
					}
				})
			}
		}, 100)
	}

	function closeURLInputModal() {
		const modal = document.getElementById('url-input-modal')
		if (modal) modal.remove()
	}

	async function submitFlowURL(overwrite = false, urlOverride = null) {
		const input = document.getElementById('flow-url-input')

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

			// Call CLI function that imports flow AND all its step dependencies!
			await invoke('import_flow_with_deps', {
				url: url,
				nameOverride: null,
				overwrite: overwrite,
			})

			await loadFlows()

			console.log('✅ Imported flow with all dependencies from URL:', url)
			alert('Flow and all its steps imported successfully!')
		} catch (error) {
			console.error('Error importing flow from URL:', error)
			const errorMsg = error?.message || error?.toString() || String(error) || 'Unknown error'

			// Only prompt for overwrite if we haven't already tried with overwrite=true
			// and the error is specifically about the flow (not steps)
			const isFlowExists =
				errorMsg.includes('already exists') &&
				(errorMsg.toLowerCase().includes('flow') ||
					(!errorMsg.toLowerCase().includes('step') && !overwrite))

			if (isFlowExists && !overwrite) {
				const shouldOverwrite = await confirmWithDialog(
					`${errorMsg}\n\nDo you want to overwrite it?`,
					{ title: 'Overwrite Flow?', type: 'warning' },
				)
				if (shouldOverwrite) {
					await submitFlowURL(true, url)
					return
				}
			} else {
				let userMessage = 'Failed to import flow:\n\n' + errorMsg

				if (errorMsg.includes('not found') || errorMsg.includes('404')) {
					userMessage += '\n\n💡 Tip: Make sure the URL points to a valid flow.yaml file.'
				}

				if (url.includes('github.com')) {
					userMessage +=
						'\n\n📝 For GitHub URLs, use the raw content URL:\nhttps://raw.githubusercontent.com/...'
				}

				alert(userMessage)
			}
		}
	}

	async function importExistingFlow(overwrite = false, selectedPath = null) {
		closeFlowPickerModal()
		closeImportOptionsModal()

		let selected = selectedPath
		try {
			if (!selected) {
				selected = await dialog.open({
					multiple: false,
					directory: false,
					filters: [
						{ name: 'Flow or Module YAML', extensions: ['yaml', 'yml'] },
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
			const isFlowFile = lowerName === 'flow.yaml' || lowerName === 'flow.yml'
			const isModuleFile = lowerName === 'module.yaml' || lowerName === 'module.yml'
			const isYamlFile = lowerName.endsWith('.yaml') || lowerName.endsWith('.yml')

			let flowDir = selected
			let flowFile = null
			let inferredName = lastParentName || fileName || 'imported-flow'

			if (isYamlFile) {
				if (parentNormalized) {
					flowDir = parentPath
				}

				if (isFlowFile) {
					flowFile = selected
					// Prefer folder name if present, otherwise strip extension
					inferredName = lastParentName || fileName.replace(/\.[^.]+$/, '') || 'imported-flow'
				} else if (isModuleFile) {
					inferredName = lastParentName || fileName.replace(/\.[^.]+$/, '') || 'imported-flow'
				} else {
					// Other YAML file – treat basename as flow name
					inferredName = fileName.replace(/\.[^.]+$/, '') || 'imported-flow'
				}
			} else if (!fileName) {
				// If the selection ended with a slash, derive name from the last non-empty segment
				inferredName = lastParentName || 'imported-flow'
			}

			if (!flowDir) {
				flowDir = selected
			}

			const request = {
				name: inferredName || 'imported-flow',
				directory: flowDir,
				overwrite: overwrite,
			}

			if (flowFile) {
				request.flow_file = flowFile
			}

			await invoke('create_flow', { request })

			closeFlowPickerModal()
			await loadFlows()

			console.log('✅ Imported flow:', request.name)
		} catch (error) {
			console.error('Error importing flow:', error)
			const errorMsg = error?.message || error?.toString() || String(error) || 'Unknown error'

			// Only prompt for overwrite if we haven't already tried with overwrite=true
			// and the error is specifically about the flow (not steps)
			const isFlowExists =
				errorMsg.includes('already exists') &&
				(errorMsg.toLowerCase().includes('flow') ||
					(!errorMsg.toLowerCase().includes('step') && !overwrite))

			if (isFlowExists && !overwrite) {
				const shouldOverwrite = await confirmWithDialog(
					`${errorMsg}\n\nDo you want to overwrite it?`,
					{ title: 'Overwrite Flow?', type: 'warning' },
				)
				if (shouldOverwrite) {
					await importExistingFlow(true, selected)
					return
				}
			} else {
				alert('Failed to import flow: ' + errorMsg)
			}
		}
	}

	// Wizard navigation
	function wizardNext() {
		if (flowState.wizardStep < 3) {
			// Validate current step
			if (flowState.wizardStep === 0) {
				const name = document.getElementById('flow-name').value.trim()
				if (!name) {
					alert('Please enter a flow name')
					return
				}
				flowState.wizardData.name = name
			}

			flowState.wizardStep++
			updateWizardView()
		}
	}

	function wizardBack() {
		if (flowState.wizardStep > 0) {
			flowState.wizardStep--
			updateWizardView()
		}
	}

	function updateWizardView() {
		// Hide all steps
		document.querySelectorAll('.wizard-step').forEach((step) => {
			step.style.display = 'none'
		})

		// Show current step
		document.getElementById(`step-${flowState.wizardStep}`).style.display = 'block'

		// Update buttons
		const backBtn = document.getElementById('wizard-back')
		const nextBtn = document.getElementById('wizard-next')
		const createBtn = document.getElementById('wizard-create')

		backBtn.disabled = flowState.wizardStep === 0

		if (flowState.wizardStep === 3) {
			nextBtn.style.display = 'none'
			createBtn.style.display = 'inline-block'
			updateFlowPreview()
		} else {
			nextBtn.style.display = 'inline-block'
			createBtn.style.display = 'none'
		}
	}

	// Add flow input
	function addFlowInput() {
		// Suggest common inputs based on steps
		const suggestedInputs = []
		flowState.wizardData.steps.forEach((step) => {
			Object.keys(step.with).forEach((inputKey) => {
				const value = step.with[inputKey]
				if (value.startsWith('inputs.')) {
					const inputName = value.replace('inputs.', '')
					if (!flowState.wizardData.inputs[inputName] && !suggestedInputs.includes(inputName)) {
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

		flowState.wizardData.inputs[inputName] = inputType
		updateFlowInputsList()
	}

	function updateFlowInputsList() {
		const container = document.getElementById('flow-inputs-list')
		container.innerHTML = ''

		Object.entries(flowState.wizardData.inputs).forEach(([name, type]) => {
			const div = document.createElement('div')
			div.style.cssText =
				'padding: 10px; background: #f5f5f5; margin-bottom: 10px; border-radius: 4px;'
			div.innerHTML = `
				<strong>${name}</strong>: ${type}
				<button class="delete-btn" style="float: right; padding: 2px 8px;"
					onclick="flowModule.removeFlowInput('${name}')">
					Remove
				</button>
			`
			container.appendChild(div)
		})
	}

	function removeFlowInput(name) {
		delete flowState.wizardData.inputs[name]
		updateFlowInputsList()
	}

	// Add flow step
	async function addFlowStep() {
		try {
			// Get available modules from database
			const modules = await invoke('get_modules')

			// Create a modal for step configuration
			const modalHtml = `
				<div id="add-step-modal" class="modal-overlay" style="display: flex;">
					<div class="modal-content" style="width: 600px;">
						<div class="modal-header">
							<h2>Add Flow Step</h2>
							<button class="modal-close" onclick="flowModule.closeAddStepModal()">×</button>
						</div>
						<div class="modal-body">
							<label style="display: block; margin-bottom: 15px;">
								<span style="display: block; margin-bottom: 5px;">Step ID *</span>
								<input type="text" id="step-id-input" placeholder="e.g., filter, count, analyze" style="width: 100%;">
							</label>

							<label style="display: block; margin-bottom: 15px;">
								<span style="display: block; margin-bottom: 5px;">Select Module *</span>
								<select id="module-select" style="width: 100%; margin-bottom: 10px;">
									<option value="">-- Select from registered modules --</option>
									${modules
										.map(
											(p) =>
												`<option value="${p.module_path}">${p.name} (${p.module_path})</option>`,
										)
										.join('')}
									<option value="browse">-- Browse for module folder/yaml --</option>
								</select>
							</label>

							<div style="display: flex; align-items: center; gap: 10px; margin-bottom: 15px;">
								<span style="color: #666;">OR</span>
								<button class="secondary-btn" onclick="flowModule.browseForModule()">
									Browse for Module...
								</button>
							</div>

							<div id="selected-module-path" style="padding: 10px; background: #f5f5f5; border-radius: 4px; margin-bottom: 15px; display: none;">
								<strong>Selected:</strong> <span id="module-path-display"></span>
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
											<input type="text" id="store-table" placeholder="e.g., flow_counts_{run_id}" style="width: 100%;">
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
							<button class="secondary-btn" onclick="flowModule.closeAddStepModal()">
								Cancel
							</button>
							<button class="primary-btn" onclick="flowModule.confirmAddStep()">
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

			// Handle module selection change
			document.getElementById('module-select').addEventListener('change', async (e) => {
				if (e.target.value === 'browse') {
					await browseForModule()
				} else if (e.target.value) {
					showSelectedModule(e.target.value)
					// Auto-populate step ID from module name if empty
					const stepIdInput = document.getElementById('step-id-input')
					if (!stepIdInput.value) {
						const moduleName = e.target.options[e.target.selectedIndex].text.split(' ')[0]
						stepIdInput.value = moduleName.toLowerCase().replace(/[^a-z0-9]/g, '-')
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

			// Store selected module path in state for later use
			flowState.tempStepModule = null
			flowState.tempStepBindings = {}
		} catch (error) {
			console.error('Error adding step:', error)
			alert('Error loading modules: ' + error)
		}
	}

	// Browse for module folder or yaml file
	async function browseForModule() {
		try {
			const selected = await dialog.open({
				multiple: false,
				directory: false,
				filters: [
					{ name: 'Module Files', extensions: ['yaml', 'yml'] },
					{ name: 'All Files', extensions: ['*'] },
				],
			})

			if (selected) {
				// If user selected a module.yaml file, use the parent directory
				let modulePath = selected
				if (selected.endsWith('.yaml') || selected.endsWith('.yml')) {
					// Get parent directory
					modulePath = selected.substring(0, selected.lastIndexOf('/'))
				}

				showSelectedModule(modulePath)
				document.getElementById('module-select').value = ''

				// Auto-populate step ID from folder name if empty
				const stepIdInput = document.getElementById('step-id-input')
				if (!stepIdInput.value) {
					// Get the last folder name from the path
					const folderName = modulePath.split('/').pop() || modulePath.split('\\').pop()
					stepIdInput.value = folderName.toLowerCase().replace(/[^a-z0-9]/g, '-')
				}
			}
		} catch (error) {
			console.error('Error browsing for module:', error)
		}
	}

	// Show selected module and load bindings
	function showSelectedModule(modulePath) {
		flowState.tempStepModule = modulePath

		// Show selected path
		const display = document.getElementById('selected-module-path')
		const pathDisplay = document.getElementById('module-path-display')
		display.style.display = 'block'
		pathDisplay.textContent = modulePath

		// Show bindings section
		const bindingsSection = document.getElementById('step-bindings')
		bindingsSection.style.display = 'block'

		// Create binding inputs for common module inputs
		const bindingsList = document.getElementById('step-bindings-list')
		bindingsList.innerHTML = ''

		const commonInputs = ['samplesheet', 'data_dir']
		const isFirstStep = flowState.wizardData.steps.length === 0

		commonInputs.forEach((inputName) => {
			let defaultBinding = ''

			if (isFirstStep) {
				// First step usually binds to flow inputs
				defaultBinding = `inputs.${inputName}`
			} else {
				// Later steps might bind to previous step outputs
				const prevStep = flowState.wizardData.steps[flowState.wizardData.steps.length - 1]
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
		flowState.tempStepModule = null
		flowState.tempStepBindings = {}
	}

	// Confirm and add the step
	function confirmAddStep() {
		const stepId = document.getElementById('step-id-input')?.value?.trim()

		if (!stepId) {
			alert('Please enter a Step ID')
			return
		}

		if (!flowState.tempStepModule) {
			alert('Please select a module')
			return
		}

		const step = {
			id: stepId,
			uses: flowState.tempStepModule,
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

		flowState.wizardData.steps.push(step)
		updateFlowStepsList()
		closeAddStepModal()
	}

	function updateFlowStepsList() {
		const container = document.getElementById('flow-steps-list')
		container.innerHTML = ''

		flowState.wizardData.steps.forEach((step, index) => {
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
						onclick="flowModule.moveStepUp(${index})">↑</button>
					<button class="secondary-btn" style="padding: 2px 8px;"
						onclick="flowModule.moveStepDown(${index})">↓</button>
					<button class="delete-btn" style="float: right; padding: 2px 8px;"
						onclick="flowModule.removeStep(${index})">Remove</button>
				</div>
			`
			container.appendChild(div)
		})
	}

	function removeStep(index) {
		flowState.wizardData.steps.splice(index, 1)
		updateFlowStepsList()
	}

	function moveStepUp(index) {
		if (index > 0) {
			const temp = flowState.wizardData.steps[index]
			flowState.wizardData.steps[index] = flowState.wizardData.steps[index - 1]
			flowState.wizardData.steps[index - 1] = temp
			updateFlowStepsList()
		}
	}

	function moveStepDown(index) {
		if (index < flowState.wizardData.steps.length - 1) {
			const temp = flowState.wizardData.steps[index]
			flowState.wizardData.steps[index] = flowState.wizardData.steps[index + 1]
			flowState.wizardData.steps[index + 1] = temp
			updateFlowStepsList()
		}
	}

	// Update preview
	function updateFlowPreview() {
		const preview = document.getElementById('flow-preview')

		// Generate YAML-like preview
		let yaml = `name: ${flowState.wizardData.name}\n`

		if (Object.keys(flowState.wizardData.inputs).length > 0) {
			yaml += 'inputs:\n'
			Object.entries(flowState.wizardData.inputs).forEach(([name, type]) => {
				yaml += `  ${name}: ${type}\n`
			})
		}

		if (flowState.wizardData.steps.length > 0) {
			yaml += '\nsteps:\n'
			flowState.wizardData.steps.forEach((step) => {
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

	// Create flow
	async function createFlow() {
		try {
			const result = await invoke('create_flow', {
				request: {
					name: flowState.wizardData.name,
					directory: null,
				},
			})

			// Save the flow spec
			const spec = {
				name: flowState.wizardData.name,
				inputs: flowState.wizardData.inputs,
				steps: flowState.wizardData.steps,
			}

			await invoke('save_flow_editor', {
				flowId: result.id,
				flowPath: result.flow_path,
				spec: spec,
			})

			closeWizard()
			await loadFlows()
			alert('Flow created successfully!')
		} catch (error) {
			alert('Error creating flow: ' + error)
		}
	}

	// Close wizard
	function closeWizard() {
		const modal = document.getElementById('flow-wizard-modal')
		if (modal) {
			modal.parentElement.remove()
		}
	}

	// Show flow detail view
	async function showFlowDetails(flowId) {
		try {
			const flow = flowState.flows.find((p) => p.id === flowId)
			if (!flow) {
				console.error('Flow not found:', flowId)
				return
			}

			flowState.currentFlow = flow

			// Hide main view, show detail view
			const mainView = document.getElementById('flows-main-view')
			const detailView = document.getElementById('flow-detail-view')

			if (mainView) mainView.style.display = 'none'
			if (detailView) detailView.style.display = 'flex'

			renderDataRunBanner()

			// Update header
			const nameEl = document.getElementById('flow-detail-name')
			if (nameEl) {
				nameEl.textContent = flow.name
			}

			const collabBtn = document.getElementById('flow-detail-collab')
			if (collabBtn) {
				collabBtn.style.display = isMultiPartyFlow(flow) ? '' : 'none'
			}

			// Update metadata badges
			const stepsCount = flow.spec?.steps?.length || 0
			const inputsCount = Object.keys(flow.spec?.inputs || {}).length

			const stepsCountEl = document.getElementById('flow-steps-count')
			if (stepsCountEl) {
				stepsCountEl.textContent = `${stepsCount} step${stepsCount === 1 ? '' : 's'}`
			}

			const inputsCountEl = document.getElementById('flow-inputs-count')
			if (inputsCountEl) {
				inputsCountEl.textContent = `${inputsCount} input${inputsCount === 1 ? '' : 's'}`
			}

			// Load and display steps
			await loadFlowSteps(flowId)

			// Populate left panel (information and parameters)
			await renderFlowMetadata()
			await renderParameterOverrides()
		} catch (error) {
			console.error('Error showing flow details:', error)
		}
	}

	// Render flow metadata in the left sidebar
	function renderFlowMetadata() {
		const metadataContainer = document.getElementById('flow-metadata')
		if (!metadataContainer || !flowState.currentFlow) return

		const flow = flowState.currentFlow
		const stepsCount = flow.spec?.steps?.length || 0
		const inputsCount = Object.keys(flow.spec?.inputs || {}).length

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
		if (!paramsList || !flowState.currentFlow) return

		const flowSpec = flowState.currentFlow.spec
		const stepParameters = []

		if (flowSpec && flowSpec.steps) {
			for (const step of flowSpec.steps) {
				try {
					const moduleSpec = await invoke('load_module_editor', {
						modulePath: step.uses,
					})
					const params = moduleSpec.metadata?.parameters || []
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
	function showFlowInputModal(existingName = null) {
		const isEdit = existingName !== null
		const existingInput = isEdit ? flowState.currentFlow.spec?.inputs?.[existingName] : null
		const inputType =
			typeof existingInput === 'string' ? existingInput : existingInput?.type || 'File'
		const inputDefault =
			typeof existingInput === 'object' && existingInput?.default ? existingInput.default : ''

		const modalHtml = `
			<div id="flow-input-modal" class="modal-overlay" style="display: flex;">
				<div class="modal-content" style="width: 500px;">
					<div class="modal-header">
						<h2>${isEdit ? 'Edit' : 'Add'} Flow Input</h2>
						<button class="modal-close" onclick="flowModule.closeFlowInputModal()">×</button>
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
						<button class="secondary-btn" onclick="flowModule.closeFlowInputModal()">Cancel</button>
						<button class="primary-btn" onclick="flowModule.saveFlowInput(${isEdit}, '${
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

	function closeFlowInputModal() {
		const modal = document.getElementById('flow-input-modal')
		if (modal) modal.remove()
	}

	async function saveFlowInput(isEdit, oldName) {
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
			// Load current flow
			const editorData = await invoke('load_flow_editor', {
				flowId: flowState.currentFlow.id,
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
			await invoke('save_flow_editor', {
				flowId: flowState.currentFlow.id,
				flowPath: flowState.currentFlow.flow_path,
				spec: editorData.spec,
			})

			// Refresh
			await loadFlows()
			const updated = flowState.flows.find((p) => p.id === flowState.currentFlow.id)
			if (updated) {
				flowState.currentFlow = updated
			}
			await loadFlowSteps(flowState.currentFlow.id)

			closeFlowInputModal()
			console.log('✅ Saved flow input:', name)
		} catch (error) {
			console.error('Error saving input:', error)
			alert('Failed to save input: ' + error)
		}
	}

	function editFlowInput(inputName) {
		showFlowInputModal(inputName)
	}

	// Show flow YAML viewer/editor
	async function showFlowYAMLModal() {
		if (!flowState.currentFlow) return

		try {
			// Get the current YAML
			const spec = flowState.currentFlow.spec
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

			const yamlPath = flowState.currentFlow.flow_path + '/flow.yaml'

			const modalHtml = `
				<div id="yaml-viewer-modal" class="modal-overlay" style="display: flex;">
					<div class="modal-content" style="width: 800px; max-height: 85vh;">
						<div class="modal-header">
							<h2>Flow YAML</h2>
							<button class="modal-close" onclick="flowModule.closeYAMLViewerModal()">×</button>
						</div>
						<div class="modal-body" style="max-height: 65vh; overflow-y: auto;">
							<div style="display: flex; justify-content: flex-end; margin-bottom: 12px;">
								<button class="secondary-btn" onclick="flowModule.openYAMLInVSCode('${yamlPath}')">
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
							<button class="secondary-btn" onclick="flowModule.closeYAMLViewerModal()">Close</button>
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

	async function openFlowYAMLInVSCode() {
		if (!flowState.currentFlow) return

		try {
			const yamlPath = flowState.currentFlow.flow_path + '/flow.yaml'
			await invoke('open_in_vscode', { path: yamlPath })
		} catch (error) {
			console.error('Error opening flow YAML in VSCode:', error)
			alert('Failed to open in VSCode: ' + error.toString())
		}
	}

	async function loadFlowSteps(flowId) {
		try {
			const flow = flowState.flows.find((p) => p.id === flowId)
			if (!flow) return

			const stepsContainer = document.getElementById('flow-steps-list')
			if (!stepsContainer) return

			const steps = flow.spec?.steps || []

			if (steps.length === 0) {
				stepsContainer.innerHTML = `
				<div style="text-align: center; padding: 40px; color: #9ca3af;">
					<p>No steps in this flow yet.</p>
					<p style="font-size: 13px; margin-top: 8px;">Click "+ Add Step" above to add your first step.</p>
				</div>
			`
				return
			}

			stepsContainer.innerHTML = ''

			steps.forEach((step, index) => {
				const stepDiv = document.createElement('div')
				stepDiv.className = 'flow-step-item'

				const stepName = step.id || `step-${index + 1}`
				const stepUses = step.uses || 'Unknown step'

				// Parse module name and version from uses field (supports name@version syntax)
				let moduleName = stepUses
				let moduleVersion = null
				if (stepUses.includes('@')) {
					const parts = stepUses.split('@')
					moduleName = parts[0]
					moduleVersion = parts[1]
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
			<div class="flow-step-header">
				<div class="flow-step-number">${index + 1}</div>
				<div class="flow-step-info">
					<h4>${stepName}</h4>
					<p>Uses: ${moduleName}${
						moduleVersion ? `<span class="version-tag">v${moduleVersion}</span>` : ''
					}</p>
					<div class="step-status-badges">${statusBadges.join('')}</div>
				</div>
					<button class="flow-step-menu-btn" data-step-index="${index}">
						<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
							<circle cx="12" cy="5" r="2"/>
							<circle cx="12" cy="12" r="2"/>
							<circle cx="12" cy="19" r="2"/>
						</svg>
					</button>
				</div>
				<div class="flow-step-config" id="step-config-${index}" style="display: none;">
					<!-- Configuration will be loaded here when expanded -->
				</div>
			`

				stepsContainer.appendChild(stepDiv)

				// Add menu button click handler
				const menuBtn = stepDiv.querySelector('.flow-step-menu-btn')
				menuBtn?.addEventListener('click', (e) => {
					e.stopPropagation()
					showStepMenu(e, index, step)
				})

				// Add header click handler to toggle accordion
				const header = stepDiv.querySelector('.flow-step-header')
				header?.addEventListener('click', (e) => {
					// Don't toggle if clicking the menu button
					if (e.target.closest('.flow-step-menu-btn')) return
					toggleStepConfig(index)
				})
			})
		} catch (error) {
			console.error('Error loading flow steps:', error)
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
						removeFlowStep(stepIndex)
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
		document.querySelectorAll('.flow-step-config').forEach((div, idx) => {
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
		if (!flowState.currentFlow || !flowState.currentFlow.spec) return

		const step = flowState.currentFlow.spec.steps[stepIndex]
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
			// Load the module spec
			const moduleSpec = await invoke('load_module_editor', {
				modulePath: step.uses,
			})

			// Get inputs and parameters
			const moduleInputs = moduleSpec.metadata?.inputs || []
			const moduleParams = moduleSpec.metadata?.parameters || []

			// Build bindings status
			const bindingsHtml =
				moduleInputs.length > 0
					? moduleInputs
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
				moduleParams.length > 0
					? `
					<details class="inline-params-section">
						<summary class="inline-section-summary">
							<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
								<circle cx="12" cy="12" r="3" />
								<path d="M12 1v6m0 6v6m6.36-15.36-4.24 4.24m-4.24 4.24-4.24 4.24m15.36 0-4.24-4.24m-4.24-4.24-4.24-4.24" />
							</svg>
							<span>Parameters (${moduleParams.length})</span>
						</summary>
						<div class="inline-params-list">
							${moduleParams
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
			// Load the module spec to get the path
			const moduleSpec = await invoke('load_module_editor', {
				modulePath: step.uses,
			})

			const modulePath = moduleSpec.module_path
			if (!modulePath) {
				throw new Error('Module path not available')
			}

			console.log('🚀 Launching Jupyter for step at:', modulePath)

			await invoke('launch_jupyter', {
				modulePath: modulePath,
			})
		} catch (error) {
			console.error('Error launching Jupyter:', error)
			alert('Failed to launch Jupyter: ' + error.toString())
		}
	}

	// Helper function to open step in VSCode from menu
	async function openStepInVSCode(step) {
		try {
			// Load the module spec to get the path
			const moduleSpec = await invoke('load_module_editor', {
				modulePath: step.uses,
			})

			const modulePath = moduleSpec.module_path
			if (!modulePath) {
				throw new Error('Module path not available')
			}

			console.log('🚀 Opening VSCode for step at:', modulePath)

			await _open(modulePath)
		} catch (error) {
			console.error('Error opening VSCode:', error)
			alert('Failed to open VSCode: ' + error.toString())
		}
	}

	// Validate flow configuration
	async function validateFlowConfig(spec) {
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

			// Try to load module spec to validate bindings
			try {
				const moduleSpec = await invoke('load_module_editor', {
					modulePath: step.uses,
				})

				const requiredInputs =
					moduleSpec.metadata?.inputs?.filter((i) => !i.type?.endsWith('?')) || []
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
					const inputExists = moduleSpec.metadata?.inputs?.find((i) => i.name === bindingName)
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
				stepValidation.issues.push(`Cannot load module: ${step.uses}`)
				validation.issues.push(`Step "${stepValidation.stepId}": Cannot load module`)
				validation.isValid = false
			}

			validation.steps.push(stepValidation)
		}

		return validation
	}

	// Show validation modal
	async function showValidationModal(flowName, validation) {
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
						<h2>Flow Validation</h2>
						<button class="modal-close" onclick="flowModule.closeValidationModal()">×</button>
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
						<button class="secondary-btn" onclick="flowModule.closeValidationModal()">Cancel</button>
						<button class="primary-btn" onclick="flowModule.confirmValidationAndRun()" ${
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
			window.flowModule.confirmValidationAndRun = () => {
				closeValidationModal()
				resolve(true)
			}
			window.flowModule.closeValidationModal = () => {
				closeValidationModal()
				resolve(false)
			}
		})
	}

	function closeValidationModal() {
		const modal = document.getElementById('validation-modal')
		if (modal) modal.remove()
	}

	// Go back to flows list
	function backToFlowsList() {
		document.getElementById('flow-detail-view').style.display = 'none'
		document.getElementById('flows-main-view').style.display = 'block'
		flowState.currentFlow = null
		renderDataRunBanner()
	}

	// Run flow with validation - reads config from sidebar
	async function runFlow(flowId) {
		const context = getPendingDataRunContext()
		const flow = flowState.flows.find((p) => p.id === flowId)
		const hasData = hasPendingData(context)
		const selectionShape = context?.datasetShape || 'List[GenotypeRecord]'

		if (hasData && flow && flowAcceptsShape(flow, selectionShape)) {
			await startDataDrivenRun(flowId)
			return
		}

		try {
			if (!flow) return

			// Load flow to get inputs
			const editorData = await invoke('load_flow_editor', {
				flowId: flowId,
			})

			// Validate flow configuration
			const validation = await validateFlowConfig(editorData.spec)

			// Show validation results
			const proceed = await showValidationModal(flow.name, validation)
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
					`Cannot run flow. Missing required inputs:\n\n${missingInputs
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

			console.log('🚀 Running flow with overrides:', allOverrides)

			// Run the flow
			const run = await invoke('run_flow', {
				flowId: flowId,
				inputOverrides: allOverrides,
				resultsDir: null,
			})

			// Store run ID in sessionStorage for auto-expansion on runs page
			if (typeof sessionStorage !== 'undefined') {
				sessionStorage.setItem('autoExpandRunId', run.id.toString())
			}

			alert(`Flow started! Run ID: ${run.id}`)

			// Navigate to results tab if available
			if (navigateTo) {
				navigateTo('runs')
			}
		} catch (error) {
			alert('Error running flow: ' + error)
		}
	}

	// Show flow input dialog with file/folder pickers and parameter overrides
	async function _showFlowInputDialog(flowName, requiredInputs, flowId, flowSpec) {
		// Load saved configurations from CLI database
		let savedConfigs = []
		try {
			savedConfigs = await invoke('list_run_configs', { flowId })
		} catch (error) {
			console.error('Failed to load saved configs:', error)
		}

		// Collect all parameters from all steps for override
		const stepParameters = []
		if (flowSpec && flowSpec.steps) {
			for (const step of flowSpec.steps) {
				try {
					const moduleSpec = await invoke('load_module_editor', {
						modulePath: step.uses,
					})
					const params = moduleSpec.metadata?.parameters || []
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
					<div id="flow-parameter-fields"></div>
				</div>`
				: ''

		// Create modal HTML
		const modalHtml = `
			<div id="flow-run-modal" class="modal-overlay" style="display: flex;">
				<div class="modal-content" style="width: 600px; max-height: 85vh;">
					<div class="modal-header">
						<h2>Run Flow: ${flowName}</h2>
						<button class="modal-close" onclick="flowModule.closeFlowRunDialog()">×</button>
					</div>
					<div class="modal-body" style="max-height: 65vh; overflow-y: auto;">
						${configSelectHtml}
						<h3>Configure Inputs</h3>
						<div id="flow-input-fields"></div>
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
						<button class="secondary-btn" onclick="flowModule.closeFlowRunDialog()">
							Cancel
						</button>
						<button class="primary-btn" onclick="flowModule.confirmFlowRun()">
							Run Flow
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
		const container = document.getElementById('flow-input-fields')
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
						<button class="secondary-btn" onclick="flowModule.selectPath('${name}', '${type}')">
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
			container.innerHTML = '<p style="color: #666;">No inputs required for this flow.</p>'
		}

		// Create parameter override fields
		const paramsContainer = document.getElementById('flow-parameter-fields')
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
			window.flowModule.confirmFlowRun = async () => {
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
							flowId,
							name: configName,
							configData: { inputs, parameters },
						})
						console.log('✅ Saved run configuration:', configName)
					} catch (error) {
						console.error('Failed to save config:', error)
						// Don't block the run if save fails
					}
				}

				closeFlowRunDialog()
				resolve({ inputs, parameters })
			}

			window.flowModule.closeFlowRunDialog = () => {
				closeFlowRunDialog()
				resolve(null)
			}
		})
	}
	function closeFlowRunDialog() {
		const modal = document.getElementById('flow-run-modal')
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

	// Delete flow
	async function deleteFlow(flowId) {
		const confirmed = await confirmWithDialog('Are you sure you want to delete this flow?', {
			title: 'Delete Flow',
			type: 'warning',
		})
		if (!confirmed) {
			return
		}

		try {
			await invoke('delete_flow', { flowId: flowId })
			await loadFlows()
		} catch (error) {
			alert('Error deleting flow: ' + error)
		}
	}

	// Open flow folder
	async function openFlowFolder(path) {
		try {
			await invoke('open_folder', { path })
		} catch (error) {
			alert('Error opening folder: ' + error)
		}
	}

	// Edit flow (placeholder for now)
	async function editFlow(flowId) {
		alert('Flow editor coming soon! For now, you can edit the flow.yaml file directly.')
		const flow = flowState.flows.find((p) => p.id === flowId)
		if (flow) {
			await openFlowFolder(flow.flow_path)
		}
	}

	// Show flow menu (for ... button)
	function showFlowMenu(flowId, event) {
		event.stopPropagation()

		const flow = flowState.flows.find((p) => p.id === flowId)
		if (!flow) return

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
				Delete Flow
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
					await openFlowFolder(flow.flow_path)
				} else if (action === 'delete') {
					await deleteFlow(flowId)
				}
			})
		})
	}

	// Attach back button handler
	function attachBackButton() {
		const backBtn = document.getElementById('back-to-flows-btn')
		if (backBtn) {
			backBtn.addEventListener('click', backToFlowsList)
		}
	}

	// Attach detail view button handlers
	function attachDetailViewButtons() {
		const runBtn = document.getElementById('flow-detail-run')
		if (runBtn) {
			runBtn.addEventListener('click', async () => {
				if (flowState.currentFlow) {
					await handleFlowRunClick(flowState.currentFlow.id)
				}
			})
		}

		const collabBtn = document.getElementById('flow-detail-collab')
		if (collabBtn) {
			collabBtn.addEventListener('click', async () => {
				if (flowState.currentFlow) {
					await showCollaborativeRunModal(flowState.currentFlow)
				}
			})
		}

		const editBtn = document.getElementById('flow-detail-edit')
		if (editBtn) {
			editBtn.addEventListener('click', () => {
				if (flowState.currentFlow) {
					editFlow(flowState.currentFlow.id)
				}
			})
		}

		const addStepBtn = document.getElementById('add-step-to-flow')
		if (addStepBtn) {
			addStepBtn.addEventListener('click', () => {
				if (flowState.currentFlow) {
					showStepPickerModal()
				} else {
					console.error('Cannot add step: no current flow')
				}
			})
		}

		const editFlowBtn = document.getElementById('edit-flow-yaml-btn')
		if (editFlowBtn) {
			editFlowBtn.addEventListener('click', () => {
				if (flowState.currentFlow) {
					openFlowYAMLInVSCode()
				}
			})
		}
	}

	// Initialization function
	function initialize() {
		// Set up listener to refresh banner when sessionStorage changes
		// Use storage event (works across tabs) and also poll when Flows view is active
		let bannerCheckInterval = null

		async function maybeAutoOpenDataRunModal() {
			if (flowState.dataRunModalOpen) return
			const context = getPendingDataRunContext()
			const hasData =
				context &&
				((context.urls && context.urls.length > 0) ||
					(context.fileIds && context.fileIds.length > 0))
			if (!hasData) return

			const contextKey = JSON.stringify({
				urls: context.urls || [],
				fileIds: context.fileIds || [],
				participants: context.participantIds || [],
			})
			if (flowState.lastAutoOpenKey === contextKey) {
				return
			}
			flowState.lastAutoOpenKey = contextKey
			try {
				await showDataRunModalDirect()
			} catch (err) {
				console.warn('Failed to auto-open data run modal:', err)
			}
		}

		function refreshBannerIfNeeded() {
			const isFlowsViewActive = document.getElementById('run-view')?.classList.contains('active')
			if (isFlowsViewActive) {
				// Clear cached context to force fresh read from sessionStorage
				flowState.pendingDataRun = null
				renderDataRunBanner()
				maybeAutoOpenDataRunModal()
			}
		}

		// Listen for storage events (works when Data tab updates sessionStorage)
		window.addEventListener('storage', (e) => {
			if (
				e.key === 'preselectedFileIds' ||
				e.key === 'preselectedParticipants' ||
				e.key === 'preselectedUrls' ||
				e.key === 'preselectedDatasetName' ||
				e.key === 'preselectedDatasetShape' ||
				e.key === 'preselectedDatasetDataType'
			) {
				refreshBannerIfNeeded()
			}
		})

		// Also poll when Flows view is active (since storage events don't fire in same window)
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
			const isFlowsViewActive = document.getElementById('run-view')?.classList.contains('active')
			if (isFlowsViewActive) {
				startBannerPolling()
			} else {
				stopBannerPolling()
			}
		}, 1000)

		// Initial check
		setTimeout(() => {
			const isFlowsViewActive = document.getElementById('run-view')?.classList.contains('active')
			if (isFlowsViewActive) {
				startBannerPolling()
			}
		}, 100)

		// Make functions available globally FIRST (before loading flows)
		window.flowModule = {
			editFlow,
			runFlow,
			openFlowFolder,
			deleteFlow,
			closeWizard,
			wizardNext,
			wizardBack,
			addFlowInput,
			addFlowStep,
			removeStep,
			moveStepUp,
			moveStepDown,
			createFlow,
			selectPath,
			closeFlowRunDialog,
			browseForModule,
			closeAddStepModal,
			confirmAddStep,
			showFlowDetails,
			configureStepBindings,
			editFlowStep,
			removeFlowStep,
			editBinding,
			removeBinding,
			removePublishOutput,
			removeSQLStore,
			closeBindingConfigModal,
			updateStepBindings,
			showFlowMenu,
			backToFlowsList,
			showCreateFlowWizard,
			showTemplateFlowPicker,
			showImportOptions,
			closeImportOptionsModal,
			importTemplateFlow,
			closeFlowPickerModal,
			createBlankFlow,
			closeFlowNameModal,
			submitFlowName,
			importFlowFromURL,
			closeURLInputModal,
			submitFlowURL,
			importExistingFlow,
			importStepFromURL,
			closeStepURLInputModal,
			submitStepURL,
			loadFlowSteps,
			closeStepPickerModal,
			showDataRunModal: showDataRunModalDirect,
			showExistingModulesList,
			closeModulesListModal,
			browseForStepFolder,
			createNewStepModule,
			closeBlankStepModal,
			submitBlankStepName,
			saveStepWithBindings,
			showFlowInputModal,
			closeFlowInputModal,
			saveFlowInput,
			editFlowInput,
			removeFlowInput,
			showFlowYAMLModal,
			closeYAMLViewerModal,
			openYAMLInVSCode,
			openFlowYAMLInVSCode,
			launchJupyterForStep,
			openVSCodeForStep,
			editParameter,
			resetParameter,
			loadFlows,
		}

		// Load flows after setting up global handlers
		loadFlows()

		// Attach event handlers to all create flow buttons
		const createBtn = document.getElementById('create-flow-btn')
		if (createBtn) {
			createBtn.addEventListener('click', showCreateFlowWizard)
		}

		const emptyCreateBtn = document.getElementById('empty-create-flow-btn')
		if (emptyCreateBtn) {
			emptyCreateBtn.addEventListener('click', showCreateFlowWizard)
		}

		const runCreateBtn = document.getElementById('run-create-flow-btn')
		if (runCreateBtn) {
			runCreateBtn.addEventListener('click', showCreateFlowWizard)
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
						<h2>Add Step to Flow</h2>
						<button class="modal-close" onclick="flowModule.closeStepPickerModal()">×</button>
					</div>
					<div class="modal-body">
						<div style="display: flex; flex-direction: column; gap: 10px;">
							<button class="action-btn-large" onclick="flowModule.importStepFromURL()">
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
							<button class="action-btn-large" onclick="flowModule.showExistingModulesList()">
								<div class="action-btn-icon">
									<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
										<rect x="3" y="3" width="7" height="7"></rect>
										<rect x="14" y="3" width="7" height="7"></rect>
										<rect x="14" y="14" width="7" height="7"></rect>
										<rect x="3" y="14" width="7" height="7"></rect>
									</svg>
								</div>
								<div class="action-btn-content">
									<div class="action-btn-title">Import Existing Module</div>
									<div class="action-btn-desc">Select from your registered modules</div>
								</div>
							</button>
							<button class="action-btn-large" onclick="flowModule.browseForStepFolder()">
								<div class="action-btn-icon">
									<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
										<path d="M3 7v10a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-6l-2-2H5a2 2 0 0 0-2 2z"></path>
									</svg>
								</div>
								<div class="action-btn-content">
									<div class="action-btn-title">Browse Local Folder</div>
									<div class="action-btn-desc">Select a module folder on your computer</div>
								</div>
							</button>
							<button class="action-btn-large" onclick="flowModule.createNewStepModule()">
								<div class="action-btn-icon">
									<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
										<line x1="12" y1="5" x2="12" y2="19"></line>
										<line x1="5" y1="12" x2="19" y2="12"></line>
									</svg>
								</div>
								<div class="action-btn-content">
									<div class="action-btn-title">Create New Module</div>
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

	// Show existing modules list (called from step picker)
	async function showExistingModulesList() {
		try {
			const modules = await invoke('get_modules')

			const modalHtml = `
				<div id="modules-list-modal" class="modal-overlay" style="display: flex;">
					<div class="modal-content" style="width: 600px; max-height: 80vh;">
						<div class="modal-header">
							<button class="back-button-icon" onclick="flowModule.closeModulesListModal(); flowModule.showStepPickerModal()">
								<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
									<polyline points="15 18 9 12 15 6"></polyline>
								</svg>
							</button>
							<h2 style="margin: 0;">Select Module</h2>
							<button class="modal-close" onclick="flowModule.closeModulesListModal()">×</button>
						</div>
						<div class="modal-body" style="max-height: 60vh; overflow-y: auto;">
							${
								modules.length > 0
									? `
								<div class="module-select-list">
									${modules
										.map(
											(p) => `
										<div class="module-select-item" data-path="${p.module_path}" data-name="${p.name}">
											<div class="module-select-info">
												<div class="module-select-name">${p.name}</div>
												<div class="module-select-path">${p.module_path}</div>
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
									: '<p style="color: #9ca3af; padding: 40px; text-align: center;">No modules registered yet. Import or create one!</p>'
							}
						</div>
					</div>
				</div>
			`

			closeStepPickerModal()
			document.body.insertAdjacentHTML('beforeend', modalHtml)

			// Add click handlers
			document.querySelectorAll('.module-select-item').forEach((item) => {
				item.addEventListener('click', async () => {
					const path = item.dataset.path
					const name = item.dataset.name
					await addStepFromPath(path, name)
					closeModulesListModal()
				})
			})
		} catch (error) {
			console.error('Error showing modules list:', error)
			alert('Failed to show modules: ' + error)
		}
	}

	function closeModulesListModal() {
		const modal = document.getElementById('modules-list-modal')
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
						<button class="modal-close" onclick="flowModule.closeStepURLInputModal()">×</button>
					</div>
					<div class="modal-body">
						<label style="display: block; margin-bottom: 8px; font-weight: 600; color: #374151;">
							GitHub URL to module.yaml
						</label>
						<input 
							type="text" 
							id="step-url-input" 
							placeholder="https://raw.githubusercontent.com/OpenMined/biovault/main/cli/examples/flow/count-lines/module.yaml"
							style="width: 100%; padding: 10px 12px; border: 1px solid #e5e7eb; border-radius: 6px; font-size: 13px; box-sizing: border-box; font-family: 'SF Mono', Monaco, monospace;"
						>
						<p style="font-size: 13px; color: #6b7280; margin-top: 8px;">
							📝 Use GitHub raw URLs (raw.githubusercontent.com) to import modules.
							<br>
							This will download the module.yaml and assets, then add it as a step.
						</p>
					</div>
					<div class="modal-footer">
						<button class="secondary-btn" onclick="flowModule.closeStepURLInputModal()">Cancel</button>
						<button class="primary-btn" onclick="flowModule.submitStepURL()">Import & Add Step</button>
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
						flowModule.submitStepURL()
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
			const result = await invoke('import_module', {
				url: url,
				overwrite: overwrite,
			})

			// Validate the result
			if (!result.module_path) {
				throw new Error('Import succeeded but no module path returned')
			}

			// Add the imported module as a step
			await addStepFromPath(result.module_path, result.name)

			console.log('✅ Imported and added step from URL:', url)
			alert(`Successfully imported module: ${result.name}`)
		} catch (error) {
			console.error('Error importing from URL:', error)
			const errorMsg = error?.message || error?.toString() || String(error) || 'Unknown error'

			if (errorMsg.includes('already exists')) {
				const shouldOverwrite = await confirmWithDialog(
					`${errorMsg}\n\nDo you want to overwrite it?`,
					{ title: 'Overwrite Module?', type: 'warning' },
				)
				if (shouldOverwrite) {
					await submitStepURL(true, url)
					return
				}
			} else {
				let userMessage = 'Failed to import module:\n\n' + errorMsg

				if (errorMsg.includes('not found') || errorMsg.includes('404')) {
					userMessage +=
						'\n\n💡 Tip: Make sure the URL points to a valid module.yaml file or module directory.'
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
				// Import/register the module first so it appears in the list
				try {
					await invoke('import_module_from_folder', {
						folderPath: selected,
						overwrite: overwrite,
					})
				} catch (e) {
					const errorStr = e.toString ? e.toString() : String(e)
					if (errorStr.includes('already exists')) {
						const shouldOverwrite = await confirmWithDialog(
							`${errorStr}\n\nDo you want to overwrite it?`,
							{ title: 'Overwrite Module?', type: 'warning' },
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
					console.log('Module may already be registered:', e)
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

	function createNewStepModule() {
		closeStepPickerModal()

		// Show simple name input (no wizard)
		const modalHtml = `
			<div id="blank-step-modal" class="modal-overlay" style="display: flex;">
				<div class="modal-content" style="width: 450px;">
					<div class="modal-header">
						<h2>Create Blank Step</h2>
						<button class="modal-close" onclick="flowModule.closeBlankStepModal()">×</button>
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
						<button class="secondary-btn" onclick="flowModule.closeBlankStepModal()">Cancel</button>
						<button class="primary-btn" onclick="flowModule.submitBlankStepName()">Create Step</button>
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
						flowModule.submitBlankStepName()
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

			// Create blank module
			const result = await invoke('create_module', {
				name: name,
				example: null,
				directory: null,
				createPythonScript: false,
				scriptName: null,
			})

			// Add to flow
			await addStepFromPath(result.module_path, result.name)

			console.log('✅ Created blank step:', name)
		} catch (error) {
			console.error('Error creating blank step:', error)
			const errorMsg = error?.message || error?.toString() || String(error) || 'Unknown error'
			alert('Failed to create step: ' + errorMsg)
		}
	}

	async function addStepFromPath(modulePath, moduleName) {
		if (!flowState.currentFlow) return

		try {
			console.log('➕ Adding step to flow:')
			console.log('   Module Name:', moduleName)
			console.log('   Module Path:', modulePath)

			// Ensure the module is registered in the database
			try {
				await invoke('import_module_from_folder', {
					folderPath: modulePath,
					overwrite: false,
				})
				console.log('✅ Module registered in database:', moduleName)
			} catch (e) {
				// Might already be registered, that's ok
				console.log('ℹ️ Module may already be registered:', e.toString())
			}

			// Load current flow
			const editorData = await invoke('load_flow_editor', {
				flowId: flowState.currentFlow.id,
			})

			// Create step using module NAME (not path) for portability
			const stepId = moduleName.toLowerCase().replace(/[^a-z0-9]/g, '-')
			const newStep = {
				id: stepId,
				uses: moduleName, // Use name for database lookup (portable!)
				with: {}, // Empty - configure later via button
			}

			console.log('📝 Adding step to flow spec:', newStep)

			// Add step
			if (!editorData.spec.steps) {
				editorData.spec.steps = []
			}
			editorData.spec.steps.push(newStep)

			// Save
			await invoke('save_flow_editor', {
				flowId: flowState.currentFlow.id,
				flowPath: flowState.currentFlow.flow_path,
				spec: editorData.spec,
			})

			// Refresh
			await loadFlows()
			const updated = flowState.flows.find((p) => p.id === flowState.currentFlow.id)
			if (updated) {
				flowState.currentFlow = updated
			}
			await loadFlowSteps(flowState.currentFlow.id)

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

	async function saveStepWithBindings(modulePath, stepId) {
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

			// Load current flow
			const editorData = await invoke('load_flow_editor', {
				flowId: flowState.currentFlow.id,
			})

			// Create step with bindings
			const newStep = {
				id: stepId,
				uses: modulePath,
				with: bindings,
			}

			// Add step
			if (!editorData.spec.steps) {
				editorData.spec.steps = []
			}
			editorData.spec.steps.push(newStep)

			// Save
			await invoke('save_flow_editor', {
				flowId: flowState.currentFlow.id,
				flowPath: flowState.currentFlow.flow_path,
				spec: editorData.spec,
			})

			// Refresh
			await loadFlows()
			const updated = flowState.flows.find((p) => p.id === flowState.currentFlow.id)
			if (updated) {
				flowState.currentFlow = updated
			}
			await loadFlowSteps(flowState.currentFlow.id)

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
		moduleSpec: null,
		bindings: {},
		parameters: {},
		publish: {},
		store: {},
		editingBindingInput: null,
	}

	// Configure step bindings
	async function configureStepBindings(stepIndex) {
		if (!flowState.currentFlow) return

		const step = flowState.currentFlow.spec?.steps?.[stepIndex]
		if (!step) return

		try {
			console.log('📋 Configuring step:', step.id, '- uses:', step.uses)

			// Load module spec to get inputs
			const moduleSpec = await invoke('load_module_editor', {
				modulePath: step.uses,
			})

			console.log('✅ Loaded module spec from path:', moduleSpec.module_path)
			console.log('   Inputs:', moduleSpec.metadata?.inputs?.length || 0)
			console.log('   Parameters:', moduleSpec.metadata?.parameters?.length || 0)
			console.log('   Outputs:', moduleSpec.metadata?.outputs?.length || 0)

			// Show new visual config modal
			await showVisualConfigModal(step, stepIndex, moduleSpec)
		} catch (error) {
			console.error('Error loading module for configuration:', error)
			alert('Failed to load module: ' + error)
		}
	}

	async function showVisualConfigModal(step, stepIndex, moduleSpec) {
		configureStepState.stepIndex = stepIndex
		configureStepState.step = step
		configureStepState.moduleSpec = moduleSpec
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

		const parameters = configureStepState.moduleSpec.metadata?.parameters || []

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

		const inputs = configureStepState.moduleSpec.metadata?.inputs || []

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
							<button class="btn-bind" onclick="flowModule.editBinding('${escapeHtml(input.name)}')">
								${isBound ? 'Change' : 'Set Binding'}
							</button>
							${
								isBound
									? `<button class="btn-unbind" onclick="flowModule.removeBinding('${escapeHtml(
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
		const param = configureStepState.moduleSpec.metadata?.parameters?.find(
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
			moduleSpec: null,
			bindings: {},
			parameters: {},
			publish: {},
			store: {},
			editingBindingInput: null,
		}
	}

	async function launchJupyterForStep() {
		if (!configureStepState.moduleSpec) return

		try {
			// Use the resolved module path from moduleSpec, not step.uses
			const modulePath = configureStepState.moduleSpec.module_path
			if (!modulePath) {
				throw new Error('Module path not available')
			}

			console.log('🚀 Launching Jupyter for module at:', modulePath)

			await invoke('launch_jupyter', {
				modulePath: modulePath,
			})
		} catch (error) {
			console.error('Error launching Jupyter:', error)
			alert('Failed to launch Jupyter: ' + error.toString())
		}
	}

	async function openVSCodeForStep() {
		if (!configureStepState.moduleSpec) return

		try {
			// Use the resolved module path from moduleSpec, not step.uses
			const modulePath = configureStepState.moduleSpec.module_path
			if (!modulePath) {
				throw new Error('Module path not available')
			}

			console.log('📂 Opening VSCode for module at:', modulePath)

			await invoke('open_in_vscode', {
				path: modulePath,
			})
		} catch (error) {
			console.error('Error opening VSCode:', error)
			alert('Failed to open VSCode: ' + error.toString())
		}
	}

	async function saveStepConfiguration() {
		try {
			// Load current flow
			const editorData = await invoke('load_flow_editor', {
				flowId: flowState.currentFlow.id,
			})

			// Update step
			if (editorData.spec.steps[configureStepState.stepIndex]) {
				editorData.spec.steps[configureStepState.stepIndex].with = configureStepState.bindings

				// NOTE: Parameters are NOT saved to flow.yaml per spec
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
			await invoke('save_flow_editor', {
				flowId: flowState.currentFlow.id,
				flowPath: flowState.currentFlow.flow_path,
				spec: editorData.spec,
			})

			// Refresh
			await loadFlows()
			const updated = flowState.flows.find((p) => p.id === flowState.currentFlow.id)
			if (updated) {
				flowState.currentFlow = updated
			}
			await loadFlowSteps(flowState.currentFlow.id)

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
		const input = configureStepState.moduleSpec.metadata?.inputs?.find((i) => i.name === inputName)
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
			// Flow input
			sourceTypeSelect.value = 'flow-input'
			updateBindingSelectors()
			const inputName = binding.replace('inputs.', '')
			document.getElementById('binding-flow-input-select').value = inputName
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
		document.getElementById('binding-flow-input-selector').style.display = 'none'
		document.getElementById('binding-step-output-selector').style.display = 'none'
		document.getElementById('binding-literal-selector').style.display = 'none'
		document.getElementById('binding-preview').style.display = 'none'

		if (sourceType === 'flow-input') {
			// Populate flow inputs with type checking
			const flowInputs = flowState.currentFlow.spec?.inputs || {}
			const select = document.getElementById('binding-flow-input-select')

			// Get expected input type
			const inputName = configureStepState.editingBindingInput
			const input = configureStepState.moduleSpec.metadata?.inputs?.find(
				(i) => i.name === inputName,
			)
			const expectedType = input?.type?.replace('?', '') || 'File'

			select.innerHTML =
				'<option value="">-- Select Input --</option>' +
				Object.entries(flowInputs)
					.map(([key, spec]) => {
						const flowInputType = typeof spec === 'string' ? spec : spec.type || 'File'
						const cleanType = flowInputType.replace('?', '')
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
			document.getElementById('binding-flow-input-selector').style.display = 'block'
			select.onchange = () => updateBindingPreview()
		} else if (sourceType === 'step-output') {
			// Populate previous steps
			const steps = flowState.currentFlow.spec?.steps || []
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

		// Find the step and load its module to get outputs
		const step = flowState.currentFlow.spec?.steps?.find((s) => s.id === stepId)
		if (!step) return

		try {
			// Get expected input type for compatibility checking
			const inputName = configureStepState.editingBindingInput
			const input = configureStepState.moduleSpec.metadata?.inputs?.find(
				(i) => i.name === inputName,
			)
			const expectedType = input?.type?.replace('?', '') || 'File' // Remove optional marker

			const moduleSpec = await invoke('load_module_editor', {
				modulePath: step.uses,
			})

			const outputs = moduleSpec.metadata?.outputs || []
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
			console.error('Failed to load module outputs:', error)
			outputSelect.innerHTML = '<option value="">-- Error loading outputs --</option>'
		}
	}

	function updateBindingPreview() {
		const sourceType = document.getElementById('binding-source-type').value
		const previewDiv = document.getElementById('binding-preview')
		const previewCode = document.getElementById('binding-preview-code')

		let binding = ''

		if (sourceType === 'flow-input') {
			const inputName = document.getElementById('binding-flow-input-select').value
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

		if (sourceType === 'flow-input') {
			const flowInput = document.getElementById('binding-flow-input-select').value
			if (!flowInput) {
				alert('Please select a flow input')
				return
			}
			binding = `inputs.${flowInput}`
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
				<button class="publish-item-remove" onclick="flowModule.removePublishOutput('${escapeHtml(
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
		const outputs = configureStepState.moduleSpec.metadata?.outputs || []
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
					<button class="store-item-remove" onclick="flowModule.removeSQLStore('${escapeHtml(
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

	// Edit a flow step - opens the module editor for that step
	async function editFlowStep(stepIndex) {
		if (!flowState.currentFlow) {
			console.error('No current flow')
			return
		}

		const step = flowState.currentFlow.spec?.steps?.[stepIndex]
		if (!step) {
			console.error('Step not found at index:', stepIndex)
			return
		}

		// Open the module editor for this step's module
		if (openModuleEditor && step.uses) {
			await openModuleEditor({ modulePath: step.uses })
		} else {
			console.error('Cannot open module editor: missing function or module path')
		}
	}

	// Remove a flow step
	async function removeFlowStep(stepIndex) {
		if (!flowState.currentFlow) {
			console.error('No current flow')
			return
		}

		if (!confirm('Are you sure you want to remove this step from the flow?')) {
			return
		}

		try {
			// Load current flow spec
			const editorData = await invoke('load_flow_editor', {
				flowId: flowState.currentFlow.id,
			})

			// Remove the step
			editorData.spec.steps.splice(stepIndex, 1)

			// Save updated flow
			await invoke('save_flow_editor', {
				flowId: flowState.currentFlow.id,
				flowPath: flowState.currentFlow.flow_path,
				spec: editorData.spec,
			})

			// Reload flows and steps
			await loadFlows()

			const updatedFlow = flowState.flows.find((p) => p.id === flowState.currentFlow.id)
			if (updatedFlow) {
				flowState.currentFlow = updatedFlow
			}

			await loadFlowSteps(flowState.currentFlow.id)

			console.log('✅ Removed step from flow')
		} catch (error) {
			console.error('Error removing step:', error)
			alert('Failed to remove step: ' + error.message)
		}
	}

	// Add a newly created module as a step to the current flow
	async function addModuleAsStep(modulePath, moduleName) {
		if (!flowState.currentFlow) {
			console.error('No current flow to add step to')
			return
		}

		try {
			console.log('🔧 Adding step to flow:', flowState.currentFlow.name)

			// Load current flow spec
			const editorData = await invoke('load_flow_editor', {
				flowId: flowState.currentFlow.id,
			})

			console.log('📄 Loaded flow spec:', editorData.spec)

			// Create new step (CLI parity - only include non-empty fields)
			const stepId = moduleName.toLowerCase().replace(/[^a-z0-9]/g, '-')
			const newStep = {
				id: stepId,
				uses: modulePath,
				with: {},
				// Don't include publish/store unless they have values (CLI parity)
			}

			console.log('➕ New step:', newStep)

			// Add step to flow
			if (!editorData.spec.steps) {
				editorData.spec.steps = []
			}
			editorData.spec.steps.push(newStep)

			console.log('📝 Updated spec with', editorData.spec.steps.length, 'steps')

			// Save updated flow
			await invoke('save_flow_editor', {
				flowId: flowState.currentFlow.id,
				flowPath: flowState.currentFlow.flow_path,
				spec: editorData.spec,
			})

			console.log('💾 Saved flow')

			// Reload flows list (now includes spec from YAML files)
			await loadFlows()
			console.log('🔄 Reloaded flows list')

			// Update current flow reference with fresh data
			const updatedFlow = flowState.flows.find((p) => p.id === flowState.currentFlow.id)
			if (updatedFlow) {
				flowState.currentFlow = updatedFlow
				console.log('✅ Updated current flow, steps count:', updatedFlow.spec?.steps?.length || 0)
			}

			// Reload the steps display
			await loadFlowSteps(flowState.currentFlow.id)
			console.log('🎉 Refreshed step display')

			console.log(`✅ Added step "${stepId}" to flow "${flowState.currentFlow.name}"`)
		} catch (error) {
			console.error('Error adding step to flow:', error)
			alert('Failed to add step to flow: ' + error.message)
		}
	}

	// Open run flow modal with dataset context
	// Called from Data tab when user clicks "Run Flow" on a dataset card
	// Also called from Network tab for peer datasets with mock data
	async function openRunFlowWithDataset({ name, dataType, entry, flowId }) {
		console.log('openRunFlowWithDataset called with:', { name, dataType, entry, flowId })

		try {
			let assets = []
			const setDatasetContext = ({
				datasetName,
				datasetOwner,
				assetKeys,
				dataTypeLabel,
				dataSource,
			}) => {
				try {
					if (datasetName) {
						sessionStorage.setItem('preselectedDatasetName', datasetName)
					} else {
						sessionStorage.removeItem('preselectedDatasetName')
					}
					if (datasetOwner) {
						sessionStorage.setItem('preselectedDatasetOwner', datasetOwner)
					} else {
						sessionStorage.removeItem('preselectedDatasetOwner')
					}
					if (assetKeys && assetKeys.length > 0) {
						sessionStorage.setItem('preselectedAssetKeys', JSON.stringify(assetKeys))
					} else {
						sessionStorage.removeItem('preselectedAssetKeys')
					}
					if (dataTypeLabel) {
						sessionStorage.setItem('preselectedDataType', dataTypeLabel)
					} else {
						sessionStorage.removeItem('preselectedDataType')
					}
					if (dataSource) {
						sessionStorage.setItem('preselectedDataSource', dataSource)
					} else {
						sessionStorage.removeItem('preselectedDataSource')
					}
				} catch (err) {
					console.warn('Failed to set dataset context:', err)
				}
			}

			const storeDataSelection = ({
				urls,
				participantIds,
				mockUrls,
				mockParticipantIds,
				realUrls,
				realParticipantIds,
			}) => {
				try {
					if (Array.isArray(urls) && urls.length > 0) {
						sessionStorage.setItem('preselectedUrls', JSON.stringify(urls))
					} else {
						sessionStorage.removeItem('preselectedUrls')
					}
					if (Array.isArray(participantIds) && participantIds.length > 0) {
						sessionStorage.setItem('preselectedParticipants', JSON.stringify(participantIds))
					} else {
						sessionStorage.removeItem('preselectedParticipants')
					}
					if (Array.isArray(mockUrls) && mockUrls.length > 0) {
						sessionStorage.setItem('preselectedUrlsMock', JSON.stringify(mockUrls))
					} else {
						sessionStorage.removeItem('preselectedUrlsMock')
					}
					if (Array.isArray(mockParticipantIds) && mockParticipantIds.length > 0) {
						sessionStorage.setItem(
							'preselectedParticipantsMock',
							JSON.stringify(mockParticipantIds),
						)
					} else {
						sessionStorage.removeItem('preselectedParticipantsMock')
					}
					if (Array.isArray(realUrls) && realUrls.length > 0) {
						sessionStorage.setItem('preselectedUrlsReal', JSON.stringify(realUrls))
					} else {
						sessionStorage.removeItem('preselectedUrlsReal')
					}
					if (Array.isArray(realParticipantIds) && realParticipantIds.length > 0) {
						sessionStorage.setItem(
							'preselectedParticipantsReal',
							JSON.stringify(realParticipantIds),
						)
					} else {
						sessionStorage.removeItem('preselectedParticipantsReal')
					}
				} catch (err) {
					console.warn('Failed to store dataset selection:', err)
				}
			}

			// Check if this is a network dataset (has owner that's not us) or local dataset
			const isNetworkDataset = entry && entry.owner && !entry.is_own

			if (isNetworkDataset) {
				// For network datasets, use the assets from the entry directly
				console.log('Using network dataset assets from entry')
				assets = entry.assets || []

				// Network dataset assets have a different structure - extract mock paths
				if (dataType === 'mock' && assets.length > 0) {
					const mockEntryUrls = []
					const mockEntryParticipants = []

					for (const asset of assets) {
						if (Array.isArray(asset.mock_entries)) {
							for (const entry of asset.mock_entries) {
								if (entry?.url) {
									mockEntryUrls.push(entry.url)
									mockEntryParticipants.push(String(entry.participant_id || ''))
								}
							}
						}
					}

					if (mockEntryUrls.length > 0) {
						const assetKeys = assets
							.map((asset) => asset.key || asset.asset_key || asset.assetKey)
							.filter(Boolean)
						setDatasetContext({
							datasetName: entry?.name || name,
							datasetOwner: entry?.owner,
							assetKeys,
							dataTypeLabel: dataType,
							dataSource: 'network_dataset',
						})
						console.log('Using network mock entries:', mockEntryUrls)
						storeDataSelection({
							urls: mockEntryUrls,
							participantIds: mockEntryParticipants,
							mockUrls: mockEntryUrls,
							mockParticipantIds: mockEntryParticipants,
						})

						if (navigateTo) {
							navigateTo('run')
						}

						setTimeout(async () => {
							try {
								await loadFlows()
								await showDataRunModalDirect(flowId)
							} catch (err) {
								console.error('Error showing data run modal:', err)
							}
						}, 100)
						return
					}

					const mockPaths = []

					// Get the datasites directory to derive local paths from mock_url if needed
					let datasitesDir = null
					try {
						const configInfo = await invoke('get_syftbox_config_info')
						if (configInfo?.data_dir) {
							datasitesDir = configInfo.data_dir.endsWith('/datasites')
								? configInfo.data_dir
								: configInfo.data_dir + '/datasites'
						}
					} catch (err) {
						console.warn('Could not get datasites dir:', err)
					}

					for (const asset of assets) {
						// Network assets have mock_path directly (if file is synced)
						if (asset.mock_path) {
							mockPaths.push(asset.mock_path)
						} else if (asset.mock_url && datasitesDir) {
							// Derive local path from mock_url
							// mock_url format: syft://{owner}/public/biovault/datasets/{name}/assets/{file}
							// local path: {datasitesDir}/{owner}/public/biovault/datasets/{name}/assets/{file}
							const urlPath = asset.mock_url.replace(/^syft:\/\//, '')
							const localPath = datasitesDir + '/' + urlPath
							console.log('Derived mock path from URL:', localPath)
							mockPaths.push(localPath)
						}
					}
					if (mockPaths.length > 0) {
						const assetKeys = assets
							.map((asset) => asset.key || asset.asset_key || asset.assetKey)
							.filter(Boolean)
						setDatasetContext({
							datasetName: entry?.name || name,
							datasetOwner: entry?.owner,
							assetKeys,
							dataTypeLabel: dataType,
							dataSource: 'network_dataset',
						})
						console.log('Using network mock paths:', mockPaths)
						// Set paths directly for flow run
						sessionStorage.removeItem('preselectedDatasetName')
						sessionStorage.removeItem('preselectedDatasetShape')
						sessionStorage.removeItem('preselectedDatasetDataType')
						const mockUrls = mockPaths.map((p) => `file://${p}`)
						const mockParticipants = mockPaths.map(() => '')
						storeDataSelection({
							urls: mockUrls,
							participantIds: mockParticipants,
							mockUrls,
							mockParticipantIds: mockParticipants,
						})

						// Navigate to flows tab
						if (navigateTo) {
							navigateTo('run')
						}

						// Wait for navigation and then show modal
						setTimeout(async () => {
							try {
								await loadFlows()
								await showDataRunModalDirect(flowId)
							} catch (err) {
								console.error('Error showing data run modal:', err)
							}
						}, 100)
						return
					}
				}

				if (dialog?.message) {
					await dialog.message('No synced mock data found for this dataset.', {
						title: 'No Mock Data',
						type: 'warning',
					})
				}
				return
			}

			// For local datasets or if network path extraction failed, query database
			console.log('Fetching datasets with list_datasets_with_assets...')
			const datasetsWithAssets = await invoke('list_datasets_with_assets')
			console.log('Got datasets:', datasetsWithAssets)
			const datasetEntry = datasetsWithAssets.find((d) => d.dataset?.name === name)
			console.log('Found dataset entry:', datasetEntry)

			if (!datasetEntry) {
				console.error(
					'Dataset not found:',
					name,
					'Available:',
					datasetsWithAssets.map((d) => d.dataset?.name),
				)
				if (dialog?.message) {
					await dialog.message(`Dataset "${name}" not found`, { title: 'Error', type: 'error' })
				}
				return
			}

			// Assets are included in the response
			assets = datasetEntry.assets || []
			const assetKeys = assets
				.map((asset) => asset.asset_key || asset.key || asset.assetKey)
				.filter(Boolean)
			setDatasetContext({
				datasetName: datasetEntry.dataset?.name || name,
				datasetOwner: datasetEntry.dataset?.author || entry?.owner || null,
				assetKeys,
				dataTypeLabel: dataType,
				dataSource: 'dataset',
			})
			console.log('Dataset assets:', assets)
			if (assets.length === 0) {
				console.error('Dataset has no assets:', name)
				if (dialog?.message) {
					await dialog.message(`Dataset "${name}" has no assets`, { title: 'Error', type: 'error' })
				}
				return
			}

			// Resolve dataset shape for type matching
			const datasetShape = resolveDatasetShape(datasetEntry, assets, dataType)

			// Store dataset context in sessionStorage
			sessionStorage.setItem('preselectedDatasetName', name)
			if (datasetShape) {
				sessionStorage.setItem('preselectedDatasetShape', datasetShape)
			} else {
				sessionStorage.removeItem('preselectedDatasetShape')
			}
			if (dataType) {
				sessionStorage.setItem('preselectedDatasetDataType', dataType)
			} else {
				sessionStorage.removeItem('preselectedDatasetDataType')
			}
			sessionStorage.removeItem('preselectedFileIds')

			const mockUrls = []
			const mockParticipantIds = []
			const realUrls = []
			const realParticipantIds = []

			console.error('DEBUG: All assets for extraction:', JSON.stringify(assets, null, 2))
			console.error('DEBUG: dataType =', dataType)

			// Extract URLs and participant IDs based on dataType
			for (const asset of assets) {
				console.error('Processing asset:', asset.asset_key, {
					private_ref: asset.private_ref,
					mock_ref: asset.mock_ref,
					private_path: asset.private_path,
					mock_path: asset.mock_path,
					resolved_private_path: asset.resolved_private_path,
					resolved_mock_path: asset.resolved_mock_path,
					private_file_id: asset.private_file_id,
					mock_file_id: asset.mock_file_id,
				})
				// Parse the private_ref and mock_ref - they can be:
				// 1. JSON objects with entries array (twin_list)
				// 2. Plain URL strings (syft://...)
				// 3. Template strings like {url}.private (not useful for extraction)
				let privateRef = null
				let mockRef = null

				if (asset.private_ref) {
					// Only try to parse if it looks like JSON (starts with { or [)
					const trimmed = asset.private_ref.trim()
					if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
						try {
							privateRef = JSON.parse(asset.private_ref)
						} catch (e) {
							console.warn('Failed to parse private_ref as JSON:', e)
						}
					} else if (trimmed.startsWith('syft://') || trimmed.startsWith('http')) {
						// Plain URL string
						privateRef = { url: trimmed }
					}
					// Template strings like {url}.private are ignored
				}

				if (asset.mock_ref) {
					// Only try to parse if it looks like JSON (starts with { or [)
					const trimmed = asset.mock_ref.trim()
					if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
						try {
							mockRef = JSON.parse(asset.mock_ref)
						} catch (e) {
							console.warn('Failed to parse mock_ref as JSON:', e)
						}
					} else if (trimmed.startsWith('syft://') || trimmed.startsWith('http')) {
						// Plain URL string
						mockRef = { url: trimmed }
					}
					// Template strings are ignored
				}

				// For twin_list assets, extract entries
				if (dataType === 'mock' || dataType === 'both') {
					if (mockRef?.entries) {
						for (const mockEntry of mockRef.entries) {
							if (mockEntry.url) {
								mockUrls.push(mockEntry.url)
								// Keep participant_ids aligned with urls (coerce to string)
								mockParticipantIds.push(String(mockEntry.participant_id || ''))
							}
						}
					} else if (mockRef?.url) {
						// Single mock file URL from parsed ref
						mockUrls.push(mockRef.url)
						mockParticipantIds.push('')
					} else if (asset.resolved_mock_path || asset.mock_path) {
						// Fallback: use resolved_mock_path or mock_path for single-file assets
						const mockPath = asset.resolved_mock_path || asset.mock_path
						mockUrls.push(`file://${mockPath}`)
						mockParticipantIds.push('')
					}
				}

				if (dataType === 'real' || dataType === 'both') {
					if (privateRef?.entries) {
						for (const privEntry of privateRef.entries) {
							// Private entries can have url (for remote lookup) or file_path (local path)
							if (privEntry.url) {
								realUrls.push(privEntry.url)
								realParticipantIds.push(String(privEntry.participant_id || ''))
							} else if (privEntry.file_path) {
								// For local private files, construct a file:// URL or use path directly
								realUrls.push(`file://${privEntry.file_path}`)
								realParticipantIds.push(String(privEntry.participant_id || ''))
							}
						}
					} else if (privateRef?.url) {
						// Single private file URL from parsed ref
						realUrls.push(privateRef.url)
						realParticipantIds.push('')
					} else if (asset.resolved_private_path || asset.private_path) {
						// Fallback: use resolved_private_path or private_path for single-file assets
						const privatePath = asset.resolved_private_path || asset.private_path
						realUrls.push(`file://${privatePath}`)
						realParticipantIds.push('')
					}
				}
			}

			const urls =
				dataType === 'real' ? realUrls : dataType === 'mock' ? mockUrls : [...mockUrls, ...realUrls]
			const participantIds =
				dataType === 'real'
					? realParticipantIds
					: dataType === 'mock'
						? mockParticipantIds
						: [...mockParticipantIds, ...realParticipantIds]

			console.error('DEBUG: Extracted URLs:', urls)
			console.error('DEBUG: Extracted participant IDs:', participantIds)

			if (urls.length === 0) {
				if (dialog?.message) {
					await dialog.message('No files found in dataset for the selected data type', {
						title: 'No Files',
						type: 'warning',
					})
				}
				return
			}

			if (
				dataType === 'both' &&
				(mockUrls.length === 0 || realUrls.length === 0) &&
				dialog?.message
			) {
				await dialog.message(
					'Only one data side is available for this dataset. We will run the available data selection.',
					{ title: 'Partial Selection', type: 'warning' },
				)
			}

			// Set in sessionStorage for flow selection (using new URLs-based approach)
			storeDataSelection({
				urls,
				participantIds,
				mockUrls,
				mockParticipantIds,
				realUrls,
				realParticipantIds,
			})

			// Clear cached context to force fresh read
			flowState.pendingDataRun = null

			// Navigate to flows tab
			if (navigateTo) {
				navigateTo('flows')
			}

			// Wait for navigation and then show modal
			setTimeout(async () => {
				try {
					await loadFlows()
					await showDataRunModalDirect(flowId)
				} catch (err) {
					console.error('Error showing data run modal:', err)
					const errMsg = err?.message || String(err) || 'Unknown error'
					if (dialog?.message) {
						await dialog.message('Failed to show flow selection: ' + errMsg, {
							title: 'Error',
							type: 'error',
						})
					}
				}
			}, 100)
		} catch (error) {
			console.error('Error in openRunFlowWithDataset:', error)
			const errorMsg = error?.message || String(error) || 'Unknown error'
			if (dialog?.message) {
				await dialog.message('Failed to prepare flow run: ' + errorMsg, {
					title: 'Error',
					type: 'error',
				})
			}
		}
	}

	function generateFlowRunId() {
		const now = new Date()
		const pad = (value) => String(value).padStart(2, '0')
		return [
			now.getFullYear(),
			pad(now.getMonth() + 1),
			pad(now.getDate()),
			pad(now.getHours()),
			pad(now.getMinutes()),
			pad(now.getSeconds()),
		].join('')
	}

	function isMultiPartyFlow(flow) {
		if (flow?.spec?.inputs?.datasites) {
			return true
		}
		if (Array.isArray(flow?.spec?.datasites) && flow.spec.datasites.length > 1) {
			return true
		}
		return false
	}

	async function showCollaborativeRunModal(flow) {
		if (!flow) return

		const settings = await invoke('get_settings').catch(() => ({}))
		const currentEmail = settings?.email || ''
		const defaultRunId = generateFlowRunId()
		const defaultDatasites = Array.isArray(flow?.spec?.inputs?.datasites?.default)
			? flow.spec.inputs.datasites.default
			: Array.isArray(flow?.spec?.datasites)
				? flow.spec.datasites
				: []
		const datasitesPrefill = defaultDatasites.length
			? defaultDatasites.join(', ')
			: currentEmail
				? currentEmail
				: ''

		document.getElementById('syqure-collab-modal')?.remove()

		const modalHtml = `
			<div id="syqure-collab-modal" class="modal-overlay">
				<div class="modal-content request-flow-modal">
					<div class="modal-header">
						<h3>Collaborative Run</h3>
						<button class="modal-close" onclick="document.getElementById('syqure-collab-modal').remove()">
							<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
								<line x1="18" y1="6" x2="6" y2="18"></line>
								<line x1="6" y1="6" x2="18" y2="18"></line>
							</svg>
						</button>
					</div>
					<div class="modal-body">
						<p style="margin-bottom: 16px; color: var(--text-secondary);">
							Start a shared flow run across multiple datasites. Everyone uses the same Run ID.
						</p>
						<div class="form-group">
							<label>Datasites (comma-separated)</label>
							<textarea id="syqure-collab-datasites" class="form-control" rows="2" placeholder="alice@example.com, bob@example.com, carol@example.com">${escapeHtml(
								datasitesPrefill,
							)}</textarea>
						</div>
						<div class="form-group">
							<label>Run ID</label>
							<input id="syqure-collab-runid" class="form-control" value="${defaultRunId}" />
						</div>
						<div class="form-group">
							<label>Message (optional)</label>
							<textarea id="syqure-collab-message" class="form-control" rows="3" placeholder="Invite collaborators to join this run..."></textarea>
						</div>
						<div class="form-group" style="display:flex; gap:12px; align-items:center;">
							<label style="display:flex; align-items:center; gap:8px; font-size: 13px;">
								<input type="checkbox" id="syqure-collab-send" checked />
								Send flow request to collaborators
							</label>
						</div>
						<div class="form-group" style="display:flex; gap:12px; align-items:center;">
							<label style="display:flex; align-items:center; gap:8px; font-size: 13px;">
								<input type="checkbox" id="syqure-collab-start" checked />
								Start run on this device
							</label>
						</div>
					</div>
					<div class="modal-footer">
						<button class="btn btn-secondary" onclick="document.getElementById('syqure-collab-modal').remove()">Cancel</button>
						<button class="btn btn-primary" id="syqure-collab-submit">
							<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
								<line x1="22" y1="2" x2="11" y2="13"></line>
								<polygon points="22 2 15 22 11 13 2 9 22 2"></polygon>
							</svg>
							Start Collaborative Run
						</button>
					</div>
				</div>
			</div>
		`

		document.body.insertAdjacentHTML('beforeend', modalHtml)

		const submitBtn = document.getElementById('syqure-collab-submit')
		submitBtn?.addEventListener('click', async () => {
			const rawDatasites = document.getElementById('syqure-collab-datasites')?.value || ''
			const runId = document.getElementById('syqure-collab-runid')?.value.trim() || ''
			const message = document.getElementById('syqure-collab-message')?.value.trim() || ''
			const sendRequests = Boolean(document.getElementById('syqure-collab-send')?.checked)
			const startLocal = Boolean(document.getElementById('syqure-collab-start')?.checked)

			const datasites = rawDatasites
				.split(/[,\\n]/)
				.map((value) => value.trim())
				.filter(Boolean)
			if (datasites.length < 2) {
				await dialog.message('Please provide at least two datasite emails.', {
					title: 'Missing Datasites',
					type: 'warning',
				})
				return
			}
			const uniq = new Set(datasites)
			if (uniq.size !== datasites.length) {
				await dialog.message('Each datasite must be unique.', {
					title: 'Duplicate Datasites',
					type: 'warning',
				})
				return
			}
			if (!runId) {
				await dialog.message('Run ID is required.', { title: 'Missing Run ID', type: 'warning' })
				return
			}

			const flowVersion = flow.version || flow.spec?.metadata?.version || '1.0.0'
			const datasetName = `collab-${flow.name}-${runId}`
			const defaultMessage =
				`Join the collaborative run "${flow.name}" (run_id: ${runId}).` +
				`\\nDatasites: ${datasites.join(', ')}`

			try {
				submitBtn.disabled = true
				submitBtn.textContent = 'Starting…'

				if (sendRequests) {
					const recipients = datasites.filter((email) => !currentEmail || email !== currentEmail)
					for (const recipient of recipients) {
						await invoke('send_flow_request', {
							flowName: flow.name,
							flowVersion,
							datasetName,
							recipient,
							message: message || defaultMessage,
							runId,
							datasites,
						})
					}
				}

				if (startLocal) {
					const inputOverrides = {}
					if (flow?.spec?.inputs?.datasites) {
						inputOverrides['inputs.datasites'] = datasites.join(',')
					}
					await invoke('run_flow', {
						flowId: flow.id,
						inputOverrides,
						runId,
					})
				}

				document.getElementById('syqure-collab-modal')?.remove()
				if (dialog?.message) {
					await dialog.message('Collaborative run started. Check messages for invites.', {
						title: 'Syqure Run Started',
						type: 'info',
					})
				}
			} catch (error) {
				console.error('Failed to start collaborative run:', error)
				await dialog.message('Failed to start collaborative run: ' + (error?.message || error), {
					title: 'Error',
					type: 'error',
				})
			} finally {
				submitBtn.disabled = false
				submitBtn.textContent = 'Start Collaborative Run'
			}
		})
	}

	// State for flow request flow
	let pendingFlowRequest = null

	// Open modal to select a flow to request run on peer's private data
	async function openRequestFlowRun({ datasetName, datasetOwner, dataset }) {
		console.log('openRequestFlowRun:', { datasetName, datasetOwner, dataset })

		pendingFlowRequest = { datasetName, datasetOwner, dataset }

		// Ensure we're on flows tab
		if (navigateTo) {
			navigateTo('flows')
		}

		// Load flows if not already loaded
		await loadFlows()

		// Show flow selection modal for request
		showRequestFlowModal()
	}

	function showRequestFlowModal() {
		// Check if we have any flows
		if (!flowState.flows || flowState.flows.length === 0) {
			if (dialog?.message) {
				dialog.message('You need to create a flow first before you can request a run.', {
					title: 'No Flows',
					type: 'warning',
				})
			}
			return
		}

		// Create modal HTML
		const modalHtml = `
			<div id="request-flow-modal" class="modal-overlay">
				<div class="modal-content request-flow-modal">
					<div class="modal-header">
						<h3>Request Flow Run</h3>
						<button class="modal-close" onclick="document.getElementById('request-flow-modal').remove()">
							<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
								<line x1="18" y1="6" x2="6" y2="18"></line>
								<line x1="6" y1="6" x2="18" y2="18"></line>
							</svg>
						</button>
					</div>
					<div class="modal-body">
						<p style="margin-bottom: 16px; color: var(--text-secondary);">
							Select a flow to send to <strong>${escapeHtml(pendingFlowRequest?.datasetOwner || '')}</strong>
							for running on their private data in dataset <strong>${escapeHtml(pendingFlowRequest?.datasetName || '')}</strong>.
						</p>
						<div class="form-group">
							<label>Select Flow</label>
							<select id="request-flow-select" class="form-control">
								${flowState.flows.map((p) => `<option value="${escapeHtml(p.name)}">${escapeHtml(p.name)} (v${p.version || '1.0.0'})</option>`).join('')}
							</select>
						</div>
						<div class="form-group">
							<label>Message (optional)</label>
							<textarea id="request-flow-message" class="form-control" rows="3" placeholder="Add a message for the recipient..."></textarea>
						</div>
					</div>
					<div class="modal-footer">
						<button class="btn btn-secondary" onclick="document.getElementById('request-flow-modal').remove()">Cancel</button>
						<button class="btn btn-primary" id="send-flow-request-btn">
							<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
								<line x1="22" y1="2" x2="11" y2="13"></line>
								<polygon points="22 2 15 22 11 13 2 9 22 2"></polygon>
							</svg>
							Send Request
						</button>
					</div>
				</div>
			</div>
		`

		// Remove existing modal if any
		document.getElementById('request-flow-modal')?.remove()

		// Add modal to DOM
		document.body.insertAdjacentHTML('beforeend', modalHtml)

		// Wire up send button
		document
			.getElementById('send-flow-request-btn')
			?.addEventListener('click', handleSendFlowRequest)
	}

	async function handleSendFlowRequest() {
		const select = document.getElementById('request-flow-select')
		const messageInput = document.getElementById('request-flow-message')
		const flowName = select?.value
		const message = messageInput?.value || ''

		if (!flowName || !pendingFlowRequest) {
			return
		}

		const { datasetName, datasetOwner, dataset: _dataset } = pendingFlowRequest

		// Find the selected flow
		const flow = flowState.flows.find((p) => p.name === flowName)
		if (!flow) {
			if (dialog?.message) {
				await dialog.message('Flow not found', { title: 'Error', type: 'error' })
			}
			return
		}

		console.log('Sending flow request:', { flow, datasetName, datasetOwner, message })

		try {
			// Send the flow request via messaging system
			// This will package the flow and send it as a message
			const sentMessage = await invoke('send_flow_request', {
				flowName: flow.name,
				flowVersion: flow.version || '1.0.0',
				datasetName,
				recipient: datasetOwner,
				message:
					message ||
					`Please run the ${flow.name} flow on your private data in dataset ${datasetName}.`,
			})

			// Close modal
			document.getElementById('request-flow-modal')?.remove()
			pendingFlowRequest = null

			if (dialog?.message) {
				await dialog.message(
					`Flow request sent to ${datasetOwner}.\n\nThey will receive a message with the flow and can choose to run it on their private data.`,
					{ title: 'Request Sent', type: 'info' },
				)
			}

			const threadId = sentMessage?.thread_id || `flow-${flow.name}:${datasetName}`
			if (typeof window.navigateTo === 'function') {
				window.navigateTo('messages')
			}
			setTimeout(() => {
				window.__messagesModule?.loadMessageThreads?.(true)
				window.__messagesModule?.openThread?.(threadId)
			}, 250)
		} catch (error) {
			console.error('Failed to send flow request:', error)
			const errorMsg = error?.message || String(error) || 'Unknown error'
			if (dialog?.message) {
				await dialog.message('Failed to send flow request: ' + errorMsg, {
					title: 'Error',
					type: 'error',
				})
			}
		}
	}

	return {
		initialize,
		loadFlows,
		showFlowDetails,
		backToFlowsList,
		addModuleAsStep, // Expose for module creation to call
		openRunFlowWithDataset, // Expose for dataset "Run Flow" button
		openRequestFlowRun, // Expose for network "Request Run" button
	}
}
