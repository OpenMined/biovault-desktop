/**
 * Messages Module - Modern Messaging Interface
 * Handles secure peer-to-peer messaging via SyftBox
 */
import { createContactAutocomplete } from './contact-autocomplete.js'

export function createMessagesModule({
	invoke,
	getCurrentUserEmail,
	getSyftboxStatus,
	setSyftboxStatus,
	_getActiveView,
	listen,
	dialog,
}) {
	// ============================================================================
	// STATE
	// ============================================================================

	const getActiveView = _getActiveView || (() => '')

	let messageThreads = []
	let activeThreadId = null
	let messageReplyTargetId = null
	let isComposingNewMessage = false
	let messagesAuthorized = false
	let messagesInitialized = false
	let messagesRefreshInterval = null
	let messagesRefreshInProgress = false
	let threadActivityMap = new Map()
	let hasActivityBaseline = false
	let notificationPermission = 'default'
	let messageSyncUnlisten = null
	let notificationApiPromise = null
	let searchTerm = ''

	const AUTO_REFRESH_MS = 10000
	const NO_SUBJECT_PLACEHOLDER = '(No Subject)'
	const contactAutocomplete = createContactAutocomplete({ invoke, getCurrentUserEmail })

	// ============================================================================
	// UTILITIES
	// ============================================================================

	async function confirmWithDialog(message, options = {}) {
		if (dialog?.confirm) {
			return await dialog.confirm(message, options)
		}
		return window.confirm(message)
	}

	function escapeHtml(value) {
		if (value === undefined || value === null) return ''
		const div = document.createElement('div')
		div.textContent = value
		return div.innerHTML
	}

	function formatDateTime(value) {
		if (!value) return ''
		const date = new Date(value)
		if (Number.isNaN(date.getTime())) return value

		const now = new Date()
		const diff = now - date
		const oneDay = 24 * 60 * 60 * 1000

		// Today - show time only
		if (diff < oneDay && date.getDate() === now.getDate()) {
			return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
		}

		// Yesterday
		const yesterday = new Date(now - oneDay)
		if (date.getDate() === yesterday.getDate()) {
			return 'Yesterday'
		}

		// Within a week - show day name
		if (diff < 7 * oneDay) {
			return date.toLocaleDateString([], { weekday: 'short' })
		}

		// Older - show date
		return date.toLocaleDateString([], { month: 'short', day: 'numeric' })
	}

	function formatFullDateTime(value) {
		if (!value) return ''
		const date = new Date(value)
		if (Number.isNaN(date.getTime())) return value
		return date.toLocaleString([], {
			month: 'short',
			day: 'numeric',
			hour: '2-digit',
			minute: '2-digit',
		})
	}

	function formatDateSeparator(value) {
		if (!value) return ''
		const date = new Date(value)
		if (Number.isNaN(date.getTime())) return ''

		const now = new Date()
		const today = new Date(now.getFullYear(), now.getMonth(), now.getDate())
		const yesterday = new Date(today.getTime() - 24 * 60 * 60 * 1000)
		const msgDate = new Date(date.getFullYear(), date.getMonth(), date.getDate())

		if (msgDate.getTime() === today.getTime()) {
			return 'Today'
		}
		if (msgDate.getTime() === yesterday.getTime()) {
			return 'Yesterday'
		}

		// Within last week
		const weekAgo = new Date(today.getTime() - 7 * 24 * 60 * 60 * 1000)
		if (msgDate >= weekAgo) {
			return date.toLocaleDateString([], { weekday: 'long' })
		}

		// Older
		return date.toLocaleDateString([], { weekday: 'long', month: 'short', day: 'numeric' })
	}

	function getDateKey(value) {
		if (!value) return ''
		const date = new Date(value)
		if (Number.isNaN(date.getTime())) return ''
		return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`
	}

	function normalizeMetadata(value) {
		if (!value) return null
		if (typeof value === 'string') {
			try {
				return JSON.parse(value)
			} catch (error) {
				console.warn('Failed to parse metadata string', error)
				return null
			}
		}
		return value
	}

	function getInitials(email) {
		if (!email) return '?'
		const name = email.split('@')[0]
		const parts = name.split(/[._-]/)
		if (parts.length >= 2) {
			return (parts[0][0] + parts[1][0]).toUpperCase()
		}
		return name.slice(0, 2).toUpperCase()
	}

	function normalizeEmail(email) {
		if (!email) return ''
		return String(email).toLowerCase().trim()
	}

	function emailsMatch(email1, email2) {
		return normalizeEmail(email1) === normalizeEmail(email2)
	}

	function getSessionInviteFromMessage(msg) {
		if (!msg) return null
		const meta = normalizeMetadata(msg.metadata)
		if (!meta || !meta.session_invite) return null
		const invite = meta.session_invite
		if (!invite.session_id) return null
		return {
			session_id: invite.session_id,
			session_name: invite.session_name || 'Session',
			from: invite.from || msg.from,
			description: invite.description,
			created_at: invite.created_at,
		}
	}

	// ============================================================================
	// UI UPDATES
	// ============================================================================

	function collectParticipants(messages) {
		const set = new Set()
		messages.forEach((msg) => {
			if (msg.from) set.add(normalizeEmail(msg.from))
			if (msg.to) set.add(normalizeEmail(msg.to))
		})
		return Array.from(set)
	}

	function formatParticipants(participants) {
		if (!participants || participants.length === 0) return ''
		const currentUserEmail = getCurrentUserEmail()
		const others = participants.filter((p) => !emailsMatch(p, currentUserEmail))
		return others.length > 0 ? others.join(', ') : participants.join(', ')
	}

	function resolveSubject(summary, messages) {
		const summarySubject = summary?.subject || ''
		const hasRealSubject =
			summarySubject &&
			summarySubject.trim().length > 0 &&
			summarySubject !== NO_SUBJECT_PLACEHOLDER
		if (hasRealSubject) return summarySubject

		const firstWithSubject = (messages || []).find(
			(msg) => msg?.subject && msg.subject.trim().length > 0,
		)
		return firstWithSubject?.subject || NO_SUBJECT_PLACEHOLDER
	}

	function updateConnectionStatus() {
		const toggle = document.getElementById('message-syftbox-toggle')
		const statusWrapper = document.getElementById('msg-connection-wrapper')

		const syftboxStatus = getSyftboxStatus()
		const isOnline = syftboxStatus.running

		if (toggle) {
			toggle.checked = isOnline
			toggle.disabled = !messagesAuthorized
		}

		// Add class to wrapper for enhanced styling
		if (statusWrapper) {
			statusWrapper.classList.toggle('is-online', isOnline)
		}
	}

	function updateConversationAvatar(participants, isSelfThread = false) {
		const avatarEl = document.getElementById('msg-conv-avatar')
		if (!avatarEl) return

		const currentUserEmail = getCurrentUserEmail()
		const others = (participants || []).filter((p) => !emailsMatch(p, currentUserEmail))
		const primaryEmail = others[0] || (participants && participants[0]) || ''

		const span = avatarEl.querySelector('span')
		if (span) {
			if (isSelfThread) {
				span.textContent = '📝'
			} else {
				span.textContent = getInitials(primaryEmail)
			}
		}

		// Update avatar style for self-threads
		if (isSelfThread) {
			avatarEl.classList.add('self-avatar')
		} else {
			avatarEl.classList.remove('self-avatar')
		}
	}

	function updateComposeVisibility(showRecipient) {
		const recipientContainer = document.querySelector(
			'.msg-compose-recipient, .message-compose-recipient',
		)
		const subjectWrapper = document.getElementById('message-subject-wrapper')

		if (recipientContainer) {
			recipientContainer.style.display = showRecipient ? 'flex' : 'none'
		}
		if (subjectWrapper) {
			subjectWrapper.style.display = showRecipient ? 'flex' : 'none'
		}
	}

	function updateMessagesEmptyState() {
		const mainEl = document.getElementById('messages-main')
		const emptyEl = document.getElementById('messages-empty-state')
		const deleteThreadBtn = document.getElementById('delete-thread-btn')

		if (!mainEl || !emptyEl) return

		if (!messagesAuthorized) {
			mainEl.style.display = 'none'
			emptyEl.style.display = 'none'
			if (deleteThreadBtn) deleteThreadBtn.style.display = 'none'
			return
		}

		if (activeThreadId || isComposingNewMessage) {
			mainEl.style.display = 'flex'
			emptyEl.style.display = 'none'
		} else if (!messageThreads.length) {
			mainEl.style.display = 'none'
			emptyEl.style.display = 'flex'
		} else {
			mainEl.style.display = 'none'
			emptyEl.style.display = 'flex'
		}

		if (deleteThreadBtn) {
			deleteThreadBtn.style.display = activeThreadId ? 'flex' : 'none'
		}
	}

	// ============================================================================
	// NOTIFICATIONS
	// ============================================================================

	async function getNotificationApi() {
		if (notificationApiPromise) return notificationApiPromise
		notificationApiPromise = (async () => {
			// First try the dynamic import (preferred)
			try {
				const mod = await import('@tauri-apps/plugin-notification')
				if (mod?.sendNotification) {
					console.log('🔔 Using @tauri-apps/plugin-notification module')
					return mod
				}
			} catch (err) {
				console.log('🔔 Dynamic import failed, trying window.__TAURI__:', err?.message)
			}

			// Fallback to window.__TAURI__.notification (works in some setups)
			if (typeof window !== 'undefined' && window.__TAURI__?.notification) {
				console.log('🔔 Using window.__TAURI__.notification API')
				return window.__TAURI__.notification
			}

			console.log('🔔 No Tauri notification API available')
			return null
		})()
		return notificationApiPromise
	}

	async function ensureNotificationPermission() {
		console.log('🔔 Checking notification permission...')
		try {
			const api = await getNotificationApi()
			console.log('🔔 Tauri notification API:', {
				available: !!api,
				hasIsPermissionGranted: !!api?.isPermissionGranted,
			})
			if (api?.isPermissionGranted) {
				const granted = await api.isPermissionGranted()
				console.log('🔔 Tauri permission status:', granted)
				if (granted) {
					notificationPermission = 'granted'
					return true
				}
				if (api.requestPermission) {
					console.log('🔔 Requesting Tauri notification permission...')
					const permission = await api.requestPermission()
					console.log('🔔 Tauri permission response:', permission)
					notificationPermission = permission
					return permission === 'granted'
				}
			}
		} catch (error) {
			console.warn('🔔 Tauri notification permission failed:', error)
		}

		if (typeof Notification === 'undefined') {
			console.log('🔔 Browser Notification API not available')
			return false
		}
		if (notificationPermission === 'granted') {
			console.log('🔔 Browser notification already granted')
			return true
		}

		try {
			console.log('🔔 Requesting browser notification permission...')
			notificationPermission = await Notification.requestPermission()
			console.log('🔔 Browser permission response:', notificationPermission)
		} catch (error) {
			console.error('🔔 Browser notification permission error:', error)
			notificationPermission = 'denied'
		}
		return notificationPermission === 'granted'
	}

	async function showSystemNotification(thread) {
		console.log('🔔 showSystemNotification called', {
			thread_id: thread?.thread_id,
			subject: thread?.subject,
		})
		if (!thread) {
			console.log('🔔 No thread provided, skipping notification')
			return
		}

		const granted = await ensureNotificationPermission()
		console.log('🔔 Notification permission granted:', granted)
		if (!granted) {
			console.log('🔔 Permission not granted, skipping notification')
			return
		}

		const participants = formatParticipants(thread.participants || [])
		const bodyParts = []
		if (participants) bodyParts.push(participants)
		if (thread.last_message_preview) bodyParts.push(thread.last_message_preview)
		const body = bodyParts.join(' • ')

		// WhatsApp notification (silent fail if not configured)
		try {
			const subject = thread.subject || 'New BioVault message'
			await invoke('whatsapp_send_notification', { message: `📬 ${subject}\n${body}` })
		} catch (_) {
			// Ignore
		}

		const identifier = thread.thread_id || thread.subject || 'biovault-message'

		// AppleScript notification - most reliable in dev mode on macOS
		// (Tauri plugin and mac-notification-sys both fail silently in dev mode)
		const title = thread.subject || 'New message'
		try {
			console.log('🔔 Sending AppleScript notification...', { title, body })
			await invoke('send_notification_applescript', { title, body })
			console.log('🔔 AppleScript notification sent successfully')
		} catch (err) {
			console.log('🔔 AppleScript notification failed:', err)

			// Fallback to mac-notification-sys (may work in production builds)
			try {
				console.log('🔔 Trying mac-notification-sys fallback...')
				await invoke('send_native_notification', { title, body })
				console.log('🔔 mac-notification-sys notification sent')
			} catch (nativeErr) {
				console.log('🔔 mac-notification-sys also failed:', nativeErr)
			}
		}

		// Browser notification for click handling
		try {
			console.log('🔔 Creating browser notification')
			const notif = new Notification(thread.subject || 'New message', {
				body,
				tag: identifier,
				data: { threadId: thread.thread_id },
			})

			notif.onclick = () => {
				window.focus()
				if (typeof window.navigateTo === 'function') {
					window.navigateTo('messages')
				}
				openThread(thread.thread_id)
				notif.close()
			}
			console.log('🔔 Browser notification created')
		} catch (err) {
			console.error('🔔 Browser notification error:', err)
		}
	}

	// ============================================================================
	// MESSAGE SYNC
	// ============================================================================

	async function handleIncomingMessageSync(payload = {}) {
		const currentView = getActiveView?.() || ''
		const emitToasts = currentView !== 'messages'
		console.log('🔔 handleIncomingMessageSync:', { payload, currentView, emitToasts })

		try {
			await loadMessageThreads(true, { emitToasts })
			if (activeThreadId && !isComposingNewMessage) {
				await openThread(activeThreadId, { preserveComposeDraft: true })
			}
		} catch (error) {
			console.error('Failed to refresh messages after RPC activity:', error, payload)
		}
	}

	function setupMessageSyncListener() {
		if (!listen || messageSyncUnlisten) return
		console.log('🔔 Setting up message sync listener...')

		listen('messages:rpc-activity', async ({ payload }) => {
			console.log('🔔 messages:rpc-activity event received:', payload)
			await handleIncomingMessageSync(payload)
		})
			.then((unlisten) => {
				messageSyncUnlisten = unlisten
				console.log('🔔 Message sync listener registered successfully')
			})
			.catch((error) => {
				console.warn('Failed to register message sync listener', error)
			})
	}

	function setupSearchListener() {
		const searchInput = document.getElementById('msg-search')
		if (!searchInput) return

		searchInput.addEventListener('input', (e) => {
			searchTerm = e.target.value.trim()
			renderMessageThreads()
		})
	}

	// ============================================================================
	// AUTHORIZATION
	// ============================================================================

	async function ensureMessagesAuthorization() {
		try {
			const devModeInfo = await invoke('get_dev_mode_info').catch(() => ({ dev_mode: false }))
			if (devModeInfo.dev_mode && devModeInfo.dev_syftbox) {
				messagesAuthorized = true
				setSyftboxStatus({ running: true, mode: 'Dev' })
			} else {
				let skipAuthFlag = false
				try {
					const skipAuth = await invoke('get_env_var', { key: 'SYFTBOX_AUTH_ENABLED' })
					skipAuthFlag = ['0', 'false', 'no'].includes((skipAuth || '').toLowerCase())
				} catch (_) {
					skipAuthFlag = false
				}

				if (skipAuthFlag) {
					messagesAuthorized = true
					setSyftboxStatus({ running: true, mode: 'Online' })
				} else {
					messagesAuthorized = await invoke('check_syftbox_auth')
				}
			}
		} catch (error) {
			console.error('Failed to check SyftBox authorization:', error)
			messagesAuthorized = false
		}

		const warningEl = document.getElementById('messages-syftbox-warning')
		const layoutEl = document.querySelector('.msg-layout, .messages-container')

		if (warningEl) {
			warningEl.style.display = messagesAuthorized ? 'none' : 'flex'
		}
		if (layoutEl) {
			layoutEl.style.display = messagesAuthorized ? 'flex' : 'none'
		}

		if (!messagesAuthorized) {
			setSyftboxStatus({ running: false, mode: 'Direct' })
			threadActivityMap = new Map()
			hasActivityBaseline = false
			stopMessagesAutoRefresh()
		} else {
			const syftboxStatus = getSyftboxStatus()
			// Auto-connect to online if authorized but not currently running
			if (!syftboxStatus.running) {
				try {
					// Attempt to start SyftBox client automatically
					const status = await invoke('start_syftbox_client')
					setSyftboxStatus(status)
					if (status.running) {
						startMessagesAutoRefresh(true)
						ensureNotificationPermission()
					}
				} catch (error) {
					console.warn('Auto-connect to SyftBox failed:', error)
					// Continue without auto-connect, user can manually enable
				}
			} else {
				startMessagesAutoRefresh(true)
				ensureNotificationPermission()
			}
		}

		updateConnectionStatus()
		updateMessagesEmptyState()

		return messagesAuthorized
	}

	async function refreshSyftboxState() {
		if (!messagesAuthorized) {
			setSyftboxStatus({ running: false, mode: 'Direct' })
			updateConnectionStatus()
			return
		}

		try {
			const devModeInfo = await invoke('get_dev_mode_info').catch(() => ({ dev_mode: false }))
			if (devModeInfo.dev_mode && devModeInfo.dev_syftbox) {
				setSyftboxStatus({ running: true, mode: 'Dev' })
			} else {
				const status = await invoke('get_syftbox_state')
				setSyftboxStatus(status)
			}
		} catch (error) {
			console.error('Failed to fetch SyftBox state:', error)
			setSyftboxStatus({ running: false, mode: 'Direct' })
		}

		updateConnectionStatus()
	}

	function updateSyftboxIndicator() {
		updateConnectionStatus()

		if (messagesAuthorized && getSyftboxStatus().running) {
			startMessagesAutoRefresh()
		} else if (!getSyftboxStatus().running) {
			stopMessagesAutoRefresh()
		}
	}

	// ============================================================================
	// THREAD MANAGEMENT
	// ============================================================================

	function updateThreadActivity(threads, emitToasts = true) {
		const nextMap = new Map()
		const canToast = emitToasts && hasActivityBaseline
		console.log('🔔 updateThreadActivity:', {
			emitToasts,
			hasActivityBaseline,
			canToast,
			threadCount: threads?.length,
		})

		threads.forEach((thread) => {
			if (!thread || !thread.thread_id) return
			const ts = thread.last_message_at ? Date.parse(thread.last_message_at) || 0 : 0
			nextMap.set(thread.thread_id, ts)

			if (!canToast) return
			const previous = threadActivityMap.get(thread.thread_id) || 0
			if (ts > previous) {
				console.log('🔔 New activity detected for thread:', {
					thread_id: thread.thread_id,
					ts,
					previous,
					subject: thread.subject,
				})
				showSystemNotification(thread)
			}
		})

		threadActivityMap = nextMap
		hasActivityBaseline = true
	}

	function startMessagesAutoRefresh(immediate = false) {
		if (messagesRefreshInterval) return
		if (!messagesAuthorized) return

		messagesRefreshInterval = setInterval(() => {
			if (!messagesAuthorized) return
			const syftboxStatus = getSyftboxStatus()
			if (!syftboxStatus.running) return
			loadMessageThreads(true, { emitToasts: true }).catch(console.error)
		}, AUTO_REFRESH_MS)

		if (immediate) {
			const syftboxStatus = getSyftboxStatus()
			loadMessageThreads(syftboxStatus.running, {
				emitToasts: hasActivityBaseline && syftboxStatus.running,
			}).catch(console.error)
		}
	}

	function stopMessagesAutoRefresh() {
		if (messagesRefreshInterval) {
			clearInterval(messagesRefreshInterval)
			messagesRefreshInterval = null
		}
	}

	async function loadMessageThreads(refresh = false, options = {}) {
		const { emitToasts = true } = options
		if (!messagesAuthorized) return
		if (messagesRefreshInProgress) return
		messagesRefreshInProgress = true

		const list = document.getElementById('message-list')
		if (list && !list.innerHTML.trim()) {
			list.innerHTML = '<div class="message-thread-empty">Loading...</div>'
		}

		try {
			if (refresh) {
				await invoke('sync_messages')
			}

			const result = await invoke('list_message_threads', { filter: 'all' })
			messageThreads = result || []

			updateThreadActivity(messageThreads, emitToasts)
			renderMessageThreads()
		} catch (error) {
			console.error('Failed to load message threads:', error)
			if (list) {
				list.innerHTML = '<div class="message-thread-empty">Failed to load</div>'
			}
		} finally {
			messagesRefreshInProgress = false
		}
	}

	function renderMessageThreads() {
		const list = document.getElementById('message-list')
		if (!list) return

		// Filter threads based on search term
		const filteredThreads = searchTerm
			? messageThreads.filter((thread) => {
					const term = searchTerm.toLowerCase()
					const subject = (thread.subject || '').toLowerCase()
					const preview = (thread.last_message_preview || '').toLowerCase()
					const participants = (thread.participants || []).join(' ').toLowerCase()
					return subject.includes(term) || preview.includes(term) || participants.includes(term)
				})
			: messageThreads

		if (filteredThreads.length === 0) {
			list.innerHTML = `
				<div class="message-thread-empty">
					<p>${searchTerm ? 'No matching conversations' : 'No conversations yet'}</p>
				</div>
			`
			return
		}

		list.innerHTML = ''
		const currentUserEmail = getCurrentUserEmail()

		filteredThreads.forEach((thread) => {
			const item = document.createElement('div')
			item.className = 'message-thread-item'

			if (thread.thread_id === activeThreadId) {
				item.classList.add('active')
			}
			if (thread.unread_count && thread.unread_count > 0) {
				item.classList.add('unread')
			}

			const participants = thread.participants || []
			const others = participants.filter((p) => !emailsMatch(p, currentUserEmail))

			// Check if this is a self-message thread (only participant is current user)
			const isSelfThread =
				participants.length === 1 && emailsMatch(participants[0], currentUserEmail)
			const displayName = isSelfThread
				? '📝 Note to Self'
				: others.length > 0
					? others.join(', ')
					: participants.join(', ')

			const displaySubject =
				thread.subject && thread.subject.trim().length > 0 ? thread.subject : NO_SUBJECT_PLACEHOLDER

			if (isSelfThread) {
				item.classList.add('self-thread')
			}
			if (thread.session_id) {
				item.classList.add('session-thread')
			}

			// Session badge takes priority if present
			const sessionBadge = thread.session_id
				? `<span class="message-thread-session" title="${escapeHtml(
						thread.session_name || 'Session',
					)}">
					<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
						<path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"></path>
						<circle cx="9" cy="7" r="4"></circle>
						<path d="M23 21v-2a4 4 0 0 0-3-3.87"></path>
						<path d="M16 3.13a4 4 0 0 1 0 7.75"></path>
					</svg>
					Session
				</span>`
				: ''
			const projectBadge =
				!thread.session_id && thread.has_project
					? '<span class="message-thread-project">Project</span>'
					: ''

			item.innerHTML = `
				<div class="message-thread-top">
					<div class="message-thread-header">${escapeHtml(displayName) || '(No participants)'}</div>
					${
						thread.unread_count > 0
							? `<span class="message-thread-unread">${
									thread.unread_count > 9 ? '9+' : thread.unread_count
								}</span>`
							: ''
					}
					${sessionBadge}
					${projectBadge}
				</div>
				<div class="message-thread-subject">${escapeHtml(displaySubject)}</div>
				<div class="message-thread-preview">${escapeHtml(thread.last_message_preview || '')}</div>
				<div class="message-thread-meta">${
					thread.last_message_at ? formatDateTime(thread.last_message_at) : ''
				}</div>
			`

			item.addEventListener('click', () => openThread(thread.thread_id))
			list.appendChild(item)
		})
	}

	// ============================================================================
	// CONVERSATION
	// ============================================================================

	function renderConversation(messages) {
		const conversation = document.getElementById('message-conversation')
		if (!conversation) return

		// Use the shared renderer with full features enabled
		renderMessagesToContainer(conversation, messages, {
			compact: false,
			showSessionInvites: true,
		})
	}

	function renderProjectPanel(messages) {
		const panel = document.getElementById('message-project-panel')
		const details = document.getElementById('message-project-details')
		if (!panel || !details) return

		const projectMessage = (messages || []).find((msg) => {
			if (!msg || !msg.metadata) return false
			return msg.metadata.project
		})

		if (!projectMessage) {
			panel.style.display = 'none'
			details.innerHTML = ''
			return
		}

		const metadata = projectMessage.metadata || {}
		const project = metadata.project || {}
		const name = project.name || metadata.project_name || projectMessage.subject || 'Project'

		let html = `<p><strong>Name:</strong> ${escapeHtml(name)}</p>`
		if (metadata.project_location) {
			html += `<p><strong>Location:</strong> ${escapeHtml(metadata.project_location)}</p>`
		}
		if (project.workflow) {
			html += `<p><strong>Workflow:</strong> ${escapeHtml(project.workflow)}</p>`
		}

		details.innerHTML = html
		panel.style.display = 'block'
	}

	function getPrimaryRecipient(participants) {
		const currentUserEmail = getCurrentUserEmail()
		const others = (participants || []).filter((p) => !emailsMatch(p, currentUserEmail))
		return others[0] || (participants && participants[0]) || ''
	}

	async function openThread(threadId, options = {}) {
		if (!messagesAuthorized) return

		const { preserveComposeDraft = false } = options
		activeThreadId = threadId
		isComposingNewMessage = false
		updateComposeVisibility(false)
		updateMessagesEmptyState()

		try {
			const messages = await invoke('get_thread_messages', { threadId })
			messageReplyTargetId = messages.length ? messages[messages.length - 1].id : null

			renderConversation(messages)
			renderProjectPanel(messages)

			const summary = messageThreads.find((thread) => thread.thread_id === threadId)
			const participants = summary ? summary.participants : collectParticipants(messages)
			const currentUserEmail = getCurrentUserEmail()

			// Check if this is a self-message thread
			const isSelfThread =
				participants.length === 1 && emailsMatch(participants[0], currentUserEmail)

			const subjectText = resolveSubject(summary, messages)
			const subjectEl = document.getElementById('message-thread-subject')
			if (subjectEl) {
				if (isSelfThread) {
					subjectEl.textContent = '📝 Note to Self'
				} else {
					subjectEl.textContent =
						subjectText && subjectText.trim().length > 0 ? subjectText : NO_SUBJECT_PLACEHOLDER
				}
			}

			const participantsEl = document.getElementById('message-thread-participants')
			if (participantsEl) {
				if (isSelfThread) {
					participantsEl.textContent =
						subjectText && subjectText !== NO_SUBJECT_PLACEHOLDER ? subjectText : 'Personal notes'
				} else {
					const formatted = formatParticipants(participants)
					participantsEl.textContent = formatted || ''
				}
			}

			updateConversationAvatar(participants, isSelfThread)

			const recipientInput = document.getElementById('message-recipient-input')
			if (recipientInput) {
				recipientInput.readOnly = true
				if (!preserveComposeDraft) {
					recipientInput.value = getPrimaryRecipient(participants)
				}
			}

			const subjectInput = document.getElementById('message-compose-subject')
			if (subjectInput && !preserveComposeDraft) {
				subjectInput.value = ''
			}

			const bodyInput = document.getElementById('message-compose-body')
			if (bodyInput && !preserveComposeDraft) {
				bodyInput.value = ''
				bodyInput.focus()
			}

			renderMessageThreads()
		} catch (error) {
			console.error('Failed to open thread:', error)
		}

		updateMessagesEmptyState()
	}

	function startNewMessage(prefillRecipient = null) {
		isComposingNewMessage = true
		activeThreadId = null
		messageReplyTargetId = null
		updateComposeVisibility(true)

		const subjectEl = document.getElementById('message-thread-subject')
		if (subjectEl) subjectEl.textContent = 'New Message'

		const participantsEl = document.getElementById('message-thread-participants')
		if (participantsEl) participantsEl.textContent = 'Start a new conversation'

		updateConversationAvatar([], false)

		const recipientInput = document.getElementById('message-recipient-input')
		if (recipientInput) {
			contactAutocomplete.attachToInputs(['message-recipient-input'])
			recipientInput.readOnly = false
			recipientInput.value = prefillRecipient || ''
			recipientInput.focus()
		}

		const subjectInput = document.getElementById('message-compose-subject')
		if (subjectInput) subjectInput.value = ''

		const bodyInput = document.getElementById('message-compose-body')
		if (bodyInput) bodyInput.value = ''

		const conversationDiv = document.getElementById('message-conversation')
		if (conversationDiv) conversationDiv.innerHTML = ''

		const projectPanel = document.getElementById('message-project-panel')
		if (projectPanel) projectPanel.style.display = 'none'

		renderMessageThreads()
		updateMessagesEmptyState()
	}

	// ============================================================================
	// ACTIONS
	// ============================================================================

	async function initializeMessagesTab(forceSync = false) {
		if (messagesInitialized && !forceSync) return

		contactAutocomplete.attachToInputs(['message-recipient-input'])

		await ensureMessagesAuthorization()
		await refreshSyftboxState()

		if (messagesAuthorized) {
			await loadMessageThreads(forceSync, { emitToasts: false })
		}

		// Setup search functionality
		setupSearchListener()

		messagesInitialized = true
	}

	async function sendCurrentMessage() {
		const recipientInput = document.getElementById('message-recipient-input')
		const subjectInput = document.getElementById('message-compose-subject')
		const bodyInput = document.getElementById('message-compose-body')

		const recipient = recipientInput?.value.trim()
		const subject = subjectInput?.value.trim()
		const body = bodyInput?.value.trim()

		if (!recipient) {
			alert('Please enter a recipient')
			return
		}
		if (!body) {
			alert('Please enter a message')
			return
		}

		try {
			const syftboxStatus = getSyftboxStatus()
			if (!syftboxStatus.running) {
				alert('You must be online to send messages')
				return
			}

			const sent = await invoke('send_message', {
				request: {
					to: recipient,
					subject: subject || NO_SUBJECT_PLACEHOLDER,
					body,
					reply_to: messageReplyTargetId,
				},
			})

			const threadKey = sent.thread_id || sent.id

			await loadMessageThreads(false, { emitToasts: false })
			if (threadKey) {
				await openThread(threadKey)
			} else {
				await loadMessageThreads(true, { emitToasts: false })
			}

			if (bodyInput) bodyInput.value = ''
		} catch (error) {
			console.error('Failed to send message:', error)
			alert(`Failed to send: ${error}`)
		}
	}

	async function deleteMessage(messageId) {
		if (!messageId) return

		const confirmed = await confirmWithDialog('Delete this message?', {
			title: 'Delete Message',
			type: 'warning',
		})
		if (!confirmed) return

		try {
			await invoke('delete_message', { messageId })
			await loadMessageThreads(true)
		} catch (error) {
			console.error('Failed to delete message:', error)
			alert(`Failed to delete: ${error}`)
		}
	}

	async function setSyftboxTarget(target) {
		const toggle = document.getElementById('message-syftbox-toggle')
		if (toggle) toggle.disabled = true

		try {
			if (target === 'online') {
				const status = await invoke('start_syftbox_client')
				setSyftboxStatus(status)
				await loadMessageThreads(true, { emitToasts: hasActivityBaseline })
				startMessagesAutoRefresh(true)
			} else {
				const status = await invoke('stop_syftbox_client')
				setSyftboxStatus(status)
				stopMessagesAutoRefresh()
			}
		} catch (error) {
			console.error('Failed to toggle SyftBox:', error)
			alert(`Failed to ${target === 'online' ? 'connect' : 'disconnect'}: ${error}`)
		} finally {
			if (toggle) toggle.disabled = false
		}

		updateSyftboxIndicator()
	}

	async function handleDeleteThread() {
		if (!activeThreadId) return
		if (!messagesAuthorized) {
			alert('You must be authorized to delete threads')
			return
		}

		const confirmed = await confirmWithDialog('Delete this entire conversation?', {
			title: 'Delete Conversation',
			type: 'warning',
		})
		if (!confirmed) return

		try {
			await invoke('delete_thread', { threadId: activeThreadId })
			activeThreadId = null
			messageReplyTargetId = null

			await loadMessageThreads(true, { emitToasts: false })

			if (messageThreads.length > 0) {
				await openThread(messageThreads[0].thread_id)
			} else {
				isComposingNewMessage = false
				updateMessagesEmptyState()
			}
		} catch (error) {
			console.error('Failed to delete thread:', error)
			alert(`Failed to delete: ${error}`)
		}
	}

	async function ensureMessagesAuthorizationAndStartNew() {
		try {
			const devModeInfo = await invoke('get_dev_mode_info').catch(() => ({ dev_mode: false }))
			if (devModeInfo.dev_mode && devModeInfo.dev_syftbox) {
				messagesAuthorized = true
			}
		} catch (_) {
			// Ignore
		}

		if (!messagesAuthorized) {
			await ensureMessagesAuthorization()
			if (!messagesAuthorized) return
		}
		startNewMessage()
	}

	function updateComposeVisibilityPublic(visible) {
		updateComposeVisibility(visible)
	}

	function resetActiveThread() {
		activeThreadId = null
		messageReplyTargetId = null
	}

	async function triggerTestNotification() {
		await showSystemNotification({
			thread_id: 'test-thread',
			subject: 'Test Notification',
			last_message_preview: 'This is a test notification from BioVault.',
			participants: ['demo@sandbox.local'],
		})
	}

	// Initialize sync listener
	setupMessageSyncListener()

	// ============================================================================
	// SHARED MESSAGE RENDERER (for embedding in other views like Sessions)
	// ============================================================================

	/**
	 * Render messages to any container element (SHARED RENDERER)
	 * Used by: Messages view, Session chat, and any future embedded message views
	 *
	 * @param {HTMLElement} container - The container element to render into
	 * @param {Array} messages - Array of message objects
	 * @param {Object} options - Rendering options
	 * @param {boolean} options.compact - Use compact mode (no date separators, simpler styling)
	 * @param {boolean} options.showSessionInvites - Show session invite cards (default: false in compact)
	 * @param {string} options.currentUserEmail - Override current user email
	 */
	function renderMessagesToContainer(container, messages, options = {}) {
		if (!container) return

		const { compact = false, showSessionInvites = !compact, currentUserEmail: userEmail } = options
		const currentUser = userEmail || getCurrentUserEmail()

		container.innerHTML = ''

		if (!messages || messages.length === 0) {
			container.innerHTML = `<div class="msg-embedded-empty">No messages yet</div>`
			return
		}

		// Group consecutive messages from the same sender, with date awareness
		const groups = []
		let currentGroup = null
		let lastDateKey = null

		messages.forEach((msg, index) => {
			const isOutgoing = emailsMatch(msg.from, currentUser)
			const isSelfMessage =
				emailsMatch(msg.from, msg.to) ||
				(emailsMatch(msg.from, currentUser) && emailsMatch(msg.to, currentUser))
			const senderId = normalizeEmail(msg.from) || 'unknown'
			const msgDateKey = getDateKey(msg.created_at)

			const dateChanged = msgDateKey && lastDateKey && msgDateKey !== lastDateKey
			const isFirstMessage = index === 0
			if (!currentGroup || currentGroup.senderId !== senderId || (!compact && dateChanged)) {
				currentGroup = {
					senderId,
					isOutgoing,
					isSelfMessage,
					messages: [],
					dateKey: msgDateKey,
					showDateSeparator: !compact && (isFirstMessage || dateChanged),
					dateLabel: formatDateSeparator(msg.created_at),
				}
				groups.push(currentGroup)
			}

			lastDateKey = msgDateKey
			currentGroup.messages.push({ ...msg, index })
		})

		// Render each group
		groups.forEach((group, groupIndex) => {
			// Date separator (only in non-compact mode)
			if (group.showDateSeparator && group.dateLabel) {
				const dateSep = document.createElement('div')
				dateSep.className = 'message-date-separator'
				dateSep.innerHTML = `<span>${escapeHtml(group.dateLabel)}</span>`
				container.appendChild(dateSep)
			}

			const groupDiv = document.createElement('div')
			groupDiv.className = `message-group${group.isOutgoing ? ' outgoing' : ' incoming'}${
				group.isSelfMessage ? ' self-note' : ''
			}${compact ? ' compact' : ''}`

			// Group header (sender name) - only for incoming non-self messages
			if (!compact && !group.isOutgoing && !group.isSelfMessage) {
				const groupHeader = document.createElement('div')
				groupHeader.className = 'message-group-header'
				groupHeader.textContent = group.senderId
				groupDiv.appendChild(groupHeader)
			} else if (!compact && group.isSelfMessage && groupIndex === 0) {
				// Self-note label (only in full mode, first group)
				const selfLabel = document.createElement('div')
				selfLabel.className = 'message-self-label'
				selfLabel.innerHTML = '<span>📝</span> Note to Self'
				groupDiv.appendChild(selfLabel)
			}

			// Render messages in group
			group.messages.forEach((msg, msgIndex) => {
				const isFirst = msgIndex === 0
				const isLast = msgIndex === group.messages.length - 1
				const msgDiv = document.createElement('div')

				let bubbleClass = 'message-bubble'
				if (group.isOutgoing) bubbleClass += ' outgoing'
				if (group.isSelfMessage) bubbleClass += ' self-note'
				if (compact) bubbleClass += ' compact'
				if (isFirst) bubbleClass += ' first'
				if (isLast) bubbleClass += ' last'
				if (!isFirst && !isLast) bubbleClass += ' middle'
				msgDiv.className = bubbleClass

				// Message body
				const body = document.createElement('div')
				body.className = 'message-bubble-body'
				body.textContent = msg.body || ''
				msgDiv.appendChild(body)

				// Session invite card (only if showSessionInvites is true)
				if (showSessionInvites) {
					const invite = getSessionInviteFromMessage(msg)
					if (invite) {
						const inviteCard = document.createElement('div')
						inviteCard.className = 'message-session-invite'

						const metaParts = []
						if (invite.from) metaParts.push(`From ${invite.from}`)
						if (invite.created_at) metaParts.push(formatFullDateTime(invite.created_at))

						inviteCard.innerHTML = `
							<h5>📋 ${escapeHtml(invite.session_name)}</h5>
							${metaParts.length ? `<p class="invite-meta">${escapeHtml(metaParts.join(' • '))}</p>` : ''}
							${invite.description ? `<p class="invite-meta">"${escapeHtml(invite.description)}"</p>` : ''}
						`

						const actions = document.createElement('div')
						actions.className = 'invite-actions'
						const openBtn = document.createElement('button')
						openBtn.textContent = 'Open Session'
						openBtn.addEventListener('click', () => {
							window.__SESSION_INVITE_TO_OPEN__ = invite.session_id
							window.dispatchEvent(
								new CustomEvent('session-invite-open', {
									detail: { sessionId: invite.session_id },
								}),
							)
							if (typeof window.navigateTo === 'function') {
								window.navigateTo('sessions')
							}
						})
						actions.appendChild(openBtn)
						inviteCard.appendChild(actions)
						msgDiv.appendChild(inviteCard)
					}
				}

				// Timestamp - show on last message of group
				if (isLast && msg.created_at) {
					const footer = document.createElement('div')
					footer.className = 'message-bubble-meta'
					if (compact) {
						const date = new Date(msg.created_at)
						footer.textContent = date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
					} else {
						footer.textContent = formatFullDateTime(msg.created_at)
					}
					msgDiv.appendChild(footer)
				}

				groupDiv.appendChild(msgDiv)
			})

			container.appendChild(groupDiv)
		})

		// Scroll to bottom
		setTimeout(() => {
			container.scrollTop = container.scrollHeight
		}, 50)
	}

	// ============================================================================
	// PUBLIC API
	// ============================================================================

	return {
		initializeMessagesTab,
		loadMessageThreads,
		startMessagesAutoRefresh,
		stopMessagesAutoRefresh,
		startNewMessage,
		sendCurrentMessage,
		deleteMessage,
		openThread,
		setSyftboxTarget,
		handleDeleteThread,
		ensureMessagesAuthorizationAndStartNew,
		updateComposeVisibilityPublic,
		resetActiveThread,
		getMessagesInitialized: () => messagesInitialized,
		getMessagesAuthorized: () => messagesAuthorized,
		triggerTestNotification,
		// Shared renderer for embedding in other views
		renderMessagesToContainer,
	}
}

// Global test notification helper
if (typeof window !== 'undefined') {
	window.__messagesTriggerTest__ = () => {
		try {
			if (typeof window.__messagesModule?.triggerTestNotification === 'function') {
				window.__messagesModule.triggerTestNotification()
			}
		} catch (_) {
			// ignore
		}
	}
}
