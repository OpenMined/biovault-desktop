import { initOnboarding } from './onboarding.js'
import { createDashboardShell } from './dashboard.js'
import { createParticipantsModule } from './participants.js'
import { createLogsModule } from './logs.js'
import { createRunsModule } from './runs.js'
import { createFilesModule } from './files.js'
import { createProjectsModule } from './projects.js'
import { createMessagesModule } from './messages.js'
import { invoke, dialog, event, shell as shellApi, windowApi } from './tauri-shim.js'

const { open } = dialog
const { listen } = event

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
let isImportInProgress = false // Track if import is currently running
let dependencyResults = null // Store dependency check results globally
let cltWaitState = {
	overlay: null,
	intervalId: null,
	active: false,
	onComplete: null,
	onCancel: null,
	windowState: null,
}

const {
	loadParticipants: loadParticipantsView,
	setSearchTerm: setParticipantsSearchTerm,
	getSelectedParticipants,
	handleSelectAll: handleParticipantsSelectAll,
} = createParticipantsModule({ invoke })

const {
	prepareRunView,
	loadRuns,
	runAnalysis,
	toggleSelectAllParticipants,
	shareCurrentRunLogs,
	setNavigateTo: setRunNavigateTo,
} = createRunsModule({ invoke, listen })

const { loadFiles, refreshExistingFilePaths, initializeFilesTab, isFileAlreadyImported } =
	createFilesModule({ invoke })

const { loadCommandLogs, displayLogs, clearLogs, copyLogs } = createLogsModule({ invoke })

// Create projects module early with placeholder navigateTo
let projectsNavigateTo = () => console.warn('navigateTo not yet initialized')
const projectsModule = createProjectsModule({
	invoke,
	dialog,
	open,
	shellApi,
	navigateTo: (...args) => projectsNavigateTo(...args),
})
const {
	loadProjects,
	importProject,
	showCreateProjectModal,
	hideCreateProjectModal,
	handleProjectNameInputChange,
	chooseProjectDirectory,
	resetProjectDirectory,
	createProjectFromModal,
	handleSaveProjectEditor,
	handleLaunchJupyter,
	handleResetJupyter,
} = projectsModule

// Create messages module early with placeholder getActiveView
let messagesGetActiveView = () => 'home'
const messagesModule = createMessagesModule({
	invoke,
	getCurrentUserEmail: () => currentUserEmail,
	getSyftboxStatus: () => syftboxStatus,
	setSyftboxStatus: (status) => {
		syftboxStatus = status
	},
	getActiveView: () => messagesGetActiveView(),
})
const {
	initializeMessagesTab,
	loadMessageThreads,
	startMessagesAutoRefresh,
	stopMessagesAutoRefresh,
	sendCurrentMessage,
	setActiveMessageFilterButton,
	setSyftboxTarget,
	handleDeleteThread,
	ensureMessagesAuthorizationAndStartNew,
	updateComposeVisibilityPublic,
	resetActiveThread,
	getMessageFilter,
	getMessagesInitialized,
	getMessagesAuthorized,
} = messagesModule

function getAppWindow() {
	if (!windowApi) return null
	if (typeof windowApi.getCurrent === 'function') {
		return windowApi.getCurrent()
	}
	return windowApi.appWindow || null
}

async function adjustWindowForCltPrompt() {
	const appWindow = getAppWindow()
	if (!appWindow) return
	if (cltWaitState.windowState) return

	try {
		const [size, position] = await Promise.all([appWindow.innerSize(), appWindow.outerPosition()])

		cltWaitState.windowState = { size, position }

		const logicalSizeCtor = windowApi?.LogicalSize
		const logicalPositionCtor = windowApi?.LogicalPosition

		const targetSize = logicalSizeCtor ? new logicalSizeCtor(780, 560) : { width: 780, height: 560 }
		const targetPosition = logicalPositionCtor ? new logicalPositionCtor(40, 60) : { x: 40, y: 60 }

		await appWindow.setSize(targetSize)
		await appWindow.setPosition(targetPosition)
		await appWindow.unminimize()
		await appWindow.show()
	} catch (error) {
		console.warn('Unable to reposition BioVault window for CLT prompt:', error)
	}
}

async function restoreWindowAfterCltPrompt() {
	const appWindow = getAppWindow()
	if (!appWindow) return
	const state = cltWaitState.windowState
	cltWaitState.windowState = null
	if (!state) return

	try {
		const logicalSizeCtor = windowApi?.LogicalSize
		const logicalPositionCtor = windowApi?.LogicalPosition

		if (state.size) {
			const originalSize = logicalSizeCtor
				? new logicalSizeCtor(state.size.width, state.size.height)
				: { width: state.size.width, height: state.size.height }
			await appWindow.setSize(originalSize)
		}
		if (state.position) {
			const originalPosition = logicalPositionCtor
				? new logicalPositionCtor(state.position.x, state.position.y)
				: { x: state.position.x, y: state.position.y }
			await appWindow.setPosition(originalPosition)
		}
		await appWindow.show()
		await appWindow.setFocus()
	} catch (error) {
		console.warn('Unable to restore BioVault window after CLT prompt:', error)
	}
}

function ensureCltOverlay() {
	if (cltWaitState.overlay) return cltWaitState.overlay

	const existingStyles = document.getElementById('clt-wait-styles')
	if (!existingStyles) {
		const styleEl = document.createElement('style')
		styleEl.id = 'clt-wait-styles'
		styleEl.textContent = `
		@keyframes clt-spin {
			0% { transform: rotate(0deg); }
			100% { transform: rotate(360deg); }
		}
		#clt-wait-overlay {
			position: fixed;
			top: 0;
			left: 0;
			right: 0;
			bottom: 0;
			background: rgba(255, 255, 255, 0.92);
			z-index: 9999;
			display: none;
			align-items: center;
			justify-content: center;
			padding: 24px;
		}
		#clt-wait-overlay[data-visible="true"] {
			display: flex;
		}
		#clt-wait-overlay .clt-card {
			width: 420px;
			max-width: 95vw;
			background: #ffffff;
			border-radius: 16px;
			box-shadow: 0 20px 60px rgba(0, 0, 0, 0.12);
			padding: 28px;
			font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
			color: #222;
		}
		#clt-wait-overlay .clt-header {
			display: flex;
			align-items: center;
			gap: 12px;
			margin-bottom: 16px;
		}
		#clt-wait-overlay .clt-header h2 {
			margin: 0;
			font-size: 20px;
			font-weight: 600;
		}
		#clt-wait-overlay .clt-body {
			font-size: 14px;
			line-height: 1.5;
			color: #444;
			margin-bottom: 18px;
		}
		#clt-wait-overlay .clt-status {
			display: flex;
			gap: 14px;
			align-items: center;
			background: #f6f7fb;
			border-radius: 10px;
			padding: 14px;
			margin-bottom: 18px;
		}
		#clt-wait-overlay .clt-spinner {
			width: 36px;
			height: 36px;
			border-radius: 50%;
			border: 3px solid rgba(70, 95, 255, 0.2);
			border-top-color: #465fff;
			animation: clt-spin 1s linear infinite;
		}
		#clt-wait-overlay .clt-status-text {
			font-size: 14px;
			font-weight: 600;
			color: #1f2933;
			margin: 0 0 4px 0;
		}
		#clt-wait-overlay .clt-feedback {
			margin: 0;
			font-size: 12px;
			color: #6b7280;
		}
		#clt-wait-overlay .clt-actions {
			display: flex;
			justify-content: flex-end;
			gap: 10px;
		}
		#clt-wait-overlay button {
			border-radius: 6px;
			padding: 8px 16px;
			font-weight: 600;
			font-size: 13px;
			cursor: pointer;
			border: none;
		}
		#clt-wait-overlay .clt-cancel-btn {
			background: #f3f4f6;
			color: #4b5563;
		}
		#clt-wait-overlay .clt-cancel-btn:hover {
			background: #e5e7eb;
		}
		#clt-wait-overlay .clt-check-btn {
			background: #465fff;
			color: #ffffff;
		}
		#clt-wait-overlay .clt-check-btn[disabled] {
			opacity: 0.6;
			cursor: not-allowed;
		}
		`
		document.head.appendChild(styleEl)
	}

	const overlay = document.createElement('div')
	overlay.id = 'clt-wait-overlay'
	overlay.innerHTML = `
		<div class="clt-card">
			<div class="clt-header">
				<span style="font-size: 26px;">🛠️</span>
				<h2>Install Command Line Tools</h2>
			</div>
			<p class="clt-body">
				BioVault needs the macOS Command Line Tools before it can install Homebrew. We just opened Apple's installer. Follow the prompts in the Apple dialog shown below.
			</p>
			<div style="display: flex; justify-content: center; margin-bottom: 16px;">
				<img src="assets/xcode-cli-tools.png" alt="Command Line Tools Installer" style="max-width: 100%; border-radius: 8px; box-shadow: 0 12px 28px rgba(31, 41, 55, 0.18);">
			</div>
			<div class="clt-status">
				<div class="clt-spinner"></div>
				<div>
					<p class="clt-status-text">Waiting for installation to finish…</p>
					<p class="clt-feedback">This can take a few minutes. Keep the installer window visible.</p>
				</div>
			</div>
			<div style="font-size: 12px; color: #4b5563; margin-bottom: 18px;">
				<ul style="padding-left: 18px; margin: 0; list-style: disc;">
					<li>Look for the “Install Command Line Developer Tools” window (screenshot above).</li>
					<li>A download progress bar may appear after you click “Install”.</li>
					<li>When it finishes, choose “Done” in the Apple dialog.</li>
				</ul>
			</div>
			<div class="clt-actions">
				<button type="button" class="clt-cancel-btn">Cancel</button>
				<button type="button" class="clt-check-btn">I've Finished</button>
			</div>
		</div>
	`

	document.body.appendChild(overlay)

	const cancelBtn = overlay.querySelector('.clt-cancel-btn')
	const checkBtn = overlay.querySelector('.clt-check-btn')
	const statusText = overlay.querySelector('.clt-status-text')
	const feedbackText = overlay.querySelector('.clt-feedback')

	cancelBtn.addEventListener('click', () => {
		cancelCltMonitor('User cancelled Command Line Tools install prompt')
	})

	checkBtn.addEventListener('click', async () => {
		checkBtn.disabled = true
		await checkCltReady(true)
		checkBtn.disabled = false
	})

	cltWaitState.overlay = overlay
	cltWaitState.statusText = statusText
	cltWaitState.feedbackText = feedbackText
	cltWaitState.checkBtn = checkBtn

	return overlay
}

const progressTasks = new Map()

function ensureProgressContainer() {
	let container = document.getElementById('operation-progress')
	if (!container) {
		container = document.createElement('div')
		container.id = 'operation-progress'
		container.className = 'operation-progress'
		document.body.appendChild(container)
	}
	return container
}

function showProgressTask(id, label, options = {}) {
	const { state = 'active' } = options
	const container = ensureProgressContainer()
	let task = progressTasks.get(id)

	if (!task) {
		const entry = document.createElement('div')
		entry.className = 'operation-progress-entry'
		entry.dataset.taskId = id

		const labelEl = document.createElement('div')
		labelEl.className = 'operation-progress-label'
		entry.appendChild(labelEl)

		const track = document.createElement('div')
		track.className = 'operation-progress-track'
		const bar = document.createElement('div')
		bar.className = 'operation-progress-bar'
		track.appendChild(bar)
		entry.appendChild(track)

		container.appendChild(entry)
		progressTasks.set(id, { entry, labelEl, bar })
		task = progressTasks.get(id)
	}

	task.entry.classList.remove('success', 'error', 'waiting')
	if (state === 'waiting') {
		task.entry.classList.add('waiting')
	}

	task.labelEl.textContent = label
	task.bar.style.animation = 'progress-indeterminate 1.2s ease-in-out infinite'
	task.bar.style.width = state === 'waiting' ? '30%' : '40%'
	task.bar.style.background = ''

	container.setAttribute('data-visible', 'true')
}

function finishProgressTask(id, { status = 'success', message } = {}) {
	const task = progressTasks.get(id)
	if (!task) return

	const { entry, labelEl, bar } = task
	entry.classList.remove('waiting')

	if (status === 'success') {
		entry.classList.add('success')
		labelEl.textContent = message || `${labelEl.textContent} complete`
		bar.style.background = ''
	} else if (status === 'error') {
		entry.classList.add('error')
		labelEl.textContent = message || `${labelEl.textContent} failed`
		bar.style.background = ''
	}

	bar.style.animation = 'none'
	bar.style.width = '100%'

	const container = ensureProgressContainer()
	setTimeout(
		() => {
			if (entry.parentElement === container) {
				container.removeChild(entry)
			}
			progressTasks.delete(id)
			if (!container.children.length) {
				container.removeAttribute('data-visible')
			}
		},
		status === 'error' ? 4500 : 2000,
	)
}

function setButtonLoading(button, label) {
	if (button.classList.contains('btn-loading')) {
		updateButtonLoadingLabel(button, label)
		return
	}

	if (!button.dataset.originalContent) {
		button.dataset.originalContent = button.innerHTML
	}

	button.disabled = true
	button.classList.add('btn-loading')
	button.innerHTML = ''

	const spinner = document.createElement('span')
	spinner.className = 'button-spinner'
	const text = document.createElement('span')
	text.className = 'button-spinner-label'
	text.textContent = label

	button.append(spinner, text)
}

function updateButtonLoadingLabel(button, label) {
	const labelEl = button.querySelector('.button-spinner-label')
	if (labelEl) {
		labelEl.textContent = label
	} else if (button.disabled) {
		button.textContent = label
	}
}

function clearButtonLoading(button) {
	if (button.dataset.originalContent) {
		button.innerHTML = button.dataset.originalContent
		delete button.dataset.originalContent
	} else {
		button.textContent = button.textContent || 'Install'
	}
	button.disabled = false
	button.classList.remove('btn-loading')
}

async function checkCltReady(fromManual = false) {
	try {
		const ready = await invoke('check_command_line_tools_installed')
		if (ready) {
			handleCltReady()
			return
		}
		if (fromManual && cltWaitState.feedbackText) {
			cltWaitState.feedbackText.textContent =
				"Still waiting for Command Line Tools. Keep the Apple installer running, then click 'I've Finished' once it completes."
		}
	} catch (error) {
		console.error('Failed to check Command Line Tools status:', error)
		if (fromManual && cltWaitState.feedbackText) {
			cltWaitState.feedbackText.textContent = 'Could not verify yet. Please try again in a moment.'
		}
	}
}

async function startCltMonitor(onComplete, options = {}) {
	const overlay = ensureCltOverlay()
	if (cltWaitState.active) {
		cltWaitState.onComplete = onComplete
		cltWaitState.onCancel = options.onCancel || null
		return
	}

	cltWaitState.onComplete = onComplete
	cltWaitState.onCancel = options.onCancel || null
	cltWaitState.active = true
	await adjustWindowForCltPrompt()
	if (cltWaitState.statusText) {
		cltWaitState.statusText.textContent = 'Waiting for installation to finish…'
	}
	if (cltWaitState.feedbackText) {
		cltWaitState.feedbackText.textContent =
			'This can take a few minutes. Keep the installer window visible.'
	}
	overlay.setAttribute('data-visible', 'true')

	if (cltWaitState.intervalId) {
		clearInterval(cltWaitState.intervalId)
	}
	cltWaitState.intervalId = setInterval(() => {
		checkCltReady(false)
	}, 5000)

	checkCltReady(false)
}

function cancelCltMonitor(reason) {
	if (cltWaitState.intervalId) {
		clearInterval(cltWaitState.intervalId)
		cltWaitState.intervalId = null
	}
	cltWaitState.active = false
	cltWaitState.onComplete = null
	const cancelCallback = cltWaitState.onCancel
	cltWaitState.onCancel = null
	if (cltWaitState.overlay) {
		cltWaitState.overlay.removeAttribute('data-visible')
	}
	if (reason) {
		console.log(reason)
	}
	if (typeof cancelCallback === 'function') {
		try {
			cancelCallback()
		} catch (error) {
			console.error('CLT cancel callback error:', error)
		}
	}
	restoreWindowAfterCltPrompt()
}

async function handleCltReady() {
	if (!cltWaitState.active) return
	if (cltWaitState.intervalId) {
		clearInterval(cltWaitState.intervalId)
		cltWaitState.intervalId = null
	}
	if (cltWaitState.statusText) {
		cltWaitState.statusText.textContent = 'Command Line Tools detected!'
	}
	if (cltWaitState.feedbackText) {
		cltWaitState.feedbackText.textContent = 'Continuing with Homebrew installation…'
	}

	const callback = cltWaitState.onComplete
	cltWaitState.onComplete = null
	cltWaitState.onCancel = null
	cltWaitState.active = false
	await restoreWindowAfterCltPrompt()

	setTimeout(async () => {
		if (cltWaitState.overlay) {
			cltWaitState.overlay.removeAttribute('data-visible')
		}
		if (typeof callback === 'function') {
			try {
				await callback()
			} catch (error) {
				console.error('Error running post-CLT callback:', error)
			}
		}
	}, 600)
}

async function runHomebrewInstall({ button, onSuccess } = {}) {
	const taskId = 'install-brew'
	showProgressTask(taskId, 'Installing Homebrew...')
	if (button) {
		setButtonLoading(button, 'Installing Homebrew...')
	}

	try {
		await invoke('install_brew')
		finishProgressTask(taskId, { status: 'success', message: 'Homebrew installed' })

		if (typeof onSuccess === 'function') {
			try {
				await onSuccess()
			} catch (onSuccessError) {
				if (button) {
					clearButtonLoading(button)
				}
				throw onSuccessError
			}
		} else {
			if (button) {
				clearButtonLoading(button)
			}
			await dialog.message(
				'✓ Homebrew installed successfully!\n\nNow you can proceed with installing dependencies.',
				{ title: 'Success', type: 'info' },
			)
		}
	} catch (error) {
		const errorMessage = typeof error === 'string' ? error : error?.message || `${error}`

		if (errorMessage.includes('Command Line Tools must be installed')) {
			showProgressTask(taskId, 'Waiting for Command Line Tools…', { state: 'waiting' })
			if (button) {
				updateButtonLoadingLabel(button, 'Waiting for Command Line Tools...')
			}
			await startCltMonitor(
				async () => {
					await runHomebrewInstall({ button, onSuccess })
				},
				{
					onCancel: () => {
						finishProgressTask(taskId, {
							status: 'error',
							message: 'Command Line Tools installation cancelled',
						})
						if (button) {
							clearButtonLoading(button)
						}
					},
				},
			)
			return
		}

		finishProgressTask(taskId, {
			status: 'error',
			message: 'Homebrew installation failed',
		})
		if (button) {
			clearButtonLoading(button)
		}
		await dialog.message(
			`Failed to install Homebrew: ${errorMessage}\n\nPlease install Homebrew manually from brew.sh`,
			{ title: 'Installation Failed', type: 'error' },
		)
	}
}

let autoParticipantIds = {} // Auto-extracted IDs for the current pattern
let patternInputDebounce = null
let currentUserEmail = ''
let syftboxStatus = { running: false, mode: 'Direct' }

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
		if (!currentFiles.includes(file) || isFileAlreadyImported(file)) {
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
	const activePattern = currentPattern ? currentPattern.trim() : ''

	sortedFiles.forEach((file) => {
		const li = document.createElement('li')
		const alreadyImported = isFileAlreadyImported(file)
		const metadata = getFileMetadata(file)
		const manualId = fileParticipantIds[file] || ''
		const autoId = autoParticipantIds[file] || ''
		const effectiveId = manualId || autoId || ''

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
		pathDiv.innerHTML = highlightPath(file, activePattern, effectiveId)
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

function markActivePattern(pattern) {
	const normalized = pattern ? pattern.trim() : ''
	const patternCards = document.querySelectorAll('.pattern-card')
	patternCards.forEach((card) => {
		const macroValue = card.dataset.macro
		const regexValue = card.dataset.regex
		const macroChip = card.querySelector('[data-pattern-type="macro"]')
		const regexChip = card.querySelector('[data-pattern-type="regex"]')

		const macroActive = normalized && macroValue === normalized
		const regexActive = normalized && regexValue === normalized

		card.classList.toggle('active', macroActive || regexActive)
		if (macroChip) {
			macroChip.classList.toggle('active', macroActive)
		}
		if (regexChip) {
			regexChip.classList.toggle('active', regexActive)
		}
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
	if (!container) return

	if (currentFiles.length === 0) {
		container.innerHTML =
			'<div class="pattern-empty">Select a folder and file type to detect patterns.</div>'
		markActivePattern('')
		return
	}

	container.innerHTML = '<div class="pattern-loading">Analyzing filenames for patterns…</div>'

	let suggestions = []
	try {
		suggestions = await invoke('suggest_patterns', { files: currentFiles })
	} catch (error) {
		console.error('Failed to fetch pattern suggestions:', error)
		container.innerHTML =
			'<div class="pattern-error">Unable to detect patterns. Try a different folder or check the console for details.</div>'
		markActivePattern(currentPattern ? currentPattern.trim() : '')
		return
	}

	if (!suggestions || suggestions.length === 0) {
		container.innerHTML =
			'<div class="pattern-empty">No ID patterns detected. Try selecting a different file type or adjust your dataset.</div>'
		markActivePattern(currentPattern ? currentPattern.trim() : '')
		return
	}

	container.innerHTML = ''

	suggestions.forEach((sugg) => {
		const macroValue = (sugg.pattern || '').trim()
		const regexValue = (sugg.regex_pattern || '').trim()

		const card = document.createElement('div')
		card.className = 'pattern-card'
		card.dataset.macro = macroValue
		card.dataset.regex = regexValue

		const title = document.createElement('div')
		title.className = 'pattern-card-title'
		title.textContent = sugg.description
		card.appendChild(title)

		const chipRow = document.createElement('div')
		chipRow.className = 'pattern-card-chips'

		const macroChip = document.createElement('button')
		macroChip.className = 'pattern-chip pattern-chip--macro'
		macroChip.dataset.patternType = 'macro'
		macroChip.textContent = macroValue
		macroChip.title = 'Use macro pattern'
		macroChip.addEventListener('click', () => {
			void applyPattern(macroValue)
		})

		chipRow.appendChild(macroChip)

		if (regexValue) {
			const regexChip = document.createElement('button')
			regexChip.className = 'pattern-chip pattern-chip--regex'
			regexChip.dataset.patternType = 'regex'
			regexChip.textContent = regexValue
			regexChip.title = 'Use regex pattern'
			regexChip.addEventListener('click', () => {
				void applyPattern(regexValue)
			})
			chipRow.appendChild(regexChip)
		} else {
			const regexLabel = document.createElement('span')
			regexLabel.className = 'pattern-chip pattern-chip--regex disabled'
			regexLabel.dataset.patternType = 'regex'
			regexLabel.textContent = 'Regex unavailable'
			chipRow.appendChild(regexLabel)
		}
		card.appendChild(chipRow)

		if (sugg.example) {
			const exampleRow = document.createElement('div')
			exampleRow.className = 'pattern-card-example'
			exampleRow.innerHTML = `<span>Example:</span> <span>${sugg.example}</span>`
			card.appendChild(exampleRow)
		}

		if (Array.isArray(sugg.sample_extractions) && sugg.sample_extractions.length > 0) {
			const sampleList = document.createElement('ul')
			sampleList.className = 'pattern-card-samples'
			sugg.sample_extractions.slice(0, 2).forEach((sample) => {
				const samplePath = sample?.path ?? sample?.[0]
				const sampleId = sample?.participant_id ?? sample?.[1]
				if (!samplePath || !sampleId) return
				const item = document.createElement('li')
				item.innerHTML = `<span class="pattern-card-sample-path">${samplePath}</span><span class="pattern-card-sample-id">→ ${sampleId}</span>`
				sampleList.appendChild(item)
			})
			card.appendChild(sampleList)
		}

		container.appendChild(card)
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
	const btn = document.getElementById('import-btn')

	// Check if any files are selected and all selected files have participant IDs
	const selectedFilesArray = Array.from(selectedFiles)
	const hasSelection = selectedFilesArray.length > 0
	const allSelectedHaveIds =
		hasSelection &&
		selectedFilesArray.every((file) => {
			const manual = fileParticipantIds[file]
			const auto = autoParticipantIds[file]
			const value = manual || auto
			return value !== undefined && value !== null && `${value}`.trim() !== ''
		})

	btn.disabled = !allSelectedHaveIds
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
	autoParticipantIds = {}
	setLastImportView('import')

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

	markActivePattern('')

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
			await loadParticipantsView()
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
		await dialog.message('Please enter your email address first.', {
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

	// Reset the OTP state to show the "Send Code" button
	document.getElementById('syftbox-send-state').style.display = 'block'
	document.getElementById('syftbox-email-info').style.display = 'none'
	document.getElementById('syftbox-otp-state').style.display = 'none'
	document.getElementById('syftbox-error-message').style.display = 'none'

	const sendSyftboxBtn = document.getElementById('send-login-code-btn')
	if (sendSyftboxBtn) {
		sendSyftboxBtn.disabled = false
		sendSyftboxBtn.textContent = 'Send Code'
	}

	const verifySyftboxBtn = document.getElementById('verify-code-btn')
	if (verifySyftboxBtn) {
		verifySyftboxBtn.disabled = true
		verifySyftboxBtn.textContent = 'Verify Code'
	}

	// Clear any previous OTP inputs
	document.querySelectorAll('.syftbox-code-input').forEach((input) => {
		input.value = ''
		input.classList.remove('error', 'success')
	})
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

const { navigateTo, registerNavigationHandlers, getActiveView, setLastImportView } =
	createDashboardShell({
		getIsImportInProgress: () => isImportInProgress,
		setIsImportInProgress: (value) => {
			isImportInProgress = value
		},
		loadParticipants: loadParticipantsView,
		loadFiles,
		loadProjects,
		prepareRunView,
		loadRuns,
		displayLogs,
		loadSettings,
		initializeMessagesTab,
		getMessagesInitialized,
		getMessagesAuthorized,
		getSyftboxStatus: () => syftboxStatus,
		startMessagesAutoRefresh,
		stopMessagesAutoRefresh,
	})

setRunNavigateTo(navigateTo)

// Now set the real navigateTo function for projects module
projectsNavigateTo = navigateTo

// Now set the real getActiveView function for messages module
messagesGetActiveView = getActiveView

window.addEventListener('DOMContentLoaded', () => {
	console.log('🔥 DOMContentLoaded fired')
	refreshExistingFilePaths()
	loadParticipantsView()
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

	registerNavigationHandlers()
	initializeFilesTab()

	const messageFilterButtons = document.querySelectorAll('.message-filter')
	messageFilterButtons.forEach((btn) => {
		btn.addEventListener('click', () => {
			if (btn.classList.contains('active')) return
			setActiveMessageFilterButton(btn.dataset.filter)
			resetActiveThread()
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
			ensureMessagesAuthorizationAndStartNew()
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
			ensureMessagesAuthorizationAndStartNew()
		})
	}

	const deleteThreadBtn = document.getElementById('delete-thread-btn')
	if (deleteThreadBtn) {
		deleteThreadBtn.addEventListener('click', handleDeleteThread)
	}

	setActiveMessageFilterButton(getMessageFilter())

	document.getElementById('done-btn').addEventListener('click', () => {
		navigateTo('home')
	})

	updateComposeVisibilityPublic(false)

	document.getElementById('close-logs-btn').addEventListener('click', () => {
		document.getElementById('log-viewer').style.display = 'none'
	})

	document.getElementById('share-logs-btn').addEventListener('click', shareCurrentRunLogs)

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

	const selectAllParticipantsTable = document.getElementById('select-all-participants-table')
	if (selectAllParticipantsTable) {
		selectAllParticipantsTable.addEventListener('change', (e) => {
			handleParticipantsSelectAll(e.target.checked)
		})
	}

	const deleteParticipantsBtn = document.getElementById('delete-selected-participants-btn')
	if (deleteParticipantsBtn) {
		deleteParticipantsBtn.addEventListener('click', async () => {
			const selected = getSelectedParticipants()
			if (selected.length === 0) return

			if (
				confirm(
					`Are you sure you want to delete ${selected.length} participant(s)? This will also delete all associated files.`,
				)
			) {
				try {
					const deleted = await invoke('delete_participants_bulk', {
						participantIds: selected,
					})
					console.log(`Deleted ${deleted} participant(s)`)
					await loadParticipantsView()
					await loadFiles()
				} catch (error) {
					alert(`Error deleting participants: ${error}`)
				}
			}
		})
	}

	const participantsSearchInput = document.getElementById('participants-search')
	if (participantsSearchInput) {
		participantsSearchInput.addEventListener('input', (e) => {
			setParticipantsSearchTerm(e.target.value)
		})
	}

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
			setLastImportView('import')
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
				if (!isFileAlreadyImported(file)) {
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
		toggleSelectAllParticipants(e.target.checked)
	})

	const fileTypeSelect = document.getElementById('file-type-select')
	const customExtension = document.getElementById('custom-extension')
	const customExtInput = document.getElementById('custom-ext-input')
	const customPattern = document.getElementById('custom-pattern')
	const patternInfoBtn = document.getElementById('pattern-info-btn')
	const patternHelp = document.getElementById('pattern-help')

	if (patternInfoBtn && patternHelp) {
		patternInfoBtn.addEventListener('click', () => {
			const expanded = patternInfoBtn.getAttribute('aria-expanded') === 'true'
			const nextState = !expanded
			patternInfoBtn.setAttribute('aria-expanded', nextState)
			patternHelp.classList.toggle('visible', nextState)
		})

		document.addEventListener('click', (event) => {
			if (!patternHelp.classList.contains('visible')) return
			if (event.target === patternInfoBtn || patternHelp.contains(event.target)) {
				return
			}
			patternInfoBtn.setAttribute('aria-expanded', 'false')
			patternHelp.classList.remove('visible')
		})

		document.addEventListener('keydown', (event) => {
			if (event.key !== 'Escape') return
			if (!patternHelp.classList.contains('visible')) return
			patternInfoBtn.setAttribute('aria-expanded', 'false')
			patternHelp.classList.remove('visible')
		})
	}

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
		const value = e.target.value
		if (patternInputDebounce) {
			clearTimeout(patternInputDebounce)
		}
		patternInputDebounce = setTimeout(() => {
			patternInputDebounce = null
			void applyPattern(value)
		}, 300)
	})

	customPattern.addEventListener('blur', (e) => {
		if (patternInputDebounce) {
			clearTimeout(patternInputDebounce)
			patternInputDebounce = null
		}
		void applyPattern(e.target.value)
	})

	customPattern.addEventListener('keydown', (e) => {
		if (e.key === 'Enter') {
			if (patternInputDebounce) {
				clearTimeout(patternInputDebounce)
				patternInputDebounce = null
			}
			void applyPattern(e.target.value)
		}
	})

	const onboarding = initOnboarding({
		invoke,
		checkDependenciesForPanel,
		runHomebrewInstall,
		showProgressTask,
		finishProgressTask,
		setButtonLoading,
		updateButtonLoadingLabel,
		clearButtonLoading,
		copyToClipboard,
		getDependencyResults: () => dependencyResults,
		checkSyftBoxStatus,
	})

	// Run onboarding check on app start
	onboarding.checkOnboarding()
})
