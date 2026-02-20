function isUpdaterDisabledSync() {
	try {
		if (typeof window !== 'undefined' && window.__DISABLE_UPDATER__) return true
		if (typeof process !== 'undefined' && process?.env) {
			const flag = process.env.DISABLE_UPDATER ?? process.env.PLAYWRIGHT_DISABLE_UPDATER
			if (flag && ['1', 'true', 'yes'].includes(flag.toLowerCase())) return true
		}
	} catch (_err) {
		// ignore env inspection errors
	}
	return false
}

async function isUpdaterDisabled() {
	// Check sync flags first
	if (isUpdaterDisabledSync()) return true

	// Check via Tauri backend (for env vars passed to binary)
	try {
		if (typeof window !== 'undefined' && window.__TAURI__?.core?.invoke) {
			const disabled = await window.__TAURI__.core.invoke('is_updater_disabled')
			if (disabled) return true
		}
	} catch (_err) {
		// ignore invoke errors
	}
	return false
}

export function createUpdaterModule() {
	async function checkUpdates(silent = false) {
		if (await isUpdaterDisabled()) {
			if (!silent) {
				console.log('[Updater] Disabled by env/flag, skipping check')
			}
			return
		}

		// Only works in Tauri mode, not browser dev mode
		// Check at runtime, not module load time (for testing)
		const isTauri = typeof window !== 'undefined' && window.__TAURI__
		if (!isTauri) {
			if (!silent) {
				console.log('[Updater] Skipping update check - only available in installed app')
			}
			return
		}

		try {
			console.log('[Updater] Starting update check...')
			console.log('[Updater] Current version:', window.__TAURI_INTERNALS__)
			console.log('[Updater] Configured endpoints: updater-manifests + releases/latest')

			// Use Tauri v2 APIs from window.__TAURI__
			const { check: checkForUpdate } = window.__TAURI__.updater
			const { ask, message } = window.__TAURI__.dialog
			const { relaunch } = window.__TAURI__.process

			console.log('[Updater] Calling checkForUpdate()...')
			const update = await checkForUpdate()
			console.log('[Updater] Update check result:', update)

			if (update) {
				console.log(`Update available: ${update.version}`)

				const yes = await ask(
					`Update to version ${update.version} is available!\n\nRelease notes:\n${update.body}\n\nWould you like to install it now?`,
					{
						title: 'Update Available',
						kind: 'info',
					},
				)

				if (yes) {
					await message('Downloading update...', {
						title: 'Updating',
						kind: 'info',
					})

					let downloaded = 0
					let contentLength = 0

					await update.downloadAndInstall((event) => {
						switch (event.event) {
							case 'Started':
								contentLength = event.data.contentLength
								console.log(`Started downloading ${contentLength} bytes`)
								break
							case 'Progress': {
								downloaded += event.data.chunkLength
								const percent = ((downloaded / contentLength) * 100).toFixed(1)
								console.log(`Downloaded ${downloaded}/${contentLength} (${percent}%)`)
								break
							}
							case 'Finished':
								console.log('Download finished')
								break
						}
					})

					await message('Update installed! The app will restart now.', {
						title: 'Update Complete',
						kind: 'info',
					})

					await relaunch()
				}
			} else if (!silent) {
				console.log('[Updater] No updates available')
				await message('You are running the latest version!', {
					title: 'No Updates',
					kind: 'info',
				})
			} else {
				console.log('[Updater] No updates available (silent check)')
			}
		} catch (error) {
			console.error('[Updater] Failed to check for updates:', error)
			console.error('[Updater] Error type:', typeof error)
			console.error('[Updater] Error message:', error?.message || error?.toString())
			console.error('[Updater] Error stack:', error?.stack)
			if (!silent) {
				// Fallback to console.error if message API not available
				console.error(`[Updater] Showing error to user: ${error}`)
			}
		}
	}

	async function checkUpdatesOnStartup() {
		if (await isUpdaterDisabled()) {
			console.log('[Updater] Startup check disabled by env/flag')
			return
		}
		await checkUpdates(true)
	}

	return {
		checkUpdates,
		checkUpdatesOnStartup,
	}
}
