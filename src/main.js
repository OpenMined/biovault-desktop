import { templateLoader } from './template-loader.js'
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
import { createSqlModule } from './sql.js'
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
	createFilesModule({ invoke, dialog })

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
		loadSql: activateSqlTab,
	})

setRunNavigateTo(navigateTo)

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
			templateLoader.loadAndInject('participants', 'participants-view'),
			templateLoader.loadAndInject('files', 'files-view'),
			templateLoader.loadAndInject('sql', 'sql-view'),
			templateLoader.loadAndInject('runs', 'runs-view'),
			templateLoader.loadAndInject('messages', 'messages-view'),
			templateLoader.loadAndInject('logs', 'logs-view'),
			templateLoader.loadAndInject('settings', 'settings-view'),
		])

		// Load import modal separately and append to body
		const importModalHtml = await templateLoader.load('import')
		document.body.insertAdjacentHTML('beforeend', importModalHtml)

		// Initialize drag-and-drop for folder selection (async now)
		await importModule.initFolderDropzone()

		await initializeSqlTab()

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
		loadParticipantsView()
		loadFiles()
		loadProjects()
		loadCommandLogs()
		loadSettings()
		updateSelectedFileCount()
	}

	// Initialize UI features
	initColumnResizers()
	registerNavigationHandlers()
	initializeFilesTab()

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
		invoke,
		dialog,
		getSelectedParticipants,
		handleParticipantsSelectAll,
		loadParticipantsView,
		setParticipantsSearchTerm,
		loadFiles,
		initializeMessagesTab,
		updateComposeVisibilityPublic,
	})

	// Show onboarding view if user is not onboarded
	await onboarding.checkOnboarding()
})
