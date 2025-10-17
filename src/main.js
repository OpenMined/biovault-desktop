import { initOnboarding } from './onboarding.js'
import { createDashboardShell } from './dashboard.js'

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
let cltWaitState = {
	overlay: null,
	intervalId: null,
	active: false,
	onComplete: null,
	onCancel: null,
	windowState: null,
}

function getAppWindow() {
	const api = window.__TAURI__?.window
	if (!api) return null
	if (typeof api.getCurrent === 'function') {
		return api.getCurrent()
	}
	return api.appWindow || null
}

async function adjustWindowForCltPrompt() {
	const appWindow = getAppWindow()
	if (!appWindow) return
	if (cltWaitState.windowState) return

	try {
		const [size, position] = await Promise.all([appWindow.innerSize(), appWindow.outerPosition()])

		cltWaitState.windowState = { size, position }

		const winApi = window.__TAURI__?.window || {}
		const logicalSizeCtor = winApi.LogicalSize
		const logicalPositionCtor = winApi.LogicalPosition

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
		const winApi = window.__TAURI__?.window || {}
		const logicalSizeCtor = winApi.LogicalSize
		const logicalPositionCtor = winApi.LogicalPosition

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
			await window.__TAURI__.dialog.message(
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
		await window.__TAURI__.dialog.message(
			`Failed to install Homebrew: ${errorMessage}\n\nPlease install Homebrew manually from brew.sh`,
			{ title: 'Installation Failed', type: 'error' },
		)
	}
}

let autoParticipantIds = {} // Auto-extracted IDs for the current pattern
let patternInputDebounce = null
let messageThreads = []
let messageFilter = 'inbox'
let activeThreadId = null
let messageReplyTargetId = null
let isComposingNewMessage = false
let messagesAuthorized = false
let currentUserEmail = ''
let syftboxStatus = { running: false, mode: 'Direct' }
let messagesInitialized = false
let messagesRefreshInterval = null
let messagesRefreshInProgress = false

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
	const activePattern = currentPattern ? currentPattern.trim() : ''

	sortedFiles.forEach((file) => {
		const li = document.createElement('li')
		const alreadyImported = existingFilePaths.has(file)
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
		hasSelection &&
		selectedFilesArray.every((file) => {
			const manual = fileParticipantIds[file]
			const auto = autoParticipantIds[file]
			const value = manual || auto
			return value !== undefined && value !== null && `${value}`.trim() !== ''
		})

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

function prepareRunView() {
	selectedParticipants = []
	selectedProject = null
	const selectAll = document.getElementById('select-all-participants')
	if (selectAll) {
		selectAll.checked = false
	}
	loadRunParticipants()
	loadRunProjects()
	updateRunButton()
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
	} else if (syftboxStatus.running && getActiveView() === 'messages') {
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

	if (messagesAuthorized && syftboxStatus.running && getActiveView() === 'messages') {
		startMessagesAutoRefresh()
	} else if (!syftboxStatus.running) {
		stopMessagesAutoRefresh()
	}
}

function startMessagesAutoRefresh(immediate = false) {
	if (messagesRefreshInterval) return
	if (!messagesAuthorized) return
	if (getActiveView() !== 'messages') return

	messagesRefreshInterval = setInterval(() => {
		if (getActiveView() !== 'messages') return
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

async function openThread(threadId, _options = {}) {
	if (!messagesAuthorized) return

	activeThreadId = threadId
	isComposingNewMessage = false
	updateComposeVisibility(false)
	updateMessagesEmptyState()

	try {
		const messages = await invoke('get_thread_messages', { threadId })
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
		loadParticipants,
		loadFiles,
		loadProjects,
		prepareRunView,
		loadRuns,
		displayLogs,
		loadSettings,
		initializeMessagesTab,
		getMessagesInitialized: () => messagesInitialized,
		getMessagesAuthorized: () => messagesAuthorized,
		getSyftboxStatus: () => syftboxStatus,
		startMessagesAutoRefresh,
		stopMessagesAutoRefresh,
	})

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

	registerNavigationHandlers()

	const messageFilterButtons = document.querySelectorAll('.message-filter')
	messageFilterButtons.forEach((btn) => {
		btn.addEventListener('click', () => {
			if (btn.classList.contains('active')) return
			setActiveMessageFilterButton(btn.dataset.filter)
			activeThreadId = null
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
				const deleted = await invoke('delete_files_bulk', { file_ids: selectedFilesForDelete })
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
