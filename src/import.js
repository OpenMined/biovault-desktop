// Import Data Module - File selection, pattern matching, and import workflow
export function createImportModule({
	invoke,
	open,
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
	let reviewSortField = 'path'
	let reviewSortDirection = 'asc'
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
			// Reset to selection view for next time
			setTimeout(() => {
				backToSelection()
			}, 300)
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
		// Pattern section is now toggled manually via autofill button - don't auto-show

		// Show file list if files are found
		if (filesPanel) {
			filesPanel.style.display = currentFiles.length > 0 ? 'block' : 'none'
		}
		// Show footer if files are found
		if (importFooter) {
			importFooter.style.display = currentFiles.length > 0 ? 'flex' : 'none'
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
			if (indicator && header.dataset.sort === sortField) {
				indicator.textContent = sortDirection === 'asc' ? '▲' : '▼'
			} else if (indicator) {
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
			if (!currentFiles.includes(file) || isFileAlreadyImported(file)) {
				selectedFiles.delete(file)
			}
		}
		if (currentFiles.length === 0) {
			const tr = document.createElement('tr')
			const td = document.createElement('td')
			td.colSpan = 4
			td.textContent = 'No files found'
			td.style.textAlign = 'center'
			td.style.padding = '20px'
			td.style.color = '#94a3b8'
			tr.appendChild(td)
			tbody.appendChild(tr)
			return
		}
		// Sort files
		const sortedFiles = sortFiles(currentFiles)
		const activePattern = currentPattern ? currentPattern.trim() : ''
		sortedFiles.forEach((file) => {
			const row = document.createElement('tr')
			const alreadyImported = isFileAlreadyImported(file)
			const manualId = fileParticipantIds[file] || ''
			const autoId = autoParticipantIds[file] || ''
			const effectiveId = manualId || autoId || ''
			if (alreadyImported) {
				row.classList.add('already-imported')
			}

			// Make row clickable (except when clicking on inputs/buttons)
			if (!alreadyImported) {
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
						} else {
							selectedFiles.delete(file)
						}
						updateSelectAllCheckbox()
						updateImportButton()
						updateSelectedFileCount()
						updateVisibleSections()
					}
				})
			}

			// Checkbox cell
			const checkboxCell = document.createElement('td')
			checkboxCell.style.textAlign = 'center'
			checkboxCell.style.padding = '10px'
			const checkbox = document.createElement('input')
			checkbox.type = 'checkbox'
			checkbox.checked = selectedFiles.has(file)
			if (alreadyImported) {
				checkbox.checked = false
				checkbox.disabled = true
				checkbox.title = 'File already imported'
				selectedFiles.delete(file)
			}
			checkbox.addEventListener('change', (e) => {
				e.stopPropagation() // Prevent row click from firing
				if (e.target.checked) {
					selectedFiles.add(file)
				} else {
					selectedFiles.delete(file)
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
			participantCell.style.padding = '10px'
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
					fileParticipantIds[file] = value
					delete autoParticipantIds[file]
					input.classList.remove('extracted')
					input.classList.add('manual')
				} else {
					delete fileParticipantIds[file]
					input.classList.remove('manual')
					input.classList.remove('extracted')
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
			actionsCell.style.padding = '10px'
			const folderBtn = document.createElement('button')
			folderBtn.className = 'show-in-folder-btn'
			folderBtn.innerHTML =
				'<img src="assets/icons/folder-open.svg" width="16" height="16" alt="" />'
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
			tbody.appendChild(row)
		})
		// Update sort indicators
		updateSortIndicators()
		document.getElementById('file-count').textContent = currentFiles.length
		updateSelectAllCheckbox()
		updateSelectedFileCount()
		updateImportButton()
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
	async function applyPattern(pattern) {
		const normalized = pattern ? pattern.trim() : ''
		const patternInput = document.getElementById('custom-pattern')
		if (patternInput && patternInput.value.trim() !== normalized) {
			patternInput.value = normalized
		}
		currentPattern = normalized
		markActivePattern(normalized)
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
			Object.entries(results || {}).forEach(([filePath, value]) => {
				if (value !== null && value !== undefined && `${value}`.trim() !== '') {
					autoParticipantIds[filePath] = `${value}`.trim()
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
	async function updatePatternSuggestions() {
		const container = document.getElementById('pattern-suggestions')
		const detectionSection = document.getElementById('pattern-detection-section')
		const feedback = document.getElementById('pattern-feedback')
		if (!container || !detectionSection) return
		const setFeedback = (message, variant = 'info') => {
			if (!feedback) return
			feedback.textContent = message
			if (!message) {
				feedback.removeAttribute('data-variant')
			} else if (variant === 'error') {
				feedback.dataset.variant = 'error'
			} else {
				feedback.removeAttribute('data-variant')
			}
		}
		const clearSuggestions = () => {
			container.innerHTML = ''
			detectionSection.setAttribute('hidden', '')
		}
		if (currentFiles.length === 0) {
			clearSuggestions()
			setFeedback('')
			markActivePattern('')
			return
		}
		setFeedback('Analyzing filenames for patterns…')
		clearSuggestions()
		let suggestions = []
		try {
			suggestions = await invoke('suggest_patterns', { files: currentFiles })
		} catch (error) {
			console.error('Failed to fetch pattern suggestions:', error)
			setFeedback(
				'Unable to detect patterns. Try a different folder or check the console for details.',
				'error',
			)
			markActivePattern(currentPattern ? currentPattern.trim() : '')
			return
		}
		if (!suggestions || suggestions.length === 0) {
			setFeedback('No ID patterns detected.')
			markActivePattern(currentPattern ? currentPattern.trim() : '')
			return
		}
		detectionSection.removeAttribute('hidden')
		setFeedback('')
		container.innerHTML = ''
		suggestions.forEach((sugg) => {
			const macroValue = (sugg.pattern || '').trim()
			const regexValue = (sugg.regex_pattern || '').trim()
			const sample = Array.isArray(sugg.sample_extractions) ? sugg.sample_extractions[0] : null
			const exampleText = sample?.path ?? sugg.example ?? ''
			const exampleId = sample?.participant_id ?? ''
			const applyValue = macroValue || regexValue || ''
			const row = document.createElement('div')
			row.className = 'pattern-suggestion'
			row.dataset.macro = macroValue
			row.dataset.regex = regexValue
			const patternInfo = document.createElement('div')
			patternInfo.className = 'pattern-info'
			// Main pattern button
			const patternBtn = document.createElement('button')
			patternBtn.type = 'button'
			patternBtn.className = 'pattern-btn'
			patternBtn.innerHTML = `
			<code class="pattern-text">${macroValue || regexValue || '(none)'}</code>
			<span class="pattern-matches">${sugg.count || currentFiles.length} matches</span>
		`
			patternBtn.addEventListener('click', () => {
				if (applyValue) {
					void applyPattern(applyValue)
				}
			})
			patternInfo.appendChild(patternBtn)
			// Example if available
			if (exampleText) {
				const example = document.createElement('div')
				example.className = 'pattern-example'
				example.innerHTML = `<span class="pattern-example-label">Example:</span> ${highlightPath(
					exampleText,
					applyValue,
					exampleId,
				)}`
				patternInfo.appendChild(example)
			}
			row.appendChild(patternInfo)
			// Copy button
			const copyBtn = document.createElement('button')
			copyBtn.type = 'button'
			copyBtn.className = 'pattern-copy-btn'
			copyBtn.title = 'Copy pattern'
			const copyIcon = document.createElement('img')
			copyIcon.src = 'assets/icons/copy.svg'
			copyIcon.width = 14
			copyIcon.height = 14
			copyBtn.appendChild(copyIcon)
			copyBtn.addEventListener('click', async (e) => {
				e.stopPropagation()
				await copyToClipboard(applyValue)
			})
			row.appendChild(copyBtn)
			container.appendChild(row)
		})
		markActivePattern(currentPattern ? currentPattern.trim() : '')
	}
	async function searchFiles() {
		if (!selectedFolder) return
		const extensions = getFileExtensions()
		if (extensions.length === 0) {
			currentFiles = []
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
		renderFiles()
		markActivePattern(currentPattern)
		await updatePatternSuggestions()
		updateVisibleSections()
	}
	async function updateFileTypeDropdown() {
		if (!selectedFolder) return
		const extensions = await invoke('get_extensions', { path: selectedFolder })
		const list = document.getElementById('file-type-list')
		list.innerHTML = ''
		extensions.forEach((ext) => {
			const label = document.createElement('label')
			label.className = 'file-type-checkbox'
			const checkbox = document.createElement('input')
			checkbox.type = 'checkbox'
			checkbox.value = ext.extension
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
		// Don't auto-select - let user choose their file types
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
			if (folderDisplay) {
				const folderName = selected.split('/').pop() || selected
				folderDisplay.textContent = folderName
				folderDisplay.title = selected
			}
			if (dropzone) {
				dropzone.classList.add('has-folder')
			}
			await updateFileTypeDropdown()
			updateVisibleSections()
		}
	}
	function updateSelectAllCheckbox() {
		const selectAllCheckbox = document.getElementById('select-all-files')
		const selectableFiles = currentFiles.filter((file) => !isFileAlreadyImported(file))
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
		if (!btn) return
		// Check prerequisites
		const selectedFilesArray = Array.from(selectedFiles)
		const hasSelection = selectedFilesArray.length > 0
		// If no files selected
		if (!hasSelection) {
			btn.disabled = true
			if (statusEl) {
				statusEl.textContent = 'Select files to continue'
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
		const missingIdCount = selectedFilesArray.filter((file) => {
			const manual = fileParticipantIds[file]
			const auto = autoParticipantIds[file]
			const value = manual || auto
			return !value || `${value}`.trim() === ''
		}).length
		// Enable only if every selected file has an ID
		if (allSelectedHaveIds) {
			btn.disabled = false
			if (statusEl) {
				statusEl.textContent = `Ready to import ${selectedFiles.size} file${
					selectedFiles.size !== 1 ? 's' : ''
				}`
				statusEl.classList.add('ready')
			}
		} else {
			btn.disabled = true
			if (statusEl) {
				statusEl.textContent = `${missingIdCount} file${
					missingIdCount !== 1 ? 's need' : ' needs'
				} participant ID`
				statusEl.classList.remove('ready')
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
		if (folderDisplay) {
			folderDisplay.textContent = 'Drop folder here or click to browse'
		}
		if (dropzone) {
			dropzone.classList.remove('has-folder')
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
		const patternDetectionSection = document.getElementById('pattern-detection-section')
		if (patternDetectionSection) {
			patternDetectionSection.setAttribute('hidden', '')
		}
		const patternFeedback = document.getElementById('pattern-feedback')
		if (patternFeedback) {
			patternFeedback.textContent = ''
			patternFeedback.removeAttribute('data-variant')
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
		}
		const detectBtn = document.getElementById('detect-types-btn')
		if (detectBtn) {
			detectBtn.disabled = false
			detectBtn.innerHTML =
				'<img src="assets/icons/wand-sparkles.svg" width="16" height="16" alt="" />'
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
		// Reset modal views to selection view
		const selectionView = document.getElementById('import-selection-view')
		const reviewView = document.getElementById('import-modal-review')
		if (selectionView) selectionView.style.display = 'flex'
		if (reviewView) reviewView.style.display = 'none'
		// Reset visibility
		updateVisibleSections()
	}
	function goToReviewStep() {
		if (selectedFiles.size === 0) {
			return
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
		// Hide selection view, show review view
		const selectionView = document.getElementById('import-selection-view')
		const reviewView = document.getElementById('import-modal-review')
		if (selectionView) {
			selectionView.style.display = 'none'
		}
		if (reviewView) {
			reviewView.style.display = 'flex'
		}
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
		// Show selection view, hide review view
		const selectionView = document.getElementById('import-selection-view')
		const reviewView = document.getElementById('import-modal-review')
		if (selectionView) {
			selectionView.style.display = 'flex'
		}
		if (reviewView) {
			reviewView.style.display = 'none'
		}
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
		const sortedFiles = sortReviewFiles(Object.keys(reviewFileMetadata))
		sortedFiles.forEach((filePath) => {
			const metadata = reviewFileMetadata[filePath]
			const row = document.createElement('tr')
			row.style.borderBottom = '1px solid #eee'
			row.style.height = 'auto'
			row.style.display = 'table-row'
			row.style.visibility = 'visible'
			row.style.opacity = '1'
			row.style.cursor = 'pointer'
			row.dataset.filePath = filePath

			// Make row clickable
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
					} else {
						selectedReviewFiles.delete(filePath)
					}
					updateReviewSelectAllCheckbox()
				}
			})

			// Checkbox cell
			const checkboxCell = document.createElement('td')
			checkboxCell.style.padding = '10px'
			checkboxCell.style.textAlign = 'center'
			const checkbox = document.createElement('input')
			checkbox.type = 'checkbox'
			checkbox.checked = selectedReviewFiles.has(filePath)
			checkbox.addEventListener('change', (e) => {
				e.stopPropagation() // Prevent row click
				if (e.target.checked) {
					selectedReviewFiles.add(filePath)
				} else {
					selectedReviewFiles.delete(filePath)
				}
				updateReviewSelectAllCheckbox()
			})
			checkboxCell.appendChild(checkbox)
			row.appendChild(checkboxCell)
			// File path cell - intelligently truncated
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
			// Data type dropdown
			const dataTypeCell = document.createElement('td')
			const dataTypeSelect = document.createElement('select')
			dataTypeSelect.innerHTML = `
				<option value="Unknown" ${metadata.data_type === 'Unknown' ? 'selected' : ''}>Unknown</option>
				<option value="Genotype" ${metadata.data_type === 'Genotype' ? 'selected' : ''}>Genotype</option>
			`
			dataTypeSelect.addEventListener('change', (e) => {
				e.stopPropagation() // Don't trigger row click
				reviewFileMetadata[filePath].data_type = e.target.value
				updateRowVisibility(row, e.target.value)
				applyReviewRowState(row, reviewFileMetadata[filePath])
			})
			dataTypeCell.appendChild(dataTypeSelect)
			row.appendChild(dataTypeCell)
			// Source dropdown
			const sourceCell = document.createElement('td')
			sourceCell.className = 'genotype-field'
			const sourceSelect = document.createElement('select')
			populateSourceSelect(sourceSelect, metadata.source, true)
			sourceSelect.addEventListener('change', (e) => {
				e.stopPropagation() // Don't trigger row click
				reviewFileMetadata[filePath].source = e.target.value || null
				applyReviewRowState(row, reviewFileMetadata[filePath])
			})
			sourceCell.appendChild(sourceSelect)
			row.appendChild(sourceCell)
			// GRCh version dropdown
			const grchCell = document.createElement('td')
			grchCell.className = 'genotype-field'
			const grchSelect = document.createElement('select')
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
			})
			grchCell.appendChild(grchSelect)
			row.appendChild(grchCell)
			// Folder button cell
			const folderCell = document.createElement('td')
			folderCell.style.textAlign = 'center'
			folderCell.style.padding = '10px'
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
			folderCell.appendChild(folderBtn)
			row.appendChild(folderCell)
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
		updateReviewSelectAllCheckbox()
	}
	function updateReviewSelectAllCheckbox() {
		const selectAllCheckbox = document.getElementById('select-all-review')
		const reviewSelectedCountEl = document.getElementById('review-selected-count')
		const reviewStatusEl = document.getElementById('review-status')
		const totalFiles = Object.keys(reviewFileMetadata).length
		const selectedCount = selectedReviewFiles.size
		if (selectAllCheckbox) {
			selectAllCheckbox.checked = selectedCount === totalFiles && totalFiles > 0
			selectAllCheckbox.indeterminate = selectedCount > 0 && selectedCount < totalFiles
		}
		if (reviewSelectedCountEl) {
			reviewSelectedCountEl.textContent = selectedCount
		}
		if (reviewStatusEl) {
			if (totalFiles === 0) {
				reviewStatusEl.textContent = 'No files to import'
			} else if (selectedCount === 0) {
				reviewStatusEl.textContent = 'Select files to import'
			} else {
				reviewStatusEl.textContent = `Ready to import ${selectedCount} file${
					selectedCount !== 1 ? 's' : ''
				}`
			}
		}
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
		const progressDiv = document.getElementById('detection-progress')
		const progressBar = document.getElementById('progress-bar')
		const progressText = document.getElementById('progress-text')
		// Show progress UI IMMEDIATELY before any work
		btn.disabled = true
		btn.innerHTML = '<span class="spinner"></span>'
		progressDiv.style.display = 'flex'
		progressBar.style.width = '0%'
		progressText.textContent = 'Detecting file types...'
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
			progressText.textContent = `Complete! Detected ${totalFiles} file types`
			progressBar.style.width = '100%'
		} catch (error) {
			alert(`Error detecting file types: ${error}`)
			console.error('Detection error:', error)
		} finally {
			btn.disabled = false
			btn.innerHTML = '<img src="assets/icons/wand-sparkles.svg" width="16" height="16" alt="" />'
			// Hide progress bar after a short delay
			setTimeout(() => {
				progressDiv.style.display = 'none'
				progressBar.style.width = '0%'
			}, 1500)
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
		if (sourceSelect) {
			setSelectValue(sourceSelect, metadata.source)
		}
		// Update grch version dropdown
		const grchSelect = targetRow.querySelector('td:nth-child(5) select')
		console.log(`Updating grch for ${filePath}:`, {
			grchSelect: grchSelect,
			grch_version: metadata.grch_version,
			selectOptions: grchSelect ? Array.from(grchSelect.options).map((o) => o.value) : [],
		})
		if (grchSelect && metadata.grch_version) {
			grchSelect.value = metadata.grch_version
			console.log(
				`Set grch select value to: ${metadata.grch_version}, actual value: ${grchSelect.value}`,
			)
		}
		// Note: Column 6 is detect button (header only), Column 7 is folder button
		// Update row count (column 8 - hidden)
		const rowCountCell = targetRow.querySelector('td:nth-child(8)')
		if (rowCountCell) {
			rowCountCell.textContent = metadata.row_count ? metadata.row_count.toLocaleString() : '-'
		}
		// Update chromosome count (column 9 - hidden)
		const chromCountCell = targetRow.querySelector('td:nth-child(9)')
		if (chromCountCell) {
			chromCountCell.textContent = metadata.chromosome_count || '-'
		}
		// Update inferred sex (column 10 - hidden)
		const sexCell = targetRow.querySelector('td:nth-child(10)')
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
			})
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
				await loadParticipantsView()
				await loadFiles()
				// Close modal and reset after successful import
				setTimeout(() => {
					resetImportState()
					isImportInProgress = false
					progressDiv.style.display = 'none'
					progressBar.style.width = '0%'
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
	function handleSelectAllFiles(checked) {
		if (checked) {
			currentFiles.forEach((file) => {
				if (!isFileAlreadyImported(file)) {
					selectedFiles.add(file)
				}
			})
		} else {
			selectedFiles.clear()
		}
		renderFiles()
		updateVisibleSections()
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
		patternInputDebounce = setTimeout(() => {
			patternInputDebounce = null
			applyPattern(value)
		}, 300)
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
		// Step indicators removed - no longer needed
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
				if (folderDisplay) {
					const folderName = droppedPath.split('/').pop() || droppedPath
					folderDisplay.textContent = folderName
					folderDisplay.title = droppedPath
				}
				if (dropzone) {
					dropzone.classList.add('has-folder')
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
				if (folderDisplay) {
					const folderName = folderPath.split('/').pop() || folderPath
					folderDisplay.textContent = folderName
					folderDisplay.title = folderPath
				}
				if (dropzone) {
					dropzone.classList.add('has-folder')
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
		handleCopyPattern,
		copyToClipboard,
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
