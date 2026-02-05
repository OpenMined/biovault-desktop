const QUEUE_DISABLED = true

function getPathBasename(filePath) {
	if (!filePath) return ''
	const normalized = filePath.replace(/\\/g, '/')
	const parts = normalized.split('/')
	return parts[parts.length - 1] || ''
}

function buildDatasetAssetSyftUrl(ownerEmail, datasetName, filePath) {
	const fileName = getPathBasename(filePath)
	return `syft://${ownerEmail}/public/biovault/datasets/${datasetName}/assets/${fileName}`
}

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
	const activeDownloads = new Set()
	const downloadProgressCache = new Map()
	let downloadModalHandle = null
	let downloadProgressListener = null
	let lastClickedFileId = null
	let isRangeSelecting = false
	let currentEditingAssets = new Map()
	let currentEditingOriginalName = null
	let currentEditingWasPublished = false
	const publishingDatasets = new Set()
	const datasetProgressTimers = new Map()

	// Dataset editor state (paired asset model with per-asset mode)
	// Each asset: { name, mode: 'single'|'list', private: file|files[], mock: file|files[] }
	let datasetAssets = []
	let currentAssetIndex = null // Which asset row is being edited
	let currentAssetSide = null // 'private' or 'mock'

	// File picker state
	let _filePickerMode = null // 'private' or 'mock' (for current asset side)
	let filePickerSelectedIds = new Set()
	let filePickerSearchTerm = ''
	let filePickerTypeFilter = ''
	let filePickerLastClickedId = null // For shift-click range selection

	function setDatasetProgress(name, progress, text) {
		const row = document.querySelector(`.dataset-progress[data-dataset="${CSS.escape(name)}"]`)
		if (!row) return
		row.style.display = 'block'
		const bar = row.querySelector('.dataset-progress-fill')
		if (bar) bar.style.width = `${Math.min(100, Math.max(0, progress || 0))}%`
		const label = row.querySelector('.dataset-progress-text')
		if (label) label.textContent = text || `Syncing via SyftBox… ${Math.round(progress || 0)}%`
	}

	function clearDatasetProgress(name) {
		const row = document.querySelector(`.dataset-progress[data-dataset="${CSS.escape(name)}"]`)
		if (row) row.style.display = 'none'
		if (datasetProgressTimers.has(name)) {
			clearTimeout(datasetProgressTimers.get(name))
			datasetProgressTimers.delete(name)
		}
	}

	function toggleSampleDataPanel(forceOpen = null) {
		const panel = document.getElementById('sample-data-panel')
		if (!panel) return
		if (forceOpen === true) {
			panel.removeAttribute('hidden')
			return
		}
		if (forceOpen === false) {
			panel.setAttribute('hidden', '')
			return
		}
		if (panel.hasAttribute('hidden')) {
			panel.removeAttribute('hidden')
		} else {
			panel.setAttribute('hidden', '')
		}
	}

	async function handleSampleDataImport(sampleId, buttonEl) {
		if (!sampleId) return
		const originalText = buttonEl?.textContent
		const progressEl = document.querySelector(
			`.sample-data-progress[data-progress-id="${sampleId}"]`,
		)
		let cancelRequested = false
		let modalHandle = null
		try {
			// Check if the sample is already downloaded
			const existingSampleDir = await invoke('check_sample_downloaded', { sampleId })
			if (existingSampleDir) {
				// Sample is already downloaded, skip to import
				if (typeof window.openImportModalWithFolder === 'function') {
					await window.openImportModalWithFolder(existingSampleDir)
				}
				toggleSampleDataPanel(false)
				return
			}

			if (sampleId === 'na06985-full') {
				if (activeDownloads.has('sample_data')) {
					openDownloadModal({
						downloadId: 'sample_data',
						title: 'Downloading NA06985 (Full CRAM)',
						body: 'Download in progress. Closing this window will not stop the download.',
						links: [
							{
								label: 'Reference (GRCh38 full)',
								href: 'https://ftp.1000genomes.ebi.ac.uk/vol1/ftp/technical/reference/GRCh38_reference_genome/GRCh38_full_analysis_set_plus_decoy_hla.fa',
							},
							{
								label: 'Reference index (.fai)',
								href: 'https://ftp.1000genomes.ebi.ac.uk/vol1/ftp/technical/reference/GRCh38_reference_genome/GRCh38_full_analysis_set_plus_decoy_hla.fa.fai',
							},
							{
								label: 'Aligned CRAM (NA06985)',
								href: 'https://ftp-trace.ncbi.nih.gov/1000genomes/ftp/1000G_2504_high_coverage/data/ERR3239276/NA06985.final.cram',
							},
							{
								label: 'Aligned index (.crai)',
								href: 'https://ftp-trace.ncbi.nih.gov/1000genomes/ftp/1000G_2504_high_coverage/data/ERR3239276/NA06985.final.cram.crai',
							},
						],
					})
					return
				}
				modalHandle = openDownloadModal({
					downloadId: 'sample_data',
					title: 'Downloading NA06985 (Full CRAM)',
					body: 'This download is large (~20GB). Closing this window will not stop the download.',
					links: [
						{
							label: 'Reference (GRCh38 full)',
							href: 'https://ftp.1000genomes.ebi.ac.uk/vol1/ftp/technical/reference/GRCh38_reference_genome/GRCh38_full_analysis_set_plus_decoy_hla.fa',
						},
						{
							label: 'Reference index (.fai)',
							href: 'https://ftp.1000genomes.ebi.ac.uk/vol1/ftp/technical/reference/GRCh38_reference_genome/GRCh38_full_analysis_set_plus_decoy_hla.fa.fai',
						},
						{
							label: 'Aligned CRAM (NA06985)',
							href: 'https://ftp-trace.ncbi.nih.gov/1000genomes/ftp/1000G_2504_high_coverage/data/ERR3239276/NA06985.final.cram',
						},
						{
							label: 'Aligned index (.crai)',
							href: 'https://ftp-trace.ncbi.nih.gov/1000genomes/ftp/1000G_2504_high_coverage/data/ERR3239276/NA06985.final.cram.crai',
						},
					],
					onCancel: () => {
						cancelRequested = true
					},
				})
			}
			if (buttonEl) {
				buttonEl.textContent = 'Downloading...'
			}
			if (progressEl) progressEl.removeAttribute('hidden')
			activeDownloads.add('sample_data')
			const result = await invoke('fetch_sample_data_with_progress', { samples: [sampleId] })
			const sampleDir = result?.sample_dir || result?.sampleDir || result
			if (!cancelRequested && sampleDir && typeof window.openImportModalWithFolder === 'function') {
				await window.openImportModalWithFolder(sampleDir)
			}
			if (!cancelRequested) {
				toggleSampleDataPanel(false)
			}
		} catch (error) {
			console.error('Sample data download failed:', error)
			await dialog.message(`Failed to download sample data: ${error}`, {
				title: 'Sample Data Error',
				type: 'error',
			})
		} finally {
			activeDownloads.delete('sample_data')
			if (buttonEl) {
				if (originalText != null) buttonEl.textContent = originalText
			}
			if (progressEl) progressEl.setAttribute('hidden', '')
			if (modalHandle) modalHandle.close()
		}
	}

	function openDownloadModal({ downloadId, title, body, onCancel, links }) {
		const existing = document.getElementById('large-download-modal')
		if (existing) existing.remove()

		const overlay = document.createElement('div')
		overlay.id = 'large-download-modal'
		overlay.className = 'download-modal-overlay'

		const modal = document.createElement('div')
		modal.className = 'download-modal-card'
		const linksHtml = Array.isArray(links)
			? `
				<div class="download-modal-links">
					<div class="download-modal-links-title">Direct download links</div>
					${links
						.map(
							(link) => `
								<a href="${link.href}" class="download-modal-link" target="_blank" rel="noreferrer">
									${link.label}
								</a>
							`,
						)
						.join('')}
				</div>
			`
			: ''

		modal.innerHTML = `
			<div class="download-modal-header">
				<h3>${title || 'Downloading...'}</h3>
				<button class="btn-text" data-role="close">Close</button>
			</div>
			<p class="download-modal-body">${body || ''}</p>
			${linksHtml}
			<div class="sample-data-progress">
				<div class="sample-data-progress-bar" data-role="progress-bar"></div>
			</div>
			<div class="sample-data-progress-text" data-role="progress-text">Preparing download…</div>
			<div class="download-modal-actions">
				<button class="btn-secondary" data-role="cancel">Cancel Download</button>
			</div>
		`

		const close = () => {
			overlay.remove()
			if (downloadModalHandle?.downloadId === downloadId) {
				downloadModalHandle = null
			}
		}
		modal.querySelector('[data-role="close"]')?.addEventListener('click', close)
		modal.querySelector('[data-role="cancel"]')?.addEventListener('click', () => {
			if (typeof onCancel === 'function') onCancel()
			close()
		})

		overlay.appendChild(modal)
		document.body.appendChild(overlay)
		const progressBar = modal.querySelector('[data-role="progress-bar"]')
		const progressText = modal.querySelector('[data-role="progress-text"]')
		const setProgress = (downloaded, total, fileLabel) => {
			if (!progressBar || !progressText) return
			const hasTotal = typeof total === 'number' && total > 0
			if (hasTotal) {
				const percent = Math.max(0, Math.min(100, (downloaded / total) * 100))
				progressBar.classList.add('is-determinate')
				progressBar.style.width = `${percent}%`
				progressText.textContent = fileLabel
					? `Downloading ${fileLabel}… ${Math.round(percent)}%`
					: `Downloading… ${Math.round(percent)}%`
			} else {
				progressBar.classList.remove('is-determinate')
				progressBar.style.width = '100%'
				progressText.textContent = fileLabel ? `Downloading ${fileLabel}…` : 'Downloading…'
			}
		}
		const handle = { close, setProgress, downloadId }
		downloadModalHandle = handle

		const cached = downloadProgressCache.get(downloadId)
		if (cached) {
			setProgress(cached.downloaded, cached.total, cached.file)
		}
		return handle
	}

	async function monitorDatasetSync(name) {
		// Avoid multiple monitors per dataset
		if (datasetProgressTimers.has(name)) return

		const loop = async () => {
			let shouldStop = false
			try {
				const data = await invoke('syftbox_queue_status')
				const uploads = data?.uploads || []
				const syncFiles = data?.sync?.files || []
				const matchesUpload = uploads.filter(
					(u) => u.key?.includes(`/datasets/${name}`) || u.key?.includes(name),
				)
				const matchesSync = syncFiles.filter((f) => f.path?.includes(`/datasets/${name}`))
				const progresses = [...matchesUpload, ...matchesSync]
				if (progresses.length === 0) {
					clearDatasetProgress(name)
					shouldStop = true
				} else {
					const maxProgress = Math.max(...progresses.map((p) => p.progress || 0))
					setDatasetProgress(name, maxProgress, `Syncing via SyftBox… ${maxProgress.toFixed(1)}%`)
				}
			} catch (err) {
				console.warn('Dataset sync monitor error:', err)
			} finally {
				if (!shouldStop) {
					const handle = setTimeout(loop, 2000)
					datasetProgressTimers.set(name, handle)
				} else {
					datasetProgressTimers.delete(name)
				}
			}
		}

		loop()
	}

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
		if (!mode || (mode !== 'participants' && mode !== 'datasets' && mode !== 'references')) return
		viewMode = mode
		const participantSection = document.getElementById('participant-data-section')
		const datasetSection = document.getElementById('dataset-data-section')
		const referenceSection = document.getElementById('reference-data-section')
		const datasetEditorSection = document.getElementById('dataset-editor-section')
		if (participantSection && datasetSection) {
			participantSection.style.display = mode === 'participants' ? 'flex' : 'none'
			datasetSection.style.display = mode === 'datasets' ? 'flex' : 'none'
			if (referenceSection) {
				referenceSection.style.display = mode === 'references' ? 'flex' : 'none'
			}
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
			} else if (mode === 'references') {
				pageSubtitle.textContent = 'Shared genome references and indexes'
			} else {
				pageSubtitle.textContent = 'Imported files and analysis results'
			}
		}

		// Update search placeholder based on view
		const searchInput = document.getElementById('file-search')
		if (searchInput) {
			searchInput.placeholder =
				mode === 'datasets'
					? 'Search datasets...'
					: mode === 'references'
						? 'Search references...'
						: 'Search files...'
		}

		const globalEmptyState = document.getElementById('data-empty-state')
		if (globalEmptyState) {
			globalEmptyState.style.display = mode === 'datasets' ? 'none' : globalEmptyState.style.display
		}

		if (mode === 'datasets') {
			void loadDatasets()
		} else if (mode === 'references') {
			renderReferencesPanel()
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

	function normalizeDataType(value) {
		return (value || '').toString().trim().toLowerCase()
	}

	function isReferenceDataType(value) {
		const dt = normalizeDataType(value)
		return dt === 'reference' || dt === 'referenceindex'
	}

	function isIndexDataType(value) {
		const dt = normalizeDataType(value)
		return dt === 'alignedindex' || dt === 'referenceindex'
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
		// Queue disabled - always show as imported for pending status
		return `<span class="status-badge status-complete" title="Imported">
			<img src="assets/icons/check-circle.svg" width="12" height="12" alt="" style="margin-right: 4px; vertical-align: middle;" />
			IMPORTED
		</span>`
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
		const setFileSelected = (targetId, selected) => {
			if (selected) {
				if (!selectedFileIds.includes(targetId)) {
					selectedFileIds.push(targetId)
				}
			} else {
				selectedFileIds = selectedFileIds.filter((id) => id !== targetId)
			}

			const targetRow = document.querySelector(`tr[data-file-id="${targetId}"]`)
			if (targetRow) {
				targetRow.classList.toggle('selected', selected)
				const cb = targetRow.querySelector('.file-checkbox')
				if (cb) cb.checked = selected
			}
		}

		checkbox.addEventListener('click', (e) => {
			const fileId = parseInt(e.target.dataset.id)
			if (e.shiftKey && lastClickedFileId !== null) {
				isRangeSelecting = true
				const ids = filesToDisplay.map((f) => f.id)
				const start = ids.indexOf(lastClickedFileId)
				const end = ids.indexOf(fileId)
				const targetChecked = checkbox.checked

				if (start !== -1 && end !== -1) {
					const from = Math.min(start, end)
					const to = Math.max(start, end)
					for (let i = from; i <= to; i++) {
						setFileSelected(ids[i], targetChecked)
					}
				} else {
					setFileSelected(fileId, targetChecked)
				}

				updateDeleteButton()
				updateSelectAllCheckbox()
				updateActionButtons()
				syncSelectionToSessionStorage()
				isRangeSelecting = false
			}
			lastClickedFileId = fileId
		})

		checkbox.addEventListener('change', (e) => {
			if (isRangeSelecting) return
			const fileId = parseInt(e.target.dataset.id)
			setFileSelected(fileId, e.target.checked)
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
		filesToDisplay = allFiles
			.filter(matchesDataTypeFilter)
			.filter(matchesFileSearch)
			.filter((file) => {
				const dt = file?.data_type || ''
				if (isReferenceDataType(dt)) return false
				if (isIndexDataType(dt)) return false
				return true
			})

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

	function renderReferencesPanel() {
		const tbody = document.getElementById('references-table-body')
		const emptyState = document.getElementById('references-empty-state')
		if (!tbody) return
		tbody.innerHTML = ''

		const referenceFiles = allFiles
			.filter((file) => isReferenceDataType(file?.data_type))
			.filter(matchesFileSearch)

		if (referenceFiles.length === 0) {
			if (emptyState) emptyState.style.display = 'flex'
			return
		}
		if (emptyState) emptyState.style.display = 'none'

		referenceFiles.forEach((file) => {
			const row = document.createElement('tr')
			const fileName = file.file_path.split('/').pop()
			row.innerHTML = `
				<td class="col-file" title="${file.file_path}">
					<span style="color: #94a3b8; font-size: 12px;">${file.file_path.split('/').slice(-2, -1)[0] || ''}${
						file.file_path.split('/').slice(-2, -1)[0] ? '/' : ''
					}</span>
					<span style="font-weight: 500; color: #1e293b;">${fileName}</span>
				</td>
				<td class="col-type">${file.data_type || '-'}</td>
				<td class="col-grch">${file.grch_version || '-'}</td>
				<td class="col-actions">
					<button class="show-in-folder-btn" title="Show in Finder">
						<img src="assets/icons/folder-open.svg" width="16" height="16" alt="" />
					</button>
				</td>
			`
			row.querySelector('button')?.addEventListener('click', async () => {
				try {
					await invoke('show_in_folder', { filePath: file.file_path })
				} catch (error) {
					console.error('Failed to show file in folder:', error)
				}
			})
			tbody.appendChild(row)
		})
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
			if (runText) runText.textContent = `Run Flow`

			if (selectionActionsGroup) {
				const countText = document.getElementById('selection-count-text')
				if (countText) {
					countText.textContent = fileCount.toString()
				}
				selectionActionsGroup.style.display = 'flex'
			}
		} else {
			if (runText) runText.textContent = 'Run Flow'
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
		if (QUEUE_DISABLED) return
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
		// Queue disabled - hide UI elements and return early
		const queueCard = document.getElementById('queue-card-container')
		const clearQueueBtn = document.getElementById('clear-queue-btn')
		const processQueueBtn = document.getElementById('process-queue-btn')
		if (queueCard) queueCard.style.display = 'none'
		if (clearQueueBtn) clearQueueBtn.style.display = 'none'
		if (processQueueBtn) processQueueBtn.style.display = 'none'
		return
		/* try {
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
		} */
	}

	// ============================================================================
	// QUEUE INFORMATION
	// ============================================================================

	async function fetchQueueInfo() {
		return
		/* try {
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
		} */
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

	// ============================================================================
	// FILE PICKER MODAL
	// ============================================================================

	async function openFilePicker(mode = 'private') {
		_filePickerMode = mode
		filePickerSelectedIds = new Set()
		filePickerSearchTerm = ''
		filePickerTypeFilter = ''
		filePickerLastClickedId = null

		const modal = document.getElementById('file-picker-modal')
		const title = document.getElementById('file-picker-title')
		const searchInput = document.getElementById('file-picker-search')
		const typeFilter = document.getElementById('file-picker-type-filter')
		const selectAll = document.getElementById('file-picker-select-all')
		const selectAllRow = document.getElementById('file-picker-select-all-row')

		if (!modal) return

		// Ensure we have the latest files
		if (allFiles.length === 0) {
			try {
				const files = await invoke('list_files')
				allFiles = files || []
				console.log(`File picker loaded ${allFiles.length} files`)
			} catch (err) {
				console.error('Failed to load files for picker:', err)
			}
		}

		// Check if current asset is in single mode
		const asset = currentAssetIndex !== null ? datasetAssets[currentAssetIndex] : null
		const isSingleMode = asset?.mode === 'single'

		// Update title based on mode
		if (title) {
			const modeLabel = mode === 'private' ? 'Private' : 'Mock'
			title.textContent = isSingleMode
				? `Select ${modeLabel} File (Single)`
				: `Select ${modeLabel} Files`
		}

		// Update add button label to match the side
		const addLabel = document.getElementById('file-picker-add-label')
		if (addLabel) {
			addLabel.textContent = mode === 'private' ? 'Add as Private' : 'Add as Mock'
		}

		// Hide select all in single mode
		if (selectAllRow) {
			selectAllRow.style.display = isSingleMode ? 'none' : ''
		}

		// Reset controls
		if (searchInput) searchInput.value = ''
		if (selectAll) selectAll.checked = false

		// Populate type filter dropdown
		if (typeFilter) {
			const types = [...new Set(allFiles.map((f) => f.data_type).filter(Boolean))]
			typeFilter.innerHTML = '<option value="">All Types</option>'
			types.forEach((type) => {
				const opt = document.createElement('option')
				opt.value = type
				opt.textContent = type
				typeFilter.appendChild(opt)
			})
		}

		// Populate file list
		populateFilePicker()

		// Show modal
		modal.style.display = 'flex'
	}

	function closeFilePicker() {
		const modal = document.getElementById('file-picker-modal')
		if (modal) {
			modal.style.display = 'none'
		}
		_filePickerMode = null
		filePickerSelectedIds = new Set()
	}

	function getFilteredPickerFiles() {
		return allFiles.filter((file) => {
			// Show complete files, or pending/processing if no complete files exist
			const validStatuses = ['complete', 'pending', 'processing']
			if (!validStatuses.includes(file.status)) return false

			// Apply type filter
			if (filePickerTypeFilter && file.data_type !== filePickerTypeFilter) return false

			// Apply search filter
			if (filePickerSearchTerm) {
				const term = filePickerSearchTerm.toLowerCase()
				const searchFields = [file.file_path, file.participant_id, file.data_type, file.source]
					.filter(Boolean)
					.map((s) => s.toLowerCase())
				if (!searchFields.some((field) => field.includes(term))) return false
			}

			return true
		})
	}

	function populateFilePicker() {
		const listContainer = document.getElementById('file-picker-list')
		const summaryEl = document.getElementById('file-picker-summary')

		if (!listContainer) return

		const filteredFiles = getFilteredPickerFiles()

		if (filteredFiles.length === 0) {
			listContainer.innerHTML = `
				<div style="display: flex; flex-direction: column; align-items: center; justify-content: center; height: 100%; color: var(--text-secondary); padding: 40px;">
					<svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" style="opacity: 0.5; margin-bottom: 12px;">
						<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path>
						<polyline points="14 2 14 8 20 8"></polyline>
					</svg>
					<p style="margin: 0; font-size: 14px;">No files found</p>
					<p style="margin: 4px 0 0 0; font-size: 12px; opacity: 0.7;">Try adjusting your filters or import some files first</p>
				</div>
			`
			if (summaryEl) summaryEl.textContent = '0 files selected'
			return
		}

		// Build file list with checkboxes
		listContainer.innerHTML = ''

		const table = document.createElement('table')
		table.className = 'file-picker-table'
		table.style.cssText = 'width: 100%; border-collapse: collapse; font-size: 13px;'

		const thead = document.createElement('thead')
		thead.innerHTML = `
			<tr style="background: var(--bg-secondary); position: sticky; top: 0; z-index: 1;">
				<th style="width: 40px; padding: 8px; text-align: center;"></th>
				<th style="padding: 8px; text-align: left;">Participant</th>
				<th style="padding: 8px; text-align: left;">Filename</th>
				<th style="padding: 8px; text-align: left;">Type</th>
				<th style="padding: 8px; text-align: left;">Source</th>
			</tr>
		`
		table.appendChild(thead)

		const tbody = document.createElement('tbody')

		filteredFiles.forEach((file) => {
			const row = document.createElement('tr')
			row.className = 'file-picker-row'
			row.dataset.fileId = file.id
			row.style.cssText = 'cursor: pointer; border-bottom: 1px solid var(--border-color);'

			const isSelected = filePickerSelectedIds.has(file.id)
			if (isSelected) row.style.background = 'var(--bg-hover)'

			const fileName = file.file_path.split('/').pop()

			row.innerHTML = `
				<td style="padding: 8px; text-align: center;">
					<input type="checkbox" class="file-picker-checkbox" data-id="${file.id}" ${isSelected ? 'checked' : ''} />
				</td>
				<td style="padding: 8px;">${file.participant_id || '<span style="color: var(--text-secondary); font-style: italic;">Unassigned</span>'}</td>
				<td style="padding: 8px; max-width: 300px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;" title="${file.file_path}">${fileName}</td>
				<td style="padding: 8px;">
					<span class="type-badge type-${(file.data_type || 'unknown').toLowerCase()}">${file.data_type || '-'}</span>
				</td>
				<td style="padding: 8px;">${file.source || '-'}</td>
			`

			// Unified click handler for row and checkbox with shift-click support
			const handleSelection = (fileId, checked, shiftKey) => {
				const asset = currentAssetIndex !== null ? datasetAssets[currentAssetIndex] : null
				const isSingleMode = asset?.mode === 'single'

				if (checked) {
					if (isSingleMode) {
						// In single mode, deselect all others first
						filePickerSelectedIds.clear()
						listContainer.querySelectorAll('.file-picker-checkbox').forEach((cb) => {
							cb.checked = false
							cb.closest('tr').style.background = ''
						})
						filePickerSelectedIds.add(fileId)
						row.style.background = 'var(--bg-hover)'
						const cb = row.querySelector('.file-picker-checkbox')
						if (cb) cb.checked = true
					} else if (shiftKey && filePickerLastClickedId !== null) {
						// Shift-click range selection (only in list mode)
						const allRows = Array.from(listContainer.querySelectorAll('.file-picker-row'))
						const lastIndex = allRows.findIndex(
							(r) => parseInt(r.dataset.fileId) === filePickerLastClickedId,
						)
						const currentIndex = allRows.findIndex((r) => parseInt(r.dataset.fileId) === fileId)
						if (lastIndex !== -1 && currentIndex !== -1) {
							const start = Math.min(lastIndex, currentIndex)
							const end = Math.max(lastIndex, currentIndex)
							for (let i = start; i <= end; i++) {
								const rowToSelect = allRows[i]
								const idToSelect = parseInt(rowToSelect.dataset.fileId)
								filePickerSelectedIds.add(idToSelect)
								rowToSelect.style.background = 'var(--bg-hover)'
								const cb = rowToSelect.querySelector('.file-picker-checkbox')
								if (cb) cb.checked = true
							}
						}
					} else {
						filePickerSelectedIds.add(fileId)
						row.style.background = 'var(--bg-hover)'
					}
					filePickerLastClickedId = fileId
				} else {
					filePickerSelectedIds.delete(fileId)
					row.style.background = ''
					const cb = row.querySelector('.file-picker-checkbox')
					if (cb) cb.checked = false
					filePickerLastClickedId = fileId
				}
				updateFilePickerSummary()
				updateFilePickerSelectAll()
			}

			// Row click toggles selection (with shift-click support)
			row.addEventListener('click', (e) => {
				if (e.target.type === 'checkbox') return
				const checkbox = row.querySelector('.file-picker-checkbox')
				if (checkbox) {
					const newChecked = !filePickerSelectedIds.has(file.id)
					handleSelection(file.id, newChecked, e.shiftKey)
				}
			})

			// Checkbox change handler
			const checkbox = row.querySelector('.file-picker-checkbox')
			if (checkbox) {
				checkbox.addEventListener('click', (e) => {
					e.stopPropagation() // Prevent row click from firing
					const fileId = parseInt(e.target.dataset.id)
					// The checkbox state has already toggled, so use its current checked state
					handleSelection(fileId, e.target.checked, e.shiftKey)
				})
			}

			tbody.appendChild(row)
		})

		table.appendChild(tbody)
		listContainer.appendChild(table)

		updateFilePickerSummary()
		updateFilePickerSelectAll()
	}

	function updateFilePickerSummary() {
		const summaryEl = document.getElementById('file-picker-summary')
		if (summaryEl) {
			const count = filePickerSelectedIds.size
			summaryEl.textContent = `${count} file${count !== 1 ? 's' : ''} selected`
		}
	}

	function updateFilePickerSelectAll() {
		const selectAll = document.getElementById('file-picker-select-all')
		if (!selectAll) return

		const filteredFiles = getFilteredPickerFiles()
		const allSelected =
			filteredFiles.length > 0 && filteredFiles.every((f) => filePickerSelectedIds.has(f.id))
		const someSelected = filteredFiles.some((f) => filePickerSelectedIds.has(f.id))

		selectAll.checked = allSelected
		selectAll.indeterminate = someSelected && !allSelected
	}

	function addSelectedFilesToDataset() {
		if (filePickerSelectedIds.size === 0) return
		if (currentAssetIndex === null || currentAssetSide === null) return

		const selectedFiles = allFiles.filter((f) => filePickerSelectedIds.has(f.id))
		const asset = datasetAssets[currentAssetIndex]
		if (!asset) return

		selectedFiles.forEach((file) => {
			const fileEntry = {
				id: file.id,
				file_path: file.file_path,
				participant_id: file.participant_id,
				data_type: file.data_type,
			}

			if (asset.mode === 'single') {
				// Single mode: replace the file on this side
				asset[currentAssetSide] = fileEntry
			} else {
				// List mode: add to the array if not already there
				if (!Array.isArray(asset[currentAssetSide])) {
					asset[currentAssetSide] = []
				}
				if (!asset[currentAssetSide].some((f) => f.id === file.id)) {
					asset[currentAssetSide].push(fileEntry)
				}
			}
		})

		closeFilePicker()
		renderDatasetAssets()
		updateEditorPreview()
	}

	// URL Input Modal state
	let urlInputAsset = null
	let _urlInputAssetIndex = null
	let urlInputSide = null

	function openUrlInputModal(asset, assetIndex, side) {
		urlInputAsset = asset
		_urlInputAssetIndex = assetIndex
		urlInputSide = side

		const modal = document.getElementById('url-input-modal')
		const input = document.getElementById('url-input-field')
		const status = document.getElementById('url-validation-status')

		if (modal) modal.classList.remove('hidden')
		if (input) {
			input.value = ''
			input.focus()
		}
		if (status) status.style.display = 'none'
	}

	function closeUrlInputModal() {
		const modal = document.getElementById('url-input-modal')
		if (modal) modal.classList.add('hidden')
		urlInputAsset = null
		_urlInputAssetIndex = null
		urlInputSide = null
	}

	function isValidUrl(str) {
		try {
			if (str.startsWith('syft://')) {
				return str.length > 7 && str.includes('@')
			}
			const url = new URL(str)
			return url.protocol === 'http:' || url.protocol === 'https:'
		} catch {
			return false
		}
	}

	async function validateAndAddUrl() {
		const input = document.getElementById('url-input-field')
		const status = document.getElementById('url-validation-status')
		const statusText = document.getElementById('url-validation-text')

		const url = input?.value?.trim()
		if (!url) {
			if (status) {
				status.style.display = 'block'
				status.style.color = 'var(--error-color, #ef4444)'
				statusText.textContent = 'Please enter a URL'
			}
			return
		}

		if (!isValidUrl(url)) {
			if (status) {
				status.style.display = 'block'
				status.style.color = 'var(--error-color, #ef4444)'
				statusText.textContent = 'Invalid URL format. Use http://, https://, or syft:// URLs'
			}
			return
		}

		// For http/https URLs, try to check if reachable
		if (url.startsWith('http://') || url.startsWith('https://')) {
			if (status) {
				status.style.display = 'block'
				status.style.color = 'var(--text-secondary)'
				statusText.textContent = 'Checking URL...'
			}

			try {
				const _response = await fetch(url, { method: 'HEAD', mode: 'no-cors' })
				// no-cors returns opaque response, so we can't check status
				// Just proceed since the fetch didn't throw
			} catch (err) {
				// URL might be unreachable, but we'll still allow it with a warning
				const confirmed = await dialog.ask(
					`Could not verify the URL is reachable:\n${url}\n\nThis might be due to CORS restrictions. Add it anyway?`,
					{ title: 'URL Warning', kind: 'warning' },
				)
				if (!confirmed) {
					if (status) {
						status.style.display = 'block'
						status.style.color = 'var(--error-color, #ef4444)'
						statusText.textContent = 'URL not added'
					}
					return
				}
			}
		}

		// Add the URL as a file entry
		const fileEntry = {
			id: null,
			file_path: url,
			participant_id: null,
			data_type: null,
			is_url: true,
		}

		const asset = urlInputAsset
		const side = urlInputSide

		if (asset.mode === 'single') {
			asset[side] = fileEntry
		} else {
			if (!Array.isArray(asset[side])) {
				asset[side] = []
			}
			if (!asset[side].some((f) => f.file_path === url)) {
				asset[side].push(fileEntry)
			}
		}

		closeUrlInputModal()
		renderDatasetAssets()
		updateEditorPreview()
	}

	// Run Flow Modal state
	let runFlowDatasetName = null
	let runFlowDatasetEntry = null

	function openRunFlowModal(datasetName, datasetEntry) {
		runFlowDatasetName = datasetName
		runFlowDatasetEntry = datasetEntry

		const modal = document.getElementById('run-flow-modal')
		if (modal) modal.classList.remove('hidden')

		// Reset to mock selection
		const mockRadio = document.querySelector('input[name="flow-data-type"][value="mock"]')
		if (mockRadio) mockRadio.checked = true
	}

	function closeRunFlowModal() {
		const modal = document.getElementById('run-flow-modal')
		if (modal) modal.classList.add('hidden')
		runFlowDatasetName = null
		runFlowDatasetEntry = null
	}

	async function confirmRunFlow() {
		const selectedType = document.querySelector('input[name="flow-data-type"]:checked')?.value
		if (!selectedType || !runFlowDatasetName) {
			closeRunFlowModal()
			return
		}

		const datasetName = runFlowDatasetName
		const entry = runFlowDatasetEntry
		closeRunFlowModal()

		// Navigate to flows and pre-select this dataset
		if (window.__flowsModule?.openRunFlowWithDataset) {
			// openRunFlowWithDataset handles navigation internally
			window.__flowsModule.openRunFlowWithDataset({
				name: datasetName,
				dataType: selectedType,
				entry,
			})
		} else if (window.navigateTo) {
			// Fallback: store in sessionStorage for flows to pick up
			sessionStorage.setItem(
				'pendingFlowRun',
				JSON.stringify({
					datasetName,
					dataType: selectedType,
				}),
			)
			window.navigateTo('flows')
		}
	}

	function addNewAsset() {
		const assetNum = datasetAssets.length + 1
		const emptyAsset = {
			name: `asset_${assetNum}`,
			mode: 'single',
			private: null,
			mock: null,
		}
		datasetAssets.push(emptyAsset)
		renderDatasetAssets()
		updateEditorPreview()
	}

	function removeAsset(index) {
		datasetAssets.splice(index, 1)
		renderDatasetAssets()
		updateEditorPreview()
	}

	function openAssetFilePicker(assetIndex, side) {
		currentAssetIndex = assetIndex
		currentAssetSide = side
		_filePickerMode = side
		openFilePicker(side)
	}

	function setAssetMode(index, mode) {
		const asset = datasetAssets[index]
		if (!asset || asset.mode === mode) return

		if (mode === 'single') {
			// Convert from list to single (take first file)
			asset.private = Array.isArray(asset.private) ? asset.private[0] || null : asset.private
			asset.mock = Array.isArray(asset.mock) ? asset.mock[0] || null : asset.mock
		} else {
			// Convert from single to list
			asset.private = asset.private ? [asset.private] : []
			asset.mock = asset.mock ? [asset.mock] : []
		}
		asset.mode = mode

		renderDatasetAssets()
		updateEditorPreview()
	}

	function updateAssetName(index, name) {
		const asset = datasetAssets[index]
		if (asset) {
			asset.name = name.toLowerCase().replace(/[^a-z0-9_]/g, '_')
		}
	}

	function renderDatasetAssets() {
		const container = document.getElementById('dataset-assets-list')
		if (!container) return

		if (datasetAssets.length === 0) {
			container.innerHTML = `
				<div class="assets-empty" style="padding: 24px; text-align: center; color: #9ca3af; font-size: 13px;">
					No assets added yet. Click "Add Asset" below to get started.
				</div>
			`
			return
		}

		container.innerHTML = ''

		datasetAssets.forEach((asset, index) => {
			const row = document.createElement('div')
			row.className = 'asset-row'
			row.dataset.index = index

			const isSingle = asset.mode === 'single'

			row.innerHTML = `
				<div class="asset-row-header">
					<div class="asset-row-top">
						<div class="asset-row-name">
							<label class="asset-name-label">Asset Name</label>
							<input type="text" class="asset-name-input" value="${asset.name || ''}"
								placeholder="asset_name" data-index="${index}"
								title="Asset identifier (lowercase, underscores)"/>
						</div>
						<button class="asset-row-remove" type="button" title="Remove asset" data-index="${index}">
							<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
								<line x1="18" y1="6" x2="6" y2="18"></line>
								<line x1="6" y1="6" x2="18" y2="18"></line>
							</svg>
						</button>
					</div>
					<div class="asset-row-mode">
						<span class="asset-mode-label">Mode:</span>
						<div class="pill-toggle pill-toggle-xs">
							<button class="pill-button ${isSingle ? 'active' : ''}" data-mode="single" data-index="${index}" type="button">Single File</button>
							<button class="pill-button ${!isSingle ? 'active' : ''}" data-mode="list" data-index="${index}" type="button">File List</button>
						</div>
					</div>
				</div>
				<div class="asset-row-content">
					<div class="asset-side private">
						<div class="asset-side-header">🔒 Private</div>
						${renderAssetSide(asset, index, 'private')}
					</div>
					<div class="asset-side mock">
						<div class="asset-side-header">📋 Mock</div>
						${renderAssetSide(asset, index, 'mock')}
					</div>
				</div>
			`

			// Add event listeners
			const removeBtn = row.querySelector('.asset-row-remove')
			removeBtn.addEventListener('click', () => removeAsset(index))

			// Asset name input
			const nameInput = row.querySelector('.asset-name-input')
			nameInput.addEventListener('input', (e) => updateAssetName(index, e.target.value))

			// Mode toggle buttons
			row.querySelectorAll('.asset-row-mode .pill-button').forEach((btn) => {
				btn.addEventListener('click', () => {
					const mode = btn.dataset.mode
					setAssetMode(index, mode)
				})
			})

			// "Existing Files" buttons - open file picker
			row.querySelectorAll('.btn-existing-files').forEach((btn) => {
				btn.addEventListener('click', () => {
					const side = btn.dataset.side
					openAssetFilePicker(index, side)
				})
			})

			// "Browse" buttons - open file dialog
			row.querySelectorAll('.btn-browse-files').forEach((btn) => {
				btn.addEventListener('click', async () => {
					const side = btn.dataset.side
					const multiple = asset.mode === 'list'
					const paths = await dialog.open({ multiple, directory: false })
					if (paths) {
						const pathList = Array.isArray(paths) ? paths : [paths]
						pathList.forEach((filePath) => {
							const fileEntry = {
								id: null, // No DB id for browsed files
								file_path: filePath,
								participant_id: null,
								data_type: null,
							}
							if (asset.mode === 'single') {
								asset[side] = fileEntry
							} else {
								if (!Array.isArray(asset[side])) {
									asset[side] = []
								}
								// Don't add duplicates
								if (!asset[side].some((f) => f.file_path === filePath)) {
									asset[side].push(fileEntry)
								}
							}
						})
						renderDatasetAssets()
						updateEditorPreview()
					}
				})
			})

			// "Link" button - open URL input modal (mock side only)
			row.querySelectorAll('.btn-add-url').forEach((btn) => {
				btn.addEventListener('click', () => {
					const side = btn.dataset.side
					openUrlInputModal(asset, index, side)
				})
			})

			// Remove file buttons in list mode
			row.querySelectorAll('.remove-file').forEach((btn) => {
				btn.addEventListener('click', () => {
					const side = btn.dataset.side
					const fileIndex = parseInt(btn.dataset.fileIndex)
					if (Array.isArray(asset[side])) {
						asset[side].splice(fileIndex, 1)
						renderDatasetAssets()
						updateEditorPreview()
					}
				})
			})

			// Remove single file button
			row.querySelectorAll('.remove-single-file').forEach((btn) => {
				btn.addEventListener('click', () => {
					const side = btn.dataset.side
					asset[side] = null
					renderDatasetAssets()
					updateEditorPreview()
				})
			})

			container.appendChild(row)
		})
	}

	function renderAssetSide(asset, assetIndex, side) {
		const sideData = asset[side]
		const isSingle = asset.mode === 'single'

		// Link button only for mock side
		const linkButton =
			side === 'mock'
				? `
				<button class="btn-add-url btn-secondary-sm" type="button" data-side="${side}">
					<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
						<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"></path>
						<path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"></path>
					</svg>
					Link
				</button>
			`
				: ''

		// Buttons: Existing Files (from DB), Browse (filesystem), and Link (for mock only)
		const buttonRow = `
			<div class="asset-side-buttons">
				<button class="btn-existing-files btn-secondary-sm" type="button" data-side="${side}">
					<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
						<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path>
						<polyline points="14 2 14 8 20 8"></polyline>
					</svg>
					Existing Files
				</button>
				<button class="btn-browse-files btn-secondary-sm" type="button" data-side="${side}">
					<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
						<path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path>
					</svg>
					Browse
				</button>
				${linkButton}
			</div>
		`

		// Helper to render a file entry (shows link icon for URLs)
		const renderFileEntry = (f, index = null) => {
			const isUrl =
				f.is_url ||
				f.file_path?.startsWith('http://') ||
				f.file_path?.startsWith('https://') ||
				f.file_path?.startsWith('syft://')
			const displayName = isUrl ? f.file_path : f.file_path?.split('/').pop()
			const icon = isUrl
				? `<svg class="file-type-icon url-icon" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
						<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"></path>
						<path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"></path>
					</svg>`
				: ''
			const removeBtn =
				index !== null
					? `<button class="remove-file" type="button" data-side="${side}" data-file-index="${index}">
							<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
								<line x1="18" y1="6" x2="6" y2="18"></line>
								<line x1="6" y1="6" x2="18" y2="18"></line>
							</svg>
						</button>`
					: `<button class="remove-single-file" type="button" data-side="${side}" title="Remove file">
							<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
								<line x1="18" y1="6" x2="6" y2="18"></line>
								<line x1="6" y1="6" x2="18" y2="18"></line>
							</svg>
						</button>`
			return `
				<div class="file-item${isUrl ? ' url-entry' : ''}">
					${icon}
					<span class="file-name${isUrl ? ' url-name' : ''}" title="${f.file_path}">${displayName}</span>
					${removeBtn}
				</div>
			`
		}

		if (isSingle) {
			// Single file mode
			if (sideData && sideData.file_path) {
				return `
					<div class="asset-file-single">
						${renderFileEntry(sideData)}
					</div>
					${buttonRow}
				`
			} else {
				return `
					<div class="asset-file-single">
						<span class="file-placeholder">No file selected</span>
					</div>
					${buttonRow}
				`
			}
		} else {
			// List mode
			const files = Array.isArray(sideData) ? sideData : []
			if (files.length === 0) {
				return `
					<div class="asset-file-list">
						<div class="file-list-empty">No files added</div>
					</div>
					${buttonRow}
				`
			} else {
				const fileItems = files.map((f, i) => renderFileEntry(f, i)).join('')
				return `
					<div class="asset-file-list">
						${fileItems}
					</div>
					${buttonRow}
				`
			}
		}
	}

	function updateEditorPreview() {
		const nameInput = document.getElementById('dataset-form-name')
		const descInput = document.getElementById('dataset-form-description')
		const versionInput = document.getElementById('dataset-form-version')

		const previewName = document.getElementById('preview-name')
		const previewMeta = document.getElementById('preview-meta')
		const previewDesc = document.getElementById('preview-desc')

		if (previewName) {
			previewName.textContent = nameInput?.value?.trim() || 'your_dataset'
		}

		// Count total files across all assets (per-asset mode)
		let fileCount = 0
		datasetAssets.forEach((asset) => {
			if (asset.mode === 'single') {
				if (asset.private) fileCount++
				if (asset.mock) fileCount++
			} else {
				fileCount += (asset.private?.length || 0) + (asset.mock?.length || 0)
			}
		})

		if (previewMeta) {
			previewMeta.textContent = `v${versionInput?.value || '1.0.0'} • ${fileCount} file${
				fileCount !== 1 ? 's' : ''
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

		// Reset asset state
		datasetAssets = []
		currentAssetIndex = null
		currentAssetSide = null

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

			// Convert old assets to new model (with name and mode)
			if (assets && assets.length > 0) {
				console.log('[Dataset Editor] Loading assets:', assets)
				for (const a of assets) {
					console.log(
						'[Dataset Editor] Asset:',
						a.asset_key,
						'kind:',
						a.kind,
						'private_ref:',
						a.private_ref?.substring(0, 100),
					)
					// Check if this is a twin_list asset
					const isTwinList = a.kind === 'twin_list'

					if (isTwinList) {
						// Parse mock_ref to extract entries
						let mockEntries = []
						let privateEntries = []

						if (a.mock_ref) {
							try {
								const mockObj = JSON.parse(a.mock_ref)
								if (mockObj.entries && Array.isArray(mockObj.entries)) {
									mockEntries = mockObj.entries.map((entry) => ({
										id: entry.db_file_id || null,
										file_path: entry.source_path || entry.url?.split('/').pop() || '',
										participant_id: entry.participant_id || null,
										data_type: null,
									}))
								}
							} catch {
								// Ignore parse errors
							}
						}

						// Parse private_ref for private entries if present
						if (a.private_ref) {
							try {
								const privObj = JSON.parse(a.private_ref)
								if (privObj.entries && Array.isArray(privObj.entries)) {
									privateEntries = privObj.entries.map((entry) => ({
										id: entry.db_file_id || null,
										file_path: entry.file_path || '',
										participant_id: entry.participant_id || null,
										data_type: null,
									}))
								}
							} catch {
								// Ignore parse errors
							}
						}

						console.log(
							'[Dataset Editor] twin_list: privateEntries=',
							privateEntries.length,
							'mockEntries=',
							mockEntries.length,
						)
						datasetAssets.push({
							name: a.asset_key || `asset_${datasetAssets.length + 1}`,
							mode: 'list',
							private: privateEntries.length > 0 ? privateEntries : [],
							mock: mockEntries.length > 0 ? mockEntries : [],
						})
					} else {
						// Single file mode
						console.log('[Dataset Editor] single file mode for:', a.asset_key)
						const privateFile =
							a.private_path || a.resolved_private_path
								? {
										id: a.private_file_id || null,
										file_path: a.resolved_private_path || a.private_path,
										participant_id: null,
										data_type: null,
									}
								: null
						const mockFile =
							a.mock_path || a.resolved_mock_path
								? {
										id: a.mock_file_id || null,
										file_path: a.resolved_mock_path || a.mock_path,
										participant_id: null,
										data_type: null,
									}
								: null

						datasetAssets.push({
							name: a.asset_key || `asset_${datasetAssets.length + 1}`,
							mode: 'single',
							private: privateFile,
							mock: mockFile,
						})
					}
				}
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
		}

		console.log('[Dataset Editor] Final datasetAssets:', JSON.stringify(datasetAssets, null, 2))
		renderDatasetAssets()
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

	function extractAssetFilename(filePath) {
		if (!filePath) return null
		const trimmed = filePath.split('#')[0].replace(/\/+$/, '')
		const parts = trimmed.split('/')
		const name = parts[parts.length - 1]
		return name || null
	}

	function inferDatasetShapeFromAssets(assets) {
		if (!Array.isArray(assets) || assets.length === 0) return null
		if (assets.some((asset) => asset.mode === 'list')) {
			return 'List[GenotypeRecord]'
		}

		const filePaths = []
		assets.forEach((asset) => {
			if (!asset) return
			if (asset.mode === 'single') {
				if (asset.private?.file_path) filePaths.push(asset.private.file_path)
				if (asset.mock?.file_path) filePaths.push(asset.mock.file_path)
			} else {
				const privateFiles = asset.private || []
				const mockFiles = asset.mock || []
				privateFiles.forEach((f) => f?.file_path && filePaths.push(f.file_path))
				mockFiles.forEach((f) => f?.file_path && filePaths.push(f.file_path))
			}
		})

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

	async function collectManifestFromForm() {
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

		// Require at least one asset with at least one file
		const hasAnyFile = datasetAssets.some((asset) => {
			if (asset.mode === 'single') {
				return asset.private || asset.mock
			} else {
				return (asset.private?.length || 0) + (asset.mock?.length || 0) > 0
			}
		})
		if (!hasAnyFile) {
			throw new Error('Add at least one file to the dataset')
		}

		// Check for overlapping files across ALL assets (same file in both private and mock anywhere)
		const allPrivateIds = new Set()
		const allMockIds = new Set()
		datasetAssets.forEach((asset) => {
			if (asset.mode === 'single') {
				if (asset.private?.id) allPrivateIds.add(asset.private.id)
				if (asset.mock?.id) allMockIds.add(asset.mock.id)
			} else {
				const privArr = asset.private || []
				privArr.forEach((f) => {
					if (f.id) allPrivateIds.add(f.id)
				})
				const mockArr = asset.mock || []
				mockArr.forEach((f) => {
					if (f.id) allMockIds.add(f.id)
				})
			}
		})

		// Find files that appear in both private and mock
		const overlappingIds = [...allPrivateIds].filter((id) => allMockIds.has(id))
		let hadWarning = false
		if (overlappingIds.length > 0) {
			// Find the file names for these IDs
			const overlappingNames = []
			datasetAssets.forEach((asset) => {
				if (asset.mode === 'single') {
					if (asset.private?.id && overlappingIds.includes(asset.private.id)) {
						overlappingNames.push(asset.private.file_path.split('/').pop())
					}
					if (asset.mock?.id && overlappingIds.includes(asset.mock.id)) {
						overlappingNames.push(asset.mock.file_path.split('/').pop())
					}
				} else {
					const privFiles = asset.private || []
					privFiles.forEach((f) => {
						if (f.id && overlappingIds.includes(f.id)) {
							overlappingNames.push(f.file_path.split('/').pop())
						}
					})
					const mockFiles = asset.mock || []
					mockFiles.forEach((f) => {
						if (f.id && overlappingIds.includes(f.id)) {
							overlappingNames.push(f.file_path.split('/').pop())
						}
					})
				}
			})
			const uniqueNames = [...new Set(overlappingNames)]
			const confirmed = await dialog.ask(
				`The same file(s) appear in both Private and Mock:\n\n${uniqueNames.join('\n')}\n\nAre you sure you want to continue?`,
				{ title: 'Duplicate Files Warning', kind: 'warning' },
			)
			if (!confirmed) {
				return null // User cancelled
			}
			hadWarning = true
		}

		// Build assets from the paired asset model (per-asset mode)
		const assets = {}
		const privateFiles = []
		const mockFiles = []

		datasetAssets.forEach((asset, idx) => {
			// Use asset.name as the key, fallback to asset_N
			const key = asset.name || `asset_${idx}`
			const isSingle = asset.mode === 'single'

			if (isSingle) {
				// Single file mode
				const privateFile = asset.private
				const mockFile = asset.mock

				if (privateFile) {
					privateFiles.push({
						file_path: privateFile.file_path,
						file_id: privateFile.id,
						participant_id: privateFile.participant_id,
					})
				}
				if (mockFile && !mockFile.is_url) {
					mockFiles.push({
						file_path: mockFile.file_path,
						file_id: mockFile.id,
						participant_id: mockFile.participant_id,
					})
				}

				const kind = privateFile && mockFile ? 'paired' : privateFile ? 'private_only' : 'mock_only'

				// For URL-based mock files, use the URL directly; otherwise generate syft:// URL
				const mockIsUrl =
					mockFile?.is_url ||
					mockFile?.file_path?.startsWith('http://') ||
					mockFile?.file_path?.startsWith('https://') ||
					mockFile?.file_path?.startsWith('syft://')
				const manifestMock = mockFile
					? mockIsUrl
						? mockFile.file_path
						: buildDatasetAssetSyftUrl(currentUserEmail, name, mockFile?.file_path)
					: undefined

				const assetId = crypto?.randomUUID ? crypto.randomUUID() : `asset-${idx}-${Date.now()}`
				assets[key] = {
					id: assetId,
					type: kind,
					url: manifestMock || `{root.private_url}#assets.${key}`,
					private: privateFile ? '{url}.private' : undefined,
					mock: manifestMock,
					mappings: {
						private: privateFile
							? { file_path: privateFile.file_path, db_file_id: privateFile.id || null }
							: null,
						mock: mockFile
							? {
									file_path: mockFile.file_path,
									db_file_id: mockFile.id || null,
									is_url: mockIsUrl || false,
								}
							: null,
					},
				}
			} else {
				// List mode - create a twin_list asset
				// Schema: mock entries in public YAML, private resolved via #keypath
				const privFiles = Array.isArray(asset.private) ? asset.private : []
				const mockFilesArr = Array.isArray(asset.mock) ? asset.mock : []

				// Track files for the top-level files arrays (for backend to copy)
				privFiles.forEach((f) =>
					privateFiles.push({
						file_path: f.file_path,
						file_id: f.id,
						participant_id: f.participant_id,
					}),
				)
				mockFilesArr.forEach((f) => {
					const isUrl =
						f.is_url ||
						f.file_path?.startsWith('http://') ||
						f.file_path?.startsWith('https://') ||
						f.file_path?.startsWith('syft://')
					if (!isUrl) {
						mockFiles.push({
							file_path: f.file_path,
							file_id: f.id,
							participant_id: f.participant_id,
						})
					}
				})

				// Generate UUID for the asset
				const assetId = crypto?.randomUUID ? crypto.randomUUID() : `asset-${idx}-${Date.now()}`

				// Build mock entries for public YAML (with URLs and relative file paths)
				const mockEntries = mockFilesArr.map((f, i) => {
					const entryId = crypto?.randomUUID
						? crypto.randomUUID()
						: `mock-${idx}-${i}-${Date.now()}`
					const isUrl =
						f.is_url ||
						f.file_path?.startsWith('http://') ||
						f.file_path?.startsWith('https://') ||
						f.file_path?.startsWith('syft://')
					const entry = {
						id: entryId,
						// Full URL for flow runs (resolves to local path)
						url: isUrl
							? f.file_path
							: buildDatasetAssetSyftUrl(currentUserEmail, name, f.file_path),
					}
					// Only include participant_id if set
					if (f.participant_id) {
						entry.participant_id = f.participant_id
					}
					// Store source path for publish to copy files (stripped before YAML write)
					if (!isUrl) {
						entry.source_path = f.file_path
					}
					return entry
				})

				// Build private entries for mappings (backend reconstructs from these)
				const privateEntries = privFiles.map((f, i) => {
					const entryId = crypto?.randomUUID
						? crypto.randomUUID()
						: `priv-${idx}-${i}-${Date.now()}`
					const entry = {
						id: entryId,
						// Local file path for flow runs
						file_path: f.file_path,
					}
					if (f.participant_id) {
						entry.participant_id = f.participant_id
					}
					return entry
				})

				// twin_list schema:
				// - url: points to the mock CSV file (for flow sample sheets)
				// - private: { url, type } - declares type so consumers know structure
				// - mock: { url, type, entries } - public entries with URLs
				// - mappings.private.entries: stores private entries for backend
				const mockCsvUrl =
					mockEntries.length > 0
						? `syft://${currentUserEmail}/public/biovault/datasets/${name}/assets/${key}.csv`
						: undefined

				assets[key] = {
					id: assetId,
					type: 'twin_list',
					url: mockCsvUrl,
					private:
						privateEntries.length > 0
							? {
									url: `{root.private_url}#assets.${key}.private`,
									type: 'twin_list',
									entries: privateEntries,
								}
							: undefined,
					mock:
						mockEntries.length > 0
							? {
									url: mockCsvUrl,
									type: 'twin_list',
									entries: mockEntries,
								}
							: undefined,
					mappings: {
						private:
							privateEntries.length > 0
								? {
										entries: privateEntries,
									}
								: null,
					},
				}
			}
		})

		const public_url = currentUserEmail
			? `syft://${currentUserEmail}/public/biovault/datasets/${name}/dataset.yaml`
			: null
		const private_url = currentUserEmail
			? `syft://${currentUserEmail}/private/biovault/datasets/${name}/dataset.yaml`
			: null

		const manifest = {
			name,
			description: description || null,
			author: author || null,
			schema,
			version,
			http_relay_servers: ['syftbox.net'],
			public_url,
			private_url,
			assets,
			shape: inferDatasetShapeFromAssets(datasetAssets),
			private_files: privateFiles,
			mock_files: mockFiles,
		}

		return { manifest, hadWarning }
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
					<div class="dataset-progress" data-dataset="${dataset.name}" style="display:none">
						<div class="dataset-progress-bar">
							<div class="dataset-progress-fill" style="width: 0%"></div>
						</div>
						<div class="dataset-progress-text">Syncing via SyftBox…</div>
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
						<button class="dataset-action-btn btn-run-flow" data-name="${
							dataset.name
						}" title="Run flow with this dataset">
							<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
								<path d="M22 12h-4l-3 9L9 3l-3 9H2"></path>
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

			// Run Flow button
			card.querySelector('.btn-run-flow')?.addEventListener('click', (e) => {
				e.stopPropagation()
				openRunFlowModal(dataset.name, entry)
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
						monitorDatasetSync(name)
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
						// Get parent directory (remove filename from path)
						const lastSlash = localPath.lastIndexOf('/')
						if (lastSlash > 0) {
							localPath = localPath.substring(0, lastSlash)
						}
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
		void ensureDownloadProgressListener()
		const queueCard = document.getElementById('queue-card-container')
		if (queueCard) {
			queueCard.style.display = 'none'
		}
		if (queueIntervalId) {
			clearInterval(queueIntervalId)
			queueIntervalId = null
		}
		const sampleDataBtn = document.getElementById('sample-data-btn')
		if (sampleDataBtn) {
			sampleDataBtn.addEventListener('click', () => toggleSampleDataPanel())
		}
		const sampleDataClose = document.getElementById('sample-data-close')
		if (sampleDataClose) {
			sampleDataClose.addEventListener('click', () => toggleSampleDataPanel(false))
		}
		const sampleDataPanel = document.getElementById('sample-data-panel')
		if (sampleDataPanel) {
			sampleDataPanel.addEventListener('click', (e) => {
				const btn = e.target.closest('[data-sample-id]')
				if (!btn) return
				const sampleId = btn.getAttribute('data-sample-id')
				void handleSampleDataImport(sampleId, btn)
			})
		}
		const downloadGrchBtn = document.getElementById('download-grch38-btn')
		if (downloadGrchBtn) {
			downloadGrchBtn.addEventListener('click', async () => {
				const progress = document.getElementById('grch38-download-progress')
				const progressBar = progress?.querySelector('.sample-data-progress-bar')
				const progressText = progress?.querySelector('.sample-data-progress-text')
				try {
					if (activeDownloads.has('grch38')) {
						openDownloadModal({
							downloadId: 'grch38',
							title: 'Downloading GRCh38 Reference',
							body: 'Download in progress. Closing this window will not stop the download.',
							links: [
								{
									label: 'GRCh38 reference (.fa)',
									href: 'https://ftp.1000genomes.ebi.ac.uk/vol1/ftp/technical/reference/GRCh38_reference_genome/GRCh38_full_analysis_set_plus_decoy_hla.fa',
								},
								{
									label: 'GRCh38 index (.fai)',
									href: 'https://ftp.1000genomes.ebi.ac.uk/vol1/ftp/technical/reference/GRCh38_reference_genome/GRCh38_full_analysis_set_plus_decoy_hla.fa.fai',
								},
							],
						})
						return
					}
					const modalHandle = openDownloadModal({
						downloadId: 'grch38',
						title: 'Downloading GRCh38 Reference',
						body: 'This download can be large. Closing this window will not stop the download.',
						links: [
							{
								label: 'GRCh38 reference (.fa)',
								href: 'https://ftp.1000genomes.ebi.ac.uk/vol1/ftp/technical/reference/GRCh38_reference_genome/GRCh38_full_analysis_set_plus_decoy_hla.fa',
							},
							{
								label: 'GRCh38 index (.fai)',
								href: 'https://ftp.1000genomes.ebi.ac.uk/vol1/ftp/technical/reference/GRCh38_reference_genome/GRCh38_full_analysis_set_plus_decoy_hla.fa.fai',
							},
						],
					})
					if (progress) progress.removeAttribute('hidden')
					if (progressBar) {
						progressBar.classList.remove('is-determinate')
						progressBar.style.width = '100%'
					}
					if (progressText) progressText.textContent = 'Downloading GRCh38…'
					activeDownloads.add('grch38')
					const result = await invoke('fetch_reference_data_with_progress')
					const referenceDir = result?.reference_dir || result?.referenceDir
					if (referenceDir) {
						const fileMetadata = {}
						const refPath = `${referenceDir}/GRCh38_full_analysis_set_plus_decoy_hla.fa`
						const refIndexPath = `${referenceDir}/GRCh38_full_analysis_set_plus_decoy_hla.fa.fai`
						fileMetadata[refPath] = {
							participant_id: null,
							data_type: 'Reference',
							source: '1000 Genomes',
							grch_version: 'GRCh38',
						}
						fileMetadata[refIndexPath] = {
							participant_id: null,
							data_type: 'ReferenceIndex',
							source: '1000 Genomes',
							grch_version: 'GRCh38',
						}
						await invoke('import_files_pending', { fileMetadata })
						await loadData()
						renderReferencesPanel()
					}
					if (modalHandle) modalHandle.close()
				} catch (error) {
					console.error('Failed to download GRCh38 reference:', error)
					await dialog.message(`Failed to download GRCh38: ${error}`, {
						title: 'Reference Download Error',
						type: 'error',
					})
				} finally {
					activeDownloads.delete('grch38')
					if (progress) progress.setAttribute('hidden', '')
				}
			})
		}
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

		// File picker modal event handlers
		const filePickerClose = document.getElementById('file-picker-close')
		if (filePickerClose) {
			filePickerClose.addEventListener('click', closeFilePicker)
		}

		const filePickerCancel = document.getElementById('file-picker-cancel')
		if (filePickerCancel) {
			filePickerCancel.addEventListener('click', closeFilePicker)
		}

		const filePickerOverlay = document.querySelector('#file-picker-modal .modal-overlay')
		if (filePickerOverlay) {
			filePickerOverlay.addEventListener('click', closeFilePicker)
		}

		const filePickerSearch = document.getElementById('file-picker-search')
		if (filePickerSearch) {
			filePickerSearch.addEventListener('input', (e) => {
				filePickerSearchTerm = e.target.value.trim().toLowerCase()
				populateFilePicker()
			})
		}

		const filePickerTypeFilterEl = document.getElementById('file-picker-type-filter')
		if (filePickerTypeFilterEl) {
			filePickerTypeFilterEl.addEventListener('change', (e) => {
				filePickerTypeFilter = e.target.value
				populateFilePicker()
			})
		}

		const filePickerSelectAll = document.getElementById('file-picker-select-all')
		if (filePickerSelectAll) {
			filePickerSelectAll.addEventListener('change', (e) => {
				const filteredFiles = getFilteredPickerFiles()
				if (e.target.checked) {
					filteredFiles.forEach((f) => filePickerSelectedIds.add(f.id))
				} else {
					filteredFiles.forEach((f) => filePickerSelectedIds.delete(f.id))
				}
				populateFilePicker()
			})
		}

		// Single "Add" button - uses filePickerMode set when picker opened
		const filePickerAdd = document.getElementById('file-picker-add')
		if (filePickerAdd) {
			filePickerAdd.addEventListener('click', () => {
				addSelectedFilesToDataset()
			})
		}

		// Wire up the "Add Asset" button in the dataset editor
		const addAssetBtn = document.getElementById('dataset-add-asset')
		if (addAssetBtn) {
			addAssetBtn.addEventListener('click', () => addNewAsset())
		}

		// URL Input modal event handlers
		const urlInputClose = document.getElementById('url-input-modal-close')
		if (urlInputClose) {
			urlInputClose.addEventListener('click', closeUrlInputModal)
		}

		const urlInputCancel = document.getElementById('url-input-cancel')
		if (urlInputCancel) {
			urlInputCancel.addEventListener('click', closeUrlInputModal)
		}

		const urlInputAdd = document.getElementById('url-input-add')
		if (urlInputAdd) {
			urlInputAdd.addEventListener('click', validateAndAddUrl)
		}

		const urlInputField = document.getElementById('url-input-field')
		if (urlInputField) {
			urlInputField.addEventListener('keydown', (e) => {
				if (e.key === 'Enter') {
					e.preventDefault()
					validateAndAddUrl()
				} else if (e.key === 'Escape') {
					closeUrlInputModal()
				}
			})
		}

		// Run Flow modal event handlers
		const runFlowClose = document.getElementById('run-flow-modal-close')
		if (runFlowClose) {
			runFlowClose.addEventListener('click', closeRunFlowModal)
		}

		const runFlowCancel = document.getElementById('run-flow-cancel')
		if (runFlowCancel) {
			runFlowCancel.addEventListener('click', closeRunFlowModal)
		}

		const runFlowConfirm = document.getElementById('run-flow-confirm')
		if (runFlowConfirm) {
			runFlowConfirm.addEventListener('click', confirmRunFlow)
		}

		// Per-asset mode toggles are wired up in renderDatasetAssets()

		// Save dataset handler (shared between top and bottom save buttons)
		async function handleSaveDataset() {
			try {
				const manifestResult = await collectManifestFromForm()
				if (!manifestResult) return // User cancelled warning dialog
				const { manifest, hadWarning: _hadWarning } = manifestResult
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
						monitorDatasetSync(manifest.name)
					} catch (pubErr) {
						console.warn('Auto-republish failed:', pubErr)
					}
				}
				await loadDatasets()
				closeDatasetEditor()
			} catch (error) {
				await dialog.message(`${error}`, { title: 'Dataset Error', type: 'error' })
			}
		}

		const saveDatasetButtonBottom = document.getElementById('dataset-editor-save-bottom')
		if (saveDatasetButtonBottom) {
			saveDatasetButtonBottom.addEventListener('click', handleSaveDataset)
		}

		const saveDatasetButtonTop = document.getElementById('dataset-editor-save')
		if (saveDatasetButtonTop) {
			saveDatasetButtonTop.addEventListener('click', handleSaveDataset)
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
					sessionStorage.setItem('preselectedDataType', 'real')
					sessionStorage.setItem('preselectedDataSource', 'file_selection')
					sessionStorage.removeItem('preselectedDatasetName')
					sessionStorage.removeItem('preselectedDatasetOwner')
					sessionStorage.removeItem('preselectedAssetKeys')

					// Trigger flow run modal via global flow module
					if (window.flowModule && typeof window.flowModule.showDataRunModal === 'function') {
						await window.flowModule.showDataRunModal()
					} else {
						// Fallback: navigate if module not available
						const navigateTo =
							window.navigateTo || ((_view) => console.warn('navigateTo not available'))
						navigateTo('run')
					}
				}
			})
		}

		// Queue processor disabled - hide UI elements
		const queueCard = document.getElementById('queue-card-container')
		const clearQueueBtn = document.getElementById('clear-queue-btn')
		const processQueueBtn = document.getElementById('process-queue-btn')
		if (queueCard) queueCard.style.display = 'none'
		if (clearQueueBtn) clearQueueBtn.style.display = 'none'
		if (processQueueBtn) processQueueBtn.style.display = 'none'
	}

	async function ensureDownloadProgressListener() {
		if (downloadProgressListener || !window.__TAURI__?.event?.listen) return
		downloadProgressListener = await window.__TAURI__.event.listen('download-progress', (event) => {
			const payload = event?.payload || {}
			const id = payload.id
			if (!id) return
			downloadProgressCache.set(id, {
				downloaded: payload.downloaded,
				total: payload.total,
				file: payload.file,
			})
			if (downloadModalHandle && downloadModalHandle.downloadId === id) {
				downloadModalHandle.setProgress(payload.downloaded, payload.total, payload.file)
			}
		})
	}

	function refreshExistingFilePaths() {
		existingFilePaths = new Set(allFiles.map((f) => f.file_path))
	}

	function inferShapeFromFiles(files) {
		if (!files || files.length === 0) return null
		const types = [...new Set(files.map((f) => f.data_type).filter(Boolean))]
		// If mixed types or unknown, return null (will default to GenotypeRecord)
		if (types.length !== 1) return null
		const dataType = types[0]
		switch (dataType) {
			case 'Aligned':
			case 'AlignedIndex':
				return 'List[Record{participant_id: String, aligned_file: File, aligned_index: File, reference_file: File, reference_index: File, ref_version: String?}]'
			case 'Variants':
				return 'List[Record{participant_id: String, vcf_file: File, vcf_index: File?, reference_file: File?, ref_version: String?}]'
			case 'Genotype':
				return 'List[GenotypeRecord]'
			default:
				return null
		}
	}

	function syncSelectionToSessionStorage() {
		if (selectedFileIds.length > 0) {
			// Get selected files and unique participant IDs
			const selectedFiles = allFiles.filter((f) => selectedFileIds.includes(f.id))
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

			// Infer shape from selected file types
			const inferredShape = inferShapeFromFiles(selectedFiles)

			// Sync to sessionStorage so flows view can detect it
			sessionStorage.setItem('preselectedFileIds', JSON.stringify(selectedFileIds))
			sessionStorage.setItem('preselectedParticipants', JSON.stringify(participantIds))
			sessionStorage.setItem('preselectedDataType', 'real')
			sessionStorage.setItem('preselectedDataSource', 'file_selection')
			sessionStorage.removeItem('preselectedDatasetName')
			if (inferredShape) {
				sessionStorage.setItem('preselectedDatasetShape', inferredShape)
			} else {
				sessionStorage.removeItem('preselectedDatasetShape')
			}
			sessionStorage.removeItem('preselectedDatasetDataType')
			sessionStorage.removeItem('preselectedDatasetOwner')
			sessionStorage.removeItem('preselectedAssetKeys')
		} else {
			// Clear if nothing selected
			sessionStorage.removeItem('preselectedFileIds')
			sessionStorage.removeItem('preselectedParticipants')
			sessionStorage.removeItem('preselectedDataType')
			sessionStorage.removeItem('preselectedDataSource')
			sessionStorage.removeItem('preselectedDatasetName')
			sessionStorage.removeItem('preselectedDatasetOwner')
			sessionStorage.removeItem('preselectedAssetKeys')
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
		openFilePicker,
		setViewMode,
	}
}

export const __private__ = { getPathBasename, buildDatasetAssetSyftUrl }
