export function createMessagesModule({
	invoke,
	getCurrentUserEmail,
	getSyftboxStatus,
	setSyftboxStatus,
	_getActiveView,
	listen,
	dialog,
}) {
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
	const AUTO_REFRESH_MS = 10000
	const NO_SUBJECT_PLACEHOLDER = '(No Subject)'
	let notificationApiPromise = null

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
		return date.toLocaleString()
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

	function setActiveMessageFilterButton(filter) {
		messageFilter = filter
		document.querySelectorAll('.message-filter').forEach((btn) => {
			btn.classList.toggle('active', btn.dataset.filter === filter)
		})
	}

	function collectParticipants(messages) {
		const set = new Set()
		messages.forEach((msg) => {
			if (msg.from) set.add(msg.from)
			if (msg.to) set.add(msg.to)
		})
		return Array.from(set)
	}

	function formatParticipants(participants) {
		if (!participants || participants.length === 0) return ''
		const currentUserEmail = getCurrentUserEmail()
		const others = participants.filter((p) => p !== currentUserEmail)
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

	async function getNotificationApi() {
		if (notificationApiPromise) return notificationApiPromise
		notificationApiPromise = import('@tauri-apps/plugin-notification')
			.then((mod) => {
				console.log('[Messages] Loaded notification plugin', Object.keys(mod || {}))
				return mod
			})
			.catch((err) => {
				console.warn('[Messages] Failed to load notification plugin', err)
				return null
			})
		return notificationApiPromise
	}

	async function ensureNotificationPermission() {
		// Prefer Tauri plugin
		try {
			const api = await getNotificationApi()
			if (api?.isPermissionGranted) {
				console.log('[Messages] Using plugin permission APIs')
				const granted = await api.isPermissionGranted()
				if (granted) {
					notificationPermission = 'granted'
					console.log('[Messages] Notification permission already granted (plugin)')
					return true
				}
				if (api.requestPermission) {
					const permission = await api.requestPermission()
					notificationPermission = permission
					console.log('[Messages] Notification permission via plugin:', permission)
					return permission === 'granted'
				}
			}
			console.log('[Messages] Plugin permission API not available')
		} catch (error) {
			console.warn('Tauri notification permission failed', error)
		}

		// Fallback to browser Notification API
		if (typeof Notification === 'undefined') return false
		if (notificationPermission === 'granted') return true
		try {
			notificationPermission = await Notification.requestPermission()
			console.log('[Messages] Browser notification permission:', notificationPermission)
		} catch (error) {
			console.warn('Notification permission request failed', error)
			notificationPermission = 'denied'
		}
		return notificationPermission === 'granted'
	}

	async function showSystemNotification(thread) {
		if (!thread) return
		console.log('[Messages] Attempting system notification for thread', thread.thread_id)
		const granted = await ensureNotificationPermission()
		if (!granted) {
			console.warn('[Messages] Notification permission not granted')
			return
		}

		const participants = formatParticipants(thread.participants || [])
		const bodyParts = []
		if (participants) bodyParts.push(participants)
		if (thread.last_message_preview) bodyParts.push(thread.last_message_preview)
		const body = bodyParts.join(' • ')

		// Also send WhatsApp notification if configured
		try {
			const subject = thread.subject || 'New BioVault message'
			const whatsappMsg = `📬 ${subject}\n${body}`
			await invoke('whatsapp_send_notification', { message: whatsappMsg })
			console.log('[Messages] WhatsApp notification sent')
		} catch (error) {
			// Silently ignore if WhatsApp not configured - that's expected
			if (!error?.toString()?.includes('not configured')) {
				console.warn('[Messages] WhatsApp notification failed', error)
			}
		}

		const identifier = thread.thread_id || thread.subject || 'biovault-message'

		// Try Tauri plugin (native) first
		try {
			const api = await getNotificationApi()
			if (api?.sendNotification) {
				await api.sendNotification({
					title: thread.subject || 'New message',
					body,
					identifier,
				})
				console.log('[Messages] Native notification sent via plugin', { identifier })
				// Also attempt to focus via browser Notification for click handling
			} else {
				console.warn('[Messages] Plugin sendNotification not available')
			}
		} catch (error) {
			console.warn('Native notification failed, falling back', error)
		}

		// Browser Notification (gives us click handler for deep link)
		try {
			const notif = new Notification(thread.subject || 'New message', {
				body,
				tag: identifier,
				data: { threadId: thread.thread_id },
			})

			notif.onclick = () => {
				console.log('[Messages] Notification clicked')
				window.focus()
				if (typeof window.navigateTo === 'function') {
					window.navigateTo('messages')
				}
				openThread(thread.thread_id)
				notif.close()
			}
			console.log('[Messages] Browser notification displayed')
		} catch (error) {
			console.warn('Browser notification failed', error)
		}
	}

	async function handleIncomingMessageSync(payload = {}) {
		const currentView = getActiveView?.() || ''
		const emitToasts = currentView !== 'messages'
		try {
			// Force a sync to pick up brand-new messages immediately
			await loadMessageThreads(true, { emitToasts })
			// Refresh the open conversation if one is active so the new message appears immediately.
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

	function getPrimaryRecipient(participants) {
		const currentUserEmail = getCurrentUserEmail()
		const others = (participants || []).filter((p) => p !== currentUserEmail)
		return others[0] || (participants && participants[0]) || ''
	}

	function updateComposeVisibility(showRecipient) {
		const recipientContainer = document.querySelector('.message-compose-recipient')
		const subjectWrapper = document.getElementById('message-subject-wrapper')
		if (recipientContainer) {
			recipientContainer.style.display = showRecipient ? 'flex' : 'none'
		}
		if (subjectWrapper) {
			subjectWrapper.style.display = showRecipient ? 'block' : 'none'
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
			mainEl.style.display = 'flex'
			emptyEl.style.display = 'none'
		}

		if (deleteThreadBtn) {
			deleteThreadBtn.style.display = activeThreadId ? 'inline-flex' : 'none'
		}
	}

	async function ensureMessagesAuthorization() {
		try {
			// Check for dev mode first - if in dev mode with syftbox, treat as authorized
			const devModeInfo = await invoke('get_dev_mode_info').catch(() => ({ dev_mode: false }))
			if (devModeInfo.dev_mode && devModeInfo.dev_syftbox) {
				console.log('🧪 Messages: Dev mode detected, treating as authorized')
				messagesAuthorized = true
				// Set syftbox status to running in dev mode
				setSyftboxStatus({ running: true, mode: 'Dev' })
			} else {
				let skipAuthFlag = false
				try {
					const skipAuth = await invoke('get_env_var', { key: 'SYFTBOX_AUTH_ENABLED' })
					skipAuthFlag = ['0', 'false', 'no'].includes((skipAuth || '').toLowerCase())
				} catch (_err) {
					skipAuthFlag = false
				}
				if (skipAuthFlag) {
					console.log('🧪 Messages: SYFTBOX_AUTH_ENABLED disabled, treating as authorized')
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
		if (warningEl) {
			warningEl.style.display = messagesAuthorized ? 'none' : 'flex'
		}

		const container = document.querySelector('#messages-view .messages-container')
		if (container) {
			container.style.display = messagesAuthorized ? 'flex' : 'none'
		}

		if (!messagesAuthorized) {
			setSyftboxStatus({ running: false, mode: 'Direct' })
		}
		updateSyftboxIndicator()

		updateMessagesEmptyState()

		if (!messagesAuthorized) {
			threadActivityMap = new Map()
			hasActivityBaseline = false
			stopMessagesAutoRefresh()
		} else {
			const syftboxStatus = getSyftboxStatus()
			if (syftboxStatus.running) {
				startMessagesAutoRefresh(true)
				// Preload permission so OS toasts can be shown later
				ensureNotificationPermission()
			}
		}
		return messagesAuthorized
	}

	async function refreshSyftboxState() {
		if (!messagesAuthorized) {
			setSyftboxStatus({ running: false, mode: 'Direct' })
			updateSyftboxIndicator()
			return
		}

		try {
			// In dev mode, keep status as running/dev
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

		updateSyftboxIndicator()
	}

	function updateSyftboxIndicator() {
		const indicator = document.getElementById('message-syftbox-indicator')
		const dropdown = document.getElementById('message-syftbox-dropdown')
		if (!indicator || !dropdown) return

		const syftboxStatus = getSyftboxStatus()
		if (syftboxStatus.running) {
			indicator.textContent = 'Online'
			indicator.classList.add('status-online')
			indicator.classList.remove('status-offline')
			dropdown.value = 'online'
		} else {
			indicator.textContent = 'Offline'
			indicator.classList.add('status-offline')
			indicator.classList.remove('status-online')
			dropdown.value = 'offline'
		}

		dropdown.disabled = !messagesAuthorized

		if (messagesAuthorized && syftboxStatus.running) {
			startMessagesAutoRefresh()
		} else if (!syftboxStatus.running) {
			stopMessagesAutoRefresh()
		}
	}

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
			loadMessageThreads(true, { emitToasts: true }).catch((error) => {
				console.error('Failed to auto refresh messages:', error)
			})
		}, AUTO_REFRESH_MS)

		if (immediate) {
			const syftboxStatus = getSyftboxStatus()
			if (syftboxStatus.running) {
				loadMessageThreads(true, { emitToasts: hasActivityBaseline }).catch((error) => {
					console.error('Failed to refresh messages:', error)
				})
			} else {
				loadMessageThreads(false, { emitToasts: false }).catch((error) => {
					console.error('Failed to refresh messages:', error)
				})
			}
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
			list.innerHTML = '<div class="message-thread-empty">Loading threads...</div>'
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
				list.innerHTML = '<div class="message-thread-empty">Failed to load threads</div>'
			}
		} finally {
			messagesRefreshInProgress = false
		}
	}

	function renderMessageThreads() {
		const list = document.getElementById('message-list')
		if (!list) return

		if (messageThreads.length === 0) {
			list.innerHTML = '<div class="message-thread-empty">No threads found</div>'
			return
		}

		list.innerHTML = ''
		messageThreads.forEach((thread) => {
			const item = document.createElement('div')
			item.className = 'message-thread-item'
			if (thread.thread_id === activeThreadId) {
				item.classList.add('active')
			}
			if (thread.unread_count && thread.unread_count > 0) {
				item.classList.add('unread')
			}

			const currentUserEmail = getCurrentUserEmail()
			const participants = thread.participants || []
			const others = participants.filter((p) => p !== currentUserEmail)
			const displayName = others.length > 0 ? others.join(', ') : participants.join(', ')

			const topRow = document.createElement('div')
			topRow.className = 'message-thread-top'

			const header = document.createElement('div')
			header.className = 'message-thread-header'
			header.textContent = displayName || '(No participants)'
			topRow.appendChild(header)

			if (thread.unread_count && thread.unread_count > 0) {
				const unread = document.createElement('span')
				unread.className = 'message-thread-unread'
				unread.textContent = thread.unread_count > 9 ? '9+' : thread.unread_count
				topRow.appendChild(unread)
			}
			if (thread.has_project) {
				const projectTag = document.createElement('span')
				projectTag.className = 'message-thread-project'
				projectTag.textContent = 'Project'
				topRow.appendChild(projectTag)
			}
			item.appendChild(topRow)

			const subject = document.createElement('div')
			subject.className = 'message-thread-subject'
			const displaySubject =
				thread.subject && thread.subject.trim().length > 0 ? thread.subject : NO_SUBJECT_PLACEHOLDER
			subject.textContent = displaySubject
			item.appendChild(subject)

			const preview = document.createElement('div')
			preview.className = 'message-thread-preview'
			preview.textContent = thread.last_message_preview || ''
			item.appendChild(preview)

			const metaRow = document.createElement('div')
			metaRow.className = 'message-thread-meta'
			metaRow.textContent = thread.last_message_at ? formatDateTime(thread.last_message_at) : ''
			item.appendChild(metaRow)

			item.addEventListener('click', () => {
				openThread(thread.thread_id)
			})

			list.appendChild(item)
		})
	}

	function renderConversation(messages) {
		const conversation = document.getElementById('message-conversation')
		if (!conversation) return

		conversation.innerHTML = ''
		messages.forEach((msg) => {
			const msgDiv = document.createElement('div')
			const currentUserEmail = getCurrentUserEmail()
			const isOutgoing = msg.from === currentUserEmail
			msgDiv.className = isOutgoing ? 'message-bubble outgoing' : 'message-bubble'

			const header = document.createElement('div')
			header.className = 'message-bubble-header'
			header.textContent = isOutgoing ? 'You' : msg.from || 'Unknown'
			msgDiv.appendChild(header)

			const body = document.createElement('div')
			body.className = 'message-bubble-body'
			body.textContent = msg.body || ''
			msgDiv.appendChild(body)

			const invite = getSessionInviteFromMessage(msg)
			if (invite) {
				const inviteCard = document.createElement('div')
				inviteCard.className = 'message-session-invite'
				const metaParts = []
				if (invite.from) metaParts.push(`From ${invite.from}`)
				if (invite.created_at) metaParts.push(formatDateTime(invite.created_at))

				inviteCard.innerHTML = `
					<h5>Session invite: ${escapeHtml(invite.session_name)}</h5>
					${metaParts.length ? `<p class="invite-meta">${escapeHtml(metaParts.join(' • '))}</p>` : ''}
					${invite.description ? `<p class="invite-meta">"${escapeHtml(invite.description)}"</p>` : ''}
				`

				const actions = document.createElement('div')
				actions.className = 'invite-actions'
				const openBtn = document.createElement('button')
				openBtn.textContent = 'Open in Sessions'
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

			const footer = document.createElement('div')
			footer.className = 'message-bubble-meta'
			footer.textContent = msg.created_at ? formatDateTime(msg.created_at) : ''
			msgDiv.appendChild(footer)

			conversation.appendChild(msgDiv)
		})

		conversation.scrollTop = conversation.scrollHeight
	}

	function renderProjectPanel(messages) {
		const panel = document.getElementById('message-project-panel')
		const details = document.getElementById('message-project-details')
		if (!panel || !details) return

		const projectMessage = (messages || []).find((msg) => {
			if (!msg || !msg.metadata) return false
			if (msg.metadata.project) return true
			return false
		})

		if (!projectMessage) {
			panel.style.display = 'none'
			details.innerHTML = ''
			return
		}

		const metadata = projectMessage.metadata || {}
		const project = metadata.project || {}
		const name = project.name || metadata.project_name || projectMessage.subject || 'Project'
		const submission = metadata.project_location || metadata.submission_url || ''
		const date = metadata.date || projectMessage.created_at

		let html = ''
		html += `<p><strong>Name:</strong> ${escapeHtml(name)}</p>`
		if (submission) {
			html += `<p><strong>Submission:</strong> ${escapeHtml(submission)}</p>`
		}
		if (date) {
			html += `<p><strong>Date:</strong> ${escapeHtml(formatDateTime(date))}</p>`
		}
		if (project.workflow) {
			html += `<p><strong>Workflow:</strong> ${escapeHtml(project.workflow)}</p>`
		}
		if (Array.isArray(metadata.assets) && metadata.assets.length) {
			html += '<p><strong>Assets:</strong></p><ul>'
			metadata.assets.forEach((asset) => {
				html += `<li>${escapeHtml(asset)}</li>`
			})
			html += '</ul>'
		}

		details.innerHTML = html
		panel.style.display = 'flex'
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

			const subjectText = resolveSubject(summary, messages)
			const subjectEl = document.getElementById('message-thread-subject')
			if (subjectEl) {
				subjectEl.textContent =
					subjectText && subjectText.trim().length > 0 ? subjectText : NO_SUBJECT_PLACEHOLDER
			}
			const participantsEl = document.getElementById('message-thread-participants')
			if (participantsEl) {
				const formatted = formatParticipants(participants)
				participantsEl.textContent = formatted ? `Participants: ${formatted}` : ''
			}

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
		if (participantsEl) participantsEl.textContent = 'Compose a new message'

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
			alert('Please enter a message body')
			return
		}

		try {
			const syftboxStatus = getSyftboxStatus()
			if (syftboxStatus.running) {
				const sent = await invoke('send_message', {
					request: {
						to: recipient,
						subject: subject || '(No Subject)',
						body,
						reply_to: messageReplyTargetId,
					},
				})
				const threadKey = sent.thread_id || sent.id

				// Refresh threads from DB (no toasts) then open the thread so the message appears immediately
				await loadMessageThreads(false, { emitToasts: false })
				if (threadKey) {
					await openThread(threadKey)
				}
				// Fallback: if no thread key, at least refresh with sync
				if (!threadKey) {
					await loadMessageThreads(true, { emitToasts: false })
				}

				if (bodyInput) bodyInput.value = ''
			} else {
				alert('SyftBox must be online to send messages')
			}
		} catch (error) {
			console.error('Failed to send message:', error)
			alert(`Failed to send message: ${error}`)
		}
	}

	async function deleteMessage(messageId) {
		if (!messageId) return

		const confirmed = await confirmWithDialog('Are you sure you want to delete this message?', {
			title: 'Delete Message',
			type: 'warning',
		})
		if (!confirmed) return

		try {
			await invoke('delete_message', { messageId })
			await loadMessageThreads(true)
		} catch (error) {
			console.error('Failed to delete message:', error)
			alert(`Failed to delete message: ${error}`)
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
			alert(`Failed to ${target === 'online' ? 'start' : 'stop'} SyftBox: ${error}`)
		} finally {
			if (dropdown) dropdown.disabled = false
		}

		updateSyftboxIndicator()
	}

	async function handleDeleteThread() {
		if (!activeThreadId) return
		if (!messagesAuthorized) {
			alert('SyftBox must be authorized to manage messages.')
			return
		}
		const confirmed = await confirmWithDialog('Delete all messages in this thread?', {
			title: 'Delete Thread',
			type: 'warning',
		})
		if (!confirmed) {
			return
		}
		try {
			await invoke('delete_thread', { threadId: activeThreadId })
			activeThreadId = null
			messageReplyTargetId = null
			isComposingNewMessage = true
			updateComposeVisibility(true)
			renderConversation([])
			renderProjectPanel([])
			await loadMessageThreads(true, { emitToasts: false })
			if (messageThreads.length > 0) {
				const nextThread = messageThreads[0]
				await openThread(nextThread.thread_id)
			} else {
				startNewMessage()
			}
		} catch (error) {
			console.error('Failed to delete thread:', error)
			alert(`Failed to delete thread: ${error}`)
		}
	}

	async function ensureMessagesAuthorizationAndStartNew() {
		// In dev mode, always allow
		try {
			const devModeInfo = await invoke('get_dev_mode_info').catch(() => ({ dev_mode: false }))
			if (devModeInfo.dev_mode && devModeInfo.dev_syftbox) {
				messagesAuthorized = true
			}
		} catch (e) {
			// Ignore dev mode check errors
		}

		if (!messagesAuthorized) {
			await ensureMessagesAuthorization()
			if (!messagesAuthorized) {
				return
			}
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
			subject: 'Notification Test',
			last_message_preview: 'This is a test notification from BioVault.',
			participants: ['demo@sandbox.local'],
		})
	}

	// Wire up real-time message sync listener as soon as the module is created
	setupMessageSyncListener()

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

// Make test notification available to global listeners (e.g., event-handlers wiring)
if (typeof window !== 'undefined') {
	window.__messagesTriggerTest__ = () => {
		// messages module is initialized in main.js; safely retrieve if available
		try {
			if (typeof window.__messagesModule?.triggerTestNotification === 'function') {
				window.__messagesModule.triggerTestNotification()
			}
		} catch (_e) {
			// ignore
		}
	}
}
