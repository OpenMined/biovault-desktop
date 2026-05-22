export function createDependenciesModule({ invoke }) {
	let dependencyResults = null
	const DEPENDENCY_CHECK_TIMEOUT_MS = 70000

	function withTimeout(promise, timeoutMs, errorMessage) {
		let timeoutId
		const timeoutPromise = new Promise((_, reject) => {
			timeoutId = setTimeout(() => reject(new Error(errorMessage)), timeoutMs)
		})

		return Promise.race([promise, timeoutPromise]).finally(() => clearTimeout(timeoutId))
	}

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
			<p style="margin-bottom: 10px;">Checking dependencies...</p>
			<p style="font-size: 11px; color: #aaa; line-height: 1.6; max-width: 280px; margin: 0 auto;">
				Searching system PATH, checking installed versions,<br/>
				and verifying running services
			</p>
		</div>
	`

		try {
			console.info('[dependencies] check_dependencies started')
			const started = Date.now()
			const result = await withTimeout(
				invoke('check_dependencies'),
				DEPENDENCY_CHECK_TIMEOUT_MS,
				`Dependency check timed out after ${Math.round(
					DEPENDENCY_CHECK_TIMEOUT_MS / 1000,
				)} seconds. A system command such as Docker, Java, Nextflow, SyftBox, Syqure, or uv did not return.`,
			)
			console.info(
				`[dependencies] check_dependencies finished in ${Date.now() - started}ms`,
				result,
			)
			dependencyResults = result
			if (typeof window.displayDependencies === 'function') {
				window.displayDependencies(result, listPanelId, detailsPanelId, isSettings)
			}
		} catch (error) {
			console.error('Failed to check dependencies:', error)
			const message = error?.message || String(error)
			depsList.innerHTML = `
			<div style="color: #dc3545; padding: 20px; text-align: center;">
				<p>Failed to check dependencies</p>
				<p style="font-size: 12px; margin-top: 10px; line-height: 1.5;">${message}</p>
				<p style="font-size: 11px; margin-top: 10px; color: #777;">Open Logs or DevTools for the full command output.</p>
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
