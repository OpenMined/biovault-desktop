export function createSessionsModule({ invoke, dialog, getCurrentUserEmail }) {
	let sessions = []
	let activeSessionId = null
	let jupyterPollingInterval = null
	let sessionInvitations = []
	let sessionsRefreshInterval = null
	let pendingInviteFocusId = null
	let sessionMessagesInterval = null

	function formatDateTime(isoString) {
		if (!isoString) return '-'
		const date = new Date(isoString)
		return date.toLocaleString()
	}

	function formatRelativeTime(isoString) {
		if (!isoString) return '-'
		const date = new Date(isoString)
		const now = new Date()
		const diff = now - date
		const minutes = Math.floor(diff / 60000)
		const hours = Math.floor(diff / 3600000)
		const days = Math.floor(diff / 86400000)

		if (days > 0) return `${days}d ago`
		if (hours > 0) return `${hours}h ago`
		if (minutes > 0) return `${minutes}m ago`
		return 'just now'
	}

	function focusInvitationCard(sessionId) {
		if (!sessionId) return
		const card = document.querySelector(`[data-invite-id="${sessionId}"]`)
		if (card) {
			card.classList.add('highlight')
			card.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
			setTimeout(() => card.classList.remove('highlight'), 1200)
		}
	}

	async function loadSessionInvitations() {
		try {
			sessionInvitations = await invoke('get_session_invitations')
			// Drop invites for sessions we already have locally
			const existingIds = new Set(sessions.map((s) => s.session_id))
			sessionInvitations = sessionInvitations.filter((i) => !existingIds.has(i.session_id))
			renderSessionInvitations()
			if (pendingInviteFocusId) {
				focusInvitationCard(pendingInviteFocusId)
				pendingInviteFocusId = null
			}
		} catch (error) {
			console.error('Failed to load session invitations:', error)
			sessionInvitations = []
			renderSessionInvitations()
		}
	}

	function renderSessionInvitations() {
		const listEl = document.getElementById('session-invitations-list')
		if (!listEl) return

		if (!sessionInvitations.length) {
			listEl.innerHTML = '<div class="session-invitations-empty">No pending invitations</div>'
			return
		}

		listEl.innerHTML = sessionInvitations
			.map(
				(invite) => `
			<div class="session-invite-card" data-invite-id="${invite.session_id}">
				<div class="session-invite-main">
					<div>
						<p class="session-invite-eyebrow">Invitation</p>
						<h4 class="session-invite-name">${escapeHtml(invite.session_name || 'Session')}</h4>
						<p class="session-invite-meta">From ${escapeHtml(invite.requester)} • ${formatRelativeTime(
							invite.created_at,
						)}</p>
						${
							invite.description
								? `<p class="session-invite-description">${escapeHtml(invite.description)}</p>`
								: ''
						}
					</div>
					<div class="session-invite-actions">
						<button class="session-cta" data-action="accept-invite" data-session-id="${invite.session_id}">Accept</button>
						<button class="session-secondary" data-action="reject-invite" data-session-id="${invite.session_id}">Decline</button>
					</div>
				</div>
			</div>
		`,
			)
			.join('')

		listEl.querySelectorAll('[data-action="accept-invite"]').forEach((btn) => {
			btn.addEventListener('click', async () => {
				const sessionId = btn.dataset.sessionId
				await acceptInvitation(sessionId)
			})
		})

		listEl.querySelectorAll('[data-action="reject-invite"]').forEach((btn) => {
			btn.addEventListener('click', async () => {
				const sessionId = btn.dataset.sessionId
				await rejectInvitation(sessionId)
			})
		})
	}

	async function loadSessions() {
		try {
			sessions = await invoke('get_sessions')
			renderSessionList()
			if (activeSessionId) {
				const active = sessions.find((s) => s.session_id === activeSessionId)
				if (active) {
					renderSessionDetail(active)
				}
			}
		} catch (error) {
			console.error('Failed to load sessions:', error)
			sessions = []
			renderSessionList()
		}
	}

	function renderSessionList() {
		const listEl = document.getElementById('session-list')
		if (!listEl) return

		if (sessions.length === 0) {
			listEl.innerHTML = `
				<div class="session-list-empty">
					<p>No sessions yet</p>
					<p>Create a new session to get started</p>
				</div>
			`
			return
		}

		listEl.innerHTML = sessions
			.map(
				(session) => `
			<div class="session-list-item ${activeSessionId === session.session_id ? 'active' : ''}"
				 data-session-id="${session.session_id}">
				<div class="session-list-item-header">
					<span class="session-list-item-name">${escapeHtml(session.name)}</span>
					<span class="session-list-item-status status-${session.status}">${session.status}</span>
				</div>
				<div class="session-list-item-meta">${formatRelativeTime(session.created_at)}</div>
				${session.peer ? `<div class="session-list-item-peer">with ${escapeHtml(session.peer)}</div>` : ''}
			</div>
		`,
			)
			.join('')

		listEl.querySelectorAll('.session-list-item').forEach((item) => {
			item.addEventListener('click', () => {
				const sessionId = item.dataset.sessionId
				openSessionDetail(sessionId)
			})
		})
	}

	async function openSessionDetail(sessionId) {
		activeSessionId = sessionId
		const session = sessions.find((s) => s.session_id === sessionId)
		if (!session) return

		document.querySelectorAll('.session-list-item').forEach((item) => {
			item.classList.toggle('active', item.dataset.sessionId === sessionId)
		})

		const mainEl = document.getElementById('sessions-main')
		const emptyEl = document.getElementById('sessions-empty-state')

		if (mainEl) mainEl.style.display = 'flex'
		if (emptyEl) emptyEl.style.display = 'none'

		renderSessionDetail(session)
		await loadSessionMessages(sessionId)
		const status = await refreshJupyterStatus(sessionId)
		startJupyterPolling(sessionId)
		startSessionMessagesPolling(sessionId)

		// Auto-launch Jupyter if not running
		if (!status.running) {
			console.log('[Sessions] Auto-launching Jupyter for session:', sessionId)
			await launchSessionJupyter()
		}
	}

	async function refreshSessionsAndInvites() {
		await loadSessions()
		await loadSessionInvitations()
	}

	function renderSessionDetail(session) {
		document.getElementById('session-name').textContent = session.name
		document.getElementById('session-status').textContent = session.status
		document.getElementById('session-status').className = `session-status status-${session.status}`
		document.getElementById('session-created-at').textContent = formatDateTime(session.created_at)
		document.getElementById('session-owner').textContent = session.owner || '-'
		document.getElementById('session-path').textContent = session.session_path || '-'

		const peerEl = document.getElementById('session-peer')
		const addPeerBtn = document.getElementById('add-peer-btn')
		if (session.peer) {
			peerEl.textContent = session.peer
			addPeerBtn.style.display = 'none'
		} else {
			peerEl.textContent = 'None'
			addPeerBtn.style.display = 'inline'
		}
	}

	async function refreshJupyterStatus(sessionId) {
		try {
			const status = await invoke('get_session_jupyter_status', { sessionId })
			updateJupyterUI(status)
			return status
		} catch (error) {
			console.error('Failed to get Jupyter status:', error)
			const fallback = { running: false }
			updateJupyterUI(fallback)
			return fallback
		}
	}

	function updateJupyterUI(status) {
		const statusEl = document.getElementById('session-jupyter-status')
		const urlEl = document.getElementById('session-jupyter-url')
		const linkEl = document.getElementById('session-jupyter-link')
		const launchBtn = document.getElementById('launch-session-jupyter-btn')
		const stopBtn = document.getElementById('stop-session-jupyter-btn')

		if (status.running) {
			statusEl.innerHTML = '<span class="jupyter-status-indicator running">Running</span>'
			if (status.url) {
				urlEl.style.display = 'block'
				linkEl.href = status.url
				linkEl.textContent = `Open Jupyter (port ${status.port})`
			}
			launchBtn.style.display = 'none'
			stopBtn.style.display = 'inline-flex'
		} else {
			statusEl.innerHTML = '<span class="jupyter-status-indicator stopped">Stopped</span>'
			urlEl.style.display = 'none'
			launchBtn.style.display = 'inline-flex'
			stopBtn.style.display = 'none'
		}
	}

	function startJupyterPolling(sessionId) {
		stopJupyterPolling()
		jupyterPollingInterval = setInterval(() => {
			if (activeSessionId === sessionId) {
				refreshJupyterStatus(sessionId)
			}
		}, 5000)
	}

	function stopJupyterPolling() {
		if (jupyterPollingInterval) {
			clearInterval(jupyterPollingInterval)
			jupyterPollingInterval = null
		}
	}

	function startSessionMessagesPolling(sessionId) {
		stopSessionMessagesPolling()
		sessionMessagesInterval = setInterval(() => {
			if (activeSessionId === sessionId) {
				loadSessionMessages(sessionId)
			}
		}, 8000)
	}

	function stopSessionMessagesPolling() {
		if (sessionMessagesInterval) {
			clearInterval(sessionMessagesInterval)
			sessionMessagesInterval = null
		}
	}

	function startSessionsAutoRefresh() {
		stopSessionsAutoRefresh()
		sessionsRefreshInterval = setInterval(() => {
			refreshSessionsAndInvites()
		}, 7000)
	}

	function stopSessionsAutoRefresh() {
		if (sessionsRefreshInterval) {
			clearInterval(sessionsRefreshInterval)
			sessionsRefreshInterval = null
		}
	}

	async function launchSessionJupyter() {
		if (!activeSessionId) return

		const launchBtn = document.getElementById('launch-session-jupyter-btn')
		if (launchBtn) {
			launchBtn.disabled = true
			launchBtn.textContent = 'Launching...'
		}

		try {
			console.log('[Sessions] Launching Jupyter for session:', activeSessionId)
			await invoke('launch_session_jupyter', { sessionId: activeSessionId })
			console.log('[Sessions] Jupyter launched, refreshing status...')
			await refreshJupyterStatus(activeSessionId)
		} catch (error) {
			console.error('[Sessions] Failed to launch Jupyter:', error)
			await dialog.message(`Failed to launch Jupyter: ${error}`, { title: 'Error', kind: 'error' })
		} finally {
			if (launchBtn) {
				launchBtn.disabled = false
				launchBtn.textContent = 'Launch Jupyter'
			}
		}
	}

	async function stopSessionJupyter() {
		if (!activeSessionId) return

		const stopBtn = document.getElementById('stop-session-jupyter-btn')
		stopBtn.disabled = true
		stopBtn.textContent = 'Stopping...'

		try {
			await invoke('stop_session_jupyter', { sessionId: activeSessionId })
			await refreshJupyterStatus(activeSessionId)
		} catch (error) {
			console.error('Failed to stop Jupyter:', error)
		} finally {
			stopBtn.disabled = false
			stopBtn.textContent = 'Stop'
		}
	}

	async function resetSessionJupyter() {
		if (!activeSessionId) return

		const confirmed = await dialog.confirm(
			'This will delete the virtual environment and recreate it. Your data files will be preserved. Continue?',
			{ title: 'Reset Jupyter Environment', kind: 'warning' },
		)

		if (!confirmed) return

		const resetBtn = document.getElementById('reset-session-jupyter-btn')
		resetBtn.disabled = true
		resetBtn.textContent = 'Resetting...'

		try {
			await invoke('reset_session_jupyter', { sessionId: activeSessionId })
			await refreshJupyterStatus(activeSessionId)
		} catch (error) {
			console.error('Failed to reset Jupyter:', error)
			await dialog.message(`Failed to reset Jupyter: ${error}`, { title: 'Error', kind: 'error' })
		} finally {
			resetBtn.disabled = false
			resetBtn.textContent = 'Reset'
		}
	}

	async function loadSessionMessages(sessionId) {
		try {
			const messages = await invoke('get_session_chat_messages', { sessionId })
			renderSessionMessages(messages)
		} catch (error) {
			console.error('Failed to load session messages:', error)
			renderSessionMessages([])
		}
	}

	function renderSessionMessages(messages) {
		const containerEl = document.getElementById('session-messages')
		if (!containerEl) return

		const currentUser = getCurrentUserEmail?.() || 'owner@local'

		if (!messages || messages.length === 0) {
			containerEl.innerHTML = '<div class="session-messages-empty">No messages yet</div>'
			return
		}

		containerEl.innerHTML = messages
			.map((msg) => {
				const isOutgoing = msg.from === currentUser
				return `
				<div class="session-message ${isOutgoing ? 'outgoing' : ''}">
					<div class="session-message-header">${escapeHtml(msg.from || 'Unknown')} - ${formatRelativeTime(
						msg.created_at,
					)}</div>
					<div class="session-message-body">${escapeHtml(msg.body || '')}</div>
				</div>
			`
			})
			.join('')

		containerEl.scrollTop = containerEl.scrollHeight
	}

	async function sendSessionMessage() {
		if (!activeSessionId) return
		const session = sessions.find((s) => s.session_id === activeSessionId)
		if (!session) return
		if (!session.peer && session.role === 'owner') {
			await dialog.message('Add a collaborator to send session messages.', {
				title: 'No Collaborator',
				kind: 'warning',
			})
			return
		}

		const inputEl = document.getElementById('session-message-input')
		const body = inputEl.value.trim()
		if (!body) return

		const sendBtn = document.getElementById('send-session-message-btn')
		sendBtn.disabled = true

		try {
			await invoke('send_session_chat_message', { sessionId: activeSessionId, body })
			inputEl.value = ''
			await loadSessionMessages(activeSessionId)
		} catch (error) {
			console.error('Failed to send message:', error)
			await dialog.message(`Failed to send message: ${error}`, { title: 'Error', kind: 'error' })
		} finally {
			sendBtn.disabled = false
		}
	}

	function showCreateSessionModal() {
		const modal = document.getElementById('create-session-modal')
		if (modal) {
			modal.style.display = 'flex'
			document.getElementById('session-name-input').value = ''
			document.getElementById('session-description-input').value = ''
			document.getElementById('session-peer-input').value = ''
			document.getElementById('session-name-input').focus()
		}
	}

	function hideCreateSessionModal() {
		const modal = document.getElementById('create-session-modal')
		if (modal) modal.style.display = 'none'
	}

	async function createSession() {
		const name = document.getElementById('session-name-input').value.trim()
		const description = document.getElementById('session-description-input').value.trim()
		const peer = document.getElementById('session-peer-input').value.trim()

		if (!name) {
			await dialog.message('Please enter a session name', {
				title: 'Validation Error',
				kind: 'error',
			})
			return
		}

		const confirmBtn = document.getElementById('confirm-create-session-btn')
		confirmBtn.disabled = true
		confirmBtn.textContent = 'Creating...'

		try {
			const session = await invoke('create_session', {
				request: {
					name,
					description: description || null,
					peer: peer || null,
				},
			})

			hideCreateSessionModal()
			await loadSessions()
			openSessionDetail(session.session_id)
		} catch (error) {
			console.error('Failed to create session:', error)
			await dialog.message(`Failed to create session: ${error}`, { title: 'Error', kind: 'error' })
		} finally {
			confirmBtn.disabled = false
			confirmBtn.textContent = 'Create Session'
		}
	}

	function showAddPeerModal() {
		const modal = document.getElementById('add-peer-modal')
		if (modal) {
			modal.style.display = 'flex'
			document.getElementById('peer-email-input').value = ''
			document.getElementById('peer-email-input').focus()
		}
	}

	function hideAddPeerModal() {
		const modal = document.getElementById('add-peer-modal')
		if (modal) modal.style.display = 'none'
	}

	async function addPeer() {
		if (!activeSessionId) return

		const peer = document.getElementById('peer-email-input').value.trim()
		if (!peer) {
			await dialog.message('Please enter an email address', {
				title: 'Validation Error',
				kind: 'error',
			})
			return
		}

		try {
			const session = await invoke('update_session_peer', { sessionId: activeSessionId, peer })
			hideAddPeerModal()
			await loadSessions()
			renderSessionDetail(session)
		} catch (error) {
			console.error('Failed to add peer:', error)
			await dialog.message(`Failed to add peer: ${error}`, { title: 'Error', kind: 'error' })
		}
	}

	async function acceptInvitation(sessionId) {
		if (!sessionId) return
		try {
			const session = await invoke('accept_session_invitation', { sessionId })
			await loadSessions()
			hideCreateSessionModal()
			activeSessionId = session.session_id
			await openSessionDetail(session.session_id)
		} catch (error) {
			console.error('Failed to accept invitation:', error)
			await dialog.message(`Failed to accept invitation: ${error}`, {
				title: 'Error',
				kind: 'error',
			})
		} finally {
			sessionInvitations = sessionInvitations.filter((i) => i.session_id !== sessionId)
			renderSessionInvitations()
			await loadSessionInvitations()
		}
	}

	async function rejectInvitation(sessionId) {
		if (!sessionId) return
		const confirmed = await dialog.confirm('Decline this session invite?', {
			title: 'Decline Invitation',
			kind: 'warning',
		})
		if (!confirmed) return

		try {
			await invoke('reject_session_invitation', { sessionId, reason: null })
			sessionInvitations = sessionInvitations.filter((i) => i.session_id !== sessionId)
			renderSessionInvitations()
			await loadSessionInvitations()
		} catch (error) {
			console.error('Failed to reject invitation:', error)
			await dialog.message(`Failed to reject invitation: ${error}`, {
				title: 'Error',
				kind: 'error',
			})
		}
	}

	async function deleteSession() {
		if (!activeSessionId) return

		const confirmed = await dialog.confirm(
			'Are you sure you want to delete this session? This action cannot be undone.',
			{ title: 'Delete Session', kind: 'warning' },
		)

		if (!confirmed) return

		try {
			await invoke('delete_session', { sessionId: activeSessionId })
			activeSessionId = null
			stopJupyterPolling()

			const mainEl = document.getElementById('sessions-main')
			const emptyEl = document.getElementById('sessions-empty-state')
			if (mainEl) mainEl.style.display = 'none'
			if (emptyEl) emptyEl.style.display = 'flex'

			await loadSessions()
		} catch (error) {
			console.error('Failed to delete session:', error)
			await dialog.message(`Failed to delete session: ${error}`, { title: 'Error', kind: 'error' })
		}
	}

	async function openSessionFolder() {
		if (!activeSessionId) return
		try {
			await invoke('open_session_folder', { sessionId: activeSessionId })
		} catch (error) {
			console.error('Failed to open folder:', error)
		}
	}

	function escapeHtml(text) {
		const div = document.createElement('div')
		div.textContent = text
		return div.innerHTML
	}

	function initializeSessionsTab() {
		const newBtn = document.getElementById('new-session-btn')
		if (newBtn) newBtn.addEventListener('click', showCreateSessionModal)

		const refreshBtn = document.getElementById('refresh-sessions-btn')
		if (refreshBtn) refreshBtn.addEventListener('click', refreshSessionsAndInvites)

		const closeModalBtn = document.getElementById('close-session-modal-btn')
		if (closeModalBtn) closeModalBtn.addEventListener('click', hideCreateSessionModal)

		const cancelModalBtn = document.getElementById('cancel-session-modal-btn')
		if (cancelModalBtn) cancelModalBtn.addEventListener('click', hideCreateSessionModal)

		const confirmCreateBtn = document.getElementById('confirm-create-session-btn')
		if (confirmCreateBtn) confirmCreateBtn.addEventListener('click', createSession)

		const closePeerBtn = document.getElementById('close-peer-modal-btn')
		if (closePeerBtn) closePeerBtn.addEventListener('click', hideAddPeerModal)

		const cancelPeerBtn = document.getElementById('cancel-peer-modal-btn')
		if (cancelPeerBtn) cancelPeerBtn.addEventListener('click', hideAddPeerModal)

		const confirmPeerBtn = document.getElementById('confirm-add-peer-btn')
		if (confirmPeerBtn) confirmPeerBtn.addEventListener('click', addPeer)

		const addPeerBtn = document.getElementById('add-peer-btn')
		if (addPeerBtn) addPeerBtn.addEventListener('click', showAddPeerModal)

		const launchBtn = document.getElementById('launch-session-jupyter-btn')
		if (launchBtn) launchBtn.addEventListener('click', launchSessionJupyter)

		const stopBtn = document.getElementById('stop-session-jupyter-btn')
		if (stopBtn) stopBtn.addEventListener('click', stopSessionJupyter)

		const resetBtn = document.getElementById('reset-session-jupyter-btn')
		if (resetBtn) resetBtn.addEventListener('click', resetSessionJupyter)

		const sendBtn = document.getElementById('send-session-message-btn')
		if (sendBtn) sendBtn.addEventListener('click', sendSessionMessage)

		const messageInput = document.getElementById('session-message-input')
		if (messageInput) {
			messageInput.addEventListener('keydown', (e) => {
				if (e.key === 'Enter' && !e.shiftKey) {
					e.preventDefault()
					sendSessionMessage()
				}
			})
		}

		const deleteBtn = document.getElementById('delete-session-btn')
		if (deleteBtn) deleteBtn.addEventListener('click', deleteSession)

		const openFolderBtn = document.getElementById('open-session-folder-btn')
		if (openFolderBtn) openFolderBtn.addEventListener('click', openSessionFolder)

		const jupyterLink = document.getElementById('session-jupyter-link')
		if (jupyterLink) {
			jupyterLink.addEventListener('click', (e) => {
				e.preventDefault()
				const url = jupyterLink.href
				if (url && url !== '#') {
					invoke('open_url', { url })
				}
			})
		}

		const createModal = document.getElementById('create-session-modal')
		if (createModal) {
			createModal.addEventListener('click', (e) => {
				if (e.target === createModal) hideCreateSessionModal()
			})
		}

		const peerModal = document.getElementById('add-peer-modal')
		if (peerModal) {
			peerModal.addEventListener('click', (e) => {
				if (e.target === peerModal) hideAddPeerModal()
			})
		}

		window.addEventListener('session-invite-open', async (e) => {
			pendingInviteFocusId = e.detail?.sessionId || null
			if (pendingInviteFocusId) {
				await refreshSessionsAndInvites()
				focusInvitationCard(pendingInviteFocusId)
			}
		})
	}

	function activateSessionsTab() {
		pendingInviteFocusId = window.__SESSION_INVITE_TO_OPEN__ || pendingInviteFocusId
		window.__SESSION_INVITE_TO_OPEN__ = null
		refreshSessionsAndInvites()
		startSessionsAutoRefresh()
	}

	function deactivateSessionsTab() {
		stopJupyterPolling()
		stopSessionMessagesPolling()
		stopSessionsAutoRefresh()
	}

	return {
		loadSessions,
		initializeSessionsTab,
		activateSessionsTab,
		deactivateSessionsTab,
	}
}
