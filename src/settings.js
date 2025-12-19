export function createSettingsModule({ invoke, dialog, loadSavedDependencies, onAiConfigUpdated }) {
	let currentUserEmail = ''
	let savedEmail = '' // The email that's actually saved in settings
	// Default to online so the messages page starts in connected mode until we learn the real status.
	let syftboxStatus = { running: true, mode: 'Online' }
	let currentSettings = null
	let defaultSyftboxServerUrl = ''
	let defaultServerPromise = null
	let keyStatus = null
	let vaultPath = ''
	let syftboxQueueTimer = null
	let syftboxStatusTimer = null
	let lastIndicatorTotals = { url: null, txTotal: null, rxTotal: null }
	let lastRuntimeTotals = { url: null, httpTx: null, httpRx: null, wsTx: null, wsRx: null }

	async function getDefaultServer() {
		if (defaultServerPromise) return defaultServerPromise
		defaultServerPromise = invoke('get_default_syftbox_server_url')
			.then((val) => {
				if (typeof val === 'string' && val.trim()) {
					defaultSyftboxServerUrl = val.trim()
				}
				return defaultSyftboxServerUrl
			})
			.catch(() => defaultSyftboxServerUrl)
		return defaultServerPromise
	}

	function setSaveStatus(message, tone = 'info') {
		const statusEl = document.getElementById('settings-save-status')
		if (!statusEl) return
		statusEl.textContent = message
		statusEl.dataset.tone = tone
	}

	async function loadSettings() {
		console.log('⚙️ [SETTINGS] loadSettings() called')
		try {
			await getDefaultServer()
			const configPath = await invoke('get_config_path').catch(() => 'Not set')
			console.log('⚙️ [SETTINGS] config_path:', configPath)
			document.getElementById('config-path-display').textContent = configPath

			const settings = await invoke('get_settings')
			console.log('⚙️ [SETTINGS] get_settings result:', JSON.stringify(settings, null, 2))
			currentSettings = settings
			document.getElementById('setting-email').value = settings.email || ''
			currentUserEmail = settings.email || ''
			savedEmail = settings.email || ''
			console.log('⚙️ [SETTINGS] email set to:', currentUserEmail)
			const syftboxServerInput = document.getElementById('setting-syftbox-server')
			if (syftboxServerInput) {
				syftboxServerInput.value = settings.syftbox_server_url || defaultSyftboxServerUrl
				syftboxServerInput.placeholder = defaultSyftboxServerUrl || 'https://your-syftbox-host'
			}

			document.getElementById('setting-ai-url').value = settings.ai_api_url || ''
			document.getElementById('setting-ai-token').value = settings.ai_api_token || ''
			document.getElementById('setting-ai-model').value = settings.ai_model || ''
			setSaveStatus('', 'info')

			loadSavedDependencies('settings-deps-list', 'settings-dep-details-panel')
			bindSyftBoxPathButtons()

			checkSyftBoxStatus()
			loadAutostartStatus()
			bindKeyButtons()
			refreshKeyStatus()
			loadContacts()
			setupSyftboxQueue()
			setupSyftboxDiagnostics()
			refreshSyftboxDiagnostics()

			// Auto-start SyftBox daemon if authenticated
			autoStartSyftBoxDaemon()

			// Poll diagnostics more frequently while on settings
			if (syftboxStatusTimer) clearInterval(syftboxStatusTimer)
			syftboxStatusTimer = setInterval(() => {
				// Only poll when settings tab is visible
				const settingsRoot = document.getElementById('settings')
				if (!settingsRoot || settingsRoot.style.display === 'none') return
				refreshSyftboxDiagnostics(false)
			}, 2000)
		} catch (error) {
			console.error('Error loading settings:', error)
		}
	}

	async function autoStartSyftBoxDaemon() {
		try {
			const configInfo = await invoke('get_syftbox_config_info').catch(() => ({}))
			const syftboxState = await invoke('get_syftbox_state').catch(() => ({ running: false }))

			// Only auto-start if authenticated and not already running
			if (configInfo.is_authenticated && !syftboxState.running) {
				console.log('🚀 [SETTINGS] Auto-starting SyftBox daemon...')
				const status = await invoke('start_syftbox_client')
				if (status.running) {
					console.log('✅ [SETTINGS] SyftBox daemon started successfully')
				} else if (status.error) {
					console.error('❌ [SETTINGS] SyftBox daemon failed to start:', status.error)
				}
				// Refresh status display
				await checkSyftBoxStatus()
			} else if (!configInfo.is_authenticated) {
				console.log('ℹ️ [SETTINGS] SyftBox not authenticated, skipping auto-start')
			} else if (syftboxState.running) {
				console.log('ℹ️ [SETTINGS] SyftBox daemon already running')
			}
		} catch (error) {
			console.error('❌ [SETTINGS] Auto-start SyftBox failed:', error)
		}
	}

	async function loadAutostartStatus() {
		try {
			const enabled = await invoke('get_autostart_enabled')
			const toggle = document.getElementById('autostart-toggle')
			if (toggle) {
				toggle.checked = enabled

				// Attach event listener if not already attached
				if (!toggle.dataset.listenerAttached) {
					toggle.addEventListener('change', async (e) => {
						const newEnabled = e.target.checked
						try {
							await invoke('set_autostart_enabled', { enabled: newEnabled })
						} catch (error) {
							console.error('Error toggling autostart:', error)
							e.target.checked = !newEnabled
						}
					})
					toggle.dataset.listenerAttached = 'true'
				}
			}
		} catch (error) {
			console.error('Error loading autostart status:', error)
		}
	}

	// Listen for autostart changes from tray menu
	if (typeof window.__TAURI__ !== 'undefined') {
		window.__TAURI__.event.listen('autostart-changed', async () => {
			const autostartToggle = document.getElementById('autostart-toggle')
			if (autostartToggle) {
				try {
					const enabled = await invoke('get_autostart_enabled')
					autostartToggle.checked = enabled
				} catch (error) {
					console.error('Error updating autostart status:', error)
				}
			}
		})
	}

	async function copyTextToClipboard(text) {
		try {
			await navigator.clipboard.writeText(text)
		} catch (error) {
			console.error('Clipboard error:', error)
			throw error
		}
	}

	function buildIdenticon(seed) {
		let hash = 0
		for (let i = 0; i < seed.length; i += 1) {
			hash = (hash * 31 + seed.charCodeAt(i)) >>> 0
		}
		const hue = hash % 360
		const fg = `hsl(${hue}, 65%, 45%)`
		const bg = '#f3f4f6'
		const cells = 5
		const size = 15
		const padding = 6
		let bits = hash || 1
		let rects = ''
		for (let y = 0; y < cells; y += 1) {
			for (let x = 0; x < Math.ceil(cells / 2); x += 1) {
				const on = bits & 1
				bits = (bits >> 1) | ((bits & 1) << 31)
				if (on) {
					const rx = padding + x * size
					const ry = padding + y * size
					const mirrorX = padding + (cells - x - 1) * size
					rects += `<rect x="${rx}" y="${ry}" width="${size}" height="${size}" fill="${fg}" rx="3" ry="3"/>`
					if (mirrorX !== rx) {
						rects += `<rect x="${mirrorX}" y="${ry}" width="${size}" height="${size}" fill="${fg}" rx="3" ry="3"/>`
					}
				}
			}
		}
		const dim = padding * 2 + cells * size
		return `<svg width="${dim}" height="${dim}" viewBox="0 0 ${dim} ${dim}" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Identity fingerprint"><rect width="${dim}" height="${dim}" fill="${bg}" rx="12" ry="12"/>${rects}</svg>`
	}

	function renderIdenticon(targetEl, seed) {
		if (!targetEl) return
		targetEl.innerHTML = buildIdenticon(seed || 'unknown')
	}

	function renderKeyStatus(status) {
		const identityEl = document.getElementById('key-identity-label')
		const fpEl = document.getElementById('key-fingerprint')
		const statusLine = document.getElementById('key-status-line')
		const warningEl = document.getElementById('key-warning')
		const copyFpBtn = document.getElementById('key-copy-fingerprint-btn')
		const copyBundleBtn = document.getElementById('key-copy-bundle-btn')
		const restoreBtn = document.getElementById('key-restore-btn')
		const generateBtn = document.getElementById('key-generate-btn')
		const refreshBtn = document.getElementById('key-refresh-btn')

		if (identityEl) identityEl.textContent = status?.identity || 'Not set'
		if (fpEl) fpEl.textContent = status?.vault_fingerprint || 'No key found'
		if (statusLine) {
			if (!status?.exists) {
				statusLine.textContent = 'No key found in vault; generate or restore to continue.'
			} else if (status?.export_fingerprint) {
				const matches =
					status.export_matches === undefined
						? '?'
						: status.export_matches
							? 'matches export'
							: 'differs from export'
				statusLine.textContent = `Vault bundle at ${status.bundle_path}; export ${matches}.`
			} else {
				statusLine.textContent = `Vault bundle at ${status.bundle_path}; no export found.`
			}
		}

		if (warningEl) {
			warningEl.textContent = status?.exists
				? ''
				: 'No key material detected for this email. Generate or restore before sharing data.'
		}

		if (copyFpBtn) copyFpBtn.disabled = !status?.vault_fingerprint
		if (copyBundleBtn) copyBundleBtn.disabled = !status?.bundle
		if (restoreBtn) restoreBtn.disabled = false
		if (generateBtn) generateBtn.disabled = false
		if (refreshBtn) refreshBtn.disabled = false

		renderIdenticon(
			document.getElementById('key-avatar'),
			status?.vault_fingerprint || status?.identity,
		)
	}

	async function refreshKeyStatus() {
		console.log('⚙️ [SETTINGS] refreshKeyStatus() called')
		try {
			const email = document.getElementById('setting-email')?.value.trim() || currentUserEmail
			console.log('⚙️ [SETTINGS] refreshKeyStatus email:', email)

			// First check vault debug info
			try {
				const vaultDebug = await invoke('key_check_vault_debug')
				console.log('⚙️ [SETTINGS] vault debug:', JSON.stringify(vaultDebug, null, 2))
			} catch (vaultErr) {
				console.warn('⚙️ [SETTINGS] vault debug failed:', vaultErr)
			}

			const status = await invoke('key_get_status', { email: email || null })
			console.log('⚙️ [SETTINGS] key_get_status result:', JSON.stringify(status, null, 2))
			keyStatus = status
			vaultPath = status?.vault_path || ''
			renderKeyStatus(status)
		} catch (error) {
			console.error('⚙️ [SETTINGS] Failed to load key status:', error)
			renderKeyStatus({
				identity: currentUserEmail || 'Unknown',
				vault_fingerprint: null,
				exists: false,
				bundle_path: '',
				export_path: '',
			})
		}
	}

	// Build a smaller identicon for contacts
	function buildSmallIdenticon(seed) {
		let hash = 0
		for (let i = 0; i < seed.length; i += 1) {
			hash = (hash * 31 + seed.charCodeAt(i)) >>> 0
		}
		const hue = hash % 360
		const fg = `hsl(${hue}, 65%, 45%)`
		const bg = '#f3f4f6'
		const cells = 5
		const size = 8
		const padding = 4
		let bits = hash || 1
		let rects = ''
		for (let y = 0; y < cells; y += 1) {
			for (let x = 0; x < Math.ceil(cells / 2); x += 1) {
				const on = bits & 1
				bits = (bits >> 1) | ((bits & 1) << 31)
				if (on) {
					const rx = padding + x * size
					const ry = padding + y * size
					const mirrorX = padding + (cells - x - 1) * size
					rects += `<rect x="${rx}" y="${ry}" width="${size}" height="${size}" fill="${fg}" rx="2" ry="2"/>`
					if (mirrorX !== rx) {
						rects += `<rect x="${mirrorX}" y="${ry}" width="${size}" height="${size}" fill="${fg}" rx="2" ry="2"/>`
					}
				}
			}
		}
		const dim = padding * 2 + cells * size
		return `<svg width="${dim}" height="${dim}" viewBox="0 0 ${dim} ${dim}" xmlns="http://www.w3.org/2000/svg"><rect width="${dim}" height="${dim}" fill="${bg}" rx="6" ry="6"/>${rects}</svg>`
	}

	async function loadContacts() {
		const listEl = document.getElementById('contacts-list')
		if (!listEl) return

		try {
			const email = document.getElementById('setting-email')?.value.trim() || currentUserEmail
			const contacts = await invoke('key_list_contacts', { currentEmail: email || null })
			renderContacts(contacts)
		} catch (error) {
			console.error('Failed to load contacts:', error)
			listEl.innerHTML = `<div class="contacts-empty">Failed to load contacts: ${error}</div>`
		}
	}

	function renderContacts(contacts) {
		const listEl = document.getElementById('contacts-list')
		if (!listEl) return

		if (!contacts || contacts.length === 0) {
			listEl.innerHTML =
				'<div class="contacts-empty">No contacts yet. Use "Refresh Keys" to sync from SyftBox.</div>'
			return
		}

		listEl.innerHTML = contacts
			.map(
				(contact) => `
			<div class="contact-item" title="${contact.bundle_path}">
				<div class="contact-avatar">${buildSmallIdenticon(contact.fingerprint)}</div>
				<div class="contact-info">
					<div class="contact-identity">${escapeHtml(contact.identity)}</div>
					<div class="contact-fingerprint">${escapeHtml(contact.fingerprint)}</div>
				</div>
			</div>
		`,
			)
			.join('')
	}

	function escapeHtml(str) {
		const div = document.createElement('div')
		div.textContent = str
		return div.innerHTML
	}

	function setSyftBoxPathDisplay(pathId, btnId, path) {
		const el = document.getElementById(pathId)
		const btn = document.getElementById(btnId)
		const trimmed = (path || '').trim()
		const display = trimmed || 'Not resolved'
		if (el) {
			el.textContent = display
			el.title = display
		}
		if (btn) {
			btn.disabled = !trimmed
			btn.dataset.path = trimmed
		}
	}

	function bindSyftBoxPathButtons() {
		const buttons = [
			'syftbox-open-config-btn',
			'syftbox-open-data-dir-btn',
			'syftbox-open-datasites-btn',
			'syftbox-open-logs-btn',
			'syftbox-open-logfile-btn',
		]

		buttons.forEach((id) => {
			const btn = document.getElementById(id)
			if (!btn || btn.dataset.listenerAttached) return
			btn.addEventListener('click', async () => {
				const path = btn.dataset.path
				if (!path) {
					await dialog.message('Path is not set yet.', {
						title: 'Path Unavailable',
						type: 'warning',
					})
					return
				}
				try {
					await invoke('open_folder', { path })
				} catch (error) {
					console.error(`Failed to open path (${path}):`, error)
					await dialog.message(`Failed to open ${path}: ${error}`, {
						title: 'Open Failed',
						type: 'error',
					})
				}
			})
			btn.dataset.listenerAttached = 'true'
		})

		const startBtn = document.getElementById('syftbox-start-btn')
		const stopBtn = document.getElementById('syftbox-stop-btn')
		if (startBtn && !startBtn.dataset.listenerAttached) {
			startBtn.addEventListener('click', async () => {
				startBtn.disabled = true
				stopBtn && (stopBtn.disabled = true)
				try {
					await invoke('start_syftbox_client')
					await checkSyftBoxStatus()
				} catch (error) {
					console.error('Failed to start SyftBox:', error)
					await dialog.message(`Failed to start SyftBox: ${error}`, {
						title: 'Start Failed',
						type: 'error',
					})
				} finally {
					startBtn.disabled = false
					stopBtn && (stopBtn.disabled = false)
				}
			})
			startBtn.dataset.listenerAttached = 'true'
		}
		if (stopBtn && !stopBtn.dataset.listenerAttached) {
			stopBtn.addEventListener('click', async () => {
				startBtn && (startBtn.disabled = true)
				stopBtn.disabled = true
				try {
					await invoke('stop_syftbox_client')
					await checkSyftBoxStatus()
				} catch (error) {
					console.error('Failed to stop SyftBox:', error)
					await dialog.message(`Failed to stop SyftBox: ${error}`, {
						title: 'Stop Failed',
						type: 'error',
					})
				} finally {
					startBtn && (startBtn.disabled = false)
					stopBtn.disabled = false
				}
			})
			stopBtn.dataset.listenerAttached = 'true'
		}
	}

	async function handleRefreshContacts() {
		const btn = document.getElementById('refresh-contacts-btn')
		const statusEl = document.getElementById('refresh-contacts-status')

		if (btn) {
			btn.disabled = true
			btn.textContent = 'Refreshing...'
		}
		if (statusEl) {
			statusEl.textContent = ''
			statusEl.className = 'refresh-status'
		}

		try {
			const result = await invoke('key_refresh_contacts')

			const parts = []
			if (result.added.length > 0) parts.push(`${result.added.length} added`)
			if (result.updated.length > 0) parts.push(`${result.updated.length} updated`)
			if (result.unchanged.length > 0) parts.push(`${result.unchanged.length} unchanged`)

			if (statusEl) {
				if (result.errors.length > 0) {
					statusEl.textContent = `${parts.join(', ')} (${result.errors.length} errors)`
					statusEl.className = 'refresh-status error'
				} else if (parts.length > 0) {
					statusEl.textContent = parts.join(', ')
					statusEl.className = 'refresh-status success'
				} else {
					statusEl.textContent = 'No contacts found in datasites'
					statusEl.className = 'refresh-status'
				}
			}

			// Reload contacts list
			await loadContacts()
		} catch (error) {
			console.error('Failed to refresh contacts:', error)
			if (statusEl) {
				statusEl.textContent = `Error: ${error}`
				statusEl.className = 'refresh-status error'
			}
		} finally {
			if (btn) {
				btn.disabled = false
				btn.textContent = 'Refresh Keys'
			}
		}
	}

	async function refreshSyftBoxPaths(configInfo) {
		setSyftBoxPathDisplay('syftbox-config-path', 'syftbox-open-config-btn', configInfo?.config_path)
		setSyftBoxPathDisplay('syftbox-data-dir', 'syftbox-open-data-dir-btn', configInfo?.data_dir)

		const email = document.getElementById('setting-email')?.value.trim() || currentUserEmail
		const datasiteDir =
			configInfo?.data_dir && email ? `${configInfo.data_dir}/datasites/${email}` : ''
		setSyftBoxPathDisplay('syftbox-datasites-dir', 'syftbox-open-datasites-btn', datasiteDir)

		const logDir = configInfo?.log_dir || (await invoke('get_desktop_log_dir').catch(() => null))
		setSyftBoxPathDisplay('syftbox-log-dir', 'syftbox-open-logs-btn', logDir)
		setSyftBoxPathDisplay(
			'syftbox-log-file',
			'syftbox-open-logfile-btn',
			configInfo?.log_path || logDir,
		)

		const daemonStatus = document.getElementById('syftbox-daemon-status')
		if (daemonStatus) {
			if (configInfo?.data_dir_error) {
				daemonStatus.textContent = `Error: ${configInfo.data_dir_error}`
				daemonStatus.dataset.tone = 'error'
			} else if (configInfo?.data_dir) {
				daemonStatus.textContent = 'Checking...'
				daemonStatus.dataset.tone = 'info'
			} else {
				daemonStatus.textContent = 'No data dir'
				daemonStatus.dataset.tone = 'warn'
			}
		}
	}

	async function _handleCopyFingerprint() {
		if (!keyStatus?.vault_fingerprint) return
		await copyTextToClipboard(keyStatus.vault_fingerprint)
		await dialog.message('Fingerprint copied to clipboard.', { title: 'Copied' })
	}

	async function _handleCopyBundle() {
		if (!keyStatus?.bundle) return
		await copyTextToClipboard(JSON.stringify(keyStatus.bundle, null, 2))
		await dialog.message('Public bundle copied to clipboard.', { title: 'Copied' })
	}

	async function _handleGenerateKey() {
		const email = document.getElementById('setting-email')?.value.trim() || currentUserEmail
		if (!email) {
			await dialog.message('Please enter your email first.', {
				title: 'Email Required',
				type: 'warning',
			})
			return
		}
		const confirmGenerate = await dialog.confirm(
			'This will generate a NEW key and overwrite any existing key. Make sure you have saved your current recovery code, or you will lose access to any data encrypted with it.\n\nAre you sure you want to generate a new key?',
			{ title: 'Warning: Generate New Key?', kind: 'warning' },
		)
		if (!confirmGenerate) return
		try {
			const result = await invoke('key_generate', { email, force: true })
			keyStatus = {
				identity: result.identity,
				vault_fingerprint: result.fingerprint,
				export_fingerprint: result.fingerprint,
				export_matches: true,
				exists: true,
				bundle_path: result.bundle_path,
				export_path: result.export_path,
				vault_path: result.vault_path,
				bundle: null,
			}
			renderKeyStatus(keyStatus)
			if (result.mnemonic) {
				await dialog.message(`Recovery code (save securely, shown once):\n\n${result.mnemonic}`, {
					title: 'Recovery Code',
				})
			}
		} catch (error) {
			console.error('Failed to generate key:', error)
			await dialog.message(`Failed to generate key: ${error}`, { title: 'Error', type: 'error' })
		} finally {
			refreshKeyStatus()
		}
	}

	async function _handleRestoreKey() {
		const email = document.getElementById('setting-email')?.value.trim() || currentUserEmail
		if (!email) {
			await dialog.message('Please enter your email first.', {
				title: 'Email Required',
				type: 'warning',
			})
			return
		}
		const mnemonic = prompt('Enter recovery code (BIP-39 mnemonic):')
		if (!mnemonic) return
		try {
			const result = await invoke('key_restore', { email, mnemonic })
			keyStatus = {
				identity: result.identity,
				vault_fingerprint: result.fingerprint,
				export_fingerprint: result.fingerprint,
				export_matches: true,
				exists: true,
				bundle_path: result.bundle_path,
				export_path: result.export_path,
				vault_path: result.vault_path,
				bundle: null,
			}
			renderKeyStatus(keyStatus)
			await dialog.message('Key restored successfully.', { title: 'Success' })
		} catch (error) {
			console.error('Failed to restore key:', error)
			await dialog.message(`Failed to restore key: ${error}`, { title: 'Error', type: 'error' })
		} finally {
			refreshKeyStatus()
		}
	}

	async function handleOpenVault() {
		try {
			const path = vaultPath || keyStatus?.vault_path || keyStatus?.bundle_path
			if (!path) {
				await dialog.message('Vault path is unknown. Generate or restore a key first.', {
					title: 'Vault Not Found',
					type: 'warning',
				})
				return
			}
			await invoke('open_folder', { path })
		} catch (error) {
			console.error('Failed to open vault folder:', error)
			await dialog.message(`Failed to open vault: ${error}`, { title: 'Error', type: 'error' })
		}
	}

	let keyHandlersBound = false
	let modalRecovery = null

	function openKeyModal() {
		const modal = document.getElementById('key-manage-modal')
		if (!modal) return
		modal.style.display = 'flex'
		modalRecovery = null
		renderModalKeyCard()
		document.getElementById('modal-recovery-block').style.display = 'none'
		document.getElementById('modal-restore-block').style.display = 'none'
	}

	function closeKeyModal() {
		const modal = document.getElementById('key-manage-modal')
		if (modal) modal.style.display = 'none'
		modalRecovery = null
		refreshKeyStatus()
	}

	function renderModalKeyCard() {
		const status = keyStatus
		document.getElementById('modal-key-identity').textContent = status?.identity || 'Not set'
		document.getElementById('modal-key-fp').textContent =
			status?.vault_fingerprint || 'No key found'
		document.getElementById('modal-key-status').textContent = status?.exists
			? `Vault bundle at ${status.bundle_path}`
			: 'No key found; generate or restore to continue.'
		document.getElementById('modal-key-warning').textContent = status?.exists
			? ''
			: 'No key detected. Generate or restore before continuing.'
		const avatar = document.getElementById('modal-key-avatar')
		if (avatar) {
			avatar.innerHTML = buildIdenticon(status?.vault_fingerprint || status?.identity || 'seed')
		}
	}

	async function handleModalGenerate() {
		const email = document.getElementById('setting-email')?.value.trim() || currentUserEmail
		if (!email) {
			await dialog.message('Please enter your email first.', {
				title: 'Email Required',
				type: 'warning',
			})
			return
		}
		const confirmed = await dialog.confirm(
			'This will generate a NEW key and overwrite any existing key. Make sure you have saved your current recovery code, or you will lose access to any data encrypted with it.\n\nAre you sure you want to generate a new key?',
			{ title: 'Warning: Generate New Key?', kind: 'warning' },
		)
		if (!confirmed) return
		try {
			const result = await invoke('key_generate', { email, force: true })
			keyStatus = {
				identity: result.identity,
				vault_fingerprint: result.fingerprint,
				export_fingerprint: result.fingerprint,
				export_matches: true,
				exists: true,
				bundle_path: result.bundle_path,
				export_path: result.export_path,
				vault_path: result.vault_path,
				bundle: null,
			}
			modalRecovery = result.mnemonic
			renderModalKeyCard()
			if (result.mnemonic) {
				document.getElementById('modal-recovery-text').textContent = result.mnemonic
				document.getElementById('modal-recovery-block').style.display = 'block'
			}
		} catch (error) {
			console.error('Failed to generate key:', error)
			await dialog.message(`Failed to generate key: ${error}`, { title: 'Error', type: 'error' })
		}
	}

	async function handleModalRestore() {
		const email = document.getElementById('setting-email')?.value.trim() || currentUserEmail
		if (!email) {
			await dialog.message('Please enter your email first.', {
				title: 'Email Required',
				type: 'warning',
			})
			return
		}
		const mnemonic = document.getElementById('modal-restore-input').value.trim()
		if (!mnemonic) {
			await dialog.message('Please enter a recovery code.', {
				title: 'Recovery Required',
				type: 'warning',
			})
			return
		}
		try {
			const result = await invoke('key_restore', { email, mnemonic })
			keyStatus = {
				identity: result.identity,
				vault_fingerprint: result.fingerprint,
				export_fingerprint: result.fingerprint,
				export_matches: true,
				exists: true,
				bundle_path: result.bundle_path,
				export_path: result.export_path,
				vault_path: result.vault_path,
				bundle: null,
			}
			modalRecovery = mnemonic
			renderModalKeyCard()
			document.getElementById('modal-restore-block').style.display = 'none'
			document.getElementById('modal-recovery-text').textContent = mnemonic
			document.getElementById('modal-recovery-block').style.display = 'block'
			await dialog.message('Key restored successfully.', { title: 'Success' })
		} catch (error) {
			console.error('Failed to restore key:', error)
			await dialog.message(`Failed to restore key: ${error}`, { title: 'Error', type: 'error' })
		}
	}

	async function handleRepublishDID() {
		const btn = document.getElementById('key-republish-btn')
		if (btn) {
			btn.disabled = true
			btn.textContent = 'Republishing...'
		}
		try {
			const email = document.getElementById('setting-email')?.value.trim() || currentUserEmail
			const result = await invoke('key_republish', { email: email || null })

			if (result.vault_matches_export) {
				await dialog.message(
					`DID republished successfully.\n\nFingerprint: ${result.fingerprint}\nExported to: ${result.export_path}`,
					{ title: 'Success' },
				)
			} else {
				await dialog.message(
					`Warning: DID was republished but verification failed.\n\nFingerprint: ${result.fingerprint}`,
					{ title: 'Warning', type: 'warning' },
				)
			}
			// Refresh key status to update the display
			await refreshKeyStatus()
		} catch (error) {
			console.error('Failed to republish DID:', error)
			await dialog.message(`Failed to republish DID: ${error}`, { title: 'Error', type: 'error' })
		} finally {
			if (btn) {
				btn.disabled = false
				btn.textContent = 'Republish DID'
			}
		}
	}

	function bindKeyButtons() {
		if (keyHandlersBound) return

		// Main settings buttons
		const openVaultBtn = document.getElementById('key-open-vault-btn')
		const republishBtn = document.getElementById('key-republish-btn')
		const manageBtn = document.getElementById('key-manage-btn')

		openVaultBtn?.addEventListener('click', handleOpenVault)
		republishBtn?.addEventListener('click', handleRepublishDID)
		manageBtn?.addEventListener('click', openKeyModal)

		// Contacts refresh button
		document
			.getElementById('refresh-contacts-btn')
			?.addEventListener('click', handleRefreshContacts)

		// Modal buttons
		document.getElementById('key-modal-close')?.addEventListener('click', closeKeyModal)
		document.getElementById('modal-generate-btn')?.addEventListener('click', handleModalGenerate)
		document.getElementById('modal-restore-btn')?.addEventListener('click', () => {
			document.getElementById('modal-restore-block').style.display = 'block'
			document.getElementById('modal-recovery-block').style.display = 'none'
		})
		document
			.getElementById('modal-restore-confirm-btn')
			?.addEventListener('click', handleModalRestore)
		document.getElementById('modal-restore-cancel-btn')?.addEventListener('click', () => {
			document.getElementById('modal-restore-block').style.display = 'none'
			if (modalRecovery) {
				document.getElementById('modal-recovery-block').style.display = 'block'
			}
		})
		document.getElementById('modal-copy-recovery-btn')?.addEventListener('click', async () => {
			if (!modalRecovery) return
			await copyTextToClipboard(modalRecovery)
			await dialog.message('Recovery code copied to clipboard.', { title: 'Copied' })
		})
		document.getElementById('modal-copy-recovery-inline')?.addEventListener('click', async () => {
			if (!modalRecovery) return
			const btn = document.getElementById('modal-copy-recovery-inline')
			await copyTextToClipboard(modalRecovery)
			btn?.classList.add('copied')
			setTimeout(() => btn?.classList.remove('copied'), 1500)
		})
		document.getElementById('modal-copy-fp-btn')?.addEventListener('click', async () => {
			if (!keyStatus?.vault_fingerprint) return
			await copyTextToClipboard(keyStatus.vault_fingerprint)
			await dialog.message('Fingerprint copied to clipboard.', { title: 'Copied' })
		})
		document.getElementById('modal-open-vault-btn')?.addEventListener('click', async () => {
			const path = keyStatus?.vault_path || keyStatus?.bundle_path
			if (!path) {
				await dialog.message('Vault path unknown.', { title: 'Error', type: 'error' })
				return
			}
			try {
				await invoke('open_folder', { path })
			} catch (error) {
				await dialog.message(`Failed to open vault: ${error}`, { title: 'Error', type: 'error' })
			}
		})

		// Close modal on overlay click
		document.getElementById('key-manage-modal')?.addEventListener('click', (e) => {
			if (e.target.id === 'key-manage-modal') closeKeyModal()
		})

		// Email/Identity change handler
		const emailInput = document.getElementById('setting-email')
		const identityActions = document.getElementById('identity-change-actions')
		const confirmBtn = document.getElementById('identity-confirm-btn')
		const cancelBtn = document.getElementById('identity-cancel-btn')

		if (emailInput && !emailInput.dataset.keyListenerAttached) {
			let debounceTimer = null

			const checkEmailChanged = () => {
				const currentValue = emailInput.value.trim()
				const hasChanged = currentValue !== savedEmail && currentValue !== ''

				if (hasChanged) {
					emailInput.classList.add('changed')
					if (identityActions) identityActions.style.display = 'flex'
				} else {
					emailInput.classList.remove('changed')
					if (identityActions) identityActions.style.display = 'none'
				}

				// Still refresh key status to show what key exists for this email
				refreshKeyStatus()
			}

			emailInput.addEventListener('input', () => {
				clearTimeout(debounceTimer)
				debounceTimer = setTimeout(checkEmailChanged, 500)
			})

			emailInput.addEventListener('blur', () => {
				clearTimeout(debounceTimer)
				checkEmailChanged()
			})

			emailInput.dataset.keyListenerAttached = 'true'
		}

		// Confirm identity change
		confirmBtn?.addEventListener('click', async () => {
			const newEmail = emailInput?.value.trim()
			if (!newEmail) {
				await dialog.message('Please enter a valid email address.', {
					title: 'Email Required',
					type: 'warning',
				})
				return
			}

			try {
				// Save the new email
				await saveSettingsChanges()
				savedEmail = newEmail
				currentUserEmail = newEmail

				emailInput?.classList.remove('changed')
				if (identityActions) identityActions.style.display = 'none'

				// Refresh key status for new email
				await refreshKeyStatus()

				// Prompt for SyftBox re-authentication
				const shouldAuth = await dialog.confirm(
					'Identity updated successfully.\n\nWould you like to authenticate with SyftBox now? This is required for secure data sharing.',
					{ title: 'Authenticate with SyftBox?', kind: 'info' },
				)

				if (shouldAuth) {
					handleSyftBoxAuthentication()
				}
			} catch (error) {
				console.error('Failed to update identity:', error)
				await dialog.message(`Failed to update identity: ${error}`, {
					title: 'Error',
					type: 'error',
				})
			}
		})

		// Cancel identity change
		cancelBtn?.addEventListener('click', () => {
			if (emailInput) {
				emailInput.value = savedEmail
				emailInput.classList.remove('changed')
			}
			if (identityActions) identityActions.style.display = 'none'
			refreshKeyStatus()
		})

		keyHandlersBound = true
	}

	async function checkSyftBoxStatus() {
		const statusBadge = document.getElementById('syftbox-status-badge')
		const authBtn = document.getElementById('syftbox-auth-btn')
		const devBadge = document.getElementById('syftbox-dev-badge')
		const serverLabel =
			(currentSettings?.syftbox_server_url && currentSettings.syftbox_server_url.trim()) ||
			defaultSyftboxServerUrl

		try {
			// Check for dev mode first
			const devModeInfo = await invoke('get_dev_mode_info').catch(() => ({ dev_mode: false }))
			const configInfo = await invoke('get_syftbox_config_info')
			await refreshSyftBoxPaths(configInfo)
			const syftboxState = await invoke('get_syftbox_state').catch(() => ({ running: false }))

			// Remove all status classes
			statusBadge.classList.remove('connected', 'disconnected', 'checking')

			// In dev mode with syftbox enabled, show special status
			if (devModeInfo.dev_mode && devModeInfo.dev_syftbox) {
				const devServer = devModeInfo.server_url || serverLabel || 'localhost:8080'
				statusBadge.innerHTML = `
					<div class="badge-line">🧪 DEV MODE - Auth Disabled</div>
					<div class="badge-subline">Server: ${devServer}</div>
					<div class="badge-subline">Backend: ${syftboxState.backend || 'Unknown'}</div>
				`
				statusBadge.classList.add('connected')
				statusBadge.style.lineHeight = '1.4'
				authBtn.textContent = 'Dev Mode Active'
				authBtn.disabled = true
				// Update syftbox status to running in dev mode
				syftboxStatus = { running: true, mode: 'Dev' }
			} else if (configInfo.is_authenticated) {
				statusBadge.innerHTML = `
					<div class="badge-line">✓ Authenticated</div>
					<div class="badge-subline">Server: ${serverLabel}</div>
					<div class="badge-subline">Config: ${configInfo.config_path}</div>
					<div class="badge-subline">Data: ${configInfo.data_dir || 'Not resolved'}</div>
					<div class="badge-subline">Daemon: ${syftboxState.running ? 'Running' : 'Stopped'}</div>
					<div class="badge-subline">Mode: ${syftboxState.mode || 'Unknown'}</div>
					<div class="badge-subline">Backend: ${syftboxState.backend || 'Unknown'}</div>
					${syftboxState.log_path || configInfo.log_path ? `<div class="badge-subline">Log: ${syftboxState.log_path || configInfo.log_path}</div>` : ''}
				`
				statusBadge.classList.add('connected')
				statusBadge.style.lineHeight = '1.4'
				authBtn.textContent = 'Reauthenticate'
				authBtn.disabled = false
			} else {
				statusBadge.innerHTML = `
					<div class="badge-line">✗ Not Authenticated</div>
					<div class="badge-subline">Server: ${serverLabel}</div>
					<div class="badge-subline">Config: ${configInfo.config_path}</div>
					<div class="badge-subline">Data: ${configInfo.data_dir || 'Not resolved'}</div>
					<div class="badge-subline">Daemon: ${syftboxState.running ? 'Running' : 'Stopped'}</div>
					<div class="badge-subline">Mode: ${syftboxState.mode || 'Unknown'}</div>
					<div class="badge-subline">Backend: ${syftboxState.backend || 'Unknown'}</div>
					${syftboxState.log_path || configInfo.log_path ? `<div class="badge-subline">Log: ${syftboxState.log_path || configInfo.log_path}</div>` : ''}
				`
				statusBadge.classList.add('disconnected')
				statusBadge.style.lineHeight = '1.4'
				authBtn.textContent = 'Authenticate'
				authBtn.disabled = false
			}

			if (devBadge) {
				devBadge.style.display = serverLabel !== defaultSyftboxServerUrl ? 'inline-flex' : 'none'
				devBadge.textContent =
					serverLabel !== defaultSyftboxServerUrl ? 'Auth skipped (dev host)' : ''
			}
		} catch (error) {
			statusBadge.innerHTML = '? Status Unknown'
			statusBadge.classList.remove('connected', 'disconnected', 'checking')
			statusBadge.classList.add('checking')
			authBtn.disabled = false
			authBtn.textContent = 'Authenticate'
			await refreshSyftBoxPaths({})
			console.error('Error checking SyftBox status:', error)

			const daemonStatus = document.getElementById('syftbox-daemon-status')
			if (daemonStatus) {
				daemonStatus.textContent = 'Status unknown'
				daemonStatus.dataset.tone = 'warn'
			}
		}
	}

	async function handleSyftBoxAuthentication() {
		const email = document.getElementById('setting-email').value.trim()
		const serverUrlInput = document.getElementById('setting-syftbox-server')
		const desiredServerUrl = serverUrlInput?.value.trim()

		if (!email) {
			await dialog.message('Please enter your email address first.', {
				title: 'Email Required',
				type: 'warning',
			})
			return
		}

		// Persist the latest settings (including server URL) before starting auth
		try {
			await saveSettingsChanges()
			if (desiredServerUrl) {
				document.body.dataset.syftboxServerUrl = desiredServerUrl
			}
		} catch (error) {
			console.error('Error saving settings before auth:', error)
			await dialog.message('Could not save settings before authentication. Please try again.', {
				title: 'Save Failed',
				type: 'error',
			})
			return
		}

		document.getElementById('onboarding-email').value = email

		// Hide the app layout (sidebar and main content)
		const appLayout = document.querySelector('.app-layout')
		if (appLayout) {
			appLayout.style.display = 'none'
		}

		document.querySelectorAll('.tab-content').forEach((content) => {
			content.classList.remove('active')
			content.style.display = 'none'
		})
		document.querySelectorAll('.nav-item').forEach((item) => item.classList.remove('active'))

		const onboardingView = document.getElementById('onboarding-view')
		onboardingView.classList.add('active')
		onboardingView.style.display = 'flex'

		document.querySelectorAll('.onboarding-step').forEach((step) => {
			step.style.display = 'none'
		})

		const step4 = document.getElementById('onboarding-step-4')
		step4.style.display = 'block'

		step4.dataset.fromSettings = 'true'

		const skipBtn = document.getElementById('skip-syftbox-btn')
		skipBtn.textContent = 'Cancel'

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

		document.querySelectorAll('.syftbox-code-input').forEach((input) => {
			input.value = ''
			input.classList.remove('error', 'success')
		})
	}

	async function saveSettingsChanges() {
		if (!currentSettings) {
			currentSettings = await invoke('get_settings').catch(() => ({}))
		}

		const email = document.getElementById('setting-email').value.trim()
		const aiApiUrl = document.getElementById('setting-ai-url').value.trim()
		const aiApiToken = document.getElementById('setting-ai-token').value.trim()
		const aiModel = document.getElementById('setting-ai-model').value.trim()
		const syftboxServerUrl =
			document.getElementById('setting-syftbox-server')?.value.trim() || defaultSyftboxServerUrl

		const settings = {
			...(currentSettings || {}),
			email,
			ai_api_url: aiApiUrl,
			ai_api_token: aiApiToken,
			ai_model: aiModel,
			syftbox_server_url: syftboxServerUrl,
		}

		try {
			await invoke('save_settings', { settings })
			currentSettings = settings
			currentUserEmail = email
			setSaveStatus('Settings saved successfully.', 'success')
			await checkSyftBoxStatus()
			onAiConfigUpdated?.()
		} catch (error) {
			console.error('Error saving settings:', error)
			setSaveStatus(error?.message || 'Failed to save settings.', 'error')
		}
	}

	function getCurrentUserEmail() {
		return currentUserEmail
	}

	function getSyftboxStatus() {
		return syftboxStatus
	}

	function setSyftboxStatus(status) {
		syftboxStatus = status
	}

	function setupSyftboxQueue() {
		const refreshBtn = document.getElementById('syftbox-queue-refresh')
		if (refreshBtn && !refreshBtn.dataset.listenerAttached) {
			refreshBtn.addEventListener('click', () => refreshSyftboxQueue(true))
			refreshBtn.dataset.listenerAttached = 'true'
		}
		const filterEl = document.getElementById('syftbox-queue-filter')
		if (filterEl && !filterEl.dataset.listenerAttached) {
			filterEl.addEventListener('click', (e) => {
				const btn = e.target.closest('.queue-filter-btn')
				if (!btn) return
				const filter = btn.dataset.filter
				if (filter) {
					document
						.querySelectorAll('#syftbox-queue-filter .queue-filter-btn')
						.forEach((b) => b.classList.toggle('active', b === btn))
					queueStore.filter = filter
					renderSyftboxQueue()
				}
			})
			filterEl.dataset.listenerAttached = 'true'
		}
		refreshSyftboxQueue(true)
		if (syftboxQueueTimer) clearInterval(syftboxQueueTimer)
		// Poll frequently but avoid UI jank
		syftboxQueueTimer = setInterval(refreshSyftboxQueue, 1000)
	}

	function setupSyftboxDiagnostics() {
		const refreshBtn = document.getElementById('syftbox-diagnostics-refresh')
		if (refreshBtn && !refreshBtn.dataset.listenerAttached) {
			refreshBtn.addEventListener('click', () => refreshSyftboxDiagnostics(true))
			refreshBtn.dataset.listenerAttached = 'true'
		}
		const tokenIds = ['syftbox-client-token', 'syftbox-refresh-token']
		tokenIds.forEach((id) => {
			const el = document.getElementById(id)
			if (el && !el.dataset.listenerAttached) {
				el.addEventListener('click', () => {
					const text = el.dataset.copyValue
					if (text) {
						copyTextToClipboard(text)
					}
				})
				el.title = 'Click to copy'
				el.dataset.listenerAttached = 'true'
			}
		})
	}

	function refreshSyftboxDiagnostics(logErrors = false) {
		invoke('get_syftbox_diagnostics')
			.then((diag) => {
				const status = diag?.status || window.__lastSyftboxQueueStatus?.status
				renderSyftboxDiagnostics({ ...diag, status })
				const cpUrl = resolveControlPlaneUrl(diag, status)
				if (status) {
					updateSidebarSyftboxIndicator(status, cpUrl, diag?.running)
				}
				// Cache for dataset ETA calc
				window.__lastSyftboxStatus = status
			})
			.catch((err) => {
				if (logErrors) console.error('SyftBox diagnostics failed', err)
			})
	}

	function renderSyftboxDiagnostics(diag) {
		const status = diag?.status || window.__lastSyftboxQueueStatus?.status
		const setText = (id, value) => {
			const el = document.getElementById(id)
			if (el) el.textContent = value ?? '—'
		}
		setText('syftbox-pids', diag?.pids?.length ? diag.pids.join(', ') : 'Not running')
		setText('syftbox-mode', diag?.mode || 'Unknown')
		setText('syftbox-backend', diag?.backend || 'Unknown')
		setText('syftbox-client-url', diag?.client_url || '—')
		setText('syftbox-server-url', diag?.server_url || '—')
		setText('syftbox-config-path-diag', diag?.config_path || '—')
		setText('syftbox-log-path', diag?.log_path || '—')
		const clientTokenEl = document.getElementById('syftbox-client-token')
		if (clientTokenEl) {
			clientTokenEl.textContent = diag?.client_token || '—'
			clientTokenEl.dataset.copyValue = diag?.client_token || ''
		}
		const refreshTokenEl = document.getElementById('syftbox-refresh-token')
		if (refreshTokenEl) {
			refreshTokenEl.textContent = diag?.refresh_token || '—'
			refreshTokenEl.dataset.copyValue = diag?.refresh_token || ''
		}
		renderSyftboxRuntime(status)
		renderControlPlaneLog(diag?.control_plane_requests || [])
		renderCurlHelper(diag, status)
	}

	function renderSyftboxRuntime(status) {
		const fmtDate = (s) => {
			if (!s) return '-'
			const d = new Date(s)
			return isNaN(d.getTime()) ? s : d.toLocaleString()
		}
		const deltaOrTotal = (delta, total) => {
			if (delta && delta > 0) return humanBytes(delta)
			if (total && total > 0) return `${humanBytes(total)} total`
			return '-'
		}
		const setText = (id, val) => {
			const el = document.getElementById(id)
			if (el) el.textContent = val ?? '—'
		}
		setText('syftbox-runtime-status', status?.status || 'Unknown')
		setText('syftbox-runtime-last-contact', fmtDate(status?.ts))

		const http = status?.runtime?.http || {}
		const ws = status?.runtime?.websocket || {}
		const uploads = status?.runtime?.uploads || {}
		const sync = status?.runtime?.sync || {}

		const cpUrl =
			status?.runtime?.client?.client_url ||
			status?.client_url ||
			window.__lastSyftboxQueueStatus?.control_plane_url
		if (cpUrl && cpUrl !== lastRuntimeTotals.url) {
			lastRuntimeTotals = { url: cpUrl, httpTx: null, httpRx: null, wsTx: null, wsRx: null }
		}

		const httpTxTotal = Number(http.bytes_sent_total || 0)
		const httpRxTotal = Number(http.bytes_recv_total || 0)
		const wsTxTotal = Number(ws.bytes_sent_total || 0)
		const wsRxTotal = Number(ws.bytes_recv_total || 0)

		const httpTxDelta =
			lastRuntimeTotals.httpTx === null ? 0 : Math.max(0, httpTxTotal - lastRuntimeTotals.httpTx)
		const httpRxDelta =
			lastRuntimeTotals.httpRx === null ? 0 : Math.max(0, httpRxTotal - lastRuntimeTotals.httpRx)
		const wsTxDelta =
			lastRuntimeTotals.wsTx === null ? 0 : Math.max(0, wsTxTotal - lastRuntimeTotals.wsTx)
		const wsRxDelta =
			lastRuntimeTotals.wsRx === null ? 0 : Math.max(0, wsRxTotal - lastRuntimeTotals.wsRx)

		lastRuntimeTotals = {
			url: cpUrl || lastRuntimeTotals.url,
			httpTx: httpTxTotal,
			httpRx: httpRxTotal,
			wsTx: wsTxTotal,
			wsRx: wsRxTotal,
		}

		const httpStr = `${deltaOrTotal(httpTxDelta, httpTxTotal)} ↑ / ${deltaOrTotal(
			httpRxDelta,
			httpRxTotal,
		)} ↓`
		const wsStr = `${deltaOrTotal(wsTxDelta, wsTxTotal)} ↑ / ${deltaOrTotal(
			wsRxDelta,
			wsRxTotal,
		)} ↓`
		const uploadsStr = `total ${uploads.total ?? 0}, uploading ${uploads.uploading ?? 0}, pending ${uploads.pending ?? 0}`
		const syncStr = `tracked ${sync.tracked_files ?? 0}, syncing ${sync.syncing_files ?? 0}, conflicts ${sync.conflicted_files ?? 0}`

		setText('syftbox-runtime-http', httpStr)
		setText('syftbox-runtime-ws', wsStr)
		setText('syftbox-runtime-uploads', uploadsStr)
		setText('syftbox-runtime-sync', syncStr)
	}

	function renderCurlHelper(diag, status) {
		const box = document.getElementById('syftbox-curl-helper')
		if (!box) return
		const url = resolveControlPlaneUrl(diag, status)
		const token =
			diag?.client_token ||
			status?.runtime?.client?.client_token ||
			window.__lastSyftboxQueueStatus?.client_token
		if (url && token) {
			const normalized = url.replace(/\/$/, '')
			box.textContent = `curl -s -H "Authorization: Bearer ${token}" "${normalized}/v1/status" | jq`
		} else {
			box.textContent = 'Control plane URL or token not available yet.'
		}
	}

	function updateSidebarSyftboxIndicator(status, cpUrl, diagRunning = false) {
		const dot = document.getElementById('syftbox-indicator-dot')
		const txEl = document.getElementById('syftbox-indicator-tx')
		const rxEl = document.getElementById('syftbox-indicator-rx')
		if (!dot) return
		if (cpUrl && cpUrl !== lastIndicatorTotals.url) {
			lastIndicatorTotals = { url: cpUrl, txTotal: null, rxTotal: null }
		}
		const runtime = status?.runtime || {}
		const http = runtime.http || {}
		const ws = runtime.websocket || {}
		const online =
			(status?.status || '').toLowerCase() === 'ok' ||
			runtime.websocket?.connected === true ||
			!!runtime.http ||
			status?.running === true ||
			diagRunning === true
		dot.dataset.state = online ? 'online' : 'offline'
		const txTotal = Number(http.bytes_sent_total || 0) + Number(ws.bytes_sent_total || 0)
		const rxTotal = Number(http.bytes_recv_total || 0) + Number(ws.bytes_recv_total || 0)

		// Show deltas since last poll to avoid giant cumulative numbers
		const txDelta =
			lastIndicatorTotals.txTotal !== null ? Math.max(0, txTotal - lastIndicatorTotals.txTotal) : 0
		const rxDelta =
			lastIndicatorTotals.rxTotal !== null ? Math.max(0, rxTotal - lastIndicatorTotals.rxTotal) : 0

		lastIndicatorTotals = { url: cpUrl || lastIndicatorTotals.url, txTotal, rxTotal }

		const deltaOrTotal = (delta, total) => {
			if (delta && delta > 0) return humanBytes(delta)
			if (total && total > 0) return humanBytes(total)
			return '-'
		}

		if (txEl) {
			txEl.textContent = deltaOrTotal(txDelta, txTotal)
			txEl.title = `Total sent: ${humanBytes(txTotal)}`
		}
		if (rxEl) {
			rxEl.textContent = deltaOrTotal(rxDelta, rxTotal)
			rxEl.title = `Total recv: ${humanBytes(rxTotal)}`
		}
	}

	function humanBytes(n) {
		if (typeof n !== 'number') return '-'
		if (n < 1024) return `${n} B`
		const units = ['KB', 'MB', 'GB', 'TB']
		let v = n
		let u = 0
		while (v >= 1024 && u < units.length - 1) {
			v /= 1024
			u++
		}
		return `${v.toFixed(v >= 10 || u === 0 ? 0 : 1)} ${units[u]}`
	}

	function renderControlPlaneLog(entries) {
		const container = document.getElementById('syftbox-cp-log')
		if (!container) return
		container.innerHTML = ''
		if (!entries || entries.length === 0) {
			container.textContent = 'No requests yet'
			return
		}
		entries
			.slice(-40)
			.reverse()
			.forEach((entry) => {
				const row = document.createElement('div')
				row.className = 'cp-log-entry'
				const ts = document.createElement('div')
				ts.textContent = entry.timestamp?.replace('T', ' ').replace('Z', '') || '-'
				const method = document.createElement('div')
				method.textContent = entry.method || ''
				const url = document.createElement('div')
				url.textContent = entry.url || ''
				const status = document.createElement('div')
				if (entry.error) {
					status.textContent = entry.error
					status.className = 'cp-log-status-error'
				} else {
					status.textContent = entry.status || '—'
					status.className =
						entry.status && Number(entry.status) >= 200 && Number(entry.status) < 300
							? 'cp-log-status-ok'
							: 'cp-log-status-error'
				}
				row.appendChild(ts)
				row.appendChild(method)
				row.appendChild(url)
				row.appendChild(status)
				container.appendChild(row)
			})
	}

	function resolveControlPlaneUrl(diag, status) {
		return (
			diag?.client_url ||
			status?.runtime?.client?.client_url ||
			status?.client_url ||
			window.__lastSyftboxQueueStatus?.control_plane_url ||
			window.__lastSyftboxQueueStatus?.client_url
		)
	}

	function formatBytes(bytes) {
		if (!bytes && bytes !== 0) return null
		const units = ['B', 'KB', 'MB', 'GB', 'TB']
		let b = bytes
		let u = 0
		while (b >= 1024 && u < units.length - 1) {
			b /= 1024
			u++
		}
		return `${b.toFixed(b >= 10 || u === 0 ? 0 : 1)}${units[u]}`
	}

	function formatEta(seconds) {
		if (!isFinite(seconds) || seconds <= 0) return null
		if (seconds > 48 * 3600) return '>48h'
		const m = Math.floor(seconds / 60)
		const s = Math.floor(seconds % 60)
		if (m > 90) return `${Math.round(m / 60)}h`
		if (m > 0) return `${m}m ${s.toString().padStart(2, '0')}s`
		return `${s}s`
	}

	function renderQueueList(container, items) {
		if (!container) return
		container.innerHTML = ''
		if (!items || items.length === 0) {
			container.classList.add('empty')
			container.textContent = `No active items`
			return
		}
		container.classList.remove('empty')
		items.slice(0, 50).forEach((item) => {
			const row = document.createElement('div')
			row.className = 'queue-item'
			const header = document.createElement('div')
			header.className = 'queue-item-header'

			const path = document.createElement('div')
			path.className = 'queue-item-path'
			path.textContent = item.path || item.key || 'unknown'
			header.appendChild(path)

			const state = document.createElement('span')
			state.className = 'status-badge'
			state.textContent = item.state?.toUpperCase?.() || 'PENDING'
			header.appendChild(state)
			row.appendChild(header)

			const meta = document.createElement('div')
			meta.className = 'queue-item-meta'
			const pct = computeProgress(item).toFixed(1)
			const parts = [`${pct}%`]
			if (item.uploadedBytes && item.size) {
				const bytesText = `${formatBytes(item.uploadedBytes)} / ${formatBytes(item.size)}`
				parts.push(bytesText)
				if (item.speedBytesPerSec && item.speedBytesPerSec > 1024) {
					const remaining = Math.max(0, item.size - item.uploadedBytes)
					const eta = formatEta(remaining / item.speedBytesPerSec)
					if (eta) parts.push(`ETA ${eta}`)
					parts.push(`${formatBytes(item.speedBytesPerSec)}/s`)
				} else {
					parts.push('Stalled')
				}
			}
			if (item.conflictState && item.conflictState !== 'none') {
				parts.push(`conflict: ${item.conflictState}`)
			}
			if (item.error) {
				parts.push(`error: ${item.error}`)
			}
			if (item.updatedAt) {
				parts.push(new Date(item.updatedAt).toLocaleTimeString())
			}
			meta.innerHTML = parts.map((p) => `<span>${p}</span>`).join('')
			row.appendChild(meta)

			const progress = document.createElement('div')
			progress.className = 'queue-progress'
			progress.innerHTML = `<div class="queue-progress-bar" style="width:${Math.min(
				100,
				computeProgress(item),
			)}%"></div>`
			row.appendChild(progress)

			const actions = document.createElement('div')
			actions.className = 'queue-actions'

			const actionUploadId = item.id || item.lastUploadId
			if (actionUploadId) {
				const makeBtn = (label, action) => {
					const btn = document.createElement('button')
					btn.className = 'queue-action-btn'
					btn.textContent = label
					btn.addEventListener('click', async () => {
						try {
							await invoke('syftbox_upload_action', { id: actionUploadId, action })
							await refreshSyftboxQueue()
							console.info(`Upload action ${action} sent for ${item.id}`)
						} catch (err) {
							console.error(`Upload ${action} failed:`, err)
						}
					})
					return btn
				}
				actions.appendChild(makeBtn('Pause', 'pause'))
				actions.appendChild(makeBtn('Resume', 'resume'))
				actions.appendChild(makeBtn('Restart', 'restart'))
				actions.appendChild(makeBtn('Cancel', 'cancel'))
			}

			if (item.localPath || item.path) {
				const openBtn = document.createElement('button')
				openBtn.className = 'queue-action-btn'
				openBtn.textContent = 'Open'
				openBtn.addEventListener('click', async () => {
					try {
						const absPath = await resolveAbsolutePath(item)
						if (absPath) {
							await invoke('open_path_in_file_manager', { path: absPath })
						}
					} catch (err) {
						console.error('Open path failed:', err)
					}
				})
				actions.appendChild(openBtn)
			}

			if (actions.childElementCount > 0) {
				row.appendChild(actions)
			}

			container.appendChild(row)
		})
	}

	async function resolveAbsolutePath(item) {
		// Prefer explicit localPath from upload registry
		if (item.localPath) return item.localPath

		// Fall back to constructing from data_dir + datasites + path/key
		const queueStatus = window.__lastSyftboxQueueStatus
		const base = queueStatus?.data_dir
		const rel = item.path || item.key
		if (!base || !rel) return null
		return `${base.replace(/\/$/, '')}/datasites/${rel.replace(/^[/\\]?/, '')}`
	}

	function computeProgress(item, fallback = 0) {
		const size = typeof item.size === 'number' ? item.size : null
		const uploaded = typeof item.uploadedBytes === 'number' ? item.uploadedBytes : null
		if (size && uploaded !== null && size > 0) {
			return Math.min(100, Math.max(0, (uploaded / size) * 100))
		}
		if (typeof item.progress === 'number') return Math.min(100, Math.max(0, item.progress))
		return fallback
	}

	const queueStore = {
		map: new Map(),
		filter: 'active',
		upsert(item, source) {
			const key = queueKey(item)
			if (!key) return

			const existing = this.map.get(key) || {
				sources: [],
				firstSeenAt: Date.now(),
				uploadIds: [],
			}
			const sources = new Set(existing.sources || [])
			if (source) sources.add(source)
			const uploadIds = new Set(existing.uploadIds || [])
			if (item.id) uploadIds.add(item.id)

			const updatedAt =
				item.updatedAt || item.startedAt || existing.updatedAt || new Date().toISOString()
			const now = Date.now()
			const size =
				Math.max(
					typeof existing.size === 'number' ? existing.size : 0,
					typeof item.size === 'number' ? item.size : 0,
				) || undefined
			const uploaded = Math.max(
				typeof existing.uploadedBytes === 'number' ? existing.uploadedBytes : 0,
				typeof item.uploadedBytes === 'number' ? item.uploadedBytes : 0,
			)
			const effectiveProgress = computeProgress(
				{ ...item, size, uploadedBytes: uploaded },
				existing.progress || 0,
			)
			const progress = Math.max(effectiveProgress, existing.progress || 0)

			let speedBytesPerSec = existing.speedBytesPerSec
			if (
				typeof uploaded === 'number' &&
				typeof existing.lastBytes === 'number' &&
				existing.lastSeenAt
			) {
				const dt = (now - existing.lastSeenAt) / 1000
				const db = uploaded - existing.lastBytes
				if (dt > 0 && db > 0) {
					const inst = db / dt
					speedBytesPerSec = speedBytesPerSec ? speedBytesPerSec * 0.6 + inst * 0.4 : inst
				}
			}
			if (speedBytesPerSec && speedBytesPerSec < 1024) {
				speedBytesPerSec = null
			}

			let state = item.state || existing.state || 'pending'
			// Error always wins
			if (item.state === 'error' || existing.state === 'error') {
				state = 'error'
			} else if (item.state === 'completed' || existing.state === 'completed') {
				// Keep completed once reached
				state = 'completed'
			}

			// If completed but bytes/progress aren't 100%, snap to complete
			let adjustedUploaded = uploaded
			let adjustedProgress = progress
			if (state === 'completed') {
				if (size && typeof adjustedUploaded === 'number' && adjustedUploaded < size) {
					adjustedUploaded = size
				}
				adjustedProgress = 100
				speedBytesPerSec = null
			}

			const merged = {
				...existing,
				...item,
				sources: Array.from(sources),
				uploadIds: Array.from(uploadIds),
				lastUploadId: item.id || existing.lastUploadId,
				progress: adjustedProgress,
				state,
				updatedAt,
				lastSeen: Date.now(),
				firstSeenAt: existing.firstSeenAt || now,
				lastSeenAt: now,
				lastBytes: typeof adjustedUploaded === 'number' ? adjustedUploaded : existing.lastBytes,
				speedBytesPerSec,
				size,
				uploadedBytes: adjustedUploaded,
			}
			this.map.set(key, merged)
		},
		all() {
			let items = Array.from(this.map.values())
			if (this.filter === 'completed') {
				items = items.filter((i) => i.state === 'completed')
			} else {
				items = items.filter((i) => i.state !== 'completed')
			}
			// Stable order by firstSeenAt (queue order)
			items.sort((a, b) => (a.firstSeenAt || 0) - (b.firstSeenAt || 0))
			return items
		},
	}

	function queueKey(item) {
		// Deduplicate primarily by path/key so sync+upload entries collapse together
		return (
			item.path ||
			item.key ||
			item.localPath ||
			item.id ||
			JSON.stringify({ path: item.path, key: item.key })
		)
	}

	async function refreshSyftboxQueue(showErrors = false) {
		const statusEl = document.getElementById('syftbox-queue-status')
		if (statusEl) statusEl.textContent = 'Loading...'
		try {
			const data = await invoke('syftbox_queue_status')
			window.__lastSyftboxQueueStatus = data
			const sync = data?.sync || { files: [], summary: null }
			const uploads = data?.uploads || []

			;(sync.files || []).forEach((f) => queueStore.upsert(f, 'sync'))
			;(uploads || []).forEach((u) => queueStore.upsert(u, 'upload'))

			if (statusEl) {
				statusEl.textContent = data?.control_plane_url
					? `Connected: ${data.control_plane_url}`
					: 'Connected'
			}

			const summary = sync?.summary || { pending: 0, syncing: 0, completed: 0, error: 0 }
			const setText = (id, val) => {
				const el = document.getElementById(id)
				if (el) el.textContent = val
			}
			setText('syftbox-summary-pending', summary.pending || 0)
			setText('syftbox-summary-syncing', summary.syncing || 0)
			setText('syftbox-summary-completed', summary.completed || 0)
			setText('syftbox-summary-error', summary.error || 0)

			renderSyftboxQueue()
		} catch (error) {
			console.error('Failed to load SyftBox queue:', error)
			if (statusEl) statusEl.textContent = 'Unavailable'
			if (showErrors) {
				await dialog.message(
					'SyftBox control plane is unavailable. Start the daemon and try again.',
					{ title: 'SyftBox', type: 'warning' },
				)
			}
			const empty = (id, msg) => {
				const el = document.getElementById(id)
				if (el) {
					el.classList.add('empty')
					el.textContent = msg
				}
			}
			empty('syftbox-queue-list', 'No data')
		}
	}

	function renderSyftboxQueue() {
		const combined = queueStore.all()
		const countLabel =
			queueStore.filter === 'completed'
				? `${combined.length} completed`
				: `${combined.length} in progress`
		const countEl = document.getElementById('syftbox-queue-count')
		if (countEl) countEl.textContent = countLabel
		renderQueueList(document.getElementById('syftbox-queue-list'), combined)
	}

	return {
		loadSettings,
		checkSyftBoxStatus,
		handleSyftBoxAuthentication,
		getCurrentUserEmail,
		getSyftboxStatus,
		setSyftboxStatus,
		saveSettings: saveSettingsChanges,
	}
}
