export function createSettingsModule({ invoke, dialog, loadSavedDependencies, onAiConfigUpdated }) {
	let currentUserEmail = ''
	let syftboxStatus = { running: false, mode: 'Direct' }
	let currentSettings = null

	function setSaveStatus(message, tone = 'info') {
		const statusEl = document.getElementById('settings-save-status')
		if (!statusEl) return
		statusEl.textContent = message
		statusEl.dataset.tone = tone
	}

	async function loadSettings() {
		try {
			const configPath = await invoke('get_config_path').catch(() => 'Not set')
			document.getElementById('config-path-display').textContent = configPath

			const settings = await invoke('get_settings')
			currentSettings = settings
			document.getElementById('setting-email').value = settings.email || ''
			currentUserEmail = settings.email || ''

			document.getElementById('setting-ai-url').value = settings.ai_api_url || ''
			document.getElementById('setting-ai-token').value = settings.ai_api_token || ''
			document.getElementById('setting-ai-model').value = settings.ai_model || ''
			setSaveStatus('', 'info')

			loadSavedDependencies('settings-deps-list', 'settings-dep-details-panel')

			checkSyftBoxStatus()
			loadAutostartStatus()
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

	async function checkSyftBoxStatus() {
		const statusBadge = document.getElementById('syftbox-status-badge')
		const authBtn = document.getElementById('syftbox-auth-btn')

		try {
			// Check for dev mode first
			const devModeInfo = await invoke('get_dev_mode_info').catch(() => ({ dev_mode: false }))
			const configInfo = await invoke('get_syftbox_config_info')

			// Remove all status classes
			statusBadge.classList.remove('connected', 'disconnected', 'checking')

			// In dev mode with syftbox enabled, show special status
			if (devModeInfo.dev_mode && devModeInfo.dev_syftbox) {
				statusBadge.innerHTML = `🧪 DEV MODE - Auth Disabled<br><span style="font-size: 11px; font-weight: normal;">Server: ${devModeInfo.server_url || 'localhost:8080'}</span>`
				statusBadge.classList.add('connected')
				statusBadge.style.lineHeight = '1.4'
				authBtn.textContent = 'Dev Mode Active'
				authBtn.disabled = true
				// Update syftbox status to running in dev mode
				syftboxStatus = { running: true, mode: 'Dev' }
			} else if (configInfo.is_authenticated) {
				statusBadge.innerHTML = `✓ Authenticated<br><span style="font-size: 11px; font-weight: normal;">Config: ${configInfo.config_path}</span>`
				statusBadge.classList.add('connected')
				statusBadge.style.lineHeight = '1.4'
				authBtn.textContent = 'Reauthenticate'
				authBtn.disabled = false
			} else {
				statusBadge.innerHTML = `✗ Not Authenticated<br><span style="font-size: 11px; font-weight: normal;">Config: ${configInfo.config_path}</span>`
				statusBadge.classList.add('disconnected')
				statusBadge.style.lineHeight = '1.4'
				authBtn.textContent = 'Authenticate'
				authBtn.disabled = false
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

		if (!email) {
			await dialog.message('Please enter your email address first.', {
				title: 'Email Required',
				type: 'warning',
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

		const settings = {
			...(currentSettings || {}),
			email,
			ai_api_url: aiApiUrl,
			ai_api_token: aiApiToken,
			ai_model: aiModel,
		}

		try {
			await invoke('save_settings', { settings })
			currentSettings = settings
			currentUserEmail = email
			setSaveStatus('Settings saved successfully.', 'success')
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
