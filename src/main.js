import { templateLoader } from './template-loader.js'
import { initOnboarding } from './onboarding.js'
import { createDashboardShell } from './dashboard.js'
import { createDataModule } from './data.js'
import { createLogsModule } from './logs.js'
import { createRunsModule } from './runs.js'
import { createProjectsModule } from './projects.js'
import { createMessagesModule } from './messages.js'
import { createImportModule } from './import.js'
import { createProgressUI } from './progress-ui.js'
import { createCltManager } from './clt-manager.js'
import { createHomebrewInstaller } from './homebrew-installer.js'
import { createDependenciesModule } from './dependencies.js'
import { createSettingsModule } from './settings.js'
import { createSqlModule } from './sql.js'
import { createUpdaterModule } from './updater.js'
import { createWorkbench } from './workbench.js'
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
} = createDataModule({ invoke, dialog })

const {
	prepareRunView,
	loadRuns,
	runAnalysis,
	toggleSelectAllParticipants,
	shareCurrentRunLogs,
	setNavigateTo: setRunNavigateTo,
} = createRunsModule({ invoke, listen })

const { loadCommandLogs, displayLogs, clearLogs, copyLogs } = createLogsModule({ invoke })

// Create workbench (will be initialized after templates load)
let workbench = null

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
		loadParticipants: loadData,
		loadFiles: loadData,
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
		loadSql: activateSqlTab,
		getWorkbench: () => workbench,
	})

setRunNavigateTo(navigateTo)

// Make navigateTo available globally for data module
window.navigateTo = navigateTo

// Now set the real functions for module placeholders
projectsNavigateTo = navigateTo
messagesGetActiveView = getActiveView
importNavigateTo = navigateTo
importSetLastImportView = setLastImportView

window.addEventListener('DOMContentLoaded', async () => {
	console.log('🔥 DOMContentLoaded fired')

	// Load HTML templates for all views
	try {
		await Promise.all([
			templateLoader.loadAndInject('onboarding', 'onboarding-view'),
			templateLoader.loadAndInject('home', 'home-view'),
			templateLoader.loadAndInject('projects', 'projects-view'),
			templateLoader.loadAndInject('project-edit', 'project-edit-view'),
			templateLoader.loadAndInject('run', 'run-view'),
			// import-review is now inside the import modal, no longer a separate view
			templateLoader.loadAndInject('import-results', 'import-results-view'),
			templateLoader.loadAndInject('data', 'data-view'),
			// SQL and Logs now load into workbench panels
			templateLoader.loadAndInject('sql', 'workbench-sql-panel'),
			templateLoader.loadAndInject('runs', 'runs-view'),
			templateLoader.loadAndInject('messages', 'messages-view'),
			templateLoader.loadAndInject('logs', 'workbench-logs-panel'),
			templateLoader.loadAndInject('settings', 'settings-view'),
		])

		// Load import modal separately and append to body
		const importModalHtml = await templateLoader.load('import')
		document.body.insertAdjacentHTML('beforeend', importModalHtml)

		// Initialize drag-and-drop for folder selection (async now)
		await importModule.initFolderDropzone()

		await initializeSqlTab()

		// Initialize workbench
		workbench = createWorkbench({
			loadSql: activateSqlTab,
			displayLogs: displayLogs,
		})
		workbench.init()

		// Make workbench globally accessible
		window.workbench = workbench

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

	if (isOnboarded) {
		// Load initial data only if user is onboarded
		refreshExistingFilePaths()
		loadData()
		loadProjects()
		loadCommandLogs()
		loadSettings()
		updateSelectedFileCount()
	}

	// Initialize UI features
	initColumnResizers()
	registerNavigationHandlers()
	initializeDataTab()

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
		loadMessageThreads,
		sendCurrentMessage,
		setActiveMessageFilterButton,
		resetActiveThread,
		ensureMessagesAuthorizationAndStartNew,
		handleDeleteThread,
		setSyftboxTarget,
		getMessageFilter,
		getSyftboxStatus,
		showCreateProjectModal,
		hideCreateProjectModal,
		createProjectFromModal,
		handleProjectNameInputChange,
		chooseProjectDirectory,
		resetProjectDirectory,
		importProject,
		handleSaveProjectEditor,
		handleLaunchJupyter,
		handleResetJupyter,
		runAnalysis,
		shareCurrentRunLogs,
		toggleSelectAllParticipants,
		copyLogs,
		clearLogs,
		handleSyftBoxAuthentication,
		saveSettings,
		checkDependenciesForPanel,
		getDependencyResults,
		checkUpdates,
		invoke,
		dialog,
		getSelectedParticipants,
		loadData,
		initializeMessagesTab,
		updateComposeVisibilityPublic,
	})

	// Show onboarding view if user is not onboarded
	await onboarding.checkOnboarding()

	// Check for updates after app initialization (silent check)
	setTimeout(() => {
		checkUpdatesOnStartup().catch((err) => {
			console.warn('Update check failed:', err)
		})
	}, 3000) // Delay 3s to avoid blocking startup
})
