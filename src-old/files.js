const QUEUE_DISABLED = true

export function createFilesModule({ invoke, dialog }) {
	const FILE_STATUS_PRIORITY = { pending: 0, processing: 1, error: 2, complete: 3 }

	let selectedFilesForDelete = []
	let currentFileTypeFilter = 'Genotype'
	let filesSortField = 'status'
	let filesSortDirection = 'asc'
	let existingFilePaths = new Set()
	let allFilesData = []
	let filesSearchTerm = ''
	let queueProcessorRunning = false
	let queueIntervalId = null
	let lastClickedFileId = null
	let lastRenderedFileIds = []
	let isRangeSelecting = false

	async function refreshExistingFilePaths() {
		try {
			const files = await invoke('get_files')
			existingFilePaths = new Set(files.map((f) => f.file_path))
		} catch (error) {
			console.error('Error loading existing file paths:', error)
			existingFilePaths = new Set()
		}
	}

	function getFileSortValue(file, field) {
		switch (field) {
			case 'id':
				return file.id ?? null
			case 'status':
				return FILE_STATUS_PRIORITY[file.status] ?? Number.MAX_SAFE_INTEGER
			case 'participant':
				return (file.participant_name || '').toLowerCase()
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
			case 'file_hash':
				return (file.file_hash || '').toLowerCase()
			case 'created_at':
				return file.created_at ? Date.parse(file.created_at) : null
			case 'updated_at':
				return file.updated_at ? Date.parse(file.updated_at) : null
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

	function sortFilesForTable(files) {
		files.sort((a, b) => {
			const valA = getFileSortValue(a, filesSortField)
			const valB = getFileSortValue(b, filesSortField)

			let comparison
			if (typeof valA === 'number' || typeof valB === 'number') {
				comparison = compareNullableNumbers(valA, valB)
			} else {
				comparison = compareNullableStrings(valA, valB)
			}

			if (comparison === 0) {
				comparison = compareNullableNumbers(a.id ?? null, b.id ?? null)
			}

			return filesSortDirection === 'asc' ? comparison : -comparison
		})
	}

	function getDefaultFilesSortDirection(field) {
		if (field === 'created_at' || field === 'updated_at') {
			return 'desc'
		}
		if (field === 'row_count' || field === 'chromosome_count' || field === 'id') {
			return 'desc'
		}
		if (field === 'status') {
			return 'asc'
		}
		return 'asc'
	}

	async function loadFiles() {
		try {
			const files = await invoke('get_files')
			existingFilePaths = new Set(files.map((f) => f.file_path))
			allFilesData = files
			renderFilesTable()
		} catch (error) {
			console.error('Error loading files:', error)
		}
	}

	function fileMatchesSearch(file) {
		if (!filesSearchTerm) return true
		const term = filesSearchTerm
		const values = [
			file.id,
			file.status,
			file.participant_name,
			file.participant_id,
			file.file_path,
			file.data_type,
			file.source,
			file.grch_version,
			file.row_count,
			file.chromosome_count,
			file.inferred_sex,
			file.file_hash,
			file.created_at,
			file.updated_at,
		]
		return values.some((value) => {
			if (value === null || value === undefined) return false
			return value.toString().toLowerCase().includes(term)
		})
	}

	function renderFilesTable() {
		const tbody = document.getElementById('files-table')
		if (!tbody) return

		tbody.innerHTML = ''

		selectedFilesForDelete = selectedFilesForDelete.filter((id) =>
			allFilesData.some((f) => f.id === id),
		)

		const files = allFilesData.slice()
		const filteredFiles = files
			.filter((f) => f.data_type === currentFileTypeFilter)
			.filter(fileMatchesSearch)

		sortFilesForTable(filteredFiles)
		lastRenderedFileIds = filteredFiles.map((f) => f.id)

		filteredFiles.forEach((f) => {
			const row = document.createElement('tr')

			let statusBadge = ''
			if (f.status === 'pending') {
				statusBadge =
					'<span style="display: inline-flex; align-items: center; gap: 4px; background: #28a745; color: #fff; padding: 2px 6px; border-radius: 3px; font-size: 11px; font-weight: 500;"><img src="assets/icons/check-circle.svg" width="10" height="10" alt="" style="vertical-align: middle;" />IMPORTED</span>'
			} else if (f.status === 'processing') {
				statusBadge =
					'<span style="display: inline-flex; align-items: center; gap: 4px; background: #17a2b8; color: #fff; padding: 2px 6px; border-radius: 3px; font-size: 11px; font-weight: 500;"><img src="assets/icons/loader.svg" width="10" height="10" alt="" style="vertical-align: middle; animation: spin 1s linear infinite;" />PROCESSING</span>'
			} else if (f.status === 'error') {
				statusBadge =
					'<span style="display: inline-flex; align-items: center; gap: 4px; background: #dc3545; color: #fff; padding: 2px 6px; border-radius: 3px; font-size: 11px; font-weight: 500;" title="' +
					(f.processing_error || '') +
					'"><img src="assets/icons/x-circle.svg" width="10" height="10" alt="" style="vertical-align: middle;" />ERROR</span>'
			} else {
				statusBadge =
					'<span style="display: inline-flex; align-items: center; gap: 4px; background: #28a745; color: #fff; padding: 2px 6px; border-radius: 3px; font-size: 11px; font-weight: 500;"><img src="assets/icons/check-circle.svg" width="10" height="10" alt="" style="vertical-align: middle;" />COMPLETE</span>'
			}

			const isMarkedForDelete = selectedFilesForDelete.includes(f.id)

			row.innerHTML = `
				<td><input type="checkbox" class="file-checkbox" data-id="${f.id}" ${
					isMarkedForDelete ? 'checked' : ''
				} /></td>
				<td>${f.id}</td>
				<td>${statusBadge}</td>
				<td>${f.participant_name || '-'}</td>
				<td class="truncate" title="${f.file_path}">${f.file_path}</td>
				<td>${f.data_type || '-'}</td>
				<td>${f.source || '-'}</td>
				<td>${f.grch_version || '-'}</td>
				<td>${f.row_count ? f.row_count.toLocaleString() : '-'}</td>
				<td>${f.chromosome_count || '-'}</td>
				<td style="font-weight: ${f.inferred_sex ? '600' : 'normal'}; color: ${
					f.inferred_sex === 'Male' ? '#007bff' : f.inferred_sex === 'Female' ? '#e83e8c' : '#666'
				}">${f.inferred_sex || '-'}</td>
				<td style="font-family: monospace; font-size: 11px;" title="${f.file_hash}">${(
					f.file_hash || ''
				).substring(0, 16)}${f.file_hash && f.file_hash.length > 16 ? '...' : ''}</td>
				<td>${f.created_at}</td>
				<td>${f.updated_at}</td>
				<td><button class="open-finder-btn" data-path="${
					f.file_path
				}" style="padding: 4px 8px; background: #007bff; color: white; border: none; border-radius: 3px; cursor: pointer; font-size: 12px;">📁 Open</button></td>
			`
			tbody.appendChild(row)

			row.querySelector('.open-finder-btn').addEventListener('click', async () => {
				try {
					await invoke('show_in_folder', { filePath: f.file_path })
				} catch (error) {
					alert(`Error opening folder: ${error}`)
				}
			})
		})

		const setFileMarkedForDelete = (id, selected) => {
			if (selected) {
				if (!selectedFilesForDelete.includes(id)) {
					selectedFilesForDelete.push(id)
				}
			} else {
				selectedFilesForDelete = selectedFilesForDelete.filter((x) => x !== id)
			}

			const cb = document.querySelector(`#files-table .file-checkbox[data-id="${id}"]`)
			if (cb) cb.checked = selected
		}

		document.querySelectorAll('#files-table .file-checkbox').forEach((checkbox) => {
			checkbox.addEventListener('click', (e) => {
				const id = parseInt(e.target.dataset.id)
				if (e.shiftKey && lastClickedFileId !== null) {
					isRangeSelecting = true
					const start = lastRenderedFileIds.indexOf(lastClickedFileId)
					const end = lastRenderedFileIds.indexOf(id)
					const targetChecked = e.target.checked

					if (start !== -1 && end !== -1) {
						const from = Math.min(start, end)
						const to = Math.max(start, end)
						for (let i = from; i <= to; i++) {
							setFileMarkedForDelete(lastRenderedFileIds[i], targetChecked)
						}
					} else {
						setFileMarkedForDelete(id, targetChecked)
					}

					updateDeleteFilesButton()
					isRangeSelecting = false
				}
				lastClickedFileId = id
			})

			checkbox.addEventListener('change', (e) => {
				if (isRangeSelecting) return
				const id = parseInt(e.target.dataset.id)
				setFileMarkedForDelete(id, e.target.checked)
				updateDeleteFilesButton()
			})
		})

		document.getElementById('files-count').textContent = filteredFiles.length
		updateFilesSortIndicators()

		const pendingCount = allFilesData.filter((f) => f.status === 'pending').length
		const pendingCountEl = document.getElementById('pending-count')
		if (pendingCountEl) pendingCountEl.textContent = pendingCount

		const processQueueBtn = document.getElementById('process-queue-btn')
		if (processQueueBtn) {
			if (QUEUE_DISABLED) {
				processQueueBtn.style.display = 'none'
			} else if (pendingCount > 0) {
				processQueueBtn.style.display = 'flex'
			} else {
				processQueueBtn.style.display = 'none'
			}
		}

		const spinner = document.getElementById('queue-spinner')
		if (spinner) {
			spinner.style.display =
				!QUEUE_DISABLED && queueProcessorRunning && pendingCount > 0 ? 'inline-block' : 'none'
		}

		const selectAllHeader = document.getElementById('select-all-files-table')
		if (selectAllHeader) {
			const filteredCount = filteredFiles.length
			const selectedCount = filteredFiles.filter((f) =>
				selectedFilesForDelete.includes(f.id),
			).length
			selectAllHeader.checked = filteredCount > 0 && selectedCount === filteredCount
			selectAllHeader.indeterminate = selectedCount > 0 && selectedCount < filteredCount
		}

		updateDeleteFilesButton()
	}

	function updateFilesSortIndicators() {
		document.querySelectorAll('#files-view .sortable-files-header').forEach((header) => {
			const indicator = header.querySelector('.sort-indicator')
			if (!indicator) return

			if (header.dataset.sortField === filesSortField) {
				indicator.textContent = filesSortDirection === 'asc' ? ' ▲' : ' ▼'
			} else {
				indicator.textContent = ''
			}
		})
	}

	function updateDeleteFilesButton() {
		const btn = document.getElementById('delete-selected-files-btn')
		if (selectedFilesForDelete.length > 0) {
			btn.style.display = 'block'
			btn.textContent = `Delete Selected (${selectedFilesForDelete.length})`
		} else {
			btn.style.display = 'none'
		}
	}

	async function updateQueueButton() {
		if (QUEUE_DISABLED) return
		try {
			const isRunning = await invoke('get_queue_processor_status')
			const btn = document.getElementById('process-queue-btn')
			const icon = document.getElementById('queue-btn-icon')
			const text = document.getElementById('queue-btn-text')
			const spinner = document.getElementById('queue-spinner')
			queueProcessorRunning = isRunning
			const pendingCount = parseInt(document.getElementById('pending-count').textContent, 10) || 0

			if (btn && icon && text) {
				if (isRunning) {
					icon.innerHTML = '<img src="assets/icons/pause.svg" width="14" height="14" alt="" />'
					text.textContent = 'Pause Queue'
					btn.style.background = 'linear-gradient(135deg, #10b981 0%, #059669 100%)'
				} else {
					icon.innerHTML = '<img src="assets/icons/play.svg" width="14" height="14" alt="" />'
					text.textContent = 'Resume Queue'
					btn.style.background = 'linear-gradient(135deg, #f59e0b 0%, #d97706 100%)'
				}
			}

			if (spinner) {
				spinner.style.display = queueProcessorRunning && pendingCount > 0 ? 'inline-block' : 'none'
			}
		} catch (error) {
			console.error('Error getting queue status:', error)
		}
	}

	function initializeFilesTab() {
		const selectAllHeader = document.getElementById('select-all-files-table')
		if (selectAllHeader) {
			selectAllHeader.addEventListener('change', (e) => {
				const checkboxes = document.querySelectorAll('.file-checkbox')
				checkboxes.forEach((checkbox) => {
					checkbox.checked = e.target.checked
					const id = parseInt(checkbox.dataset.id)
					if (e.target.checked) {
						if (!selectedFilesForDelete.includes(id)) {
							selectedFilesForDelete.push(id)
						}
					} else {
						selectedFilesForDelete = selectedFilesForDelete.filter((x) => x !== id)
					}
				})
				updateDeleteFilesButton()
			})
		}

		const processQueueBtn = document.getElementById('process-queue-btn')
		if (processQueueBtn) {
			if (QUEUE_DISABLED) {
				processQueueBtn.style.display = 'none'
			} else {
				processQueueBtn.addEventListener('click', async () => {
					try {
						const isRunning = await invoke('get_queue_processor_status')

						if (isRunning) {
							await invoke('pause_queue_processor')
						} else {
							await invoke('resume_queue_processor')
						}

						await updateQueueButton()
						await loadFiles()
					} catch (error) {
						alert(`Error toggling queue processor: ${error}`)
					}
				})
			}
		}

		if (!QUEUE_DISABLED && !queueIntervalId) {
			queueIntervalId = setInterval(async () => {
				await updateQueueButton()

				const isFilesTabActive = document.getElementById('files-view')?.classList.contains('active')
				const pendingCount = parseInt(
					document.getElementById('pending-count')?.textContent || '0',
					10,
				)

				if (queueProcessorRunning && isFilesTabActive && pendingCount > 0) {
					await loadFiles()
				}
			}, 3000)
		}

		const deleteFilesBtn = document.getElementById('delete-selected-files-btn')
		if (deleteFilesBtn) {
			deleteFilesBtn.addEventListener('click', async () => {
				if (selectedFilesForDelete.length === 0) return

				const confirmed = await dialog.confirm(
					`Are you sure you want to delete ${selectedFilesForDelete.length} file(s)?`,
					{ title: 'Delete Files', type: 'warning' },
				)

				if (confirmed) {
					try {
						const deleted = await invoke('delete_files_bulk', { fileIds: selectedFilesForDelete })
						console.log(`Deleted ${deleted} file(s)`)
						await loadFiles()
					} catch (error) {
						await dialog.message(`Error deleting files: ${error}`, {
							title: 'Error',
							type: 'error',
						})
					}
				}
			})
		}

		const filesSearchInput = document.getElementById('files-search')
		if (filesSearchInput) {
			filesSearchInput.addEventListener('input', (e) => {
				filesSearchTerm = e.target.value.trim().toLowerCase()
				renderFilesTable()
			})
		}

		document.querySelectorAll('#files-view .sortable-files-header').forEach((header) => {
			header.addEventListener('click', () => {
				const field = header.dataset.sortField
				if (!field) return

				if (filesSortField === field) {
					filesSortDirection = filesSortDirection === 'asc' ? 'desc' : 'asc'
				} else {
					filesSortField = field
					filesSortDirection = getDefaultFilesSortDirection(field)
				}

				renderFilesTable()
			})
		})

		document.querySelectorAll('.file-type-tab').forEach((tab) => {
			tab.addEventListener('click', () => {
				const fileType = tab.dataset.type

				document.querySelectorAll('.file-type-tab').forEach((t) => {
					t.classList.remove('active')
					t.style.borderBottom = '3px solid transparent'
					t.style.color = '#666'
				})

				tab.classList.add('active')
				tab.style.borderBottom = '3px solid #007bff'
				tab.style.color = '#007bff'

				currentFileTypeFilter = fileType
				selectedFilesForDelete = []
				renderFilesTable()
			})
		})

		updateFilesSortIndicators()
		void updateQueueButton()
	}

	return {
		loadFiles,
		renderFilesTable,
		updateFilesSortIndicators,
		updateDeleteFilesButton,
		refreshExistingFilePaths,
		initializeFilesTab,
		isFileAlreadyImported: (filePath) => existingFilePaths.has(filePath),
		getExistingFilePaths: () => new Set(existingFilePaths),
	}
}
