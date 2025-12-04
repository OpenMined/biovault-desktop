/**
 * Messages Module - Modern Messaging Interface
 * Handles secure peer-to-peer messaging via SyftBox
 */

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
	let messageFilter = 'inbox'
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

	const AUTO_REFRESH_MS = 10000
	const NO_SUBJECT_PLACEHOLDER = '(No Subject)'

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

	function setActiveMessageFilterButton(filter) {
		messageFilter = filter
		document.querySelectorAll('.msg-filter-btn, .message-filter').forEach((btn) => {
			btn.classList.toggle('active', btn.dataset.filter === filter)
		})
	}

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
		const dot = document.getElementById('msg-status-dot')
		const indicator = document.getElementById('message-syftbox-indicator')
		const dropdown = document.getElementById('message-syftbox-dropdown')

		const syftboxStatus = getSyftboxStatus()
		const isOnline = syftboxStatus.running

		if (dot) {
			dot.classList.toggle('online', isOnline)
		}

		if (indicator) {
			indicator.textContent = isOnline ? 'Online' : 'Offline'
			indicator.classList.toggle('status-online', isOnline)
			indicator.classList.toggle('status-offline', !isOnline)
		}

		if (dropdown) {
			dropdown.value = isOnline ? 'online' : 'offline'
			dropdown.disabled = !messagesAuthorized
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
		notificationApiPromise = import('@tauri-apps/plugin-notification')
			.then((mod) => mod)
			.catch(() => null)
		return notificationApiPromise
	}

	async function ensureNotificationPermission() {
		try {
			const api = await getNotificationApi()
			if (api?.isPermissionGranted) {
				const granted = await api.isPermissionGranted()
				if (granted) {
					notificationPermission = 'granted'
					return true
				}
				if (api.requestPermission) {
					const permission = await api.requestPermission()
					notificationPermission = permission
					return permission === 'granted'
				}
			}
		} catch (error) {
			console.warn('Tauri notification permission failed', error)
		}

		if (typeof Notification === 'undefined') return false
		if (notificationPermission === 'granted') return true

		try {
			notificationPermission = await Notification.requestPermission()
		} catch (error) {
			notificationPermission = 'denied'
		}
		return notificationPermission === 'granted'
	}

	async function showSystemNotification(thread) {
		if (!thread) return

		const granted = await ensureNotificationPermission()
		if (!granted) return

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

		// Native notification
		try {
			const api = await getNotificationApi()
			if (api?.sendNotification) {
				await api.sendNotification({
					title: thread.subject || 'New message',
					body,
					identifier,
				})
			}
		} catch (_) {
			// Fallback to browser
		}

		// Browser notification for click handling
		try {
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
		} catch (_) {
			// Ignore
		}
	}

	// ============================================================================
	// MESSAGE SYNC
	// ============================================================================

	async function handleIncomingMessageSync(payload = {}) {
		const currentView = getActiveView?.() || ''
		const emitToasts = currentView !== 'messages'

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

		listen('messages:rpc-activity', async ({ payload }) => {
			await handleIncomingMessageSync(payload)
		})
			.then((unlisten) => {
				messageSyncUnlisten = unlisten
			})
			.catch((error) => {
				console.warn('Failed to register message sync listener', error)
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
			if (syftboxStatus.running) {
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

		threads.forEach((thread) => {
			if (!thread || !thread.thread_id) return
			const ts = thread.last_message_at ? Date.parse(thread.last_message_at) || 0 : 0
			nextMap.set(thread.thread_id, ts)

			if (!canToast) return
			const previous = threadActivityMap.get(thread.thread_id) || 0
			if (ts > previous) {
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

			const result = await invoke('list_message_threads', { filter: messageFilter })
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

		if (messageThreads.length === 0) {
			list.innerHTML = `
				<div class="message-thread-empty">
					<p>No conversations yet</p>
				</div>
			`
			return
		}

		list.innerHTML = ''
		const currentUserEmail = getCurrentUserEmail()

		messageThreads.forEach((thread) => {
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
					${thread.has_project ? '<span class="message-thread-project">Project</span>' : ''}
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

		conversation.innerHTML = ''
		const currentUserEmail = getCurrentUserEmail()

		// Group consecutive messages from the same sender, with date awareness
		const groups = []
		let currentGroup = null
		let lastDateKey = null

		messages.forEach((msg, index) => {
			const isOutgoing = emailsMatch(msg.from, currentUserEmail)
			const isSelfMessage =
				emailsMatch(msg.from, msg.to) ||
				(emailsMatch(msg.from, currentUserEmail) && emailsMatch(msg.to, currentUserEmail))
			const senderId = normalizeEmail(msg.from) || 'unknown'
			const msgDateKey = getDateKey(msg.created_at)

			// Start new group if sender changes, it's the first message, or date changes
			const dateChanged = msgDateKey && lastDateKey && msgDateKey !== lastDateKey
			const isFirstMessage = index === 0
			if (!currentGroup || currentGroup.senderId !== senderId || dateChanged) {
				currentGroup = {
					senderId,
					isOutgoing,
					isSelfMessage,
					messages: [],
					dateKey: msgDateKey,
					showDateSeparator: isFirstMessage || dateChanged,
					dateLabel: formatDateSeparator(msg.created_at),
				}
				groups.push(currentGroup)
			}

			lastDateKey = msgDateKey
			currentGroup.messages.push({ ...msg, index })
		})

		// Render each group
		groups.forEach((group, groupIndex) => {
			// Date separator
			if (group.showDateSeparator && group.dateLabel) {
				const dateSep = document.createElement('div')
				dateSep.className = 'message-date-separator'
				dateSep.innerHTML = `<span>${escapeHtml(group.dateLabel)}</span>`
				conversation.appendChild(dateSep)
			}

			const groupDiv = document.createElement('div')
			groupDiv.className = `message-group${group.isOutgoing ? ' outgoing' : ' incoming'}${
				group.isSelfMessage ? ' self-note' : ''
			}`

			// Group header (sender name) - only for incoming non-self messages
			if (!group.isOutgoing && !group.isSelfMessage) {
				const groupHeader = document.createElement('div')
				groupHeader.className = 'message-group-header'
				groupHeader.textContent = group.senderId
				groupDiv.appendChild(groupHeader)
			} else if (group.isSelfMessage && groupIndex === 0) {
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
				if (isFirst) bubbleClass += ' first'
				if (isLast) bubbleClass += ' last'
				if (!isFirst && !isLast) bubbleClass += ' middle'
				msgDiv.className = bubbleClass

				// Message body
				const body = document.createElement('div')
				body.className = 'message-bubble-body'
				body.textContent = msg.body || ''
				msgDiv.appendChild(body)

				// Session invite
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
							new CustomEvent('session-invite-open', { detail: { sessionId: invite.session_id } }),
						)
						if (typeof window.navigateTo === 'function') {
							window.navigateTo('sessions')
						}
					})
					actions.appendChild(openBtn)
					inviteCard.appendChild(actions)
					msgDiv.appendChild(inviteCard)
				}

				// Timestamp - only show on last message of group
				if (isLast && msg.created_at) {
					const footer = document.createElement('div')
					footer.className = 'message-bubble-meta'
					footer.textContent = formatFullDateTime(msg.created_at)
					msgDiv.appendChild(footer)
				}

				groupDiv.appendChild(msgDiv)
			})

			conversation.appendChild(groupDiv)
		})

		// Scroll to bottom smoothly
		setTimeout(() => {
			conversation.scrollTo({
				top: conversation.scrollHeight,
				behavior: 'smooth',
			})
		}, 50)
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

		await ensureMessagesAuthorization()
		await refreshSyftboxState()

		if (messagesAuthorized) {
			await loadMessageThreads(forceSync, { emitToasts: false })
		}

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
		const dropdown = document.getElementById('message-syftbox-dropdown')
		if (dropdown) dropdown.disabled = true

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
			if (dropdown) dropdown.disabled = false
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

	function getMessageFilter() {
		return messageFilter
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
		setActiveMessageFilterButton,
		setSyftboxTarget,
		handleDeleteThread,
		ensureMessagesAuthorizationAndStartNew,
		updateComposeVisibilityPublic,
		resetActiveThread,
		getMessageFilter,
		getMessagesInitialized: () => messagesInitialized,
		getMessagesAuthorized: () => messagesAuthorized,
		triggerTestNotification,
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
