import { initOnboarding } from './onboarding.js'
import { createDashboardShell } from './dashboard.js'
import { createParticipantsModule } from './participants.js'
import { createLogsModule } from './logs.js'
import { createRunsModule } from './runs.js'
import { createFilesModule } from './files.js'
import { createProjectsModule } from './projects.js'
import { createMessagesModule } from './messages.js'
import { createImportModule } from './import.js'
import { invoke, dialog, event, shell as shellApi, windowApi } from './tauri-shim.js'

const { open } = dialog
const { listen } = event

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

let currentUserEmail = ''
let syftboxStatus = { running: false, mode: 'Direct' }

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

// Create import module with placeholder functions
let importNavigateTo = () => console.warn('navigateTo not yet initialized')
let importSetLastImportView = () => console.warn('setLastImportView not yet initialized')
const importModule = createImportModule({
	invoke,
	open,
	isFileAlreadyImported,
	refreshExistingFilePaths,
	loadParticipantsView,
	loadFiles,
	navigateTo: (...args) => importNavigateTo(...args),
	setLastImportView: (...args) => importSetLastImportView(...args),
})
const {
	pickFolder,
	searchFiles,
	resetImportState,
	goToReviewStep,
	detectFileTypes,
	finalizeImport,
	setSortField,
	initColumnResizers,
	setReviewSortField,
	updateSelectedFileCount,
	handleSelectAllFiles,
	handleSelectAllReview,
	handleBulkDataTypeChange,
	handleBulkSourceChange,
	handleBulkGrchVersionChange,
	handleCustomPatternInput,
	handleCustomPatternBlur,
	handleCustomPatternKeydown,
	copyToClipboard,
	getIsImportInProgress,
} = importModule

const { navigateTo, registerNavigationHandlers, getActiveView, setLastImportView } =
	createDashboardShell({
		getIsImportInProgress,
		setIsImportInProgress: () => {
			console.warn(
				'setIsImportInProgress is no longer supported - import state is internal to import module',
			)
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

// Now set the real functions for module placeholders
projectsNavigateTo = navigateTo
messagesGetActiveView = getActiveView
importNavigateTo = navigateTo
importSetLastImportView = setLastImportView

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
		handleBulkDataTypeChange(e.target.value)
		e.target.value = ''
	})

	document.getElementById('set-all-source').addEventListener('change', (e) => {
		handleBulkSourceChange(e.target.value)
		e.target.value = ''
	})

	document.getElementById('set-all-grch').addEventListener('change', (e) => {
		handleBulkGrchVersionChange(e.target.value)
		e.target.value = ''
	})

	// Select all checkbox in review view
	document.getElementById('select-all-review').addEventListener('change', (e) => {
		handleSelectAllReview(e.target.checked)
	})

	// Sortable headers in review view
	document.querySelectorAll('#import-review-view .sortable-header').forEach((header) => {
		header.addEventListener('click', () => {
			const field = header.dataset.sortField
			setReviewSortField(field)
		})
	})

	document.getElementById('select-all-files').addEventListener('change', (e) => {
		handleSelectAllFiles(e.target.checked)
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
		handleCustomPatternInput(e.target.value)
	})

	customPattern.addEventListener('blur', (e) => {
		handleCustomPatternBlur(e.target.value)
	})

	customPattern.addEventListener('keydown', (e) => {
		if (e.key === 'Enter') {
			handleCustomPatternKeydown(e.key, e.target.value)
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
