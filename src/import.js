// Import Data Module - File selection, pattern matching, and import workflow
export function createImportModule({
	invoke,
	open,
	dialog,
	isFileAlreadyImported,
	refreshExistingFilePaths,
	loadParticipantsView,
	loadFiles,
	setLastImportView,
}) {
	// Internal state
	let selectedFolder = null
	let currentFiles = []
	let currentPattern = ''
	let fileParticipantIds = {}
	let selectedFiles = new Set()
	let sortField = 'path'
	let sortDirection = 'asc'
	let isImportInProgress = false
	let reviewFileMetadata = {}
	let selectedReviewFiles = new Set()
	let usingRandomIds = false // Track if random IDs are currently active
	let reviewSortField = 'path'
	let showOnlyMissingIds = false // Filter to show only files missing IDs
	let filesMissingIds = [] // Track which files are missing IDs
	let reviewSortDirection = 'asc'
	let showOnlyIncompleteReview = false // Filter to show only files with incomplete configurations
	let filesIncompleteReview = [] // Track which files have incomplete configurations
	let autoParticipantIds = {} // Auto-extracted IDs for the current pattern
	let patternInputDebounce = null

	const GENOTYPE_SOURCE_OPTIONS = [
		'23andMe',
		'AncestryDNA',
		'Genes for Good',
		'Dynamic DNA',
		'Living DNA',
		'MyHeritage',
		'FamilyTreeDNA',
		'deCODEme',
		'Dante Labs',
		'Unknown',
	]

	function populateSourceSelect(select, selectedValue = null, includePlaceholder = false) {
		if (!select) return
		const value = selectedValue || ''
		select.innerHTML = ''
		if (includePlaceholder) {
			const placeholder = document.createElement('option')
			placeholder.value = ''
			placeholder.textContent = '-'
			if (!value) {
				placeholder.selected = true
			}
			select.appendChild(placeholder)
		}
		let matched = false
		GENOTYPE_SOURCE_OPTIONS.forEach((source) => {
			const option = document.createElement('option')
			option.value = source
			option.textContent = source
			if (source === value) {
				option.selected = true
				matched = true
			}
			select.appendChild(option)
		})
		if (value && !matched) {
			const fallback = document.createElement('option')
			fallback.value = value
			fallback.textContent = value
			fallback.selected = true
			select.appendChild(fallback)
		}
	}

	function setSelectValue(select, value) {
		if (!select) return
		const normalized = value || ''
		const hasOption = Array.from(select.options).some((opt) => opt.value === normalized)
		if (!hasOption && normalized) {
			const option = document.createElement('option')
			option.value = normalized
			option.textContent = normalized
			select.appendChild(option)
		}
		select.value = normalized
	}

	// Modal management
	function openImportModal() {
		const modal = document.getElementById('import-modal')
		if (modal) {
			modal.removeAttribute('hidden')
		} else {
			console.error('❌ Import modal element not found in DOM')
		}
	}
	function closeImportModal() {
		const modal = document.getElementById('import-modal')
		if (modal) {
			modal.setAttribute('hidden', '')
			// Fully reset state when modal closes for a fresh start next time
			setTimeout(() => {
				resetImportState()
			}, 300) // Wait for animation to complete
		}
	}
	// Progressive disclosure - show/hide sections based on state
	function updateVisibleSections() {
		const fileTypesSection = document.getElementById('file-types-section')
		const filesPanel = document.getElementById('files-panel')
		const importFooter = document.getElementById('import-footer')
		// Show file types if folder is selected
		if (fileTypesSection) {
			fileTypesSection.style.display = selectedFolder ? 'block' : 'none'
		}
		// Show pattern section when files are loaded (always visible)
		const patternSection = document.getElementById('pattern-detection-section')
		if (patternSection) {
			patternSection.style.display = currentFiles.length > 0 ? 'block' : 'none'
		}

		// Show file list if files are found
		if (filesPanel) {
			filesPanel.style.display = currentFiles.length > 0 ? 'block' : 'none'
		}
		// Footer is always visible now, just update its content
		if (importFooter) {
			importFooter.style.display = 'flex'
		}
	}
	function getFileExtensions() {
		const checkboxes = document.querySelectorAll(
			'.file-type-checkbox input[type="checkbox"]:checked',
		)
		return Array.from(checkboxes).map((cb) => cb.value)
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
			// Exclude underscore from character class so it stops before delimiter
			characterClass = '([a-zA-Z0-9\\-]+)'
		} else if (afterId === '-') {
			// Exclude hyphen from character class so it stops before delimiter
			characterClass = '([a-zA-Z0-9_]+)'
		} else if (afterId === '.') {
			// Exclude period from character class so it stops before delimiter
			characterClass = '([a-zA-Z0-9_\\-]+)'
		} else {
			// Default: capture typical ID characters greedily
			characterClass = '([a-zA-Z0-9_\\-]+)'
		}
		let regex = pattern
			.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
			.replace(/\\\{id\\\}/g, characterClass)
			.replace(/\\\*/g, '.*')
		return new RegExp(regex)
	}
	function normalizeNamedGroupPattern(pattern) {
		return pattern.replace(/\(\?P<([a-zA-Z0-9_]+)>/g, '(?<$1>')
	}
	function buildRegexFromString(pattern) {
		if (!pattern) return null
		try {
			return new RegExp(normalizeNamedGroupPattern(pattern))
		} catch (error) {
			console.warn('Invalid regex pattern provided:', pattern, error)
			return null
		}
	}
	function extractIdFromPath(path, pattern) {
		if (!pattern) return null
		const normalized = pattern.trim()
		// Handle special token patterns
		if (
			normalized === '{parent}' ||
			normalized === '{dirname}' ||
			normalized === '{dir}' ||
			normalized === '{id}/*'
		) {
			const parts = path.split('/')
			const parentDir = parts[parts.length - 2]
			if (parentDir) {
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
		if (normalized === '{filename}') {
			const filename = path.split('/').pop()
			if (!filename) return null
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
		if (normalized === '{basename}') {
			const filename = path.split('/').pop()
			if (!filename) return null
			const dir = path.substring(0, path.lastIndexOf('/') + 1)
			return {
				id: filename,
				start: dir.length,
				length: filename.length,
			}
		}
		if (normalized.startsWith('{parent:') && normalized.endsWith('}')) {
			const parts = path.split('/')
			if (parts.length < 2) return null
			const parentDir = parts[parts.length - 2]
			const innerPattern = normalized.slice('{parent:'.length, -1)
			const pathBeforeParent = parts.slice(0, -2).join('/') + '/'
			if (!parentDir) return null
			if (innerPattern === '{id}') {
				return {
					id: parentDir,
					start: pathBeforeParent.length,
					length: parentDir.length,
					isDirectory: true,
				}
			}
			const parentRegex = patternToRegex(innerPattern)
			if (!parentRegex) return null
			const parentMatch = parentDir.match(parentRegex)
			if (parentMatch && parentMatch[1]) {
				const idStartInParent = parentMatch.index + parentMatch[0].indexOf(parentMatch[1])
				return {
					id: parentMatch[1],
					start: pathBeforeParent.length + idStartInParent,
					length: parentMatch[1].length,
					isDirectory: true,
				}
			}
			return null
		}
		if (normalized.startsWith('{stem:') && normalized.endsWith('}')) {
			const filename = path.split('/').pop()
			if (!filename) return null
			const stem = filename.includes('.')
				? filename.substring(0, filename.lastIndexOf('.'))
				: filename
			const dir = path.substring(0, path.lastIndexOf('/') + 1)
			const innerPattern = normalized.slice('{stem:'.length, -1)
			if (innerPattern === '{id}') {
				return {
					id: stem,
					start: dir.length,
					length: stem.length,
				}
			}
			const stemRegex = patternToRegex(innerPattern)
			if (!stemRegex) return null
			const stemMatch = stem.match(stemRegex)
			if (stemMatch && stemMatch[1]) {
				const idStartInStem = stemMatch.index + stemMatch[0].indexOf(stemMatch[1])
				return {
					id: stemMatch[1],
					start: dir.length + idStartInStem,
					length: stemMatch[1].length,
				}
			}
			return null
		}
		if (normalized.includes('{id}')) {
			const filename = path.split('/').pop()
			const regex = patternToRegex(normalized)
			if (!regex || !filename) return null
			const match = regex.exec(filename)
			if (match && match[1]) {
				const dir = path.substring(0, path.lastIndexOf('/') + 1)
				const idStart = match.index + match[0].indexOf(match[1])
				return { id: match[1], start: dir.length + idStart, length: match[1].length }
			}
			return null
		}
		const regex = buildRegexFromString(normalized)
		if (!regex) return null
		const match = regex.exec(path)
		if (!match) return null
		const groups = match.groups || {}
		const extractedId = groups.id || match[1]
		if (!extractedId) return null
		const matchIndex = typeof match.index === 'number' ? match.index : path.indexOf(match[0])
		const idStartWithinMatch = match[0].indexOf(extractedId)
		const start = matchIndex + (idStartWithinMatch >= 0 ? idStartWithinMatch : 0)
		return { id: extractedId, start, length: extractedId.length }
	}
	function highlightPath(path, pattern, fallbackId = '') {
		const normalizedPattern = pattern ? pattern.trim() : ''
		const extraction = normalizedPattern ? extractIdFromPath(path, normalizedPattern) : null
		if (extraction && extraction.id) {
			const before = path.substring(0, extraction.start)
			const highlighted = path.substring(extraction.start, extraction.start + extraction.length)
			const after = path.substring(extraction.start + extraction.length)
			return `<span style="color: #666;">${before}</span><span class="highlight">${highlighted}</span><span style="color: #666;">${after}</span>`
		}
		const candidateId = fallbackId ? fallbackId.toString() : ''
		if (candidateId) {
			let index = path.indexOf(candidateId)
			if (index === -1) {
				index = path.toLowerCase().indexOf(candidateId.toLowerCase())
			}
			if (index !== -1) {
				const before = path.substring(0, index)
				const highlighted = path.substring(index, index + candidateId.length)
				const after = path.substring(index + candidateId.length)
				return `<span style="color: #666;">${before}</span><span class="highlight">${highlighted}</span><span style="color: #666;">${after}</span>`
			}
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
		const headers = document.querySelectorAll(
			'.file-table th[data-sort], .review-table th[data-sort]',
		)
		headers.forEach((header) => {
			const indicator = header.querySelector('.sort-indicator')
			if (!indicator) return

			// Ensure icon exists
			let icon = indicator.querySelector('img')
			if (!icon) {
				icon = document.createElement('img')
				icon.src = 'assets/icons/chevron-down.svg'
				icon.alt = ''
				indicator.appendChild(icon)
			}

			if (header.dataset.sort === sortField || header.dataset.sort === reviewSortField) {
				const isActive = header.dataset.sort === sortField
				const direction = isActive ? sortDirection : reviewSortDirection
				indicator.classList.add('active')
				indicator.classList.remove('asc', 'desc')
				indicator.classList.add(direction)
			} else {
				indicator.classList.remove('active', 'asc', 'desc')
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
		updateSortIndicators()
	}
	function initColumnResizers() {
		// Table columns resize automatically with CSS, no manual resizing needed
	}
	let importSplitterInitialized = false
	function _initImportSplitter() {
		if (importSplitterInitialized) return
		const layout = document.querySelector('.import-layout')
		const resizer = document.querySelector('.import-resizer')
		const topSection = document.querySelector('.import-top')
		const bottomSection = document.querySelector('.import-files-section')
		if (!layout || !resizer || !topSection || !bottomSection) return
		importSplitterInitialized = true
		const MIN_TOP = 160
		const MIN_BOTTOM = 200
		let isDragging = false
		let startY = 0
		let startTopHeight = 0
		let availableHeight = 0
		const getClientY = (event) => {
			if (event.touches && event.touches.length > 0) {
				return event.touches[0].clientY
			}
			return typeof event.clientY === 'number' ? event.clientY : null
		}
		const stopDrag = () => {
			if (!isDragging) return
			isDragging = false
			resizer.classList.remove('is-dragging')
			document.body.style.userSelect = ''
			document.body.style.cursor = ''
			document.removeEventListener('mousemove', onMove)
			document.removeEventListener('mouseup', stopDrag)
			document.removeEventListener('touchmove', onMove)
			document.removeEventListener('touchend', stopDrag)
			document.removeEventListener('touchcancel', stopDrag)
			topSection.style.removeProperty('will-change')
			bottomSection.style.removeProperty('will-change')
		}
		const onMove = (event) => {
			if (!isDragging) return
			const clientY = getClientY(event)
			if (clientY === null) return
			event.preventDefault()
			const delta = clientY - startY
			let newHeight = startTopHeight + delta
			newHeight = Math.max(MIN_TOP, Math.min(newHeight, availableHeight - MIN_BOTTOM))
			const percent = (newHeight / availableHeight) * 100
			layout.style.setProperty('--import-top-size', `${percent}%`)
		}
		const startDrag = (event) => {
			const clientY = getClientY(event)
			if (clientY === null) return
			event.preventDefault()
			isDragging = true
			startY = clientY
			const layoutRect = layout.getBoundingClientRect()
			const handleRect = resizer.getBoundingClientRect()
			const topRect = topSection.getBoundingClientRect()
			const resizerStyles = window.getComputedStyle(resizer)
			const marginTop = parseFloat(resizerStyles.marginTop) || 0
			const marginBottom = parseFloat(resizerStyles.marginBottom) || 0
			const layoutStyles = window.getComputedStyle(layout)
			const paddingTop = parseFloat(layoutStyles.paddingTop) || 0
			const paddingBottom = parseFloat(layoutStyles.paddingBottom) || 0
			availableHeight = Math.max(
				layoutRect.height -
					handleRect.height -
					marginTop -
					marginBottom -
					paddingTop -
					paddingBottom,
				MIN_TOP + MIN_BOTTOM,
			)
			startTopHeight = Math.min(Math.max(topRect.height, MIN_TOP), availableHeight - MIN_BOTTOM)
			resizer.classList.add('is-dragging')
			document.body.style.userSelect = 'none'
			document.body.style.cursor = 'row-resize'
			topSection.style.setProperty('will-change', 'height')
			bottomSection.style.setProperty('will-change', 'height')
			document.addEventListener('mousemove', onMove)
			document.addEventListener('mouseup', stopDrag)
			document.addEventListener('touchmove', onMove, { passive: false })
			document.addEventListener('touchend', stopDrag)
			document.addEventListener('touchcancel', stopDrag)
		}
		resizer.addEventListener('mousedown', startDrag)
		resizer.addEventListener('touchstart', startDrag, { passive: false })
		const existingSize = layout.style.getPropertyValue('--import-top-size').trim()
		layout.style.setProperty('--import-top-size', existingSize || '50%')
	}
	function renderFiles() {
		const tbody = document.getElementById('file-list')
		tbody.innerHTML = ''
		for (const file of Array.from(selectedFiles)) {
			if (!currentFiles.includes(file)) {
				selectedFiles.delete(file)
			}
		}
		if (currentFiles.length === 0) {
			const tr = document.createElement('tr')
			const td = document.createElement('td')
			td.colSpan = 4
			td.style.textAlign = 'center'
			td.style.padding = '40px 20px'
			td.innerHTML = `
				<div style="display: flex; flex-direction: column; align-items: center; gap: 12px;">
					<svg width="48" height="48" viewBox="0 0 16 16" fill="currentColor" style="opacity: 0.3;">
						<path d="M1.75 2.5A1.75 1.75 0 0 0 0 4.25v7.5C0 12.99 1.01 14 2.25 14h11.5c1.24 0 2.25-1.01 2.25-2.25v-6.5A1.75 1.75 0 0 0 14.25 3.5H7.5L6.29 2.29A1.75 1.75 0 0 0 5.06 1.75H1.75Z"/>
					</svg>
					<div style="color: #64748b; font-size: 15px; font-weight: 600;">No files found</div>
					<div style="color: #94a3b8; font-size: 13px; max-width: 400px;">
						${!selectedFolder ? 'Select a folder to see files' : 'Select file types above to filter files'}
					</div>
				</div>
			`
			tr.appendChild(td)
			tbody.appendChild(tr)
			return
		}
		// Separate already-imported files
		const newFiles = currentFiles.filter((file) => !isFileAlreadyImported(file))
		const alreadyImportedFiles = currentFiles.filter((file) => isFileAlreadyImported(file))

		// Filter files if showing only missing IDs (only apply to new files)
		let filesToRender = newFiles
		if (showOnlyMissingIds) {
			filesToRender = newFiles.filter((file) => {
				const manual = fileParticipantIds[file]
				const auto = autoParticipantIds[file]
				const value = manual || auto
				return !value || `${value}`.trim() === ''
			})
		}
		// Sort files
		const sortedFiles = sortFiles(filesToRender)
		const sortedAlreadyImported = sortFiles(alreadyImportedFiles)
		const activePattern = currentPattern ? currentPattern.trim() : ''

		sortedFiles.forEach((file) => {
			const row = createFileRow(file, activePattern)
			if (row) {
				tbody.appendChild(row)
			}
		})
		// Update sort indicators
		updateSortIndicators()
		document.getElementById('file-count').textContent = newFiles.length
		updateSelectAllCheckbox()
		updateSelectedFileCount()
		updateImportButton()

		// Add collapsible section for already-imported files if any exist
		if (sortedAlreadyImported.length > 0) {
			const alreadyImportedRow = document.createElement('tr')
			alreadyImportedRow.className = 'already-imported-header'
			alreadyImportedRow.dataset.collapsed = 'true'
			const headerCell = document.createElement('td')
			headerCell.colSpan = 4
			headerCell.className = 'already-imported-header-cell'
			headerCell.innerHTML = `
				<div style="display: flex; align-items: center; justify-content: space-between; gap: 12px;">
					<div style="display: flex; align-items: center; gap: 8px;">
						<svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" class="collapse-icon" style="transition: transform 0.2s ease; transform: rotate(-90deg);">
							<path d="M6 3.25L10.25 8 6 12.75v-1.5L8.5 8 6 4.75v-1.5z"/>
						</svg>
						<span style="font-weight: 600; color: #64748b; font-size: 13px;">
							<strong style="color: #475569;">${sortedAlreadyImported.length}</strong> already imported file${
								sortedAlreadyImported.length !== 1 ? 's' : ''
							}
						</span>
					</div>
					<span style="font-size: 11px; color: #94a3b8;">Click to show</span>
				</div>
			`
			headerCell.addEventListener('click', () => {
				const isCollapsed = alreadyImportedRow.dataset.collapsed === 'true'
				alreadyImportedRow.dataset.collapsed = isCollapsed ? 'false' : 'true'
				const icon = headerCell.querySelector('.collapse-icon')
				if (icon) {
					icon.style.transform = isCollapsed ? 'rotate(0deg)' : 'rotate(-90deg)'
				}
				const toggleText = headerCell.querySelector('span:last-child')
				if (toggleText) {
					toggleText.textContent = `Click to ${isCollapsed ? 'hide' : 'show'}`
				}
				sortedAlreadyImported.forEach((file) => {
					const row = document.querySelector(`tr[data-file-path="${CSS.escape(file)}"]`)
					if (row) {
						row.style.display = isCollapsed ? 'table-row' : 'none'
					}
				})
			})
			alreadyImportedRow.appendChild(headerCell)
			tbody.appendChild(alreadyImportedRow)

			// Render already-imported files (collapsed by default)
			sortedAlreadyImported.forEach((file) => {
				const row = createFileRow(file, activePattern)
				if (row) {
					row.style.display = 'none' // Collapsed by default
					tbody.appendChild(row)
				}
			})
		}

		markActivePattern(currentPattern ? currentPattern.trim() : '')
		updateActiveStates()
	}
	function createFileRow(file, activePattern) {
		const row = document.createElement('tr')
		const alreadyImported = isFileAlreadyImported(file)
		const manualId = fileParticipantIds[file] || ''
		const autoId = autoParticipantIds[file] || ''
		const effectiveId = manualId || autoId || ''
		const missingId = !effectiveId || effectiveId.trim() === ''
		if (alreadyImported) {
			row.classList.add('already-imported')
		}
		if (missingId && !alreadyImported) {
			row.classList.add('missing-id')
			row.dataset.filePath = file // Store file path for scrolling
		}

		// Make row clickable (except when clicking on inputs/buttons)
		row.style.cursor = 'pointer'
		row.addEventListener('click', (e) => {
			// Don't toggle if clicking on input, button, or checkbox itself
			if (
				e.target.tagName === 'INPUT' ||
				e.target.tagName === 'BUTTON' ||
				e.target.closest('button')
			) {
				return
			}
			const checkbox = row.querySelector('input[type="checkbox"]')
			if (checkbox && !checkbox.disabled) {
				checkbox.checked = !checkbox.checked
				if (checkbox.checked) {
					selectedFiles.add(file)
					row.classList.add('selected')
				} else {
					selectedFiles.delete(file)
					row.classList.remove('selected')
				}
				updateSelectAllCheckbox()
				updateImportButton()
				updateSelectedFileCount()
				updateVisibleSections()
			}
		})

		// Checkbox cell
		const checkboxCell = document.createElement('td')
		checkboxCell.style.textAlign = 'center'
		checkboxCell.style.padding = '4px'
		const checkbox = document.createElement('input')
		checkbox.type = 'checkbox'
		checkbox.checked = selectedFiles.has(file)
		checkbox.dataset.filePath = file // Store file path for easier lookup
		// Add selected class to row if checked
		if (checkbox.checked) {
			row.classList.add('selected')
		}
		checkbox.addEventListener('change', (e) => {
			e.stopPropagation() // Prevent row click from firing
			if (e.target.checked) {
				selectedFiles.add(file)
				row.classList.add('selected')
			} else {
				selectedFiles.delete(file)
				row.classList.remove('selected')
			}
			updateSelectAllCheckbox()
			updateImportButton()
			updateSelectedFileCount()
			updateVisibleSections()
		})
		checkboxCell.appendChild(checkbox)
		row.appendChild(checkboxCell)
		// File path cell - intelligently truncated
		const pathCell = document.createElement('td')
		const pathParts = file.split('/')
		const filename = pathParts[pathParts.length - 1]
		const parentFolder = pathParts[pathParts.length - 2] || ''

		const pathWrapper = document.createElement('div')
		pathWrapper.style.display = 'flex'
		pathWrapper.style.alignItems = 'center'
		pathWrapper.style.gap = '6px'

		// Show parent folder in subdued color
		if (parentFolder) {
			const folderSpan = document.createElement('span')
			folderSpan.textContent = `.../${parentFolder}/`
			folderSpan.style.color = '#94a3b8'
			folderSpan.style.fontSize = '12px'
			pathWrapper.appendChild(folderSpan)
		}

		// Show filename with highlighting if ID is extracted
		const filenameSpan = document.createElement('span')
		filenameSpan.innerHTML = highlightPath(filename, activePattern, effectiveId)
		filenameSpan.style.color = '#1e293b'
		filenameSpan.style.fontWeight = '500'
		pathWrapper.appendChild(filenameSpan)

		if (alreadyImported) {
			const badge = document.createElement('span')
			badge.className = 'imported-badge'
			badge.textContent = 'Imported'
			pathWrapper.appendChild(badge)
		}

		pathCell.appendChild(pathWrapper)
		pathCell.title = file // Full path on hover
		row.appendChild(pathCell)
		// Participant ID cell
		const participantCell = document.createElement('td')
		participantCell.style.padding = '4px'
		const input = document.createElement('input')
		input.type = 'text'
		input.className = 'participant-id-input'
		input.placeholder = 'Enter ID'
		input.style.width = '100%'
		// Extract ID if pattern exists
		if (manualId) {
			input.value = manualId
			input.classList.add('manual')
			input.classList.remove('extracted')
		} else if (autoId) {
			input.value = autoId
			input.classList.add('extracted')
			input.classList.remove('manual')
		} else {
			input.value = ''
			input.classList.remove('manual')
			input.classList.remove('extracted')
		}
		// Update map when user edits
		input.addEventListener('input', (e) => {
			const value = e.target.value.trim()
			if (value) {
				// Check for duplicate IDs
				const isDuplicate = Array.from(currentFiles).some((otherFile) => {
					if (otherFile === file) return false
					const otherManual = fileParticipantIds[otherFile]
					const otherAuto = autoParticipantIds[otherFile]
					const otherValue = otherManual || otherAuto
					return otherValue && otherValue.trim() === value
				})

				if (isDuplicate) {
					// Show warning but still allow the ID
					input.style.borderColor = '#f59e0b'
					input.style.boxShadow = '0 0 0 3px rgba(245, 158, 11, 0.1)'
					input.title = 'Warning: This ID is already used by another file'
					// Clear warning after 3 seconds
					setTimeout(() => {
						if (input.value.trim() === value) {
							input.style.borderColor = ''
							input.style.boxShadow = ''
							input.title = ''
						}
					}, 3000)
				} else {
					input.style.borderColor = ''
					input.style.boxShadow = ''
					input.title = ''
				}

				fileParticipantIds[file] = value
				delete autoParticipantIds[file]
				input.classList.remove('extracted')
				input.classList.add('manual')
				// Remove missing-id class if ID was added
				row.classList.remove('missing-id')
				delete row.dataset.filePath
			} else {
				delete fileParticipantIds[file]
				input.classList.remove('manual')
				input.classList.remove('extracted')
				input.style.borderColor = ''
				input.style.boxShadow = ''
				input.title = ''
				// Add missing-id class if ID was removed
				if (!alreadyImported) {
					row.classList.add('missing-id')
				}
				if (currentPattern) {
					void applyPattern(currentPattern)
				}
			}
			updateImportButton()
			updateVisibleSections()
		})
		participantCell.appendChild(input)
		row.appendChild(participantCell)
		// Folder button cell
		const actionsCell = document.createElement('td')
		actionsCell.style.textAlign = 'center'
		actionsCell.style.padding = '4px'
		const folderBtn = document.createElement('button')
		folderBtn.className = 'show-in-folder-btn'
		folderBtn.innerHTML = '<img src="assets/icons/folder-open.svg" width="16" height="16" alt="" />'
		folderBtn.title = 'Show in Finder'
		folderBtn.addEventListener('click', async () => {
			try {
				await invoke('show_in_folder', { filePath: file })
			} catch (error) {
				console.error('Failed to show file in folder:', error)
			}
		})
		actionsCell.appendChild(folderBtn)
		row.appendChild(actionsCell)
		row.dataset.filePath = file
		return row
	}
	function markActivePattern(pattern) {
		const normalized = pattern ? pattern.trim() : ''
		document.querySelectorAll('.pattern-suggestion').forEach((row) => {
			const macroValue = row.dataset.macro?.trim() || ''
			const regexValue = row.dataset.regex?.trim() || ''
			const isActive = Boolean(
				normalized && (normalized === macroValue || normalized === regexValue),
			)
			row.classList.toggle('active', isActive)
		})
	}
	function updateActiveStates() {
		// Update Random IDs button active state
		const randomIdsBtn = document.getElementById('random-ids-btn')
		if (randomIdsBtn) {
			randomIdsBtn.classList.toggle('active', usingRandomIds)
		}
		// Update custom pattern input active state
		const customPatternInput = document.getElementById('custom-pattern')
		if (customPatternInput) {
			const hasCustomPattern = currentPattern && currentPattern.trim() !== '' && !usingRandomIds
			customPatternInput.classList.toggle('active', hasCustomPattern)
			// Clear random IDs flag if pattern is being used
			if (hasCustomPattern) {
				usingRandomIds = false
				if (randomIdsBtn) {
					randomIdsBtn.classList.remove('active')
				}
			}
		}
	}
	function resetRandomIdsState() {
		usingRandomIds = false
		updateActiveStates()
	}
	async function applyPattern(pattern) {
		const normalized = pattern ? pattern.trim() : ''
		const patternInput = document.getElementById('custom-pattern')
		if (patternInput && patternInput.value.trim() !== normalized) {
			patternInput.value = normalized
		}
		currentPattern = normalized
		usingRandomIds = false // Clear random IDs flag when applying pattern
		markActivePattern(normalized)
		updateActiveStates()
		if (!normalized || currentFiles.length === 0) {
			autoParticipantIds = {}
			renderFiles()
			updateImportButton()
			return
		}
		try {
			const results = await invoke('extract_ids_for_files', {
				files: currentFiles,
				pattern: normalized,
			})
			autoParticipantIds = {}
			// Clear manual IDs for files that will get pattern-extracted IDs
			// This allows patterns to overwrite random IDs or previously manual IDs
			const idUsage = new Map() // Map of ID -> array of files using it

			// First pass: collect all extracted IDs
			Object.entries(results || {}).forEach(([filePath, value]) => {
				if (value !== null && value !== undefined && `${value}`.trim() !== '') {
					const trimmedId = `${value}`.trim()
					if (!idUsage.has(trimmedId)) {
						idUsage.set(trimmedId, [])
					}
					idUsage.get(trimmedId).push(filePath)
				}
			})

			// Second pass: assign unique IDs
			Object.entries(results || {}).forEach(([filePath, value]) => {
				if (value !== null && value !== undefined && `${value}`.trim() !== '') {
					const trimmedId = `${value}`.trim()
					const filesWithThisId = idUsage.get(trimmedId) || []

					if (filesWithThisId.length > 1) {
						// Multiple files have same ID - make them unique
						const index = filesWithThisId.indexOf(filePath)
						autoParticipantIds[filePath] = `${trimmedId}_${index + 1}`
					} else {
						// Unique ID
						autoParticipantIds[filePath] = trimmedId
					}
					// Remove manual ID so pattern ID can take precedence
					delete fileParticipantIds[filePath]
				}
			})
		} catch (error) {
			console.error('Failed to extract IDs for pattern:', error)
			autoParticipantIds = {}
		}
		renderFiles()
		updateImportButton()
		updateVisibleSections()
	}
	async function copyToClipboard(text) {
		try {
			await navigator.clipboard.writeText(text)
		} catch (error) {
			console.error('Clipboard error:', error)
			throw error
		}
	}
	// Generate random alphanumeric ID (similar to makeSlug but without prefix)
	function generateRandomId(length = 12) {
		const validChars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
		const array = new Uint8Array(length)
		crypto.getRandomValues(array)
		let result = ''
		for (let i = 0; i < length; i++) {
			result += validChars[array[i] % validChars.length]
		}
		return result
	}
	function assignRandomIds() {
		if (currentFiles.length === 0) return
		// Get files to assign IDs to (all selected files, or all files if none selected)
		// Allow overwriting existing IDs when user explicitly chooses this option
		const filesToUpdate = Array.from(selectedFiles.size > 0 ? selectedFiles : currentFiles)
		if (filesToUpdate.length === 0) return
		// Generate unique IDs for each file (overwriting any existing IDs)
		const usedIds = new Set()
		filesToUpdate.forEach((file) => {
			let randomId
			do {
				randomId = generateRandomId(12)
			} while (usedIds.has(randomId))
			usedIds.add(randomId)
			// Assign as manual ID (overwrites any existing pattern-based ID)
			fileParticipantIds[file] = randomId
			delete autoParticipantIds[file]
		})
		// Mark random IDs as active
		usingRandomIds = true
		currentPattern = '' // Clear pattern when using random IDs
		markActivePattern('')
		updateActiveStates()
		// Re-render files to show the new IDs
		renderFiles()
		updateImportButton()
		updateVisibleSections()
	}
	async function updatePatternSuggestions() {
		const container = document.getElementById('pattern-suggestions')
		const detectionSection = document.getElementById('pattern-detection-section')
		if (!container || !detectionSection) return
		const clearSuggestions = () => {
			container.innerHTML = ''
			detectionSection.style.display = 'none'
		}
		if (currentFiles.length === 0) {
			clearSuggestions()
			markActivePattern('')
			return
		}
		// Show the section first (always visible when files are loaded)
		detectionSection.style.display = 'block'
		container.innerHTML = ''
		let suggestions = []
		try {
			console.log('🔍 Requesting pattern suggestions for', currentFiles.length, 'files')
			suggestions = await invoke('suggest_patterns', { files: currentFiles })
			console.log('📋 Received', suggestions?.length || 0, 'pattern suggestions', suggestions)
		} catch (error) {
			console.error('❌ Failed to fetch pattern suggestions:', error)
			markActivePattern(currentPattern ? currentPattern.trim() : '')
			return
		}
		if (!suggestions || suggestions.length === 0) {
			console.log('⚠️ No pattern suggestions found')
			markActivePattern(currentPattern ? currentPattern.trim() : '')
			return
		}

		// Filter out the "Use parent directory names as participant IDs" pattern
		suggestions = suggestions.filter(
			(sugg) => sugg.description !== 'Use parent directory names as participant IDs',
		)

		// Auto-apply the first/best suggestion if it has high confidence
		const bestSuggestion = suggestions[0]
		const shouldAutoApply =
			bestSuggestion &&
			(bestSuggestion.count || currentFiles.length) >= currentFiles.length * 0.8 && // 80%+ match rate
			currentFiles.length >= 2 // Only auto-apply if multiple files
		suggestions.forEach((sugg) => {
			const macroValue = (sugg.pattern || '').trim()
			const regexValue = (sugg.regex_pattern || '').trim()
			const sample = Array.isArray(sugg.sample_extractions) ? sugg.sample_extractions[0] : null
			const exampleText = sample?.path ?? sugg.example ?? ''
			const exampleId = sample?.participant_id ?? ''
			const applyValue = macroValue || regexValue || ''
			const description = sugg.description || 'Extract participant ID from file path'

			const row = document.createElement('div')
			row.className = 'pattern-suggestion'
			row.dataset.macro = macroValue
			row.dataset.regex = regexValue

			const patternInfo = document.createElement('div')
			patternInfo.className = 'pattern-info'

			// Description header with file count badge
			const descHeader = document.createElement('div')
			descHeader.className = 'pattern-description-header'
			const descEl = document.createElement('div')
			descEl.className = 'pattern-description'
			descEl.textContent = description
			descHeader.appendChild(descEl)
			const matchesBadge = document.createElement('span')
			matchesBadge.className = 'pattern-matches'
			matchesBadge.textContent = `✓ ${sugg.count || currentFiles.length} file${
				(sugg.count || currentFiles.length) !== 1 ? 's' : ''
			}`
			descHeader.appendChild(matchesBadge)
			patternInfo.appendChild(descHeader)

			// Main pattern button - larger, more prominent
			const patternBtn = document.createElement('button')
			patternBtn.type = 'button'
			patternBtn.className = 'pattern-btn'

			// Show example extraction prominently
			let buttonContent = `<div class="pattern-btn-content">`
			if (exampleText && exampleId) {
				const fileName = exampleText.split('/').pop() || exampleText
				buttonContent += `
					<div class="pattern-example-preview">
						<span class="pattern-example-file">${fileName}</span>
						<span class="pattern-example-arrow">→</span>
						<span class="pattern-example-id">${exampleId}</span>
					</div>
				`
			}
			buttonContent += `</div>`
			patternBtn.innerHTML = buttonContent

			patternBtn.addEventListener('click', () => {
				if (applyValue) {
					void applyPattern(applyValue)
				}
			})
			patternInfo.appendChild(patternBtn)

			row.appendChild(patternInfo)
			container.appendChild(row)

			// Auto-apply best suggestion
			if (shouldAutoApply && sugg === bestSuggestion && applyValue) {
				setTimeout(() => {
					void applyPattern(applyValue)
				}, 300)
			}
		})
		markActivePattern(currentPattern ? currentPattern.trim() : '')
		updateActiveStates()
	}
	async function searchFiles() {
		if (!selectedFolder) return
		const extensions = getFileExtensions()
		if (extensions.length === 0) {
			currentFiles = []
			selectedFiles.clear()
			renderFiles()
			markActivePattern('')
			autoParticipantIds = {}
			fileParticipantIds = {}
			await updatePatternSuggestions()
			return
		}
		currentFiles = await invoke('search_txt_files', { path: selectedFolder, extensions })
		currentPattern = ''
		autoParticipantIds = {}
		fileParticipantIds = {}
		const patternInput = document.getElementById('custom-pattern')
		if (patternInput) {
			patternInput.value = ''
		}
		// Select all files by default
		selectedFiles.clear()
		currentFiles.forEach((file) => {
			selectedFiles.add(file)
		})
		renderFiles()
		markActivePattern(currentPattern)
		// Auto-detect patterns immediately when files are loaded
		await updatePatternSuggestions()
		updateVisibleSections()
	}
	async function updateFileTypeDropdown() {
		if (!selectedFolder) return
		const extensions = await invoke('get_extensions', { path: selectedFolder })
		const list = document.getElementById('file-type-list')
		list.innerHTML = ''
		// Common file types to auto-select
		const commonTypes = ['.txt', '.csv', '.vcf', '.fasta', '.fastq', '.tsv']
		extensions.forEach((ext) => {
			const label = document.createElement('label')
			label.className = 'file-type-checkbox'
			const checkbox = document.createElement('input')
			checkbox.type = 'checkbox'
			checkbox.value = ext.extension
			// Auto-select common file types
			if (commonTypes.includes(ext.extension)) {
				checkbox.checked = true
			}
			checkbox.addEventListener('change', () => {
				searchFiles()
				updateVisibleSections()
			})
			const span = document.createElement('span')
			span.textContent = `${ext.extension} (${ext.count})`
			label.appendChild(checkbox)
			label.appendChild(span)
			list.appendChild(label)
		})
		// Trigger search if any were auto-selected
		const hasAutoSelected = extensions.some((ext) => commonTypes.includes(ext.extension))
		if (hasAutoSelected) {
			await searchFiles()
			updateVisibleSections()
		}
	}
	async function pickFolder() {
		let selected = await open({
			directory: true,
			multiple: false,
		})
		if (!selected && typeof window !== 'undefined') {
			const override = window.__TEST_SELECT_FOLDER__
			if (typeof override === 'function') {
				try {
					selected = await override()
				} catch (error) {
					console.error('Test folder selection override failed:', error)
				}
			} else if (override) {
				selected = override
			}
		}
		if (selected) {
			selectedFiles.clear()
			updateSelectedFileCount()
			await refreshExistingFilePaths()
			selectedFolder = selected
			// Update folder display
			const folderDisplay = document.getElementById('folder-display')
			const dropzone = document.getElementById('folder-dropzone')
			const clearBtn = document.getElementById('dropzone-clear-btn')
			if (folderDisplay) {
				const folderName = selected.split('/').pop() || selected
				folderDisplay.textContent = folderName
				folderDisplay.title = selected
			}
			if (dropzone) {
				dropzone.classList.add('has-folder')
			}
			if (clearBtn) {
				clearBtn.style.display = 'flex'
			}
			await updateFileTypeDropdown()
			updateVisibleSections()
		}
	}
	function updateSelectAllCheckbox() {
		const selectAllCheckbox = document.getElementById('select-all-files')
		const selectableFiles = currentFiles
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
		const btn = document.getElementById('import-continue-btn')
		const statusEl = document.getElementById('import-status')
		const reviewBtn = document.getElementById('review-import-btn')
		if (!btn && !reviewBtn) return
		// Check prerequisites
		const selectedFilesArray = Array.from(selectedFiles)
		const hasSelection = selectedFilesArray.length > 0
		// If no files selected
		if (!hasSelection) {
			if (btn) btn.disabled = true
			if (statusEl) {
				if (currentFiles.length === 0) {
					statusEl.textContent = ''
				} else {
					statusEl.textContent = `Select ${
						currentFiles.length === 1 ? 'the file' : 'at least 1 file'
					} to continue`
				}
				statusEl.classList.remove('ready')
			}
			return
		}
		// Check if all selected files have participant IDs
		const allSelectedHaveIds = selectedFilesArray.every((file) => {
			const manual = fileParticipantIds[file]
			const auto = autoParticipantIds[file]
			const value = manual || auto
			return value !== undefined && value !== null && `${value}`.trim() !== ''
		})
		const filesMissingIdsList = selectedFilesArray.filter((file) => {
			const manual = fileParticipantIds[file]
			const auto = autoParticipantIds[file]
			const value = manual || auto
			return !value || `${value}`.trim() === ''
		})
		const missingIdCount = filesMissingIdsList.length
		filesMissingIds = filesMissingIdsList

		// Update filter and jump buttons visibility
		const filterBtn = document.getElementById('filter-missing-ids-btn')
		const _jumpBtn = document.getElementById('jump-to-missing-btn')
		const missingCountEl = document.getElementById('missing-ids-count')

		const validationActions = document.getElementById('file-validation-actions')
		if (missingIdCount > 0) {
			if (validationActions) validationActions.style.display = 'flex'
			if (filterBtn) {
				filterBtn.classList.toggle('active', showOnlyMissingIds)
			}
			if (missingCountEl) missingCountEl.textContent = missingIdCount
		} else {
			if (validationActions) validationActions.style.display = 'none'
			const wasFiltered = showOnlyMissingIds
			showOnlyMissingIds = false // Reset filter if no missing IDs
			// Re-render to show all files if filter was on
			if (wasFiltered) {
				renderFiles()
			}
		}

		// Enable only if every selected file has an ID
		if (allSelectedHaveIds) {
			if (btn) btn.disabled = false
			if (statusEl) {
				statusEl.innerHTML = `Ready to import ${selectedFiles.size} file${
					selectedFiles.size !== 1 ? 's' : ''
				}`
				statusEl.classList.add('ready')
				statusEl.classList.remove('has-issues')
				statusEl.style.cursor = 'default'
				statusEl.onclick = null
			}
		} else {
			if (btn) btn.disabled = true
			if (statusEl) {
				const hasPattern = currentPattern && currentPattern.trim() !== ''
				const suggestion = hasPattern
					? ' Click "Jump to missing" to find and fix them'
					: ' Click "Jump to missing" to find them'
				statusEl.innerHTML = `<span class="status-highlight">${missingIdCount} file${
					missingIdCount !== 1 ? 's need' : ' needs'
				} participant ID${suggestion}</span>`
				statusEl.classList.remove('ready')
				statusEl.classList.add('has-issues')
				// Make clickable to jump to first missing ID
				statusEl.style.cursor = 'pointer'
				statusEl.onclick = () => jumpToNextMissingId()
			}
		}
		if (typeof window !== 'undefined') {
			window.__IMPORT_DEBUG__ = {
				selectedFiles: Array.from(selectedFiles),
				autoParticipantIds: { ...autoParticipantIds },
				fileParticipantIds: { ...fileParticipantIds },
				allSelectedHaveIds,
			}
		}
	}
	function resetImportState() {
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
		autoParticipantIds = {}
		setLastImportView('import')
		// Reset step indicator
		updateStepIndicator(1)
		// Reset folder display
		const folderDisplay = document.getElementById('folder-display')
		const dropzone = document.getElementById('folder-dropzone')
		const clearBtn = document.getElementById('dropzone-clear-btn')
		if (folderDisplay) {
			folderDisplay.textContent = 'Drop folder here or click to browse'
		}
		if (dropzone) {
			dropzone.classList.remove('has-folder')
		}
		if (clearBtn) {
			clearBtn.style.display = 'none'
		}
		resetRandomIdsState()
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
		const patternDetectionSection = document.getElementById('pattern-detection-section')
		if (patternDetectionSection) {
			patternDetectionSection.style.display = 'none'
		}
		const customPatternInput = document.getElementById('custom-pattern')
		if (customPatternInput) {
			customPatternInput.value = ''
		}
		const patternSection = document.getElementById('pattern-section')
		if (patternSection) {
			patternSection.style.display = 'none'
		}
		markActivePattern('')
		const fileTypeList = document.getElementById('file-type-list')
		if (fileTypeList) {
			fileTypeList.innerHTML = ''
		}
		const fileTypeCheckboxes = document.querySelectorAll(
			'.file-type-checkbox input[type="checkbox"]',
		)
		fileTypeCheckboxes.forEach((cb) => (cb.checked = false))
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
			reviewImportBtn.style.display = 'none'
		}
		const detectBtn = document.getElementById('detect-types-btn')
		if (detectBtn) {
			detectBtn.disabled = false
		}
		const progressBar = document.getElementById('detection-progress')
		const progressBarFill = document.getElementById('progress-bar-fill')
		const progressText = document.getElementById('progress-text')
		if (progressBar && progressBarFill && progressText) {
			progressBar.classList.add('hidden')
			progressBarFill.style.width = '0%'
			progressText.textContent = ''
		}
		updateSelectAllCheckbox()
		updateImportButton()
		updateReviewSelectAllCheckbox()
		// Reset to step 1
		backToSelection()
		// Reset visibility
		updateVisibleSections()
	}
	async function goToReviewStep() {
		if (selectedFiles.size === 0) {
			return
		}

		// Check for files with assigned IDs that aren't selected
		const filesWithIdsButNotSelected = currentFiles.filter((file) => {
			if (selectedFiles.has(file)) return false // Skip files that are selected
			// Allow all files
			// Check if file has an ID assigned (manual or auto)
			const manualId = fileParticipantIds[file]
			const autoId = autoParticipantIds[file]
			return (manualId && manualId.trim() !== '') || (autoId && autoId.trim() !== '')
		})

		// Show confirmation if there are files with IDs that aren't selected
		if (filesWithIdsButNotSelected.length > 0 && dialog) {
			const fileCount = filesWithIdsButNotSelected.length
			const fileText = fileCount === 1 ? 'file' : 'files'
			const confirmed = await dialog.confirm(
				`You have assigned participant IDs to ${fileCount} ${fileText} that ${
					fileCount === 1 ? 'is' : 'are'
				} not selected for import. Are you sure you want to continue?\n\nThese IDs will not be imported.`,
				{ title: 'Unselected Files with IDs', type: 'warning' },
			)

			if (!confirmed) {
				return
			}
		}

		selectedFiles.forEach((file) => {
			if (!fileParticipantIds[file] && autoParticipantIds[file]) {
				fileParticipantIds[file] = autoParticipantIds[file]
			}
		})
		// Build file-to-ID mapping
		const filesToImport = Array.from(selectedFiles)
		// Initialize metadata for each file
		reviewFileMetadata = {}
		selectedReviewFiles = new Set()
		filesToImport.forEach((file) => {
			const participantId = fileParticipantIds[file] || null
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
		// Show review view inside modal
		showReviewViewInModal()
	}
	function showReviewViewInModal() {
		// Show step 2, hide step 1
		const step1 = document.getElementById('import-selection-view')
		const step2 = document.getElementById('import-step-2')
		const backBtn = document.getElementById('import-back-btn')
		const continueBtn = document.getElementById('import-continue-btn')
		const importBtn = document.getElementById('review-import-btn')

		if (step1) step1.style.display = 'none'
		if (step2) step2.style.display = 'block'
		if (backBtn) backBtn.style.display = 'block'
		if (continueBtn) continueBtn.style.display = 'none'
		if (importBtn) importBtn.style.display = 'block'

		// Update step indicator
		updateStepIndicator(2)
		// Render review table
		showReviewView()
		// Auto-detect file types on entering review step
		setTimeout(() => {
			detectFileTypes()
		}, 100)
	}
	function backToSelection() {
		// Show step 1, hide step 2
		const step1 = document.getElementById('import-selection-view')
		const step2 = document.getElementById('import-step-2')
		const backBtn = document.getElementById('import-back-btn')
		const continueBtn = document.getElementById('import-continue-btn')
		const importBtn = document.getElementById('review-import-btn')

		if (step1) step1.style.display = 'block'
		if (step2) step2.style.display = 'none'
		if (backBtn) backBtn.style.display = 'none'
		if (continueBtn) continueBtn.style.display = 'block'
		if (importBtn) importBtn.style.display = 'none'

		// Update step indicator
		updateStepIndicator(1)
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
		showReviewView()
		updateSortIndicators()
	}
	function _updateReviewSortIndicators() {
		// Not used in modal - keeping for compatibility
	}
	function showReviewView() {
		const reviewCountEl = document.getElementById('review-file-count')
		const tbody = document.getElementById('review-files-table')
		const bulkSourceSelect = document.getElementById('set-all-source')
		if (bulkSourceSelect) {
			populateSourceSelect(bulkSourceSelect, null, true)
		}
		if (reviewCountEl) {
			reviewCountEl.textContent = Object.keys(reviewFileMetadata).length
		}
		if (!tbody) {
			return
		}
		tbody.innerHTML = ''

		// Filter files if showing only incomplete configurations
		let filesToRender = Object.keys(reviewFileMetadata)
		if (showOnlyIncompleteReview) {
			filesToRender = filesToRender.filter((filePath) => {
				const metadata = reviewFileMetadata[filePath]
				return !isReviewMetadataComplete(metadata)
			})
		}

		const sortedFiles = sortReviewFiles(filesToRender)
		sortedFiles.forEach((filePath) => {
			const metadata = reviewFileMetadata[filePath]
			const row = document.createElement('tr')
			row.dataset.filePath = filePath

			// Make row clickable (except when clicking on inputs/buttons)
			row.style.cursor = 'pointer'
			row.addEventListener('click', (e) => {
				// Don't toggle if clicking on input, select, button
				if (
					e.target.tagName === 'INPUT' ||
					e.target.tagName === 'SELECT' ||
					e.target.tagName === 'BUTTON' ||
					e.target.closest('button')
				) {
					return
				}
				const checkbox = row.querySelector('input[type="checkbox"]')
				if (checkbox) {
					checkbox.checked = !checkbox.checked
					if (checkbox.checked) {
						selectedReviewFiles.add(filePath)
						row.classList.add('selected')
					} else {
						selectedReviewFiles.delete(filePath)
						row.classList.remove('selected')
					}
					updateReviewSelectAllCheckbox()
				}
			})

			// Checkbox cell - match first step styling
			const checkboxCell = document.createElement('td')
			checkboxCell.style.textAlign = 'center'
			checkboxCell.style.padding = '4px'
			const checkbox = document.createElement('input')
			checkbox.type = 'checkbox'
			checkbox.checked = selectedReviewFiles.has(filePath)
			checkbox.dataset.filePath = filePath
			// Add selected class to row if checked
			if (checkbox.checked) {
				row.classList.add('selected')
			}
			checkbox.addEventListener('change', (e) => {
				e.stopPropagation() // Prevent row click
				if (e.target.checked) {
					selectedReviewFiles.add(filePath)
					row.classList.add('selected')
				} else {
					selectedReviewFiles.delete(filePath)
					row.classList.remove('selected')
				}
				updateReviewSelectAllCheckbox()
			})
			checkboxCell.appendChild(checkbox)
			row.appendChild(checkboxCell)

			// File path cell - match first step styling exactly
			const pathCell = document.createElement('td')
			const pathParts = filePath.split('/')
			const filename = pathParts[pathParts.length - 1]
			const parentFolder = pathParts[pathParts.length - 2] || ''

			const pathWrapper = document.createElement('div')
			pathWrapper.style.display = 'flex'
			pathWrapper.style.alignItems = 'center'
			pathWrapper.style.gap = '6px'

			// Show parent folder in subdued color
			if (parentFolder) {
				const folderSpan = document.createElement('span')
				folderSpan.textContent = `.../${parentFolder}/`
				folderSpan.style.color = '#94a3b8'
				folderSpan.style.fontSize = '12px'
				pathWrapper.appendChild(folderSpan)
			}

			// Show filename
			const filenameSpan = document.createElement('span')
			filenameSpan.textContent = filename
			filenameSpan.style.color = '#1e293b'
			filenameSpan.style.fontWeight = '500'
			pathWrapper.appendChild(filenameSpan)

			pathCell.appendChild(pathWrapper)
			pathCell.title = filePath // Full path on hover
			row.appendChild(pathCell)

			// Data type dropdown - use same style as data page
			const dataTypeCell = document.createElement('td')
			const dataTypeSelect = document.createElement('select')
			dataTypeSelect.className = 'data-type-select'
			dataTypeSelect.innerHTML = `
				<option value="Unknown" ${metadata.data_type === 'Unknown' ? 'selected' : ''}>Unknown</option>
				<option value="Genotype" ${metadata.data_type === 'Genotype' ? 'selected' : ''}>Genotype</option>
				<option value="Phenotype" ${metadata.data_type === 'Phenotype' ? 'selected' : ''}>Phenotype</option>
			`
			dataTypeSelect.addEventListener('change', (e) => {
				e.stopPropagation() // Don't trigger row click
				reviewFileMetadata[filePath].data_type = e.target.value
				updateRowVisibility(row, e.target.value)
				applyReviewRowState(row, reviewFileMetadata[filePath])
				updateReviewStatus()
			})
			dataTypeCell.appendChild(dataTypeSelect)
			row.appendChild(dataTypeCell)

			// Source dropdown
			const sourceCell = document.createElement('td')
			const sourceSelect = document.createElement('select')
			sourceSelect.className = 'review-cell-select'
			populateSourceSelect(sourceSelect, metadata.source, true)
			sourceSelect.addEventListener('change', (e) => {
				e.stopPropagation() // Don't trigger row click
				reviewFileMetadata[filePath].source = e.target.value || null
				applyReviewRowState(row, reviewFileMetadata[filePath])
				updateReviewStatus()
			})
			sourceCell.appendChild(sourceSelect)
			row.appendChild(sourceCell)

			// GRCh version dropdown
			const grchCell = document.createElement('td')
			const grchSelect = document.createElement('select')
			grchSelect.className = 'review-cell-select'
			grchSelect.innerHTML = `
				<option value="">-</option>
				<option value="Unknown" ${metadata.grch_version === 'Unknown' ? 'selected' : ''}>Unknown</option>
				<option value="GRCh36" ${metadata.grch_version === 'GRCh36' ? 'selected' : ''}>GRCh36</option>
				<option value="GRCh37" ${metadata.grch_version === 'GRCh37' ? 'selected' : ''}>GRCh37</option>
				<option value="GRCh38" ${metadata.grch_version === 'GRCh38' ? 'selected' : ''}>GRCh38</option>
			`
			grchSelect.addEventListener('change', (e) => {
				e.stopPropagation() // Don't trigger row click
				reviewFileMetadata[filePath].grch_version = e.target.value || null
				applyReviewRowState(row, reviewFileMetadata[filePath])
				updateReviewStatus()
			})
			grchCell.appendChild(grchSelect)
			row.appendChild(grchCell)

			// Actions cell - folder button (match first step styling)
			const actionsCell = document.createElement('td')
			actionsCell.style.textAlign = 'center'
			actionsCell.style.padding = '4px'
			const folderBtn = document.createElement('button')
			folderBtn.className = 'show-in-folder-btn'
			folderBtn.innerHTML =
				'<img src="assets/icons/folder-open.svg" width="16" height="16" alt="" />'
			folderBtn.title = 'Show in Finder'
			folderBtn.addEventListener('click', async (e) => {
				e.preventDefault()
				e.stopPropagation()
				try {
					await invoke('show_in_folder', { filePath: filePath })
				} catch (error) {
					console.error('Failed to show file in folder:', error)
				}
			})
			actionsCell.appendChild(folderBtn)
			row.appendChild(actionsCell)

			applyReviewRowState(row, metadata)
			updateRowVisibility(row, metadata.data_type)
			tbody.appendChild(row)
		})
		updateReviewSelectAllCheckbox()
		updateReviewStatus()
		updateSortIndicators()
	}
	function updateReviewSelectAllCheckbox() {
		const selectAllCheckbox = document.getElementById('select-all-review')
		const reviewSelectedCountEl = document.getElementById('review-selected-count')
		const totalFiles = Object.keys(reviewFileMetadata).length
		const selectedCount = selectedReviewFiles.size
		if (selectAllCheckbox) {
			selectAllCheckbox.checked = selectedCount === totalFiles && totalFiles > 0
			selectAllCheckbox.indeterminate = selectedCount > 0 && selectedCount < totalFiles
		}
		if (reviewSelectedCountEl) {
			reviewSelectedCountEl.textContent = selectedCount
		}
		updateReviewStatus()
	}
	function updateReviewStatus() {
		const reviewStatusEl = document.getElementById('review-status')
		const importStatusEl = document.getElementById('import-status') // Unified status
		const statusEl = reviewStatusEl || importStatusEl
		if (!statusEl) return

		const totalFiles = Object.keys(reviewFileMetadata).length
		const selectedCount = selectedReviewFiles.size

		// Find incomplete configurations in selected files
		const incompleteSelected = Array.from(selectedReviewFiles).filter((filePath) => {
			const metadata = reviewFileMetadata[filePath]
			if (!metadata) return false
			return !isReviewMetadataComplete(metadata)
		})
		filesIncompleteReview = incompleteSelected

		// Update filter and jump buttons visibility
		const validationActions = document.getElementById('review-validation-actions')
		const filterBtn = document.getElementById('filter-incomplete-review-btn')
		const _jumpBtn = document.getElementById('jump-to-incomplete-review-btn')
		const incompleteCountEl = document.getElementById('incomplete-review-count')

		if (incompleteSelected.length > 0) {
			if (validationActions) validationActions.style.display = 'flex'
			if (filterBtn) {
				filterBtn.classList.toggle('active', showOnlyIncompleteReview)
			}
			if (incompleteCountEl) incompleteCountEl.textContent = incompleteSelected.length
		} else {
			if (validationActions) validationActions.style.display = 'none'
			showOnlyIncompleteReview = false // Reset filter if no incomplete
			if (filterBtn) filterBtn.classList.remove('active')
		}

		// Update status message (use unified status element)
		if (totalFiles === 0) {
			statusEl.innerHTML = 'No files to import'
			statusEl.classList.remove('has-issues', 'ready')
			statusEl.style.cursor = 'default'
			statusEl.onclick = null
		} else if (selectedCount === 0) {
			statusEl.innerHTML = 'Select files to import'
			statusEl.classList.remove('has-issues', 'ready')
			statusEl.style.cursor = 'default'
			statusEl.onclick = null
		} else if (incompleteSelected.length > 0) {
			statusEl.innerHTML = `<span class="status-highlight">${
				incompleteSelected.length
			} selected file${
				incompleteSelected.length !== 1 ? 's need' : ' needs'
			} configuration. Click to fix.</span>`
			statusEl.classList.add('has-issues')
			statusEl.classList.remove('ready')
			statusEl.style.cursor = 'pointer'
			statusEl.onclick = () => jumpToNextIncompleteReview()
		} else {
			statusEl.innerHTML = `Ready to import ${selectedCount} file${selectedCount !== 1 ? 's' : ''}`
			statusEl.classList.add('ready')
			statusEl.classList.remove('has-issues')
			statusEl.style.cursor = 'default'
			statusEl.onclick = null
		}
	}
	function isReviewMetadataComplete(metadata) {
		if (!metadata) return false
		// Data type is required for all files
		const hasDataType = metadata.data_type && metadata.data_type !== 'Unknown'
		if (!hasDataType) return false

		// For genotype files, source and GRCh are also required
		if (metadata.data_type === 'Genotype') {
			const hasSource = metadata.source && metadata.source !== 'Unknown' && metadata.source !== ''
			const hasGrch =
				metadata.grch_version && metadata.grch_version !== 'Unknown' && metadata.grch_version !== ''
			return hasSource && hasGrch
		}

		// For phenotype files, only data type is required
		return true
	}
	function applyReviewRowState(row, metadata) {
		if (!row) return
		if (isReviewMetadataComplete(metadata)) {
			row.classList.add('review-row-complete')
			row.classList.remove('review-row-incomplete')
		} else {
			row.classList.add('review-row-incomplete')
			row.classList.remove('review-row-complete')
			// Store file path for jumping
			if (row.dataset.filePath) {
				row.dataset.needsConfig = 'true'
			}
		}
	}
	function updateRowVisibility(_row, _dataType) {
		// Keep all fields visible regardless of data type
		// Users should be able to configure Source and GRCh even if data type is unknown
	}
	async function detectFileTypes() {
		if (selectedReviewFiles.size === 0) {
			alert('Please select files to detect')
			return
		}
		const btn = document.getElementById('detect-types-btn')
		const progressBar = document.getElementById('detection-progress')
		const progressBarFill = document.getElementById('progress-bar-fill')
		const progressText = document.getElementById('progress-text')
		// Show progress UI IMMEDIATELY before any work
		btn.disabled = true
		btn.innerHTML = '<span class="spinner"></span> Auto-detecting...'
		if (progressBar && progressBarFill && progressText) {
			progressBar.classList.remove('hidden')
			progressBarFill.style.width = '0%'
			progressText.textContent = 'Detecting file types...'
		}
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
				if (progressText)
					progressText.textContent = `Detecting file types... ${processed}/${totalFiles}`
				if (progressBarFill) progressBarFill.style.width = `${(processed / totalFiles) * 100}%`
				const detections = await invoke('detect_file_types', { files: batch })
				// Log the detection results to console for debugging
				console.log('🧬 detect_file_types batch result:', detections)
				// Update all metadata and UI for this batch
				Object.keys(detections).forEach((filePath) => {
					const detection = detections[filePath]
					console.log(`🧪 Detected metadata for ${filePath}:`, detection)
					if (reviewFileMetadata[filePath] && detection) {
						// Map the backend grch value to the expected dropdown format
						let grchValue = detection.grch_version
						if (grchValue === '36') {
							grchValue = 'GRCh36'
						} else if (grchValue === '37') {
							grchValue = 'GRCh37'
						} else if (grchValue === '38') {
							grchValue = 'GRCh38'
						} else if (grchValue && grchValue !== 'Unknown') {
							// If it's some other value, try to add GRCh prefix if not already there
							if (!grchValue.startsWith('GRCh')) {
								grchValue = `GRCh${grchValue}`
							}
						}

						console.log(`Updating metadata for ${filePath}:`, {
							data_type: detection.data_type,
							source: detection.source,
							grch_version: grchValue,
						})
						reviewFileMetadata[filePath].data_type = detection.data_type
						reviewFileMetadata[filePath].source = detection.source
						reviewFileMetadata[filePath].grch_version = grchValue
						updateRowInPlace(filePath)
					}
				})
				processed += batch.length
			}
			if (progressText) progressText.textContent = `Complete! Detected ${totalFiles} file types`
			if (progressBarFill) progressBarFill.style.width = '100%'
			// Update the status message to reflect the updated metadata
			updateReviewStatus()
		} catch (error) {
			alert(`Error detecting file types: ${error}`)
			console.error('Detection error:', error)
		} finally {
			btn.disabled = false
			btn.innerHTML =
				'<svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><path d="M8 0a8 8 0 1 0 0 16A8 8 0 0 0 8 0zM5.354 4.646L8 7.293l2.646-2.647a.5.5 0 0 1 .708.708L8.707 8l2.647 2.646a.5.5 0 0 1-.708.708L8 8.707l-2.646 2.647a.5.5 0 0 1-.708-.708L7.293 8 4.646 5.354a.5.5 0 1 1 .708-.708z"/></svg> Auto-detect'
			// Hide progress bar after a short delay
			setTimeout(() => {
				const progressBar = document.getElementById('detection-progress')
				const progressBarFill = document.getElementById('progress-bar-fill')
				if (progressBar) progressBar.classList.add('hidden')
				if (progressBarFill) progressBarFill.style.width = '0%'
			}, 800)
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
		// Column order: 1=checkbox, 2=file, 3=data type, 4=source, 5=grch, 6=folder button
		// Update data type dropdown
		const dataTypeSelect = targetRow.querySelector('td:nth-child(3) select')
		if (dataTypeSelect) {
			dataTypeSelect.value = metadata.data_type
			updateRowVisibility(targetRow, metadata.data_type)
		}
		// Update source dropdown
		const sourceSelect = targetRow.querySelector('td:nth-child(4) select')
		if (sourceSelect) {
			setSelectValue(sourceSelect, metadata.source)
		}
		// Update grch version dropdown
		const grchSelect = targetRow.querySelector('td:nth-child(5) select')
		if (grchSelect && metadata.grch_version) {
			grchSelect.value = metadata.grch_version
		}
		applyReviewRowState(targetRow, metadata)
	}
	async function finalizeImport() {
		const btn = document.getElementById('review-import-btn')
		const progressBar = document.getElementById('detection-progress')
		const progressBarFill = document.getElementById('progress-bar-fill')
		const progressText = document.getElementById('progress-text')
		// Mark import as in progress
		isImportInProgress = true
		// Show progress UI IMMEDIATELY before any work
		btn.disabled = true
		btn.innerHTML = '<span class="spinner"></span> Importing...'
		if (progressBar && progressBarFill && progressText) {
			progressBar.classList.remove('hidden')
			progressBarFill.style.width = '0%'
			progressText.textContent = 'Preparing import...'
		}
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
			})
			if (progressText) progressText.textContent = `Importing files...`
			if (progressBarFill) progressBarFill.style.width = '50%'
			// Direct import (no queue)
			const result = await invoke('import_files_with_metadata', {
				fileMetadata: fileMetadata,
			})
			if (progressText) progressText.textContent = `Complete! Imported ${totalFiles} files`
			if (progressBarFill) progressBarFill.style.width = '100%'
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
				await loadParticipantsView()
				await loadFiles()
				// Close modal and reset after successful import
				setTimeout(() => {
					resetImportState()
					isImportInProgress = false
					const progressBar = document.getElementById('detection-progress')
					const progressBarFill = document.getElementById('progress-bar-fill')
					if (progressBar) progressBar.classList.add('hidden')
					if (progressBarFill) progressBarFill.style.width = '0%'
					closeImportModal()
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
					const progressBar = document.getElementById('detection-progress')
					const progressBarFill = document.getElementById('progress-bar-fill')
					if (progressBar) progressBar.classList.add('hidden')
					if (progressBarFill) progressBarFill.style.width = '0%'
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
				const progressBar = document.getElementById('detection-progress')
				const progressBarFill = document.getElementById('progress-bar-fill')
				if (progressBar) progressBar.style.display = 'none'
				if (progressBarFill) progressBarFill.style.width = '0%'
			}, 2000)
		}
	}
	function handleSelectAllFiles(checked) {
		if (checked) {
			currentFiles.forEach((file) => {
				selectedFiles.add(file)
			})
		} else {
			selectedFiles.clear()
		}
		renderFiles()
		updateVisibleSections()
		updateSelectedFileCount()
		updateImportButton()
	}
	function handleSelectAllReview(checked) {
		const allFiles = Object.keys(reviewFileMetadata)
		if (checked) {
			allFiles.forEach((file) => selectedReviewFiles.add(file))
		} else {
			selectedReviewFiles.clear()
		}
		showReviewView()
	}
	function toggleMissingIdsFilter() {
		showOnlyMissingIds = !showOnlyMissingIds
		renderFiles()
		updateVisibleSections()
		updateSelectAllCheckbox()
		updateSelectedFileCount()
	}
	function toggleIncompleteReviewFilter() {
		showOnlyIncompleteReview = !showOnlyIncompleteReview
		showReviewView()
	}
	function jumpToNextIncompleteReview() {
		if (filesIncompleteReview.length === 0) {
			// Recalculate from current state
			filesIncompleteReview = Array.from(selectedReviewFiles).filter((filePath) => {
				const metadata = reviewFileMetadata[filePath]
				return !isReviewMetadataComplete(metadata)
			})
		}

		if (filesIncompleteReview.length === 0) return

		// Turn off filter if it was on
		if (showOnlyIncompleteReview) {
			showOnlyIncompleteReview = false
			showReviewView()
			setTimeout(() => jumpToNextIncompleteReview(), 100)
			return
		}

		// Find first incomplete row
		const firstIncompleteFile = filesIncompleteReview[0]
		const rows = document.querySelectorAll('#review-files-table tr')
		let targetRow = null

		for (const row of rows) {
			if (row.dataset.filePath === firstIncompleteFile || row.dataset.needsConfig === 'true') {
				targetRow = row
				break
			}
		}

		// Fallback: find first row with incomplete class
		if (!targetRow) {
			const incompleteRows = document.querySelectorAll(
				'#review-files-table tr.review-row-incomplete',
			)
			if (incompleteRows.length > 0) {
				targetRow = incompleteRows[0]
			}
		}

		if (targetRow) {
			targetRow.scrollIntoView({ behavior: 'smooth', block: 'center' })
			const originalTransition = targetRow.style.transition
			targetRow.style.transition = 'all 0.3s ease'
			targetRow.style.boxShadow = '0 0 0 4px rgba(251, 191, 36, 0.3)'
			const originalBg = targetRow.style.backgroundColor
			targetRow.style.backgroundColor = '#fef3c7'
			setTimeout(() => {
				targetRow.style.boxShadow = ''
				targetRow.style.backgroundColor = originalBg || ''
				targetRow.style.transition = originalTransition || ''
			}, 2500)
			// Focus the first dropdown
			const firstSelect = targetRow.querySelector('select')
			if (firstSelect) {
				setTimeout(() => {
					firstSelect.focus()
				}, 400)
			}
		}
	}
	function jumpToNextMissingId() {
		// Recalculate missing IDs from current state if needed
		if (filesMissingIds.length === 0) {
			filesMissingIds = Array.from(selectedFiles).filter((file) => {
				const manual = fileParticipantIds[file]
				const auto = autoParticipantIds[file]
				const value = manual || auto
				return !value || `${value}`.trim() === ''
			})
		}

		if (filesMissingIds.length === 0) return

		// Turn off filter to show all files if it was on
		if (showOnlyMissingIds) {
			showOnlyMissingIds = false
			renderFiles()
			// Wait for render to complete
			setTimeout(() => jumpToNextMissingId(), 100)
			return
		}

		// Find first missing ID row in DOM by matching file path
		const firstMissingFile = filesMissingIds[0]
		const rows = document.querySelectorAll('#file-list tr')
		let targetRow = null

		for (const row of rows) {
			// Check if this row corresponds to the missing file
			const checkbox = row.querySelector('input[type="checkbox"][data-file-path]')
			if (checkbox && checkbox.dataset.filePath === firstMissingFile) {
				targetRow = row
				break
			}
		}

		// Fallback: find first row with missing-id class
		if (!targetRow) {
			const missingRows = document.querySelectorAll('#file-list tr.missing-id')
			if (missingRows.length > 0) {
				targetRow = missingRows[0]
			}
		}

		if (targetRow) {
			// Scroll to row
			targetRow.scrollIntoView({ behavior: 'smooth', block: 'center' })
			// Highlight it briefly with a pulse animation
			const originalTransition = targetRow.style.transition
			targetRow.style.transition = 'all 0.3s ease'
			targetRow.style.boxShadow = '0 0 0 4px rgba(251, 191, 36, 0.3)'
			const originalBg = targetRow.style.backgroundColor
			targetRow.style.backgroundColor = '#fef3c7'
			setTimeout(() => {
				targetRow.style.boxShadow = ''
				targetRow.style.backgroundColor = originalBg || ''
				targetRow.style.transition = originalTransition || ''
			}, 2500)
			// Focus the input
			const input = targetRow.querySelector('.participant-id-input')
			if (input) {
				setTimeout(() => {
					input.focus()
					input.select()
				}, 400)
			}
		}
	}
	function handleBulkDataTypeChange(value) {
		if (!value) return
		if (selectedReviewFiles.size === 0) {
			alert('Please select files to update')
			return
		}
		selectedReviewFiles.forEach((file) => {
			reviewFileMetadata[file].data_type = value
		})
		showReviewView()
	}
	function handleBulkSourceChange(value) {
		if (!value) return
		if (selectedReviewFiles.size === 0) {
			alert('Please select files to update')
			return
		}
		selectedReviewFiles.forEach((file) => {
			reviewFileMetadata[file].source = value
		})
		showReviewView()
	}
	function handleBulkGrchVersionChange(value) {
		if (!value) return
		if (selectedReviewFiles.size === 0) {
			alert('Please select files to update')
			return
		}
		selectedReviewFiles.forEach((file) => {
			reviewFileMetadata[file].grch_version = value
		})
		showReviewView()
	}
	function handleCustomPatternInput(value) {
		if (patternInputDebounce) {
			clearTimeout(patternInputDebounce)
		}
		// Apply immediately while typing with minimal debounce for performance
		const trimmed = value.trim()
		if (trimmed.length > 0) {
			// Very short debounce (100ms) to avoid excessive calls while typing
			patternInputDebounce = setTimeout(() => {
				patternInputDebounce = null
				// Try to apply, but catch errors silently for invalid patterns
				applyPattern(trimmed).catch(() => {
					// Pattern might be invalid, but don't show error - user is still typing
				})
			}, 100)
		} else {
			// Clear pattern if empty
			currentPattern = ''
			usingRandomIds = false
			autoParticipantIds = {}
			markActivePattern('')
			updateActiveStates()
			renderFiles()
			updateImportButton()
		}
	}
	function handleCustomPatternFocus(value) {
		// Apply immediately when input is focused/clicked
		if (patternInputDebounce) {
			clearTimeout(patternInputDebounce)
			patternInputDebounce = null
		}
		const trimmed = value.trim()
		if (trimmed.length > 0) {
			applyPattern(trimmed).catch(() => {
				// Pattern might be invalid, but don't show error
			})
		}
	}
	function handleCustomPatternBlur(value) {
		if (patternInputDebounce) {
			clearTimeout(patternInputDebounce)
			patternInputDebounce = null
		}
		applyPattern(value)
	}
	function handleCustomPatternKeydown(key, value) {
		if (key === 'Enter') {
			if (patternInputDebounce) {
				clearTimeout(patternInputDebounce)
				patternInputDebounce = null
			}
			applyPattern(value)
		}
	}
	async function handleCopyPattern(pattern) {
		try {
			await copyToClipboard(pattern)
		} catch (error) {
			console.error('Failed to copy pattern:', error)
		}
	}
	function updateStepIndicator(_step) {
		// Step indicators removed - function kept for compatibility but does nothing
	}
	async function handleFolderDrop(paths) {
		if (!paths || paths.length === 0) return

		// Take the first path (could be a file or folder)
		const droppedPath = paths[0]

		// Check if it's a directory via Tauri command
		try {
			const isDir = await invoke('is_directory', { path: droppedPath })
			if (isDir) {
				selectedFiles.clear()
				updateSelectedFileCount()
				await refreshExistingFilePaths()
				selectedFolder = droppedPath

				// Update UI
				const folderDisplay = document.getElementById('folder-display')
				const dropzone = document.getElementById('folder-dropzone')
				const clearBtn = document.getElementById('dropzone-clear-btn')
				if (folderDisplay) {
					const folderName = droppedPath.split('/').pop() || droppedPath
					folderDisplay.textContent = folderName
					folderDisplay.title = droppedPath
				}
				if (dropzone) {
					dropzone.classList.add('has-folder')
				}
				if (clearBtn) {
					clearBtn.style.display = 'flex'
				}

				await updateFileTypeDropdown()
				updateVisibleSections()
			} else {
				// It's a file, not a folder - get parent directory
				const parts = droppedPath.split('/')
				parts.pop() // Remove filename
				const folderPath = parts.join('/')

				selectedFiles.clear()
				updateSelectedFileCount()
				await refreshExistingFilePaths()
				selectedFolder = folderPath

				// Update UI
				const folderDisplay = document.getElementById('folder-display')
				const dropzone = document.getElementById('folder-dropzone')
				const clearBtn = document.getElementById('dropzone-clear-btn')
				if (folderDisplay) {
					const folderName = folderPath.split('/').pop() || folderPath
					folderDisplay.textContent = folderName
					folderDisplay.title = folderPath
				}
				if (dropzone) {
					dropzone.classList.add('has-folder')
				}
				if (clearBtn) {
					clearBtn.style.display = 'flex'
				}

				await updateFileTypeDropdown()
				updateVisibleSections()
			}
		} catch (error) {
			console.error('Failed to process dropped path:', error)
		}
	}
	async function initFolderDropzone() {
		const dropzone = document.getElementById('folder-dropzone')
		if (!dropzone) {
			console.log('⚠️ Dropzone element not found')
			return
		}

		console.log('🎯 Initializing folder dropzone')

		// Setup Tauri file drop listener using Tauri v2 API
		if (typeof window !== 'undefined' && window.__TAURI__) {
			console.log('✅ Tauri environment detected')
			try {
				const { getCurrentWebviewWindow } = window.__TAURI__.webviewWindow
				const currentWindow = getCurrentWebviewWindow()

				await currentWindow.onDragDropEvent((event) => {
					console.log('🎯 Drag-drop event:', event)
					const dropzone = document.getElementById('folder-dropzone')

					if (event.payload.type === 'over') {
						console.log('👆 Drag over')
						if (dropzone) {
							dropzone.classList.add('drag-over')
						}
					} else if (event.payload.type === 'drop') {
						console.log('📦 Drop received:', event.payload.paths)
						if (dropzone) {
							dropzone.classList.remove('drag-over')
						}
						handleFolderDrop(event.payload.paths)
					} else if (event.payload.type === 'leave' || event.payload.type === 'cancel') {
						console.log('❌ Drag cancelled')
						if (dropzone) {
							dropzone.classList.remove('drag-over')
						}
					}
				})
				console.log('✅ Registered drag-drop event handler')
			} catch (err) {
				console.error('❌ Failed to setup Tauri file drop handler:', err)
			}
		} else {
			console.log('⚠️ Not in Tauri environment')
		}

		// Fallback: Prevent default drag behaviors and show visual feedback
		const events = ['dragenter', 'dragover', 'dragleave', 'drop']
		events.forEach((eventName) => {
			dropzone.addEventListener(eventName, (e) => {
				e.preventDefault()
				e.stopPropagation()
			})
		})

		// Highlight dropzone when dragging over (fallback for web)
		const dragEvents = ['dragenter', 'dragover']
		dragEvents.forEach((eventName) => {
			dropzone.addEventListener(eventName, () => {
				dropzone.classList.add('drag-over')
			})
		})

		dropzone.addEventListener('dragleave', () => {
			dropzone.classList.remove('drag-over')
		})

		// Fallback drop handler (won't work in Tauri, just for completeness)
		dropzone.addEventListener('drop', () => {
			dropzone.classList.remove('drag-over')
		})
	}
	return {
		openImportModal,
		closeImportModal,
		backToSelection,
		pickFolder,
		searchFiles,
		renderFiles,
		updateSelectAllCheckbox,
		updateSelectedFileCount,
		updateImportButton,
		resetImportState,
		goToReviewStep,
		showReviewView,
		detectFileTypes,
		finalizeImport,
		toggleMissingIdsFilter,
		jumpToNextMissingId,
		toggleIncompleteReviewFilter,
		jumpToNextIncompleteReview,
		setSortField,
		initColumnResizers,
		setReviewSortField,
		applyPattern,
		updatePatternSuggestions,
		markActivePattern,
		updateFileTypeDropdown,
		getFileExtensions,
		handleSelectAllFiles,
		handleSelectAllReview,
		handleBulkDataTypeChange,
		handleBulkSourceChange,
		handleBulkGrchVersionChange,
		handleCustomPatternInput,
		handleCustomPatternBlur,
		handleCustomPatternKeydown,
		handleCustomPatternFocus,
		handleCopyPattern,
		copyToClipboard,
		assignRandomIds,
		updateStepIndicator,
		initFolderDropzone,
		handleFolderDrop,
		getIsImportInProgress: () => isImportInProgress,
		getSelectedFolder: () => selectedFolder,
		getSelectedFiles: () => selectedFiles,
		getReviewFileMetadata: () => reviewFileMetadata,
		getSelectedReviewFiles: () => selectedReviewFiles,
	}
}
