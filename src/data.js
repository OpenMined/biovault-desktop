export function createDataModule({ invoke, dialog }) {
	const FILE_STATUS_PRIORITY = { pending: 0, processing: 1, error: 2, complete: 3 }

	// State
	let allParticipants = []
	let allFiles = []
	let selectedForDelete = [] // Can include both participant IDs and file IDs
	let expandedParticipants = new Set()
	let currentDataTypeFilter = 'All'
	let sortField = 'status'
	let sortDirection = 'asc'
	let searchTerm = ''
	let queueProcessorRunning = false
	let queueIntervalId = null
	let existingFilePaths = new Set()

	// Helper: Group files by participant
	function groupFilesByParticipant() {
		const grouped = new Map()

		// Key by participant_id string (e.g., "P001"), not numeric id
		allParticipants.forEach((p) => {
			grouped.set(p.participant_id, {
				participant: p,
				files: [],
			})
		})

		allFiles.forEach((file) => {
			if (file.participant_id) {
				const group = grouped.get(file.participant_id)
				if (group) {
					group.files.push(file)
				}
			}
		})

		return Array.from(grouped.values())
	}

	// Helper: Get aggregated status for participant
	function getParticipantStatus(files) {
		if (files.length === 0) return 'unknown'
		const statuses = files.map((f) => f.status)
		if (statuses.every((s) => s === 'complete')) return 'complete'
		if (statuses.some((s) => s === 'pending')) return 'pending'
		if (statuses.some((s) => s === 'processing')) return 'processing'
		if (statuses.some((s) => s === 'error')) return 'error'
		return 'mixed'
	}

	// Helper: Get sort value for participant group
	function getGroupSortValue(group, field) {
		const { participant, files } = group

		switch (field) {
			case 'id':
				return participant.id
			case 'participant_id':
				return (participant.participant_id || '').toLowerCase()
			case 'status': {
				const status = getParticipantStatus(files)
				return FILE_STATUS_PRIORITY[status] ?? Number.MAX_SAFE_INTEGER
			}
			case 'file_count':
				return files.length
			case 'created_at':
				return participant.created_at ? Date.parse(participant.created_at) : null
			default:
				// For file-level fields, use first file's value
				if (files.length > 0) {
					return getFileSortValue(files[0], field)
				}
				return null
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
			case 'chromosome_count':
				return file.chromosome_count ?? null
			case 'inferred_sex':
				return (file.inferred_sex || '').toLowerCase()
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

	function sortGroups(groups) {
		groups.sort((a, b) => {
			const valA = getGroupSortValue(a, sortField)
			const valB = getGroupSortValue(b, sortField)

			let comparison
			if (typeof valA === 'number' || typeof valB === 'number') {
				comparison = compareNullableNumbers(valA, valB)
			} else {
				comparison = compareNullableStrings(valA, valB)
			}

			if (comparison === 0) {
				comparison = compareNullableNumbers(a.participant.id, b.participant.id)
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

	function matchesSearch(group) {
		if (!searchTerm) return true
		const term = searchTerm.toLowerCase()

		// Search in participant
		const participant = group.participant
		const participantValues = [participant.id, participant.participant_id, participant.created_at]

		if (participantValues.some((v) => v && v.toString().toLowerCase().includes(term))) {
			return true
		}

		// Search in files
		return group.files.some((file) => {
			const fileValues = [
				file.id,
				file.status,
				file.file_path,
				file.data_type,
				file.source,
				file.grch_version,
				file.row_count,
				file.chromosome_count,
				file.inferred_sex,
				file.file_hash,
				file.created_at,
			]
			return fileValues.some((v) => v && v.toString().toLowerCase().includes(term))
		})
	}

	function matchesDataTypeFilter(group) {
		if (currentDataTypeFilter === 'All') return true
		return group.files.some((f) => f.data_type === currentDataTypeFilter)
	}

	// Render status badge
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

	// Render file row
	function renderFileRow(file, isNested = false) {
		const row = document.createElement('tr')
		row.className = isNested ? 'nested-file-row' : 'file-row'
		row.dataset.fileId = file.id

		const statusBadge = renderStatusBadge(file.status, file.processing_error)

		const indent = isNested ? '<span class="file-indent">└─</span>' : ''

		const createdDate = file.created_at ? file.created_at.split(' ')[0] : '-'

		row.innerHTML = `
			<td class="checkbox-cell">${
				isNested
					? ''
					: `<input type="checkbox" class="item-checkbox" data-type="file" data-id="${file.id}" />`
			}</td>
			<td>${file.id}</td>
			<td>${statusBadge}</td>
			<td>${isNested ? '-' : file.participant_id || '-'}</td>
			<td title="${file.file_path}">${indent}${file.file_path.split('/').pop()}</td>
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
			<td>${createdDate}</td>
			<td class="actions-cell">
				<button class="btn-icon open-finder-btn" data-path="${
					file.file_path
				}" title="Show in folder">📁</button>
			</td>
		`

		// Add event listener for open finder button
		row.querySelector('.open-finder-btn').addEventListener('click', async () => {
			try {
				await invoke('show_in_folder', { filePath: file.file_path })
			} catch (error) {
				alert(`Error opening folder: ${error}`)
			}
		})

		if (!isNested) {
			const checkbox = row.querySelector('.item-checkbox')

			// Make entire row clickable (except buttons)
			row.addEventListener('click', (e) => {
				// Don't toggle if clicking on checkbox, button, or actions cell
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

			checkbox.addEventListener('change', (e) => {
				const fileId = parseInt(e.target.dataset.id)
				if (e.target.checked) {
					if (!selectedForDelete.includes(`file-${fileId}`)) {
						selectedForDelete.push(`file-${fileId}`)
					}
					row.classList.add('selected')
				} else {
					selectedForDelete = selectedForDelete.filter((x) => x !== `file-${fileId}`)
					row.classList.remove('selected')
				}
				updateDeleteButton()
			})

			row.style.cursor = 'pointer'
		}

		return row
	}

	// Render participant group
	function renderParticipantGroup(group) {
		const { participant, files } = group
		const filteredFiles =
			currentDataTypeFilter === 'All'
				? files
				: files.filter((f) => f.data_type === currentDataTypeFilter)

		if (filteredFiles.length === 0) return []

		const rows = []
		const status = getParticipantStatus(filteredFiles)
		const isExpanded = expandedParticipants.has(participant.id)
		const isSingleFile = filteredFiles.length === 1

		// Create main participant row
		const mainRow = document.createElement('tr')
		mainRow.className = 'participant-row'
		mainRow.dataset.participantId = participant.id

		const statusBadge = renderStatusBadge(status)
		const expandIcon = isSingleFile ? '→' : isExpanded ? '▼' : `▶ (${filteredFiles.length})`

		// For single file, show file info inline
		if (isSingleFile) {
			const file = filteredFiles[0]
			const createdDate = participant.created_at ? participant.created_at.split(' ')[0] : '-'

			mainRow.innerHTML = `
				<td class="checkbox-cell"><input type="checkbox" class="item-checkbox" data-type="participant" data-id="${
					participant.id
				}" /></td>
				<td>${participant.id}</td>
				<td>${renderStatusBadge(file.status, file.processing_error)}</td>
				<td><strong>${participant.participant_id}</strong></td>
				<td title="${file.file_path}">${file.file_path.split('/').pop()}</td>
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
				<td>${createdDate}</td>
				<td class="actions-cell">
					<button class="btn-icon open-finder-btn" data-path="${
						file.file_path
					}" title="Show in folder">📁</button>
				</td>
			`

			mainRow.querySelector('.open-finder-btn').addEventListener('click', async () => {
				try {
					await invoke('show_in_folder', { filePath: file.file_path })
				} catch (error) {
					alert(`Error opening folder: ${error}`)
				}
			})
		} else {
			// Multiple files - show participant row with expand toggle
			const createdDate = participant.created_at ? participant.created_at.split(' ')[0] : '-'

			mainRow.innerHTML = `
				<td class="checkbox-cell"><input type="checkbox" class="item-checkbox" data-type="participant" data-id="${participant.id}" /></td>
				<td>${participant.id}</td>
				<td>${statusBadge}</td>
				<td class="expandable-cell"><span class="expand-icon">${expandIcon}</span> <strong>${participant.participant_id}</strong></td>
				<td colspan="6" class="text-muted">${filteredFiles.length} files</td>
				<td>${createdDate}</td>
				<td></td>
			`

			// Add expand/collapse functionality
			mainRow.querySelector('.expandable-cell').addEventListener('click', () => {
				if (expandedParticipants.has(participant.id)) {
					expandedParticipants.delete(participant.id)
				} else {
					expandedParticipants.add(participant.id)
				}
				renderDataTable()
			})
		}

		// Add checkbox listener and row click functionality
		const checkbox = mainRow.querySelector('.item-checkbox')

		// Make entire row clickable (except actions and expandable cells)
		mainRow.addEventListener('click', (e) => {
			// Don't toggle if clicking on checkbox, button, actions, or expandable cell
			if (
				e.target.tagName === 'INPUT' ||
				e.target.tagName === 'BUTTON' ||
				e.target.closest('.actions-cell') ||
				e.target.closest('.checkbox-cell') ||
				e.target.closest('.expandable-cell')
			) {
				return
			}
			checkbox.checked = !checkbox.checked
			checkbox.dispatchEvent(new Event('change'))
		})

		checkbox.addEventListener('change', (e) => {
			const participantId = parseInt(e.target.dataset.id)
			if (e.target.checked) {
				if (!selectedForDelete.includes(`participant-${participantId}`)) {
					selectedForDelete.push(`participant-${participantId}`)
				}
				mainRow.classList.add('selected')
			} else {
				selectedForDelete = selectedForDelete.filter((x) => x !== `participant-${participantId}`)
				mainRow.classList.remove('selected')
			}
			updateDeleteButton()
		})

		mainRow.style.cursor = 'pointer'

		rows.push(mainRow)

		// Add nested file rows if expanded
		if (!isSingleFile && isExpanded) {
			filteredFiles.forEach((file) => {
				const fileRow = renderFileRow(file, true)
				rows.push(fileRow)
			})
		}

		return rows
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

			renderDataTable()
		} catch (error) {
			console.error('Error loading data:', error)
		}
	}

	function renderDataTable() {
		const tbody = document.getElementById('data-table')
		if (!tbody) return

		tbody.innerHTML = ''

		// Clean up selection
		selectedForDelete = selectedForDelete.filter((id) => {
			if (id.startsWith('participant-')) {
				const pId = parseInt(id.split('-')[1])
				return allParticipants.some((p) => p.id === pId)
			} else if (id.startsWith('file-')) {
				const fId = parseInt(id.split('-')[1])
				return allFiles.some((f) => f.id === fId)
			}
			return false
		})

		// Group and filter
		const groups = groupFilesByParticipant()
		const filtered = groups.filter(matchesSearch).filter(matchesDataTypeFilter)

		sortGroups(filtered)

		// Render all rows
		filtered.forEach((group) => {
			const rows = renderParticipantGroup(group)
			rows.forEach((row) => tbody.appendChild(row))
		})

		// Update counts and UI
		const totalCount = filtered.reduce((sum, g) => {
			const fileCount =
				currentDataTypeFilter === 'All'
					? g.files.length
					: g.files.filter((f) => f.data_type === currentDataTypeFilter).length
			return sum + fileCount
		}, 0)
		document.getElementById('data-count').textContent = totalCount

		const pendingCount = allFiles.filter((f) => f.status === 'pending').length
		document.getElementById('pending-count').textContent = pendingCount

		const processQueueBtn = document.getElementById('process-queue-btn')
		if (processQueueBtn) {
			processQueueBtn.style.display = pendingCount > 0 ? 'flex' : 'none'
		}

		const spinner = document.getElementById('queue-spinner')
		if (spinner) {
			spinner.style.display = queueProcessorRunning && pendingCount > 0 ? 'inline-block' : 'none'
		}

		updateSortIndicators()
		updateDeleteButton()
		updateSelectAllCheckbox()
	}

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
		const runBtn = document.getElementById('run-analysis-btn')

		const participantCount = selectedForDelete.filter((id) => id.startsWith('participant-')).length

		if (selectedForDelete.length > 0) {
			btn.style.display = 'block'
			btn.textContent = `Delete Selected (${selectedForDelete.length})`

			if (participantCount > 0 && runBtn) {
				runBtn.style.display = 'flex'
				runBtn.textContent = `🔬 Run Analysis (${participantCount})`
			}
		} else {
			btn.style.display = 'none'
			if (runBtn) {
				runBtn.style.display = 'none'
			}
		}
	}

	function updateSelectAllCheckbox() {
		const selectAllHeader = document.getElementById('select-all-data-table')
		if (!selectAllHeader) return

		const groups = groupFilesByParticipant()
		const filtered = groups.filter(matchesSearch).filter(matchesDataTypeFilter)
		const totalItems = filtered.length

		const selectedCount = selectedForDelete.filter((id) => {
			if (id.startsWith('participant-')) {
				const pId = parseInt(id.split('-')[1])
				return filtered.some((g) => g.participant.id === pId)
			}
			return false
		}).length

		selectAllHeader.checked = totalItems > 0 && selectedCount === totalItems
		selectAllHeader.indeterminate = selectedCount > 0 && selectedCount < totalItems
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

	function initializeDataTab() {
		// Select all checkbox
		const selectAllHeader = document.getElementById('select-all-data-table')
		if (selectAllHeader) {
			selectAllHeader.addEventListener('change', (e) => {
				const groups = groupFilesByParticipant()
				const filtered = groups.filter(matchesSearch).filter(matchesDataTypeFilter)

				if (e.target.checked) {
					filtered.forEach((group) => {
						const key = `participant-${group.participant.id}`
						if (!selectedForDelete.includes(key)) {
							selectedForDelete.push(key)
						}
					})
				} else {
					filtered.forEach((group) => {
						const key = `participant-${group.participant.id}`
						selectedForDelete = selectedForDelete.filter((x) => x !== key)
					})
				}

				renderDataTable()
			})
		}

		// Search input
		const searchInput = document.getElementById('data-search')
		if (searchInput) {
			searchInput.addEventListener('input', (e) => {
				searchTerm = e.target.value.trim().toLowerCase()
				renderDataTable()
			})
		}

		// Data type filter dropdown
		const dataTypeFilter = document.getElementById('data-type-filter')
		if (dataTypeFilter) {
			dataTypeFilter.addEventListener('change', (e) => {
				currentDataTypeFilter = e.target.value
				renderDataTable()
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

				renderDataTable()
			})
		})

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

		// Delete button
		const deleteBtn = document.getElementById('delete-selected-btn')
		if (deleteBtn) {
			deleteBtn.addEventListener('click', async () => {
				if (selectedForDelete.length === 0) return

				const participantIds = selectedForDelete
					.filter((id) => id.startsWith('participant-'))
					.map((id) => parseInt(id.split('-')[1]))

				const fileIds = selectedForDelete
					.filter((id) => id.startsWith('file-'))
					.map((id) => parseInt(id.split('-')[1]))

				const confirmed = await dialog.confirm(
					`Are you sure you want to delete ${participantIds.length} participant(s) and ${fileIds.length} file(s)?`,
					{ title: 'Delete Data', type: 'warning' },
				)

				if (confirmed) {
					try {
						let deleted = 0
						if (participantIds.length > 0) {
							deleted += await invoke('delete_participants_bulk', {
								participantIds: participantIds,
							})
						}
						if (fileIds.length > 0) {
							deleted += await invoke('delete_files_bulk', { fileIds: fileIds })
						}

						console.log(`Deleted ${deleted} item(s)`)
						selectedForDelete = []
						await loadData()
					} catch (error) {
						await dialog.message(`Error deleting data: ${error}`, {
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
				const participantIds = selectedForDelete
					.filter((id) => id.startsWith('participant-'))
					.map((id) => parseInt(id.split('-')[1]))

				if (participantIds.length > 0) {
					// Store selected participant IDs and navigate to Run view
					sessionStorage.setItem('preselectedParticipants', JSON.stringify(participantIds))
					const navigateTo =
						window.navigateTo || ((_view) => console.warn('navigateTo not available'))
					navigateTo('run')
				}
			})
		}

		// Clear Selection button
		const clearSelectionBtn = document.getElementById('clear-selection-btn')
		if (clearSelectionBtn) {
			clearSelectionBtn.addEventListener('click', () => {
				selectedForDelete = []
				renderDataTable()
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
		renderDataTable,
		initializeDataTab,
		refreshExistingFilePaths,
		isFileAlreadyImported: (filePath) => existingFilePaths.has(filePath),
		getExistingFilePaths: () => new Set(existingFilePaths),
		getSelectedParticipants: () => {
			return selectedForDelete
				.filter((id) => id.startsWith('participant-'))
				.map((id) => {
					const pId = parseInt(id.split('-')[1])
					return allParticipants.find((p) => p.id === pId)
				})
				.filter(Boolean)
		},
	}
}
