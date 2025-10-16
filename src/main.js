const { invoke } = window.__TAURI__.core
const { open } = window.__TAURI__.dialog
const { listen } = window.__TAURI__.event

const shellApi = window.__TAURI__ && window.__TAURI__.shell ? window.__TAURI__.shell : null

let selectedFolder = null
let currentFiles = []
let currentPattern = ''
let fileParticipantIds = {} // Maps file path to participant ID
let selectedFiles = new Set() // Set of selected file paths
let sortField = 'path' // Current sort field: path, filename, extension, participant
let sortDirection = 'asc' // asc or desc
let columnWidths = {
	path: 1200, // Wide for fullscreen, will collapse naturally
	filename: 180,
	participant: 150,
}
let commandLogs = [] // Array of log entries
let isImportInProgress = false // Track if import is currently running
let dependencyResults = null // Store dependency check results globally
let messageThreads = []
let messageFilter = 'inbox'
let activeThreadId = null
let activeThreadMessages = []
let messageReplyTargetId = null
let isComposingNewMessage = false
let messagesAuthorized = false
let currentUserEmail = ''
let syftboxStatus = { running: false, mode: 'Direct' }
let messagesInitialized = false
let messagesRefreshInterval = null
let messagesRefreshInProgress = false
let activeView = 'home'

function updateComposeVisibility(showRecipient) {
	const recipientContainer = document.querySelector('.message-compose-recipient')
	const subjectWrapper = document.getElementById('message-subject-wrapper')
	if (recipientContainer) {
		recipientContainer.style.display = showRecipient ? 'flex' : 'none'
	}
	if (subjectWrapper) {
		subjectWrapper.style.display = showRecipient ? 'block' : 'none'
	}
}

const projectEditorState = {
	projectId: null,
	projectPath: '',
	metadata: null,
	selectedAssets: new Set(),
	treeNodes: new Map(),
	jupyter: {
		running: false,
		port: null,
	},
}

const projectCreateState = {
	selectedDir: null,
	usingDefault: true,
	defaultDir: '',
}

function isLikelyEmail(value) {
	const trimmed = value ? value.trim() : ''
	if (!trimmed) return false
	const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
	return emailRegex.test(trimmed)
}

async function openInExternalBrowser(url) {
	if (shellApi && typeof shellApi.open === 'function') {
		try {
			await shellApi.open(url)
			return
		} catch (err) {
			console.warn('shell.open failed, falling back to window.open:', err)
		}
	}

	try {
		await invoke('open_url', { url })
		return
	} catch (error) {
		console.warn('invoke("open_url") failed, fallback to window.open:', error)
	}

	window.open(url, '_blank', 'noopener,noreferrer')
}

async function confirmWithDialog(message, options = {}) {
	if (window.__TAURI__?.dialog?.confirm) {
		return await window.__TAURI__.dialog.confirm(message, options)
	}
	return window.confirm(message)
}

async function handleDeleteProject(project) {
	const name = project.name || project.project_path
	const prompt = project.orphaned
		? `Are you sure you want to delete the folder "${project.project_path}"? This cannot be undone.`
		: `Are you sure you want to delete project "${name}"? This will remove the project directory and cannot be undone.`

	const confirmed = await confirmWithDialog(prompt, {
		title: 'Delete Project',
		type: 'warning',
	})

	if (!confirmed) return

	const modalMsg = project.orphaned
		? 'Deleting project folder...'
		: 'Deleting project (database + folder)...'
	showOperationModal(modalMsg)

	try {
		if (project.orphaned) {
			await invoke('delete_project_folder', { projectPath: project.project_path })
		} else if (project.id !== null && project.id !== undefined) {
			await invoke('delete_project', { projectId: project.id })
		}
		await loadProjects()
	} catch (error) {
		alert(`Error deleting project: ${error}`)
	} finally {
		hideOperationModal()
	}
}

let operationModalDepth = 0

function setOperationButtonsDisabled(disabled) {
	const launchBtn = document.getElementById('project-edit-launch-jupyter-btn')
	const resetBtn = document.getElementById('project-edit-reset-jupyter-btn')
	if (launchBtn) launchBtn.disabled = disabled
	if (resetBtn) resetBtn.disabled = disabled
}

function updateOperationModal(message) {
	const textEl = document.getElementById('operation-modal-text')
	if (textEl) {
		textEl.textContent = message
	}
}

function showOperationModal(message) {
	operationModalDepth += 1
	const modal = document.getElementById('operation-modal')
	if (modal) {
		modal.style.display = 'flex'
	}
	setOperationButtonsDisabled(true)
	updateOperationModal(message)
}

function hideOperationModal() {
	if (operationModalDepth > 0) {
		operationModalDepth -= 1
	}
	if (operationModalDepth === 0) {
		const modal = document.getElementById('operation-modal')
		if (modal) {
			modal.style.display = 'none'
		}
		setOperationButtonsDisabled(false)
	}
}

function getFileExtensions() {
	const select = document.getElementById('file-type-select')
	const selected = Array.from(select.selectedOptions).map((opt) => opt.value)

	// If custom is selected, get the custom extension
	if (selected.includes('custom')) {
		const customInput = document.getElementById('custom-ext-input')
		let ext = customInput.value.trim()
		if (ext.startsWith('*.')) {
			ext = ext.substring(1)
		}
		// Remove 'custom' and add the actual extension
		return selected.filter((v) => v !== 'custom').concat(ext ? [ext] : [])
	}

	return selected.filter((v) => v !== '') // Filter out empty option
}

function patternToRegex(pattern) {
	if (!pattern) return null

	// Handle special tokens that don't use regex
	if (
		pattern === '{parent}' ||
		pattern === '{dirname}' ||
		pattern === '{dir}' ||
		pattern === '{filename}' ||
		pattern === '{basename}' ||
		pattern === '{id}/*'
	) {
		return null // These are handled separately
	}

	if (!pattern.includes('{id}')) return null

	// Find what character comes after {id} to make matching non-greedy
	const idIndex = pattern.indexOf('{id}')
	const afterId = pattern.charAt(idIndex + 4) // Character after '{id}'

	let characterClass
	if (afterId === '_') {
		// Exclude underscore from character class (non-greedy)
		characterClass = '([a-zA-Z0-9\\-]+?)'
	} else if (afterId === '-') {
		// Exclude hyphen from character class (non-greedy)
		characterClass = '([a-zA-Z0-9_]+?)'
	} else if (afterId === '.') {
		// Exclude period from character class (non-greedy)
		characterClass = '([a-zA-Z0-9_\\-]+?)'
	} else {
		// Default: include everything, but non-greedy
		characterClass = '([a-zA-Z0-9_\\-]+?)'
	}

	let regex = pattern
		.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
		.replace(/\\\{id\\\}/g, characterClass)
		.replace(/\\\*/g, '.*')

	return new RegExp(regex)
}

function extractIdFromPath(path, pattern) {
	if (!pattern) return null

	// Handle special token patterns
	if (
		pattern === '{parent}' ||
		pattern === '{dirname}' ||
		pattern === '{dir}' ||
		pattern === '{id}/*'
	) {
		// Extract parent directory name
		const parts = path.split('/')
		const parentDir = parts[parts.length - 2]
		if (parentDir) {
			// Find position in full path for highlighting
			const pathBeforeParent = parts.slice(0, -2).join('/') + '/'
			return {
				id: parentDir,
				start: pathBeforeParent.length,
				length: parentDir.length,
				isDirectory: true,
			}
		}
		return null
	}

	if (pattern === '{filename}') {
		// Extract filename without extension
		const filename = path.split('/').pop()
		const nameWithoutExt = filename.includes('.')
			? filename.substring(0, filename.lastIndexOf('.'))
			: filename
		const dir = path.substring(0, path.lastIndexOf('/') + 1)
		return {
			id: nameWithoutExt,
			start: dir.length,
			length: nameWithoutExt.length,
		}
	}

	if (pattern === '{basename}') {
		// Extract full filename with extension
		const filename = path.split('/').pop()
		const dir = path.substring(0, path.lastIndexOf('/') + 1)
		return {
			id: filename,
			start: dir.length,
			length: filename.length,
		}
	}

	// Handle {id} patterns with regex
	const filename = path.split('/').pop()
	const regex = patternToRegex(pattern)

	if (!regex) return null

	const match = filename.match(regex)
	if (match && match[1]) {
		const dir = path.substring(0, path.lastIndexOf('/') + 1)
		const idStart = match.index + match[0].indexOf(match[1])
		return { id: match[1], start: dir.length + idStart, length: match[1].length }
	}
	return null
}

function highlightPattern(path, pattern) {
	const result = extractIdFromPath(path, pattern)

	if (result) {
		const before = path.substring(0, result.start)
		const highlighted = path.substring(result.start, result.start + result.length)
		const after = path.substring(result.start + result.length)

		return `<span style="color: #666;">${before}</span><span class="highlight">${highlighted}</span><span style="color: #666;">${after}</span>`
	}

	const filename = path.split('/').pop()
	const dir = path.substring(0, path.lastIndexOf('/') + 1)
	return `<span style="color: #666;">${dir}</span>${filename}`
}

function getFileMetadata(filePath) {
	const parts = filePath.split('/')
	const fullFilename = parts[parts.length - 1]
	const dir = parts.slice(0, -1).join('/') + '/'
	const lastDotIndex = fullFilename.lastIndexOf('.')
	const filename = lastDotIndex > 0 ? fullFilename.substring(0, lastDotIndex) : fullFilename
	const extension = lastDotIndex > 0 ? fullFilename.substring(lastDotIndex) : ''

	return { dir, filename, extension, fullFilename }
}

function sortFiles(files) {
	const sorted = [...files]
	sorted.sort((a, b) => {
		let aVal, bVal

		switch (sortField) {
			case 'path':
				aVal = a
				bVal = b
				break
			case 'filename':
				aVal = getFileMetadata(a).filename
				bVal = getFileMetadata(b).filename
				break
			case 'extension':
				aVal = getFileMetadata(a).extension
				bVal = getFileMetadata(b).extension
				break
			case 'participant':
				aVal = fileParticipantIds[a] || ''
				bVal = fileParticipantIds[b] || ''
				break
			default:
				return 0
		}

		const comparison = aVal.localeCompare(bVal)
		return sortDirection === 'asc' ? comparison : -comparison
	})

	return sorted
}

function updateSortIndicators() {
	const headers = document.querySelectorAll('.file-list-header div[data-sort]')
	headers.forEach((header) => {
		const indicator = header.querySelector('.sort-indicator')
		if (header.dataset.sort === sortField) {
			indicator.textContent = sortDirection === 'asc' ? '▲' : '▼'
		} else {
			indicator.textContent = ''
		}
	})
}

function setSortField(field) {
	if (sortField === field) {
		// Toggle direction
		sortDirection = sortDirection === 'asc' ? 'desc' : 'asc'
	} else {
		// New field, default to ascending
		sortField = field
		sortDirection = 'asc'
	}
	renderFiles()
}

function updateColumnWidths() {
	// Update header columns
	const headerPath = document.querySelector('.file-list-header .col-path')
	const headerFilename = document.querySelector('.file-list-header .col-filename')
	const headerParticipant = document.querySelector('.file-list-header .col-participant')

	if (headerPath) headerPath.style.width = `${columnWidths.path}px`
	if (headerFilename) headerFilename.style.width = `${columnWidths.filename}px`
	if (headerParticipant) headerParticipant.style.width = `${columnWidths.participant}px`

	// Update all rows
	document.querySelectorAll('.file-list li .col-path').forEach((el) => {
		el.style.width = `${columnWidths.path}px`
	})
	document.querySelectorAll('.file-list li .col-filename').forEach((el) => {
		el.style.width = `${columnWidths.filename}px`
	})
	document.querySelectorAll('.file-list li .col-participant').forEach((el) => {
		el.style.width = `${columnWidths.participant}px`
	})
}

function initColumnResizers() {
	const resizers = document.querySelectorAll('.column-resizer')

	resizers.forEach((resizer) => {
		let startX, startWidth, column

		resizer.addEventListener('mousedown', (e) => {
			e.stopPropagation() // Prevent sort
			column = resizer.dataset.col
			startX = e.pageX
			startWidth = columnWidths[column]

			resizer.classList.add('resizing')
			document.body.style.cursor = 'col-resize'
			document.body.style.userSelect = 'none'

			const onMouseMove = (e) => {
				const diff = e.pageX - startX
				const newWidth = Math.max(50, startWidth + diff)
				columnWidths[column] = newWidth
				updateColumnWidths()
			}

			const onMouseUp = () => {
				resizer.classList.remove('resizing')
				document.body.style.cursor = ''
				document.body.style.userSelect = ''
				document.removeEventListener('mousemove', onMouseMove)
				document.removeEventListener('mouseup', onMouseUp)
			}

			document.addEventListener('mousemove', onMouseMove)
			document.addEventListener('mouseup', onMouseUp)
		})
	})
}

function renderFiles() {
	const fileList = document.getElementById('file-list')
	fileList.innerHTML = ''

	for (const file of Array.from(selectedFiles)) {
		if (!currentFiles.includes(file) || existingFilePaths.has(file)) {
			selectedFiles.delete(file)
		}
	}

	if (currentFiles.length === 0) {
		const li = document.createElement('li')
		li.textContent = 'No files found'
		li.style.gridColumn = '1 / -1'
		fileList.appendChild(li)
		return
	}

	// Sort files
	const sortedFiles = sortFiles(currentFiles)

	sortedFiles.forEach((file) => {
		const li = document.createElement('li')
		const alreadyImported = existingFilePaths.has(file)
		const metadata = getFileMetadata(file)

		// Checkbox column
		const checkboxDiv = document.createElement('div')
		checkboxDiv.className = 'col-checkbox'
		const checkbox = document.createElement('input')
		checkbox.type = 'checkbox'
		checkbox.className = 'file-checkbox'
		checkbox.checked = selectedFiles.has(file)
		if (alreadyImported) {
			checkbox.checked = false
			checkbox.disabled = true
			checkbox.title = 'File already imported'
			selectedFiles.delete(file)
			li.classList.add('already-imported')
		}
		checkbox.addEventListener('change', (e) => {
			if (e.target.checked) {
				selectedFiles.add(file)
			} else {
				selectedFiles.delete(file)
			}
			updateSelectAllCheckbox()
			updateImportButton()
			updateSelectedFileCount()
		})
		checkboxDiv.appendChild(checkbox)

		// Path column (directory only) with highlighting
		const pathDiv = document.createElement('div')
		pathDiv.className = 'file-path col-path'
		pathDiv.innerHTML = highlightPattern(file, currentPattern)
		pathDiv.title = file // Full path on hover
		pathDiv.style.width = `${columnWidths.path}px`
		if (alreadyImported) {
			const badge = document.createElement('span')
			badge.className = 'imported-badge'
			badge.textContent = 'Imported'
			pathDiv.appendChild(badge)
		}

		// Filename column
		const filenameDiv = document.createElement('div')
		filenameDiv.className = 'col-filename'
		filenameDiv.textContent = metadata.filename
		filenameDiv.title = metadata.fullFilename
		filenameDiv.style.width = `${columnWidths.filename}px`

		// Extension column
		const extensionDiv = document.createElement('div')
		extensionDiv.className = 'col-extension'
		extensionDiv.textContent = metadata.extension

		// Participant ID input column
		const participantDiv = document.createElement('div')
		participantDiv.className = 'col-participant'
		participantDiv.style.width = `${columnWidths.participant}px`
		const input = document.createElement('input')
		input.type = 'text'
		input.className = 'participant-id-input'
		input.placeholder = 'Enter ID'

		// Extract ID if pattern exists
		const extracted = extractIdFromPath(file, currentPattern)
		if (extracted && extracted.id) {
			console.log(`✅ Extracted participant ID for ${file}: ${extracted.id}`)
			input.value = extracted.id
			input.classList.add('extracted')
			fileParticipantIds[file] = extracted.id
			console.log(`📝 Stored in fileParticipantIds[${file}] = ${fileParticipantIds[file]}`)
		} else {
			console.log(`❌ No extraction for ${file}, pattern: ${currentPattern}`)
			input.value = fileParticipantIds[file] || ''
			if (fileParticipantIds[file]) {
				input.classList.add('manual')
			}
		}

		// Update map when user edits
		input.addEventListener('input', (e) => {
			const value = e.target.value.trim()
			if (value) {
				fileParticipantIds[file] = value
				input.classList.remove('extracted')
				input.classList.add('manual')
			} else {
				delete fileParticipantIds[file]
				input.classList.remove('manual')
				input.classList.remove('extracted')
			}
			updateImportButton()
		})
		participantDiv.appendChild(input)

		// Show in folder button
		const actionsDiv = document.createElement('div')
		actionsDiv.className = 'col-actions'
		const showBtn = document.createElement('button')
		showBtn.className = 'show-in-folder-btn'
		showBtn.textContent = '📁'
		showBtn.title = 'Show in Finder'
		showBtn.addEventListener('click', async () => {
			try {
				await invoke('show_in_folder', { filePath: file })
			} catch (error) {
				console.error('Failed to show file in folder:', error)
			}
		})
		actionsDiv.appendChild(showBtn)

		li.appendChild(checkboxDiv)
		li.appendChild(pathDiv)
		li.appendChild(filenameDiv)
		li.appendChild(extensionDiv)
		li.appendChild(participantDiv)
		li.appendChild(actionsDiv)
		fileList.appendChild(li)
	})

	// Update sort indicators
	updateSortIndicators()

	document.getElementById('file-count').textContent = currentFiles.length
	updateSelectAllCheckbox()
	updateSelectedFileCount()
	updateImportButton()
}

async function updatePatternSuggestions() {
	if (currentFiles.length === 0) return

	const suggestions = await invoke('suggest_patterns', { files: currentFiles })
	const container = document.getElementById('pattern-suggestions')
	container.innerHTML = ''

	suggestions.forEach((sugg) => {
		const btn = document.createElement('button')
		btn.className = 'pattern-btn'
		btn.textContent = sugg.pattern
		btn.title = sugg.description
		btn.addEventListener('click', () => {
			document.querySelectorAll('.pattern-btn').forEach((b) => b.classList.remove('active'))
			btn.classList.add('active')
			document.getElementById('custom-pattern').value = sugg.pattern
			currentPattern = sugg.pattern
			renderFiles()
			updateImportButton()
		})
		container.appendChild(btn)
	})
}

async function searchFiles() {
	if (!selectedFolder) return

	const extensions = getFileExtensions()
	if (extensions.length === 0) {
		currentFiles = []
		renderFiles()
		return
	}

	currentFiles = await invoke('search_txt_files', { path: selectedFolder, extensions })
	currentPattern = ''

	renderFiles()
	await updatePatternSuggestions()
}

async function updateFileTypeDropdown() {
	if (!selectedFolder) return

	const extensions = await invoke('get_extensions', { path: selectedFolder })
	const select = document.getElementById('file-type-select')

	select.innerHTML = ''

	extensions.forEach((ext) => {
		const option = document.createElement('option')
		option.value = ext.extension
		option.textContent = `${ext.extension} (${ext.count})`
		select.appendChild(option)
	})

	const customOption = document.createElement('option')
	customOption.value = 'custom'
	customOption.textContent = 'Custom...'
	select.appendChild(customOption)

	// Auto-select the first extension by default
	if (extensions.length > 0) {
		select.options[0].selected = true
	}
}

async function pickFolder() {
	const selected = await open({
		directory: true,
		multiple: false,
	})

	if (selected) {
		selectedFiles.clear()
		updateSelectedFileCount()
		await refreshExistingFilePaths()
		selectedFolder = selected
		document.getElementById('selected-path').textContent = selected
		await updateFileTypeDropdown()
		await searchFiles()
	}
}

function updateSelectAllCheckbox() {
	const selectAllCheckbox = document.getElementById('select-all-files')
	const selectableFiles = currentFiles.filter((file) => !existingFilePaths.has(file))
	if (selectableFiles.length === 0) {
		selectAllCheckbox.checked = false
		return
	}
	selectAllCheckbox.checked = selectableFiles.every((file) => selectedFiles.has(file))
}

function updateSelectedFileCount() {
	const el = document.getElementById('selected-count')
	if (el) {
		el.textContent = selectedFiles.size
	}
}

function updateImportButton() {
	const btn = document.getElementById('import-btn')

	// Check if any files are selected and all selected files have participant IDs
	const selectedFilesArray = Array.from(selectedFiles)
	const hasSelection = selectedFilesArray.length > 0
	const allSelectedHaveIds =
		hasSelection && selectedFilesArray.every((file) => fileParticipantIds[file])

	btn.disabled = !allSelectedHaveIds
}

let selectedParticipantsForDelete = []

async function loadParticipants() {
	try {
		const participants = await invoke('get_participants')
		allParticipants = participants
		selectedParticipantsForDelete = []
		renderParticipantsTable()
	} catch (error) {
		console.error('Error loading participants:', error)
	}
}

function updateDeleteParticipantsButton() {
	const btn = document.getElementById('delete-selected-participants-btn')
	if (selectedParticipantsForDelete.length > 0) {
		btn.style.display = 'block'
		btn.textContent = `Delete Selected (${selectedParticipantsForDelete.length})`
	} else {
		btn.style.display = 'none'
	}
}

function participantMatchesSearch(participant) {
	if (!participantsSearchTerm) return true
	const term = participantsSearchTerm
	const values = [participant.id, participant.participant_id, participant.created_at]
	return values.some((value) => {
		if (value === null || value === undefined) return false
		return value.toString().toLowerCase().includes(term)
	})
}

function renderParticipantsTable() {
	const tbody = document.getElementById('participants-table')
	if (!tbody) return

	tbody.innerHTML = ''

	selectedParticipantsForDelete = selectedParticipantsForDelete.filter((id) =>
		allParticipants.some((p) => p.id === id),
	)

	const filtered = allParticipants.filter(participantMatchesSearch)

	filtered.forEach((p) => {
		const row = document.createElement('tr')
		const isSelected = selectedParticipantsForDelete.includes(p.id)
		row.innerHTML = `
			<td><input type="checkbox" class="participant-checkbox" data-id="${p.id}" ${
				isSelected ? 'checked' : ''
			} /></td>
			<td>${p.id}</td>
			<td>${p.participant_id}</td>
			<td>${p.created_at}</td>
		`
		tbody.appendChild(row)
	})

	document.querySelectorAll('#participants-table .participant-checkbox').forEach((checkbox) => {
		checkbox.addEventListener('change', (e) => {
			const id = parseInt(e.target.dataset.id)
			if (e.target.checked) {
				if (!selectedParticipantsForDelete.includes(id)) {
					selectedParticipantsForDelete.push(id)
				}
			} else {
				selectedParticipantsForDelete = selectedParticipantsForDelete.filter((x) => x !== id)
			}
			updateDeleteParticipantsButton()
		})
	})

	document.getElementById('participant-count').textContent = allParticipants.length
	const selectAllHeader = document.getElementById('select-all-participants-table')
	if (selectAllHeader) {
		const filteredCount = filtered.length
		const selectedCount = filtered.filter((p) =>
			selectedParticipantsForDelete.includes(p.id),
		).length
		selectAllHeader.checked = filteredCount > 0 && selectedCount === filteredCount
		selectAllHeader.indeterminate = selectedCount > 0 && selectedCount < filteredCount
	}
	updateDeleteParticipantsButton()
}

const FILE_STATUS_PRIORITY = { pending: 0, processing: 1, error: 2, complete: 3 }

let selectedFilesForDelete = []
let currentFileTypeFilter = 'Genotype' // Default to Genotype tab
let filesSortField = 'status'
let filesSortDirection = 'asc'
let existingFilePaths = new Set()
let allFilesData = []
let filesSearchTerm = ''
let allParticipants = []
let participantsSearchTerm = ''
let queueProcessorRunning = false

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
		selectedFilesForDelete = []
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

	filteredFiles.forEach((f) => {
		const row = document.createElement('tr')

		let statusBadge = ''
		if (f.status === 'pending') {
			statusBadge =
				'<span style="background: #ffc107; color: #000; padding: 2px 6px; border-radius: 3px; font-size: 11px; font-weight: 500;">⏳ PENDING</span>'
		} else if (f.status === 'processing') {
			statusBadge =
				'<span style="background: #17a2b8; color: #fff; padding: 2px 6px; border-radius: 3px; font-size: 11px; font-weight: 500;">⚙️ PROCESSING</span>'
		} else if (f.status === 'error') {
			statusBadge =
				'<span style="background: #dc3545; color: #fff; padding: 2px 6px; border-radius: 3px; font-size: 11px; font-weight: 500;" title="' +
				(f.processing_error || '') +
				'">❌ ERROR</span>'
		} else {
			statusBadge =
				'<span style="background: #28a745; color: #fff; padding: 2px 6px; border-radius: 3px; font-size: 11px; font-weight: 500;">✓ COMPLETE</span>'
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

	document.querySelectorAll('#files-table .file-checkbox').forEach((checkbox) => {
		checkbox.addEventListener('change', (e) => {
			const id = parseInt(e.target.dataset.id)
			if (e.target.checked) {
				if (!selectedFilesForDelete.includes(id)) {
					selectedFilesForDelete.push(id)
				}
			} else {
				selectedFilesForDelete = selectedFilesForDelete.filter((x) => x !== id)
			}
			updateDeleteFilesButton()
		})
	})

	document.getElementById('files-count').textContent = filteredFiles.length
	updateFilesSortIndicators()

	const pendingCount = allFilesData.filter((f) => f.status === 'pending').length
	document.getElementById('pending-count').textContent = pendingCount

	const processQueueBtn = document.getElementById('process-queue-btn')
	if (pendingCount > 0) {
		processQueueBtn.style.display = 'flex'
	} else {
		processQueueBtn.style.display = 'none'
	}

	const spinner = document.getElementById('queue-spinner')
	if (spinner) {
		spinner.style.display = queueProcessorRunning && pendingCount > 0 ? 'inline-block' : 'none'
	}

	const selectAllHeader = document.getElementById('select-all-files-table')
	if (selectAllHeader) {
		const filteredCount = filteredFiles.length
		const selectedCount = filteredFiles.filter((f) => selectedFilesForDelete.includes(f.id)).length
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

function resetImportState() {
	console.log('🔄 Resetting import workflow state')

	// Clear tracking structures
	isImportInProgress = false
	selectedFiles.clear()
	selectedReviewFiles = new Set()
	reviewFileMetadata = {}
	fileParticipantIds = {}
	currentFiles = []
	selectedFolder = null
	currentPattern = ''
	reviewSortField = 'path'
	reviewSortDirection = 'asc'

	// Reset step 1 UI elements
	const selectedPathEl = document.getElementById('selected-path')
	if (selectedPathEl) {
		selectedPathEl.textContent = 'No folder selected'
	}

	const selectAllFiles = document.getElementById('select-all-files')
	if (selectAllFiles) {
		selectAllFiles.checked = false
	}

	const fileCountEl = document.getElementById('file-count')
	if (fileCountEl) {
		fileCountEl.textContent = '0'
	}

	updateSelectedFileCount()

	const fileListEl = document.getElementById('file-list')
	if (fileListEl) {
		fileListEl.innerHTML = ''
	}

	const patternContainer = document.getElementById('pattern-suggestions')
	if (patternContainer) {
		patternContainer.innerHTML = ''
	}

	const customPatternInput = document.getElementById('custom-pattern')
	if (customPatternInput) {
		customPatternInput.value = ''
	}

	document.querySelectorAll('.pattern-btn').forEach((btn) => btn.classList.remove('active'))

	const fileTypeSelect = document.getElementById('file-type-select')
	if (fileTypeSelect) {
		fileTypeSelect.innerHTML = '<option value="">Select file type(s)...</option>'
		Array.from(fileTypeSelect.options).forEach((option) => (option.selected = false))
	}

	const customExtension = document.getElementById('custom-extension')
	if (customExtension) {
		customExtension.style.display = 'none'
	}

	const customExtInput = document.getElementById('custom-ext-input')
	if (customExtInput) {
		customExtInput.value = ''
	}

	// Reset review step UI elements
	const reviewTable = document.getElementById('review-files-table')
	if (reviewTable) {
		reviewTable.innerHTML = ''
	}

	const reviewCountEl = document.getElementById('review-file-count')
	if (reviewCountEl) {
		reviewCountEl.textContent = '0'
	}

	const reviewSelectAll = document.getElementById('select-all-review')
	if (reviewSelectAll) {
		reviewSelectAll.checked = false
		reviewSelectAll.indeterminate = false
	}

	const reviewImportBtn = document.getElementById('review-import-btn')
	if (reviewImportBtn) {
		reviewImportBtn.disabled = false
		reviewImportBtn.innerHTML = 'Import Files →'
	}

	const detectBtn = document.getElementById('detect-types-btn')
	if (detectBtn) {
		detectBtn.disabled = false
		detectBtn.innerHTML = '🔍 Detect File Types'
	}

	const analyzeBtn = document.getElementById('analyze-types-btn')
	if (analyzeBtn) {
		analyzeBtn.disabled = false
		analyzeBtn.innerHTML = '🧬 Analyze Files'
	}

	const progressDiv = document.getElementById('detection-progress')
	const progressBar = document.getElementById('progress-bar')
	const progressText = document.getElementById('progress-text')
	if (progressDiv && progressBar && progressText) {
		progressDiv.style.display = 'none'
		progressBar.style.width = '0%'
		progressText.textContent = ''
	}

	updateSelectAllCheckbox()
	updateImportButton()
	updateReviewSelectAllCheckbox()

	// Ensure the import step is the visible state if we were on the review view
	const importView = document.getElementById('import-view')
	const importReviewView = document.getElementById('import-review-view')
	if (importReviewView && importReviewView.classList.contains('active')) {
		importReviewView.classList.remove('active')
		if (importView) {
			importView.classList.add('active')
		}

		const importTab = document.querySelector('.tab[data-tab="import"]')
		if (importTab) {
			document.querySelectorAll('.tab').forEach((t) => t.classList.remove('active'))
			importTab.classList.add('active')
		}
	}

	console.log('✅ Import workflow reset complete')
}

// Step 2: Review file types before import
let reviewFileMetadata = {}
let selectedReviewFiles = new Set()
let reviewSortField = 'path'
let reviewSortDirection = 'asc'

function goToReviewStep() {
	if (selectedFiles.size === 0) return

	// Build file-to-ID mapping
	const filesToImport = Array.from(selectedFiles)

	// Initialize metadata for each file
	reviewFileMetadata = {}
	selectedReviewFiles = new Set()

	console.log('🔍 fileParticipantIds at review time:', JSON.stringify(fileParticipantIds, null, 2))
	console.log(`🔍 Number of files to import: ${filesToImport.length}`)
	console.log(`🔍 Number of participant IDs in map: ${Object.keys(fileParticipantIds).length}`)

	filesToImport.forEach((file) => {
		const participantId = fileParticipantIds[file] || null
		console.log(`🔍 File: ${file}`)
		console.log(`   participantId from map: ${participantId}`)

		reviewFileMetadata[file] = {
			participant_id: participantId,
			data_type: 'Unknown',
			source: null,
			grch_version: null,
			row_count: null,
			chromosome_count: null,
			inferred_sex: null,
		}
		selectedReviewFiles.add(file) // Select all by default
	})

	console.log('🔍 reviewFileMetadata initialized:', reviewFileMetadata)

	// Show review view
	showReviewView()
}

function sortReviewFiles(filePaths) {
	return filePaths.sort((a, b) => {
		const metaA = reviewFileMetadata[a]
		const metaB = reviewFileMetadata[b]

		let valA, valB

		switch (reviewSortField) {
			case 'path':
				valA = a.toLowerCase()
				valB = b.toLowerCase()
				break
			case 'data_type':
				valA = (metaA.data_type || '').toLowerCase()
				valB = (metaB.data_type || '').toLowerCase()
				break
			case 'source':
				valA = (metaA.source || '').toLowerCase()
				valB = (metaB.source || '').toLowerCase()
				break
			case 'grch_version':
				valA = (metaA.grch_version || '').toLowerCase()
				valB = (metaB.grch_version || '').toLowerCase()
				break
			case 'row_count':
				valA = metaA.row_count || 0
				valB = metaB.row_count || 0
				break
			case 'chromosome_count':
				valA = metaA.chromosome_count || 0
				valB = metaB.chromosome_count || 0
				break
			case 'inferred_sex':
				valA = (metaA.inferred_sex || '').toLowerCase()
				valB = (metaB.inferred_sex || '').toLowerCase()
				break
			default:
				valA = a.toLowerCase()
				valB = b.toLowerCase()
		}

		if (valA < valB) return reviewSortDirection === 'asc' ? -1 : 1
		if (valA > valB) return reviewSortDirection === 'asc' ? 1 : -1
		return 0
	})
}

function setReviewSortField(field) {
	if (reviewSortField === field) {
		reviewSortDirection = reviewSortDirection === 'asc' ? 'desc' : 'asc'
	} else {
		reviewSortField = field
		reviewSortDirection = 'asc'
	}

	updateReviewSortIndicators()
	showReviewView()
}

function updateReviewSortIndicators() {
	document.querySelectorAll('#import-review-view .sortable-header').forEach((header) => {
		const indicator = header.querySelector('.sort-indicator')
		const field = header.dataset.sortField

		if (field === reviewSortField) {
			indicator.textContent = reviewSortDirection === 'asc' ? ' ▲' : ' ▼'
		} else {
			indicator.textContent = ''
		}
	})
}

function showReviewView() {
	document.getElementById('review-file-count').textContent = Object.keys(reviewFileMetadata).length

	const tbody = document.getElementById('review-files-table')
	tbody.innerHTML = ''

	const sortedFiles = sortReviewFiles(Object.keys(reviewFileMetadata))

	sortedFiles.forEach((filePath) => {
		const metadata = reviewFileMetadata[filePath]
		const row = document.createElement('tr')
		row.style.borderBottom = '1px solid #eee'
		row.dataset.filePath = filePath

		// Checkbox cell
		const checkboxCell = document.createElement('td')
		checkboxCell.style.padding = '10px'
		checkboxCell.style.textAlign = 'center'
		const checkbox = document.createElement('input')
		checkbox.type = 'checkbox'
		checkbox.checked = selectedReviewFiles.has(filePath)
		checkbox.addEventListener('change', (e) => {
			if (e.target.checked) {
				selectedReviewFiles.add(filePath)
			} else {
				selectedReviewFiles.delete(filePath)
			}
			updateReviewSelectAllCheckbox()
		})
		checkboxCell.appendChild(checkbox)
		row.appendChild(checkboxCell)

		// File path cell with folder icon
		const pathCell = document.createElement('td')
		pathCell.style.padding = '10px'
		pathCell.style.fontSize = '13px'
		pathCell.style.display = 'flex'
		pathCell.style.alignItems = 'center'
		pathCell.style.gap = '8px'

		const pathText = document.createElement('span')
		pathText.textContent = filePath
		pathText.title = filePath
		pathText.style.flex = '1'
		pathText.style.overflow = 'hidden'
		pathText.style.textOverflow = 'ellipsis'
		pathText.style.whiteSpace = 'nowrap'

		const folderBtn = document.createElement('button')
		folderBtn.textContent = '📁'
		folderBtn.style.padding = '4px 8px'
		folderBtn.style.background = '#f0f0f0'
		folderBtn.style.border = '1px solid #ddd'
		folderBtn.style.borderRadius = '4px'
		folderBtn.style.cursor = 'pointer'
		folderBtn.style.flexShrink = '0'
		folderBtn.style.zIndex = '10'
		folderBtn.style.position = 'relative'
		folderBtn.addEventListener('click', async (e) => {
			e.preventDefault()
			e.stopPropagation()
			console.log('🔍 REVIEW Folder button clicked for:', filePath)
			try {
				console.log('🔍 Calling show_in_folder with filePath:', filePath)
				await invoke('show_in_folder', { filePath: filePath })
				console.log('✅ show_in_folder succeeded')
			} catch (error) {
				console.error('❌ show_in_folder error:', error)
				alert(`Error opening folder: ${error}`)
			}
		})

		pathCell.appendChild(pathText)
		pathCell.appendChild(folderBtn)
		row.appendChild(pathCell)

		// Data type dropdown
		const dataTypeCell = document.createElement('td')
		dataTypeCell.style.padding = '10px'
		const dataTypeSelect = document.createElement('select')
		dataTypeSelect.style.width = '100%'
		dataTypeSelect.style.padding = '6px'
		dataTypeSelect.innerHTML = `
			<option value="Unknown" ${metadata.data_type === 'Unknown' ? 'selected' : ''}>Unknown</option>
			<option value="Genotype" ${metadata.data_type === 'Genotype' ? 'selected' : ''}>Genotype</option>
		`
		dataTypeSelect.addEventListener('change', (e) => {
			reviewFileMetadata[filePath].data_type = e.target.value
			updateRowVisibility(row, e.target.value)
			applyReviewRowState(row, reviewFileMetadata[filePath])
		})
		dataTypeCell.appendChild(dataTypeSelect)
		row.appendChild(dataTypeCell)

		// Source dropdown
		const sourceCell = document.createElement('td')
		sourceCell.style.padding = '10px'
		sourceCell.className = 'genotype-field'
		const sourceSelect = document.createElement('select')
		sourceSelect.style.width = '100%'
		sourceSelect.style.padding = '6px'
		sourceSelect.innerHTML = `
			<option value="">-</option>
			<option value="Unknown" ${metadata.source === 'Unknown' ? 'selected' : ''}>Unknown</option>
			<option value="23andMe" ${metadata.source === '23andMe' ? 'selected' : ''}>23andMe</option>
			<option value="AncestryDNA" ${
				metadata.source === 'AncestryDNA' ? 'selected' : ''
			}>AncestryDNA</option>
			<option value="Genes for Good" ${
				metadata.source === 'Genes for Good' ? 'selected' : ''
			}>Genes for Good</option>
			<option value="Dynamic DNA" ${
				metadata.source === 'Dynamic DNA' ? 'selected' : ''
			}>Dynamic DNA</option>
		`
		sourceSelect.addEventListener('change', (e) => {
			reviewFileMetadata[filePath].source = e.target.value || null
			applyReviewRowState(row, reviewFileMetadata[filePath])
		})
		sourceCell.appendChild(sourceSelect)
		row.appendChild(sourceCell)

		// GRCh version dropdown
		const grchCell = document.createElement('td')
		grchCell.style.padding = '10px'
		grchCell.className = 'genotype-field'
		const grchSelect = document.createElement('select')
		grchSelect.style.width = '100%'
		grchSelect.style.padding = '6px'
		grchSelect.innerHTML = `
			<option value="">-</option>
			<option value="Unknown" ${metadata.grch_version === 'Unknown' ? 'selected' : ''}>Unknown</option>
			<option value="36" ${metadata.grch_version === '36' ? 'selected' : ''}>36</option>
			<option value="37" ${metadata.grch_version === '37' ? 'selected' : ''}>37</option>
			<option value="38" ${metadata.grch_version === '38' ? 'selected' : ''}>38</option>
		`
		grchSelect.addEventListener('change', (e) => {
			reviewFileMetadata[filePath].grch_version = e.target.value || null
			applyReviewRowState(row, reviewFileMetadata[filePath])
		})
		grchCell.appendChild(grchSelect)
		row.appendChild(grchCell)

		// Row count cell (hidden - not used during import)
		const rowCountCell = document.createElement('td')
		rowCountCell.style.display = 'none'
		rowCountCell.style.padding = '10px'
		rowCountCell.style.fontSize = '13px'
		rowCountCell.style.color = '#666'
		rowCountCell.textContent = metadata.row_count ? metadata.row_count.toLocaleString() : '-'
		row.appendChild(rowCountCell)

		// Chromosome count cell (hidden - not used during import)
		const chromCountCell = document.createElement('td')
		chromCountCell.style.display = 'none'
		chromCountCell.style.padding = '10px'
		chromCountCell.style.fontSize = '13px'
		chromCountCell.style.color = '#666'
		chromCountCell.textContent = metadata.chromosome_count || '-'
		row.appendChild(chromCountCell)

		// Inferred sex cell (hidden - not used during import)
		const sexCell = document.createElement('td')
		sexCell.style.display = 'none'
		sexCell.style.padding = '10px'
		sexCell.style.fontSize = '13px'
		sexCell.style.color = '#666'
		sexCell.style.fontWeight = metadata.inferred_sex ? '600' : 'normal'
		sexCell.textContent = metadata.inferred_sex || '-'
		row.appendChild(sexCell)

		applyReviewRowState(row, metadata)
		updateRowVisibility(row, metadata.data_type)
		tbody.appendChild(row)
	})

	navigateTo('import-review')
	updateReviewSelectAllCheckbox()
	updateReviewSortIndicators()
}

function updateReviewSelectAllCheckbox() {
	const selectAllCheckbox = document.getElementById('select-all-review')
	const totalFiles = Object.keys(reviewFileMetadata).length
	const selectedCount = selectedReviewFiles.size

	selectAllCheckbox.checked = selectedCount === totalFiles && totalFiles > 0
	selectAllCheckbox.indeterminate = selectedCount > 0 && selectedCount < totalFiles
}

function isReviewMetadataComplete(metadata) {
	if (!metadata) return false
	const filledDataType = metadata.data_type && metadata.data_type !== 'Unknown'
	const filledSource = metadata.source && metadata.source !== 'Unknown'
	const filledGrch = metadata.grch_version && metadata.grch_version !== 'Unknown'
	return filledDataType && filledSource && filledGrch
}

function applyReviewRowState(row, metadata) {
	if (!row) return
	if (isReviewMetadataComplete(metadata)) {
		row.classList.add('review-row-complete')
	} else {
		row.classList.remove('review-row-complete')
	}
}

function updateRowVisibility(row, dataType) {
	const genotypeFields = row.querySelectorAll('.genotype-field')
	genotypeFields.forEach((field) => {
		field.style.display = dataType === 'Genotype' ? '' : 'none'
	})
}

async function detectFileTypes() {
	if (selectedReviewFiles.size === 0) {
		alert('Please select files to detect')
		return
	}

	const btn = document.getElementById('detect-types-btn')
	const progressDiv = document.getElementById('detection-progress')
	const progressBar = document.getElementById('progress-bar')
	const progressText = document.getElementById('progress-text')

	// Show progress UI IMMEDIATELY before any work
	btn.disabled = true
	btn.innerHTML = '<span class="spinner"></span>Detecting...'
	progressDiv.style.display = 'flex'
	progressBar.style.width = '0%'
	progressText.textContent = 'Starting detection...'

	// Force UI update before CLI calls
	await new Promise((resolve) => setTimeout(resolve, 10))

	try {
		const selectedFilesArray = Array.from(selectedReviewFiles)
		const batchSize = 1000 // Large batches since detection is fast
		const totalFiles = selectedFilesArray.length
		let processed = 0

		// Process in batches to show progress
		for (let i = 0; i < selectedFilesArray.length; i += batchSize) {
			const batch = selectedFilesArray.slice(i, i + batchSize)

			progressText.textContent = `Detecting file types... ${processed}/${totalFiles}`
			progressBar.style.width = `${(processed / totalFiles) * 100}%`

			const detections = await invoke('detect_file_types', { files: batch })

			// Update all metadata and UI for this batch
			Object.keys(detections).forEach((filePath) => {
				const detection = detections[filePath]
				console.log(`🔍 Detection result for ${filePath}:`, detection)
				if (reviewFileMetadata[filePath] && detection) {
					console.log(
						`📝 BEFORE update - participant_id: ${reviewFileMetadata[filePath].participant_id}, data_type: ${reviewFileMetadata[filePath].data_type}, source: ${reviewFileMetadata[filePath].source}`,
					)
					reviewFileMetadata[filePath].data_type = detection.data_type
					reviewFileMetadata[filePath].source = detection.source
					reviewFileMetadata[filePath].grch_version = detection.grch_version
					console.log(
						`📝 AFTER update - participant_id: ${reviewFileMetadata[filePath].participant_id}, data_type: ${reviewFileMetadata[filePath].data_type}, source: ${reviewFileMetadata[filePath].source}`,
					)
					updateRowInPlace(filePath)
				}
			})

			processed += batch.length
		}

		progressText.textContent = `Complete! Detected ${totalFiles} file types`
		progressBar.style.width = '100%'

		console.log(`✅ Detected ${totalFiles} file types`)
	} catch (error) {
		alert(`Error detecting file types: ${error}`)
		console.error('Detection error:', error)
	} finally {
		btn.disabled = false
		btn.innerHTML = '🔍 Detect File Types'

		// Hide progress bar after a short delay
		setTimeout(() => {
			progressDiv.style.display = 'none'
			progressBar.style.width = '0%'
		}, 2000)
	}
}

function updateRowInPlace(filePath) {
	// Find row by iterating and comparing dataset
	const rows = document.querySelectorAll('#review-files-table tr')
	let targetRow = null
	for (const row of rows) {
		if (row.dataset.filePath === filePath) {
			targetRow = row
			break
		}
	}

	if (!targetRow) return

	const metadata = reviewFileMetadata[filePath]

	// Update data type dropdown
	const dataTypeSelect = targetRow.querySelector('td:nth-child(3) select')
	if (dataTypeSelect) {
		dataTypeSelect.value = metadata.data_type
		updateRowVisibility(targetRow, metadata.data_type)
	}

	// Update source dropdown
	const sourceSelect = targetRow.querySelector('td:nth-child(4) select')
	if (sourceSelect && metadata.source) {
		sourceSelect.value = metadata.source
	}

	// Update grch version dropdown
	const grchSelect = targetRow.querySelector('td:nth-child(5) select')
	if (grchSelect && metadata.grch_version) {
		grchSelect.value = metadata.grch_version
	}

	// Update row count (column 6)
	const rowCountCell = targetRow.querySelector('td:nth-child(6)')
	if (rowCountCell) {
		rowCountCell.textContent = metadata.row_count ? metadata.row_count.toLocaleString() : '-'
	}

	// Update chromosome count (column 7)
	const chromCountCell = targetRow.querySelector('td:nth-child(7)')
	if (chromCountCell) {
		chromCountCell.textContent = metadata.chromosome_count || '-'
	}

	// Update inferred sex (column 8)
	const sexCell = targetRow.querySelector('td:nth-child(8)')
	if (sexCell) {
		sexCell.textContent = metadata.inferred_sex || '-'
		sexCell.style.fontWeight = metadata.inferred_sex ? '600' : 'normal'
	}

	applyReviewRowState(targetRow, metadata)
}

async function finalizeImport() {
	const btn = document.getElementById('review-import-btn')
	const progressDiv = document.getElementById('detection-progress')
	const progressBar = document.getElementById('progress-bar')
	const progressText = document.getElementById('progress-text')

	// Mark import as in progress
	isImportInProgress = true

	// Show progress UI IMMEDIATELY before any work
	btn.disabled = true
	btn.innerHTML = '<span class="spinner"></span>Importing...'
	progressDiv.style.display = 'flex'
	progressBar.style.width = '0%'
	progressText.textContent = 'Preparing import...'

	// Force UI update before CLI calls
	await new Promise((resolve) => setTimeout(resolve, 10))

	try {
		const filesToImport = Object.keys(reviewFileMetadata)
		const totalFiles = filesToImport.length
		let allResults = {
			success: true,
			imported: 0,
			updated: 0,
			conflicts: [],
			errors: [],
		}

		// Build fileMetadata object for ALL files (single call - instant import)
		const fileMetadata = {}
		filesToImport.forEach((file) => {
			const meta = reviewFileMetadata[file]
			fileMetadata[file] = {
				participant_id: meta.participant_id,
				data_type: meta.data_type,
				source: meta.source,
				grch_version: meta.grch_version,
			}
			console.log(
				`🔍 Preparing import - file: ${file}, participant_id: ${meta.participant_id}, data_type: ${meta.data_type}`,
			)
		})

		console.log('📦 Full fileMetadata being sent to Tauri:', fileMetadata)

		progressText.textContent = `Adding files to queue...`
		progressBar.style.width = '50%'

		// Fast import - add all files to queue instantly (no hashing)
		const result = await invoke('import_files_pending', {
			fileMetadata: fileMetadata,
		})

		progressText.textContent = `Complete! Added ${totalFiles} files to queue`
		progressBar.style.width = '100%'

		// Update results
		if (result.success) {
			allResults.imported = totalFiles
		} else {
			allResults.success = false
			if (result.conflicts) allResults.conflicts.push(...result.conflicts)
			if (result.errors) allResults.errors.push(...result.errors)
		}

		if (allResults.success) {
			// Metadata was saved during import via CSV
			await loadParticipants()
			await loadFiles()

			// Navigate to files tab after successful import
			setTimeout(() => {
				resetImportState()
				isImportInProgress = false
				progressDiv.style.display = 'none'
				progressBar.style.width = '0%'
				navigateTo('files')
			}, 1000)
		} else {
			const updateConflicts = confirm(
				`Some files had conflicts.\nDo you want to update the files with conflicts?`,
			)

			if (updateConflicts) {
				alert('Update functionality coming soon')
			}

			// Re-enable button on failure
			isImportInProgress = false
			btn.disabled = false
			btn.innerHTML = 'Import Files →'
			setTimeout(() => {
				progressDiv.style.display = 'none'
				progressBar.style.width = '0%'
			}, 2000)
		}
	} catch (error) {
		alert(`Error: ${error}`)
		console.error('Import error:', error)

		// Re-enable button on error
		isImportInProgress = false
		btn.disabled = false
		btn.innerHTML = 'Import Files →'
		setTimeout(() => {
			progressDiv.style.display = 'none'
			progressBar.style.width = '0%'
		}, 2000)
	}
}

async function loadProjects() {
	try {
		const projects = await invoke('get_projects')
		const container = document.getElementById('projects-list')

		if (!projects || projects.length === 0) {
			container.innerHTML = '<p style="color: #666;">No projects found in BioVault.</p>'
			return
		}

		container.innerHTML = ''

		projects.forEach((project) => {
			const card = document.createElement('div')
			card.className = 'project-card'

			const info = document.createElement('div')
			info.className = 'project-info'

			const title = document.createElement('h3')
			title.textContent = project.name || '(unnamed project)'
			if (project.orphaned) {
				const badge = document.createElement('span')
				badge.className = 'project-badge project-badge-orphan'
				badge.textContent = 'Unregistered folder'
				title.appendChild(badge)
			}
			info.appendChild(title)

			const author = document.createElement('p')
			author.innerHTML = `<strong>Author:</strong> ${project.author ?? '—'}`
			info.appendChild(author)

			const workflow = document.createElement('p')
			workflow.innerHTML = `<strong>Workflow:</strong> ${project.workflow ?? '—'}`
			info.appendChild(workflow)

			const template = document.createElement('p')
			template.innerHTML = `<strong>Template:</strong> ${project.template ?? '—'}`
			info.appendChild(template)

			const path = document.createElement('p')
			path.innerHTML = `<strong>Path:</strong> ${project.project_path}`
			info.appendChild(path)

			const created = document.createElement('p')
			const meta = project.created_at
				? `${project.source} | Created: ${project.created_at}`
				: project.source
			created.innerHTML = `<strong>Source:</strong> ${meta}`
			info.appendChild(created)

			card.appendChild(info)

			const actions = document.createElement('div')
			actions.className = 'project-card-actions'

			const editBtn = document.createElement('button')
			editBtn.className = 'secondary-btn'
			editBtn.textContent = project.orphaned ? 'Open in Editor' : 'Edit'
			editBtn.addEventListener('click', async () => {
				if (project.orphaned) {
					await openProjectEditor({ projectPath: project.project_path })
				} else if (project.id !== null && project.id !== undefined) {
					await openProjectEditor({ projectId: project.id })
				}
			})
			actions.appendChild(editBtn)

			const openBtn = document.createElement('button')
			openBtn.className = 'open-folder-btn'
			openBtn.textContent = 'Open Folder'
			openBtn.addEventListener('click', async () => {
				try {
					await invoke('open_folder', { path: project.project_path })
				} catch (error) {
					alert(`Error opening folder: ${error}`)
				}
			})
			actions.appendChild(openBtn)

			const deleteBtn = document.createElement('button')
			deleteBtn.className = 'delete-btn'
			deleteBtn.textContent = 'Delete'
			deleteBtn.addEventListener('click', async () => {
				await handleDeleteProject(project)
			})
			actions.appendChild(deleteBtn)

			card.appendChild(actions)
			container.appendChild(card)
		})
	} catch (error) {
		console.error('Error loading projects:', error)
	}
}

async function importProject(overwrite = false) {
	const input = document.getElementById('project-url-input')
	const url = input.value.trim()

	if (!url) {
		alert('Please enter a GitHub URL')
		return
	}

	console.log('Import button clicked, URL:', url)

	const btn = document.getElementById('import-project-btn')
	btn.disabled = true
	btn.textContent = 'Importing...'

	try {
		console.log('Calling invoke with:', { url, overwrite })
		const result = await invoke('import_project', { url, overwrite })
		console.log('Import successful:', result)
		input.value = ''
		await loadProjects()
		alert('Project imported successfully!')
	} catch (error) {
		console.error('Import error:', error)
		const errorStr = String(error)
		if (errorStr.includes('already exists')) {
			const shouldOverwrite = confirm(`${errorStr}\n\nDo you want to overwrite it?`)
			if (shouldOverwrite) {
				btn.disabled = false
				btn.textContent = 'Import'
				await importProject(true)
				return
			}
		} else {
			alert(`Error importing project: ${errorStr}`)
		}
	} finally {
		console.log('Import finally block')
		btn.disabled = false
		btn.textContent = 'Import'
	}
}

async function fetchDefaultProjectPath(name) {
	const trimmed = name ? name.trim() : ''
	try {
		return await invoke('get_default_project_path', {
			name: trimmed ? trimmed : null,
		})
	} catch (error) {
		console.error('Failed to fetch default project path:', error)
		return ''
	}
}

async function showCreateProjectModal() {
	const modal = document.getElementById('create-project-modal')
	const nameInput = document.getElementById('new-project-name')
	const templateSelect = document.getElementById('new-project-template')
	const pathInput = document.getElementById('new-project-path')

	nameInput.value = ''
	nameInput.autocapitalize = 'none'
	nameInput.autocorrect = 'off'
	nameInput.spellcheck = false
	templateSelect.value = ''
	projectCreateState.selectedDir = null
	projectCreateState.usingDefault = true

	const defaultPath = await fetchDefaultProjectPath('')
	projectCreateState.defaultDir = defaultPath
	pathInput.value = defaultPath

	modal.style.display = 'flex'
	setTimeout(() => nameInput.focus(), 100)
}

function hideCreateProjectModal() {
	const modal = document.getElementById('create-project-modal')
	modal.style.display = 'none'
}

async function handleProjectNameInputChange() {
	if (!projectCreateState.usingDefault) {
		return
	}

	const nameValue = document.getElementById('new-project-name').value.trim()
	const defaultPath = await fetchDefaultProjectPath(nameValue)
	projectCreateState.defaultDir = defaultPath
	document.getElementById('new-project-path').value = defaultPath
}

async function chooseProjectDirectory() {
	try {
		const selection = await open({ directory: true, multiple: false })
		if (!selection) {
			return
		}

		const chosen = Array.isArray(selection) ? selection[0] : selection
		if (!chosen) {
			return
		}

		projectCreateState.selectedDir = chosen
		projectCreateState.usingDefault = false
		document.getElementById('new-project-path').value = chosen
	} catch (error) {
		console.error('Folder selection cancelled or failed:', error)
	}
}

async function resetProjectDirectory() {
	projectCreateState.selectedDir = null
	projectCreateState.usingDefault = true
	const nameValue = document.getElementById('new-project-name').value.trim()
	const defaultPath = await fetchDefaultProjectPath(nameValue)
	projectCreateState.defaultDir = defaultPath
	document.getElementById('new-project-path').value = defaultPath
}

async function createProjectFromModal() {
	const nameInput = document.getElementById('new-project-name')
	const templateSelect = document.getElementById('new-project-template')
	const confirmBtn = document.getElementById('create-project-confirm')

	const projectName = nameInput.value.trim()
	if (!projectName) {
		await window.__TAURI__.dialog.message('Please enter a project name', {
			title: 'Name Required',
			type: 'warning',
		})
		nameInput.focus()
		return
	}

	const example = templateSelect.value || null
	const directory = projectCreateState.selectedDir

	confirmBtn.disabled = true
	confirmBtn.textContent = 'Creating...'

	try {
		const project = await invoke('create_project', {
			name: projectName,
			example,
			directory: directory || null,
		})
		hideCreateProjectModal()
		await loadProjects()
		await openProjectEditor({ projectId: project.id })
	} catch (error) {
		const errorStr = String(error)
		console.error('Create project error:', errorStr)
		const targetPath = directory || projectCreateState.defaultDir
		if (errorStr.includes('project.yaml already exists') && targetPath) {
			const shouldOpen = confirm(`${errorStr}\n\nOpen the project editor for ${targetPath}?`)
			if (shouldOpen) {
				hideCreateProjectModal()
				await openProjectEditor({ projectPath: targetPath })
			}
		} else {
			await window.__TAURI__.dialog.message(`Error creating project: ${errorStr}`, {
				title: 'Error',
				type: 'error',
			})
		}
	} finally {
		confirmBtn.disabled = false
		confirmBtn.textContent = 'Create Project'
	}
}

async function openProjectEditor({ projectId = null, projectPath = null }) {
	if (!projectId && !projectPath) {
		alert('Unable to open project editor: missing project identifier')
		return
	}

	try {
		const payload = await invoke('load_project_editor', {
			projectId,
			projectPath,
		})

		projectEditorState.projectId = payload.project_id ?? null
		projectEditorState.projectPath = payload.project_path
		projectEditorState.metadata = payload.metadata
		projectEditorState.selectedAssets = new Set(
			(payload.metadata.assets || []).map((asset) => asset.replace(/\\/g, '/')),
		)
		projectEditorState.treeNodes = new Map()
		projectEditorState.jupyter = {
			running: false,
			port: null,
		}

		renderProjectEditor(payload)
		await refreshJupyterStatus(true)
		navigateTo('project-edit')
	} catch (error) {
		console.error('Failed to load project editor:', error)
		alert(`Error loading project: ${error}`)
	}
}

function renderProjectEditor(data) {
	const pathEl = document.getElementById('project-edit-path')
	pathEl.textContent = data.project_path || ''

	document.getElementById('project-edit-name').value = data.metadata.name || ''
	document.getElementById('project-edit-author').value = data.metadata.author || ''
	document.getElementById('project-edit-workflow').value = data.metadata.workflow || ''
	document.getElementById('project-edit-template').value = data.metadata.template || ''

	const treeContainer = document.getElementById('project-file-tree')
	treeContainer.innerHTML = ''
	projectEditorState.treeNodes.clear()

	if (!data.file_tree || data.file_tree.length === 0) {
		treeContainer.innerHTML =
			'<p style="color: #666; font-size: 13px;">No files found in this folder.</p>'
	} else {
		renderProjectTree(data.file_tree, treeContainer, null)
		projectEditorState.selectedAssets.forEach((assetPath) => {
			const info = projectEditorState.treeNodes.get(assetPath)
			if (!info) return
			setNodeAndChildren(assetPath, true)
			updateAncestorStates(info.parent)
		})
	}

	const statusEl = document.getElementById('project-edit-status')
	if (data.has_project_yaml) {
		statusEl.textContent = ''
		statusEl.style.color = '#666'
	} else {
		statusEl.textContent = 'No project.yaml detected. Saving will create one automatically.'
		statusEl.style.color = '#ff9800'
	}

	updateJupyterControls()
}

function renderProjectTree(nodes, container, parentPath) {
	nodes.forEach((node) => {
		const path = node.path
		if (node.is_dir) {
			if (node.name === '.venv') {
				return
			}
			const details = document.createElement('details')
			details.open = true
			const summary = document.createElement('summary')
			summary.className = 'tree-node'

			const children = Array.isArray(node.children) ? node.children : []

			const checkbox = document.createElement('input')
			checkbox.type = 'checkbox'
			checkbox.dataset.path = path
			checkbox.addEventListener('click', (e) => e.stopPropagation())
			checkbox.addEventListener('change', (e) => {
				setNodeAndChildren(path, e.target.checked)
				const info = projectEditorState.treeNodes.get(path)
				if (info) {
					updateAncestorStates(info.parent)
				}
			})

			const label = document.createElement('span')
			label.textContent = `${node.name}/`
			summary.appendChild(checkbox)
			summary.appendChild(label)
			details.appendChild(summary)

			const childrenContainer = document.createElement('div')
			details.appendChild(childrenContainer)
			container.appendChild(details)

			projectEditorState.treeNodes.set(path, {
				checkbox,
				isDir: true,
				parent: parentPath,
				children: children.map((child) => child.path),
			})

			renderProjectTree(children, childrenContainer, path)
		} else {
			const leaf = document.createElement('div')
			leaf.className = 'tree-leaf'
			const checkbox = document.createElement('input')
			checkbox.type = 'checkbox'
			checkbox.dataset.path = path
			checkbox.addEventListener('change', (e) => {
				if (e.target.checked) {
					projectEditorState.selectedAssets.add(path)
				} else {
					projectEditorState.selectedAssets.delete(path)
				}
				const info = projectEditorState.treeNodes.get(path)
				if (info) {
					info.checkbox.indeterminate = false
					updateAncestorStates(info.parent)
				}
			})

			const label = document.createElement('span')
			label.textContent = node.name
			leaf.appendChild(checkbox)
			leaf.appendChild(label)
			container.appendChild(leaf)

			projectEditorState.treeNodes.set(path, {
				checkbox,
				isDir: false,
				parent: parentPath,
				children: [],
			})
		}
	})
}

function setNodeAndChildren(path, isChecked) {
	const node = projectEditorState.treeNodes.get(path)
	if (!node) return

	node.checkbox.checked = isChecked
	node.checkbox.indeterminate = false

	if (node.isDir) {
		node.children.forEach((childPath) => {
			setNodeAndChildren(childPath, isChecked)
		})
	} else if (isChecked) {
		projectEditorState.selectedAssets.add(path)
	} else {
		projectEditorState.selectedAssets.delete(path)
	}
}

function updateAncestorStates(startPath) {
	let currentPath = startPath
	while (currentPath) {
		const node = projectEditorState.treeNodes.get(currentPath)
		if (!node) break
		if (!node.isDir) {
			currentPath = node.parent
			continue
		}

		let allChecked = true
		let anyChecked = false
		node.children.forEach((childPath) => {
			const childNode = projectEditorState.treeNodes.get(childPath)
			if (!childNode) return
			if (childNode.checkbox.indeterminate) {
				anyChecked = true
				allChecked = false
			} else if (childNode.checkbox.checked) {
				anyChecked = true
			} else {
				allChecked = false
			}
		})

		node.checkbox.checked = anyChecked && allChecked
		node.checkbox.indeterminate = anyChecked && !allChecked
		currentPath = node.parent
	}
}

function updateJupyterControls() {
	const button = document.getElementById('project-edit-launch-jupyter-btn')
	const statusRow = document.getElementById('project-jupyter-status')
	if (!button) return

	button.textContent = projectEditorState.jupyter.running ? 'Stop Jupyter' : 'Launch Jupyter'

	if (!statusRow) return

	if (projectEditorState.jupyter.running && projectEditorState.jupyter.port) {
		const url = `http://localhost:${projectEditorState.jupyter.port}`
		statusRow.style.display = 'block'
		statusRow.innerHTML =
			'Running at <button id="jupyter-open-link" class="link-button" type="button">🔗 ' +
			url +
			'</button>'
		const linkButton = document.getElementById('jupyter-open-link')
		if (linkButton) {
			linkButton.onclick = async () => {
				console.log('[Jupyter] Opening lab URL:', url)
				await openInExternalBrowser(url)
			}
		}
	} else {
		statusRow.style.display = 'none'
		statusRow.innerHTML = ''
	}
}

async function refreshJupyterStatus(showMessage = false) {
	if (!projectEditorState.projectPath) return
	const statusEl = document.getElementById('project-edit-status')

	try {
		const result = await invoke('get_jupyter_status', {
			projectPath: projectEditorState.projectPath,
		})
		projectEditorState.jupyter.running = !!result.running
		projectEditorState.jupyter.port = result.port ?? null
		updateJupyterControls()
		if (showMessage) {
			if (projectEditorState.jupyter.running) {
				const portInfo = projectEditorState.jupyter.port
				statusEl.textContent = portInfo
					? `Jupyter is running on port ${portInfo}.`
					: 'Jupyter server is running.'
				statusEl.style.color = '#28a745'
			} else {
				statusEl.textContent = 'Jupyter server is not running.'
				statusEl.style.color = '#666'
			}
		}
	} catch (error) {
		console.error('Failed to fetch Jupyter status:', error)
		if (showMessage) {
			statusEl.textContent = `Unable to determine Jupyter status: ${error}`
			statusEl.style.color = '#dc3545'
		}
	}
}

async function handleSaveProjectEditor() {
	if (!projectEditorState.projectPath) {
		alert('Select or create a project first')
		return
	}

	const statusEl = document.getElementById('project-edit-status')
	statusEl.textContent = ''
	statusEl.style.color = '#666'

	const nameValue = document.getElementById('project-edit-name').value.trim()
	const authorInputEl = document.getElementById('project-edit-author')
	const authorValue = authorInputEl.value.trim()
	const workflowValue = document.getElementById('project-edit-workflow').value.trim()
	const templateValue = document.getElementById('project-edit-template').value.trim()

	if (!nameValue) {
		alert('Project name cannot be empty')
		return
	}

	if (!workflowValue) {
		alert('Workflow cannot be empty')
		return
	}

	if (authorValue && !isLikelyEmail(authorValue)) {
		statusEl.textContent = 'Please enter a valid email address.'
		statusEl.style.color = '#dc3545'
		authorInputEl.focus()
		return
	}

	statusEl.textContent = 'Saving project...'
	statusEl.style.color = '#666'

	try {
		const assets = Array.from(projectEditorState.selectedAssets)
		const payload = {
			name: nameValue,
			author: authorValue,
			workflow: workflowValue,
			template: templateValue || null,
			assets,
		}

		const saved = await invoke('save_project_editor', {
			projectId: projectEditorState.projectId,
			projectPath: projectEditorState.projectPath,
			payload,
		})
		projectEditorState.projectId = saved.id
		projectEditorState.projectPath = saved.project_path
		statusEl.textContent = '✅ Project saved'
		statusEl.style.color = '#28a745'
		await loadProjects()
	} catch (error) {
		console.error('Failed to save project:', error)
		statusEl.textContent = `Error saving project: ${error}`
		statusEl.style.color = '#dc3545'
	}
}

async function handleLaunchJupyter() {
	if (!projectEditorState.projectPath) {
		alert('Select a project first')
		return
	}

	const statusEl = document.getElementById('project-edit-status')
	statusEl.style.color = '#666'

	if (projectEditorState.jupyter.running) {
		const message = 'Stopping Jupyter server...\nCommand: uv run --python .venv jupyter lab stop'
		showOperationModal(message)
		statusEl.textContent = 'Stopping Jupyter (jupyter lab stop)...'
		try {
			const result = await invoke('stop_jupyter', {
				projectPath: projectEditorState.projectPath,
			})
			projectEditorState.jupyter.running = !!result.running
			projectEditorState.jupyter.port = result.port ?? null
			updateJupyterControls()
			statusEl.textContent = 'Jupyter server stopped.'
			statusEl.style.color = '#666'
			await refreshJupyterStatus(false)
		} catch (error) {
			console.error('Failed to stop Jupyter:', error)
			statusEl.textContent = `Error stopping Jupyter: ${error}`
			statusEl.style.color = '#dc3545'
		} finally {
			hideOperationModal()
		}
		return
	}

	const launchMessage =
		'Launching Jupyter...\nCommands:\n- uv pip install -U --python .venv jupyterlab bioscript\n- uv run --python .venv jupyter lab'
	showOperationModal(launchMessage)
	statusEl.textContent =
		'Launching Jupyter... (uv pip install -U --python .venv jupyterlab bioscript)'

	try {
		const result = await invoke('launch_jupyter', {
			projectPath: projectEditorState.projectPath,
			pythonVersion: null,
		})
		projectEditorState.jupyter.running = !!result.running
		projectEditorState.jupyter.port = result.port ?? null
		updateJupyterControls()

		if (projectEditorState.jupyter.port) {
			const url = `http://localhost:${projectEditorState.jupyter.port}`
			updateOperationModal('Opening browser...')
			await openInExternalBrowser(url)
			statusEl.textContent = `Jupyter running at ${url}`
			statusEl.style.color = '#28a745'
		} else {
			statusEl.textContent = 'Jupyter server started.'
			statusEl.style.color = '#28a745'
		}
		await refreshJupyterStatus(false)
	} catch (error) {
		console.error('Failed to launch Jupyter:', error)
		statusEl.textContent = `Error launching Jupyter: ${error}`
		statusEl.style.color = '#dc3545'
	} finally {
		hideOperationModal()
	}
}

async function handleResetJupyter() {
	if (!projectEditorState.projectPath) {
		alert('Select a project first')
		return
	}

	const confirmed = await window.__TAURI__.dialog.confirm(
		'Resetting will delete and recreate the project virtual environment. This will remove any additional packages you installed. Continue?',
		{ title: 'Reset Jupyter Environment', type: 'warning' },
	)

	if (!confirmed) {
		return
	}

	const statusEl = document.getElementById('project-edit-status')
	statusEl.textContent = 'Resetting Jupyter environment...'
	statusEl.style.color = '#666'
	const modalMessage =
		'Resetting Jupyter environment...\nSteps:\n- Remove existing .venv\n- uv pip install -U --python .venv jupyterlab bioscript'
	showOperationModal(modalMessage)

	try {
		const result = await invoke('reset_jupyter', {
			projectPath: projectEditorState.projectPath,
			pythonVersion: null,
		})
		projectEditorState.jupyter.running = !!result.status.running
		projectEditorState.jupyter.port = result.status.port ?? null
		updateJupyterControls()
		statusEl.textContent = result.message || 'Jupyter environment reset. The server is stopped.'
		statusEl.style.color = '#28a745'
		await refreshJupyterStatus(true)
	} catch (error) {
		console.error('Failed to reset Jupyter:', error)
		statusEl.textContent = `Error resetting Jupyter: ${error}`
		statusEl.style.color = '#dc3545'
	} finally {
		hideOperationModal()
	}
}

let selectedParticipants = []
let selectedProject = null

async function loadRunParticipants() {
	try {
		const participants = await invoke('get_participants')
		const container = document.getElementById('run-participants-list')
		container.innerHTML = ''

		participants.forEach((p) => {
			const item = document.createElement('div')
			item.className = 'selection-item'
			item.dataset.id = p.id
			item.innerHTML = `
				<input type="checkbox" id="part-${p.id}" />
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
	} catch (error) {
		console.error('Error loading participants:', error)
	}
}

async function loadRunProjects() {
	try {
		const projects = await invoke('get_projects')
		const container = document.getElementById('run-projects-list')
		container.innerHTML = ''

		projects.forEach((p) => {
			const item = document.createElement('div')
			item.className = 'selection-item'
			item.dataset.id = p.id
			item.innerHTML = `<strong>${p.name}</strong> - ${p.workflow}`

			item.addEventListener('click', () => {
				document
					.querySelectorAll('#run-projects-list .selection-item')
					.forEach((i) => i.classList.remove('selected'))
				item.classList.add('selected')
				selectedProject = parseInt(item.dataset.id)
				updateRunButton()
			})

			container.appendChild(item)
		})
	} catch (error) {
		console.error('Error loading projects:', error)
	}
}

function updateRunButton() {
	const btn = document.getElementById('run-btn')
	btn.disabled = selectedParticipants.length === 0 || selectedProject === null
}

async function loadRuns() {
	try {
		const runs = await invoke('get_runs')
		const container = document.getElementById('runs-list')

		if (runs.length === 0) {
			container.innerHTML = '<p style="color: #666;">No runs yet.</p>'
			return
		}

		container.innerHTML = ''
		runs.forEach((run) => {
			const card = document.createElement('div')
			card.className = `run-card ${run.status}`
			card.style.cursor = 'pointer'
			card.dataset.runId = run.id
			card.dataset.projectName = run.project_name

			let statusBadge
			if (run.status === 'success') {
				statusBadge =
					'<span style="background: #28a745; color: white; padding: 4px 8px; border-radius: 4px; font-size: 12px;">Success</span>'
			} else if (run.status === 'failed') {
				statusBadge =
					'<span style="background: #dc3545; color: white; padding: 4px 8px; border-radius: 4px; font-size: 12px;">Failed</span>'
			} else {
				statusBadge =
					'<span style="background: #ffc107; color: black; padding: 4px 8px; border-radius: 4px; font-size: 12px;">Running</span>'
			}

			card.innerHTML = `
				<div style="display: flex; justify-content: space-between; align-items: start;">
					<div class="run-info">
						<h3>${run.project_name} ${statusBadge}</h3>
						<p><strong>Participants:</strong> ${run.participant_count}</p>
						<p><strong>Work Directory:</strong> ${run.work_dir}</p>
						<p><strong>Created:</strong> ${run.created_at}</p>
					</div>
					<div style="display: flex; gap: 10px;">
						<button class="open-folder-btn" data-path="${run.work_dir}">Open Folder</button>
						<button class="delete-btn" data-run-id="${run.id}">Delete</button>
					</div>
				</div>
			`

			// Make card clickable to show logs
			card.addEventListener('click', async (e) => {
				// Don't trigger if clicking buttons
				if (e.target.tagName === 'BUTTON') return
				await showRunLogs(run.id, run.project_name, run.work_dir)
			})

			container.appendChild(card)
		})

		document.querySelectorAll('.open-folder-btn').forEach((btn) => {
			btn.addEventListener('click', async (e) => {
				try {
					await invoke('open_folder', { path: e.target.dataset.path })
				} catch (error) {
					alert(`Error opening folder: ${error}`)
				}
			})
		})

		document.querySelectorAll('.run-card .delete-btn').forEach((btn) => {
			btn.addEventListener('click', async (e) => {
				const runId = parseInt(e.target.dataset.runId)
				if (
					confirm(
						'Are you sure you want to delete this run? This will remove all files and the database entry.',
					)
				) {
					try {
						await invoke('delete_run', { runId })

						// Hide log viewer if it's showing logs for the deleted run
						if (currentLogRunId === runId) {
							document.getElementById('log-viewer').style.display = 'none'
							currentLogRunId = null
							currentLogWorkDir = null
						}

						await loadRuns()
					} catch (error) {
						alert(`Error deleting run: ${error}`)
					}
				}
			})
		})
	} catch (error) {
		console.error('Error loading runs:', error)
	}
}

let currentRunLogListeners = []

let currentLogRunId = null
let currentLogWorkDir = null

async function showRunLogs(runId, projectName, workDir = null) {
	const logViewer = document.getElementById('log-viewer')
	const logContent = document.getElementById('log-content')
	const logRunName = document.getElementById('log-run-name')
	const shareBtn = document.getElementById('share-logs-btn')

	currentLogRunId = runId
	currentLogWorkDir = workDir

	logViewer.style.display = 'block'
	logContent.textContent = 'Loading logs...'
	logRunName.textContent = `(${projectName})`

	// Show share button if we have a work dir
	if (workDir) {
		shareBtn.style.display = 'block'
	} else {
		shareBtn.style.display = 'none'
	}

	try {
		const logs = await invoke('get_run_logs', { runId })
		logContent.textContent = logs
		logContent.scrollTop = logContent.scrollHeight
	} catch (error) {
		logContent.textContent = `Error loading logs: ${error}`
	}
}

async function runAnalysis() {
	if (selectedParticipants.length === 0 || selectedProject === null) return

	const btn = document.getElementById('run-btn')
	btn.disabled = true
	btn.textContent = 'Starting...'

	try {
		// First, create the run record
		const result = await invoke('start_analysis', {
			participantIds: selectedParticipants,
			projectId: selectedProject,
		})

		// Navigate to Results tab BEFORE starting execution
		navigateTo('runs')
		await loadRuns()

		// Show log viewer and set it up
		const logViewer = document.getElementById('log-viewer')
		const logContent = document.getElementById('log-content')
		const logRunName = document.getElementById('log-run-name')
		const shareBtn = document.getElementById('share-logs-btn')

		logViewer.style.display = 'block'
		logContent.textContent = ''
		logContent.dataset.runId = result.run_id
		logRunName.textContent = ''
		shareBtn.style.display = 'block'

		currentLogRunId = result.run_id
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

async function loadSettings() {
	try {
		const configPath = await invoke('get_config_path').catch(() => 'Not set')
		document.getElementById('config-path-display').textContent = configPath

		const settings = await invoke('get_settings')
		document.getElementById('setting-email').value = settings.email || ''
		currentUserEmail = settings.email || ''

		// Load saved dependency states for settings page (don't re-check)
		loadSavedDependencies('settings-deps-list', 'settings-dep-details-panel')

		// Check SyftBox auth status
		checkSyftBoxStatus()
	} catch (error) {
		console.error('Error loading settings:', error)
	}
}

async function checkSyftBoxStatus() {
	const statusBadge = document.getElementById('syftbox-status-badge')
	const authBtn = document.getElementById('syftbox-auth-btn')

	try {
		const configInfo = await invoke('get_syftbox_config_info')

		if (configInfo.is_authenticated) {
			statusBadge.innerHTML = `✓ Authenticated<br><span style="font-size: 11px; font-weight: normal;">Config: ${configInfo.config_path}</span>`
			statusBadge.style.background = '#d4edda'
			statusBadge.style.color = '#155724'
			statusBadge.style.border = '1px solid #c3e6cb'
			statusBadge.style.lineHeight = '1.4'
			authBtn.textContent = 'Reauthenticate'
		} else {
			statusBadge.innerHTML = `✗ Not Authenticated<br><span style="font-size: 11px; font-weight: normal;">Config: ${configInfo.config_path}</span>`
			statusBadge.style.background = '#f8d7da'
			statusBadge.style.color = '#721c24'
			statusBadge.style.border = '1px solid #f5c6cb'
			statusBadge.style.lineHeight = '1.4'
			authBtn.textContent = 'Authenticate'
		}

		authBtn.disabled = false
	} catch (error) {
		statusBadge.innerHTML = '? Status Unknown'
		statusBadge.style.background = '#fff3cd'
		statusBadge.style.color = '#856404'
		statusBadge.style.border = '1px solid #ffeaa7'
		authBtn.disabled = false
		authBtn.textContent = 'Authenticate'
		console.error('Error checking SyftBox status:', error)
	}
}

async function handleSyftBoxAuthentication() {
	const email = document.getElementById('setting-email').value.trim()

	if (!email) {
		await window.__TAURI__.dialog.message('Please enter your email address first.', {
			title: 'Email Required',
			type: 'warning',
		})
		return
	}

	// Set the onboarding email field
	document.getElementById('onboarding-email').value = email

	// Show onboarding view with step 4 (SyftBox auth)
	// Hide tabs navigation bar
	const tabsBar = document.querySelector('.tabs')
	if (tabsBar) {
		tabsBar.style.display = 'none'
	}

	// Hide all tab contents and show onboarding view
	document.querySelectorAll('.tab-content').forEach((content) => {
		content.classList.remove('active')
		content.style.display = 'none'
	})
	document.querySelectorAll('.tab').forEach((tab) => tab.classList.remove('active'))

	const onboardingView = document.getElementById('onboarding-view')
	onboardingView.classList.add('active')
	onboardingView.style.display = 'flex'

	// Hide all onboarding steps except step 4
	document.querySelectorAll('.onboarding-step').forEach((step) => {
		step.style.display = 'none'
	})

	const step4 = document.getElementById('onboarding-step-4')
	step4.style.display = 'block'

	// Mark that we're coming from settings (for skip button behavior)
	step4.dataset.fromSettings = 'true'

	// Change skip button text to "Cancel"
	const skipBtn = document.getElementById('skip-syftbox-btn')
	skipBtn.textContent = 'Cancel'

	// Reset the OTP state to show the "Send Login Code" button
	document.getElementById('syftbox-send-state').style.display = 'block'
	document.getElementById('syftbox-otp-state').style.display = 'none'

	// Clear any previous OTP inputs
	document.querySelectorAll('.syftbox-code-input').forEach((input) => {
		input.value = ''
		input.classList.remove('error', 'success')
	})
}

// Log management functions
async function loadCommandLogs() {
	try {
		const logs = await invoke('get_command_logs')
		commandLogs = logs
		displayLogs()
	} catch (error) {
		console.error('Error loading logs:', error)
	}
}

function displayLogs() {
	const logsContent = document.getElementById('logs-content')
	if (commandLogs.length === 0) {
		logsContent.textContent = 'No command logs yet.'
		return
	}

	const MAX_OUTPUT_CHARS = 5000
	let logText = ''

	commandLogs.forEach((log) => {
		logText += `\n${'='.repeat(80)}\n`
		logText += `[${log.timestamp}]\n`
		logText += `Command: ${log.command}\n`
		logText += `${'-'.repeat(80)}\n`

		if (log.output) {
			let output = log.output
			if (output.length > MAX_OUTPUT_CHARS) {
				output =
					output.substring(0, MAX_OUTPUT_CHARS) +
					`\n\n... (output truncated, ${output.length - MAX_OUTPUT_CHARS} chars hidden)`
			}
			logText += output
		}

		if (log.error) {
			logText += `\nERROR: ${log.error}`
		}

		logText += '\n'
	})

	logsContent.textContent = logText
}

async function clearLogs() {
	if (!confirm('Are you sure you want to clear all logs?')) {
		return
	}

	try {
		await invoke('clear_command_logs')
		commandLogs = []
		displayLogs()
	} catch (error) {
		alert(`Error clearing logs: ${error}`)
	}
}

function copyLogs() {
	const logsContent = document.getElementById('logs-content')
	const text = logsContent.textContent

	navigator.clipboard
		.writeText(text)
		.then(() => {
			const btn = document.getElementById('copy-logs-btn')
			const originalText = btn.innerHTML
			btn.innerHTML = '✅ Copied!'
			setTimeout(() => {
				btn.innerHTML = originalText
			}, 2000)
		})
		.catch((err) => {
			alert(`Failed to copy logs: ${err}`)
		})
}

function escapeHtml(value) {
	if (value === undefined || value === null) return ''
	const div = document.createElement('div')
	div.textContent = value
	return div.innerHTML
}

function formatDateTime(value) {
	if (!value) return ''
	const date = new Date(value)
	if (Number.isNaN(date.getTime())) return value
	return date.toLocaleString()
}

function setActiveMessageFilterButton(filter) {
	messageFilter = filter
	document.querySelectorAll('.message-filter').forEach((btn) => {
		btn.classList.toggle('active', btn.dataset.filter === filter)
	})
}

function collectParticipants(messages) {
	const set = new Set()
	messages.forEach((msg) => {
		if (msg.from) set.add(msg.from)
		if (msg.to) set.add(msg.to)
	})
	return Array.from(set)
}

function formatParticipants(participants) {
	if (!participants || participants.length === 0) return ''
	const others = participants.filter((p) => p !== currentUserEmail)
	return others.length > 0 ? others.join(', ') : participants.join(', ')
}

function getPrimaryRecipient(participants) {
	const others = (participants || []).filter((p) => p !== currentUserEmail)
	return others[0] || (participants && participants[0]) || ''
}

function updateMessagesEmptyState() {
	const mainEl = document.getElementById('messages-main')
	const emptyEl = document.getElementById('messages-empty-state')
	const deleteThreadBtn = document.getElementById('delete-thread-btn')
	if (!mainEl || !emptyEl) return

	if (!messagesAuthorized) {
		mainEl.style.display = 'none'
		emptyEl.style.display = 'none'
		if (deleteThreadBtn) deleteThreadBtn.style.display = 'none'
		return
	}

	if (activeThreadId || isComposingNewMessage) {
		mainEl.style.display = 'flex'
		emptyEl.style.display = 'none'
	} else if (!messageThreads.length) {
		mainEl.style.display = 'none'
		emptyEl.style.display = 'flex'
	} else {
		mainEl.style.display = 'flex'
		emptyEl.style.display = 'none'
	}

	if (deleteThreadBtn) {
		deleteThreadBtn.style.display = activeThreadId ? 'inline-flex' : 'none'
	}
}

async function ensureMessagesAuthorization() {
	try {
		messagesAuthorized = await invoke('check_syftbox_auth')
	} catch (error) {
		console.error('Failed to check SyftBox authorization:', error)
		messagesAuthorized = false
	}

	const warningEl = document.getElementById('messages-syftbox-warning')
	if (warningEl) {
		warningEl.style.display = messagesAuthorized ? 'none' : 'flex'
	}

	const container = document.querySelector('#messages-view .messages-container')
	if (container) {
		container.style.display = messagesAuthorized ? 'flex' : 'none'
	}

	if (!messagesAuthorized) {
		syftboxStatus = { running: false, mode: 'Direct' }
	}
	updateSyftboxIndicator()

	updateMessagesEmptyState()

	if (!messagesAuthorized) {
		stopMessagesAutoRefresh()
	} else if (syftboxStatus.running && activeView === 'messages') {
		startMessagesAutoRefresh(true)
	}
	return messagesAuthorized
}

async function refreshSyftboxState() {
	if (!messagesAuthorized) {
		syftboxStatus = { running: false, mode: 'Direct' }
		updateSyftboxIndicator()
		return
	}

	try {
		syftboxStatus = await invoke('get_syftbox_state')
	} catch (error) {
		console.error('Failed to fetch SyftBox state:', error)
		syftboxStatus = { running: false, mode: 'Direct' }
	}

	updateSyftboxIndicator()
}

function updateSyftboxIndicator() {
	const indicator = document.getElementById('message-syftbox-indicator')
	const dropdown = document.getElementById('message-syftbox-dropdown')
	if (!indicator || !dropdown) return

	if (syftboxStatus.running) {
		indicator.textContent = 'Online'
		indicator.classList.add('status-online')
		indicator.classList.remove('status-offline')
		dropdown.value = 'online'
	} else {
		indicator.textContent = 'Offline'
		indicator.classList.add('status-offline')
		indicator.classList.remove('status-online')
		dropdown.value = 'offline'
	}

	dropdown.disabled = !messagesAuthorized

	if (messagesAuthorized && syftboxStatus.running && activeView === 'messages') {
		startMessagesAutoRefresh()
	} else if (!syftboxStatus.running) {
		stopMessagesAutoRefresh()
	}
}

function startMessagesAutoRefresh(immediate = false) {
	if (messagesRefreshInterval) return
	if (!messagesAuthorized) return
	if (activeView !== 'messages') return

	messagesRefreshInterval = setInterval(() => {
		if (activeView !== 'messages') return
		if (!messagesAuthorized) return
		if (!syftboxStatus.running) return
		loadMessageThreads(true).catch((error) => {
			console.error('Failed to auto refresh messages:', error)
		})
	}, 15000)

	if (immediate) {
		if (syftboxStatus.running) {
			loadMessageThreads(true).catch((error) => {
				console.error('Failed to refresh messages:', error)
			})
		} else {
			loadMessageThreads(false).catch((error) => {
				console.error('Failed to refresh messages:', error)
			})
		}
	}
}

function stopMessagesAutoRefresh() {
	if (messagesRefreshInterval) {
		clearInterval(messagesRefreshInterval)
		messagesRefreshInterval = null
	}
}

async function loadMessageThreads(refresh = false) {
	if (!messagesAuthorized) return
	if (messagesRefreshInProgress) return
	messagesRefreshInProgress = true

	const list = document.getElementById('message-thread-list')
	if (list && !list.innerHTML.trim()) {
		list.innerHTML = '<div class="message-thread-empty">Loading threads...</div>'
	}

	try {
		if (refresh) {
			await invoke('sync_messages')
		}
		messageThreads = await invoke('list_message_threads', {
			scope: messageFilter,
			limit: 100,
		})
		renderMessageThreads()
		if (activeThreadId) {
			const exists = messageThreads.some((thread) => thread.thread_id === activeThreadId)
			if (exists) {
				await openThread(activeThreadId, { silent: true })
			} else {
				activeThreadId = null
				activeThreadMessages = []
				messageReplyTargetId = null
			}
		}
	} catch (error) {
		console.error('Failed to load message threads:', error)
		if (list) {
			list.innerHTML = `<div class="message-thread-empty">${escapeHtml(error)}</div>`
		}
	} finally {
		messagesRefreshInProgress = false
	}

	updateMessagesEmptyState()
}

function renderMessageThreads() {
	const list = document.getElementById('message-thread-list')
	if (!list) return

	list.innerHTML = ''

	if (!messageThreads.length) {
		list.innerHTML = '<div class="message-thread-empty">No messages yet.</div>'
		return
	}

	messageThreads.forEach((thread) => {
		const item = document.createElement('div')
		item.className = 'message-thread-item'
		if (thread.thread_id === activeThreadId && !isComposingNewMessage) {
			item.classList.add('active')
		}
		if (thread.unread_count > 0) {
			item.classList.add('unread')
		}

		const subject = document.createElement('div')
		subject.className = 'message-thread-subject'
		subject.textContent =
			thread.subject && thread.subject.trim().length > 0 ? thread.subject : '(No Subject)'

		if (thread.unread_count > 0) {
			const unread = document.createElement('span')
			unread.className = 'message-thread-unread'
			unread.textContent = thread.unread_count
			subject.appendChild(unread)
		}

		if (thread.has_project) {
			const badge = document.createElement('span')
			badge.className = 'message-thread-project'
			badge.textContent = 'Project'
			subject.appendChild(badge)
		}

		const meta = document.createElement('div')
		meta.className = 'message-thread-meta'
		meta.textContent = `${formatParticipants(thread.participants)} • ${formatDateTime(thread.last_message_at)}`

		const preview = document.createElement('div')
		preview.className = 'message-thread-preview'
		preview.textContent = thread.last_message_preview

		item.appendChild(subject)
		item.appendChild(meta)
		item.appendChild(preview)
		item.dataset.threadId = thread.thread_id
		item.addEventListener('click', () => {
			openThread(thread.thread_id)
		})

		list.appendChild(item)
	})
}

function renderConversation(messages) {
	const container = document.getElementById('message-conversation')
	if (!container) return

	const items = messages || []
	if (!items.length) {
		container.innerHTML = '<div class="messages-empty-thread">No messages yet.</div>'
		return
	}

	container.innerHTML = ''
	items.forEach((msg) => {
		const isOutgoing = msg.from === currentUserEmail
		const bubble = document.createElement('div')
		bubble.className = `message-bubble ${isOutgoing ? 'outgoing' : 'incoming'}`

		const header = document.createElement('div')
		header.className = 'message-bubble-header'
		header.textContent = `${msg.from} • ${formatDateTime(msg.created_at)}`

		const body = document.createElement('div')
		body.className = 'message-bubble-body'
		const formatted = msg.body
			? msg.body
					.split('\n')
					.map((line) => `<span>${escapeHtml(line)}</span>`)
					.join('<br>')
			: ''
		body.innerHTML = formatted

		bubble.appendChild(header)
		bubble.appendChild(body)

		const actions = document.createElement('div')
		actions.className = 'message-bubble-actions'
		const deleteBtn = document.createElement('button')
		deleteBtn.type = 'button'
		deleteBtn.className = 'message-delete-btn'
		deleteBtn.textContent = 'Delete'
		deleteBtn.addEventListener('click', (event) => {
			event.stopPropagation()
			deleteMessage(msg.id)
		})
		actions.appendChild(deleteBtn)
		bubble.appendChild(actions)
		container.appendChild(bubble)
	})

	container.scrollTop = container.scrollHeight
}

function renderProjectPanel(messages) {
	const panel = document.getElementById('message-project-panel')
	const details = document.getElementById('message-project-details')
	if (!panel || !details) return

	const projectMessage = (messages || []).find((msg) => {
		if (!msg || !msg.metadata) return false
		if (msg.metadata.project) return true
		return false
	})

	if (!projectMessage) {
		panel.style.display = 'none'
		details.innerHTML = ''
		return
	}

	const metadata = projectMessage.metadata || {}
	const project = metadata.project || {}
	const name = project.name || metadata.project_name || projectMessage.subject || 'Project'
	const submission = metadata.project_location || metadata.submission_url || ''
	const date = metadata.date || projectMessage.created_at

	let html = ''
	html += `<p><strong>Name:</strong> ${escapeHtml(name)}</p>`
	if (submission) {
		html += `<p><strong>Submission:</strong> ${escapeHtml(submission)}</p>`
	}
	if (date) {
		html += `<p><strong>Date:</strong> ${escapeHtml(formatDateTime(date))}</p>`
	}
	if (project.workflow) {
		html += `<p><strong>Workflow:</strong> ${escapeHtml(project.workflow)}</p>`
	}
	if (Array.isArray(metadata.assets) && metadata.assets.length) {
		html += '<p><strong>Assets:</strong></p><ul>'
		metadata.assets.forEach((asset) => {
			html += `<li>${escapeHtml(asset)}</li>`
		})
		html += '</ul>'
	}

	details.innerHTML = html
	panel.style.display = 'flex'
}

async function openThread(threadId, options = {}) {
	if (!messagesAuthorized) return

	activeThreadId = threadId
	isComposingNewMessage = false
	updateComposeVisibility(false)
	updateMessagesEmptyState()

	try {
		const messages = await invoke('get_thread_messages', { threadId })
		activeThreadMessages = messages
		messageReplyTargetId = messages.length ? messages[messages.length - 1].id : null

		renderConversation(messages)
		renderProjectPanel(messages)

		const summary = messageThreads.find((thread) => thread.thread_id === threadId)
		const participants = summary ? summary.participants : collectParticipants(messages)

		const subjectText = summary ? summary.subject : messages[0]?.subject
		const subjectEl = document.getElementById('message-thread-subject')
		if (subjectEl) {
			subjectEl.textContent =
				subjectText && subjectText.trim().length > 0 ? subjectText : '(No Subject)'
		}
		const participantsEl = document.getElementById('message-thread-participants')
		if (participantsEl) {
			const formatted = formatParticipants(participants)
			participantsEl.textContent = formatted ? `Participants: ${formatted}` : ''
		}

		const recipientInput = document.getElementById('message-recipient-input')
		if (recipientInput) {
			recipientInput.value = getPrimaryRecipient(participants)
			recipientInput.readOnly = true
		}

		const subjectInput = document.getElementById('message-compose-subject')
		if (subjectInput) {
			subjectInput.value = ''
		}

		const bodyInput = document.getElementById('message-compose-body')
		if (bodyInput) {
			bodyInput.value = ''
			bodyInput.focus()
		}

		renderMessageThreads()
	} catch (error) {
		console.error('Failed to open thread:', error)
	}

	updateMessagesEmptyState()
}

function startNewMessage() {
	isComposingNewMessage = true
	activeThreadId = null
	activeThreadMessages = []
	messageReplyTargetId = null
	updateComposeVisibility(true)

	const subjectEl = document.getElementById('message-thread-subject')
	if (subjectEl) subjectEl.textContent = 'New Message'

	const participantsEl = document.getElementById('message-thread-participants')
	if (participantsEl) participantsEl.textContent = 'Compose a new message'

	const recipientInput = document.getElementById('message-recipient-input')
	if (recipientInput) {
		recipientInput.readOnly = false
		recipientInput.value = ''
		recipientInput.focus()
	}

	const subjectInput = document.getElementById('message-compose-subject')
	if (subjectInput) subjectInput.value = ''

	const bodyInput = document.getElementById('message-compose-body')
	if (bodyInput) bodyInput.value = ''

	const conversation = document.getElementById('message-conversation')
	if (conversation) {
		conversation.innerHTML = '<div class="messages-empty-thread">Compose your message below.</div>'
	}

	renderProjectPanel([])
	renderMessageThreads()
	updateMessagesEmptyState()
}

async function initializeMessagesTab(forceSync = false) {
	const authorized = await ensureMessagesAuthorization()
	if (!authorized) return

	await refreshSyftboxState()

	const shouldImmediate = !messagesInitialized || forceSync

	if (shouldImmediate) {
		await loadMessageThreads(true)
	} else {
		await loadMessageThreads(false)
	}
	messagesInitialized = true

	updateMessagesEmptyState()

	if (syftboxStatus.running) {
		startMessagesAutoRefresh(false)
	}
}

async function sendCurrentMessage() {
	if (!messagesAuthorized) {
		alert('Authorize SyftBox before sending messages.')
		return
	}

	const bodyInput = document.getElementById('message-compose-body')
	if (!bodyInput) return
	const body = bodyInput.value.trim()
	if (!body) {
		alert('Message body cannot be empty.')
		return
	}

	const subjectInput = document.getElementById('message-compose-subject')
	const subject = subjectInput ? subjectInput.value.trim() : ''

	const recipientInput = document.getElementById('message-recipient-input')
	const toValue = recipientInput ? recipientInput.value.trim() : ''

	if (isComposingNewMessage && !toValue) {
		alert('Recipient email is required.')
		return
	}

	const sendBtn = document.getElementById('message-send-btn')
	if (sendBtn) sendBtn.disabled = true

	try {
		const payload = {
			body,
			subject: subject || null,
			reply_to: !isComposingNewMessage ? messageReplyTargetId : null,
			to: isComposingNewMessage ? toValue : null,
		}

		const result = await invoke('send_message', { request: payload })
		isComposingNewMessage = false
		const threadId = result.thread_id || result.id
		setActiveMessageFilterButton('sent')
		await loadMessageThreads(true)
		await openThread(threadId)
	} catch (error) {
		console.error('Failed to send message:', error)
		alert(`Failed to send message: ${error}`)
	} finally {
		if (sendBtn) sendBtn.disabled = false
	}
}

async function deleteMessage(messageId) {
	if (!messageId) return
	if (!messagesAuthorized) {
		alert('SyftBox must be authorized to manage messages.')
		return
	}

	const confirmed = confirm('Delete this message?')
	if (!confirmed) return

	try {
		await invoke('delete_message', { messageId })
		await loadMessageThreads(true)
	} catch (error) {
		console.error('Failed to delete message:', error)
		alert(`Failed to delete message: ${error}`)
	}
}

async function setSyftboxTarget(target) {
	const dropdown = document.getElementById('message-syftbox-dropdown')
	if (dropdown) dropdown.disabled = true

	try {
		if (target === 'online') {
			syftboxStatus = await invoke('start_syftbox_client')
			await loadMessageThreads(true)
			startMessagesAutoRefresh(true)
		} else {
			syftboxStatus = await invoke('stop_syftbox_client')
			stopMessagesAutoRefresh()
		}
	} catch (error) {
		console.error('Failed to toggle SyftBox:', error)
		alert(`Failed to ${target === 'online' ? 'start' : 'stop'} SyftBox: ${error}`)
	} finally {
		if (dropdown) dropdown.disabled = false
	}

	updateSyftboxIndicator()
}

function navigateTo(viewName) {
	// Check if import is in progress
	if (isImportInProgress && viewName !== 'import-review') {
		const confirmed = confirm(
			'Import is currently in progress. Are you sure you want to cancel and leave this page?',
		)
		if (!confirmed) {
			return // Don't navigate
		}
		// User confirmed - cancel the import
		isImportInProgress = false
	}

	const tabContents = document.querySelectorAll('.tab-content')
	tabContents.forEach((content) => {
		content.classList.remove('active')
		content.style.display = 'none'
	})

	const targetView = document.getElementById(`${viewName}-view`)
	if (!targetView) {
		console.warn(`navigateTo: Unknown view "${viewName}"`)
		return
	}

	targetView.classList.add('active')
	targetView.style.display = ''
	activeView = viewName

	// Only update tab highlighting if this view has a corresponding tab
	const tab = document.querySelector(`.tab[data-tab="${viewName}"]`)
	if (tab) {
		document.querySelectorAll('.tab').forEach((t) => t.classList.remove('active'))
		tab.classList.add('active')
	}

	if (viewName === 'participants') {
		loadParticipants()
	} else if (viewName === 'files') {
		loadFiles()
	} else if (viewName === 'projects') {
		loadProjects()
	} else if (viewName === 'run') {
		selectedParticipants = []
		selectedProject = null
		document.getElementById('select-all-participants').checked = false
		loadRunParticipants()
		loadRunProjects()
		updateRunButton()
	} else if (viewName === 'runs') {
		loadRuns()
	} else if (viewName === 'logs') {
		displayLogs()
	} else if (viewName === 'settings') {
		loadSettings()
	} else if (viewName === 'messages') {
		initializeMessagesTab(!messagesInitialized)
		if (messagesAuthorized && syftboxStatus.running) {
			startMessagesAutoRefresh(true)
		}
	}

	if (viewName !== 'messages') {
		stopMessagesAutoRefresh()
	}
}

// Function to load saved dependency states without re-checking
async function loadSavedDependencies(listPanelId, detailsPanelId) {
	const depsList = document.getElementById(listPanelId)
	if (!depsList) return

	try {
		// Get saved states from config without re-checking
		const result = await invoke('get_saved_dependency_states')
		dependencyResults = result
		window.displayDependencies(result, listPanelId, detailsPanelId, true)
	} catch (error) {
		console.error('Failed to load saved dependencies:', error)
		depsList.innerHTML = `
			<div style="text-align: center; color: #999; padding: 20px;">
				<p>No saved dependency states</p>
				<p style="font-size: 12px; margin-top: 10px;">Click "Check Again" to scan</p>
			</div>
		`
	}
}

async function checkDependenciesForPanel(listPanelId, detailsPanelId, isSettings = false) {
	const depsList = document.getElementById(listPanelId)
	if (!depsList) return

	// Show loading state
	depsList.innerHTML = `
		<div style="text-align: center; color: #999; padding: 20px;">
			<div class="spinner" style="width: 24px; height: 24px; margin: 0 auto 15px;"></div>
			<p>Checking dependencies...</p>
		</div>
	`

	try {
		const result = await invoke('check_dependencies')
		dependencyResults = result
		if (typeof window.displayDependencies === 'function') {
			window.displayDependencies(result, listPanelId, detailsPanelId, isSettings)
		}
	} catch (error) {
		console.error('Failed to check dependencies:', error)
		depsList.innerHTML = `
			<div style="color: #dc3545; padding: 20px; text-align: center;">
				<p>❌ Failed to check dependencies</p>
				<p style="font-size: 12px; margin-top: 10px;">${error}</p>
			</div>
		`
	}
}

window.addEventListener('DOMContentLoaded', () => {
	console.log('🔥 DOMContentLoaded fired')
	refreshExistingFilePaths()
	loadParticipants()
	loadFiles()
	loadProjects()
	loadCommandLogs()
	loadSettings()
	updateSelectedFileCount()

	// Initialize column resizers
	initColumnResizers()

	// Add sort header click listeners
	document.querySelectorAll('.file-list-header div[data-sort]').forEach((header) => {
		header.addEventListener('click', () => {
			setSortField(header.dataset.sort)
		})
	})

	document.querySelectorAll('.home-btn').forEach((btn) => {
		btn.addEventListener('click', () => {
			const nav = btn.dataset.nav
			navigateTo(nav)
		})
	})

	document.querySelectorAll('.tab').forEach((tab) => {
		tab.addEventListener('click', () => {
			const targetTab = tab.dataset.tab

			// Check if user is leaving import workflow
			const currentView = document.querySelector('.tab-content.active')?.id
			const inImportWorkflow = currentView === 'import-view' || currentView === 'import-review-view'
			const leavingImport = inImportWorkflow && targetTab !== 'import'

			if (leavingImport) {
				if (
					!confirm(
						'You are in the middle of importing files. Are you sure you want to leave? Your progress will be lost.',
					)
				) {
					return
				}
			}

			navigateTo(targetTab)
		})
	})

	const messageFilterButtons = document.querySelectorAll('.message-filter')
	messageFilterButtons.forEach((btn) => {
		btn.addEventListener('click', () => {
			if (btn.classList.contains('active')) return
			setActiveMessageFilterButton(btn.dataset.filter)
			activeThreadId = null
			activeThreadMessages = []
			messageReplyTargetId = null
			loadMessageThreads(false)
		})
	})

	const refreshMessagesBtn = document.getElementById('refresh-messages-btn')
	if (refreshMessagesBtn) {
		refreshMessagesBtn.addEventListener('click', () => loadMessageThreads(true))
	}

	const newMessageBtn = document.getElementById('new-message-btn')
	if (newMessageBtn) {
		newMessageBtn.addEventListener('click', () => {
			if (!messagesAuthorized) {
				ensureMessagesAuthorization()
				return
			}
			startNewMessage()
		})
	}

	const sendMessageBtn = document.getElementById('message-send-btn')
	if (sendMessageBtn) {
		sendMessageBtn.addEventListener('click', sendCurrentMessage)
	}

	const syftboxDropdown = document.getElementById('message-syftbox-dropdown')
	if (syftboxDropdown) {
		syftboxDropdown.addEventListener('change', (event) => {
			const target = event.target.value
			if (
				(target === 'online' && syftboxStatus.running) ||
				(target === 'offline' && !syftboxStatus.running)
			) {
				return
			}
			setSyftboxTarget(target)
		})
	}

	const messagesAuthBtn = document.getElementById('messages-auth-btn')
	if (messagesAuthBtn) {
		messagesAuthBtn.addEventListener('click', async () => {
			await handleSyftBoxAuthentication()
			await initializeMessagesTab(true)
		})
	}

	const projectBtn = document.getElementById('message-view-project-btn')
	if (projectBtn) {
		projectBtn.addEventListener('click', () => navigateTo('projects'))
	}

	const composeBody = document.getElementById('message-compose-body')
	if (composeBody) {
		composeBody.addEventListener('keydown', (event) => {
			if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
				event.preventDefault()
				sendCurrentMessage()
			}
		})
	}

	const emptyStartBtn = document.getElementById('empty-start-message-btn')
	if (emptyStartBtn) {
		emptyStartBtn.addEventListener('click', () => {
			if (!messagesAuthorized) {
				ensureMessagesAuthorization()
				return
			}
			startNewMessage()
		})
	}

	const deleteThreadBtn = document.getElementById('delete-thread-btn')
	if (deleteThreadBtn) {
		deleteThreadBtn.addEventListener('click', async () => {
			if (!activeThreadId) return
			if (!messagesAuthorized) {
				alert('SyftBox must be authorized to manage messages.')
				return
			}
			if (!confirm('Delete all messages in this thread?')) {
				return
			}
			try {
				await invoke('delete_thread', { threadId: activeThreadId })
				activeThreadId = null
				activeThreadMessages = []
				messageReplyTargetId = null
				isComposingNewMessage = true
				updateComposeVisibility(true)
				renderConversation([])
				renderProjectPanel([])
				await loadMessageThreads(true)
				if (messageThreads.length > 0) {
					const nextThread = messageThreads[0]
					await openThread(nextThread.thread_id)
				} else {
					startNewMessage()
				}
			} catch (error) {
				console.error('Failed to delete thread:', error)
				alert(`Failed to delete thread: ${error}`)
			}
		})
	}

	setActiveMessageFilterButton(messageFilter)

	document.getElementById('done-btn').addEventListener('click', () => {
		navigateTo('home')
	})

	updateComposeVisibility(false)

	// File type tab switching
	document.querySelectorAll('.file-type-tab').forEach((tab) => {
		tab.addEventListener('click', () => {
			const fileType = tab.dataset.type

			// Update active state
			document.querySelectorAll('.file-type-tab').forEach((t) => {
				t.classList.remove('active')
				t.style.borderBottom = '3px solid transparent'
				t.style.color = '#666'
			})

			tab.classList.add('active')
			tab.style.borderBottom = '3px solid #007bff'
			tab.style.color = '#007bff'

			// Update filter and reload files
			currentFileTypeFilter = fileType
			selectedFilesForDelete = []
			renderFilesTable()
		})
	})

	document.getElementById('close-logs-btn').addEventListener('click', () => {
		document.getElementById('log-viewer').style.display = 'none'
	})

	document.getElementById('share-logs-btn').addEventListener('click', async () => {
		if (currentLogWorkDir) {
			try {
				await invoke('open_folder', { path: currentLogWorkDir })
			} catch (error) {
				alert(`Error opening folder: ${error}`)
			}
		}
	})

	// Settings save/reset buttons removed from UI

	// SyftBox authentication button
	const syftboxAuthBtn = document.getElementById('syftbox-auth-btn')
	if (syftboxAuthBtn) {
		syftboxAuthBtn.addEventListener('click', async () => {
			await handleSyftBoxAuthentication()
		})
	}

	// Settings dependency buttons
	const settingsCheckBtn = document.getElementById('settings-check-again-btn')
	if (settingsCheckBtn) {
		settingsCheckBtn.addEventListener('click', () => {
			checkDependenciesForPanel('settings-deps-list', 'settings-dep-details-panel', true)
		})
	}

	const settingsInstallBtn = document.getElementById('settings-install-missing-deps-btn')
	if (settingsInstallBtn) {
		settingsInstallBtn.addEventListener('click', async () => {
			if (!dependencyResults) return

			const missingDeps = dependencyResults.dependencies.filter(
				(dep) => !dep.found || (dep.running !== null && dep.running === false),
			)

			if (missingDeps.length === 0) {
				alert('All dependencies are already installed!')
				return
			}

			// Show install modal
			const modal = document.getElementById('install-modal')
			const progressBar = document.getElementById('install-progress-bar')
			const statusText = document.getElementById('install-status-text')
			const installLog = document.getElementById('install-log')
			const closeBtn = document.getElementById('install-close-btn')

			modal.style.display = 'flex'
			closeBtn.disabled = true
			installLog.innerHTML = ''
			progressBar.style.width = '0%'

			try {
				for (let i = 0; i < missingDeps.length; i++) {
					const dep = missingDeps[i]
					const progress = ((i / missingDeps.length) * 100).toFixed(0)
					progressBar.style.width = `${progress}%`
					statusText.textContent = `Installing ${dep.name}...`
					installLog.innerHTML += `\n[${new Date().toLocaleTimeString()}] Installing ${
						dep.name
					}...\n`

					try {
						const result = await invoke('install_dependency', { name: dep.name })
						if (result) {
							installLog.innerHTML += `✓ ${dep.name} installed successfully at: ${result}\n`
						} else {
							installLog.innerHTML += `✓ ${dep.name} installed successfully\n`
						}
					} catch (error) {
						installLog.innerHTML += `✗ Failed to install ${dep.name}: ${error}\n`
					}
				}

				progressBar.style.width = '100%'
				statusText.textContent = 'Installation complete! Checking dependencies...'
				installLog.innerHTML += `\n[${new Date().toLocaleTimeString()}] Installation complete!\n`

				// Re-check dependencies
				await checkDependenciesForPanel('settings-deps-list', 'settings-dep-details-panel', true)
			} finally {
				closeBtn.disabled = false
			}
		})
	}

	document.getElementById('copy-logs-btn').addEventListener('click', copyLogs)
	document.getElementById('clear-logs-btn').addEventListener('click', clearLogs)

	document.getElementById('select-all-participants-table').addEventListener('change', (e) => {
		const checkboxes = document.querySelectorAll('.participant-checkbox')
		checkboxes.forEach((checkbox) => {
			checkbox.checked = e.target.checked
			const id = parseInt(checkbox.dataset.id)
			if (e.target.checked) {
				if (!selectedParticipantsForDelete.includes(id)) {
					selectedParticipantsForDelete.push(id)
				}
			} else {
				selectedParticipantsForDelete = selectedParticipantsForDelete.filter((x) => x !== id)
			}
		})
		updateDeleteParticipantsButton()
	})

	document
		.getElementById('delete-selected-participants-btn')
		.addEventListener('click', async () => {
			if (selectedParticipantsForDelete.length === 0) return

			if (
				confirm(
					`Are you sure you want to delete ${selectedParticipantsForDelete.length} participant(s)? This will also delete all associated files.`,
				)
			) {
				try {
					const deleted = await invoke('delete_participants_bulk', {
						participantIds: selectedParticipantsForDelete,
					})
					console.log(`Deleted ${deleted} participant(s)`)
					await loadParticipants()
					await loadFiles()
				} catch (error) {
					alert(`Error deleting participants: ${error}`)
				}
			}
		})

	document.getElementById('select-all-files-table').addEventListener('change', (e) => {
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

	// Update queue processor button based on status
	async function updateQueueButton() {
		try {
			const isRunning = await invoke('get_queue_processor_status')
			const btn = document.getElementById('process-queue-btn')
			const icon = document.getElementById('queue-btn-icon')
			const text = document.getElementById('queue-btn-text')
			const spinner = document.getElementById('queue-spinner')
			queueProcessorRunning = isRunning
			const pendingCount = parseInt(document.getElementById('pending-count').textContent, 10) || 0

			if (isRunning) {
				icon.textContent = '⏸'
				text.textContent = 'Pause Queue'
				btn.style.background = '#28a745' // Green
			} else {
				icon.textContent = '▶'
				text.textContent = 'Resume Queue'
				btn.style.background = '#ffc107' // Yellow
			}

			if (spinner) {
				spinner.style.display = queueProcessorRunning && pendingCount > 0 ? 'inline-block' : 'none'
			}
		} catch (error) {
			console.error('Error getting queue status:', error)
		}
	}

	document.getElementById('process-queue-btn').addEventListener('click', async () => {
		try {
			const isRunning = await invoke('get_queue_processor_status')

			if (isRunning) {
				await invoke('pause_queue_processor')
			} else {
				await invoke('resume_queue_processor')
			}

			await updateQueueButton()
			await loadFiles() // Refresh files list
		} catch (error) {
			alert(`Error toggling queue processor: ${error}`)
		}
	})

	// Poll queue status and pending count every 3 seconds
	setInterval(async () => {
		await updateQueueButton()

		// Auto-refresh files panel when queue is active
		const isFilesTabActive = document.getElementById('files-view')?.classList.contains('active')
		const pendingCount = parseInt(document.getElementById('pending-count')?.textContent || '0', 10)

		if (queueProcessorRunning && isFilesTabActive && pendingCount > 0) {
			await loadFiles()
		}
	}, 3000)

	// Initial button update
	updateQueueButton()

	document.getElementById('delete-selected-files-btn').addEventListener('click', async () => {
		if (selectedFilesForDelete.length === 0) return

		if (confirm(`Are you sure you want to delete ${selectedFilesForDelete.length} file(s)?`)) {
			try {
				const deleted = await invoke('delete_files_bulk', { fileIds: selectedFilesForDelete })
				console.log(`Deleted ${deleted} file(s)`)
				await loadFiles()
			} catch (error) {
				alert(`Error deleting files: ${error}`)
			}
		}
	})

	const filesSearchInput = document.getElementById('files-search')
	if (filesSearchInput) {
		filesSearchInput.addEventListener('input', (e) => {
			filesSearchTerm = e.target.value.trim().toLowerCase()
			renderFilesTable()
		})
	}

	const participantsSearchInput = document.getElementById('participants-search')
	if (participantsSearchInput) {
		participantsSearchInput.addEventListener('input', (e) => {
			participantsSearchTerm = e.target.value.trim().toLowerCase()
			renderParticipantsTable()
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

	updateFilesSortIndicators()

	document.getElementById('pick-folder').addEventListener('click', pickFolder)
	document.getElementById('import-btn').addEventListener('click', goToReviewStep)

	// Reset button on Step 1
	const resetBtn = document.getElementById('reset-import-btn')
	if (resetBtn) {
		resetBtn.addEventListener('click', () => {
			console.log('Reset button clicked')
			resetImportState()
		})
	} else {
		console.error('reset-import-btn not found')
	}

	// Step 2 Review view listeners
	const detectBtn = document.getElementById('detect-types-btn')
	const backBtn = document.getElementById('review-back-btn')
	const reviewImportBtn = document.getElementById('review-import-btn')

	if (detectBtn) {
		detectBtn.addEventListener('click', detectFileTypes)
	} else {
		console.error('detect-types-btn not found')
	}

	if (backBtn) {
		backBtn.addEventListener('click', () => {
			console.log('Back button clicked')
			navigateTo('import')
		})
	} else {
		console.error('review-back-btn not found')
	}

	if (reviewImportBtn) {
		reviewImportBtn.addEventListener('click', finalizeImport)
	} else {
		console.error('review-import-btn not found')
	}

	// Set All dropdowns - only apply to selected files
	document.getElementById('set-all-datatype').addEventListener('change', (e) => {
		if (!e.target.value) return
		if (selectedReviewFiles.size === 0) {
			alert('Please select files to update')
			e.target.value = ''
			return
		}
		selectedReviewFiles.forEach((file) => {
			reviewFileMetadata[file].data_type = e.target.value
		})
		showReviewView()
		e.target.value = ''
	})

	document.getElementById('set-all-source').addEventListener('change', (e) => {
		if (!e.target.value) return
		if (selectedReviewFiles.size === 0) {
			alert('Please select files to update')
			e.target.value = ''
			return
		}
		selectedReviewFiles.forEach((file) => {
			reviewFileMetadata[file].source = e.target.value
		})
		showReviewView()
		e.target.value = ''
	})

	document.getElementById('set-all-grch').addEventListener('change', (e) => {
		if (!e.target.value) return
		if (selectedReviewFiles.size === 0) {
			alert('Please select files to update')
			e.target.value = ''
			return
		}
		selectedReviewFiles.forEach((file) => {
			reviewFileMetadata[file].grch_version = e.target.value
		})
		showReviewView()
		e.target.value = ''
	})

	// Select all checkbox in review view
	document.getElementById('select-all-review').addEventListener('change', (e) => {
		const allFiles = Object.keys(reviewFileMetadata)
		if (e.target.checked) {
			allFiles.forEach((file) => selectedReviewFiles.add(file))
		} else {
			selectedReviewFiles.clear()
		}
		showReviewView()
	})

	// Sortable headers in review view
	document.querySelectorAll('#import-review-view .sortable-header').forEach((header) => {
		header.addEventListener('click', () => {
			const field = header.dataset.sortField
			setReviewSortField(field)
		})
	})

	document.getElementById('select-all-files').addEventListener('change', (e) => {
		if (e.target.checked) {
			currentFiles.forEach((file) => {
				if (!existingFilePaths.has(file)) {
					selectedFiles.add(file)
				}
			})
		} else {
			selectedFiles.clear()
		}
		renderFiles()
	})
	document.getElementById('create-project-btn').addEventListener('click', () => {
		showCreateProjectModal()
	})
	document.getElementById('create-project-cancel').addEventListener('click', () => {
		hideCreateProjectModal()
	})
	document.getElementById('create-project-confirm').addEventListener('click', () => {
		createProjectFromModal()
	})
	document.getElementById('new-project-name').addEventListener('input', () => {
		handleProjectNameInputChange()
	})
	document.getElementById('new-project-name').addEventListener('keypress', (e) => {
		if (e.key === 'Enter') {
			createProjectFromModal()
		}
	})
	document.getElementById('project-path-browse-btn').addEventListener('click', async () => {
		await chooseProjectDirectory()
	})
	document.getElementById('project-path-reset-btn').addEventListener('click', async () => {
		await resetProjectDirectory()
	})
	document.getElementById('import-project-btn').addEventListener('click', () => {
		console.log('Import project button clicked')
		importProject()
	})
	document.getElementById('run-btn').addEventListener('click', runAnalysis)
	document
		.getElementById('project-edit-save-btn')
		.addEventListener('click', handleSaveProjectEditor)
	document.getElementById('project-edit-cancel-btn').addEventListener('click', () => {
		navigateTo('projects')
	})
	document.getElementById('project-edit-back-btn').addEventListener('click', () => {
		navigateTo('projects')
	})
	document
		.getElementById('project-edit-launch-jupyter-btn')
		.addEventListener('click', handleLaunchJupyter)
	document
		.getElementById('project-edit-reset-jupyter-btn')
		.addEventListener('click', handleResetJupyter)

	document.getElementById('select-all-participants').addEventListener('change', (e) => {
		const checkboxes = document.querySelectorAll('#run-participants-list input[type="checkbox"]')
		const items = document.querySelectorAll('#run-participants-list .selection-item')

		checkboxes.forEach((checkbox, index) => {
			checkbox.checked = e.target.checked
			const item = items[index]
			const participantId = parseInt(item.dataset.id)

			if (e.target.checked) {
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
	})

	const fileTypeSelect = document.getElementById('file-type-select')
	const customExtension = document.getElementById('custom-extension')
	const customExtInput = document.getElementById('custom-ext-input')
	const customPattern = document.getElementById('custom-pattern')

	fileTypeSelect.addEventListener('change', (e) => {
		if (e.target.value === 'custom') {
			customExtension.style.display = 'block'
		} else {
			customExtension.style.display = 'none'
			searchFiles()
		}
	})

	customExtInput.addEventListener('input', () => {
		searchFiles()
	})

	customPattern.addEventListener('input', (e) => {
		document.querySelectorAll('.pattern-btn').forEach((b) => b.classList.remove('active'))
		currentPattern = e.target.value
		renderFiles()
		updateImportButton()
	})

	// Wrapper for onboarding
	async function checkDependencies() {
		await checkDependenciesForPanel('deps-list', 'dep-details-panel', false)
	}

	// Function to copy text to clipboard
	async function copyToClipboard(text) {
		try {
			await navigator.clipboard.writeText(text)
			return true
		} catch (err) {
			console.error('Failed to copy:', err)
			return false
		}
	}

	// Function to show dependency details in right panel (expose globally)
	window.showDependencyDetails = function showDependencyDetails(
		dep,
		depIndex,
		detailsPanelId = 'dep-details-panel',
	) {
		const detailsPanel = document.getElementById(detailsPanelId)
		// Docker Desktop can be installed but not running, so treat found=true as installed
		const isInstalled = dep.found

		if (isInstalled) {
			// Show installed dependency details
			let description = dep.description || 'This dependency is installed and ready to use.'

			// Add warning if Docker is installed but not running
			if (dep.name === 'Docker' && dep.running === false) {
				description =
					'Docker Desktop is installed but not currently running. Please start Docker Desktop to use it.'
			}

			detailsPanel.innerHTML = `
				<div style="margin-bottom: 20px;">
					<div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px; gap: 10px;">
						<h3 style="margin: 0; color: #28a745; font-size: 20px; white-space: nowrap;">✓ ${dep.name}</h3>
						${
							dep.website
								? `
						<button id="open-website-btn-${depIndex}" style="padding: 4px; width: auto; min-width: 0; background: transparent; border: none; cursor: pointer; font-size: 18px; line-height: 1; opacity: 0.7; transition: opacity 0.2s; flex-shrink: 0; margin-left: auto;" title="Open ${dep.name} website" onmouseover="this.style.opacity='1'" onmouseout="this.style.opacity='0.7'">🔗</button>
						`
								: ''
						}
					</div>
					<p style="color: #666; font-size: 13px; margin: 0 0 15px 0;">${description}</p>
				</div>

				<div style="background: #f8f9fa; padding: 15px; border-radius: 6px; margin-bottom: 15px;">
					${
						dep.version
							? `
					<div style="margin-bottom: 12px;">
						<strong style="font-size: 13px; color: #333;">Version:</strong>
						<div style="font-family: monospace; font-size: 12px; color: #666; margin-top: 5px;">${dep.version}</div>
					</div>
					`
							: ''
					}

					${
						dep.running !== null
							? `
					<div style="margin-bottom: 12px;">
						<strong style="font-size: 13px; color: #333;">Status:</strong>
						<div style="font-size: 12px; color: ${dep.running ? '#28a745' : '#dc3545'}; margin-top: 5px;">
							${dep.running ? '🟢 Running' : '🔴 Not Running'}
						</div>
					</div>
					`
							: ''
					}

					<div style="margin-bottom: 12px;">
						<strong style="font-size: 13px; color: #333;">Path:</strong>
						<div style="margin-top: 8px; display: flex; gap: 8px; align-items: center;">
							<input
								type="text"
								id="path-input-${depIndex}"
								value="${dep.path || ''}"
								placeholder="Enter path to ${dep.name} executable"
								autocapitalize="off"
								style="flex: 1; padding: 8px; border: 1px solid #ddd; border-radius: 4px; font-family: monospace; font-size: 12px;"
							/>
						</div>
					</div>

					<div style="display: flex; gap: 8px;">
						<button id="reset-path-btn-${depIndex}" style="padding: 8px 16px; background: #6c757d; color: white; border: none; border-radius: 4px; cursor: pointer; font-size: 12px;">Reset</button>
						<button id="check-path-btn-${depIndex}" style="padding: 8px 16px; background: #17a2b8; color: white; border: none; border-radius: 4px; cursor: pointer; font-size: 12px;">Check Again</button>
					</div>
					<p style="font-size: 10px; color: #666; margin-top: 8px;">Reset auto-detects, Check Again verifies your path</p>
				</div>

			`

			// Add open website handler
			const openWebsiteBtn = document.getElementById(`open-website-btn-${depIndex}`)
			if (openWebsiteBtn) {
				openWebsiteBtn.addEventListener('click', async () => {
					if (dep.website) {
						try {
							// Use custom Tauri command to open URL in default browser
							await invoke('open_url', { url: dep.website })
						} catch (error) {
							console.error('Failed to open URL:', error)
						}
					}
				})
			}

			// Add reset path handler - auto-detect
			const resetPathBtn = document.getElementById(`reset-path-btn-${depIndex}`)
			if (resetPathBtn) {
				resetPathBtn.addEventListener('click', async () => {
					try {
						// Clear custom path by saving empty string, which triggers auto-detect
						await invoke('save_custom_path', { name: dep.name, path: '' })

						// Check the dependency without custom path (auto-detect)
						const result = await invoke('check_single_dependency', { name: dep.name, path: null })

						// Update the dependency data
						dep.found = result.found
						dep.path = result.path
						dep.version = result.version
						dep.running = result.running

						// Update the dependency list item
						const depItem = document.querySelector(`.dep-item[data-dep-index="${depIndex}"]`)
						if (depItem) {
							// Docker Desktop can be installed but not running, so treat found=true as installed
							const isInstalled = dep.found
							let statusIcon = isInstalled ? '✓' : '✗'
							let statusColor = isInstalled ? '#28a745' : '#dc3545'

							// Show warning color if Docker is installed but not running
							if (dep.name === 'Docker' && dep.found && dep.running === false) {
								statusColor = '#ffc107' // Warning yellow
								statusIcon = '⚠️' // Warning icon
							}

							depItem.innerHTML = `
								<span style="font-size: 18px; color: ${statusColor};">${statusIcon}</span>
								<strong style="font-size: 13px; color: #333; flex: 1;">${dep.name}</strong>
							`
						}

						// Re-render this specific dependency details
						showDependencyDetails(dep, depIndex)

						// Update the UI with the result
						if (result.found) {
							await window.__TAURI__.dialog.message(
								`✓ ${dep.name} auto-detected!\n\nPath: ${result.path}\nVersion: ${
									result.version || 'Unknown'
								}`,
								{ title: 'Success', type: 'info' },
							)
						} else {
							await window.__TAURI__.dialog.message(
								`✗ ${dep.name} not found automatically.\n\nPlease install it or enter a custom path.`,
								{ title: 'Not Found', type: 'warning' },
							)
						}
					} catch (error) {
						await window.__TAURI__.dialog.message(`Error resetting path: ${error}`, {
							title: 'Error',
							type: 'error',
						})
					}
				})
			}

			// Add check path handler - verify custom path
			const checkPathBtn = document.getElementById(`check-path-btn-${depIndex}`)
			if (checkPathBtn) {
				checkPathBtn.addEventListener('click', async () => {
					const pathInput = document.getElementById(`path-input-${depIndex}`)
					const customPath = pathInput.value.trim()

					if (!customPath) {
						await window.__TAURI__.dialog.message('Please enter a path to check', {
							title: 'Empty Path',
							type: 'warning',
						})
						return
					}

					try {
						// Check this single dependency with the custom path (WITHOUT saving first)
						const result = await invoke('check_single_dependency', {
							name: dep.name,
							path: customPath,
						})

						// Update the UI with the result
						if (result.found) {
							// Path is valid - save it and update just this dependency
							await invoke('save_custom_path', { name: dep.name, path: customPath })

							// Update the dependency data
							dep.found = result.found
							dep.path = result.path || customPath
							dep.version = result.version
							dep.running = result.running

							// Update the dependency list item to show as installed
							const depItem = document.querySelector(`.dep-item[data-dep-index="${depIndex}"]`)
							if (depItem) {
								depItem.innerHTML = `
									<span style="font-size: 18px; color: #28a745;">✓</span>
									<strong style="font-size: 13px; color: #333; flex: 1;">${dep.name}</strong>
								`
							}

							// Re-render this specific dependency details
							showDependencyDetails(dep, depIndex)

							await window.__TAURI__.dialog.message(
								`✓ ${dep.name} found!\n\nPath: ${result.path || customPath}\nVersion: ${
									result.version || 'Unknown'
								}`,
								{ title: 'Success', type: 'info' },
							)
						} else {
							// Path is invalid - mark as missing but keep the invalid path in the input
							dep.found = false
							dep.path = null
							dep.version = null
							dep.running = null

							// Update the dependency list item to show as missing
							const depItem = document.querySelector(`.dep-item[data-dep-index="${depIndex}"]`)
							if (depItem) {
								depItem.innerHTML = `
									<span style="font-size: 18px; color: #dc3545;">✗</span>
									<strong style="font-size: 13px; color: #333; flex: 1;">${dep.name}</strong>
								`
							}

							// Re-render as missing dependency (but keep the path in the input)
							showDependencyDetails(dep, depIndex)

							// Keep the invalid path in the input box
							setTimeout(() => {
								const pathInput = document.getElementById(`path-input-${depIndex}`)
								if (pathInput) {
									pathInput.value = customPath
								}
							}, 100)

							await window.__TAURI__.dialog.message(
								`✗ ${dep.name} not found at the specified path.\n\nPlease check the path and try again.`,
								{ title: 'Not Found', type: 'warning' },
							)
						}
					} catch (error) {
						await window.__TAURI__.dialog.message(`Error: ${error}`, {
							title: 'Error',
							type: 'error',
						})
					}
				})
			}
		} else {
			// Show missing dependency details with install button
			const description = dep.description || 'This dependency is not installed.'
			const rawInstructions = dep.install_instructions || 'No installation instructions available'
			const installInstructions = filterInstructionsByOS(rawInstructions)
			const commands = extractCommands(rawInstructions)

			detailsPanel.innerHTML = `
				<div style="margin-bottom: 20px;">
					<div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px; gap: 10px;">
						<h3 style="margin: 0; color: #dc3545; font-size: 20px; white-space: nowrap;">✗ ${dep.name}</h3>
						${
							dep.website
								? `
						<button id="open-website-btn-${depIndex}" style="padding: 4px; width: auto; min-width: 0; background: transparent; border: none; cursor: pointer; font-size: 18px; line-height: 1; opacity: 0.7; transition: opacity 0.2s; flex-shrink: 0; margin-left: auto;" title="Open ${dep.name} website" onmouseover="this.style.opacity='1'" onmouseout="this.style.opacity='0.7'">🔗</button>
						`
								: ''
						}
					</div>
					<p style="color: #666; font-size: 13px; margin: 0 0 15px 0;">${description}</p>
				</div>

				<div style="background: #f8f9fa; padding: 15px; border-radius: 6px; margin-bottom: 15px;">
					<div style="margin-bottom: 12px;">
						<strong style="font-size: 13px; color: #333;">Path:</strong>
						<div style="margin-top: 8px; display: flex; gap: 8px; align-items: center;">
							<input
								type="text"
								id="path-input-${depIndex}"
								value="${dep.path || ''}"
								placeholder="Enter path to ${dep.name} executable (or install)"
								autocapitalize="off"
								style="flex: 1; padding: 8px; border: 1px solid #ddd; border-radius: 4px; font-family: monospace; font-size: 12px;"
							/>
						</div>
					</div>

					<div style="display: flex; gap: 8px; margin-bottom: 8px;">
						<button id="install-single-btn-${depIndex}" style="padding: 8px 16px; background: #28a745; color: white; border: none; border-radius: 4px; cursor: pointer; font-size: 12px; font-weight: 600;">Install</button>
						<button id="check-path-btn-${depIndex}" style="padding: 8px 16px; background: #17a2b8; color: white; border: none; border-radius: 4px; cursor: pointer; font-size: 12px;">Check Again</button>
					</div>
					<p style="font-size: 10px; color: #666; margin-top: 4px;">Install auto-detects, Check Again verifies your manual path</p>
				</div>

				<div style="background: #fff8e1; padding: 15px; border-left: 4px solid #ffc107; border-radius: 4px; margin-bottom: 20px; position: relative;">
					<div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px;">
						<h4 style="margin: 0; color: #856404; font-size: 14px;">📖 Manual Installation</h4>
						${
							commands.length > 0
								? `
							<button class="copy-cmd-btn" data-command="${encodeURIComponent(
								commands[0],
							)}" style="padding: 2px; min-width: 0; width: auto; background: transparent; border: none; cursor: pointer; font-size: 14px; line-height: 1; opacity: 0.7; transition: opacity 0.2s;" title="Copy command" onmouseover="this.style.opacity='1'" onmouseout="this.style.opacity='0.7'">📋</button>
						`
								: ''
						}
					</div>
					<p style="font-size: 12px; color: #856404; margin-bottom: 10px;">You can also install this dependency manually:</p>

					${
						commands.length > 0
							? commands
									.map(
										(cmd) => `
						<div style="background: #1e1e1e; padding: 10px; border-radius: 4px; margin-bottom: 8px;">
							<pre style="color: #d4d4d4; font-family: 'Courier New', monospace; font-size: 11px; margin: 0; white-space: pre-wrap; word-break: break-all;">${cmd}</pre>
						</div>
					`,
									)
									.join('')
							: `
						<div style="background: #f8f9fa; padding: 10px; border-radius: 4px; font-size: 11px; color: #333; white-space: pre-wrap; font-family: monospace;">${installInstructions}</div>
					`
					}
				</div>
			`

			// Add open website handler
			const openWebsiteBtn = document.getElementById(`open-website-btn-${depIndex}`)
			if (openWebsiteBtn) {
				openWebsiteBtn.addEventListener('click', async () => {
					if (dep.website) {
						try {
							// Use custom Tauri command to open URL in default browser
							await invoke('open_url', { url: dep.website })
						} catch (error) {
							console.error('Failed to open URL:', error)
						}
					}
				})
			}

			// Add install single button handler
			const installSingleBtn = document.getElementById(`install-single-btn-${depIndex}`)
			if (installSingleBtn) {
				installSingleBtn.addEventListener('click', async () => {
					// Check for brew on macOS before installing dependencies
					const currentPlatform = detectPlatform()
					if (currentPlatform === 'macos') {
						try {
							const brewInstalled = await invoke('check_brew_installed')
							if (!brewInstalled) {
								// Prompt user to install brew first
								const installBrew = await window.__TAURI__.dialog.confirm(
									'Homebrew is required to install this dependency.\n\nWould you like to install Homebrew first?',
									{ title: 'Homebrew Required', type: 'warning' },
								)

								if (installBrew) {
									try {
										// Show progress
										installSingleBtn.disabled = true
										installSingleBtn.textContent = 'Installing Homebrew...'

										await invoke('install_brew')

										await window.__TAURI__.dialog.message(
											'✓ Homebrew installed successfully!\n\nNow you can proceed with installing dependencies.',
											{ title: 'Success', type: 'info' },
										)

										// Restore button state
										installSingleBtn.disabled = false
										installSingleBtn.textContent = 'Install'

										// Don't proceed with dependency installation yet, let user click again
										return
									} catch (error) {
										await window.__TAURI__.dialog.message(
											`Failed to install Homebrew: ${error}\n\nPlease install Homebrew manually from brew.sh`,
											{ title: 'Installation Failed', type: 'error' },
										)

										// Restore button state
										installSingleBtn.disabled = false
										installSingleBtn.textContent = 'Install'
										return
									}
								} else {
									// User declined to install brew
									return
								}
							}
						} catch (error) {
							console.error('Failed to check brew installation:', error)
						}
					}

					const confirmed = await window.__TAURI__.dialog.confirm(
						`Install ${dep.name}?\n\nBioVault will attempt to install this dependency for you.`,
						{ title: 'Confirm Installation', type: 'warning' },
					)
					if (confirmed) {
						try {
							// Show progress
							installSingleBtn.disabled = true
							installSingleBtn.textContent = 'Installing...'

							// Install the dependency
							const installedPath = await invoke('install_dependency', { name: dep.name })

							if (installedPath) {
								// Update the path input with the installed path
								const pathInput = document.getElementById(`path-input-${depIndex}`)
								if (pathInput) {
									pathInput.value = installedPath
								}

								await window.__TAURI__.dialog.message(
									`✓ ${dep.name} installed successfully!\n\nPath: ${installedPath}`,
									{ title: 'Success', type: 'info' },
								)
							} else {
								await window.__TAURI__.dialog.message(
									`✓ ${dep.name} installed successfully!\n\nPlease check the path detection using 'Check Again'.`,
									{ title: 'Success', type: 'info' },
								)
							}

							// Re-check this dependency
							await checkDependencies()
						} catch (error) {
							await window.__TAURI__.dialog.message(`${error}`, {
								title: 'Installation Failed',
								type: 'error',
							})

							// Restore button state
							installSingleBtn.disabled = false
							installSingleBtn.textContent = 'Install'
						}
					}
				})
			}

			// Add check path handler - verify manual path for missing dependency
			const checkPathBtn = document.getElementById(`check-path-btn-${depIndex}`)
			if (checkPathBtn) {
				checkPathBtn.addEventListener('click', async () => {
					const pathInput = document.getElementById(`path-input-${depIndex}`)
					const customPath = pathInput.value.trim()

					if (!customPath) {
						await window.__TAURI__.dialog.message(
							'Please enter a path to check, or use the Install button',
							{ title: 'Empty Path', type: 'warning' },
						)
						return
					}

					try {
						// Check this single dependency with the custom path (WITHOUT saving first)
						const result = await invoke('check_single_dependency', {
							name: dep.name,
							path: customPath,
						})

						// Update the UI with the result
						if (result.found) {
							// Path is valid - save it and update just this dependency
							await invoke('save_custom_path', { name: dep.name, path: customPath })

							// Update the dependency data
							dep.found = result.found
							dep.path = result.path || customPath
							dep.version = result.version
							dep.running = result.running

							// Update the dependency list item
							const depItem = document.querySelector(`.dep-item[data-dep-index="${depIndex}"]`)
							if (depItem) {
								depItem.innerHTML = `
									<span style="font-size: 18px; color: #28a745;">✓</span>
									<strong style="font-size: 13px; color: #333; flex: 1;">${dep.name}</strong>
								`
							}

							// Re-render this specific dependency details
							showDependencyDetails(dep, depIndex)

							await window.__TAURI__.dialog.message(
								`✓ ${dep.name} found!\n\nPath: ${result.path || customPath}\nVersion: ${
									result.version || 'Unknown'
								}`,
								{ title: 'Success', type: 'info' },
							)
						} else {
							// Path is invalid - don't save it
							await window.__TAURI__.dialog.message(
								`✗ ${dep.name} not found at the specified path.\n\nPlease check the path and try again.`,
								{ title: 'Not Found', type: 'warning' },
							)
						}
					} catch (error) {
						await window.__TAURI__.dialog.message(`Error: ${error}`, {
							title: 'Error',
							type: 'error',
						})
					}
				})
			}

			// Add copy button handlers
			document.querySelectorAll('.copy-cmd-btn').forEach((btn) => {
				btn.addEventListener('click', async (e) => {
					e.stopPropagation()
					const command = decodeURIComponent(btn.dataset.command)
					await copyToClipboard(command)
					// Just copy silently, no visual change
				})
			})
		}
	}

	// Helper function to detect current platform
	function detectPlatform() {
		const userAgent = navigator.userAgent.toLowerCase()
		const platform = navigator.platform.toLowerCase()

		if (platform.indexOf('mac') !== -1 || userAgent.indexOf('macintosh') !== -1) {
			return 'macos'
		} else if (platform.indexOf('win') !== -1 || userAgent.indexOf('windows') !== -1) {
			return 'windows'
		} else if (platform.indexOf('linux') !== -1 || userAgent.indexOf('linux') !== -1) {
			return 'linux'
		}
		return 'unknown'
	}

	// Helper function to filter install instructions by current OS
	function filterInstructionsByOS(instructions) {
		const currentPlatform = detectPlatform()
		const lines = instructions.split('\n')
		const filteredLines = []

		for (const line of lines) {
			const trimmed = line.trim()

			// Skip empty lines
			if (!trimmed) continue

			// Check if line starts with an OS prefix (case-insensitive)
			const osMatch = trimmed.match(/^(macOS|Ubuntu|Debian|RHEL|CentOS|Windows|Linux|Arch):/i)

			if (osMatch) {
				const osPrefix = osMatch[1].toLowerCase()

				// Map OS prefixes to platform names
				if (currentPlatform === 'macos' && osPrefix === 'macos') {
					// Remove the prefix and add the command
					filteredLines.push(trimmed.replace(/^macOS:\s*/i, ''))
				} else if (
					currentPlatform === 'linux' &&
					['ubuntu', 'debian', 'rhel', 'centos', 'linux', 'arch'].includes(osPrefix)
				) {
					filteredLines.push(trimmed.replace(/^[^:]+:\s*/, ''))
				} else if (currentPlatform === 'windows' && osPrefix === 'windows') {
					filteredLines.push(trimmed.replace(/^Windows:\s*/i, ''))
				}
			} else {
				// Lines without OS prefix are included for all platforms
				filteredLines.push(trimmed)
			}
		}

		// If no instructions remain after filtering, return original
		return filteredLines.length > 0 ? filteredLines.join('\n') : instructions
	}

	// Helper function to extract CLI commands from install instructions
	function extractCommands(instructions) {
		// First filter by OS
		const filteredInstructions = filterInstructionsByOS(instructions)

		const commands = []
		const lines = filteredInstructions.split('\n')
		for (const line of lines) {
			const trimmed = line.trim()

			// Skip empty lines
			if (!trimmed) continue

			// Match lines that contain shell commands
			// Pattern: optional text followed by command
			const commandPattern =
				/(?:.*?:\s*)?((?:brew|apt-get|apt|yum|dnf|pacman|pip|npm|cargo|curl|wget|sudo)\s+.+)/i
			const match = trimmed.match(commandPattern)

			if (match) {
				// Extract just the command part (group 1)
				commands.push(match[1].trim())
			} else if (
				trimmed.match(/^(brew|apt-get|apt|yum|dnf|pacman|pip|npm|cargo|curl|wget|sudo)/i)
			) {
				// Fallback: if line starts with a command, use the whole line
				commands.push(trimmed)
			}
		}
		return commands
	}

	// Function to display dependencies (expose globally for settings page)
	window.displayDependencies = function displayDependencies(
		result,
		listPanelId = 'deps-list',
		detailsPanelId = 'dep-details-panel',
		isSettings = false,
	) {
		const depsList = document.getElementById(listPanelId)
		const nextBtn = isSettings ? null : document.getElementById('onboarding-next-2')
		const installBtn = isSettings
			? document.getElementById('settings-install-missing-deps-btn')
			: document.getElementById('install-missing-deps-btn')

		let html = ''

		result.dependencies.forEach((dep, index) => {
			// Docker Desktop can be installed but not running, so treat found=true as installed
			const isInstalled = dep.found

			let statusIcon = isInstalled ? '✓' : '✗'
			let statusColor = isInstalled ? '#28a745' : '#dc3545'

			// Show warning color if Docker is installed but not running
			if (dep.name === 'Docker' && dep.found && dep.running === false) {
				statusColor = '#ffc107' // Warning yellow
				statusIcon = '⚠️' // Warning icon
			}

			html += `
				<div class="dep-item" data-dep-index="${index}" style="display: flex; align-items: center; gap: 8px; padding: 10px; background: white; border-radius: 6px; margin-bottom: 8px; cursor: pointer; border: 2px solid transparent; transition: all 0.2s;">
					<span style="font-size: 18px; color: ${statusColor};">${statusIcon}</span>
					<strong style="font-size: 13px; color: #333; flex: 1;">${dep.name}</strong>
				</div>
			`
		})

		depsList.innerHTML = html

		// Add click handlers for ALL dependencies
		document.querySelectorAll(`#${listPanelId} .dep-item`).forEach((item) => {
			item.addEventListener('click', () => {
				const depIndex = parseInt(item.dataset.depIndex)
				const dep = result.dependencies[depIndex]

				// Show details in right panel
				window.showDependencyDetails?.(dep, depIndex, detailsPanelId)

				// Highlight selected item
				document.querySelectorAll(`#${listPanelId} .dep-item`).forEach((i) => {
					i.style.borderColor = 'transparent'
					i.style.background = 'white'
				})
				item.style.borderColor = '#0066cc'
				item.style.background = '#f0f8ff'
			})

			// Add hover effect
			item.addEventListener('mouseenter', () => {
				if (item.style.borderColor !== 'rgb(0, 102, 204)') {
					item.style.background = '#f8f9fa'
				}
			})
			item.addEventListener('mouseleave', () => {
				if (item.style.borderColor !== 'rgb(0, 102, 204)') {
					item.style.background = 'white'
				}
			})
		})

		// Enable/disable buttons based on dependencies
		// Check if there are actually missing dependencies (not just not running)
		const actuallyMissing = result.dependencies.some((dep) => !dep.found)

		// For onboarding, we allow proceeding if all deps are FOUND (installed)
		// even if some services like Docker aren't running
		const allDepsFound = result.dependencies.every((dep) => dep.found)

		if (allDepsFound) {
			if (nextBtn) nextBtn.disabled = false
			// Disable Install Missing if nothing is actually missing
			if (installBtn) installBtn.disabled = !actuallyMissing
		} else {
			if (nextBtn) nextBtn.disabled = true
			// Only enable Install Missing if there are dependencies that need installation
			if (installBtn) installBtn.disabled = !actuallyMissing
		}

		// Auto-select first missing dependency, or first one if all installed
		const items = document.querySelectorAll(`#${listPanelId} .dep-item`)
		if (items.length > 0) {
			// Find first missing dependency
			let firstMissing = null
			result.dependencies.forEach((dep, index) => {
				// Docker Desktop can be installed but not running, so treat found=true as installed
				const isInstalled = dep.found
				if (!isInstalled && firstMissing === null) {
					firstMissing = index
				}
			})

			// Select first missing, or first overall if all installed
			const indexToSelect = firstMissing !== null ? firstMissing : 0
			const itemToSelect = items[indexToSelect]

			if (itemToSelect) {
				// Trigger click on the item
				itemToSelect.click()
			}
		}
	}

	// Step 1: Welcome -> Step 2
	const nextBtn1 = document.getElementById('onboarding-next-1')
	if (nextBtn1) {
		nextBtn1.addEventListener('click', () => {
			document.getElementById('onboarding-step-1').style.display = 'none'
			document.getElementById('onboarding-step-2').style.display = 'block'
			// Check dependencies when entering step 2
			checkDependencies()
		})
	}

	// Check Again button
	const checkAgainBtn = document.getElementById('check-again-btn')
	if (checkAgainBtn) {
		checkAgainBtn.addEventListener('click', () => {
			checkDependencies()
		})
	}

	// Install Missing button - installs all missing dependencies
	const installMissingBtn = document.getElementById('install-missing-deps-btn')
	if (installMissingBtn) {
		installMissingBtn.addEventListener('click', async () => {
			if (!dependencyResults) return

			// Find all missing dependencies
			const missingDeps = dependencyResults.dependencies.filter((dep) => {
				const isInstalled = dep.found && (dep.running === null || dep.running === true)
				return !isInstalled
			})

			if (missingDeps.length === 0) return

			const depNames = missingDeps.map((d) => d.name).join(', ')
			const confirmed = await window.__TAURI__.dialog.confirm(
				`Install the following missing dependencies?\n\n${depNames}\n\nBioVault will attempt to install these automatically. This may take several minutes.`,
				{ title: 'Confirm Installation', type: 'warning' },
			)

			if (confirmed) {
				try {
					await invoke('install_dependencies', { names: missingDeps.map((d) => d.name) })
					await checkDependencies()
				} catch (error) {
					await window.__TAURI__.dialog.message(`${error}`, {
						title: 'Installation Not Available',
						type: 'info',
					})
				}
			}
		})
	}

	// Skip dependencies button on onboarding step 1
	const skipDepsBtn = document.getElementById('skip-dependencies-btn')
	if (skipDepsBtn) {
		skipDepsBtn.addEventListener('click', async () => {
			skipDepsBtn.disabled = true
			try {
				const confirmed = await window.__TAURI__.dialog.confirm(
					'Warning: Skipping dependency checks may cause BioVault to not function properly.\n\n' +
						'Some features may not work without the required dependencies installed.\n\n' +
						'Are you sure you want to skip?',
					{ title: 'Skip Dependency Checks?', type: 'warning' },
				)

				if (!confirmed) {
					return
				}

				try {
					await invoke('update_saved_dependency_states')
				} catch (error) {
					console.error('Failed to save skipped state:', error)
				}

				document.getElementById('onboarding-step-2').style.display = 'none'
				document.getElementById('onboarding-step-3').style.display = 'block'
			} finally {
				skipDepsBtn.disabled = false
			}
			// If not confirmed, stay on the current page
		})
	}

	// Step 2: Dependencies -> Step 3
	const nextBtn2 = document.getElementById('onboarding-next-2')
	if (nextBtn2) {
		nextBtn2.addEventListener('click', () => {
			document.getElementById('onboarding-step-2').style.display = 'none'
			document.getElementById('onboarding-step-3').style.display = 'block'
		})
	}

	// Step 3: Back to Step 2
	const backBtn3 = document.getElementById('onboarding-back-3')
	if (backBtn3) {
		backBtn3.addEventListener('click', () => {
			document.getElementById('onboarding-step-3').style.display = 'none'
			document.getElementById('onboarding-step-2').style.display = 'block'
		})
	}

	// Email validation function
	function isValidEmail(email) {
		// More thorough email validation
		if (!email || email.length < 3) return false

		// Split on @ to check parts
		const parts = email.split('@')
		if (parts.length !== 2) return false

		const [localPart, domain] = parts

		// Check local part (before @)
		if (!localPart || localPart.length === 0 || localPart.length > 64) return false
		if (localPart.startsWith('.') || localPart.endsWith('.')) return false
		if (localPart.includes('..')) return false

		// Check domain part (after @)
		if (!domain || domain.length < 3) return false

		// Domain must have at least one dot and a TLD
		const domainParts = domain.split('.')
		if (domainParts.length < 2) return false

		// Check each domain part
		for (const part of domainParts) {
			if (!part || part.length === 0) return false
			if (part.length > 63) return false
			if (part.startsWith('-') || part.endsWith('-')) return false
			// Only allow alphanumeric and hyphens
			if (!/^[a-zA-Z0-9-]+$/.test(part)) return false
		}

		// TLD should be at least 2 characters
		const tld = domainParts[domainParts.length - 1]
		if (tld.length < 2) return false

		// TLD should not be all numbers
		if (/^\d+$/.test(tld)) return false

		return true
	}

	// Email input validation
	const emailInput = document.getElementById('onboarding-email')
	const emailValidationMsg = document.getElementById('email-validation-message')

	if (emailInput) {
		// Disable Next button initially
		const nextBtn3 = document.getElementById('onboarding-next-3')
		if (nextBtn3) {
			nextBtn3.disabled = true
			nextBtn3.style.opacity = '0.5'
			nextBtn3.style.cursor = 'not-allowed'
		}

		// Real-time email validation
		emailInput.addEventListener('input', () => {
			const email = emailInput.value.trim()
			const isValid = isValidEmail(email)

			if (nextBtn3 && emailValidationMsg) {
				if (isValid) {
					nextBtn3.disabled = false
					nextBtn3.style.opacity = '1'
					nextBtn3.style.cursor = 'pointer'
					emailInput.style.borderColor = '#28a745'
					emailValidationMsg.textContent = '✓ Valid email address'
					emailValidationMsg.style.color = '#28a745'
				} else {
					nextBtn3.disabled = true
					nextBtn3.style.opacity = '0.5'
					nextBtn3.style.cursor = 'not-allowed'
					if (email.length > 0) {
						emailInput.style.borderColor = '#dc3545'
						// Provide specific error messages
						if (!email.includes('@')) {
							emailValidationMsg.textContent = '✗ Email must contain @'
						} else if (email.endsWith('@')) {
							emailValidationMsg.textContent = '✗ Please enter domain after @'
						} else if (!email.includes('.', email.indexOf('@'))) {
							emailValidationMsg.textContent = '✗ Domain must contain a dot'
						} else {
							emailValidationMsg.textContent = '✗ Please enter a valid email'
						}
						emailValidationMsg.style.color = '#dc3545'
					} else {
						emailInput.style.borderColor = '#ddd'
						emailValidationMsg.textContent = ''
					}
				}
			}
		})
	}

	// Step 3: Email -> Step 4 (SyftBox OTP)
	const nextBtn3 = document.getElementById('onboarding-next-3')
	if (nextBtn3) {
		nextBtn3.addEventListener('click', async () => {
			const email = document.getElementById('onboarding-email').value.trim()
			if (!isValidEmail(email)) {
				await window.__TAURI__.dialog.message('Please enter a valid email address', {
					title: 'Invalid Email',
					type: 'error',
				})
				return
			}

			// Move to step 4 (SyftBox OTP)
			document.getElementById('onboarding-step-3').style.display = 'none'
			document.getElementById('onboarding-step-4').style.display = 'block'
		})
	}

	// Step 4: SyftBox OTP - Send Login Code button
	const sendLoginCodeBtn = document.getElementById('send-login-code-btn')
	if (sendLoginCodeBtn) {
		sendLoginCodeBtn.addEventListener('click', async () => {
			const email = document.getElementById('onboarding-email').value.trim()

			sendLoginCodeBtn.disabled = true
			sendLoginCodeBtn.innerHTML = '<span class="spinner"></span> Sending...'

			try {
				await invoke('syftbox_request_otp', { email })

				// Switch to OTP input state
				document.getElementById('syftbox-send-state').style.display = 'none'
				document.getElementById('syftbox-otp-state').style.display = 'block'
				document.getElementById('syftbox-user-email').textContent = email

				// Focus first input
				const firstInput = document.querySelector('.syftbox-code-input[data-index="0"]')
				if (firstInput) firstInput.focus()
			} catch (error) {
				await window.__TAURI__.dialog.message(`Failed to send OTP: ${error}`, {
					title: 'Error',
					type: 'error',
				})
				sendLoginCodeBtn.disabled = false
				sendLoginCodeBtn.textContent = 'Send Login Code'
			}
		})
	}

	// Step 4: SyftBox OTP - Digit input handling
	const codeInputs = document.querySelectorAll('.syftbox-code-input')
	codeInputs.forEach((input, index) => {
		input.addEventListener('input', (e) => {
			const value = e.target.value

			// Only allow numbers
			if (value && !/^\d$/.test(value)) {
				e.target.value = ''
				return
			}

			// Clear error state
			codeInputs.forEach((inp) => {
				inp.classList.remove('error')
			})
			document.getElementById('syftbox-error-message').style.display = 'none'

			// Move to next input if value entered
			if (value && index < codeInputs.length - 1) {
				codeInputs[index + 1].focus()
			}

			// Check if all inputs filled
			const allFilled = Array.from(codeInputs).every((inp) => inp.value)
			document.getElementById('verify-code-btn').disabled = !allFilled
		})

		// Handle backspace and Enter
		input.addEventListener('keydown', (e) => {
			if (e.key === 'Backspace' && !e.target.value && index > 0) {
				codeInputs[index - 1].focus()
			} else if (e.key === 'Enter') {
				// Trigger verify button if all fields are filled
				const allFilled = Array.from(codeInputs).every((inp) => inp.value)
				if (allFilled) {
					document.getElementById('verify-code-btn').click()
				}
			}
		})

		// Handle paste
		input.addEventListener('paste', (e) => {
			e.preventDefault()
			const pastedData = e.clipboardData.getData('text').replace(/\D/g, '')

			for (let i = 0; i < Math.min(pastedData.length, codeInputs.length); i++) {
				codeInputs[i].value = pastedData[i]
			}

			// Focus last filled or first empty
			const lastIndex = Math.min(pastedData.length, codeInputs.length - 1)
			codeInputs[lastIndex].focus()

			// Enable verify button if all filled
			const allFilled = Array.from(codeInputs).every((inp) => inp.value)
			document.getElementById('verify-code-btn').disabled = !allFilled
		})
	})

	// Step 4: SyftBox OTP - Verify Code button
	const verifyCodeBtn = document.getElementById('verify-code-btn')
	if (verifyCodeBtn) {
		verifyCodeBtn.addEventListener('click', async () => {
			const code = Array.from(codeInputs)
				.map((inp) => inp.value)
				.join('')
			const email = document.getElementById('onboarding-email').value.trim()
			const step4 = document.getElementById('onboarding-step-4')
			const fromSettings = step4.dataset.fromSettings === 'true'

			verifyCodeBtn.disabled = true
			verifyCodeBtn.innerHTML = '<span class="spinner"></span> Verifying...'

			try {
				await invoke('syftbox_submit_otp', { code, email })

				// Success - mark inputs as success
				codeInputs.forEach((inp) => inp.classList.add('success'))

				// Wait a moment then proceed
				setTimeout(async () => {
					if (fromSettings) {
						// Coming from settings - reset state, show success, and return to settings
						step4.dataset.fromSettings = 'false'
						document.getElementById('skip-syftbox-btn').textContent = 'Skip' // Reset button text

						// Reset the OTP state to initial state
						document.getElementById('syftbox-send-state').style.display = 'block'
						document.getElementById('syftbox-otp-state').style.display = 'none'
						document.getElementById('syftbox-error-message').style.display = 'none'

						// Clear OTP inputs
						document.querySelectorAll('.syftbox-code-input').forEach((input) => {
							input.value = ''
							input.classList.remove('error', 'success')
						})

						// Reset verify button
						const verifyBtn = document.getElementById('verify-code-btn')
						verifyBtn.disabled = true
						verifyBtn.textContent = 'Verify Code'

						// Reset send login code button
						const sendLoginCodeBtn = document.getElementById('send-login-code-btn')
						if (sendLoginCodeBtn) {
							sendLoginCodeBtn.disabled = false
							sendLoginCodeBtn.textContent = 'Send Login Code'
						}

						await window.__TAURI__.dialog.message('Successfully authenticated with SyftBox!', {
							title: 'Success',
							type: 'info',
						})

						// Show tabs navigation bar
						const tabsBar = document.querySelector('.tabs')
						if (tabsBar) {
							tabsBar.style.display = 'flex'
						}

						// Hide onboarding and show settings
						document.getElementById('onboarding-view').classList.remove('active')
						document.getElementById('onboarding-view').style.display = 'none'

						const settingsView = document.getElementById('settings-view')
						settingsView.classList.add('active')
						settingsView.style.display = 'flex'

						// Activate settings tab
						document.querySelectorAll('.tab').forEach((tab) => tab.classList.remove('active'))
						document.querySelector('.tab[data-tab="settings"]').classList.add('active')

						// Refresh status
						checkSyftBoxStatus()
					} else {
						// Normal onboarding flow - proceed to step 5 (initializing)
						document.getElementById('onboarding-step-4').style.display = 'none'
						document.getElementById('onboarding-step-5').style.display = 'block'
						// Initialize BioVault
						initializeBioVault(email)
					}
				}, 500)
			} catch (error) {
				// Error - show error state
				codeInputs.forEach((inp) => inp.classList.add('error'))
				document.getElementById('syftbox-error-message').style.display = 'block'
				document.getElementById('syftbox-error-message').textContent = error
					.toString()
					.includes('Invalid')
					? 'Invalid verification code. Please try again.'
					: `Error: ${error}`

				verifyCodeBtn.disabled = false
				verifyCodeBtn.textContent = 'Verify Code'
			}
		})
	}

	// Step 4: SyftBox OTP - Resend Code button
	const resendCodeBtn = document.getElementById('resend-code-btn')
	if (resendCodeBtn) {
		resendCodeBtn.addEventListener('click', async () => {
			const email = document.getElementById('onboarding-email').value.trim()

			resendCodeBtn.disabled = true
			resendCodeBtn.textContent = 'Sending...'

			try {
				await invoke('syftbox_request_otp', { email })

				// Clear inputs
				codeInputs.forEach((inp) => {
					inp.value = ''
					inp.classList.remove('error', 'success')
				})
				document.getElementById('syftbox-error-message').style.display = 'none'
				document.getElementById('verify-code-btn').disabled = true

				// Focus first input
				codeInputs[0].focus()

				await window.__TAURI__.dialog.message('A new code has been sent to your email.', {
					title: 'Code Sent',
				})
			} catch (error) {
				await window.__TAURI__.dialog.message(`Failed to send OTP: ${error}`, {
					title: 'Error',
					type: 'error',
				})
			} finally {
				resendCodeBtn.disabled = false
				resendCodeBtn.textContent = 'Send Again'
			}
		})
	}

	// Step 4: SyftBox OTP - Skip/Cancel button
	const skipSyftboxBtn = document.getElementById('skip-syftbox-btn')
	if (skipSyftboxBtn) {
		skipSyftboxBtn.addEventListener('click', () => {
			const step4 = document.getElementById('onboarding-step-4')
			const fromSettings = step4.dataset.fromSettings === 'true'

			if (fromSettings) {
				// Coming from settings - reset state and return to settings page
				step4.dataset.fromSettings = 'false'
				skipSyftboxBtn.textContent = 'Skip' // Reset button text

				// Reset the OTP state to initial state
				document.getElementById('syftbox-send-state').style.display = 'block'
				document.getElementById('syftbox-otp-state').style.display = 'none'
				document.getElementById('syftbox-error-message').style.display = 'none'

				// Clear OTP inputs
				document.querySelectorAll('.syftbox-code-input').forEach((input) => {
					input.value = ''
					input.classList.remove('error', 'success')
				})

				// Reset verify button
				const verifyBtn = document.getElementById('verify-code-btn')
				verifyBtn.disabled = true
				verifyBtn.textContent = 'Verify Code'

				// Reset send login code button
				const sendLoginCodeBtn = document.getElementById('send-login-code-btn')
				if (sendLoginCodeBtn) {
					sendLoginCodeBtn.disabled = false
					sendLoginCodeBtn.textContent = 'Send Login Code'
				}

				// Show tabs navigation bar
				const tabsBar = document.querySelector('.tabs')
				if (tabsBar) {
					tabsBar.style.display = 'flex'
				}

				// Hide onboarding and show settings
				document.getElementById('onboarding-view').classList.remove('active')
				document.getElementById('onboarding-view').style.display = 'none'

				const settingsView = document.getElementById('settings-view')
				settingsView.classList.add('active')
				settingsView.style.display = 'flex'

				// Activate settings tab
				document.querySelectorAll('.tab').forEach((tab) => tab.classList.remove('active'))
				document.querySelector('.tab[data-tab="settings"]').classList.add('active')

				// Refresh status
				checkSyftBoxStatus()
			} else {
				// Normal onboarding flow - skip to step 5
				const email = document.getElementById('onboarding-email').value.trim()

				document.getElementById('onboarding-step-4').style.display = 'none'
				document.getElementById('onboarding-step-5').style.display = 'block'
				// Initialize BioVault
				initializeBioVault(email)
			}
		})
	}

	// Helper function to initialize BioVault
	async function initializeBioVault(email) {
		try {
			await invoke('complete_onboarding', { email })
			// Reload to show main app with updated config
			location.reload()
		} catch (error) {
			await window.__TAURI__.dialog.message(`Error initializing BioVault: ${error}`, {
				title: 'Error',
				type: 'error',
			})
		}
	}

	// Reset all data button
	const resetAllBtn = document.getElementById('reset-all-btn')
	if (resetAllBtn) {
		resetAllBtn.addEventListener('click', async () => {
			const confirmed = await window.__TAURI__.dialog.confirm(
				'This will DELETE ALL DATA including participants, files, projects, and runs. This cannot be undone!\n\nAre you sure?',
				{ title: 'Reset All Data', type: 'warning' },
			)

			if (!confirmed) {
				return
			}

			try {
				await invoke('reset_all_data')
				await window.__TAURI__.dialog.message('All data has been reset. The app will now reload.', {
					title: 'Reset Complete',
				})

				// Reload the window to restart fresh
				window.location.reload()
			} catch (error) {
				await window.__TAURI__.dialog.message(`Error resetting data: ${error}`, {
					title: 'Error',
					type: 'error',
				})
			}
		})
	}

	// Check if onboarded on app start
	async function checkOnboarding() {
		try {
			const isOnboarded = await invoke('check_is_onboarded')
			if (!isOnboarded) {
				// Show onboarding view
				document.getElementById('onboarding-view').style.display = 'flex'
				// Hide tabs
				document.querySelector('.tabs').style.display = 'none'
				// Hide all other tab-content views
				document.querySelectorAll('.tab-content:not(#onboarding-view)').forEach((view) => {
					view.classList.remove('active')
					view.style.display = 'none'
				})
				// Update title
				document.title = 'BioVault - Setup'
			}
		} catch (error) {
			console.error('Error checking onboarding status:', error)
		}
	}

	// Run onboarding check on app start
	checkOnboarding()
})
