export function createSettingsModule({ invoke, dialog, loadSavedDependencies }) {
	let currentUserEmail = ''
	let syftboxStatus = { running: false, mode: 'Direct' }

	async function loadSettings() {
		try {
			const configPath = await invoke('get_config_path').catch(() => 'Not set')
			document.getElementById('config-path-display').textContent = configPath

			const settings = await invoke('get_settings')
			document.getElementById('setting-email').value = settings.email || ''
			currentUserEmail = settings.email || ''

			loadSavedDependencies('settings-deps-list', 'settings-dep-details-panel')

			checkSyftBoxStatus()
		} catch (error) {
			console.error('Error loading settings:', error)
		}
	}

	async function checkSyftBoxStatus() {
		const statusBadge = document.getElementById('syftbox-status-badge')
		const authBtn = document.getElementById('syftbox-auth-btn')

		try {
			const configInfo = await invoke('get_syftbox_config_info')

			if (configInfo.is_authenticated) {
				statusBadge.innerHTML = `✓ Authenticated<br><span style="font-size: 11px; font-weight: normal;">Config: ${configInfo.config_path}</span>`
				statusBadge.style.background = '#d4edda'
				statusBadge.style.color = '#155724'
				statusBadge.style.border = '1px solid #c3e6cb'
				statusBadge.style.lineHeight = '1.4'
				authBtn.textContent = 'Reauthenticate'
			} else {
				statusBadge.innerHTML = `✗ Not Authenticated<br><span style="font-size: 11px; font-weight: normal;">Config: ${configInfo.config_path}</span>`
				statusBadge.style.background = '#f8d7da'
				statusBadge.style.color = '#721c24'
				statusBadge.style.border = '1px solid #f5c6cb'
				statusBadge.style.lineHeight = '1.4'
				authBtn.textContent = 'Authenticate'
			}

			authBtn.disabled = false
		} catch (error) {
			statusBadge.innerHTML = '? Status Unknown'
			statusBadge.style.background = '#fff3cd'
			statusBadge.style.color = '#856404'
			statusBadge.style.border = '1px solid #ffeaa7'
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

		const tabsBar = document.querySelector('.tabs')
		if (tabsBar) {
			tabsBar.style.display = 'none'
		}

		document.querySelectorAll('.tab-content').forEach((content) => {
			content.classList.remove('active')
			content.style.display = 'none'
		})
		document.querySelectorAll('.tab').forEach((tab) => tab.classList.remove('active'))

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
	}
}
