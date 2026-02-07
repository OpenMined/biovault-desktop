/**
 * Messages Module - Messaging Interface
 * Handles secure peer-to-peer messaging via SyftBox
 */
import { createContactAutocomplete } from './contact-autocomplete.js'
import {
	escapeHtml,
	formatFullDateTime,
	formatThreadDateTime,
	formatDateSeparator,
	getDateKey,
	normalizeEmail,
	emailsMatch,
	getInitials,
	confirmWithDialog,
	normalizeMetadata,
} from './utils.js'

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
	let threadParticipantsById = new Map()
	let hasActivityBaseline = false
	let notificationPermission = 'default'
	let messageSyncUnlisten = null
	let notificationApiPromise = null
	let searchTerm = ''
	let messageFilter = 'inbox'

	// Color palette for sender bubbles (soft, readable colors)
	const SENDER_COLORS = [
		{ bg: '#dbeafe', border: '#93c5fd' }, // blue
		{ bg: '#dcfce7', border: '#86efac' }, // green
		{ bg: '#fef3c7', border: '#fcd34d' }, // amber
		{ bg: '#fce7f3', border: '#f9a8d4' }, // pink
		{ bg: '#e0e7ff', border: '#a5b4fc' }, // indigo
		{ bg: '#ccfbf1', border: '#5eead4' }, // teal
		{ bg: '#fee2e2', border: '#fca5a5' }, // red
		{ bg: '#f3e8ff', border: '#d8b4fe' }, // purple
	]

	// Generate a consistent color index from an email
	function getSenderColorIndex(email) {
		if (!email) return 0
		let hash = 0
		for (let i = 0; i < email.length; i++) {
			hash = ((hash << 5) - hash + email.charCodeAt(i)) | 0
		}
		return Math.abs(hash) % SENDER_COLORS.length
	}

	function getSenderColor(email) {
		return SENDER_COLORS[getSenderColorIndex(email)]
	}

	function resolveParticipantIdentity(identity) {
		const normalized = normalizeEmail(identity)
		if (!normalized) return ''
		if (normalized.includes('@')) return normalized
		const current = normalizeEmail(getCurrentUserEmail())
		const domain = current.includes('@') ? current.split('@')[1] : ''
		return domain ? `${normalized}@${domain}` : normalized
	}

	function uniqueParticipantEmails(emails) {
		return Array.from(
			new Set(
				(emails || [])
					.map((email) => resolveParticipantIdentity(email))
					.filter((email) => email.length > 0),
			),
		)
	}

	// Render participant chips with colors for thread header
	function renderParticipantChips(participants, currentUserEmail) {
		if (!participants || participants.length === 0) return ''
		const normalizedParticipants = uniqueParticipantEmails(participants)
		const others = normalizedParticipants.filter((p) => !emailsMatch(p, currentUserEmail))
		if (others.length === 0) return ''

		return others
			.map((email) => {
				const color = getSenderColor(email)
				return `<span class="participant-chip" title="${escapeHtml(email)}" style="background-color: ${color.bg}; border-color: ${color.border};">${escapeHtml(email)}</span>`
			})
			.join('')
	}

	// ============================================================================
	// EMAIL CHIP INPUT
	// ============================================================================

	let recipientChips = []

	function initializeChipInput() {
		const recipientInput = document.getElementById('message-recipient-input')
		if (!recipientInput) return

		// Create wrapper if not exists
		let wrapper = recipientInput.parentElement
		if (!wrapper.classList.contains('chip-input-wrapper')) {
			wrapper = document.createElement('div')
			wrapper.className = 'chip-input-wrapper'
			recipientInput.parentElement.insertBefore(wrapper, recipientInput)
			wrapper.appendChild(recipientInput)
		}

		// Create chips container if not exists
		let chipsContainer = wrapper.querySelector('.chips-container')
		if (!chipsContainer) {
			chipsContainer = document.createElement('div')
			chipsContainer.className = 'chips-container'
			wrapper.insertBefore(chipsContainer, recipientInput)
		}

		// Handle input events
		recipientInput.addEventListener('keydown', handleChipInputKeydown)
		recipientInput.addEventListener('blur', handleChipInputBlur)

		return { wrapper, chipsContainer }
	}

	function handleChipInputKeydown(e) {
		const input = e.target
		const value = input.value.trim()

		// Comma or Enter adds chip
		if ((e.key === ',' || e.key === 'Enter') && value) {
			e.preventDefault()
			const email = value.replace(/,/g, '').trim()
			if (email && isValidEmail(email)) {
				addRecipientChip(email)
				input.value = ''
			}
		}

		// Backspace on empty input removes last chip
		if (e.key === 'Backspace' && !input.value && recipientChips.length > 0) {
			removeRecipientChip(recipientChips.length - 1)
		}
	}

	function handleChipInputBlur(e) {
		const input = e.target
		const value = input.value.trim()
		if (value && isValidEmail(value)) {
			addRecipientChip(value)
			input.value = ''
		}
	}

	function isValidEmail(email) {
		return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
	}

	function addRecipientChip(email) {
		// Normalize and check for duplicates (case-insensitive)
		const normalizedEmail = email.toLowerCase().trim()
		if (recipientChips.some((e) => e.toLowerCase().trim() === normalizedEmail)) return
		recipientChips.push(email)
		renderRecipientChips()
	}

	function removeRecipientChip(index) {
		recipientChips.splice(index, 1)
		renderRecipientChips()
	}

	function renderRecipientChips() {
		const recipientInput = document.getElementById('message-recipient-input')
		if (!recipientInput) return

		const wrapper = recipientInput.closest('.chip-input-wrapper')
		if (!wrapper) return

		let chipsContainer = wrapper.querySelector('.chips-container')
		if (!chipsContainer) return

		chipsContainer.innerHTML = recipientChips
			.map(
				(email, idx) => `
			<span class="email-chip">
				${escapeHtml(email)}
				<button type="button" class="chip-remove" data-index="${idx}" title="Remove">×</button>
			</span>
		`,
			)
			.join('')

		// Add click handlers for remove buttons
		chipsContainer.querySelectorAll('.chip-remove').forEach((btn) => {
			btn.addEventListener('click', (e) => {
				e.preventDefault()
				e.stopPropagation()
				const idx = parseInt(btn.dataset.index, 10)
				removeRecipientChip(idx)
			})
		})

		// Update placeholder
		recipientInput.placeholder = recipientChips.length > 0 ? 'Add more...' : 'recipient@example.com'
	}

	function getRecipientEmails() {
		const recipientInput = document.getElementById('message-recipient-input')
		const inputValue = recipientInput?.value.trim() || ''

		// Combine chips and any text in input
		const emails = [...recipientChips]
		if (inputValue && isValidEmail(inputValue)) {
			emails.push(inputValue)
		}

		return emails
	}

	function clearRecipientChips() {
		recipientChips = []
		const recipientInput = document.getElementById('message-recipient-input')
		if (recipientInput) {
			recipientInput.value = ''
		}
		renderRecipientChips()
	}

	function setRecipientChips(emails) {
		recipientChips = [...emails]
		renderRecipientChips()
	}
	let syftboxAutoStartDisabled = null

	// Refresh rate: 2s in dev/test mode, 10s in production
	// Note: 500ms was too aggressive and caused DOM instability during Playwright tests
	const isDevMode = window.__DEV_WS_BRIDGE_PORT__ || window.location.search.includes('ws=')
	const AUTO_REFRESH_MS = isDevMode ? 2000 : 10000
	const NO_SUBJECT_PLACEHOLDER = '(No Subject)'
	let failedMessages = []
	let failedMessagesCount = 0
	let lastRenderedThreadsHash = '' // Track last render to avoid unnecessary DOM rebuilds
	const contactAutocomplete = createContactAutocomplete({ invoke, getCurrentUserEmail })

	// ============================================================================
	// UTILITIES (module-specific helpers)
	// ============================================================================

	// Wrapper for confirmWithDialog that passes the dialog object
	async function confirm(message, options = {}) {
		return confirmWithDialog(dialog, message, options)
	}

	async function isSyftboxAutoStartDisabled() {
		if (syftboxAutoStartDisabled !== null) return syftboxAutoStartDisabled
		try {
			const value = await invoke('get_env_var', {
				key: 'DISABLE_SYFTBOX_AUTO_START',
			})
			syftboxAutoStartDisabled = ['1', 'true', 'yes', 'on'].includes((value || '').toLowerCase())
		} catch (_) {
			syftboxAutoStartDisabled = false
		}
		return syftboxAutoStartDisabled
	}

	// Format file size in human readable format
	function formatFileSize(bytes) {
		if (bytes === 0) return '0 Bytes'
		const k = 1024
		const sizes = ['Bytes', 'KB', 'MB', 'GB']
		const i = Math.floor(Math.log(bytes) / Math.log(k))
		return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i]
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

	function getFlowRequestFromMessage(msg) {
		if (!msg) return null
		const meta = normalizeMetadata(msg.metadata)
		if (!meta || !meta.flow_request) return null
		const request = meta.flow_request
		if (!request.flow_name) return null
		return {
			flow_name: request.flow_name,
			flow_version: request.flow_version || '1.0.0',
			dataset_name: request.dataset_name,
			sender: request.sender || msg.from,
			flow_spec: request.flow_spec,
			flow_location: request.flow_location,
			submission_id: request.submission_id,
			sender_local_path: request.sender_local_path,
			receiver_local_path_template: request.receiver_local_path_template,
			run_id: request.run_id,
			datasites: Array.isArray(request.datasites) ? request.datasites : null,
			collab: Boolean(request.collab),
		}
	}

	function getFlowInvitationFromMessage(msg) {
		if (!msg) return null
		const meta = normalizeMetadata(msg.metadata)
		if (!meta || !meta.flow_invitation) return null
		const invitation = meta.flow_invitation
		if (!invitation.flow_name || !invitation.session_id) return null
		return {
			flow_name: invitation.flow_name,
			session_id: invitation.session_id,
			participants: Array.isArray(invitation.participants) ? invitation.participants : [],
			flow_spec: invitation.flow_spec,
			sender: msg.from,
		}
	}

	function parseSyftUrl(syftUrl) {
		if (!syftUrl || typeof syftUrl !== 'string') return null
		const match = syftUrl.match(/^syft:\/\/([^/]+)\/(.+)$/i)
		if (!match) return null
		return { datasite: match[1], path: match[2] }
	}

	function buildFlowRequestSubscriptionPath(flowRequest) {
		if (!flowRequest) return null
		let datasite = flowRequest.sender
		let path = null
		const parsed = parseSyftUrl(flowRequest.flow_location)
		if (parsed) {
			datasite = parsed.datasite || datasite
			path = parsed.path
		}
		if (!path && flowRequest.submission_id && flowRequest.sender) {
			path = `shared/biovault/submissions/${flowRequest.submission_id}`
		}
		if (!datasite || !path) return null
		path = path.replace(/^\/+/, '')
		path = path.replace(/\/flow\.ya?ml$/i, '')
		if (path.startsWith('datasites/')) {
			const parts = path.split('/')
			if (parts.length > 2) {
				return `${parts[1]}/${parts.slice(2).join('/')}`
			}
		}
		if (path.startsWith(`${datasite}/`)) {
			return path
		}
		return `${datasite}/${path}`
	}

	function getFlowResultsFromMessage(msg) {
		if (!msg) return null
		const meta = normalizeMetadata(msg.metadata)
		if (!meta || !meta.flow_results) return null
		const results = meta.flow_results
		if (!results.flow_name) return null
		return {
			flow_name: results.flow_name,
			run_id: results.run_id,
			sender: results.sender || msg.from,
			results_location: results.results_location,
			files: results.files || [],
			submission_id: results.submission_id,
		}
	}

	function parseRunMetadata(run) {
		if (!run?.metadata) return {}
		try {
			return JSON.parse(run.metadata)
		} catch (error) {
			console.warn('Failed to parse run metadata:', error)
			return {}
		}
	}

	function formatRunSelectionLabel(run) {
		const metadata = parseRunMetadata(run)
		const selection = metadata.data_selection || {}
		const parts = [`Run #${run.id}`]
		if (selection.dataset_name) parts.push(selection.dataset_name)
		if (Array.isArray(selection.asset_keys) && selection.asset_keys.length > 0) {
			parts.push(selection.asset_keys.join(', '))
		}
		if (selection.data_type) {
			const label = selection.data_type === 'private' ? 'real' : selection.data_type.toString()
			parts.push(label)
		}
		if (selection.participant_count) {
			parts.push(
				`${selection.participant_count} participant${selection.participant_count === 1 ? '' : 's'}`,
			)
		}
		return parts.join(' • ')
	}

	function setActiveMessageFilterButton(filter) {
		messageFilter = filter
		document.querySelectorAll('.message-filter').forEach((btn) => {
			btn.classList.toggle('active', btn.dataset.filter === filter)
		})

		// Show failed messages panel or regular thread list based on filter
		const _messageList = document.getElementById('message-list')
		const messagesMain = document.getElementById('messages-main')
		const emptyState = document.getElementById('messages-empty-state')

		if (filter === 'failed') {
			// Hide normal message UI when viewing failed messages
			if (messagesMain) messagesMain.style.display = 'none'
			if (emptyState) emptyState.style.display = 'none'
			loadFailedMessages()
		} else {
			// Restore normal view
			loadMessageThreads(false, { emitToasts: false })
		}
	}

	async function loadFailedMessages() {
		if (!messagesAuthorized) return

		const list = document.getElementById('message-list')
		if (!list) return

		try {
			const result = await invoke('list_failed_messages', { includeDismissed: false })
			failedMessages = result?.failed_messages || []
			renderFailedMessages()
		} catch (error) {
			console.error('Failed to load failed messages:', error)
			if (list) {
				list.innerHTML = '<div class="message-thread-empty">Failed to load failed messages</div>'
			}
		}
	}

	// Update badge using a known count (avoids extra backend call)
	function updateFailedMessagesBadgeWithCount(count) {
		failedMessagesCount = count || 0
		const badge = document.getElementById('failed-messages-badge')
		if (badge) {
			badge.textContent = failedMessagesCount > 9 ? '9+' : failedMessagesCount
			badge.style.display = failedMessagesCount > 0 ? 'inline-block' : 'none'
		}
		// Add warning class to failed filter button if there are failures
		const failedBtn = document.querySelector('.message-filter-failed')
		if (failedBtn) {
			failedBtn.classList.toggle('has-failures', failedMessagesCount > 0)
		}
	}

	// Fetch count from backend (only when we haven't synced recently)
	async function updateFailedMessagesBadge() {
		try {
			const count = await invoke('count_failed_messages')
			updateFailedMessagesBadgeWithCount(count)
		} catch (error) {
			console.error('Failed to update failed messages badge:', error)
		}
	}

	function renderFailedMessages() {
		const list = document.getElementById('message-list')
		if (!list) return

		if (failedMessages.length === 0) {
			list.innerHTML = '<div class="message-thread-empty">No failed messages</div>'
			return
		}

		list.innerHTML = ''
		failedMessages.forEach((failed) => {
			const item = document.createElement('div')
			item.className = 'message-thread-item failed-message-item'

			const topRow = document.createElement('div')
			topRow.className = 'message-thread-top'

			const header = document.createElement('div')
			header.className = 'message-thread-header'
			header.innerHTML = `<span class="failed-icon">⚠️</span> ${escapeHtml(
				failed.sender_identity || 'Unknown sender',
			)}`
			topRow.appendChild(header)

			const errorTag = document.createElement('span')
			errorTag.className = 'message-thread-error-tag'
			errorTag.textContent = getFailureReasonShort(failed.failure_reason)
			topRow.appendChild(errorTag)

			item.appendChild(topRow)

			const subject = document.createElement('div')
			subject.className = 'message-thread-subject'
			subject.textContent = failed.failure_reason_display || 'Decryption failed'
			item.appendChild(subject)

			const preview = document.createElement('div')
			preview.className = 'message-thread-preview'
			preview.textContent = failed.suggested_action || 'Unknown error'
			item.appendChild(preview)

			const metaRow = document.createElement('div')
			metaRow.className = 'message-thread-meta'
			metaRow.textContent = failed.created_at ? formatThreadDateTime(failed.created_at) : ''
			item.appendChild(metaRow)

			item.addEventListener('click', () => {
				showFailedMessageDetails(failed)
			})

			list.appendChild(item)
		})
	}

	function getFailureReasonShort(reason) {
		if (!reason) return 'Error'
		if (reason.includes('SenderBundleNotCached')) return 'Missing Key'
		if (reason.includes('RecipientKeyMismatch')) return 'Key Mismatch'
		if (reason.includes('WrongRecipient')) return 'Wrong Key'
		if (reason.includes('DecryptionFailed')) return 'Decrypt Error'
		if (reason.includes('InvalidEnvelope')) return 'Invalid'
		return 'Error'
	}

	function showFailedMessageDetails(failed) {
		const messagesMain = document.getElementById('messages-main')
		const emptyState = document.getElementById('messages-empty-state')
		const conversation = document.getElementById('message-conversation')
		const subjectEl = document.getElementById('message-thread-subject')
		const participantsEl = document.getElementById('message-thread-participants')
		const deleteBtn = document.getElementById('delete-thread-btn')
		const composeSection = document.querySelector('.message-compose')

		if (messagesMain) messagesMain.style.display = 'flex'
		if (emptyState) emptyState.style.display = 'none'
		if (deleteBtn) deleteBtn.style.display = 'none'
		if (composeSection) composeSection.style.display = 'none'

		if (subjectEl) subjectEl.textContent = 'Failed Message'
		if (participantsEl) participantsEl.textContent = `From: ${failed.sender_identity || 'Unknown'}`

		if (conversation) {
			conversation.innerHTML = `
				<div class="failed-message-details">
					<div class="failed-message-header">
						<h3>⚠️ Message Could Not Be Decrypted</h3>
						<p class="failed-reason">${escapeHtml(failed.failure_reason_display || failed.failure_reason)}</p>
					</div>

					<div class="failed-message-info">
						<div class="info-row">
							<span class="info-label">Sender:</span>
							<span class="info-value">${escapeHtml(failed.sender_identity || 'Unknown')}</span>
						</div>
						<div class="info-row">
							<span class="info-label">Sender Key Fingerprint:</span>
							<span class="info-value fingerprint">${escapeHtml(failed.sender_fingerprint || 'Unknown')}</span>
						</div>
						${
							failed.recipient_fingerprint
								? `
						<div class="info-row">
							<span class="info-label">Expected Recipient Key:</span>
							<span class="info-value fingerprint">${escapeHtml(failed.recipient_fingerprint)}</span>
						</div>
						`
								: ''
						}
						<div class="info-row">
							<span class="info-label">Received:</span>
							<span class="info-value">${
								failed.created_at ? formatThreadDateTime(failed.created_at) : 'Unknown'
							}</span>
						</div>
					</div>

					<div class="failed-message-suggestion">
						<h4>Suggested Action</h4>
						<p>${escapeHtml(
							failed.suggested_action || 'Contact the sender or check your key configuration.',
						)}</p>
					</div>

					<div class="failed-message-actions">
						<button class="message-cta" onclick="window.__messagesModule?.handleImportSenderKey?.('${escapeHtml(
							failed.sender_identity,
						)}')">
							Import Sender's Key
						</button>
						<button class="message-secondary" onclick="window.__messagesModule?.startNewMessage?.('${escapeHtml(
							failed.sender_identity,
						)}')">
							Compose Message to Sender
						</button>
						<button class="message-secondary danger" onclick="window.__messagesModule?.dismissFailedMessage?.('${escapeHtml(
							failed.id,
						)}')">
							Dismiss
						</button>
						<button class="message-secondary danger" onclick="window.__messagesModule?.deleteFailedMessage?.('${escapeHtml(
							failed.id,
						)}')">
							Delete
						</button>
					</div>

					<div class="failed-message-technical">
						<details>
							<summary>Technical Details</summary>
							<pre>${escapeHtml(failed.error_details || 'No additional details')}</pre>
						</details>
					</div>
				</div>
			`
		}
	}

	async function handleImportSenderKey(senderIdentity) {
		if (!senderIdentity) {
			alert('No sender identity available')
			return
		}
		try {
			await invoke('network_import_contact', { identity: senderIdentity })
			alert(`Key for ${senderIdentity} imported successfully. Try syncing messages again.`)
			// Refresh to potentially decrypt the message now
			await invoke('sync_messages_with_failures')
			await updateFailedMessagesBadge()
			if (messageFilter === 'failed') {
				await loadFailedMessages()
			}
		} catch (error) {
			console.error('Failed to import sender key:', error)
			alert(`Failed to import key for ${senderIdentity}: ${error}`)
		}
	}

	async function dismissFailedMessage(id) {
		if (!id) return
		try {
			await invoke('dismiss_failed_message', { id })
			await updateFailedMessagesBadge()
			if (messageFilter === 'failed') {
				await loadFailedMessages()
			}
		} catch (error) {
			console.error('Failed to dismiss failed message:', error)
			alert(`Failed to dismiss message: ${error}`)
		}
	}

	async function deleteFailedMessage(id) {
		if (!id) return
		const confirmed = await confirm('Delete this failed message record?', {
			title: 'Delete Failed Message',
			type: 'warning',
		})
		if (!confirmed) return

		try {
			await invoke('delete_failed_message', { id })
			await updateFailedMessagesBadge()
			if (messageFilter === 'failed') {
				await loadFailedMessages()
			}
		} catch (error) {
			console.error('Failed to delete failed message:', error)
			alert(`Failed to delete message: ${error}`)
		}
	}

	// ============================================================================
	// UI UPDATES
	// ============================================================================

	function collectParticipants(messages) {
		const set = new Set()
		messages.forEach((msg) => {
			if (msg.from) set.add(resolveParticipantIdentity(msg.from))
			if (msg.to) set.add(resolveParticipantIdentity(msg.to))
		})
		return Array.from(set)
	}

	function collectGroupParticipantsFromMessages(messages) {
		const participants = new Set()
		;(messages || []).forEach((msg) => {
			const meta = normalizeMetadata(msg?.metadata)
			const groupParticipants = meta?.group_chat?.participants
			if (!Array.isArray(groupParticipants)) return
				groupParticipants.forEach((email) => {
					if (typeof email === 'string' && email.trim()) {
						participants.add(resolveParticipantIdentity(email))
					}
				})
			})
			return Array.from(participants)
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

	function updateConversationAvatar(participants, isSelfThread = false, isSessionThread = false) {
		const avatarEl = document.getElementById('msg-conv-avatar')
		const headerEl = document.querySelector('.msg-conv-header')
		if (!avatarEl) return

		const currentUserEmail = getCurrentUserEmail()
		const others = (participants || []).filter((p) => !emailsMatch(p, currentUserEmail))
		const primaryEmail = others[0] || (participants && participants[0]) || ''

		const span = avatarEl.querySelector('span')
		if (span) {
			if (isSessionThread) {
				span.textContent = '🔐'
			} else if (isSelfThread) {
				span.textContent = '📝'
			} else {
				span.textContent = getInitials(primaryEmail)
			}
		}

		// Clear all special avatar classes first
		avatarEl.classList.remove('self-avatar', 'session-avatar')
		if (headerEl) {
			headerEl.classList.remove('session-header')
		}

		// Apply appropriate styling
		if (isSessionThread) {
			avatarEl.classList.add('session-avatar')
			if (headerEl) {
				headerEl.classList.add('session-header')
			}
		} else if (isSelfThread) {
			avatarEl.classList.add('self-avatar')
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
				const autoStartDisabled = await isSyftboxAutoStartDisabled()
				if (autoStartDisabled) {
					console.log('SyftBox auto-start disabled; skipping auto-connect')
				} else {
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

		messagesRefreshInterval = setInterval(async () => {
			if (!messagesAuthorized) return
			const syftboxStatus = getSyftboxStatus()
			if (!syftboxStatus.running) return
			await loadMessageThreads(true, { emitToasts: true }).catch(console.error)
			// Also refresh the active conversation if one is open
			if (activeThreadId && !isComposingNewMessage) {
				await openThread(activeThreadId, { preserveComposeDraft: true }).catch(console.error)
			}
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
				// Use batched command: sync + list in one call (reduces roundtrips)
				const result = await invoke('refresh_messages_batched', { scope: 'all' })
				messageThreads = result?.threads || []
				updateThreadActivity(messageThreads, emitToasts)
				renderMessageThreads()
				// Use failed count from batched result
				updateFailedMessagesBadgeWithCount(result?.total_failed ?? 0)
			} else {
				// No sync needed - just list threads
				const result = await invoke('list_message_threads', { scope: 'all' })
				messageThreads = result || []
				updateThreadActivity(messageThreads, emitToasts)
				renderMessageThreads()
				// Fetch failed count separately (no sync was done)
				await updateFailedMessagesBadge()
			}
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

		// Compute hash of current state to detect changes
		const stateHash = JSON.stringify({
			threads: messageThreads.map((t) => ({
				id: t.thread_id,
				unread: t.unread_count,
				last: t.last_message_at,
				preview: t.last_message_preview,
			})),
			activeThreadId,
			searchTerm,
			messageFilter,
		})

		// Skip render if nothing changed (prevents DOM thrashing during polling)
		if (stateHash === lastRenderedThreadsHash) {
			return
		}
		lastRenderedThreadsHash = stateHash

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

				const participants = uniqueParticipantEmails(thread.participants || [])
				const others = participants.filter((p) => !emailsMatch(p, currentUserEmail))

			// Check if this is a self-message thread (only participant is current user)
			const isSelfThread =
				participants.length === 1 && emailsMatch(participants[0], currentUserEmail)

			// Check if this is a session thread
			const isSessionThread = !!thread.session_id

			// Display name varies by thread type
			let displayName
			if (isSessionThread) {
				// For sessions, show session name prominently with lock icon
				displayName = `🔐 ${thread.session_name || 'Secure Session'}`
			} else if (isSelfThread) {
				displayName = '📝 Note to Self'
			} else {
				displayName = others.length > 0 ? others.join(', ') : participants.join(', ')
			}

			const displaySubject =
				thread.subject && thread.subject.trim().length > 0 ? thread.subject : NO_SUBJECT_PLACEHOLDER

			if (isSelfThread) {
				item.classList.add('self-thread')
			}
			if (isSessionThread) {
				item.classList.add('session-thread')
			}

			// Session badge takes priority if present - uses distinct amber/lock icon
			const sessionBadge = thread.session_id
				? `<span class="message-thread-session" title="${escapeHtml(
						thread.session_name || 'Secure Session',
					)}">
				<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
					<rect x="3" y="11" width="18" height="11" rx="2" ry="2"></rect>
					<path d="M7 11V7a5 5 0 0 1 10 0v4"></path>
				</svg>
				Session
			</span>`
				: ''
			const moduleBadge =
				!thread.session_id && thread.has_module
					? '<span class="message-thread-module">Module</span>'
					: ''
			const isGroupChat = participants.length >= 3
			const groupBadge =
				!thread.session_id && !thread.has_module && isGroupChat
					? '<span class="message-thread-group">Group</span>'
					: ''

			// For session threads, show participants in subject line
			const sessionParticipantsLine = isSessionThread
				? `<div class="message-thread-subject">With ${
						others.length > 0 ? escapeHtml(others.join(', ')) : 'participants'
					}</div>`
				: `<div class="message-thread-subject">${escapeHtml(displaySubject)}</div>`

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
					${moduleBadge}
					${groupBadge}
				</div>
				${sessionParticipantsLine}
				<div class="message-thread-preview">${escapeHtml(thread.last_message_preview || '')}</div>
				<div class="message-thread-meta">${
					thread.last_message_at ? formatThreadDateTime(thread.last_message_at) : ''
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

	function renderModulePanel(messages) {
		const panel = document.getElementById('message-module-panel')
		const details = document.getElementById('message-module-details')
		if (!panel || !details) return

		const moduleMessage = (messages || []).find((msg) => {
			if (!msg || !msg.metadata) return false
			return msg.metadata.module
		})

		if (!moduleMessage) {
			panel.style.display = 'none'
			details.innerHTML = ''
			return
		}

		const metadata = moduleMessage.metadata || {}
		const module = metadata.module || {}
		const name = module.name || metadata.module_name || moduleMessage.subject || 'Module'

		let html = `<p><strong>Name:</strong> ${escapeHtml(name)}</p>`
		if (metadata.module_location) {
			html += `<p><strong>Location:</strong> ${escapeHtml(metadata.module_location)}</p>`
		}
		if (module.workflow) {
			html += `<p><strong>Workflow:</strong> ${escapeHtml(module.workflow)}</p>`
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
			renderModulePanel(messages)

			const summary = messageThreads.find((thread) => thread.thread_id === threadId)
			const messageParticipants = collectParticipants(messages)
			const groupParticipants = collectGroupParticipantsFromMessages(messages)
				const participants = Array.from(
					new Set([...(summary?.participants || []), ...messageParticipants, ...groupParticipants]),
				)
				const normalizedParticipants = uniqueParticipantEmails(participants)
				threadParticipantsById.set(threadId, normalizedParticipants)
				const currentUserEmail = getCurrentUserEmail()

				// Check if this is a self-message thread
				const isSelfThread =
					normalizedParticipants.length === 1 &&
					emailsMatch(normalizedParticipants[0], currentUserEmail)

			// Check if this is a session thread
			const isSessionThread = !!(summary && summary.session_id)

			const subjectText = resolveSubject(summary, messages)
			const subjectEl = document.getElementById('message-thread-subject')
			if (subjectEl) {
				if (isSessionThread) {
					// Show session name prominently
					subjectEl.textContent = `🔐 ${summary.session_name || 'Secure Session'}`
				} else if (isSelfThread) {
					subjectEl.textContent = '📝 Note to Self'
				} else {
					subjectEl.textContent =
						subjectText && subjectText.trim().length > 0 ? subjectText : NO_SUBJECT_PLACEHOLDER
				}
			}

			const participantsEl = document.getElementById('message-thread-participants')
			if (participantsEl) {
				if (isSessionThread) {
					const chipsHtml = renderParticipantChips(normalizedParticipants, currentUserEmail)
					if (chipsHtml) {
						participantsEl.innerHTML = `<span class="participant-label">Session with</span> ${chipsHtml}`
					} else {
						participantsEl.textContent = 'Secure collaborative session'
					}
				} else if (isSelfThread) {
					participantsEl.textContent =
						subjectText && subjectText !== NO_SUBJECT_PLACEHOLDER ? subjectText : 'Personal notes'
				} else {
					const chipsHtml = renderParticipantChips(normalizedParticipants, currentUserEmail)
					if (chipsHtml) {
						participantsEl.innerHTML = chipsHtml
					} else {
						participantsEl.textContent = ''
					}
				}
			}

				updateConversationAvatar(normalizedParticipants, isSelfThread, isSessionThread)

			const recipientInput = document.getElementById('message-recipient-input')
			if (recipientInput) {
				recipientInput.readOnly = true
				if (!preserveComposeDraft) {
						recipientInput.value = getPrimaryRecipient(normalizedParticipants)
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
		updateProposeFlowButton()
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

		// Reset to normal styling (not self or session)
		updateConversationAvatar([], false, false)

		const recipientInput = document.getElementById('message-recipient-input')
		if (recipientInput) {
			// Clear any existing chips and set up for new message
			clearRecipientChips()
			if (prefillRecipient) {
				addRecipientChip(prefillRecipient)
			}
			contactAutocomplete.attachToInputs(['message-recipient-input'])
			recipientInput.readOnly = false
			recipientInput.focus()
		}

		const subjectInput = document.getElementById('message-compose-subject')
		if (subjectInput) subjectInput.value = ''

		const bodyInput = document.getElementById('message-compose-body')
		if (bodyInput) bodyInput.value = ''

		const conversationDiv = document.getElementById('message-conversation')
		if (conversationDiv) conversationDiv.innerHTML = ''

		const modulePanel = document.getElementById('message-module-panel')
		if (modulePanel) modulePanel.style.display = 'none'

		renderMessageThreads()
		updateMessagesEmptyState()
		updateProposeFlowButton()
	}

	// ============================================================================
	// ACTIONS
	// ============================================================================

	async function initializeMessagesTab(forceSync = false) {
		if (messagesInitialized && !forceSync) return

		// Initialize chip input for recipients
		initializeChipInput()
		contactAutocomplete.attachToInputs(['message-recipient-input'])

		await ensureMessagesAuthorization()
		await refreshSyftboxState()

		if (messagesAuthorized) {
			await loadMessageThreads(forceSync, { emitToasts: false })
			await updateFailedMessagesBadge()
		}

		// Setup search functionality
		setupSearchListener()

		messagesInitialized = true
	}

	async function sendCurrentMessage() {
		const subjectInput = document.getElementById('message-compose-subject')
		const bodyInput = document.getElementById('message-compose-body')

		const subject = subjectInput?.value.trim()
		const body = bodyInput?.value.trim()

		// Get recipients - from chips if composing new, from thread if replying
		let recipients = []
		if (isComposingNewMessage) {
			recipients = getRecipientEmails()
		} else if (activeThreadId) {
			// Replying to existing thread - use thread participants (excluding self)
			const currentUser = getCurrentUserEmail()
			const thread = messageThreads.find((t) => t.thread_id === activeThreadId)
				const knownParticipants =
					threadParticipantsById.get(activeThreadId) || thread?.participants || []
				if (knownParticipants.length > 0) {
					recipients = knownParticipants.filter((p) => !emailsMatch(p, currentUser))
				}
			}

			recipients = uniqueParticipantEmails(recipients)

		if (recipients.length === 0) {
			alert('Please enter at least one recipient')
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

			for (const recipient of recipients) {
				const contactCheck = await invoke('key_check_contact', { email: recipient })

				if (!contactCheck.has_key) {
					if (contactCheck.is_on_network) {
						const goToNetwork = await dialog.ask(
							`${recipient} is on the BioVault network but you haven't added them to your contacts yet.\n\nGo to Network tab to add and verify their key before messaging.`,
							{
								title: 'Contact Not Added',
								kind: 'warning',
								okLabel: 'Go to Network',
								cancelLabel: 'Cancel',
							},
						)
						if (goToNetwork) {
							const event = new CustomEvent('navigate-to-tab', { detail: { tab: 'network' } })
							window.dispatchEvent(event)
						}
						return
					} else {
						const sendInvite = await dialog.ask(
							`${recipient} doesn't appear to be on the BioVault network yet.\n\nWould you like to invite them?`,
							{
								title: 'Recipient Not Found',
								kind: 'info',
								okLabel: 'Send Invite',
								cancelLabel: 'Cancel',
							},
						)
						if (sendInvite) {
							await showInviteOptions('message')
						}
						return
					}
				}
			}

			const request =
				recipients.length === 1
					? {
							to: recipients[0],
							subject: subject || NO_SUBJECT_PLACEHOLDER,
							body,
							reply_to: messageReplyTargetId,
						}
					: {
							recipients,
							subject: subject || NO_SUBJECT_PLACEHOLDER,
							body,
							reply_to: messageReplyTargetId,
						}

			const sent = await invoke('send_message', { request })

			const threadKey = sent.thread_id || sent.id

			await loadMessageThreads(false, { emitToasts: false })
			if (threadKey) {
				await openThread(threadKey)
			} else {
				await loadMessageThreads(true, { emitToasts: false })
			}

			if (bodyInput) bodyInput.value = ''
			// Clear recipient chips after successful send
			clearRecipientChips()
		} catch (error) {
			console.error('Failed to send message:', error)
			alert(`Failed to send: ${error}`)
		}
	}

	async function deleteMessage(messageId) {
		if (!messageId) return

		const confirmed = await confirm('Delete this message?', {
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

		const confirmed = await confirm('Delete this entire conversation?', {
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

	async function getInviteData(type = 'message') {
		const currentUserEmail = getCurrentUserEmail?.() || ''
		let fingerprint = ''
		try {
			const keyStatus = await invoke('key_get_status')
			fingerprint = keyStatus?.vault_fingerprint || keyStatus?.export_fingerprint || ''
		} catch (e) {
			console.warn('Could not get key fingerprint for invite:', e)
		}
		return {
			from: currentUserEmail,
			fingerprint,
			type,
		}
	}

	async function getInviteUrl(type = 'message') {
		const data = await getInviteData(type)
		const params = new URLSearchParams({
			from: data.from,
			fp: data.fingerprint,
			type: data.type,
		})
		return `https://app.biovault.net/invite?${params.toString()}`
	}

	async function getInviteMessage(type = 'message') {
		const inviteUrl = await getInviteUrl(type)
		const typeDesc =
			type === 'session'
				? 'an end-to-end encrypted collaborative session'
				: type === 'dataset'
					? 'secure dataset sharing'
					: 'secure messaging'
		return `Hi!\n\nI'd like to invite you to ${typeDesc} on BioVault - a platform for private data analysis.\n\nGet started here:\n${inviteUrl}\n\nLearn more:\n- https://biovault.net\n- https://openmined.org\n\nLooking forward to working together!`
	}

	async function openInviteUrl(url) {
		if (invoke) {
			invoke('open_url', { url }).catch(() => window.open(url, '_blank'))
		} else {
			window.open(url, '_blank')
		}
	}

	async function openInvite(provider, type = 'message') {
		const subject = encodeURIComponent('Join me on BioVault!')
		const body = encodeURIComponent(await getInviteMessage(type))
		const message = encodeURIComponent(await getInviteMessage(type))

		const urls = {
			gmail: `https://mail.google.com/mail/?view=cm&fs=1&su=${subject}&body=${body}`,
			outlook: `https://outlook.live.com/mail/0/deeplink/compose?subject=${subject}&body=${body}`,
			email: `mailto:?subject=${subject}&body=${body}`,
			whatsapp: `https://wa.me/?text=${message}`,
		}

		if (urls[provider]) {
			await openInviteUrl(urls[provider])
		}
	}

	async function showInviteOptions(type = 'message') {
		const existingModal = document.getElementById('invite-options-modal')
		if (existingModal) existingModal.remove()

		const inviteUrl = await getInviteUrl(type)

		const modal = document.createElement('div')
		modal.id = 'invite-options-modal'
		modal.innerHTML = `
			<div class="invite-modal-backdrop"></div>
			<div class="invite-modal-content">
				<h3>Invite to BioVault</h3>
				<p>Share this link to invite someone:</p>
				<div class="invite-link-box">
					<input type="text" class="invite-link-input" value="${inviteUrl}" readonly />
					<button class="invite-copy-btn" title="Copy to clipboard">📋</button>
				</div>
				<div class="invite-copy-status"></div>
				<p class="invite-share-label">Or share via:</p>
				<div class="invite-options-grid">
					<button class="invite-option-btn" data-provider="gmail">
						<span class="invite-icon">📧</span>
						<span>Gmail</span>
					</button>
						<button class="invite-option-btn" data-provider="outlook">
							<span class="invite-icon">📬</span>
							<span>Outlook</span>
						</button>
						<button class="invite-option-btn" data-provider="email">
							<span class="invite-icon">💌</span>
							<span>Email App</span>
						</button>
						<button class="invite-option-btn" data-provider="whatsapp">
							<span class="invite-icon">💬</span>
							<span>WhatsApp</span>
						</button>
					</div>
					<button class="invite-cancel-btn">Close</button>
				</div>
			`

		const style = document.createElement('style')
		style.textContent = `
			#invite-options-modal { position: fixed; inset: 0; z-index: 10000; display: flex; align-items: center; justify-content: center; }
			.invite-modal-backdrop { position: absolute; inset: 0; background: rgba(0,0,0,0.5); }
			.invite-modal-content { position: relative; background: var(--bg-primary, #fff); border-radius: 12px; padding: 24px; max-width: 420px; width: 90%; box-shadow: 0 20px 40px rgba(0,0,0,0.3); }
			.invite-modal-content h3 { margin: 0 0 8px; font-size: 18px; }
			.invite-modal-content p { margin: 0 0 12px; color: var(--text-secondary, #666); font-size: 14px; }
			.invite-link-box { display: flex; gap: 8px; margin-bottom: 4px; }
			.invite-link-input { flex: 1; padding: 10px 12px; border: 1px solid var(--border-color, #e0e0e0); border-radius: 8px; font-size: 12px; font-family: monospace; background: var(--bg-secondary, #f5f5f5); color: var(--text-primary, #333); }
			.invite-copy-btn { padding: 10px 14px; border: 1px solid var(--border-color, #e0e0e0); border-radius: 8px; background: var(--accent-color, #10b981); color: white; cursor: pointer; font-size: 16px; transition: all 0.2s; }
			.invite-copy-btn:hover { opacity: 0.9; }
			.invite-copy-status { font-size: 12px; color: var(--accent-color, #10b981); height: 18px; margin-bottom: 8px; }
			.invite-share-label { margin-top: 16px !important; font-weight: 500; }
			.invite-options-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; margin-bottom: 16px; }
			.invite-option-btn { display: flex; flex-direction: column; align-items: center; gap: 4px; padding: 12px 8px; border: 1px solid var(--border-color, #e0e0e0); border-radius: 8px; background: var(--bg-secondary, #f5f5f5); cursor: pointer; transition: all 0.2s; font-size: 11px; }
			.invite-option-btn:hover { background: var(--bg-hover, #e8e8e8); border-color: var(--accent-color, #10b981); }
			.invite-icon { font-size: 20px; }
			.invite-cancel-btn { width: 100%; padding: 10px; border: none; border-radius: 8px; background: transparent; color: var(--text-secondary, #666); cursor: pointer; font-size: 14px; }
			.invite-cancel-btn:hover { background: var(--bg-secondary, #f5f5f5); }
		`
		modal.appendChild(style)
		document.body.appendChild(modal)

		const copyBtn = modal.querySelector('.invite-copy-btn')
		const copyStatus = modal.querySelector('.invite-copy-status')
		const linkInput = modal.querySelector('.invite-link-input')

		copyBtn.addEventListener('click', async () => {
			try {
				await navigator.clipboard.writeText(inviteUrl)
				copyStatus.textContent = '✓ Copied to clipboard!'
				copyBtn.textContent = '✓'
				setTimeout(() => {
					copyStatus.textContent = ''
					copyBtn.textContent = '📋'
				}, 2000)
			} catch (e) {
				linkInput.select()
				document.execCommand('copy')
				copyStatus.textContent = '✓ Copied!'
			}
		})

		linkInput.addEventListener('click', () => linkInput.select())

		modal.querySelector('.invite-modal-backdrop').addEventListener('click', () => modal.remove())
		modal.querySelector('.invite-cancel-btn').addEventListener('click', () => modal.remove())
		modal.querySelectorAll('.invite-option-btn').forEach((btn) => {
			btn.addEventListener('click', async () => {
				const provider = btn.dataset.provider
				await openInvite(provider, type)
			})
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

		// Deduplicate messages by ID and by content+sender (with relaxed timestamp matching)
		const seenIds = new Set()
		const seenContent = new Set()
		const dedupedMessages = messages.filter((msg) => {
			// Check by ID first
			if (msg.id) {
				if (seenIds.has(msg.id)) return false
				seenIds.add(msg.id)
			}
			// Normalize timestamp to minute precision to catch duplicates with slight time differences
			let normalizedTime = ''
			if (msg.created_at) {
				try {
					const d = new Date(msg.created_at)
					normalizedTime = `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}-${d.getHours()}-${d.getMinutes()}`
				} catch {
					normalizedTime = msg.created_at
				}
			}
			// Also check by content hash to catch duplicates with different IDs
			const contentKey = `${msg.from || ''}|${msg.body || ''}|${normalizedTime}`
			if (seenContent.has(contentKey)) return false
			seenContent.add(contentKey)
			return true
		})

		// Group consecutive messages from the same sender, with date awareness
		const groups = []
		let currentGroup = null
		let lastDateKey = null

		dedupedMessages.forEach((msg, index) => {
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

				// Apply consistent color to incoming messages (not outgoing, not self)
				if (!group.isOutgoing && !group.isSelfMessage) {
					const senderColor = getSenderColor(msg.from)
					msgDiv.style.backgroundColor = senderColor.bg
					msgDiv.style.borderColor = senderColor.border
				}

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
							<h5>🔐 ${escapeHtml(invite.session_name)}<span class="invite-label">Session Invite</span></h5>
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

				// Flow request card
				const flowRequest = getFlowRequestFromMessage(msg)
				if (flowRequest) {
					const requestCard = document.createElement('div')
					requestCard.className = 'message-flow-request'

					requestCard.innerHTML = `
						<h5>🔧 ${escapeHtml(flowRequest.flow_name)} <span class="version-badge">v${escapeHtml(flowRequest.flow_version)}</span><span class="invite-label">Flow Request</span></h5>
						<p class="invite-meta">Run on dataset: <strong>${escapeHtml(flowRequest.dataset_name || 'your data')}</strong></p>
						<p class="invite-meta">From: ${escapeHtml(flowRequest.sender)}</p>
						${flowRequest.run_id ? `<p class="invite-meta">Run ID: <strong>${escapeHtml(flowRequest.run_id)}</strong></p>` : ''}
						${
							Array.isArray(flowRequest.datasites) && flowRequest.datasites.length > 0
								? `<p class="invite-meta">Datasites: ${escapeHtml(flowRequest.datasites.join(', '))}</p>`
								: ''
						}
					`

					const actions = document.createElement('div')
					actions.className = 'invite-actions'
					let runActions = null
					let runButtons = null
					let joinBtn = null
					let runSelect = null
					let runSelectOpenBtn = null
					let runSelectSendBtn = null

					const updateRunButtons = (flow) => {
						if (!runButtons) return
						const enabled = Boolean(flow && flowRequest.dataset_name)
						runButtons.flow = flow || null
						runButtons.mock.disabled = !enabled
						runButtons.real.disabled = !enabled
						runButtons.both.disabled = !enabled
							if (joinBtn) {
								joinBtn.disabled = !(flow && flowRequest.run_id)
							}
						}

					const refreshFlowRequestActions = async () => {
						if (!runActions) return
						try {
							const [flows, runs] = await Promise.all([invoke('get_flows'), invoke('get_flow_runs')])
							const flow = (flows || []).find((p) => p?.name === flowRequest.flow_name)
							updateRunButtons(flow)

							if (!runSelect || !runSelectOpenBtn || !runSelectSendBtn) return

							if (!flow) {
								runSelect.__runMap = null
								runSelect.__flowRef = null
								runSelect.innerHTML = '<option value="">Import flow first</option>'
								runSelect.disabled = true
								runSelectOpenBtn.style.display = 'none'
								runSelectSendBtn.style.display = 'none'
								return
							}

							const matchingRuns = (runs || []).filter(
								(run) => run.flow_id === flow.id && run.status === 'success',
							)
							if (matchingRuns.length === 0) {
								runSelect.__runMap = new Map()
								runSelect.__flowRef = flow
								runSelect.innerHTML = '<option value="">No completed runs yet</option>'
								runSelect.disabled = true
								runSelectOpenBtn.style.display = 'none'
								runSelectSendBtn.style.display = 'none'
								return
							}

							runSelect.__runMap = new Map(matchingRuns.map((run) => [run.id, run]))
							runSelect.__flowRef = flow
							runSelect.innerHTML = matchingRuns
								.map(
									(run) =>
										`<option value="${run.id}">${escapeHtml(formatRunSelectionLabel(run))}</option>`,
								)
								.join('')
							runSelect.disabled = false
							runSelectOpenBtn.style.display = ''
							runSelectSendBtn.style.display = ''
						} catch (error) {
							console.error('Failed to refresh flow request actions:', error)
							if (runSelect) {
								runSelect.innerHTML = '<option value="">Failed to load runs</option>'
							}
						}
					}

					if (!group.isOutgoing) {
						const syncBtn = document.createElement('button')
						syncBtn.className = 'secondary'
						syncBtn.textContent = 'Sync Request'
						syncBtn.addEventListener('click', async () => {
							if (syncBtn.disabled) return
							const targetPath = buildFlowRequestSubscriptionPath(flowRequest)
							if (!targetPath) {
								await dialog.message('Flow location not available for sync.', {
									title: 'Sync Error',
									type: 'error',
								})
								return
							}
							const originalText = syncBtn.textContent
							syncBtn.disabled = true
							syncBtn.textContent = 'Syncing…'
							try {
								await invoke('sync_tree_set_subscription', {
									path: targetPath,
									allow: true,
									isDir: true,
								})
								await invoke('trigger_syftbox_sync')
								syncBtn.textContent = 'Synced'
							} catch (error) {
								console.error('Failed to sync flow request:', error)
								syncBtn.textContent = originalText
								syncBtn.disabled = false
								await dialog.message(`Failed to sync request: ${error?.message || error}`, {
									title: 'Sync Error',
									type: 'error',
								})
							}
						})
						actions.appendChild(syncBtn)

							const importBtn = document.createElement('button')
							importBtn.textContent = 'Import Flow'
							importBtn.addEventListener('click', async () => {
								try {
								if (!flowRequest.flow_location) {
									await dialog.message('Flow folder not found in request', {
										title: 'Import Error',
										type: 'error',
									})
									return
								}

								await invoke('import_flow_from_request', {
									name: flowRequest.flow_name,
									flowLocation: flowRequest.flow_location,
									overwrite: false,
								})

									await dialog.message(
										`Flow "${flowRequest.flow_name}" imported successfully!\n\nGo to Flows tab to view and run it.`,
										{ title: 'Flow Imported', type: 'info' },
									)

									await refreshFlowRequestActions()
								} catch (error) {
									console.error('Failed to import flow:', error)
									await dialog.message('Failed to import flow: ' + (error?.message || error), {
									title: 'Import Error',
									type: 'error',
								})
							}
						})
						actions.appendChild(importBtn)
					}

					const openBtn = document.createElement('button')
					openBtn.className = 'secondary'
					openBtn.textContent = 'Open in Finder'
					openBtn.addEventListener('click', async () => {
						try {
							if (!flowRequest.flow_location) {
								await dialog.message('Flow folder not found in request', {
									title: 'Open Folder Error',
									type: 'error',
								})
								return
							}
							const folderPath = await invoke('resolve_syft_url_to_local_path', {
								syftUrl: flowRequest.flow_location,
							})
							await invoke('open_folder', { path: folderPath })
						} catch (error) {
							console.error('Failed to open flow folder:', error)
							await dialog.message(`Failed to open folder: ${error?.message || error}`, {
								title: 'Open Folder Error',
								type: 'error',
							})
						}
					})
					actions.appendChild(openBtn)

					requestCard.appendChild(actions)

					if (!group.isOutgoing) {
						runActions = document.createElement('div')
						runActions.className = 'invite-actions'

						const runMockBtn = document.createElement('button')
						runMockBtn.textContent = 'Run Mock'
						runMockBtn.className = 'secondary'
						runMockBtn.disabled = true

						const runRealBtn = document.createElement('button')
						runRealBtn.textContent = 'Run Real'
						runRealBtn.className = 'secondary'
						runRealBtn.disabled = true

						const runBothBtn = document.createElement('button')
						runBothBtn.textContent = 'Run Both'
						runBothBtn.disabled = true

						runButtons = { mock: runMockBtn, real: runRealBtn, both: runBothBtn, flow: null }

						const runWithType = async (dataType) => {
							const flow = runButtons?.flow
							if (!flow) {
								await dialog.message('Import the flow first before running.', {
									title: 'Flow Required',
									type: 'warning',
								})
								return
							}
							if (!flowRequest.dataset_name) {
								await dialog.message('Dataset name missing from this request.', {
									title: 'Missing Dataset',
									type: 'error',
								})
								return
							}
							if (window.__flowsModule?.openRunFlowWithDataset) {
								window.__flowsModule.openRunFlowWithDataset({
									name: flowRequest.dataset_name,
									dataType,
									flowId: flow.id,
								})
							} else if (typeof window.navigateTo === 'function') {
								window.navigateTo('flows')
							}
						}

						runMockBtn.addEventListener('click', () => runWithType('mock'))
						runRealBtn.addEventListener('click', () => runWithType('real'))
						runBothBtn.addEventListener('click', () => runWithType('both'))

						runActions.appendChild(runMockBtn)
						runActions.appendChild(runRealBtn)
						runActions.appendChild(runBothBtn)

							if (flowRequest.run_id) {
								joinBtn = document.createElement('button')
								joinBtn.textContent = 'Join Run'
								joinBtn.className = 'secondary'
								joinBtn.disabled = true
								joinBtn.addEventListener('click', async () => {
									let flow = runButtons?.flow
									if (!flow) {
										// Self-heal: try import+refresh so join does not look stuck.
										try {
											if (flowRequest.flow_location) {
												await invoke('import_flow_from_request', {
													name: flowRequest.flow_name,
													flowLocation: flowRequest.flow_location,
													overwrite: false,
												})
											}
										} catch (error) {
											console.warn('Auto-import before join failed:', error)
										}
										for (let i = 0; i < 8; i++) {
											await refreshFlowRequestActions()
											flow = runButtons?.flow
											if (flow) break
											await new Promise((r) => setTimeout(r, 400))
										}
										if (!flow) {
											await dialog.message('Import the flow first before joining.', {
												title: 'Flow Required',
												type: 'warning',
											})
											return
										}
									}
									const inputOverrides = {}
									if (
									flow?.spec?.inputs?.datasites &&
									Array.isArray(flowRequest.datasites) &&
									flowRequest.datasites.length > 0
								) {
									inputOverrides['inputs.datasites'] = flowRequest.datasites.join(',')
								}
									try {
										joinBtn.disabled = true
										joinBtn.textContent = 'Joining...'
										await invoke('run_flow', {
											flowId: flow.id,
											inputOverrides,
											runId: flowRequest.run_id,
										})
										await refreshFlowRequestActions()
										joinBtn.textContent = 'Join Run'
										joinBtn.disabled = false
									} catch (error) {
										joinBtn.disabled = false
										joinBtn.textContent = 'Join Run'
										console.error('Failed to start collaborative run:', error)
										await dialog.message(
											`Failed to start collaborative run: ${error?.message || error}`,
										{ title: 'Run Error', type: 'error' },
									)
								}
							})
							runActions.appendChild(joinBtn)
						}

						requestCard.appendChild(runActions)

						const resultsActions = document.createElement('div')
						resultsActions.className = 'invite-actions'

							runSelect = document.createElement('select')
							runSelect.className = 'form-control'
							runSelect.style.flex = '1'
							runSelect.innerHTML = '<option value="">Loading runs...</option>'
							runSelect.disabled = true

							runSelectOpenBtn = document.createElement('button')
							runSelectOpenBtn.textContent = 'Show in Finder'
							runSelectOpenBtn.className = 'secondary'
							runSelectOpenBtn.disabled = true
							runSelectOpenBtn.style.display = 'none'
							runSelectOpenBtn.addEventListener('click', async () => {
								const runId = parseInt(runSelect.value, 10)
								if (!runId) return
								const run = runSelect.__runMap?.get(runId)
							if (!run) return
							try {
								const path = run.results_dir || run.work_dir
								if (!path) {
									await dialog.message('Results folder not available for this run.', {
										title: 'Open Folder Error',
										type: 'error',
									})
									return
								}
								await invoke('open_folder', { path })
							} catch (error) {
								console.error('Failed to open results folder:', error)
									await dialog.message(`Failed to open folder: ${error?.message || error}`, {
										title: 'Open Folder Error',
										type: 'error',
									})
								}
							})

							runSelectSendBtn = document.createElement('button')
							runSelectSendBtn.textContent = 'Send Back'
							runSelectSendBtn.disabled = true
							runSelectSendBtn.style.display = 'none'
							runSelectSendBtn.addEventListener('click', async () => {
								const runId = parseInt(runSelect.value, 10)
								if (!runId) return

							const run = runSelect.__runMap?.get(runId)
							const flow = runSelect.__flowRef
							if (!run || !flow) {
								await dialog.message('Run metadata not available.', {
									title: 'Send Results Error',
									type: 'error',
								})
								return
							}

							const resultsDir = run.results_dir || run.work_dir
							if (!resultsDir) {
								await dialog.message('Results folder not available for this run.', {
									title: 'Send Results Error',
									type: 'error',
								})
								return
							}

							let treeEntries = []
							try {
								treeEntries = await invoke('list_results_tree', { root: resultsDir })
							} catch (error) {
								await dialog.message(`Failed to load results folder: ${error?.message || error}`, {
									title: 'Send Results Error',
									type: 'error',
								})
								return
							}

							const fileEntries = (treeEntries || []).filter((entry) => !entry.is_dir)
							if (fileEntries.length === 0) {
								await dialog.message('No results files found to share yet.', {
									title: 'Send Results',
									type: 'info',
								})
								return
							}

							const buildTree = (files) => {
								const root = { name: 'Results', children: new Map(), files: [] }
								files.forEach((file) => {
									const parts = file.path.split('/').filter(Boolean)
									let node = root
									parts.forEach((part, idx) => {
										const isFile = idx === parts.length - 1
										if (isFile) {
											node.files.push({
												name: part,
												path: file.path,
												size: file.size_bytes || 0,
											})
										} else {
											if (!node.children.has(part)) {
												node.children.set(part, {
													name: part,
													children: new Map(),
													files: [],
												})
											}
											node = node.children.get(part)
										}
									})
								})
								return root
							}

							const renderTree = (node, prefix = '', isRoot = false) => {
								const dirPath = isRoot ? '' : prefix ? `${prefix}/${node.name}` : node.name
								const childPrefix = isRoot ? '' : dirPath
								const childDirs = Array.from(node.children.values()).sort((a, b) =>
									a.name.localeCompare(b.name),
								)
								const files = [...node.files].sort((a, b) => a.name.localeCompare(b.name))

								const filesHtml = files
									.map(
										(file) => `
											<label class="results-tree-file">
												<input type="checkbox" data-output-path="${encodeURIComponent(
													file.path,
												)}" data-path="${encodeURIComponent(file.path)}" checked />
												<span class="results-tree-name">${escapeHtml(file.name)}</span>
												<span class="results-tree-size">${formatFileSize(file.size)}</span>
											</label>
										`,
									)
									.join('')

								const childrenHtml = childDirs
									.map((child) => renderTree(child, childPrefix, false))
									.join('')

								return `
									<div class="results-tree-node ${isRoot ? 'root' : ''}">
										<label class="results-tree-label">
											<input type="checkbox" data-dir="${encodeURIComponent(dirPath)}" checked />
											<span class="results-tree-name">${escapeHtml(node.name)}</span>
										</label>
										<div class="results-tree-children">
											${filesHtml}
											${childrenHtml}
										</div>
									</div>
								`
							}

							const treeRoot = buildTree(fileEntries)
							const treeHtml = renderTree(treeRoot, '', true)

							const modal = document.createElement('div')
							modal.style.cssText =
								'position: fixed; inset: 0; background: rgba(15,23,42,0.45); display: flex; align-items: center; justify-content: center; z-index: 9999;'

							const card = document.createElement('div')
							card.style.cssText =
								'background: #ffffff; color: #0f172a; width: min(520px, 92vw); border-radius: 14px; box-shadow: 0 18px 50px rgba(0,0,0,0.25); padding: 22px 24px; display: flex; flex-direction: column; gap: 16px;'

							card.innerHTML = `
								<div style="display:flex; align-items:center; gap:10px;">
									<div style="font-size: 18px; font-weight: 700;">Send Results</div>
									<div style="font-size: 12px; color: #64748b; margin-left: auto;">Run #${runId}</div>
								</div>
								<div style="font-size: 13px; color: #64748b;">Select which files to share from the results folder.</div>
								<div class="results-tree">
									${treeHtml}
								</div>
								<div style="display:flex; gap:8px; justify-content:flex-end;">
									<button id="send-results-cancel" style="padding:10px 14px; border-radius:8px; border:1px solid #e2e8f0; background:#f8fafc; color:#0f172a; font-weight:600; cursor:pointer;">Cancel</button>
									<button id="send-results-confirm" style="padding:10px 14px; border-radius:8px; border:none; background:linear-gradient(135deg,#16a34a 0%,#15803d 100%); color:#fff; font-weight:700; cursor:pointer;">Send</button>
								</div>
							`

							const fileChecks = Array.from(
								card.querySelectorAll('input[type="checkbox"][data-output-path]'),
							)
							const dirChecks = Array.from(
								card.querySelectorAll('input[type="checkbox"][data-dir]'),
							)
							const toggleDescendants = (dirValue, checked) => {
								const prefix = dirValue ? `${dirValue}/` : ''
								fileChecks.forEach((input) => {
									const raw = input.dataset.outputPath || input.dataset.path || ''
									let decoded = raw
									try {
										decoded = decodeURIComponent(raw)
									} catch {
										decoded = raw
									}
									if (!prefix || decoded.startsWith(prefix)) {
										input.checked = checked
									}
								})
								dirChecks.forEach((input) => {
									const raw = input.dataset.dir || ''
									let decoded = raw
									try {
										decoded = decodeURIComponent(raw)
									} catch {
										decoded = raw
									}
									if (!prefix || decoded.startsWith(prefix)) {
										input.checked = checked
									}
								})
							}

							dirChecks.forEach((input) => {
								input.addEventListener('change', () => {
									const raw = input.dataset.dir || ''
									let decoded = raw
									try {
										decoded = decodeURIComponent(raw)
									} catch {
										decoded = raw
									}
									toggleDescendants(decoded, input.checked)
								})
							})

							modal.appendChild(card)
							document.body.appendChild(modal)

							const closeModal = () => {
								modal.remove()
							}
							card.querySelector('#send-results-cancel')?.addEventListener('click', closeModal)
							modal.addEventListener('click', (event) => {
								if (event.target === modal) closeModal()
							})

							card.querySelector('#send-results-confirm')?.addEventListener('click', async () => {
								const selected = Array.from(
									card.querySelectorAll('input[type="checkbox"][data-output-path]:checked'),
								)
									.map((input) => input.dataset.outputPath || input.dataset.path)
									.filter(Boolean)
									.map((value) => {
										try {
											return decodeURIComponent(value)
										} catch {
											return value
										}
									})

								if (selected.length === 0) {
									await dialog.message('Select at least one file to share.', {
										title: 'Send Results',
										type: 'warning',
									})
									return
									}

									try {
										runSelectSendBtn.disabled = true
										await invoke('send_flow_request_results', {
											requestId: msg.id,
											runId,
										outputPaths: selected,
									})
									await dialog.message('Results sent back to the shared folder.', {
										title: 'Results Sent',
										type: 'info',
									})
									closeModal()
								} catch (error) {
									console.error('Failed to send flow results:', error)
										await dialog.message(`Failed to send results: ${error?.message || error}`, {
											title: 'Send Results Error',
											type: 'error',
										})
									} finally {
										runSelectSendBtn.disabled = false
									}
								})
							})

							resultsActions.appendChild(runSelect)
							resultsActions.appendChild(runSelectOpenBtn)
							resultsActions.appendChild(runSelectSendBtn)
							requestCard.appendChild(resultsActions)

								const updateActionState = async () => {
								const runId = parseInt(runSelect.value, 10)
								const hasSelection = Number.isFinite(runId)
								runSelectOpenBtn.disabled = !hasSelection
								let hasResults = false
								if (hasSelection) {
									const run = runSelect.__runMap?.get(runId)
									const resultsDir = run?.results_dir || run?.work_dir
									if (resultsDir) {
										try {
											const entries = await invoke('list_results_tree', { root: resultsDir })
											hasResults = (entries || []).some((entry) => !entry.is_dir)
										} catch {
											hasResults = false
										}
									}
								}
									runSelectSendBtn.disabled = !hasSelection || !hasResults
									runSelectSendBtn.style.display = hasResults ? '' : 'none'
								}
								runSelect.addEventListener('change', updateActionState)
								;(async () => {
									await refreshFlowRequestActions()
									await updateActionState()
								})()
							}

					msgDiv.appendChild(requestCard)
				}

				// Flow results card
				const flowResults = getFlowResultsFromMessage(msg)
				if (flowResults) {
					const resultsCard = document.createElement('div')
					resultsCard.className = 'message-flow-results'

					const filesHtml = flowResults.files
						.map(
							(file, idx) => `
						<div class="result-file" data-file-idx="${idx}">
							<span class="file-icon">📄</span>
							<span class="file-name">${escapeHtml(file.file_name)}</span>
							<span class="file-size">${formatFileSize(file.size_bytes)}</span>
						</div>
					`,
						)
						.join('')

					resultsCard.innerHTML = `
						<h5>📊 ${escapeHtml(flowResults.flow_name)} <span class="results-label">Flow Results</span></h5>
						<p class="invite-meta">Run #${flowResults.run_id} • ${flowResults.files.length} file(s)</p>
						<p class="invite-meta">From: ${escapeHtml(flowResults.sender)}</p>
						<div class="results-files-list">${filesHtml}</div>
					`

					const actions = document.createElement('div')
					actions.className = 'invite-actions'

					const hasInlineContent = flowResults.files.some((file) => file.content_base64)

					if (flowResults.results_location && !group.isOutgoing) {
						const importBtn = document.createElement('button')
						importBtn.textContent = 'Import Results'
						importBtn.addEventListener('click', async () => {
							try {
								importBtn.disabled = true
								const destPath = await invoke('import_flow_results', {
									resultsLocation: flowResults.results_location,
									submissionId: flowResults.submission_id,
									runId: flowResults.run_id,
									flowName: flowResults.flow_name,
								})
								await invoke('open_folder', { path: destPath })
							} catch (error) {
								console.error('Failed to import results:', error)
								await dialog.message(`Failed to import results: ${error?.message || error}`, {
									title: 'Import Results Error',
									type: 'error',
								})
							} finally {
								importBtn.disabled = false
							}
						})
						actions.appendChild(importBtn)
					}

					if (hasInlineContent) {
						const saveBtn = document.createElement('button')
						saveBtn.textContent = 'Save All Files'
						saveBtn.addEventListener('click', async () => {
							try {
								// Save each file using save dialog
								for (const file of flowResults.files) {
									if (!file.content_base64) continue
									const destPath = await dialog.save({
										title: `Save ${file.file_name}`,
										defaultPath: file.file_name,
									})
									if (!destPath) continue // User cancelled

									// Decode base64 and save
									const content = atob(file.content_base64)
									const bytes = new Uint8Array(content.length)
									for (let i = 0; i < content.length; i++) {
										bytes[i] = content.charCodeAt(i)
									}
									await invoke('save_file_bytes', {
										path: destPath,
										content: Array.from(bytes),
									})
								}

								await dialog.message(`Saved ${flowResults.files.length} file(s)`, {
									title: 'Files Saved',
									type: 'info',
								})
							} catch (error) {
								console.error('Failed to save files:', error)
								await dialog.message('Failed to save files: ' + (error?.message || error), {
									title: 'Save Error',
									type: 'error',
								})
							}
						})
						actions.appendChild(saveBtn)
					}

					resultsCard.appendChild(actions)
					msgDiv.appendChild(resultsCard)
				}

				// Flow invitation card
				const flowInvitation = getFlowInvitationFromMessage(msg)
				if (flowInvitation) {
					const invitationCard = document.createElement('div')
					invitationCard.className = 'flow-invitation-card'

					// Find the current user's role
					const currentUser = getCurrentUserEmail()
					const myParticipant = flowInvitation.participants.find((p) =>
						emailsMatch(p.email, currentUser),
					)
					const myRole = myParticipant?.role || null

					const participantsHtml = flowInvitation.participants
						.map((p) => {
							const isMe = emailsMatch(p.email, currentUser)
							return `<span class="participant-chip${isMe ? ' is-me' : ''}">👤 ${escapeHtml(p.email)} (${escapeHtml(p.role)})${isMe ? ' ← you' : ''}</span>`
						})
						.join(' ')

					invitationCard.innerHTML = `
						<div class="flow-invitation-header">
							<span class="flow-invitation-icon">🔄</span>
							<span class="flow-invitation-title">${escapeHtml(flowInvitation.flow_name)}</span>
						</div>
						${myRole ? `<div class="flow-invitation-role">Your role: <strong>${escapeHtml(myRole)}</strong></div>` : ''}
						<div class="flow-invitation-participants">${participantsHtml}</div>
						<div class="flow-invitation-status"></div>
					`

					const actions = document.createElement('div')
					actions.className = 'flow-invitation-actions'

					const statusEl = invitationCard.querySelector('.flow-invitation-status')

					// Check if this exact flow name exists locally.
					// Do not infer from metadata name to avoid false positives.
					const checkFlowExists = async () => {
						try {
							const flows = await invoke('get_flows')
							return (flows || []).some((f) => f.name === flowInvitation.flow_name)
						} catch {
							return false
						}
					}

					const importFlowFromInvitation = async (overwrite = false) => {
						const flowSpec = flowInvitation.flow_spec
						if (!flowSpec) {
							throw new Error('No flow specification in invitation')
						}
						return await invoke('import_flow_from_json', {
							request: {
								name: flowInvitation.flow_name,
								flow_json: flowSpec,
								overwrite,
							},
						})
					}

					const importBtn = document.createElement('button')
					importBtn.className = 'flow-invitation-btn import-btn'
					importBtn.textContent = '📥 Import Flow'

					const joinBtn = document.createElement('button')
					joinBtn.className = 'flow-invitation-btn view-runs-btn'
					joinBtn.textContent = '🤝 Join Flow'
					joinBtn.style.display = 'none'

					importBtn.addEventListener('click', async () => {
						console.log('[Flow Import] Button clicked')
						importBtn.disabled = true
						importBtn.textContent = 'Importing...'
						try {
							console.log(
								'[Flow Import] Flow spec:',
								JSON.stringify(flowInvitation.flow_spec, null, 2).substring(0, 500),
							)
							console.log('[Flow Import] Calling import_flow_from_json...')
							const result = await importFlowFromInvitation(false)
							console.log('[Flow Import] Success:', result)

							// Update UI
							importBtn.style.display = 'none'
							joinBtn.style.display = 'inline-block'
							if (statusEl) statusEl.textContent = '✓ Flow imported'
						} catch (error) {
							console.error('[Flow Import] Failed:', error)
							importBtn.disabled = false
							importBtn.textContent = '📥 Import Flow'
							if (statusEl) statusEl.textContent = `⚠ Import failed: ${error}`
						}
					})

					joinBtn.addEventListener('click', async () => {
						// If already joined, just navigate to Runs
						if (joinBtn.classList.contains('joined')) {
							// Recover from stale "joined but not imported" state.
							const exists = await checkFlowExists()
							if (!exists) {
								try {
									if (statusEl) statusEl.textContent = 'Importing flow...'
									await importFlowFromInvitation(false)
									if (statusEl) statusEl.textContent = '✓ Flow available'
								} catch (error) {
									if (dialog?.message) {
										await dialog.message(`Flow is missing locally: ${error}`, {
											title: 'Import Required',
											kind: 'error',
										})
									}
									return
								}
							}
							const event = new CustomEvent('navigate-to-tab', { detail: { tab: 'runs' } })
							window.dispatchEvent(event)
							return
						}

						try {
							joinBtn.disabled = true
							joinBtn.textContent = 'Joining...'

							// Safety: ensure local flow import exists before accepting session.
							// This prevents "View/Join without import" broken state.
							let flowExists = await checkFlowExists()
							if (!flowExists) {
								if (statusEl) statusEl.textContent = 'Importing flow...'
								await importFlowFromInvitation(false)
								flowExists = await checkFlowExists()
								if (!flowExists) {
									throw new Error('Flow import did not complete locally')
								}
							}

							// Accept the invitation (backend only, no modal)
							const result = await invoke('accept_flow_invitation', {
								sessionId: flowInvitation.session_id,
								flowName: flowInvitation.flow_name,
								flowSpec: flowInvitation.flow_spec,
								participants: flowInvitation.participants,
								autoRunAll: false,
								threadId: activeThreadId ?? null,
							})

							console.log('[Join Flow] Accepted:', result)

							// Update button to "View Flow" and keep it clickable
							joinBtn.textContent = '📋 View Flow'
							joinBtn.classList.add('joined')
							joinBtn.disabled = false

							// Hide Decline button after joining
							declineBtn.style.display = 'none'

							// Navigate to Runs tab
							const event = new CustomEvent('navigate-to-tab', { detail: { tab: 'runs' } })
							window.dispatchEvent(event)
						} catch (error) {
							console.error('Failed to accept flow invitation:', error)
							joinBtn.disabled = false
							joinBtn.textContent = '🤝 Join Flow'
							if (dialog?.message) {
								await dialog.message(`Failed to join flow: ${error}`, {
									title: 'Error',
									kind: 'error',
								})
							}
						}
					})

					actions.appendChild(importBtn)
					actions.appendChild(joinBtn)

					const declineBtn = document.createElement('button')
					declineBtn.className = 'flow-invitation-btn decline-btn'
					declineBtn.textContent = 'Decline'

					// Hide decline button if user is the sender (proposer)
					const isSender = emailsMatch(msg.from, currentUser)
					if (isSender) {
						declineBtn.style.display = 'none'
					}

					declineBtn.addEventListener('click', async () => {
						if (dialog?.confirm) {
							const confirmed = await dialog.confirm('Decline this flow invitation?', {
								title: 'Decline Invitation',
								kind: 'warning',
							})
							if (confirmed) {
								// Hide the invitation card
								invitationCard.innerHTML = `
									<div class="flow-invitation-declined">
										<span>❌ You declined this flow invitation</span>
									</div>
								`
								invitationCard.classList.add('declined')
							}
						}
					})
					actions.appendChild(declineBtn)

					invitationCard.appendChild(actions)
					msgDiv.appendChild(invitationCard)

					// Check if flow already exists and if user already joined.
					// Keep "Import Flow" visible when joined but not imported locally.
							checkFlowExists().then(async (exists) => {
							let alreadyJoined = false
							try {
								const state = await invoke('get_multiparty_flow_state', {
									sessionId: flowInvitation.session_id,
								})
								alreadyJoined = !!(state && state.session_id && state.run_id)
							} catch (e) {
								console.log('[Flow Invitation] Session not found, user can join')
							}

							if (alreadyJoined) {
								declineBtn.style.display = 'none'
								if (exists) {
									joinBtn.style.display = 'inline-block'
									joinBtn.textContent = '📋 View Flow'
									joinBtn.classList.add('joined')
									importBtn.style.display = 'none'
									if (statusEl) statusEl.textContent = '✓ Already joined'
								} else {
									// Joined session exists, but local flow import is missing.
									// Enforce import first to avoid broken "View Flow" state.
									importBtn.style.display = 'inline-block'
									importBtn.disabled = false
									importBtn.textContent = '📥 Import Flow'
									joinBtn.style.display = 'none'
									joinBtn.classList.add('joined')
									if (statusEl) statusEl.textContent = 'Import flow to view joined session'
								}
								return
							}

							// Not joined yet: enforce Import -> Join ordering.
							if (exists) {
								joinBtn.style.display = 'inline-block'
								importBtn.style.display = 'none'
								if (statusEl) statusEl.textContent = '✓ Flow available'
							} else if (statusEl) {
								importBtn.style.display = 'inline-block'
								joinBtn.style.display = 'none'
								statusEl.textContent = 'Import flow, then join'
							}
						})
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
	// MULTIPARTY FLOW HELPERS
	// ============================================================================

	function getActiveThreadParticipants() {
		if (!activeThreadId) return []
		const thread = messageThreads.find((t) => t.thread_id === activeThreadId)
		if (!thread) return []
		return thread.participants || []
	}

	function isGroupThread() {
		const participants = getActiveThreadParticipants()
		const currentUser = getCurrentUserEmail()
		const otherParticipants = participants.filter((p) => !emailsMatch(p, currentUser))
		return otherParticipants.length > 1
	}

	async function sendMessageToRecipients({ recipients, body, subject, metadata }) {
		if (!recipients || recipients.length === 0) {
			throw new Error('No recipients specified')
		}
		if (!body) {
			throw new Error('Message body is required')
		}

		const syftboxStatus = getSyftboxStatus()
		if (!syftboxStatus.running) {
			throw new Error('You must be online to send messages')
		}

		const request =
			recipients.length === 1
				? { to: recipients[0], subject: subject || NO_SUBJECT_PLACEHOLDER, body, metadata }
				: { recipients, subject: subject || NO_SUBJECT_PLACEHOLDER, body, metadata }

		const sent = await invoke('send_message', { request })

		// Refresh thread list
		await loadMessageThreads(false, { emitToasts: false })

		return sent
	}

	function updateProposeFlowButton() {
		const btn = document.getElementById('propose-flow-btn')
		if (!btn) return

		// Show button only in group chats
		if (isGroupThread() && activeThreadId && !isComposingNewMessage) {
			btn.style.display = 'flex'
		} else {
			btn.style.display = 'none'
		}
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
		setActiveMessageFilterButton,
		getMessagesInitialized: () => messagesInitialized,
		getMessagesAuthorized: () => messagesAuthorized,
		triggerTestNotification,
		// Invite functions
		showInviteOptions,
		openInvite,
		// Failed messages
		loadFailedMessages,
		updateFailedMessagesBadge,
		handleImportSenderKey,
		dismissFailedMessage,
		deleteFailedMessage,
		// Shared renderer for embedding in other views
		renderMessagesToContainer,
		// Multiparty flow helpers
		getActiveThreadParticipants,
		isGroupThread,
		sendMessageToRecipients,
		updateProposeFlowButton,
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
