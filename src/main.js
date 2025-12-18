import { templateLoader } from './template-loader.js'
import { initOnboarding } from './onboarding.js'
import { createDashboardShell } from './dashboard.js'
import { createDataModule } from './data.js'
import { createLogsModule } from './logs.js'
import { createRunsModule } from './runs.js'
import { createProjectsModule } from './projects.js'
import { createPipelinesModule } from './pipelines.js'
import { createMessagesModule } from './messages.js'
import { createImportModule } from './import.js'
import { createProgressUI } from './progress-ui.js'
import { createCltManager } from './clt-manager.js'
import { createHomebrewInstaller } from './homebrew-installer.js'
import { createDependenciesModule } from './dependencies.js'
import { createSettingsModule } from './settings.js'
import { createSqlModule } from './sql.js'
import { createSessionsModule } from './sessions.js'
import { createUpdaterModule } from './updater.js'
import { createNetworkModule } from './network.js'
import { setupEventHandlers } from './event-handlers.js'
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

const { initializeSqlTab, activateSqlTab, invalidateAiConfig } = createSqlModule({ invoke, dialog })

// Sessions module placeholder - will be fully initialized after getCurrentUserEmail is available
let sessionsModule = null

const { checkUpdates, checkUpdatesOnStartup } = createUpdaterModule()

const {
	loadSettings,
	checkSyftBoxStatus,
	handleSyftBoxAuthentication,
	getCurrentUserEmail,
	getSyftboxStatus,
	setSyftboxStatus,
	saveSettings,
} = createSettingsModule({
	invoke,
	dialog,
	loadSavedDependencies,
	onAiConfigUpdated: invalidateAiConfig,
})

const {
	loadData,
	initializeDataTab,
	refreshExistingFilePaths,
	isFileAlreadyImported,
	getSelectedParticipants,
	clearAllSelections,
} = createDataModule({ invoke, dialog, getCurrentUserEmail })

const { refreshLogs, displayLogs, setLogsAutoRefreshEnabled, clearLogs, copyLogs, openLogsFolder } =
	createLogsModule({
		invoke,
	})

const {
	prepareRunView,
	loadRuns,
	runAnalysis,
	toggleSelectAllParticipants,
	shareCurrentRunLogs,
	setNavigateTo: setRunNavigateTo,
} = createRunsModule({ invoke, listen, dialog, refreshLogs })

// Create projects module early with placeholder navigateTo
let projectsNavigateTo = () => console.warn('navigateTo not yet initialized')
let pipelineModule_addProjectAsStep = null // Will be set after pipelines module is created

const projectsModule = createProjectsModule({
	invoke,
	dialog,
	open,
	shellApi,
	addProjectAsPipelineStep: (projectPath, projectName) => {
		// Delegate to pipelines module
		if (pipelineModule_addProjectAsStep) {
			return pipelineModule_addProjectAsStep(projectPath, projectName)
		}
	},
	navigateTo: (...args) => projectsNavigateTo(...args),
})

// Destructure projects module exports
const {
	loadProjects,
	importProject,
	importProjectFromFolder,
	showCreateProjectModal,
	openProjectEditor,
	hideCreateProjectModal,
	handleProjectNameInputChange,
	chooseProjectDirectory,
	resetProjectDirectory,
	createProjectFromModal,
	handleCreateWizardNext,
	handleCreateWizardBack,
	handleWizardStepClick,
	handleSaveProjectEditor,
	handleLaunchJupyter,
	handleResetJupyter,
	handleOpenProjectFolder,
	handleLeaveProjectEditor,
	handleReloadProjectSpec,
} = projectsModule

// Create pipelines module AFTER destructuring projectsModule
const pipelinesModule = createPipelinesModule({
	invoke,
	dialog,
	open,
	navigateTo: (...args) => projectsNavigateTo(...args),
	showCreateProjectModal,
	openProjectEditor,
})

// Wire up the callback so projects can add steps to pipelines
pipelineModule_addProjectAsStep = pipelinesModule.addProjectAsStep

// Expose pipelines module for data.js to call openRunPipelineWithDataset
window.__pipelinesModule = pipelinesModule

// Create messages module early with placeholder getActiveView
let messagesGetActiveView = () => 'projects'
const messagesModule = createMessagesModule({
	invoke,
	getCurrentUserEmail,
	getSyftboxStatus,
	setSyftboxStatus,
	listen,
	getActiveView: () => messagesGetActiveView(),
	dialog,
})
const {
	initializeMessagesTab,
	loadMessageThreads,
	startMessagesAutoRefresh,
	stopMessagesAutoRefresh,
	sendCurrentMessage,
	setSyftboxTarget,
	handleDeleteThread,
	ensureMessagesAuthorizationAndStartNew,
	updateComposeVisibilityPublic,
	resetActiveThread,
	setActiveMessageFilterButton,
	getMessagesInitialized,
	getMessagesAuthorized,
	showInviteOptions: showMessagesInviteOptions,
} = messagesModule

// Expose messages module globally for test actions (e.g., notification test button wiring)
window.__messagesModule = messagesModule
window.__messagesTriggerTest__ = () => {
	try {
		console.log('[Messages] Test notification button clicked')
		if (messagesModule?.triggerTestNotification) {
			messagesModule.triggerTestNotification()
		} else {
			console.warn('[Messages] triggerTestNotification not available')
		}
	} catch (err) {
		console.warn('[Messages] Test notification trigger failed', err)
	}
}

// Create sessions module with getCurrentUserEmail
sessionsModule = createSessionsModule({
	invoke,
	dialog,
	getCurrentUserEmail,
	listen,
	getMessagesModule: () => messagesModule,
})
const {
	initializeSessionsTab,
	activateSessionsTab,
	deactivateSessionsTab,
	showInviteOptions: showSessionsInviteOptions,
} = sessionsModule

// Create network module
const networkModule = createNetworkModule({ invoke, shellApi })

// Create import module with placeholder functions
let importNavigateTo = () => console.warn('navigateTo not yet initialized')
let importSetLastImportView = () => console.warn('setLastImportView not yet initialized')
const importModule = createImportModule({
	invoke,
	open,
	dialog,
	isFileAlreadyImported,
	refreshExistingFilePaths,
	loadParticipantsView: loadData,
	loadFiles: loadData,
	navigateTo: (...args) => importNavigateTo(...args),
	setLastImportView: (...args) => importSetLastImportView(...args),
})
const {
	openImportModal,
	closeImportModal,
	backToSelection,
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
	handleCustomPatternFocus,
	copyToClipboard,
	assignRandomIds,
	updatePatternSuggestions,
	toggleMissingIdsFilter,
	jumpToNextMissingId,
	toggleIncompleteReviewFilter,
	jumpToNextIncompleteReview,
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
		loadParticipants: loadData,
		loadFiles: loadData,
		loadProjects,
		loadPipelines: pipelinesModule.loadPipelines,
		prepareRunView,
		loadRuns,
		refreshLogs,
		setLogsAutoRefreshEnabled,
		loadSettings,
		initializeMessagesTab,
		getMessagesInitialized,
		getMessagesAuthorized,
		getSyftboxStatus,
		startMessagesAutoRefresh,
		stopMessagesAutoRefresh,
		loadSql: activateSqlTab,
		activateSessionsTab,
		deactivateSessionsTab,
	})

setRunNavigateTo(navigateTo)

// Make navigateTo available globally for data module
window.navigateTo = navigateTo
// Expose clearAllSelections globally for pipelines module
window.clearAllDataSelections = clearAllSelections

// Expose readiness markers for automated tests
window.__NAV_HANDLERS_READY__ = false
window.__EVENT_HANDLERS_READY__ = false
window.__ONBOARDING_CHECK_COMPLETE__ = false

async function checkKeyFingerprintMismatchOnStartup() {
	try {
		const email = await getCurrentUserEmail()
		if (!email) return

		const status = await invoke('key_get_status', { email })
		if (status && status.exists && status.export_fingerprint && status.export_matches === false) {
			const message = [
				'Your local vault key differs from the key in your published DID (did.json).',
				`Local fingerprint: ${status.vault_fingerprint || 'unknown'}`,
				`Published fingerprint: ${status.export_fingerprint}`,
				'Open Settings to recover the old key or re-publish your current DID?',
			].join('\n')

			const openSettings = await dialog.confirm(message, {
				title: 'Key mismatch detected',
				type: 'warning',
			})
			if (openSettings) {
				navigateTo('settings')
			}
		}
	} catch (error) {
		console.warn('⚠️ Key mismatch check failed:', error)
	}
}

// Now set the real functions for module placeholders
projectsNavigateTo = navigateTo
messagesGetActiveView = getActiveView
importNavigateTo = navigateTo
importSetLastImportView = setLastImportView

window.addEventListener('DOMContentLoaded', async () => {
	console.log('🔥 DOMContentLoaded fired')

	try {
		const dbPath = await invoke('get_database_path')
		console.log('🗃️ BioVault database path:', dbPath)
	} catch (error) {
		console.warn('⚠️ Failed to fetch BioVault database path:', error)
	}

	// Load HTML templates for all views
	try {
		await Promise.all([
			templateLoader.loadAndInject('onboarding', 'onboarding-view'),
			// projects template is now merged into run template (Pipelines tab)
			templateLoader.loadAndInject('project-edit', 'project-edit-view'),
			templateLoader.loadAndInject('run', 'run-view'),
			// import-review is now inside the import modal, no longer a separate view
			templateLoader.loadAndInject('import-results', 'import-results-view'),
			templateLoader.loadAndInject('data', 'data-view'),
			// Load all templates into their direct tabs
			templateLoader.loadAndInject('sql', 'sql-view'),
			templateLoader.loadAndInject('sessions', 'sessions-view'),
			templateLoader.loadAndInject('runs', 'runs-view'),
			templateLoader.loadAndInject('messages', 'messages-view'),
			templateLoader.loadAndInject('network', 'network-view'),
			templateLoader.loadAndInject('logs', 'logs-view'),
			templateLoader.loadAndInject('settings', 'settings-view'),
		])

		// Load import modal separately and append to body
		const importModalHtml = await templateLoader.load('import')
		document.body.insertAdjacentHTML('beforeend', importModalHtml)

		// Initialize drag-and-drop for folder selection (async now)
		await importModule.initFolderDropzone()

		await initializeSqlTab()

		// Initialize Logs and SQL tabs (now direct tabs, not workbench)
		displayLogs()
		activateSqlTab()

		console.log('✅ All templates loaded')
	} catch (error) {
		console.error('❌ Failed to load templates:', error)
	}

	// Initialize onboarding early to check status
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

	// Check onboarding status first - if not onboarded, skip loading data
	const isOnboarded = await invoke('check_is_onboarded')
	console.log('🎯 Main.js onboarding check:', isOnboarded, 'type:', typeof isOnboarded)

	if (isOnboarded) {
		console.log('📊 User is onboarded, loading data...')
		// Load initial data only if user is onboarded
		refreshExistingFilePaths()
		loadData()
		loadProjects()
		refreshLogs({ force: true })
		await loadSettings()
		await checkKeyFingerprintMismatchOnStartup()
		updateSelectedFileCount()
	} else {
		console.log('🚀 User NOT onboarded, will show onboarding screen...')
	}

	// Initialize UI features
	initColumnResizers()
	registerNavigationHandlers()
	window.__NAV_HANDLERS_READY__ = true
	initializeDataTab()
	pipelinesModule.initialize()
	initializeSessionsTab()
	networkModule.init()

	// Setup sidebar invite button
	const sidebarInviteBtn = document.getElementById('sidebar-invite-btn')
	if (sidebarInviteBtn) {
		sidebarInviteBtn.addEventListener('click', () => showSessionsInviteOptions('session'))
	}

	// Listen for navigation events from other modules (e.g., messages wanting to go to network tab)
	window.addEventListener('navigate-to-tab', (event) => {
		const tab = event.detail?.tab
		if (tab) {
			navigateTo(tab)
		}
	})

	// Setup all event handlers
	setupEventHandlers({
		navigateTo,
		setLastImportView,
		openImportModal,
		closeImportModal,
		backToSelection,
		pickFolder,
		searchFiles,
		resetImportState,
		goToReviewStep,
		detectFileTypes,
		finalizeImport,
		setSortField,
		setReviewSortField,
		handleSelectAllFiles,
		handleSelectAllReview,
		handleBulkDataTypeChange,
		handleBulkSourceChange,
		handleBulkGrchVersionChange,
		handleCustomPatternInput,
		handleCustomPatternBlur,
		handleCustomPatternKeydown,
		handleCustomPatternFocus,
		updatePatternSuggestions,
		assignRandomIds,
		toggleMissingIdsFilter,
		jumpToNextMissingId,
		toggleIncompleteReviewFilter,
		jumpToNextIncompleteReview,
		loadMessageThreads,
		sendCurrentMessage,
		resetActiveThread,
		setActiveMessageFilterButton,
		ensureMessagesAuthorizationAndStartNew,
		handleDeleteThread,
		setSyftboxTarget,
		getSyftboxStatus,
		showMessagesInviteOptions,
		showCreateProjectModal,
		hideCreateProjectModal,
		createProjectFromModal,
		handleCreateWizardNext,
		handleCreateWizardBack,
		handleWizardStepClick,
		handleProjectNameInputChange,
		chooseProjectDirectory,
		resetProjectDirectory,
		importProject,
		importProjectFromFolder,
		handleSaveProjectEditor,
		handleLaunchJupyter,
		handleResetJupyter,
		handleOpenProjectFolder,
		handleLeaveProjectEditor,
		handleReloadProjectSpec,
		runAnalysis,
		shareCurrentRunLogs,
		toggleSelectAllParticipants,
		copyLogs,
		clearLogs,
		openLogsFolder,
		handleSyftBoxAuthentication,
		saveSettings,
		checkDependenciesForPanel,
		getDependencyResults,
		checkUpdates,
		invoke,
		dialog,
		checkSyftBoxStatus,
		getSelectedParticipants,
		loadData,
		initializeMessagesTab,
		updateComposeVisibilityPublic,
	})
	window.__EVENT_HANDLERS_READY__ = true

	// Show onboarding view if user is not onboarded
	try {
		await onboarding.checkOnboarding()
	} finally {
		window.__ONBOARDING_CHECK_COMPLETE__ = true
	}

	// Check for updates after app initialization (silent check)
	setTimeout(() => {
		checkUpdatesOnStartup().catch((err) => {
			console.warn('Update check failed:', err)
		})
	}, 3000) // Delay 3s to avoid blocking startup

	// Listen for deep link events (biovault://...)
	listen('deep-link', (event) => {
		console.log('🔗 Deep link received:', event.payload)
		handleDeepLink(event.payload)
	})
})

// Handle deep link URLs
function handleDeepLink(url) {
	try {
		const parsed = new URL(url)
		console.log('🔗 Parsing deep link:', parsed)

		// Handle biovault://invite?from=...&fp=...&type=...
		if (parsed.pathname === 'invite' || parsed.pathname === '/invite' || parsed.host === 'invite') {
			const from = parsed.searchParams.get('from')
			const fingerprint = parsed.searchParams.get('fp')
			const type = parsed.searchParams.get('type') || 'session'

			console.log('🔗 Invite deep link:', { from, fingerprint, type })

			// Show a dialog with the invite info
			dialog.message(
				`You received an invite from:\n${from || 'Unknown'}\n\nType: ${type}\n\nTo connect, add them as a contact in the Network tab.`,
				{ title: 'BioVault Invite', kind: 'info' },
			)

			// Could also automatically navigate to Network tab or pre-fill contact
		}
	} catch (e) {
		console.error('Failed to parse deep link:', e)
	}
}
