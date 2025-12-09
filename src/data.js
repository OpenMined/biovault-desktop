export function createDataModule({ invoke, dialog, getCurrentUserEmail }) {
	const FILE_STATUS_PRIORITY = { pending: 0, processing: 1, error: 2, complete: 3 }
	let viewMode = 'participants'
	let currentUserEmail = ''

	// State
	let allParticipants = []
	let allFiles = []
	let datasets = []
	let selectedFileIds = [] // File IDs selected for workflows/operations
	let currentDataTypeFilter = 'All'
	let fileSearchTerm = ''
	let sortField = 'status'
	let sortDirection = 'asc'
	let _queueProcessorRunning = false
	let queueIntervalId = null
	let existingFilePaths = new Set()
	let filesToDisplay = [] // Filtered files currently displayed
	let queueInfoCache = new Map() // Cache queue info by file ID: { position, totalPending, isProcessorRunning, estimatedTimeRemaining }
	let globalQueueInfo = null // Global queue info: { totalPending, processingCount, isProcessorRunning, currentlyProcessing, estimatedTimeRemaining }
	let currentEditingAssets = new Map()
	let currentEditingOriginalName = null
	let currentEditingWasPublished = false
	const publishingDatasets = new Set()

	async function refreshCurrentUserEmail() {
		try {
			if (typeof getCurrentUserEmail === 'function') {
				const maybeEmail = await getCurrentUserEmail()
				if (maybeEmail) {
					currentUserEmail = maybeEmail
				}
			}
		} catch (err) {
			console.warn('Could not refresh user email', err)
		}
	}

	// ============================================================================
	// HELPERS
	// ============================================================================

	function setViewMode(mode) {
		if (!mode || (mode !== 'participants' && mode !== 'datasets')) return
		viewMode = mode
		const participantSection = document.getElementById('participant-data-section')
		const datasetSection = document.getElementById('dataset-data-section')
		const datasetEditorSection = document.getElementById('dataset-editor-section')
		if (participantSection && datasetSection) {
			participantSection.style.display = mode === 'participants' ? 'flex' : 'none'
			datasetSection.style.display = mode === 'datasets' ? 'flex' : 'none'
			// Hide editor when switching views
			if (datasetEditorSection) {
				datasetEditorSection.style.display = 'none'
			}
		}

		const toggleButtons = document.querySelectorAll('#data-view-toggle .pill-button')
		toggleButtons.forEach((btn) => {
			if (btn.dataset.view === mode) {
				btn.classList.add('active')
			} else {
				btn.classList.remove('active')
			}
		})

		const globalEmptyState = document.getElementById('data-empty-state')
		if (globalEmptyState) {
			globalEmptyState.style.display = mode === 'datasets' ? 'none' : globalEmptyState.style.display
		}

		if (mode === 'datasets') {
			void loadDatasets()
		} else {
			renderFilesPanel()
		}
	}

	function getFileSortValue(file, field) {
		switch (field) {
			case 'id':
				return file.id ?? null
			case 'status':
				return FILE_STATUS_PRIORITY[file.status] ?? Number.MAX_SAFE_INTEGER
			case 'file_path':
				return (file.file_path || '').toLowerCase()
			case 'data_type':
				return (file.data_type || '').toLowerCase()
			case 'source':
				return (file.source || '').toLowerCase()
			case 'grch_version':
				return (file.grch_version || '').toLowerCase()
			case 'row_count':
				return file.row_count ?? null
			case 'inferred_sex':
				return (file.inferred_sex || '').toLowerCase()
			case 'participant_id':
				return (file.participant_id || '').toLowerCase()
			case 'created_at':
				return file.created_at ? Date.parse(file.created_at) : null
			default:
				return (file[field] || '').toString().toLowerCase()
		}
	}

	function compareNullableNumbers(a, b) {
		const aNull = a === null || a === undefined || Number.isNaN(a)
		const bNull = b === null || b === undefined || Number.isNaN(b)
		if (aNull && bNull) return 0
		if (aNull) return 1
		if (bNull) return -1
		return a - b
	}

	function compareNullableStrings(a, b) {
		const aNull = a === null || a === undefined || a === ''
		const bNull = b === null || b === undefined || b === ''
		if (aNull && bNull) return 0
		if (aNull) return 1
		if (bNull) return -1
		return a.localeCompare(b, undefined, { sensitivity: 'base' })
	}

	function sortFiles(files) {
		files.sort((a, b) => {
			const valA = getFileSortValue(a, sortField)
			const valB = getFileSortValue(b, sortField)

			let comparison
			if (typeof valA === 'number' || typeof valB === 'number') {
				comparison = compareNullableNumbers(valA, valB)
			} else {
				comparison = compareNullableStrings(valA, valB)
			}

			if (comparison === 0) {
				comparison = compareNullableNumbers(a.id, b.id)
			}

			return sortDirection === 'asc' ? comparison : -comparison
		})
	}

	function getDefaultSortDirection(field) {
		if (field === 'created_at' || field === 'updated_at') return 'desc'
		if (field === 'row_count' || field === 'id') return 'desc'
		if (field === 'status') return 'asc'
		return 'asc'
	}

	// ============================================================================
	// FILTERING
	// ============================================================================

	function matchesFileSearch(file) {
		if (!fileSearchTerm) return true
		const term = fileSearchTerm.toLowerCase()

		// Search in file fields
		const fileValues = [
			file.id,
			file.status,
			file.file_path,
			file.data_type,
			file.source,
			file.grch_version,
			file.participant_id,
			file.inferred_sex,
		]
		const matchesFile = fileValues.some((v) => v && v.toString().toLowerCase().includes(term))

		// Also check if search term matches any participant ID (for filtering by participant)
		if (matchesFile) return true

		// Check if search term matches any participant ID exactly or partially
		const matchingParticipantIds = allParticipants
			.filter((p) => p.participant_id && p.participant_id.toLowerCase().includes(term))
			.map((p) => p.participant_id)

		if (matchingParticipantIds.length > 0 && file.participant_id) {
			return matchingParticipantIds.includes(file.participant_id)
		}

		return false
	}

	function matchesDataTypeFilter(file) {
		if (currentDataTypeFilter === 'All') return true
		return file.data_type === currentDataTypeFilter
	}

	// ============================================================================
	// RENDERING - STATUS BADGE
	// ============================================================================

	// Format time estimate in human-readable format
	function formatTimeEstimate(seconds) {
		if (!seconds || seconds <= 0) return null

		if (seconds < 60) {
			return `${Math.round(seconds)}s`
		} else if (seconds < 3600) {
			const minutes = Math.round(seconds / 60)
			return `${minutes}m`
		} else {
			const hours = Math.floor(seconds / 3600)
			const minutes = Math.round((seconds % 3600) / 60)
			if (minutes > 0) {
				return `${hours}h ${minutes}m`
			}
			return `${hours}h`
		}
	}

	function renderStatusBadge(status, error = null, fileId = null) {
		if (status === 'pending' && fileId) {
			const queueInfo = queueInfoCache.get(fileId)
			if (queueInfo) {
				const {
					position,
					totalPending,
					isProcessorRunning,
					estimatedTimeRemaining: _estimatedTimeRemaining,
				} = queueInfo
				if (position !== undefined && totalPending !== undefined) {
					const queueText =
						position > 0
							? `Queue: #${position} of ${totalPending}`
							: `Queue: ${totalPending} file${totalPending === 1 ? '' : 's'} waiting`
					const processorStatus = isProcessorRunning ? 'Processor running' : 'Processor paused'
					const title = `${queueText} • ${processorStatus}`
					return `<span class="status-badge status-pending" title="${title}">
						<img src="assets/icons/clock.svg" width="12" height="12" alt="" style="margin-right: 4px; vertical-align: middle;" />
						PENDING #${position}/${totalPending}
					</span>`
				}
			}
			// Fallback if no queue info yet
			const totalPending = globalQueueInfo?.totalPending || '?'
			return `<span class="status-badge status-pending" title="Pending in queue">
				<img src="assets/icons/clock.svg" width="12" height="12" alt="" style="margin-right: 4px; vertical-align: middle;" />
				PENDING (${totalPending} in queue)
			</span>`
		}

		const badges = {
			pending: `<span class="status-badge status-pending" title="Pending">
				<img src="assets/icons/clock.svg" width="12" height="12" alt="" style="margin-right: 4px; vertical-align: middle;" />
				PENDING
			</span>`,
			processing: `<span class="status-badge status-processing" title="Processing">
				<img src="assets/icons/loader.svg" width="12" height="12" alt="" style="margin-right: 4px; vertical-align: middle; animation: spin 1s linear infinite;" />
				PROCESSING
			</span>`,
			error: `<span class="status-badge status-error" title="${error || 'Error'}">
				<img src="assets/icons/x-circle.svg" width="12" height="12" alt="" style="margin-right: 4px; vertical-align: middle;" />
				ERROR
			</span>`,
			complete: `<span class="status-badge status-complete" title="Complete">
				<img src="assets/icons/check-circle.svg" width="12" height="12" alt="" style="margin-right: 4px; vertical-align: middle;" />
				COMPLETE
			</span>`,
			mixed: `<span class="status-badge status-mixed" title="Mixed status">
				<img src="assets/icons/alert-circle.svg" width="12" height="12" alt="" style="margin-right: 4px; vertical-align: middle;" />
				MIXED
			</span>`,
			unknown: `<span class="status-badge status-unknown" title="Unknown">
				?
			</span>`,
		}
		return badges[status] || badges.unknown
	}

	// ============================================================================
	// RENDERING - FILES TABLE
	// ============================================================================

	function renderFileRow(file) {
		const row = document.createElement('tr')
		row.className = 'file-row'
		row.dataset.fileId = file.id

		const isSelected = selectedFileIds.includes(file.id)
		if (isSelected) row.classList.add('selected')

		const statusBadge = renderStatusBadge(file.status, file.processing_error, file.id)
		const participantId = file.participant_id
		const participantDisplay = participantId
			? `<span class="participant-link" data-participant-id="${participantId}" title="Click to filter by ${participantId}">${participantId}</span>`
			: '<span style="color: #9ca3af; font-style: italic;">Unassigned</span>'

		row.innerHTML = `
			<td class="checkbox-cell">
				<input type="checkbox" class="file-checkbox" data-id="${file.id}" ${isSelected ? 'checked' : ''} />
			</td>
			<td><strong>${participantDisplay}</strong></td>
			<td>${statusBadge}</td>
			<td class="col-file" title="${file.file_path}">
				<span style="display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">
					<span style="color: #94a3b8; font-size: 12px;">${file.file_path.split('/').slice(-2, -1)[0] || ''}${
						file.file_path.split('/').slice(-2, -1)[0] ? '/' : ''
					}</span>
					<span style="font-weight: 500; color: #1e293b;">${file.file_path.split('/').pop()}</span>
				</span>
			</td>
			<td>
				<span class="type-badge type-${(file.data_type && file.data_type !== 'Unknown'
					? file.data_type
					: 'unknown'
				).toLowerCase()}">
					${file.data_type && file.data_type !== 'Unknown' ? file.data_type : '-'}
				</span>
			</td>
			<td>${file.source || '-'}</td>
			<td>${file.grch_version || '-'}</td>
			<td>${file.row_count ? file.row_count.toLocaleString() : '-'}</td>
			<td class="sex-cell" style="font-weight: ${file.inferred_sex ? '600' : 'normal'}; color: ${
				file.inferred_sex === 'Male'
					? '#007bff'
					: file.inferred_sex === 'Female'
						? '#e83e8c'
						: '#666'
			}">${
				file.inferred_sex && file.inferred_sex !== 'Unknown' && file.inferred_sex !== 'UNKNOWN'
					? file.inferred_sex
					: file.inferred_sex === 'Unknown' || file.inferred_sex === 'UNKNOWN'
						? 'Unknown'
						: '-'
			}</td>
			<td class="actions-cell">
				<button class="btn-icon open-finder-btn" data-path="${file.file_path}" title="Show in folder">
					<img src="assets/icons/folder.svg" width="16" height="16" alt="" />
				</button>
			</td>
		`

		// Open finder button
		row.querySelector('.open-finder-btn').addEventListener('click', async (e) => {
			e.stopPropagation()
			try {
				await invoke('show_in_folder', { filePath: file.file_path })
			} catch (error) {
				alert(`Error opening folder: ${error}`)
			}
		})

		// Participant link - click to search/filter by participant
		const participantLink = row.querySelector('.participant-link')
		if (participantLink) {
			participantLink.addEventListener('click', (e) => {
				e.stopPropagation()
				const pid = e.target.dataset.participantId
				if (pid) {
					// Set search term to participant ID to filter files
					const fileSearch = document.getElementById('file-search')
					if (fileSearch) {
						fileSearchTerm = pid.toLowerCase()
						fileSearch.value = pid
						renderFilesPanel()
					}
				}
			})
		}

		// Checkbox handler
		const checkbox = row.querySelector('.file-checkbox')
		checkbox.addEventListener('change', (e) => {
			const fileId = parseInt(e.target.dataset.id)
			if (e.target.checked) {
				if (!selectedFileIds.includes(fileId)) {
					selectedFileIds.push(fileId)
				}
				row.classList.add('selected')
			} else {
				selectedFileIds = selectedFileIds.filter((id) => id !== fileId)
				row.classList.remove('selected')
			}
			updateDeleteButton()
			updateSelectAllCheckbox()
			updateActionButtons()
			syncSelectionToSessionStorage()
		})

		// Make row clickable (except buttons, checkbox, and participant links)
		row.addEventListener('click', (e) => {
			if (
				e.target.tagName === 'INPUT' ||
				e.target.tagName === 'BUTTON' ||
				e.target.closest('.actions-cell') ||
				e.target.closest('.checkbox-cell') ||
				e.target.closest('.participant-link')
			) {
				return
			}
			checkbox.checked = !checkbox.checked
			checkbox.dispatchEvent(new Event('change'))
		})

		row.style.cursor = 'pointer'

		return row
	}

	function renderFilesPanel() {
		const tbody = document.getElementById('files-table-body')
		const emptyState = document.getElementById('files-empty-state')
		const tableWrapper = document.querySelector('.files-table-wrapper')

		if (!tbody) return

		tbody.innerHTML = ''

		// Get files to display - apply all filters and store at module level
		filesToDisplay = allFiles.filter(matchesDataTypeFilter).filter(matchesFileSearch)

		// Update page title (keep it simple, file count is in badge)
		const dataView = document.getElementById('data-view')
		const pageTitle =
			dataView?.querySelector('.page-titlemodern') || dataView?.querySelector('.page-title')
		if (pageTitle) {
			pageTitle.textContent = 'Data'
		}

		// Clean up file selections (remove files that don't exist anymore)
		selectedFileIds = selectedFileIds.filter((id) => allFiles.some((f) => f.id === id))

		// Sort files
		sortFiles(filesToDisplay)

		// Render files with virtual scrolling for large datasets
		if (filesToDisplay.length === 0) {
			tableWrapper.style.display = 'none'
			emptyState.style.display = 'flex'
			document.getElementById('empty-state-title').textContent = 'No files found'
			document.getElementById('empty-state-message').textContent =
				'Try adjusting your filters or search term'
		} else {
			tableWrapper.style.display = 'block'
			emptyState.style.display = 'none'

			// Render all rows without virtual scrolling so the user can scroll/select the full dataset
			filesToDisplay.forEach((file) => {
				const row = renderFileRow(file)
				tbody.appendChild(row)
			})
		}

		updateSortIndicators()
		updateSelectAllCheckbox()
		updateDeleteButton()
		updateActionButtons()
	}

	// Virtual scrolling removed; table now renders all rows so scroll height matches dataset size.

	// ============================================================================
	// UI UPDATES
	// ============================================================================

	function updateSortIndicators() {
		document.querySelectorAll('.sortable-header').forEach((header) => {
			const indicator = header.querySelector('.sort-indicator')
			if (!indicator) return

			if (header.dataset.sortField === sortField) {
				// For status, invert the indicator because priority 0 (pending) = worst (should be at bottom)
				// So ascending (0->3) means worst to best, which should show ▼
				// And descending (3->0) means best to worst, which should show ▲
				if (sortField === 'status') {
					indicator.textContent = sortDirection === 'asc' ? ' ▼' : ' ▲'
				} else {
					indicator.textContent = sortDirection === 'asc' ? ' ▲' : ' ▼'
				}
			} else {
				indicator.textContent = ''
			}
		})
	}

	function updateDeleteButton() {
		const btn = document.getElementById('delete-selected-btn')
		if (!btn) return

		if (selectedFileIds.length > 0) {
			btn.style.display = 'flex'
			// Keep the icon, just update the title
			btn.title = `Delete ${selectedFileIds.length} file${selectedFileIds.length === 1 ? '' : 's'}`
		} else {
			btn.style.display = 'none'
		}
	}

	function updateActionButtons() {
		const runBtn = document.getElementById('run-analysis-btn')
		const runText = document.getElementById('run-analysis-text')
		const _selectionCountEl = document.getElementById('selection-count')
		const selectionActionsGroup = document.getElementById('selection-actions-group')

		const fileCount = selectedFileIds.length

		if (fileCount > 0) {
			// Enable run button for any selected files
			runBtn.disabled = false
			runText.textContent = 'Run Pipeline'
			runBtn.title = `Run pipeline on ${fileCount} file${fileCount === 1 ? '' : 's'}`

			if (selectionActionsGroup) {
				const countText = document.getElementById('selection-count-text')
				if (countText) {
					countText.textContent = fileCount.toString()
				}
				selectionActionsGroup.style.display = 'flex'
			}
		} else {
			runBtn.disabled = true
			runText.textContent = 'Run Pipeline'
			runBtn.title = 'Select files to run pipeline'
			if (selectionActionsGroup) {
				selectionActionsGroup.style.display = 'none'
			}
		}
	}

	function updateSelectAllCheckbox() {
		const selectAllCheckbox = document.getElementById('select-all-data-files')
		if (!selectAllCheckbox) return

		// Use filtered files array instead of DOM query to support virtual scrolling
		const allFilteredFileIds = filesToDisplay.map((f) => f.id)

		const allSelected =
			allFilteredFileIds.length > 0 &&
			allFilteredFileIds.every((id) => selectedFileIds.includes(id))
		const someSelected = allFilteredFileIds.some((id) => selectedFileIds.includes(id))

		selectAllCheckbox.checked = allSelected
		selectAllCheckbox.indeterminate = someSelected && !allSelected
	}

	// Clear all file selections
	function clearAllSelections() {
		selectedFileIds = []

		// Remove selected class from all rows
		document.querySelectorAll('.file-row.selected').forEach((row) => {
			row.classList.remove('selected')
		})

		// Uncheck all file checkboxes
		document.querySelectorAll('.file-checkbox').forEach((checkbox) => {
			checkbox.checked = false
		})

		// Update UI
		updateSelectAllCheckbox()
		updateDeleteButton()
		updateActionButtons()
		syncSelectionToSessionStorage()
	}

	// Update queue status indicator with count and time estimate
	function updateQueueStatusIndicator(globalInfo) {
		const statusIndicator = document.getElementById('queue-status-indicator')
		const pendingCountEl = document.getElementById('pending-count')
		const timeEstimateEl = document.getElementById('queue-time-estimate-display')
		const pendingCount = globalInfo?.total_pending || 0
		const processingCount = globalInfo?.processing_count || 0
		const hasQueueItems = pendingCount > 0 || processingCount > 0
		const isProcessorRunning = globalInfo?.is_processor_running || false

		// Only show status indicator when there are files processing or pending
		if (statusIndicator && pendingCountEl) {
			if (hasQueueItems) {
				statusIndicator.style.display = 'flex'
				pendingCountEl.textContent = pendingCount

				// Only show time estimate if processor is actually running (not paused)
				if (timeEstimateEl) {
					if (isProcessorRunning) {
						const timeEstimate = globalInfo?.estimated_time_remaining_seconds
							? formatTimeEstimate(globalInfo.estimated_time_remaining_seconds)
							: null

						if (timeEstimate) {
							timeEstimateEl.textContent = `~${timeEstimate}`
							timeEstimateEl.title = `Estimated time remaining: ${timeEstimate}`
							timeEstimateEl.style.display = 'inline'
						} else {
							timeEstimateEl.style.display = 'none'
						}
					} else {
						// Processor is paused - hide time estimate since it's frozen
						timeEstimateEl.style.display = 'none'
					}
				}
			} else {
				statusIndicator.style.display = 'none'
			}
		}
	}

	async function updateQueueButton() {
		try {
			// Always fetch fresh queue info to ensure UI is in sync with backend
			const globalInfo = await invoke('get_queue_info', { fileId: null })
			globalQueueInfo = globalInfo

			const isRunning = globalInfo.is_processor_running
			_queueProcessorRunning = isRunning

			const btn = document.getElementById('process-queue-btn')
			const iconContainer = document.getElementById('queue-btn-icon-container')
			const text = document.getElementById('queue-btn-text')
			const spinnerContainer = document.getElementById('queue-spinner-container')
			const queueCard = document.getElementById('queue-card-container')

			// Use fresh data from backend, not stale DOM values
			const pendingCount = globalInfo.total_pending || 0
			const processingCount = globalInfo.processing_count || 0
			const hasQueueItems = pendingCount > 0 || processingCount > 0

			// Only show queue card when there are files processing or pending
			if (queueCard) {
				if (hasQueueItems) {
					queueCard.style.display = 'inline-flex'
				} else {
					queueCard.style.display = 'none'
				}
			}

			// Update button state
			if (btn && iconContainer && text) {
				if (isRunning) {
					iconContainer.innerHTML =
						'<img src="assets/icons/pause.svg" width="14" height="14" alt="" />'
					text.textContent = 'Pause'
					btn.className = 'queue-control-btn btn-queue-pause'
				} else {
					iconContainer.innerHTML =
						'<img src="assets/icons/play.svg" width="14" height="14" alt="" />'
					text.textContent = 'Resume'
					btn.className = 'queue-control-btn btn-queue-resume'
				}
			}

			// Update status indicator with fresh global info
			updateQueueStatusIndicator(globalInfo)

			// Show spinner only when actually processing (running AND has pending files)
			if (spinnerContainer) {
				spinnerContainer.style.display = isRunning && pendingCount > 0 ? 'inline-flex' : 'none'
			}
		} catch (error) {
			console.error('Error getting queue status:', error)
		}
	}

	// ============================================================================
	// QUEUE INFORMATION
	// ============================================================================

	async function fetchQueueInfo() {
		try {
			// Get global queue info
			const globalInfo = await invoke('get_queue_info', { fileId: null })
			globalQueueInfo = globalInfo

			// Update queue processor running status
			_queueProcessorRunning = globalInfo.is_processor_running

			// Update queue status indicator with time estimate
			updateQueueStatusIndicator(globalInfo)

			// Get queue info for all pending files
			const pendingFiles = allFiles.filter((f) => f.status === 'pending')
			if (pendingFiles.length > 0) {
				// Fetch queue position for each pending file
				const queueInfoPromises = pendingFiles.map(async (file) => {
					try {
						const info = await invoke('get_queue_info', { fileId: file.id })
						return { fileId: file.id, info }
					} catch (error) {
						console.error(`Error fetching queue info for file ${file.id}:`, error)
						return null
					}
				})

				const queueInfos = await Promise.all(queueInfoPromises)
				queueInfos.forEach((result) => {
					if (result) {
						queueInfoCache.set(result.fileId, {
							position: result.info.queue_position || 0,
							totalPending: result.info.total_pending,
							isProcessorRunning: result.info.is_processor_running,
							estimatedTimeRemaining: result.info.estimated_time_remaining_seconds,
						})
					}
				})
			}

			// Log queue information
			if (globalInfo.total_pending > 0) {
				console.log(
					`📊 Queue status: ${globalInfo.total_pending} pending, ${
						globalInfo.processing_count
					} processing, processor ${globalInfo.is_processor_running ? 'running' : 'paused'}`,
				)
				if (globalInfo.currently_processing) {
					const fileName = globalInfo.currently_processing.file_path.split('/').pop()
					console.log(`   Currently processing: ${fileName}`)
				}
			}
		} catch (error) {
			console.error('Error fetching queue info:', error)
		}
	}

	// ============================================================================
	// MAIN DATA LOADING
	// ============================================================================

	async function loadDatasets() {
		try {
			const result = await invoke('list_datasets_with_assets')
			datasets = Array.isArray(result) ? result : []
			await renderDatasets()
		} catch (error) {
			console.error('Error loading datasets:', error)
		}
	}

	function resetDatasetEditor() {
		const nameInput = document.getElementById('dataset-form-name')
		const descInput = document.getElementById('dataset-form-description')
		const authorInput = document.getElementById('dataset-form-author')
		const versionInput = document.getElementById('dataset-form-version')
		const schemaInput = document.getElementById('dataset-form-schema')
		const assetsContainer = document.getElementById('dataset-form-assets')
		if (nameInput) nameInput.value = ''
		if (descInput) descInput.value = ''
		if (authorInput) authorInput.value = currentUserEmail || ''
		if (versionInput) versionInput.value = '1.0.0'
		if (schemaInput) schemaInput.value = 'net.biovault.datasets:1.0.0'
		if (assetsContainer) assetsContainer.innerHTML = ''
		currentEditingAssets = new Map()
		currentEditingOriginalName = null
		currentEditingWasPublished = false
	}

	function addAssetRow(asset = {}) {
		const assetsContainer = document.getElementById('dataset-form-assets')
		if (!assetsContainer) return
		const row = document.createElement('div')
		row.className = 'dataset-asset-row'
		row.style.display = 'grid'
		row.style.gridTemplateColumns = '1fr 1fr 1.8fr 1.8fr 40px'
		row.style.gap = '8px'
		row.style.marginBottom = '8px'

		const privateVal = asset.resolved_private_path || asset.private_path || ''
		const mockVal = asset.resolved_mock_path || asset.mock_path || ''
		const privateId = asset.private_file_id || null
		const mockId = asset.mock_file_id || null
		row.dataset.privateId = privateId ?? ''
		row.dataset.mockId = mockId ?? ''
		row.dataset.origPrivatePath = privateVal
		row.dataset.origMockPath = mockVal

		row.innerHTML = `
			<input class="asset-key" type="text" placeholder="asset key" value="${asset.asset_key || ''}" autocapitalize="off" autocorrect="off" spellcheck="false" />
			<select class="asset-kind">
				<option value="twin" ${asset.kind === 'twin' || !asset.kind ? 'selected' : ''}>twin</option>
				<option value="file" ${asset.kind === 'file' ? 'selected' : ''}>file</option>
			</select>
			<div class="input-with-button asset-private-wrap">
				<input class="asset-private" type="text" placeholder="Private file path" value="${privateVal}" autocapitalize="off" autocorrect="off" spellcheck="false" />
				<button class="btn-icon select-private" title="Choose private file">
					<img src="assets/icons/folder-open.svg" width="14" height="14" alt="Browse" />
				</button>
			</div>
			<div class="input-with-button asset-mock-wrap">
				<input class="asset-mock" type="text" placeholder="Public/mock file path (optional)" value="${mockVal}" autocapitalize="off" autocorrect="off" spellcheck="false" />
				<button class="btn-icon select-mock" title="Choose mock/public file">
					<img src="assets/icons/folder-open.svg" width="14" height="14" alt="Browse" />
				</button>
			</div>
			<button class="btn-icon remove-asset" title="Remove">
				<img src="assets/icons/x.svg" width="14" height="14" alt="Remove" />
			</button>
		`

		row.querySelector('.remove-asset')?.addEventListener('click', () => {
			row.remove()
		})

		row.querySelector('.select-private')?.addEventListener('click', async (e) => {
			e.preventDefault()
			const path = await dialog.open({ multiple: false, directory: false })
			if (path) {
				row.querySelector('.asset-private').value = Array.isArray(path) ? path[0] : path
			}
		})

		row.querySelector('.select-mock')?.addEventListener('click', async (e) => {
			e.preventDefault()
			const path = await dialog.open({ multiple: false, directory: false })
			if (path) {
				row.querySelector('.asset-mock').value = Array.isArray(path) ? path[0] : path
			}
		})

		row.querySelector('.asset-kind')?.addEventListener('change', () => {
			updateAssetRowVisibility(row)
		})
		updateAssetRowVisibility(row)

		assetsContainer.appendChild(row)
	}

	function updateAssetRowVisibility(row) {
		const kind = row.querySelector('.asset-kind')?.value || 'twin'
		const privWrap = row.querySelector('.asset-private-wrap')
		const mockWrap = row.querySelector('.asset-mock-wrap')
		if (kind === 'twin') {
			if (privWrap) privWrap.style.display = 'flex'
			if (mockWrap) {
				mockWrap.style.display = 'flex'
				const mockInput = mockWrap.querySelector('.asset-mock')
				if (mockInput) mockInput.placeholder = 'Public/mock file path (optional)'
			}
		} else {
			if (privWrap) privWrap.style.display = 'none'
			if (mockWrap) {
				mockWrap.style.display = 'flex'
				const mockInput = mockWrap.querySelector('.asset-mock')
				if (mockInput) mockInput.placeholder = 'Public file path'
			}
		}
	}

	async function openDatasetEditor(entry = null) {
		const editor = document.getElementById('dataset-editor-section')
		const list = document.getElementById('dataset-data-section')
		if (!editor || !list) return
		await refreshCurrentUserEmail()
		setViewMode('datasets')
		resetDatasetEditor()
		list.style.display = 'none'
		editor.style.display = 'block'

		if (entry) {
			const { dataset, assets } = entry
			currentEditingAssets = new Map()
			currentEditingOriginalName = dataset.name
			assets?.forEach((a) => currentEditingAssets.set(a.asset_key, a))
			document.getElementById('dataset-editor-title').textContent = `Edit ${dataset.name}`
			document.getElementById('dataset-form-name').value = dataset.name
			document.getElementById('dataset-form-description').value = dataset.description || ''
			document.getElementById('dataset-form-author').value =
				dataset.author || currentUserEmail || ''
			document.getElementById('dataset-form-version').value = dataset.version || '1.0.0'
			document.getElementById('dataset-form-schema').value =
				dataset.schema || 'net.biovault.datasets:1.0.0'
			if (assets && assets.length > 0) {
				assets.forEach((a) => addAssetRow(a))
			} else {
				addAssetRow()
			}
			// Check if currently published
			try {
				currentEditingWasPublished = await invoke('is_dataset_published', { name: dataset.name })
			} catch {
				currentEditingWasPublished = false
			}
		} else {
			currentEditingOriginalName = null
			currentEditingWasPublished = false
			document.getElementById('dataset-editor-title').textContent = 'New Dataset'
			addAssetRow()
		}
	}

	function closeDatasetEditor() {
		const editor = document.getElementById('dataset-editor-section')
		const list = document.getElementById('dataset-data-section')
		if (editor) {
			editor.style.display = 'none'
		}
		// Only show dataset list if we're in datasets view mode
		if (list && viewMode === 'datasets') {
			list.style.display = 'flex'
		}
		resetDatasetEditor()
	}

	function collectManifestFromForm() {
		const name = document.getElementById('dataset-form-name')?.value?.trim()
		const description = document.getElementById('dataset-form-description')?.value?.trim()
		const author =
			document.getElementById('dataset-form-author')?.value?.trim() || currentUserEmail || ''
		const version = document.getElementById('dataset-form-version')?.value?.trim() || '1.0.0'
		const schema = 'net.biovault.datasets:1.0.0'

		if (!name) {
			throw new Error('Dataset name is required')
		}

		const assetsContainer = document.getElementById('dataset-form-assets')
		const assetRows = assetsContainer
			? Array.from(assetsContainer.querySelectorAll('.dataset-asset-row'))
			: []
		if (assetRows.length === 0) {
			throw new Error('Add at least one asset')
		}

		const assets = {}
		assetRows.forEach((row, idx) => {
			const key = row.querySelector('.asset-key')?.value?.trim()
			const kind = row.querySelector('.asset-kind')?.value || 'twin'
			const privatePath = row.querySelector('.asset-private')?.value?.trim()
			const mockPath = row.querySelector('.asset-mock')?.value?.trim()
			const assetFromList = currentEditingAssets.get(key)
			const privateId = row.dataset.privateId ? parseInt(row.dataset.privateId, 10) : null
			const mockId = row.dataset.mockId ? parseInt(row.dataset.mockId, 10) : null
			const origPrivatePath = row.dataset.origPrivatePath || ''
			const origMockPath = row.dataset.origMockPath || ''
			if (!key) return
			const keepPrivateId = privateId && privatePath === origPrivatePath
			const keepMockId = mockId && mockPath === origMockPath
			const assetId =
				assetFromList?.asset_uuid ||
				(crypto?.randomUUID ? crypto.randomUUID() : `asset-${idx}-${Date.now()}`)
			const isTwin = kind === 'twin'
			const manifestMock = mockPath
				? `syft://${currentUserEmail}/public/biovault/datasets/${name}/assets/${mockPath
						.split('/')
						.pop()}`
				: undefined
			assets[key] = {
				id: assetId,
				kind,
				url: isTwin
					? `{root.private_url}#assets.${key}`
					: mockPath || `{root.public_url}#assets.${key}`,
				private: isTwin ? '{url}.private' : undefined,
				mock: isTwin ? manifestMock : mockPath || undefined,
				mappings: {
					private:
						isTwin && privatePath
							? { file_path: privatePath, db_file_id: keepPrivateId ? privateId : null }
							: null,
					mock: mockPath ? { file_path: mockPath, db_file_id: keepMockId ? mockId : null } : null,
				},
				extra: undefined,
			}
		})

		const public_url = currentUserEmail
			? `syft://${currentUserEmail}/public/biovault/datasets/${name}/dataset.yaml`
			: null
		const private_url = currentUserEmail
			? `syft://${currentUserEmail}/private/biovault/datasets/${name}/dataset.yaml`
			: null

		return {
			name,
			description: description || null,
			author: author || null,
			schema,
			version,
			http_relay_servers: ['syftbox.net'],
			public_url,
			private_url,
			assets,
			extra: undefined,
		}
	}

	async function renderDatasets() {
		const tbody = document.getElementById('datasets-table-body')
		const emptyState = document.getElementById('datasets-empty-state')
		if (!tbody || !emptyState) return

		tbody.innerHTML = ''

		if (!datasets || datasets.length === 0) {
			emptyState.style.display = 'flex'
			return
		}

		emptyState.style.display = 'none'

		for (const entry of datasets) {
			const { dataset, assets } = entry
			const tr = document.createElement('tr')
			const assetCount = assets?.length ?? 0

			// Check actual published state on filesystem
			let isPublished = false
			try {
				isPublished = await invoke('is_dataset_published', { name: dataset.name })
			} catch {
				isPublished = false
			}

			const assetTags = (assets || [])
				.slice(0, 3)
				.map((a) => `<span class="chip">${a.asset_key}</span>`)
				.join(' ')
			const extraAssets = assetCount > 3 ? `+${assetCount - 3}` : ''

			tr.innerHTML = `
				<td>${dataset.name}</td>
				<td>${dataset.version}</td>
				<td>${dataset.author}</td>
				<td>${dataset.schema}</td>
				<td>${assetTags} ${extraAssets}</td>
				<td>${isPublished ? 'Yes' : 'No'}</td>
				<td class="actions-cell">
					<button class="btn-icon edit-dataset-btn" data-name="${dataset.name}" title="Edit dataset">
						<img src="assets/icons/pencil.svg" width="14" height="14" alt="Edit" />
					</button>
					<button class="btn-icon publish-toggle-btn" data-name="${dataset.name}" data-published="${isPublished}" title="${isPublished ? 'Unpublish' : 'Publish'} dataset">
						<img src="assets/icons/${isPublished ? 'x-circle' : 'upload'}.svg" width="14" height="14" alt="${isPublished ? 'Unpublish' : 'Publish'}" />
					</button>
					<button class="btn-icon open-folder-btn" data-name="${dataset.name}" data-public="${dataset.public_url || ''}" title="Open datasets folder">
						<img src="assets/icons/folder-open.svg" width="14" height="14" alt="Open" />
					</button>
					<button class="btn-icon delete-dataset-btn" data-name="${dataset.name}" title="Delete dataset">
						<img src="assets/icons/trash.svg" width="14" height="14" alt="Delete" />
					</button>
				</td>
			`

			tr.querySelector('.publish-toggle-btn')?.addEventListener('click', async (e) => {
				e.stopPropagation()
				const btn = e.currentTarget
				const name = btn?.dataset?.name
				const published = btn?.dataset?.published === 'true'

				if (publishingDatasets.has(name)) return

				if (published) {
					const confirmed = await dialog.confirm(
						`Unpublish dataset "${name}" from your datasite? Public copies will be removed.`,
						{ title: 'Unpublish Dataset', type: 'warning' },
					)
					if (!confirmed) return
					try {
						await invoke('unpublish_dataset', { name })
						await loadDatasets()
					} catch (error) {
						await dialog.message(`Error unpublishing dataset: ${error}`, {
							title: 'Unpublish Error',
							type: 'error',
						})
					}
				} else {
					const confirmed = await dialog.confirm(
						`Publish dataset "${name}" to your datasite? Public assets only are copied.`,
						{ title: 'Publish Dataset', type: 'info' },
					)
					if (!confirmed) return
					try {
						publishingDatasets.add(name)
						if (btn) btn.classList.add('loading')
						await invoke('publish_dataset', {
							manifestPath: null,
							name,
							copyMock: true,
						})
						await loadDatasets()
					} catch (error) {
						await dialog.message(`Error publishing dataset: ${error}`, {
							title: 'Publish Error',
							type: 'error',
						})
					} finally {
						publishingDatasets.delete(name)
						if (btn) btn.classList.remove('loading')
					}
				}
			})

			tr.querySelector('.delete-dataset-btn')?.addEventListener('click', async () => {
				const confirmed = await dialog.confirm(
					`Delete dataset "${dataset.name}"? This removes it from the local catalog.`,
					{ title: 'Delete Dataset', type: 'warning' },
				)
				if (!confirmed) return
				try {
					await invoke('delete_dataset', { name: dataset.name })
					await loadDatasets()
				} catch (error) {
					await dialog.message(`Error deleting dataset: ${error}`, {
						title: 'Delete Error',
						type: 'error',
					})
				}
			})

			tr.querySelector('.open-folder-btn')?.addEventListener('click', async (e) => {
				e.stopPropagation()
				const pubUrl = e.currentTarget?.dataset?.public
				try {
					let localPath
					if (pubUrl) {
						localPath = await invoke('resolve_syft_url_to_local_path', { syftUrl: pubUrl })
					} else {
						localPath = await invoke('get_datasets_folder_path')
					}
					await invoke('open_folder', { path: localPath })
				} catch (error) {
					await dialog.message(`Error opening folder: ${error}`, {
						title: 'Open Folder Error',
						type: 'error',
					})
				}
			})

			tr.querySelector('.edit-dataset-btn')?.addEventListener('click', () => {
				openDatasetEditor(entry)
			})

			tbody.appendChild(tr)
		}
	}

	async function loadData() {
		try {
			const [participants, files] = await Promise.all([
				invoke('get_participants'),
				invoke('get_files'),
			])

			allParticipants = participants
			allFiles = files
			existingFilePaths = new Set(files.map((f) => f.file_path))

			console.log('📊 Data loaded:', { participants: participants.length, files: files.length })

			// Update file count badge (total files, not filtered)
			const fileCountEl =
				document.getElementById('file-countmodern') || document.getElementById('file-count')
			if (fileCountEl) {
				const count = files.length
				fileCountEl.textContent = `${count} file${count === 1 ? '' : 's'}`
			}

			const pendingCount = files.filter((f) => f.status === 'pending').length
			const processingCount = files.filter((f) => f.status === 'processing').length
			// Update status indicator will be handled by updateQueueInfo when it refreshes

			// Queue button is always visible (to pause/resume)
			// Status indicator only shows when there are pending files

			const clearQueueBtn = document.getElementById('clear-queue-btn')
			if (clearQueueBtn) {
				// Show button if there are pending OR processing files
				clearQueueBtn.style.display = pendingCount + processingCount > 0 ? 'flex' : 'none'
			}

			// Update queue UI
			await updateQueueButton()

			// Show/hide participant UI or global empty state (datasets view manages its own empty state)
			const participantLayout = document.getElementById('participant-data-section')
			const globalEmptyState = document.getElementById('data-empty-state')

			if (participantLayout) {
				if (participants.length === 0 && files.length === 0) {
					participantLayout.style.display = 'none'
					if (viewMode === 'participants') {
						globalEmptyState.style.display = 'flex'
					}
				} else {
					participantLayout.style.display = viewMode === 'participants' ? 'flex' : 'none'
					globalEmptyState.style.display = 'none'
				}
			}

			// Clear queue info cache for files that are no longer pending
			const currentPendingIds = new Set(
				files.filter((f) => f.status === 'pending').map((f) => f.id),
			)
			for (const [fileId] of queueInfoCache.entries()) {
				if (!currentPendingIds.has(fileId)) {
					queueInfoCache.delete(fileId)
				}
			}

			renderFilesPanel()
			updateActionButtons()

			// Fetch queue information for pending files
			await fetchQueueInfo()
			// Re-render to show updated queue info
			renderFilesPanel()

			// Sync current selection state to sessionStorage
			syncSelectionToSessionStorage()
		} catch (error) {
			console.error('Error loading data:', error)
		}
	}

	// ============================================================================
	// INITIALIZATION
	// ============================================================================

	function initializeDataTab() {
		void refreshCurrentUserEmail()
		setViewMode(viewMode)
		// View toggle (Participants vs Datasets)
		const toggleButtons = document.querySelectorAll('#data-view-toggle .pill-button')
		toggleButtons.forEach((btn) => {
			btn.addEventListener('click', () => {
				setViewMode(btn.dataset.view)
				closeDatasetEditor()
			})
		})
		const refreshDatasetsBtn = document.getElementById('refresh-datasets-btn')
		if (refreshDatasetsBtn) {
			refreshDatasetsBtn.addEventListener('click', () => loadDatasets())
		}
		const newDatasetBtn = document.getElementById('new-dataset-btn')
		if (newDatasetBtn) {
			newDatasetBtn.addEventListener('click', () => openDatasetEditor(null))
		}

		const addAssetButton = document.getElementById('dataset-form-add-asset')
		if (addAssetButton) {
			addAssetButton.addEventListener('click', () => addAssetRow())
		}

		const saveDatasetButton = document.getElementById('dataset-editor-save')
		if (saveDatasetButton) {
			saveDatasetButton.addEventListener('click', async () => {
				try {
					const manifest = collectManifestFromForm()
					const originalName = currentEditingOriginalName
					const wasPublished = currentEditingWasPublished
					await invoke('save_dataset_with_files', {
						manifest,
						originalName: originalName || null,
					})
					// Auto-republish if it was published before editing
					if (wasPublished) {
						try {
							await invoke('publish_dataset', {
								manifestPath: null,
								name: manifest.name,
								copyMock: true,
							})
						} catch (pubErr) {
							console.warn('Auto-republish failed:', pubErr)
						}
					}
					await loadDatasets()
					closeDatasetEditor()
				} catch (error) {
					await dialog.message(`${error}`, { title: 'Dataset Error', type: 'error' })
				}
			})
		}

		const cancelDatasetButton = document.getElementById('dataset-editor-cancel')
		if (cancelDatasetButton) {
			cancelDatasetButton.addEventListener('click', () => {
				closeDatasetEditor()
			})
		}

		// File search (searches both files and participants)
		const fileSearch = document.getElementById('file-search')
		if (fileSearch) {
			fileSearch.addEventListener('input', (e) => {
				fileSearchTerm = e.target.value.trim().toLowerCase()
				renderFilesPanel()
			})
		}

		// Data type filter removed - showing all types
		currentDataTypeFilter = 'All'

		// Sortable headers
		document.querySelectorAll('.sortable-header').forEach((header) => {
			header.addEventListener('click', () => {
				const field = header.dataset.sortField
				if (!field) return

				if (sortField === field) {
					sortDirection = sortDirection === 'asc' ? 'desc' : 'asc'
				} else {
					sortField = field
					sortDirection = getDefaultSortDirection(field)
				}

				renderFilesPanel()
			})
		})

		// Select all files checkbox
		const selectAllFiles = document.getElementById('select-all-data-files')
		if (selectAllFiles) {
			selectAllFiles.addEventListener('change', (e) => {
				// Use filtered files array instead of DOM query to support virtual scrolling
				const allFilteredFileIds = filesToDisplay.map((f) => f.id)

				if (e.target.checked) {
					// Select all filtered files
					allFilteredFileIds.forEach((id) => {
						if (!selectedFileIds.includes(id)) {
							selectedFileIds.push(id)
						}
					})
				} else {
					// Deselect all filtered files
					selectedFileIds = selectedFileIds.filter((id) => !allFilteredFileIds.includes(id))
				}

				renderFilesPanel()
				syncSelectionToSessionStorage()
			})
		}

		// Delete selected files button
		const deleteBtn = document.getElementById('delete-selected-btn')
		if (deleteBtn) {
			deleteBtn.addEventListener('click', async () => {
				if (selectedFileIds.length === 0) return

				const confirmed = await dialog.confirm(
					`Are you sure you want to delete ${selectedFileIds.length} file(s)?`,
					{ title: 'Delete Files', type: 'warning' },
				)

				if (confirmed) {
					try {
						await invoke('delete_files_bulk', { fileIds: selectedFileIds })
						selectedFileIds = []
						syncSelectionToSessionStorage()
						await loadData()
					} catch (error) {
						await dialog.message(`Error deleting files: ${error}`, {
							title: 'Error',
							type: 'error',
						})
					}
				}
			})
		}

		// Run Analysis button
		const runAnalysisBtn = document.getElementById('run-analysis-btn')
		if (runAnalysisBtn) {
			runAnalysisBtn.addEventListener('click', async () => {
				if (selectedFileIds.length > 0) {
					// Get unique participant IDs from selected files
					const participantIds = [
						...new Set(
							selectedFileIds
								.map((fileId) => {
									const file = allFiles.find((f) => f.id === fileId)
									if (!file) return null
									const participant = allParticipants.find(
										(p) => p.participant_id === file.participant_id,
									)
									return participant ? participant.id : null
								})
								.filter(Boolean),
						),
					]

					// Store selected participant IDs and file IDs
					sessionStorage.setItem('preselectedParticipants', JSON.stringify(participantIds))
					sessionStorage.setItem('preselectedFileIds', JSON.stringify(selectedFileIds))

					// Trigger pipeline run modal via global pipeline module
					if (
						window.pipelineModule &&
						typeof window.pipelineModule.showDataRunModal === 'function'
					) {
						await window.pipelineModule.showDataRunModal()
					} else {
						// Fallback: navigate if module not available
						const navigateTo =
							window.navigateTo || ((_view) => console.warn('navigateTo not available'))
						navigateTo('run')
					}
				}
			})
		}

		// Queue processor button
		const processQueueBtn = document.getElementById('process-queue-btn')
		if (processQueueBtn) {
			processQueueBtn.addEventListener('click', async () => {
				try {
					const isRunning = await invoke('get_queue_processor_status')

					if (isRunning) {
						await invoke('pause_queue_processor')
					} else {
						await invoke('resume_queue_processor')
					}

					// Immediately refresh queue info to get accurate state
					await fetchQueueInfo()
					await updateQueueButton()
					await loadData()
				} catch (error) {
					alert(`Error toggling queue processor: ${error}`)
				}
			})
		}

		// Clear queue button
		const clearQueueBtn = document.getElementById('clear-queue-btn')
		if (clearQueueBtn) {
			clearQueueBtn.addEventListener('click', async () => {
				// Get queue info to include both pending and processing files
				const queueInfo = await invoke('get_queue_info', { fileId: null })
				const totalQueueCount = queueInfo.total_pending + queueInfo.processing_count

				if (totalQueueCount === 0) {
					return
				}

				const processingText =
					queueInfo.processing_count > 0
						? ` (including ${queueInfo.processing_count} currently being processed)`
						: ''

				const confirmed = await dialog.confirm(
					`Are you sure you want to clear the queue? This will remove ${totalQueueCount} file${
						totalQueueCount === 1 ? '' : 's'
					}${processingText} from the queue. This will stop any ongoing imports. This action cannot be undone.`,
					{ title: 'Clear Queue', type: 'warning' },
				)

				if (confirmed) {
					try {
						const deleted = await invoke('clear_pending_queue')
						await dialog.message(
							`Cleared ${deleted} file${deleted === 1 ? '' : 's'} from the queue.`,
							{ title: 'Queue Cleared', type: 'info' },
						)
						await loadData()
					} catch (error) {
						await dialog.message(`Error clearing queue: ${error}`, {
							title: 'Error',
							type: 'error',
						})
					}
				}
			})
		}

		// Queue processor interval
		if (!queueIntervalId) {
			queueIntervalId = setInterval(async () => {
				const isDataTabActive = document.getElementById('data-view')?.classList.contains('active')
				if (!isDataTabActive) return

				// Always fetch fresh queue info from backend
				await fetchQueueInfo()

				// Update button and UI based on fresh state
				await updateQueueButton()

				// Get fresh state from backend
				const pendingCount = globalQueueInfo?.total_pending || 0
				const processingCount = globalQueueInfo?.processing_count || 0
				const hasQueueItems = pendingCount > 0 || processingCount > 0
				const isRunning = globalQueueInfo?.is_processor_running || false

				if (hasQueueItems) {
					// Update file list to reflect status changes
					renderFilesPanel()

					// Only do full data reload if processor is running (to catch completions)
					// When paused, we still update UI but don't need aggressive reloads
					if (isRunning) {
						await loadData()
					}
				} else {
					// No queue items - hide queue card and refresh data
					await loadData()
				}
			}, 2000) // Update every 2 seconds when data tab is active
		}

		void updateQueueButton()
	}

	function refreshExistingFilePaths() {
		existingFilePaths = new Set(allFiles.map((f) => f.file_path))
	}

	function syncSelectionToSessionStorage() {
		if (selectedFileIds.length > 0) {
			// Get unique participant IDs from selected files
			const participantIds = [
				...new Set(
					selectedFileIds
						.map((fileId) => {
							const file = allFiles.find((f) => f.id === fileId)
							if (!file) return null
							const participant = allParticipants.find(
								(p) => p.participant_id === file.participant_id,
							)
							return participant ? participant.id : null
						})
						.filter(Boolean),
				),
			]

			// Sync to sessionStorage so pipelines view can detect it
			sessionStorage.setItem('preselectedFileIds', JSON.stringify(selectedFileIds))
			sessionStorage.setItem('preselectedParticipants', JSON.stringify(participantIds))
		} else {
			// Clear if nothing selected
			sessionStorage.removeItem('preselectedFileIds')
			sessionStorage.removeItem('preselectedParticipants')
		}
	}

	return {
		loadData,
		renderDataTable: renderFilesPanel, // Alias for compatibility
		initializeDataTab,
		refreshExistingFilePaths,
		isFileAlreadyImported: (filePath) => existingFilePaths.has(filePath),
		getExistingFilePaths: () => new Set(existingFilePaths),
		getSelectedFileIds: () => [...selectedFileIds],
		getSelectedParticipants: () => {
			// Get unique participant IDs from selected files
			const participantIds = new Set()
			selectedFileIds.forEach((fileId) => {
				const file = allFiles.find((f) => f.id === fileId)
				if (file && file.participant_id) {
					participantIds.add(file.participant_id)
				}
			})
			return Array.from(participantIds)
				.map((pid) => allParticipants.find((p) => p.participant_id === pid))
				.filter(Boolean)
		},
		syncSelectionToSessionStorage,
		clearAllSelections,
	}
}
