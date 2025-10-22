export function createDashboardShell({
	documentRef = typeof document !== 'undefined' ? document : null,
	getIsImportInProgress,
	setIsImportInProgress,
	loadParticipants,
	loadFiles,
	loadProjects,
	prepareRunView,
	loadRuns,
	displayLogs,
	loadSettings,
	loadSql,
	initializeMessagesTab,
	getMessagesInitialized,
	getMessagesAuthorized,
	getSyftboxStatus,
	startMessagesAutoRefresh,
	stopMessagesAutoRefresh,
}) {
	let activeView = 'home'
	let lastImportView = 'import'
	const importSubViews = ['import', 'import-review', 'import-results']

	function navigateTo(requestedView) {
		if (!requestedView) return

		let targetView = requestedView

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
			content.style.display = 'none'
		})

		const targetElement = doc.getElementById(`${targetView}-view`)
		if (!targetElement) {
			console.warn(`navigateTo: Unknown view "${targetView}"`)
			return
		}

		targetElement.classList.add('active')
		targetElement.style.display = ''
		activeView = targetView

		const highlightTabName = importSubViews.includes(targetView) ? 'import' : targetView
		const tab = doc.querySelector(`.tab[data-tab="${highlightTabName}"]`)
		if (tab) {
			doc.querySelectorAll('.tab').forEach((t) => t.classList.remove('active'))
			tab.classList.add('active')
		}

		if (importSubViews.includes(targetView)) {
			lastImportView = targetView
		}

		switch (targetView) {
			case 'participants':
				loadParticipants?.()
				break
			case 'files':
				loadFiles?.()
				break
			case 'projects':
				loadProjects?.()
				break
			case 'run':
				prepareRunView?.()
				break
			case 'runs':
				loadRuns?.()
				break
			case 'logs':
				displayLogs?.()
				break
			case 'settings':
				loadSettings?.()
				break
			case 'sql':
				loadSql?.()
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
		doc.querySelectorAll('.home-btn').forEach((btn) => {
			btn.addEventListener('click', () => {
				navigateTo(btn.dataset.nav)
			})
		})

		doc.querySelectorAll('.tab').forEach((tab) => {
			tab.addEventListener('click', () => {
				navigateTo(tab.dataset.tab)
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
