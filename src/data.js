export function createDataModule({ invoke, dialog }) {
	const FILE_STATUS_PRIORITY = { pending: 0, processing: 1, error: 2, complete: 3 }

	// State
	let allParticipants = []
	let allFiles = []
	let selectedFileIds = [] // File IDs selected for workflows/operations
	let currentDataTypeFilter = 'All'
	let fileSearchTerm = ''
	let sortField = 'status'
	let sortDirection = 'asc'
	let queueProcessorRunning = false
	let queueIntervalId = null
	let existingFilePaths = new Set()

	// ============================================================================
	// HELPERS
	// ============================================================================

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
			case 'chromosome_count':
				return file.chromosome_count ?? null
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
		if (field === 'row_count' || field === 'chromosome_count' || field === 'id') return 'desc'
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

	function renderStatusBadge(status, error = null) {
		const badges = {
			pending: '<span class="status-badge status-pending" title="Pending">⏳ PENDING</span>',
			processing:
				'<span class="status-badge status-processing" title="Processing">⚙️ PROCESSING</span>',
			error: `<span class="status-badge status-error" title="${error || 'Error'}">❌ ERROR</span>`,
			complete: '<span class="status-badge status-complete" title="Complete">✓ COMPLETE</span>',
			mixed: '<span class="status-badge status-mixed" title="Mixed status">◐ MIXED</span>',
			unknown: '<span class="status-badge status-unknown" title="Unknown">? UNKNOWN</span>',
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

		const statusBadge = renderStatusBadge(file.status, file.processing_error)
		const participantId = file.participant_id
		const participantDisplay = participantId
			? `<span class="participant-link" data-participant-id="${participantId}" title="Click to filter by ${participantId}">${participantId}</span>`
			: '<span style="color: #9ca3af; font-style: italic;">Unassigned</span>'

		row.innerHTML = `
			<td class="checkbox-cell">
				<input type="checkbox" class="file-checkbox" data-id="${file.id}" ${isSelected ? 'checked' : ''} />
			</td>
			<td>${file.id}</td>
			<td>${statusBadge}</td>
			<td><strong>${participantDisplay}</strong></td>
			<td title="${file.file_path}">${file.file_path.split('/').pop()}</td>
			<td>
				<span class="type-badge type-${(file.data_type || 'unknown').toLowerCase()}">
					${file.data_type || 'Unknown'}
				</span>
			</td>
			<td>${file.source || '-'}</td>
			<td>${file.grch_version || '-'}</td>
			<td>${file.row_count ? file.row_count.toLocaleString() : '-'}</td>
			<td>${file.chromosome_count || '-'}</td>
			<td class="sex-cell" style="font-weight: ${file.inferred_sex ? '600' : 'normal'}; color: ${
				file.inferred_sex === 'Male'
					? '#007bff'
					: file.inferred_sex === 'Female'
						? '#e83e8c'
						: '#666'
			}">${file.inferred_sex || '-'}</td>
			<td class="actions-cell">
				<button class="btn-icon open-finder-btn" data-path="${
					file.file_path
				}" title="Show in folder">📁</button>
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

		// Get files to display - apply all filters
		let filesToDisplay = allFiles.filter(matchesDataTypeFilter).filter(matchesFileSearch)

		// Update page title with file count (only in Data view)
		const dataView = document.getElementById('data-view')
		const pageTitle = dataView?.querySelector('.page-title')
		if (pageTitle) {
			const titleText = `${filesToDisplay.length} files`
			pageTitle.innerHTML = `Data <span style="font-size: 14px; font-weight: 400; color: #6b7280; margin-left: 8px;">(${titleText})</span>`
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

			// Use virtual scrolling for large datasets (>500 files)
			if (filesToDisplay.length > 500) {
				// Reset scroll handler attachment if table wrapper changed
				const tableWrapper = document.querySelector('.files-table-wrapper')
				if (tableWrapper && virtualScrollState.scrollHandlerAttached) {
					// Check if handler is still attached
					if (!tableWrapper.hasAttribute('data-vscroll-attached')) {
						virtualScrollState.scrollHandlerAttached = false
						tableWrapper.setAttribute('data-vscroll-attached', 'true')
					}
				}
				renderFilesWithVirtualScrolling(tbody, filesToDisplay)
			} else {
				// Clear virtual scroll state for smaller datasets
				virtualScrollState.allFiles = null
				virtualScrollState.scrollHandlerAttached = false
				// Render all files directly for smaller datasets
				filesToDisplay.forEach((file) => {
					const row = renderFileRow(file)
					tbody.appendChild(row)
				})
			}
		}

		updateSortIndicators()
		updateSelectAllCheckbox()
		updateDeleteButton()
		updateActionButtons()
	}

	// ============================================================================
	// VIRTUAL SCROLLING (for large datasets)
	// ============================================================================

	let virtualScrollState = {
		visibleStart: 0,
		visibleEnd: 50,
		rowHeight: 48, // Approximate row height in pixels
		buffer: 10, // Extra rows to render outside viewport
		allFiles: null,
		scrollHandler: null,
		scrollHandlerAttached: false,
	}

	function renderFilesWithVirtualScrolling(tbody, files) {
		const tableWrapper = document.querySelector('.files-table-wrapper')
		if (!tableWrapper) return

		// Clear existing content
		tbody.innerHTML = ''

		// Store files for virtual scrolling
		virtualScrollState.allFiles = files

		// Calculate visible range
		const scrollTop = tableWrapper.scrollTop || 0
		const containerHeight = tableWrapper.clientHeight || 800
		const startIndex = Math.max(
			0,
			Math.floor(scrollTop / virtualScrollState.rowHeight) - virtualScrollState.buffer,
		)
		const endIndex = Math.min(
			files.length,
			Math.ceil((scrollTop + containerHeight) / virtualScrollState.rowHeight) +
				virtualScrollState.buffer,
		)

		virtualScrollState.visibleStart = startIndex
		virtualScrollState.visibleEnd = endIndex

		// Add spacer for rows before visible range
		if (startIndex > 0) {
			const spacerTop = document.createElement('tr')
			spacerTop.style.height = `${startIndex * virtualScrollState.rowHeight}px`
			spacerTop.innerHTML = '<td colspan="12"></td>'
			tbody.appendChild(spacerTop)
		}

		// Render visible rows
		for (let i = startIndex; i < endIndex && i < files.length; i++) {
			const file = files[i]
			const row = renderFileRow(file)
			tbody.appendChild(row)
		}

		// Add spacer for rows after visible range
		if (endIndex < files.length) {
			const spacerBottom = document.createElement('tr')
			spacerBottom.style.height = `${(files.length - endIndex) * virtualScrollState.rowHeight}px`
			spacerBottom.innerHTML = '<td colspan="12"></td>'
			tbody.appendChild(spacerBottom)
		}

		// Set up scroll handler (debounced) - only once per table wrapper
		if (!virtualScrollState.scrollHandlerAttached) {
			virtualScrollState.scrollHandler = debounce(() => {
				if (tableWrapper && virtualScrollState.allFiles) {
					renderFilesWithVirtualScrolling(tbody, virtualScrollState.allFiles)
				}
			}, 16) // ~60fps

			tableWrapper.addEventListener('scroll', virtualScrollState.scrollHandler, { passive: true })
			virtualScrollState.scrollHandlerAttached = true
		}

		// Update total height for proper scrolling
		tableWrapper.style.overflowY = 'auto'
	}

	function debounce(func, wait) {
		let timeout
		return function executedFunction(...args) {
			const later = () => {
				clearTimeout(timeout)
				func(...args)
			}
			clearTimeout(timeout)
			timeout = setTimeout(later, wait)
		}
	}

	// ============================================================================
	// UI UPDATES
	// ============================================================================

	function updateSortIndicators() {
		document.querySelectorAll('.sortable-header').forEach((header) => {
			const indicator = header.querySelector('.sort-indicator')
			if (!indicator) return

			if (header.dataset.sortField === sortField) {
				indicator.textContent = sortDirection === 'asc' ? ' ▲' : ' ▼'
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
			btn.textContent = 'Delete'
			btn.title = `Delete ${selectedFileIds.length} file${selectedFileIds.length === 1 ? '' : 's'}`
		} else {
			btn.style.display = 'none'
		}
	}

	function updateActionButtons() {
		const runBtn = document.getElementById('run-analysis-btn')
		const runText = document.getElementById('run-analysis-text')
		const selectionCountEl = document.getElementById('selection-count')
		const selectionActionsGroup = document.getElementById('selection-actions-group')

		const fileCount = selectedFileIds.length
		if (fileCount > 0) {
			runBtn.disabled = false
			runText.textContent = 'Run Pipeline'
			runBtn.title = `Run pipeline on ${fileCount} file${fileCount === 1 ? '' : 's'}`
			if (selectionCountEl && selectionActionsGroup) {
				const countText =
					selectionCountEl.querySelector('#selection-count-text') || selectionCountEl
				countText.textContent = fileCount.toString()
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

		const visibleFileIds = Array.from(document.querySelectorAll('.file-checkbox')).map((cb) =>
			parseInt(cb.dataset.id),
		)

		const allSelected =
			visibleFileIds.length > 0 && visibleFileIds.every((id) => selectedFileIds.includes(id))
		const someSelected = visibleFileIds.some((id) => selectedFileIds.includes(id))

		selectAllCheckbox.checked = allSelected
		selectAllCheckbox.indeterminate = someSelected && !allSelected
	}

	async function updateQueueButton() {
		try {
			const isRunning = await invoke('get_queue_processor_status')
			const btn = document.getElementById('process-queue-btn')
			const icon = document.getElementById('queue-btn-icon')
			const text = document.getElementById('queue-btn-text')
			const spinner = document.getElementById('queue-spinner')

			queueProcessorRunning = isRunning
			const pendingCount = parseInt(
				document.getElementById('pending-count')?.textContent || '0',
				10,
			)

			if (btn && icon && text) {
				if (isRunning) {
					icon.textContent = '⏸'
					text.textContent = 'Pause Queue'
					btn.style.background = '#28a745'
				} else {
					icon.textContent = '▶'
					text.textContent = 'Resume Queue'
					btn.style.background = '#ffc107'
				}
			}

			if (spinner) {
				spinner.style.display = queueProcessorRunning && pendingCount > 0 ? 'inline-block' : 'none'
			}
		} catch (error) {
			console.error('Error getting queue status:', error)
		}
	}

	// ============================================================================
	// MAIN DATA LOADING
	// ============================================================================

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

			const pendingCount = files.filter((f) => f.status === 'pending').length
			document.getElementById('pending-count').textContent = pendingCount

			const processQueueBtn = document.getElementById('process-queue-btn')
			if (processQueueBtn) {
				processQueueBtn.style.display = pendingCount > 0 ? 'flex' : 'none'
			}

			// Show/hide main UI or global empty state
			const mainLayout = document.querySelector('.data-main-layout')
			const globalEmptyState = document.getElementById('data-empty-state')

			if (participants.length === 0 && files.length === 0) {
				mainLayout.style.display = 'none'
				globalEmptyState.style.display = 'flex'
			} else {
				mainLayout.style.display = 'flex'
				globalEmptyState.style.display = 'none'
			}

			renderFilesPanel()
			updateActionButtons()
		} catch (error) {
			console.error('Error loading data:', error)
		}
	}

	// ============================================================================
	// INITIALIZATION
	// ============================================================================

	function initializeDataTab() {
		// File search (searches both files and participants)
		const fileSearch = document.getElementById('file-search')
		if (fileSearch) {
			fileSearch.addEventListener('input', (e) => {
				fileSearchTerm = e.target.value.trim().toLowerCase()
				renderFilesPanel()
			})
		}

		// Data type filter
		const dataTypeFilter = document.getElementById('data-type-filter')
		if (dataTypeFilter) {
			dataTypeFilter.addEventListener('change', (e) => {
				currentDataTypeFilter = e.target.value
				renderFilesPanel()
			})
		}

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
				const visibleFileIds = Array.from(document.querySelectorAll('.file-checkbox')).map((cb) =>
					parseInt(cb.dataset.id),
				)

				if (e.target.checked) {
					visibleFileIds.forEach((id) => {
						if (!selectedFileIds.includes(id)) {
							selectedFileIds.push(id)
						}
					})
				} else {
					selectedFileIds = selectedFileIds.filter((id) => !visibleFileIds.includes(id))
				}

				renderFilesPanel()
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
			runAnalysisBtn.addEventListener('click', () => {
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

					// Store selected participant IDs and navigate to Run view
					sessionStorage.setItem('preselectedParticipants', JSON.stringify(participantIds))
					sessionStorage.setItem('preselectedFileIds', JSON.stringify(selectedFileIds))
					const navigateTo =
						window.navigateTo || ((_view) => console.warn('navigateTo not available'))
					navigateTo('run')
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

					await updateQueueButton()
					await loadData()
				} catch (error) {
					alert(`Error toggling queue processor: ${error}`)
				}
			})
		}

		// Queue processor interval
		if (!queueIntervalId) {
			queueIntervalId = setInterval(async () => {
				await updateQueueButton()

				const isDataTabActive = document.getElementById('data-view')?.classList.contains('active')
				const pendingCount = parseInt(
					document.getElementById('pending-count')?.textContent || '0',
					10,
				)

				if (queueProcessorRunning && isDataTabActive && pendingCount > 0) {
					await loadData()
				}
			}, 3000)
		}

		void updateQueueButton()
	}

	function refreshExistingFilePaths() {
		existingFilePaths = new Set(allFiles.map((f) => f.file_path))
	}

	return {
		loadData,
		renderDataTable: renderFilesPanel, // Alias for compatibility
		initializeDataTab,
		refreshExistingFilePaths,
		isFileAlreadyImported: (filePath) => existingFilePaths.has(filePath),
		getExistingFilePaths: () => new Set(existingFilePaths),
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
	}
}
