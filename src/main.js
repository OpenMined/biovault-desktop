import { initOnboarding } from './onboarding.js'
import { createDashboardShell } from './dashboard.js'
import { createParticipantsModule } from './participants.js'
import { createLogsModule } from './logs.js'
import { createRunsModule } from './runs.js'
import { createFilesModule } from './files.js'
import { createProjectsModule } from './projects.js'
import { createMessagesModule } from './messages.js'
import { createImportModule } from './import.js'
import { createProgressUI } from './progress-ui.js'
import { createCltManager } from './clt-manager.js'
import { createHomebrewInstaller } from './homebrew-installer.js'
import { createDependenciesModule } from './dependencies.js'
import { createSettingsModule } from './settings.js'
import { invoke, dialog, event, shell as shellApi, windowApi } from './tauri-shim.js'

const { open } = dialog
const { listen } = event

const {
	showProgressTask,
	finishProgressTask,
	setButtonLoading,
	updateButtonLoadingLabel,
	clearButtonLoading,
} = createProgressUI()

const { startCltMonitor } = createCltManager({ invoke, windowApi })

const { runHomebrewInstall } = createHomebrewInstaller({
	invoke,
	dialog,
	showProgressTask,
	finishProgressTask,
	setButtonLoading,
	updateButtonLoadingLabel,
	clearButtonLoading,
	startCltMonitor,
})

const { loadSavedDependencies, checkDependenciesForPanel, getDependencyResults } =
	createDependenciesModule({ invoke })

const {
	loadSettings,
	checkSyftBoxStatus,
	handleSyftBoxAuthentication,
	getCurrentUserEmail,
	getSyftboxStatus,
	setSyftboxStatus,
} = createSettingsModule({ invoke, dialog, loadSavedDependencies })

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
	getCurrentUserEmail,
	getSyftboxStatus,
	setSyftboxStatus,
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

// Function to load saved dependency states without re-checking

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
		getSyftboxStatus,
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
			const status = getSyftboxStatus()
			if ((target === 'online' && status.running) || (target === 'offline' && !status.running)) {
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
			const depResults = getDependencyResults()
			if (!depResults) return

			const missingDeps = depResults.dependencies.filter(
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
		getDependencyResults,
		checkSyftBoxStatus,
	})

	// Run onboarding check on app start
	onboarding.checkOnboarding()
})
