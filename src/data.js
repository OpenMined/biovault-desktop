export function createDataModule({ invoke, dialog }) {
	const FILE_STATUS_PRIORITY = { pending: 0, processing: 1, error: 2, complete: 3 }

	// State
	let allParticipants = []
	let allFiles = []
	let selectedParticipantIds = [] // IDs of selected participants (for filtering view)
	let selectedFileIds = [] // File IDs selected for workflows/operations
	let showAllFiles = false // Toggle between "selected participants" and "all files"
	let participantFilter = 'all' // Filter for participant sidebar
	let participantSearchTerm = ''
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

	function getParticipantStatus(files) {
		if (files.length === 0) return 'unknown'
		const statuses = files.map((f) => f.status)
		if (statuses.every((s) => s === 'complete')) return 'complete'
		if (statuses.some((s) => s === 'pending')) return 'pending'
		if (statuses.some((s) => s === 'processing')) return 'processing'
		if (statuses.some((s) => s === 'error')) return 'error'
		return 'mixed'
	}

	function getFilesForParticipant(participantId) {
		return allFiles.filter((f) => f.participant_id === participantId)
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

	function matchesParticipantSearch(participant) {
		if (!participantSearchTerm) return true
		const term = participantSearchTerm.toLowerCase()
		const values = [participant.id, participant.participant_id, participant.created_at]
		return values.some((v) => v && v.toString().toLowerCase().includes(term))
	}

	function matchesParticipantFilter(participant) {
		const files = getFilesForParticipant(participant.participant_id)

		switch (participantFilter) {
			case 'all':
				return true
			case 'genotype':
				return files.some((f) => f.data_type === 'Genotype')
			case 'incomplete':
				return files.some((f) => f.status === 'pending' || f.status === 'error')
			default:
				return true
		}
	}

	function matchesFileSearch(file) {
		if (!fileSearchTerm) return true
		const term = fileSearchTerm.toLowerCase()
		const values = [
			file.id,
			file.status,
			file.file_path,
			file.data_type,
			file.source,
			file.grch_version,
			file.participant_id,
			file.inferred_sex,
		]
		return values.some((v) => v && v.toString().toLowerCase().includes(term))
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
	// RENDERING - PARTICIPANTS SIDEBAR
	// ============================================================================

	function renderParticipantItem(participant) {
		const files = getFilesForParticipant(participant.participant_id)
		const status = getParticipantStatus(files)
		const isSelected = selectedParticipantIds.includes(participant.id)

		const item = document.createElement('div')
		item.className = `participant-item ${isSelected ? 'selected' : ''}`
		item.dataset.participantId = participant.id

		const fileCountText = files.length === 1 ? '1 file' : `${files.length} files`

		item.innerHTML = `
			<div class="participant-checkbox">
				<input type="checkbox" ${isSelected ? 'checked' : ''} />
			</div>
			<div class="participant-info">
				<div class="participant-name">${participant.participant_id}</div>
				<div class="participant-meta">
					<span class="file-count">${fileCountText}</span>
					<span class="status-dot status-${status}"></span>
				</div>
			</div>
			<div class="participant-status">
				${renderStatusBadge(status)}
			</div>
		`

		// Click handler for entire item
		item.addEventListener('click', (e) => {
			// Don't toggle if clicking checkbox directly (it handles itself)
			if (e.target.type === 'checkbox') return

			const checkbox = item.querySelector('input[type="checkbox"]')
			checkbox.checked = !checkbox.checked
			checkbox.dispatchEvent(new Event('change'))
		})

		// Checkbox change handler - selects/deselects ALL FILES for this participant
		const checkbox = item.querySelector('input[type="checkbox"]')
		checkbox.addEventListener('change', (e) => {
			e.stopPropagation()
			const participantId = parseInt(participant.id)
			const participantFiles = getFilesForParticipant(participant.participant_id)

			if (e.target.checked) {
				// Select all files for this participant
				participantFiles.forEach((file) => {
					if (!selectedFileIds.includes(file.id)) {
						selectedFileIds.push(file.id)
					}
				})
				if (!selectedParticipantIds.includes(participantId)) {
					selectedParticipantIds.push(participantId)
				}
				// Auto-switch to "Selected" view when user selects a participant
				if (showAllFiles) {
					showAllFiles = false
					updateShowAllFilesButton()
				}
			} else {
				// Deselect all files for this participant
				const fileIdsToRemove = participantFiles.map((f) => f.id)
				selectedFileIds = selectedFileIds.filter((id) => !fileIdsToRemove.includes(id))
				selectedParticipantIds = selectedParticipantIds.filter((id) => id !== participantId)
			}

			renderFilesPanel()
			updateActionButtons()
		})

		return item
	}

	function renderParticipantsSidebar() {
		const listContainer = document.getElementById('participants-list')
		if (!listContainer) return

		listContainer.innerHTML = ''

		// Filter participants
		const filtered = allParticipants
			.filter(matchesParticipantSearch)
			.filter(matchesParticipantFilter)

		// Sort by participant_id
		filtered.sort((a, b) => {
			const idA = (a.participant_id || '').toLowerCase()
			const idB = (b.participant_id || '').toLowerCase()
			return idA.localeCompare(idB)
		})

		filtered.forEach((participant) => {
			const item = renderParticipantItem(participant)
			listContainer.appendChild(item)
		})

		// Update participant checkboxes based on file selections (only when in Selected view)
		setTimeout(() => updateParticipantCheckboxes(), 0)

		// Participant count is updated in loadData() - shows total, not filtered
	}

	function updateParticipantCheckboxes() {
		// Only update participant checkboxes when in "Selected" view
		// In "All Files" view, participant list is dimmed and shouldn't update
		if (showAllFiles) return

		allParticipants.forEach((participant) => {
			const item = document.querySelector(
				`.participant-item[data-participant-id="${participant.id}"]`,
			)
			if (!item) return

			const checkbox = item.querySelector('input[type="checkbox"]')
			if (!checkbox) return

			const participantFiles = getFilesForParticipant(participant.participant_id)
			const allFilesSelected =
				participantFiles.length > 0 &&
				participantFiles.every((file) => selectedFileIds.includes(file.id))
			const someFilesSelected = participantFiles.some((file) => selectedFileIds.includes(file.id))

			checkbox.checked = allFilesSelected
			checkbox.indeterminate = someFilesSelected && !allFilesSelected

			// Update selection state for visual feedback
			if (allFilesSelected || someFilesSelected) {
				item.classList.add('selected')
			} else {
				item.classList.remove('selected')
			}
		})
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

		row.innerHTML = `
			<td class="checkbox-cell">
				<input type="checkbox" class="file-checkbox" data-id="${file.id}" ${isSelected ? 'checked' : ''} />
			</td>
			<td>${file.id}</td>
			<td>${statusBadge}</td>
			<td><strong>${file.participant_id || '-'}</strong></td>
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
		row.querySelector('.open-finder-btn').addEventListener('click', async () => {
			try {
				await invoke('show_in_folder', { filePath: file.file_path })
			} catch (error) {
				alert(`Error opening folder: ${error}`)
			}
		})

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
			updateParticipantCheckboxes()
		})

		// Make row clickable (except buttons and checkbox)
		row.addEventListener('click', (e) => {
			if (
				e.target.tagName === 'INPUT' ||
				e.target.tagName === 'BUTTON' ||
				e.target.closest('.actions-cell') ||
				e.target.closest('.checkbox-cell')
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
		const panelTitle = document.getElementById('files-panel-title')

		if (!tbody) return

		tbody.innerHTML = ''

		// Get files to display
		let filesToDisplay = []

		if (showAllFiles) {
			// Show all files
			filesToDisplay = allFiles.filter(matchesDataTypeFilter).filter(matchesFileSearch)
			panelTitle.textContent = `All Files (${filesToDisplay.length})`
		} else {
			// Show files for selected participants only
			if (selectedParticipantIds.length === 0) {
				// No participants selected - show empty state
				tableWrapper.style.display = 'none'
				emptyState.style.display = 'flex'
				document.getElementById('empty-state-title').textContent = 'No participants selected'
				document.getElementById('empty-state-message').textContent =
					'Select participants from the sidebar to view their files, or click "Show All Files"'
				// Don't reset file-count here - header should always show total files
				return
			}

			const selectedParticipantStrings = selectedParticipantIds.map((id) => {
				const p = allParticipants.find((p) => p.id === id)
				return p ? p.participant_id : null
			})

			filesToDisplay = allFiles
				.filter((f) => selectedParticipantStrings.includes(f.participant_id))
				.filter(matchesDataTypeFilter)
				.filter(matchesFileSearch)

			const participantText =
				selectedParticipantIds.length === 1
					? '1 participant'
					: `${selectedParticipantIds.length} participants`
			panelTitle.textContent = `Files for ${participantText} (${filesToDisplay.length})`
		}

		// Clean up file selections (remove files that don't exist anymore)
		selectedFileIds = selectedFileIds.filter((id) => allFiles.some((f) => f.id === id))

		// Sort files
		sortFiles(filesToDisplay)

		// Render files
		if (filesToDisplay.length === 0) {
			tableWrapper.style.display = 'none'
			emptyState.style.display = 'flex'
			document.getElementById('empty-state-title').textContent = 'No files found'
			document.getElementById('empty-state-message').textContent =
				'Try adjusting your filters or search term'
		} else {
			tableWrapper.style.display = 'block'
			emptyState.style.display = 'none'

			filesToDisplay.forEach((file) => {
				const row = renderFileRow(file)
				tbody.appendChild(row)
			})
		}

		updateSortIndicators()
		updateSelectAllCheckbox()
		updateDeleteButton()
		updateActionButtons()
		updateParticipantCheckboxes()
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
			btn.textContent = `Delete (${selectedFileIds.length})`
		} else {
			btn.style.display = 'none'
		}
	}

	function updateActionButtons() {
		const runBtn = document.getElementById('run-analysis-btn')
		const runText = document.getElementById('run-analysis-text')

		const fileCount = selectedFileIds.length
		if (fileCount > 0) {
			runBtn.disabled = false
			runText.textContent = `Run Pipeline (${fileCount} ${fileCount === 1 ? 'file' : 'files'})`
		} else {
			runBtn.disabled = true
			runText.textContent = 'Run Pipeline'
		}
	}

	function updateSelectAllCheckbox() {
		const selectAllCheckbox = document.getElementById('select-all-files')
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

	function updateShowAllFilesButton() {
		const selectedBtn = document.getElementById('view-selected-btn')
		const allBtn = document.getElementById('view-all-btn')
		const participantsList = document.getElementById('participants-list')

		if (!selectedBtn || !allBtn) return

		if (showAllFiles) {
			selectedBtn.classList.remove('active')
			allBtn.classList.add('active')
			// Dim the participant list to show it's not affecting the current view
			if (participantsList) {
				participantsList.classList.add('dimmed')
			}
		} else {
			selectedBtn.classList.add('active')
			allBtn.classList.remove('active')
			// Re-enable participant list
			if (participantsList) {
				participantsList.classList.remove('dimmed')
			}
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

			// Update header counts - these should always show totals
			const participantCountEl = document.getElementById('participant-count')
			const fileCountEl = document.getElementById('file-count')

			if (participantCountEl) {
				participantCountEl.textContent = participants.length
			}
			if (fileCountEl) {
				fileCountEl.textContent = files.length
			}

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

			renderParticipantsSidebar()
			renderFilesPanel()
			updateActionButtons()
			updateShowAllFilesButton()
		} catch (error) {
			console.error('Error loading data:', error)
		}
	}

	// ============================================================================
	// INITIALIZATION
	// ============================================================================

	function initializeDataTab() {
		// Participant search
		const participantSearch = document.getElementById('participant-search')
		if (participantSearch) {
			participantSearch.addEventListener('input', (e) => {
				participantSearchTerm = e.target.value.trim().toLowerCase()
				renderParticipantsSidebar()
			})
		}

		// Participant filter dropdown
		const participantFilterSelect = document.getElementById('participant-filter')
		if (participantFilterSelect) {
			participantFilterSelect.addEventListener('change', (e) => {
				participantFilter = e.target.value
				renderParticipantsSidebar()
			})
		}

		// View mode segmented control
		const viewSelectedBtn = document.getElementById('view-selected-btn')
		const viewAllBtn = document.getElementById('view-all-btn')

		if (viewSelectedBtn) {
			viewSelectedBtn.addEventListener('click', () => {
				if (!showAllFiles) return // Already in this mode
				showAllFiles = false
				updateShowAllFilesButton()
				renderFilesPanel()
			})
		}

		if (viewAllBtn) {
			viewAllBtn.addEventListener('click', () => {
				if (showAllFiles) return // Already in this mode
				showAllFiles = true
				updateShowAllFilesButton()
				renderFilesPanel()
			})
		}

		// File search
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
			return selectedParticipantIds
				.map((id) => allParticipants.find((p) => p.id === id))
				.filter(Boolean)
		},
	}
}
