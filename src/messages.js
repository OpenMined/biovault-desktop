export function createMessagesModule({
	invoke,
	getCurrentUserEmail,
	getSyftboxStatus,
	setSyftboxStatus,
	getActiveView,
	dialog,
}) {
	let messageThreads = []
	let messageFilter = 'inbox'
	let activeThreadId = null
	let messageReplyTargetId = null
	let isComposingNewMessage = false
	let messagesAuthorized = false
	let messagesInitialized = false
	let messagesRefreshInterval = null
	let messagesRefreshInProgress = false

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
			messagesAuthorized = await invoke('check_syftbox_auth')
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
			stopMessagesAutoRefresh()
		} else {
			const syftboxStatus = getSyftboxStatus()
			if (syftboxStatus.running && getActiveView() === 'messages') {
				startMessagesAutoRefresh(true)
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
			const status = await invoke('get_syftbox_state')
			setSyftboxStatus(status)
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

		if (messagesAuthorized && syftboxStatus.running && getActiveView() === 'messages') {
			startMessagesAutoRefresh()
		} else if (!syftboxStatus.running) {
			stopMessagesAutoRefresh()
		}
	}

	function startMessagesAutoRefresh(immediate = false) {
		if (messagesRefreshInterval) return
		if (!messagesAuthorized) return
		if (getActiveView() !== 'messages') return

		messagesRefreshInterval = setInterval(() => {
			if (getActiveView() !== 'messages') return
			if (!messagesAuthorized) return
			const syftboxStatus = getSyftboxStatus()
			if (!syftboxStatus.running) return
			loadMessageThreads(true).catch((error) => {
				console.error('Failed to auto refresh messages:', error)
			})
		}, 15000)

		if (immediate) {
			const syftboxStatus = getSyftboxStatus()
			if (syftboxStatus.running) {
				loadMessageThreads(true).catch((error) => {
					console.error('Failed to refresh messages:', error)
				})
			} else {
				loadMessageThreads(false).catch((error) => {
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

	async function loadMessageThreads(refresh = false) {
		if (!messagesAuthorized) return
		if (messagesRefreshInProgress) return
		messagesRefreshInProgress = true

		const list = document.getElementById('message-thread-list')
		if (list && !list.innerHTML.trim()) {
			list.innerHTML = '<div class="message-thread-empty">Loading threads...</div>'
		}

		try {
			if (refresh) {
				await invoke('sync_messages')
			}

			const result = await invoke('list_message_threads', { filter: messageFilter })
			messageThreads = result || []

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
		const list = document.getElementById('message-thread-list')
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

			const currentUserEmail = getCurrentUserEmail()
			const participants = thread.participants || []
			const others = participants.filter((p) => p !== currentUserEmail)
			const displayName = others.length > 0 ? others.join(', ') : participants.join(', ')

			const header = document.createElement('div')
			header.className = 'message-thread-header'
			header.textContent = displayName || '(No participants)'
			item.appendChild(header)

			const subject = document.createElement('div')
			subject.className = 'message-thread-subject'
			subject.textContent = thread.subject || '(No Subject)'
			item.appendChild(subject)

			const preview = document.createElement('div')
			preview.className = 'message-thread-preview'
			preview.textContent = thread.last_message_preview || ''
			item.appendChild(preview)

			const timestamp = document.createElement('div')
			timestamp.className = 'message-thread-timestamp'
			timestamp.textContent = thread.last_message_at ? formatDateTime(thread.last_message_at) : ''
			item.appendChild(timestamp)

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
			msgDiv.className = isOutgoing
				? 'message-item message-outgoing'
				: 'message-item message-incoming'

			const header = document.createElement('div')
			header.className = 'message-header'
			header.textContent = isOutgoing ? 'You' : msg.from || 'Unknown'
			msgDiv.appendChild(header)

			const body = document.createElement('div')
			body.className = 'message-body'
			body.textContent = msg.body || ''
			msgDiv.appendChild(body)

			const footer = document.createElement('div')
			footer.className = 'message-footer'
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

	async function openThread(threadId, _options = {}) {
		if (!messagesAuthorized) return

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

			const subjectText = summary ? summary.subject : messages[0]?.subject
			const subjectEl = document.getElementById('message-thread-subject')
			if (subjectEl) {
				subjectEl.textContent =
					subjectText && subjectText.trim().length > 0 ? subjectText : '(No Subject)'
			}
			const participantsEl = document.getElementById('message-thread-participants')
			if (participantsEl) {
				const formatted = formatParticipants(participants)
				participantsEl.textContent = formatted ? `Participants: ${formatted}` : ''
			}

			const recipientInput = document.getElementById('message-recipient-input')
			if (recipientInput) {
				recipientInput.value = getPrimaryRecipient(participants)
				recipientInput.readOnly = true
			}

			const subjectInput = document.getElementById('message-compose-subject')
			if (subjectInput) {
				subjectInput.value = ''
			}

			const bodyInput = document.getElementById('message-compose-body')
			if (bodyInput) {
				bodyInput.value = ''
				bodyInput.focus()
			}

			renderMessageThreads()
		} catch (error) {
			console.error('Failed to open thread:', error)
		}

		updateMessagesEmptyState()
	}

	function startNewMessage() {
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
			recipientInput.value = ''
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
			await loadMessageThreads(forceSync)
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
				await invoke('send_message', {
					to: recipient,
					subject: subject || '(No Subject)',
					body,
					replyTo: messageReplyTargetId,
				})
				await loadMessageThreads(true)

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
				await loadMessageThreads(true)
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
			await loadMessageThreads(true)
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
		if (!messagesAuthorized) {
			await ensureMessagesAuthorization()
			return
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
	}
}
