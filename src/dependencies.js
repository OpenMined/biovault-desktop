export function createDependenciesModule({ invoke }) {
	let dependencyResults = null

	async function loadSavedDependencies(listPanelId, detailsPanelId) {
		const depsList = document.getElementById(listPanelId)
		if (!depsList) return

		try {
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

	function getDependencyResults() {
		return dependencyResults
	}

	return {
		loadSavedDependencies,
		checkDependenciesForPanel,
		getDependencyResults,
	}
}
