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
		try {
			await getDefaultServer()
			const configPath = await invoke('get_config_path').catch(() => 'Not set')
			document.getElementById('config-path-display').textContent = configPath

			const settings = await invoke('get_settings')
			currentSettings = settings
			document.getElementById('setting-email').value = settings.email || ''
			currentUserEmail = settings.email || ''
			savedEmail = settings.email || ''
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

			checkSyftBoxStatus()
			loadAutostartStatus()
			bindKeyButtons()
			refreshKeyStatus()
			loadContacts()
		} catch (error) {
			console.error('Error loading settings:', error)
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
		try {
			const email = document.getElementById('setting-email')?.value.trim() || currentUserEmail
			const status = await invoke('key_get_status', { email: email || null })
			keyStatus = status
			vaultPath = status?.vault_path || ''
			renderKeyStatus(status)
		} catch (error) {
			console.error('Failed to load key status:', error)
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

	function bindKeyButtons() {
		if (keyHandlersBound) return

		// Main settings buttons
		const openVaultBtn = document.getElementById('key-open-vault-btn')
		const manageBtn = document.getElementById('key-manage-btn')

		openVaultBtn?.addEventListener('click', handleOpenVault)
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

			// Remove all status classes
			statusBadge.classList.remove('connected', 'disconnected', 'checking')

			// In dev mode with syftbox enabled, show special status
			if (devModeInfo.dev_mode && devModeInfo.dev_syftbox) {
				const devServer = devModeInfo.server_url || serverLabel || 'localhost:8080'
				statusBadge.innerHTML = `
					<div class="badge-line">🧪 DEV MODE - Auth Disabled</div>
					<div class="badge-subline">Server: ${devServer}</div>
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
			console.error('Error checking SyftBox status:', error)
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
