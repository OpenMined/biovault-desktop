export function createDashboardShell({
	documentRef = typeof document !== 'undefined' ? document : null,
	getIsImportInProgress,
	setIsImportInProgress,
	loadParticipants,
	_loadFiles,
	loadProjects,
	loadPipelines,
	loadRuns,
	displayLogs,
	setLogsAutoRefreshEnabled,
	loadSettings,
	loadSql,
	initializeMessagesTab,
	getMessagesInitialized,
	getMessagesAuthorized,
	getSyftboxStatus,
	startMessagesAutoRefresh,
	stopMessagesAutoRefresh,
}) {
	let activeView = 'run'
	let lastImportView = 'import'
	const importSubViews = ['import', 'import-review', 'import-results']

	function navigateTo(requestedView) {
		if (!requestedView) return

		let targetView = requestedView

		// Redirect old 'projects' tab to 'run' (since they're now merged)
		if (requestedView === 'projects') {
			targetView = 'run'
		}

		if (requestedView === 'import' && lastImportView !== 'import') {
			targetView = lastImportView
		}

		if (getIsImportInProgress?.() && targetView !== 'import-review') {
			const confirmed = confirm(
				'Import is currently in progress. Are you sure you want to cancel and leave this page?',
			)
			if (!confirmed) {
				return
			}
			setIsImportInProgress?.(false)
		}

		const doc = documentRef || document
		const tabContents = doc.querySelectorAll('.tab-content')
		tabContents.forEach((content) => {
			content.classList.remove('active')
		})

		const targetElement = doc.getElementById(`${targetView}-view`)
		if (!targetElement) {
			console.warn(`navigateTo: Unknown view "${targetView}"`)
			return
		}

		targetElement.classList.add('active')
		activeView = targetView

		const isLogsView = targetView === 'logs'
		setLogsAutoRefreshEnabled?.(isLogsView)

		// Update active state in sidebar navigation
		const highlightTabName = importSubViews.includes(targetView) ? 'import' : targetView

		// Update sidebar nav items (includes both main nav and footer items)
		doc.querySelectorAll('.nav-item').forEach((item) => item.classList.remove('active'))
		const navItem = doc.querySelector(`.nav-item[data-tab="${highlightTabName}"]`)
		if (navItem) {
			navItem.classList.add('active')
		}

		if (importSubViews.includes(targetView)) {
			lastImportView = targetView
		}

		switch (targetView) {
			case 'data':
				loadParticipants?.() // loadParticipants is actually loadData now
				break
			case 'run':
				// Load projects and pipelines (which includes both pipelines and projects sections)
				loadProjects?.()
				loadPipelines?.()
				break
			case 'runs':
				loadRuns?.()
				break
			case 'logs':
				displayLogs?.({ force: true })
				break
			case 'sql':
				loadSql?.()
				break
			case 'settings':
				loadSettings?.()
				break
			case 'messages': {
				const initialized = getMessagesInitialized?.()
				initializeMessagesTab?.(!initialized)
				if (getMessagesAuthorized?.() && getSyftboxStatus?.()?.running) {
					startMessagesAutoRefresh?.(true)
				}
				break
			}
			default:
				break
		}

		if (targetView !== 'messages') {
			stopMessagesAutoRefresh?.()
		}
	}

	function registerNavigationHandlers() {
		const doc = documentRef || document

		// Sidebar navigation items (includes both main nav and footer items)
		doc.querySelectorAll('.nav-item').forEach((item) => {
			item.addEventListener('click', () => {
				navigateTo(item.dataset.tab)
			})
		})
	}

	return {
		navigateTo,
		registerNavigationHandlers,
		getActiveView: () => activeView,
		getLastImportView: () => lastImportView,
		setLastImportView: (view) => {
			if (view) {
				lastImportView = view
			}
		},
	}
}
