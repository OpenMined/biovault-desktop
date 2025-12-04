/**
 * WhatsApp Integration Module for BioVault Desktop
 *
 * Handles:
 * - QR code login flow
 * - Connection status display
 * - Message sending/receiving
 * - Event handling from Tauri backend
 */

export function createWhatsAppModule({ invoke, listen }) {
	let isConnected = false
	let connectedPhone = null
	let _connectedName = null
	let eventListeners = []

	// Saved notification phone from settings
	let savedNotificationPhone = ''

	// DOM element references
	const elements = {
		statusBadge: () => document.getElementById('whatsapp-status-badge'),
		setupBtn: () => document.getElementById('whatsapp-setup-btn'),
		disconnectBtn: () => document.getElementById('whatsapp-disconnect-btn'),
		qrModal: () => document.getElementById('whatsapp-qr-modal'),
		qrLoading: () => document.getElementById('whatsapp-qr-loading'),
		qrContainer: () => document.getElementById('whatsapp-qr-container'),
		qrImage: () => document.getElementById('whatsapp-qr-image'),
		connectedSuccess: () => document.getElementById('whatsapp-connected-success'),
		connectedName: () => document.getElementById('whatsapp-connected-name'),
		errorContainer: () => document.getElementById('whatsapp-error'),
		errorMessage: () => document.getElementById('whatsapp-error-message'),
		modalClose: () => document.getElementById('whatsapp-modal-close'),
		retryBtn: () => document.getElementById('whatsapp-retry-btn'),
		// Phone number setting
		notificationPhone: () => document.getElementById('whatsapp-notification-phone'),
		savePhoneBtn: () => document.getElementById('whatsapp-save-phone-btn'),
		phoneSaveStatus: () => document.getElementById('whatsapp-phone-save-status'),
		// Test section
		testMessage: () => document.getElementById('whatsapp-test-message'),
		testSendBtn: () => document.getElementById('whatsapp-test-send-btn'),
		testResult: () => document.getElementById('whatsapp-test-result'),
		// Message log
		messageLog: () => document.getElementById('whatsapp-message-log'),
		clearLogBtn: () => document.getElementById('whatsapp-clear-log-btn'),
		// Auth folder
		authPath: () => document.getElementById('whatsapp-auth-path'),
		openFolderBtn: () => document.getElementById('whatsapp-open-folder-btn'),
		resetAuthBtn: () => document.getElementById('whatsapp-reset-auth-btn'),
	}

	/**
	 * Update the status badge UI
	 */
	function updateStatusBadge(status, text) {
		const badge = elements.statusBadge()
		if (!badge) return

		badge.classList.remove('connected', 'disconnected', 'checking')

		switch (status) {
			case 'connected':
				badge.classList.add('connected')
				badge.innerHTML = `&#x2713; ${text || 'Connected'}`
				break
			case 'disconnected':
				badge.classList.add('disconnected')
				badge.innerHTML = `&#x2717; ${text || 'Not Connected'}`
				break
			case 'checking':
				badge.classList.add('checking')
				badge.innerHTML = `<span class="spinner" style="width: 12px; height: 12px; margin: 0"></span> ${text || 'Checking...'}`
				break
			default:
				badge.innerHTML = text || 'Unknown'
		}
	}

	/**
	 * Update UI based on connection state
	 */
	function updateConnectionUI() {
		const setupBtn = elements.setupBtn()
		const disconnectBtn = elements.disconnectBtn()

		if (isConnected) {
			// Check if phone is configured
			if (savedNotificationPhone) {
				updateStatusBadge('connected', 'Configured')
			} else {
				updateStatusBadge('connected', 'Connected')
			}

			if (setupBtn) setupBtn.style.display = 'none'
			if (disconnectBtn) disconnectBtn.style.display = 'inline-flex'
		} else {
			updateStatusBadge('disconnected', 'Not Connected')

			if (setupBtn) setupBtn.style.display = 'inline-flex'
			if (disconnectBtn) disconnectBtn.style.display = 'none'
		}
	}

	/**
	 * Show the QR modal
	 */
	function showQrModal() {
		const modal = elements.qrModal()
		if (!modal) return

		modal.style.display = 'flex'

		// Reset modal state
		const qrLoading = elements.qrLoading()
		const qrContainer = elements.qrContainer()
		const connectedSuccess = elements.connectedSuccess()
		const errorContainer = elements.errorContainer()

		if (qrLoading) {
			qrLoading.style.display = 'block'
			// Reset loading text
			const loadingText = qrLoading.querySelector('p')
			if (loadingText) loadingText.textContent = 'Generating QR code...'
		}
		if (qrContainer) qrContainer.style.display = 'none'
		if (connectedSuccess) connectedSuccess.style.display = 'none'
		if (errorContainer) errorContainer.style.display = 'none'
	}

	/**
	 * Show reconnecting state in modal
	 */
	function showReconnecting() {
		const qrLoading = elements.qrLoading()
		const qrContainer = elements.qrContainer()

		if (qrContainer) qrContainer.style.display = 'none'
		if (qrLoading) {
			qrLoading.style.display = 'block'
			const loadingText = qrLoading.querySelector('p')
			if (loadingText) loadingText.textContent = 'Connecting to WhatsApp...'
		}
	}

	/**
	 * Hide the QR modal
	 */
	function hideQrModal() {
		const modal = elements.qrModal()
		if (modal) modal.style.display = 'none'
	}

	/**
	 * Display the QR code
	 */
	function showQrCode(qrDataUrl) {
		const qrLoading = elements.qrLoading()
		const qrContainer = elements.qrContainer()
		const qrImage = elements.qrImage()

		if (qrLoading) qrLoading.style.display = 'none'
		if (qrContainer) qrContainer.style.display = 'block'
		if (qrImage) qrImage.src = qrDataUrl
	}

	/**
	 * Show connection success in modal
	 */
	function showConnectedSuccess(name, phone) {
		const qrLoading = elements.qrLoading()
		const qrContainer = elements.qrContainer()
		const connectedSuccess = elements.connectedSuccess()
		const connectedNameEl = elements.connectedName()

		if (qrLoading) qrLoading.style.display = 'none'
		if (qrContainer) qrContainer.style.display = 'none'
		if (connectedSuccess) connectedSuccess.style.display = 'block'
		if (connectedNameEl) {
			connectedNameEl.textContent = phone ? `${name} (${phone})` : name || 'Your WhatsApp account'
		}

		// Auto-close modal after success
		setTimeout(hideQrModal, 2000)
	}

	/**
	 * Show error in modal
	 */
	function showError(message) {
		const qrLoading = elements.qrLoading()
		const qrContainer = elements.qrContainer()
		const errorContainer = elements.errorContainer()
		const errorMessage = elements.errorMessage()

		if (qrLoading) qrLoading.style.display = 'none'
		if (qrContainer) qrContainer.style.display = 'none'
		if (errorContainer) errorContainer.style.display = 'block'
		if (errorMessage) errorMessage.textContent = message
	}

	/**
	 * Start the login flow
	 */
	async function startLogin() {
		showQrModal()

		try {
			await invoke('whatsapp_start_login')
		} catch (error) {
			console.error('Failed to start WhatsApp login:', error)
			showError(error.message || 'Failed to start login')
		}
	}

	/**
	 * Disconnect WhatsApp
	 */
	async function disconnect() {
		try {
			await invoke('whatsapp_logout')
			isConnected = false
			connectedPhone = null
			_connectedName = null
			updateConnectionUI()
		} catch (error) {
			console.error('Failed to disconnect WhatsApp:', error)
		}
	}

	/**
	 * Check initial status
	 */
	async function checkStatus() {
		updateStatusBadge('checking', 'Checking...')

		try {
			// First check if auth exists
			const hasAuth = await invoke('whatsapp_check_auth_exists')
			if (hasAuth) {
				// Request status from bridge (will emit event)
				await invoke('whatsapp_get_status')
			} else {
				isConnected = false
				updateConnectionUI()
			}
		} catch (error) {
			console.error('Failed to check WhatsApp status:', error)
			isConnected = false
			updateConnectionUI()
		}
	}

	/**
	 * Setup event listeners for WhatsApp events from Tauri
	 */
	async function setupEventListeners() {
		// QR code received
		const unlistenQr = await listen('whatsapp:qr', (event) => {
			console.log('WhatsApp QR received')
			showQrCode(event.payload.qr)
		})
		eventListeners.push(unlistenQr)

		// Connected
		const unlistenConnected = await listen('whatsapp:connected', (event) => {
			console.log('WhatsApp connected:', event.payload)
			isConnected = true
			connectedPhone = event.payload.phone
			_connectedName = event.payload.name
			updateConnectionUI()
			showConnectedSuccess(event.payload.name, event.payload.phone)
		})
		eventListeners.push(unlistenConnected)

		// Disconnected
		const unlistenDisconnected = await listen('whatsapp:disconnected', (event) => {
			console.log('WhatsApp disconnected:', event.payload)
			isConnected = false
			connectedPhone = null
			_connectedName = null
			updateConnectionUI()

			if (event.payload.reason === 'logged_out') {
				// User logged out from phone
			} else if (event.payload.reconnecting) {
				// Show reconnecting state in modal (after QR scan with 515)
				showReconnecting()
			}
		})
		eventListeners.push(unlistenDisconnected)

		// Status update
		const unlistenStatus = await listen('whatsapp:status', (event) => {
			console.log('WhatsApp status:', event.payload)
			isConnected = event.payload.connected
			connectedPhone = event.payload.phone
			_connectedName = event.payload.name
			updateConnectionUI()
		})
		eventListeners.push(unlistenStatus)

		// Error
		const unlistenError = await listen('whatsapp:error', (event) => {
			console.error('WhatsApp error:', event.payload)
			showError(event.payload.message)
		})
		eventListeners.push(unlistenError)

		// Incoming message (for notifications)
		const unlistenMessage = await listen('whatsapp:message', (event) => {
			console.log('WhatsApp message received:', event.payload)
			// Refresh the message log to show new incoming message
			loadMessageLog()
		})
		eventListeners.push(unlistenMessage)

		// Message sent confirmation
		const unlistenSent = await listen('whatsapp:sent', (event) => {
			console.log('WhatsApp message sent:', event.payload)
			const resultEl = elements.testResult()
			if (resultEl) {
				resultEl.textContent = `Sent to ${event.payload.to} (id: ${event.payload.id})`
				resultEl.style.color = '#10b981'
			}
			// Refresh the message log to show updated status
			loadMessageLog()
		})
		eventListeners.push(unlistenSent)
	}

	/**
	 * Save phone number to settings
	 */
	async function savePhoneNumber() {
		const phoneInput = elements.notificationPhone()
		const statusEl = elements.phoneSaveStatus()
		const phone = phoneInput?.value?.trim() || ''

		if (statusEl) {
			statusEl.textContent = 'Saving...'
			statusEl.style.color = '#6b7280'
		}

		try {
			// Load current settings, update phone, save
			const settings = await invoke('get_settings')
			settings.whatsapp_phone = phone
			await invoke('save_settings', { settings })

			savedNotificationPhone = phone
			updateConnectionUI() // Update status badge

			if (statusEl) {
				statusEl.textContent = phone ? 'Saved!' : 'Cleared'
				statusEl.style.color = '#10b981'
				setTimeout(() => {
					statusEl.textContent = ''
				}, 2000)
			}
		} catch (error) {
			console.error('Failed to save phone number:', error)
			if (statusEl) {
				statusEl.textContent = 'Error saving'
				statusEl.style.color = '#ef4444'
			}
		}
	}

	/**
	 * Load phone number from settings
	 */
	async function loadPhoneNumber() {
		try {
			const settings = await invoke('get_settings')
			savedNotificationPhone = settings.whatsapp_phone || ''

			const phoneInput = elements.notificationPhone()
			if (phoneInput) {
				phoneInput.value = savedNotificationPhone
			}
		} catch (error) {
			console.error('Failed to load phone number:', error)
		}
	}

	/**
	 * Load and display message log
	 */
	async function loadMessageLog() {
		try {
			const log = await invoke('whatsapp_get_message_log')
			displayMessageLog(log)
		} catch (error) {
			console.error('Failed to load message log:', error)
		}
	}

	/**
	 * Display message log in UI
	 */
	function displayMessageLog(log) {
		const logEl = elements.messageLog()
		if (!logEl) return

		if (!log || log.length === 0) {
			logEl.innerHTML = '<p style="color: #9ca3af; text-align: center;">No messages yet</p>'
			return
		}

		const html = log
			.slice()
			.reverse() // Show newest first
			.map((entry) => {
				const icon = entry.direction === 'sent' ? '↑' : '↓'
				const color = entry.direction === 'sent' ? '#3b82f6' : '#10b981'
				const statusColor =
					entry.status === 'success' ? '#10b981' : entry.status === 'error' ? '#ef4444' : '#f59e0b'
				const truncatedMsg =
					entry.message.length > 50 ? entry.message.substring(0, 50) + '...' : entry.message

				return `<div style="margin-bottom: 6px; padding: 4px; border-radius: 4px; background: white;">
					<span style="color: ${color}; font-weight: bold;">${icon}</span>
					<span style="color: #6b7280;">${entry.timestamp}</span>
					<span style="color: ${statusColor};">[${entry.status}]</span>
					<span style="color: #374151;">${entry.phone}</span>
					<br/>
					<span style="color: #4b5563; margin-left: 16px;">${truncatedMsg}</span>
				</div>`
			})
			.join('')

		logEl.innerHTML = html
	}

	/**
	 * Clear message log
	 */
	async function clearMessageLog() {
		try {
			await invoke('whatsapp_clear_message_log')
			displayMessageLog([])
		} catch (error) {
			console.error('Failed to clear message log:', error)
		}
	}

	/**
	 * Load and display auth path
	 */
	async function loadAuthPath() {
		try {
			const path = await invoke('whatsapp_get_auth_path')
			const pathEl = elements.authPath()
			if (pathEl) {
				pathEl.textContent = path
			}
		} catch (error) {
			console.error('Failed to get auth path:', error)
		}
	}

	/**
	 * Open auth folder in file explorer
	 */
	async function openAuthFolder() {
		try {
			await invoke('whatsapp_open_auth_folder')
		} catch (error) {
			console.error('Failed to open auth folder:', error)
		}
	}

	/**
	 * Reset WhatsApp credentials
	 */
	async function resetAuth() {
		if (
			!confirm(
				'This will delete your WhatsApp credentials and require re-scanning the QR code. Continue?',
			)
		) {
			return
		}

		try {
			// Shutdown bridge first
			await invoke('whatsapp_shutdown')
			// Clear credentials
			await invoke('whatsapp_reset_auth')
			// Update UI
			isConnected = false
			connectedPhone = null
			_connectedName = null
			updateConnectionUI()
			alert('Credentials reset. Click Setup to reconnect.')
		} catch (error) {
			console.error('Failed to reset auth:', error)
			alert('Failed to reset credentials: ' + error)
		}
	}

	/**
	 * Handle test send button click (uses notification API)
	 */
	async function handleTestSend() {
		const message = elements.testMessage()?.value?.trim()
		const resultEl = elements.testResult()

		if (!savedNotificationPhone) {
			if (resultEl) {
				resultEl.textContent = 'Please save your phone number first'
				resultEl.style.color = '#ef4444'
			}
			return
		}

		if (!message) {
			if (resultEl) {
				resultEl.textContent = 'Please enter a message'
				resultEl.style.color = '#ef4444'
			}
			return
		}

		if (resultEl) {
			resultEl.textContent = 'Sending...'
			resultEl.style.color = '#6b7280'
		}

		try {
			await invoke('whatsapp_send_notification', { message })
			if (resultEl) {
				resultEl.textContent = 'Notification sent! Check your WhatsApp.'
				resultEl.style.color = '#10b981'
			}
			// Refresh log after a short delay
			setTimeout(loadMessageLog, 1000)
		} catch (error) {
			console.error('Failed to send test notification:', error)
			if (resultEl) {
				resultEl.textContent = `Error: ${error.message || error}`
				resultEl.style.color = '#ef4444'
			}
		}
	}

	/**
	 * Setup UI button handlers
	 */
	function setupButtonHandlers() {
		const setupBtn = elements.setupBtn()
		const disconnectBtn = elements.disconnectBtn()
		const modalClose = elements.modalClose()
		const retryBtn = elements.retryBtn()
		const testSendBtn = elements.testSendBtn()
		const savePhoneBtn = elements.savePhoneBtn()
		const clearLogBtn = elements.clearLogBtn()
		const modal = elements.qrModal()

		if (setupBtn) {
			setupBtn.addEventListener('click', startLogin)
		}

		if (disconnectBtn) {
			disconnectBtn.addEventListener('click', disconnect)
		}

		if (modalClose) {
			modalClose.addEventListener('click', hideQrModal)
		}

		if (retryBtn) {
			retryBtn.addEventListener('click', startLogin)
		}

		if (testSendBtn) {
			testSendBtn.addEventListener('click', handleTestSend)
		}

		if (savePhoneBtn) {
			savePhoneBtn.addEventListener('click', savePhoneNumber)
		}

		if (clearLogBtn) {
			clearLogBtn.addEventListener('click', clearMessageLog)
		}

		const openFolderBtn = elements.openFolderBtn()
		if (openFolderBtn) {
			openFolderBtn.addEventListener('click', openAuthFolder)
		}

		const resetAuthBtn = elements.resetAuthBtn()
		if (resetAuthBtn) {
			resetAuthBtn.addEventListener('click', resetAuth)
		}

		// Close modal when clicking on background (not content)
		if (modal) {
			modal.addEventListener('click', (e) => {
				if (e.target === modal) hideQrModal()
			})
		}
	}

	/**
	 * Initialize the WhatsApp module
	 */
	async function init() {
		await setupEventListeners()
		setupButtonHandlers()
		await loadAuthPath()
		await loadPhoneNumber()
		await loadMessageLog()
		await checkStatus()
	}

	/**
	 * Cleanup event listeners
	 */
	function cleanup() {
		for (const unlisten of eventListeners) {
			unlisten()
		}
		eventListeners = []
	}

	/**
	 * Send a message via WhatsApp
	 */
	async function sendMessage(to, text) {
		if (!isConnected) {
			throw new Error('WhatsApp not connected')
		}

		try {
			await invoke('whatsapp_send_message', { to, text })
		} catch (error) {
			console.error('Failed to send WhatsApp message:', error)
			throw error
		}
	}

	return {
		init,
		cleanup,
		checkStatus,
		startLogin,
		disconnect,
		sendMessage,
		isConnected: () => isConnected,
		getConnectedPhone: () => connectedPhone,
	}
}
