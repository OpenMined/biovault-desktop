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

		// Update page subtitle based on view
		const pageSubtitle = document.querySelector('#data-view .page-subtitle')
		if (pageSubtitle) {
			if (mode === 'datasets') {
				pageSubtitle.textContent =
					'Package files as datasets and publish to share with collaborators'
			} else {
				pageSubtitle.textContent = 'Imported genotype files and analysis results'
			}
		}

		// Update search placeholder based on view
		const searchInput = document.getElementById('file-search')
		if (searchInput) {
			searchInput.placeholder = mode === 'datasets' ? 'Search datasets...' : 'Search files...'
		}

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
		// Update title for accessibility - visibility is handled by the toolbar
		btn.title = `Delete ${selectedFileIds.length} file${selectedFileIds.length === 1 ? '' : 's'}`
	}

	function updateActionButtons() {
		const runText = document.getElementById('run-analysis-text')
		const selectionActionsGroup = document.getElementById('selection-actions-group')

		const fileCount = selectedFileIds.length

		if (fileCount > 0 && viewMode === 'participants') {
			if (runText) runText.textContent = `Run Pipeline`

			if (selectionActionsGroup) {
				const countText = document.getElementById('selection-count-text')
				if (countText) {
					countText.textContent = fileCount.toString()
				}
				selectionActionsGroup.style.display = 'flex'
			}
		} else {
			if (runText) runText.textContent = 'Run Pipeline'
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
		const _statusIndicator = document.getElementById('queue-status-indicator')
		const pendingCountEl = document.getElementById('pending-count')
		const timeEstimateEl = document.getElementById('queue-time-estimate-display')
		const pendingCount = globalInfo?.total_pending || 0
		const processingCount = globalInfo?.processing_count || 0
		const hasQueueItems = pendingCount > 0 || processingCount > 0
		const isProcessorRunning = globalInfo?.is_processor_running || false

		// Update pending count
		if (pendingCountEl) {
			pendingCountEl.textContent = pendingCount
		}

		// Only show time estimate if processor is actually running (not paused)
		if (timeEstimateEl) {
			if (isProcessorRunning && hasQueueItems) {
				const timeEstimate = globalInfo?.estimated_time_remaining_seconds
					? formatTimeEstimate(globalInfo.estimated_time_remaining_seconds)
					: null

				if (timeEstimate) {
					timeEstimateEl.textContent = `• ~${timeEstimate}`
					timeEstimateEl.title = `Estimated time remaining: ${timeEstimate}`
					timeEstimateEl.style.display = 'inline'
				} else {
					timeEstimateEl.style.display = 'none'
				}
			} else {
				// Processor is paused or queue is empty - hide time estimate
				timeEstimateEl.style.display = 'none'
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
			const clearQueueBtn = document.getElementById('clear-queue-btn')

			// Use fresh data from backend, not stale DOM values
			const pendingCount = globalInfo.total_pending || 0
			const processingCount = globalInfo.processing_count || 0
			const hasQueueItems = pendingCount > 0 || processingCount > 0

			// Only show queue bar when there are files processing or pending
			if (queueCard) {
				if (hasQueueItems) {
					queueCard.style.display = 'flex'
				} else {
					queueCard.style.display = 'none'
				}
			}

			// Show/hide clear button based on queue state
			if (clearQueueBtn) {
				clearQueueBtn.style.display = hasQueueItems ? 'inline-flex' : 'none'
			}

			// Update button state
			if (btn && iconContainer && text) {
				if (isRunning) {
					iconContainer.innerHTML =
						'<img src="assets/icons/pause.svg" width="14" height="14" alt="" />'
					text.textContent = 'Pause'
					btn.className = 'queue-bar-toggle btn-queue-pause'
				} else {
					iconContainer.innerHTML =
						'<img src="assets/icons/play.svg" width="14" height="14" alt="" />'
					text.textContent = 'Resume'
					btn.className = 'queue-bar-toggle btn-queue-resume'
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
		updateEditorPreview()
	}

	function addAssetRow(asset = {}) {
		const assetsContainer = document.getElementById('dataset-form-assets')
		if (!assetsContainer) return

		const row = document.createElement('div')
		row.className = 'asset-row-modern'

		const privateVal = asset.resolved_private_path || asset.private_path || ''
		const mockVal = asset.resolved_mock_path || asset.mock_path || ''
		const privateId = asset.private_file_id || null
		const mockId = asset.mock_file_id || null
		row.dataset.privateId = privateId ?? ''
		row.dataset.mockId = mockId ?? ''
		row.dataset.origPrivatePath = privateVal
		row.dataset.origMockPath = mockVal
		row.dataset.kind = asset.kind || 'twin'

		// Generate a default key from filename or index
		const assetCount = assetsContainer.querySelectorAll('.asset-row-modern').length
		const defaultKey = asset.asset_key || `file_${assetCount + 1}`

		// Get just the filename for display
		const _privateFileName = privateVal ? privateVal.split('/').pop() : ''
		const _mockFileName = mockVal ? mockVal.split('/').pop() : ''

		row.innerHTML = `
			<div class="asset-row-header">
				<div class="asset-row-title">
					<input class="asset-key" type="text" placeholder="asset_name" value="${defaultKey}" autocapitalize="off" autocorrect="off" spellcheck="false" />
					<span class="asset-row-badge">Twin</span>
				</div>
				<button class="btn-remove-asset" title="Remove this file">
					<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
						<line x1="18" y1="6" x2="6" y2="18"></line>
						<line x1="6" y1="6" x2="18" y2="18"></line>
					</svg>
				</button>
			</div>
			<div class="asset-row-files">
				<div class="asset-file-input">
					<label class="private-label">
						<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
							<rect x="3" y="11" width="18" height="11" rx="2" ry="2"></rect>
							<path d="M7 11V7a5 5 0 0 1 10 0v4"></path>
						</svg>
						Private (Real Data)
					</label>
					<div class="file-input-group">
						<input class="asset-private" type="text" placeholder="Select your private file..." value="${privateVal}" title="${privateVal}" autocapitalize="off" autocorrect="off" spellcheck="false" />
						<button class="btn-browse select-private" title="Browse for private file">
							<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
								<path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path>
							</svg>
						</button>
					</div>
				</div>
				<div class="asset-file-input">
					<label class="mock-label">
						<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
							<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path>
							<polyline points="14 2 14 8 20 8"></polyline>
						</svg>
						Mock (Sample) - Optional
					</label>
					<div class="file-input-group">
						<input class="asset-mock" type="text" placeholder="Select sample/mock file..." value="${mockVal}" title="${mockVal}" autocapitalize="off" autocorrect="off" spellcheck="false" />
						<button class="btn-browse select-mock" title="Browse for mock file">
							<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
								<path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path>
							</svg>
						</button>
					</div>
				</div>
			</div>
		`

		// Remove button
		row.querySelector('.btn-remove-asset')?.addEventListener('click', () => {
			row.remove()
			updateEditorPreview()
		})

		// Browse for private file
		row.querySelector('.select-private')?.addEventListener('click', async (e) => {
			e.preventDefault()
			const path = await dialog.open({ multiple: false, directory: false })
			if (path) {
				const pathStr = Array.isArray(path) ? path[0] : path
				const privateInput = row.querySelector('.asset-private')
				privateInput.value = pathStr
				privateInput.title = pathStr

				// Auto-fill asset key from filename if empty or default
				const keyInput = row.querySelector('.asset-key')
				if (keyInput && (!keyInput.value || keyInput.value.startsWith('file_'))) {
					const fileName = pathStr.split('/').pop()
					const cleanName = fileName
						.replace(/\.[^.]+$/, '')
						.toLowerCase()
						.replace(/[^a-z0-9_]/g, '_')
					keyInput.value = cleanName
				}
				updateEditorPreview()
			}
		})

		// Browse for mock file
		row.querySelector('.select-mock')?.addEventListener('click', async (e) => {
			e.preventDefault()
			const path = await dialog.open({ multiple: false, directory: false })
			if (path) {
				const pathStr = Array.isArray(path) ? path[0] : path
				const mockInput = row.querySelector('.asset-mock')
				mockInput.value = pathStr
				mockInput.title = pathStr
				updateEditorPreview()
			}
		})

		// Update preview on key change
		row.querySelector('.asset-key')?.addEventListener('input', () => {
			updateEditorPreview()
		})

		assetsContainer.appendChild(row)
		updateEditorPreview()
	}

	function updateEditorPreview() {
		const nameInput = document.getElementById('dataset-form-name')
		const descInput = document.getElementById('dataset-form-description')
		const versionInput = document.getElementById('dataset-form-version')
		const assetsContainer = document.getElementById('dataset-form-assets')

		const previewName = document.getElementById('preview-name')
		const previewMeta = document.getElementById('preview-meta')
		const previewDesc = document.getElementById('preview-desc')

		if (previewName) {
			previewName.textContent = nameInput?.value?.trim() || 'your_dataset'
		}

		const assetCount = assetsContainer?.querySelectorAll('.asset-row-modern').length || 0
		if (previewMeta) {
			previewMeta.textContent = `v${versionInput?.value || '1.0.0'} • ${assetCount} file${
				assetCount !== 1 ? 's' : ''
			}`
		}

		if (previewDesc) {
			const desc = descInput?.value?.trim()
			previewDesc.textContent = desc || 'No description'
			previewDesc.style.fontStyle = desc ? 'normal' : 'italic'
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
		editor.style.display = 'flex'

		// Set up preview update listeners
		const nameInput = document.getElementById('dataset-form-name')
		const descInput = document.getElementById('dataset-form-description')
		const versionInput = document.getElementById('dataset-form-version')
		const authorInput = document.getElementById('dataset-form-author')

		nameInput?.addEventListener('input', updateEditorPreview)
		descInput?.addEventListener('input', updateEditorPreview)
		versionInput?.addEventListener('input', updateEditorPreview)

		// Set author (hidden but used)
		if (authorInput) {
			authorInput.value = currentUserEmail || ''
		}

		if (entry) {
			const { dataset, assets } = entry
			currentEditingAssets = new Map()
			currentEditingOriginalName = dataset.name
			assets?.forEach((a) => currentEditingAssets.set(a.asset_key, a))
			document.getElementById('dataset-editor-title').textContent = `Edit Dataset`
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
			document.getElementById('dataset-editor-title').textContent = 'Create New Dataset'
			// Don't add empty row - let user click "Add File"
		}

		updateEditorPreview()
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

		// Validate name format
		if (!/^[a-z0-9_]+$/.test(name)) {
			throw new Error('Dataset name must contain only lowercase letters, numbers, and underscores')
		}

		const assetsContainer = document.getElementById('dataset-form-assets')
		const assetRows = assetsContainer
			? Array.from(assetsContainer.querySelectorAll('.asset-row-modern'))
			: []
		if (assetRows.length === 0) {
			throw new Error('Add at least one file to the dataset')
		}

		const assets = {}
		assetRows.forEach((row, idx) => {
			const key = row.querySelector('.asset-key')?.value?.trim()
			const kind = row.dataset.kind || 'twin'
			const privatePath = row.querySelector('.asset-private')?.value?.trim()
			const mockPath = row.querySelector('.asset-mock')?.value?.trim()
			const assetFromList = currentEditingAssets.get(key)
			const privateId = row.dataset.privateId ? parseInt(row.dataset.privateId, 10) : null
			const mockId = row.dataset.mockId ? parseInt(row.dataset.mockId, 10) : null
			const origPrivatePath = row.dataset.origPrivatePath || ''
			const origMockPath = row.dataset.origMockPath || ''
			if (!key) return

			// Validate key format
			if (!/^[a-z0-9_]+$/.test(key)) {
				throw new Error(
					`Asset name "${key}" must contain only lowercase letters, numbers, and underscores`,
				)
			}

			// Require at least private path for twin assets
			if (kind === 'twin' && !privatePath) {
				throw new Error(`Asset "${key}" needs a private file path`)
			}

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
		const grid = document.getElementById('datasets-grid')
		const emptyState = document.getElementById('datasets-empty-state')
		if (!grid || !emptyState) return

		grid.innerHTML = ''

		if (!datasets || datasets.length === 0) {
			emptyState.style.display = 'flex'
			return
		}

		emptyState.style.display = 'none'

		// Fetch session counts for all datasets
		let sessionCounts = {}
		try {
			const sessions = await invoke('list_sessions')
			if (Array.isArray(sessions)) {
				sessions.forEach((s) => {
					if (s.dataset_name) {
						sessionCounts[s.dataset_name] = (sessionCounts[s.dataset_name] || 0) + 1
					}
				})
			}
		} catch {
			// Ignore session count errors
		}

		for (const entry of datasets) {
			const { dataset, assets } = entry
			const assetCount = assets?.length ?? 0

			// Check actual published state on filesystem
			let isPublished = false
			try {
				isPublished = await invoke('is_dataset_published', { name: dataset.name })
			} catch {
				isPublished = false
			}

			// Check if assets have mock data (needed for network preview)
			const hasMockData = (assets || []).some((a) => a.mock_ref || a.mock_path || a.mock_file_id)

			const sessionCount = sessionCounts[dataset.name] || 0

			// Build asset chips
			const maxVisibleAssets = 3
			const visibleAssets = (assets || []).slice(0, maxVisibleAssets)
			const remainingAssets = assetCount - maxVisibleAssets

			const assetChipsHtml = visibleAssets
				.map(
					(a) => `
					<span class="dataset-asset-chip">
						<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
							<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path>
						</svg>
						${a.asset_key}
					</span>
				`,
				)
				.join('')
			const moreChipHtml =
				remainingAssets > 0
					? `<span class="dataset-asset-chip dataset-asset-more">+${remainingAssets} more</span>`
					: ''

			const card = document.createElement('div')
			card.className = 'dataset-card'
			card.dataset.name = dataset.name

			// Build visibility tooltip
			const visibilityTooltip = isPublished
				? hasMockData
					? 'Visible on network with preview data'
					: 'Visible on network (no preview data)'
				: 'Not visible on network. Click Publish to make discoverable.'

			card.innerHTML = `
				<div class="dataset-card-header">
					<div class="dataset-card-info">
						<h4 class="dataset-card-name">
							<svg class="dataset-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
								<path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"></path>
							</svg>
							${dataset.name}
						</h4>
						<div class="dataset-card-meta">
							<span>v${dataset.version || '1.0.0'}</span>
							<span>•</span>
							<span>${dataset.author || 'Unknown'}</span>
							<span>•</span>
							<span>${assetCount} asset${assetCount !== 1 ? 's' : ''}</span>
						</div>
					</div>
					<div class="dataset-card-status" title="${visibilityTooltip}">
						<span class="dataset-status-badge ${isPublished ? 'published' : 'draft'}">
							${isPublished ? 'Published' : 'Draft'}
						</span>
						${
							isPublished && hasMockData
								? '<span class="dataset-mock-badge" title="Has preview data">Preview</span>'
								: ''
						}
					</div>
				</div>
				<div class="dataset-card-body">
					${dataset.description ? `<p class="dataset-card-description">${dataset.description}</p>` : ''}
					<div class="dataset-card-assets">
						${assetChipsHtml}
						${moreChipHtml}
					</div>
				</div>
				<div class="dataset-card-footer">
					<div class="dataset-card-sessions">
						<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
							<path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"></path>
							<circle cx="9" cy="7" r="4"></circle>
							<path d="M23 21v-2a4 4 0 0 0-3-3.87"></path>
							<path d="M16 3.13a4 4 0 0 1 0 7.75"></path>
						</svg>
						${sessionCount > 0 ? `${sessionCount} session${sessionCount !== 1 ? 's' : ''}` : 'No sessions'}
					</div>
					<div class="dataset-card-actions">
						<button class="dataset-action-btn btn-start-session" data-name="${
							dataset.name
						}" title="Start new session with this dataset">
							<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
								<polygon points="5 3 19 12 5 21 5 3"></polygon>
							</svg>
						</button>
						<button class="dataset-action-btn ${isPublished ? 'btn-unpublish' : 'btn-publish'}" data-name="${
							dataset.name
						}" data-published="${isPublished}" title="${
							isPublished ? 'Unpublish from datasite' : 'Publish to datasite'
						}">
							<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
								${
									isPublished
										? '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="7 10 12 15 17 10"></polyline><line x1="12" y1="15" x2="12" y2="3"></line>'
										: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="17 8 12 3 7 8"></polyline><line x1="12" y1="3" x2="12" y2="15"></line>'
								}
							</svg>
						</button>
						<button class="dataset-action-btn btn-edit" data-name="${dataset.name}" title="Edit dataset">
							<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
								<path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path>
								<path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path>
							</svg>
						</button>
						<button class="dataset-action-btn btn-folder" data-name="${dataset.name}" data-public="${
							dataset.public_url || ''
						}" title="Open folder">
							<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
								<path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path>
							</svg>
						</button>
						<button class="dataset-action-btn btn-delete" data-name="${dataset.name}" title="Delete dataset">
							<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
								<polyline points="3 6 5 6 21 6"></polyline>
								<path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
							</svg>
						</button>
					</div>
				</div>
			`

			// Start Session button
			card.querySelector('.btn-start-session')?.addEventListener('click', async (e) => {
				e.stopPropagation()
				// Navigate to sessions and pre-fill with this dataset
				if (window.__sessionsModule?.openCreateSessionWithDataset) {
					window.__sessionsModule.openCreateSessionWithDataset({
						name: dataset.name,
						owner: dataset.author || currentUserEmail,
						public_url: dataset.public_url,
					})
				}
				// Navigate to sessions tab
				if (window.navigateTo) {
					window.navigateTo('sessions')
				}
			})

			// Publish/Unpublish button
			card.querySelector('.btn-publish, .btn-unpublish')?.addEventListener('click', async (e) => {
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
						`Publish dataset "${name}" to your datasite? Public mock files will be copied.`,
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

			// Edit button
			card.querySelector('.btn-edit')?.addEventListener('click', (e) => {
				e.stopPropagation()
				openDatasetEditor(entry)
			})

			// Folder button
			card.querySelector('.btn-folder')?.addEventListener('click', async (e) => {
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

			// Delete button
			card.querySelector('.btn-delete')?.addEventListener('click', async (e) => {
				e.stopPropagation()
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

			// Make card clickable to edit
			card.addEventListener('click', () => {
				openDatasetEditor(entry)
			})
			card.style.cursor = 'pointer'

			grid.appendChild(card)
		}
	}

	// Create dataset from selected files
	async function createDatasetFromSelection() {
		if (selectedFileIds.length === 0) {
			await dialog.message('Please select at least one file to create a dataset from.', {
				title: 'No Files Selected',
				type: 'info',
			})
			return
		}

		// Gather selected files
		const selectedFiles = allFiles.filter((f) => selectedFileIds.includes(f.id))

		// Switch to datasets view and open editor
		await refreshCurrentUserEmail()

		const editor = document.getElementById('dataset-editor-section')
		const list = document.getElementById('dataset-data-section')
		const participantSection = document.getElementById('participant-data-section')

		if (editor && list && participantSection) {
			participantSection.style.display = 'none'
			list.style.display = 'none'
			editor.style.display = 'flex'
		}

		// Update toggle to show datasets as active
		const toggleButtons = document.querySelectorAll('#data-view-toggle .pill-button')
		toggleButtons.forEach((btn) => {
			btn.classList.toggle('active', btn.dataset.view === 'datasets')
		})
		viewMode = 'datasets'

		resetDatasetEditor()

		document.getElementById('dataset-editor-title').textContent = 'Create Dataset from Selection'
		document.querySelector('.dataset-editor-subtitle').textContent = `Packaging ${
			selectedFiles.length
		} selected file${selectedFiles.length !== 1 ? 's' : ''} into a shareable dataset`

		// Pre-fill author
		const authorInput = document.getElementById('dataset-form-author')
		if (authorInput) {
			authorInput.value = currentUserEmail || ''
		}

		// Auto-generate name suggestion from file types or participant
		const fileTypes = [...new Set(selectedFiles.map((f) => f.data_type).filter(Boolean))]
		const participants = [...new Set(selectedFiles.map((f) => f.participant_id).filter(Boolean))]

		let suggestedName = 'my_dataset'
		if (participants.length === 1) {
			suggestedName = participants[0].toLowerCase().replace(/[^a-z0-9_]/g, '_')
		} else if (fileTypes.length > 0) {
			suggestedName = fileTypes
				.join('_')
				.toLowerCase()
				.replace(/[^a-z0-9_]/g, '')
		}

		const nameInput = document.getElementById('dataset-form-name')
		if (nameInput) {
			nameInput.value = suggestedName
		}

		// Add description
		const descInput = document.getElementById('dataset-form-description')
		if (descInput) {
			const fileTypesList = fileTypes.length > 0 ? ` (${fileTypes.join(', ')})` : ''
			descInput.value = `Dataset containing ${selectedFiles.length} file${
				selectedFiles.length !== 1 ? 's' : ''
			}${fileTypesList}`
		}

		// Create asset rows for each selected file
		const assetsContainer = document.getElementById('dataset-form-assets')
		if (assetsContainer) {
			assetsContainer.innerHTML = ''
		}

		selectedFiles.forEach((file, idx) => {
			const fileName = file.file_path.split('/').pop()
			const assetKey = fileName
				.replace(/\.[^.]+$/, '')
				.toLowerCase()
				.replace(/[^a-z0-9_]/g, '_')
			addAssetRow({
				asset_key: assetKey || `file_${idx + 1}`,
				kind: 'twin',
				private_path: file.file_path,
				resolved_private_path: file.file_path,
				private_file_id: file.id,
			})
		})

		// Set up preview listeners
		nameInput?.addEventListener('input', updateEditorPreview)
		descInput?.addEventListener('input', updateEditorPreview)
		document.getElementById('dataset-form-version')?.addEventListener('input', updateEditorPreview)

		updateEditorPreview()
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

			const _pendingCount = files.filter((f) => f.status === 'pending').length
			const _processingCount = files.filter((f) => f.status === 'processing').length
			// Update status indicator will be handled by updateQueueInfo when it refreshes
			// Queue bar visibility is handled by updateQueueButton

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

	function setupDatasetInfoDismiss() {
		const dismissBtn = document.getElementById('dismiss-dataset-info')
		if (!dismissBtn) return

		const infoBox = dismissBtn.closest('.dataset-visibility-info')
		if (!infoBox) return

		const storageKey = 'dataset-visibility-info-dismissed'

		// Check if already dismissed
		if (localStorage.getItem(storageKey) === 'true') {
			infoBox.classList.add('hidden')
		}

		dismissBtn.addEventListener('click', () => {
			infoBox.classList.add('hidden')
			localStorage.setItem(storageKey, 'true')
		})
	}

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

		// Set up dataset visibility info dismiss
		setupDatasetInfoDismiss()
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

		// Create Dataset from Selection button
		const createDatasetBtn = document.getElementById('create-dataset-from-selection-btn')
		if (createDatasetBtn) {
			createDatasetBtn.addEventListener('click', () => {
				createDatasetFromSelection()
			})
		}

		// Clear selection button
		const clearSelectionBtn = document.getElementById('clear-selection-btn')
		if (clearSelectionBtn) {
			clearSelectionBtn.addEventListener('click', () => {
				clearAllSelections()
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
		loadDatasets,
		renderDataTable: renderFilesPanel, // Alias for compatibility
		initializeDataTab,
		refreshExistingFilePaths,
		isFileAlreadyImported: (filePath) => existingFilePaths.has(filePath),
		getExistingFilePaths: () => new Set(existingFilePaths),
		getSelectedFileIds: () => [...selectedFileIds],
		getSelectedFiles: () => allFiles.filter((f) => selectedFileIds.includes(f.id)),
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
		createDatasetFromSelection,
		openDatasetEditor,
		setViewMode,
	}
}
