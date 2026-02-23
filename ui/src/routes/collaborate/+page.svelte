<script lang="ts">
	import { invoke } from '@tauri-apps/api/core'
	import { goto } from '$app/navigation'
	import { onMount, onDestroy } from 'svelte'
	import { syftboxAuthStore } from '$lib/stores/syftbox-auth.svelte'
	import { getAvatarToneClass } from '$lib/utils.js'
	import SyftboxSignInDialog from '$lib/components/syftbox-sign-in-dialog.svelte'
	import ConversationPanel from '$lib/components/conversation-panel.svelte'
	import { buildSpaceConversationAdapter, type ConversationAdapter } from '$lib/collab/conversation-adapters'
	import * as Empty from '$lib/components/ui/empty/index.js'
	import * as Dialog from '$lib/components/ui/dialog/index.js'
	import * as DropdownMenu from '$lib/components/ui/dropdown-menu/index.js'
	import * as Avatar from '$lib/components/ui/avatar/index.js'
	import { Button } from '$lib/components/ui/button/index.js'
	import { Input } from '$lib/components/ui/input/index.js'
	import { Badge } from '$lib/components/ui/badge/index.js'
	import { Skeleton } from '$lib/components/ui/skeleton/index.js'
	import LogInIcon from '@lucide/svelte/icons/log-in'
	import SearchIcon from '@lucide/svelte/icons/search'
	import Loader2Icon from '@lucide/svelte/icons/loader-2'
	import PlusIcon from '@lucide/svelte/icons/plus'
	import PencilIcon from '@lucide/svelte/icons/pencil'
	import LockIcon from '@lucide/svelte/icons/lock'
	import FolderOpenIcon from '@lucide/svelte/icons/folder-open'
	import CheckIcon from '@lucide/svelte/icons/check'
	import MessageSquareIcon from '@lucide/svelte/icons/message-square'
	import { toast } from 'svelte-sonner'

	interface VaultMessage {
		id: string
		from: string
		to: string
		subject?: string
		body: string
		created_at: string
		status: string
		thread_id?: string
		metadata?: Record<string, unknown>
	}

	interface Contact {
		identity: string
		fingerprint?: string
	}
	interface SpaceCandidate extends Contact {
		source: 'contact' | 'discovered'
	}

	interface NetworkScanResult {
		contacts: Contact[]
		discovered: Contact[]
	}

	interface CollaborationSpace {
		space_id: string
		thread_id: string
		name: string
		participants: string[]
		member_count: number
		last_activity_at?: string
		last_message_preview: string
		unread_count: number
	}

	interface Session {
		session_id: string
		name: string
		status: string
		owner: string
		peer?: string
		created_at: string
		session_path?: string
		description?: string
	}

	interface SessionInvitation {
		session_id: string
		session_name: string
		requester: string
		description?: string
		created_at: string
	}

	let signInDialogOpen = $state(false)
	let createSessionDialogOpen = $state(false)
	let createSessionName = $state('')
	let createSessionLoading = $state(false)
	let createSessionError = $state('')
	let createSpaceDialogOpen = $state(false)
	let createSpaceName = $state('')
	let createSpaceQuery = $state('')
	let createSpaceLoading = $state(false)
	let createSpaceError = $state('')
	let createSpaceSelected = $state<string[]>([])
	let createSpaceConfirmAdd = $state(false)
	let renameSpaceOpen = $state(false)
	let renameSpaceName = $state('')
	let renameSpaceLoading = $state(false)
	let renameSpaceError = $state('')

	let contacts = $state<Contact[]>([])
	let discovered = $state<Contact[]>([])
	let spaces = $state<CollaborationSpace[]>([])
	let sessions = $state<Session[]>([])
	let invitations = $state<SessionInvitation[]>([])

	let selectedSpace = $state<CollaborationSpace | null>(null)
	let spaceChatReloadSignal = $state(0)

	let listSearch = $state('')
	let currentUserEmail = $state('')
	let loading = $state(true)
	let loadingList = $state(false)
	let loadingSessions = $state(false)
	let eventActionLoading = $state<Record<string, boolean>>({})
	let refreshTimer: ReturnType<typeof setInterval> | null = null

	const AUTO_REFRESH_MS = 10000
	const isAuthenticated = $derived(syftboxAuthStore.isAuthenticated)
	const isCheckingAuth = $derived(syftboxAuthStore.isChecking)

	function normalizeIdentity(value: unknown): string | null {
		if (typeof value !== 'string') return null
		const trimmed = value.trim()
		return trimmed.length > 0 ? trimmed : null
	}

	function participantSignature(values: string[]): string {
		return [...new Set(values.map((v) => v.toLowerCase()))].sort().join('|')
	}

	function spaceDisplayName(
		space: Pick<CollaborationSpace, 'name' | 'participants'> | null | undefined,
	): string {
		if (!space) return 'New Space'
		const named = normalizeIdentity(space.name)
		if (named) return named
		const participants = space.participants
			.map((p) => normalizeIdentity(p))
			.filter((p): p is string => !!p)
		if (participants.length > 0) return participants.join(', ')
		return 'New Space'
	}

	function participantEmailArrayText(participants: string[]): string {
		const safe = participants
			.map((p) => normalizeIdentity(p))
			.filter((p): p is string => !!p)
		return safe.length > 0 ? `[${safe.join(', ')}]` : '[]'
	}

	function getSpaceAvatarTone(space: CollaborationSpace): string {
		return getAvatarToneClass(`space:${space.space_id}`)
	}

	function spaceRecipients(space: CollaborationSpace): string[] {
		return space.participants.filter(
			(p) => normalizeIdentity(p)?.toLowerCase() !== currentUserEmail.toLowerCase(),
		)
	}

	type SpaceMessageKind =
		| 'message'
		| 'space_event'
		| 'session_invite'
		| 'session_response'
		| 'flow_request'
		| 'flow_results'

	function getMessageKind(msg: VaultMessage): SpaceMessageKind {
		const meta = msg.metadata || {}
		if (meta.space_event) return 'space_event'
		if (meta.flow_request) return 'flow_request'
		if (meta.flow_results) return 'flow_results'
		if (meta.session_invite) return 'session_invite'
		if (meta.session_invite_response) return 'session_response'
		return 'message'
	}

	function getSessionInviteId(msg: VaultMessage): string | null {
		const meta = msg.metadata || {}
		const invite = meta.session_invite as Record<string, unknown> | undefined
		const id = invite?.session_id
		return typeof id === 'string' && id.trim().length > 0 ? id : null
	}

	function getSessionResponseId(msg: VaultMessage): string | null {
		const meta = msg.metadata || {}
		const response = meta.session_invite_response as Record<string, unknown> | undefined
		const id = response?.session_id
		return typeof id === 'string' && id.trim().length > 0 ? id : null
	}

	function getSessionMessageId(msg: VaultMessage): string | null {
		return getSessionResponseId(msg) || getSessionInviteId(msg)
	}

	function getFlowRequestMeta(msg: VaultMessage): Record<string, unknown> | null {
		const meta = msg.metadata || {}
		const fr = meta.flow_request
		return fr && typeof fr === 'object' ? (fr as Record<string, unknown>) : null
	}

	function getFlowResultsMeta(msg: VaultMessage): Record<string, unknown> | null {
		const meta = msg.metadata || {}
		const fr = meta.flow_results
		return fr && typeof fr === 'object' ? (fr as Record<string, unknown>) : null
	}

	function getSpaceEventMeta(msg: VaultMessage): Record<string, unknown> | null {
		const meta = msg.metadata || {}
		const ev = meta.space_event
		return ev && typeof ev === 'object' ? (ev as Record<string, unknown>) : null
	}

	function badgeForKind(kind: SpaceMessageKind): string | null {
		switch (kind) {
			case 'space_event':
				return null
			case 'session_invite':
				return 'Session Invite'
			case 'session_response':
				return 'Session Update'
			case 'flow_request':
				return 'Flow Request'
			case 'flow_results':
				return 'Flow Results'
			default:
				return null
		}
	}

	function setEventLoading(messageId: string, loading: boolean) {
		eventActionLoading = { ...eventActionLoading, [messageId]: loading }
	}

	const filteredSpaces = $derived(
		listSearch.trim()
			? spaces.filter((s) => {
					const q = listSearch.toLowerCase()
					return (
						s.name.toLowerCase().includes(q) ||
						s.participants.some((p) => p.toLowerCase().includes(q))
					)
				})
			: spaces,
	)

	const contactIdentitySet = $derived.by(() => {
		const set = new Set<string>()
		for (const c of contacts) {
			const id = normalizeIdentity(c.identity)
			if (id) set.add(id.toLowerCase())
		}
		return set
	})
	const selectableDiscovered = $derived.by(() =>
		discovered.filter((d) => {
			const id = normalizeIdentity(d.identity)
			return id ? !contactIdentitySet.has(id.toLowerCase()) : false
		}),
	)
	const spaceCandidates = $derived.by<SpaceCandidate[]>(() => {
		const q = createSpaceQuery.trim().toLowerCase()
		const merged: SpaceCandidate[] = [
			...contacts.map((c) => ({ ...c, source: 'contact' as const })),
			...selectableDiscovered.map((c) => ({ ...c, source: 'discovered' as const })),
		]
		return merged
			.filter((c) => !!normalizeIdentity(c.identity))
			.filter((c) => {
				const id = normalizeIdentity(c.identity)
				return id ? id.toLowerCase() !== currentUserEmail.toLowerCase() : false
			})
			.filter((c) => {
				const id = normalizeIdentity(c.identity)
				return id ? (q ? id.toLowerCase().includes(q) : true) : false
			})
			.sort((a, b) => (a.identity || '').localeCompare(b.identity || ''))
	})
	const contactCandidates = $derived(
		spaceCandidates.filter((candidate) => candidate.source === 'contact'),
	)
	const discoveredCandidates = $derived(
		spaceCandidates.filter((candidate) => candidate.source === 'discovered'),
	)
	const selectedDiscoveredCount = $derived.by(
		() =>
			createSpaceSelected.filter((id) => {
				const safe = normalizeIdentity(id)
				return safe ? !contactIdentitySet.has(safe.toLowerCase()) : false
			}).length,
	)
	$effect(() => {
		if (selectedDiscoveredCount === 0 && createSpaceConfirmAdd) {
			createSpaceConfirmAdd = false
		}
	})
	const selectedSpaceParticipantSet = $derived.by(() => {
		const set = new Set<string>()
		if (!selectedSpace) return set
		for (const p of selectedSpace.participants) {
			const safe = normalizeIdentity(p)
			if (safe) set.add(safe.toLowerCase())
		}
		return set
	})
	const selectedSpaceSessions = $derived.by(() => {
		if (!selectedSpace) return []
		return sessions.filter((session) => {
			const owner = normalizeIdentity(session.owner)
			const peer = normalizeIdentity(session.peer)
			return !!(
				(owner && selectedSpaceParticipantSet.has(owner.toLowerCase())) ||
				(peer && selectedSpaceParticipantSet.has(peer.toLowerCase()))
			)
		})
	})
	function dedupeSpaceMessages(messages: VaultMessage[]): VaultMessage[] {
		return messages.filter((msg, idx, arr) => {
			const kind = getMessageKind(msg)
			if (kind !== 'session_invite' && kind !== 'session_response') return true
			const sessionId = getSessionMessageId(msg)
			if (!sessionId) return true
			for (let i = idx + 1; i < arr.length; i++) {
				const next = arr[i]
				const nextKind = getMessageKind(next)
				if (nextKind !== 'session_invite' && nextKind !== 'session_response') continue
				if (getSessionMessageId(next) === sessionId) return false
			}
			return true
		})
	}
	function initials(identity: string): string {
		if (!identity) return '?'
		return identity.split('@')[0].slice(0, 2).toUpperCase()
	}

	function getIdentityAvatarTone(identity: string): string {
		return getAvatarToneClass(identity)
	}

	function formatTime(value: string | null | undefined): string {
		if (!value) return ''
		const date = new Date(value)
		const now = new Date()
		const diffDays = Math.floor((now.getTime() - date.getTime()) / (1000 * 60 * 60 * 24))
		if (diffDays === 0) return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
		if (diffDays === 1) return 'Yesterday'
		if (diffDays < 7) return date.toLocaleDateString([], { weekday: 'short' })
		return date.toLocaleDateString([], { month: 'short', day: 'numeric' })
	}

	function formatFullTime(value: string): string {
		const date = new Date(value)
		return date.toLocaleString([], {
			month: 'short',
			day: 'numeric',
			hour: '2-digit',
			minute: '2-digit',
		})
	}

	function isOutgoingMessage(msg: VaultMessage): boolean {
		return msg.from.toLowerCase() === currentUserEmail.toLowerCase()
	}

	function navigateToSessionWorkspace(
		sessionId: string,
		tab: 'overview' | 'datasets' | 'jupyter' | 'chat' = 'overview',
	) {
		goto(`/collaborate/sessions/${encodeURIComponent(sessionId)}?tab=${tab}`)
	}

	async function getCurrentUserEmail(): Promise<string> {
		try {
			const settings = await invoke<{ email?: string }>('get_settings')
			return settings?.email || ''
		} catch {
			return ''
		}
	}

	async function loadContacts() {
		const result = await invoke<NetworkScanResult>('network_scan_datasites')
		contacts = result?.contacts || []
		discovered = result?.discovered || []
	}

	async function loadSpaces() {
		spaces = await invoke<CollaborationSpace[]>('list_spaces', { limit: 300 })
	}

	async function loadSessions() {
		loadingSessions = true
		try {
			const [sessionList, inviteList] = await Promise.all([
				invoke<Session[]>('get_sessions'),
				invoke<SessionInvitation[]>('get_session_invitations'),
			])
			sessions = sessionList || []
			const existing = new Set(sessions.map((s) => s.session_id))
			invitations = (inviteList || []).filter((i) => !existing.has(i.session_id))
		} finally {
			loadingSessions = false
		}
	}

	async function loadSidebar(refresh = false) {
		loadingList = true
		try {
			await Promise.all([loadContacts(), loadSpaces(), loadSessions()])
			if (!selectedSpace && spaces.length > 0) {
				selectSpace(spaces[0])
			}
		} finally {
			loadingList = false
		}
	}

	function selectSpace(space: CollaborationSpace) {
		selectedSpace = space
		renameSpaceOpen = false
		renameSpaceName = ''
		renameSpaceError = ''
		spaceChatReloadSignal += 1
	}

	async function onAfterSpaceSend(spaceId: string) {
		await loadSidebar(false)
		const refreshed = spaces.find((s) => s.space_id === spaceId)
		if (refreshed) {
			selectedSpace = refreshed
			spaceChatReloadSignal += 1
		}
	}

	function getAttachmentTargetSession(): Session | null {
		const candidates = [...selectedSpaceSessions]
		if (candidates.length === 0) return null
		const active = candidates.filter((s) => s.status.toLowerCase() === 'active')
		const source = active.length > 0 ? active : candidates
		source.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
		return source[0] || null
	}

	async function attachPathsToSession(paths: string[]) {
		if (!selectedSpace) return
		const clean = paths.map((p) => p.trim()).filter((p) => p.length > 0)
		if (clean.length === 0) return
		const target = getAttachmentTargetSession()
		if (!target) {
			toast.error('No session available in this space', {
				description: 'Start or accept a session first, then attach files.',
			})
			return
		}
		const copied = await invoke<string[]>('add_files_to_session', {
			sessionId: target.session_id,
			filePaths: clean,
		})
		const count = copied?.length || 0
		if (count > 0) {
			await spaceConversationAdapter(selectedSpace).sendMessage(
				`Attached ${count} item${count === 1 ? '' : 's'} to session "${target.name}".`,
			)
			toast.success(`Attached ${count} item${count === 1 ? '' : 's'}`)
		}
	}

	function spaceConversationAdapter(space: CollaborationSpace): ConversationAdapter<VaultMessage> {
		return buildSpaceConversationAdapter<VaultMessage>({
			invoke,
			spaceId: space.space_id,
			threadId: space.thread_id,
			spaceName: spaceDisplayName(space),
			participants: space.participants,
			currentUserEmail,
			dedupeMessages: dedupeSpaceMessages,
			kindLabel: (msg: VaultMessage) => badgeForKind(getMessageKind(msg)),
			isEventMessage: (msg: VaultMessage) =>
				getMessageKind(msg) === 'space_event' ||
				msg.body.startsWith('Created space:') ||
				msg.body.startsWith('Renamed space to:') ||
				msg.body.startsWith('Created session:'),
			onAfterSend: () => onAfterSpaceSend(space.space_id),
			attachPaths: (paths: string[]) => attachPathsToSession(paths),
		})
	}

	function openCreateSessionDialog() {
		createSessionError = ''
		createSessionName = selectedSpace ? `Session with ${spaceDisplayName(selectedSpace)}` : 'New session'
		createSessionDialogOpen = true
	}

	function startRenameSpace() {
		if (!selectedSpace) return
		renameSpaceOpen = true
		renameSpaceError = ''
		renameSpaceName = spaceDisplayName(selectedSpace)
	}

	function cancelRenameSpace() {
		renameSpaceOpen = false
		renameSpaceError = ''
		renameSpaceName = ''
	}

	async function saveRenameSpace() {
		if (!selectedSpace || renameSpaceLoading) return
		const nextName = renameSpaceName.trim()
		if (!nextName) {
			renameSpaceError = 'Space name is required'
			return
		}
		const currentName = spaceDisplayName(selectedSpace)
		if (nextName === currentName) {
			cancelRenameSpace()
			return
		}
		const recipients = spaceRecipients(selectedSpace)
		if (recipients.length < 1) {
			renameSpaceError = 'This space has no recipients yet'
			return
		}

		renameSpaceLoading = true
		renameSpaceError = ''
		try {
			await invoke('send_message', {
				request: {
					recipients,
					subject: nextName,
					body: `Renamed space to: ${nextName}`,
					metadata: {
						space_event: {
							type: 'renamed',
							name: nextName,
						},
						group_chat: {
							name: nextName,
						},
					},
				},
			})
			await loadSidebar(true)
			const refreshed = spaces.find((s) => s.space_id === selectedSpace?.space_id)
			if (refreshed) selectedSpace = refreshed
			cancelRenameSpace()
			toast.success('Space renamed')
		} catch (e) {
			renameSpaceError = String(e)
		} finally {
			renameSpaceLoading = false
		}
	}

	async function createSessionFromContext() {
		const name = createSessionName.trim()
		if (!name || createSessionLoading) return
		createSessionLoading = true
		createSessionError = ''
		try {
			const peer =
				selectedSpace?.participants.find(
					(p) => normalizeIdentity(p)?.toLowerCase() !== currentUserEmail.toLowerCase(),
				) || null
			const created = await invoke<Session>('create_session', {
				request: { name, peer },
			})
			if (selectedSpace && created?.session_id) {
				const recipients = spaceRecipients(selectedSpace)
				if (recipients.length > 0) {
					await invoke('send_message', {
						request: {
							recipients,
							subject: spaceDisplayName(selectedSpace),
							body: `Created session: ${name}`,
							metadata: {
								space_event: {
									type: 'session_created',
									session_id: created.session_id,
									session_name: name,
								},
								group_chat: {
									name: spaceDisplayName(selectedSpace),
									participants: selectedSpace.participants,
								},
							},
						},
					})
				}
			}
			createSessionDialogOpen = false
			await loadSidebar(true)
			await loadSessions()
			spaceChatReloadSignal += 1
			if (!selectedSpace && created?.session_id) {
				navigateToSessionWorkspace(created.session_id, 'overview')
			}
		} catch (e) {
			createSessionError = String(e)
		} finally {
			createSessionLoading = false
		}
	}

	async function openSelectedWorkspaceSession(session: Session) {
		navigateToSessionWorkspace(session.session_id, 'overview')
	}

	function toggleSpaceContact(identity: string) {
		const safeIdentity = normalizeIdentity(identity)
		if (!safeIdentity) return
		if (createSpaceSelected.includes(safeIdentity)) {
			createSpaceSelected = createSpaceSelected.filter((v) => v !== safeIdentity)
		} else {
			createSpaceSelected = [...createSpaceSelected, safeIdentity]
		}
	}

	async function openCreateSpaceDialog(preselectIdentity?: unknown) {
		const preselected = normalizeIdentity(preselectIdentity)
		createSpaceError = ''
		createSpaceName = preselected ? `Space with ${preselected}` : ''
		createSpaceQuery = ''
		createSpaceSelected = preselected ? [preselected] : []
		createSpaceConfirmAdd = false
		createSpaceLoading = true
		try {
			await loadContacts()
			createSpaceDialogOpen = true
		} catch (e) {
			createSpaceError = String(e)
		} finally {
			createSpaceLoading = false
		}
	}

	async function createSpaceFromDialog() {
		if (createSpaceLoading) return
		if (createSpaceSelected.length < 1) {
			createSpaceError = 'Select at least 1 contact'
			return
		}
		const toImport = createSpaceSelected.filter(
			(id) => {
				const safe = normalizeIdentity(id)
				return safe ? !contactIdentitySet.has(safe.toLowerCase()) : false
			},
		)
		if (toImport.length > 0 && !createSpaceConfirmAdd) {
			createSpaceError =
				'Confirm adding selected discovered contacts before creating the space'
			return
		}
		createSpaceLoading = true
		createSpaceError = ''
		try {
			for (const identity of toImport) {
				await invoke('network_import_contact', { identity })
			}
			const current = normalizeIdentity(currentUserEmail)
			const desiredParticipants = [
				...createSpaceSelected,
				...(current ? [current] : []),
			]
			const desiredSig = participantSignature(desiredParticipants)
			const existing = spaces.find((s) => participantSignature(s.participants) === desiredSig)
			if (existing) {
				createSpaceDialogOpen = false
				selectSpace(existing)
				toast.info('Space already exists. Opened it.')
				return
			}

			const spaceLabel = createSpaceName.trim() || 'New Space'
				await invoke('send_message', {
					request: {
						recipients: createSpaceSelected,
						subject: spaceLabel,
						body: `Created space: ${spaceLabel}`,
						metadata: {
							space_event: {
								type: 'created',
								name: spaceLabel,
							},
							group_chat: {
								name: spaceLabel,
							},
						},
					},
				})
			createSpaceDialogOpen = false
			await loadSidebar(true)
			const created = spaces.find((s) => participantSignature(s.participants) === desiredSig)
			if (created) {
				selectSpace(created)
			}
			toast.success('Space created')
		} catch (e) {
			createSpaceError = String(e)
		} finally {
			createSpaceLoading = false
		}
	}

	async function acceptSessionFromMessage(msg: VaultMessage) {
		const sessionId = getSessionInviteId(msg)
		if (!sessionId) return
		setEventLoading(msg.id, true)
		try {
			await invoke('accept_session_invitation', { sessionId })
			await loadSessions()
			await loadSidebar(true)
		} finally {
			setEventLoading(msg.id, false)
		}
	}

	async function declineSessionFromMessage(msg: VaultMessage) {
		const sessionId = getSessionInviteId(msg)
		if (!sessionId) return
		setEventLoading(msg.id, true)
		try {
			await invoke('reject_session_invitation', { sessionId, reason: null })
			await loadSessions()
		} finally {
			setEventLoading(msg.id, false)
		}
	}

	async function openSessionFromMessage(msg: VaultMessage) {
		const sessionId = getSessionResponseId(msg) || getSessionInviteId(msg)
		if (!sessionId) return
		setEventLoading(msg.id, true)
		try {
			await invoke('open_session_folder', { sessionId })
		} finally {
			setEventLoading(msg.id, false)
		}
	}

	async function importFlowFromMessage(msg: VaultMessage) {
		const meta = getFlowRequestMeta(msg)
		const flowLocation = meta?.flow_location
		if (typeof flowLocation !== 'string' || !flowLocation.trim()) return
		setEventLoading(msg.id, true)
		try {
			await invoke('import_flow_from_request', {
				name: null,
				flowLocation,
				overwrite: false,
			})
			toast.success('Flow imported')
		} catch (e) {
			toast.error('Failed to import flow', { description: String(e) })
		} finally {
			setEventLoading(msg.id, false)
		}
	}

	async function importFlowResultsFromMessage(msg: VaultMessage) {
		const meta = getFlowResultsMeta(msg)
		const resultsLocation = meta?.results_location
		if (typeof resultsLocation !== 'string' || !resultsLocation.trim()) return
		setEventLoading(msg.id, true)
		try {
			await invoke('import_flow_results', {
				resultsLocation,
				submissionId:
					typeof meta?.submission_id === 'string' ? meta.submission_id : null,
				runId: typeof meta?.run_id === 'number' ? meta.run_id : null,
				flowName: typeof meta?.flow_name === 'string' ? meta.flow_name : null,
			})
			toast.success('Results imported')
		} catch (e) {
			toast.error('Failed to import results', { description: String(e) })
		} finally {
			setEventLoading(msg.id, false)
		}
	}

	function startAutoRefresh() {
		if (refreshTimer) return
		refreshTimer = setInterval(async () => {
			if (!isAuthenticated) return
			await loadSidebar(true)
			if (selectedSpace) {
				const refreshed = spaces.find((s) => s.space_id === selectedSpace?.space_id)
				if (refreshed) {
					selectedSpace = refreshed
					spaceChatReloadSignal += 1
				}
			}
		}, AUTO_REFRESH_MS)
	}

	function stopAutoRefresh() {
		if (refreshTimer) {
			clearInterval(refreshTimer)
			refreshTimer = null
		}
	}

	onMount(async () => {
		await syftboxAuthStore.checkAuth()
		currentUserEmail = await getCurrentUserEmail()
		if (syftboxAuthStore.isAuthenticated) {
			await loadSidebar(true)
		}
		loading = false
		if (syftboxAuthStore.isAuthenticated) startAutoRefresh()
	})

	onDestroy(() => {
		stopAutoRefresh()
	})
</script>

<div class="flex h-full flex-col bg-[radial-gradient(1200px_600px_at_0%_-10%,hsl(var(--muted))_0%,transparent_55%)]">
	{#if loading || isCheckingAuth}
		<div class="flex h-full items-center justify-center">
			<Loader2Icon class="size-8 animate-spin text-muted-foreground" />
		</div>
	{:else if !isAuthenticated}
		<div class="flex h-full items-center justify-center p-6">
			<Empty.Root>
				<Empty.Header>
					<Empty.Media variant="icon">
						<LogInIcon class="size-6" />
					</Empty.Media>
					<Empty.Title>Connect to SyftBox</Empty.Title>
					<Empty.Description>
						Connect to SyftBox to access secure collaboration.
					</Empty.Description>
				</Empty.Header>
				<Empty.Content>
					<Button onclick={() => (signInDialogOpen = true)}>
						<LogInIcon class="size-4" />
						Connect to SyftBox
					</Button>
				</Empty.Content>
			</Empty.Root>
		</div>
	{:else}
		<div class="flex min-h-0 flex-1 overflow-hidden">
			<div class="flex w-80 shrink-0 flex-col overflow-hidden rounded-r-2xl bg-background/90 shadow-[0_10px_30px_-18px_hsl(var(--foreground)/0.35)] ring-1 ring-border/40 backdrop-blur">
				<div class="shrink-0 border-b bg-background/70 px-4 py-2 backdrop-blur">
					<div class="flex h-11 items-center justify-between gap-2">
						<div>
							<h1 class="text-base font-semibold">Spaces</h1>
							<p class="text-xs text-muted-foreground">Collaborate with others</p>
						</div>
						<Button
							size="icon"
							variant="secondary"
							class="h-11 w-11 shrink-0 rounded-lg"
							onclick={openCreateSpaceDialog}
							aria-label="Create space"
						>
							<PlusIcon class="size-4" />
						</Button>
					</div>
				</div>
				<div class="shrink-0 px-3 pb-2 pt-2">
					<div class="flex items-center gap-2">
						<div class="relative min-w-0 flex-1">
							<SearchIcon class="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
							<Input placeholder="Search spaces..." bind:value={listSearch} class="h-10 pl-9" />
						</div>
					</div>
				</div>

				<div class="min-h-0 flex-1 overflow-auto p-2">
					{#if loadingList}
						<div class="space-y-2 p-3">
							<Skeleton class="h-10 w-full" />
							<Skeleton class="h-10 w-full" />
							<Skeleton class="h-10 w-full" />
						</div>
					{:else}
						{#each filteredSpaces as space (space.space_id)}
								<button
									type="button"
									onclick={() => selectSpace(space)}
								class="mb-1.5 w-full rounded-xl bg-background/70 px-3 py-2.5 text-left transition-[background,box-shadow] hover:bg-muted/45 {selectedSpace?.space_id ===
									space.space_id
										? 'bg-primary/[0.08] shadow-sm ring-1 ring-primary/25'
										: 'ring-1 ring-transparent'}"
								>
									<div class="flex items-center gap-3">
										<Avatar.Root class="size-9 shrink-0">
											<Avatar.Fallback class={`text-xs ${getSpaceAvatarTone(space)}`}
												>{initials(spaceDisplayName(space) || 'SP')}</Avatar.Fallback
											>
										</Avatar.Root>
										<div class="min-w-0 flex-1">
											<p class="truncate text-sm font-medium">{spaceDisplayName(space)}</p>
											<p class="truncate text-xs text-muted-foreground">
												{space.member_count} members • {space.last_message_preview}
											</p>
										</div>
										<span class="text-xs text-muted-foreground">{formatTime(space.last_activity_at)}</span>
									</div>
								</button>
						{:else}
							<div class="p-6 text-center text-sm text-muted-foreground">
								No spaces found
							</div>
						{/each}
					{/if}
				</div>
			</div>

				<div class="w-px shrink-0 self-stretch bg-border/60"></div>
				<div class="min-h-0 flex flex-1 flex-col overflow-hidden">
					{#if selectedSpace}
						<div class="shrink-0 border-b bg-background/70 px-4 py-2 backdrop-blur">
							<div class="flex h-11 items-center justify-between gap-3">
								<div class="min-w-0 flex-1">
									{#if renameSpaceOpen}
										<div class="space-y-1">
											<div class="flex items-center gap-2">
												<Input
													class="h-8 max-w-sm"
													placeholder="Space name"
													bind:value={renameSpaceName}
													onkeydown={(e) => {
														if (e.key === 'Enter') {
															e.preventDefault()
															void saveRenameSpace()
														}
														if (e.key === 'Escape') {
															e.preventDefault()
															cancelRenameSpace()
														}
													}}
												/>
												<Button
													size="sm"
													variant="secondary"
													disabled={renameSpaceLoading || !renameSpaceName.trim()}
													onclick={saveRenameSpace}
												>
													{#if renameSpaceLoading}
														<Loader2Icon class="size-4 animate-spin" />
													{:else}
														Save
													{/if}
												</Button>
												<Button size="sm" variant="ghost" onclick={cancelRenameSpace}>
													Cancel
												</Button>
											</div>
											{#if renameSpaceError}
												<p class="text-xs text-destructive">{renameSpaceError}</p>
											{/if}
										</div>
									{:else}
										<div class="flex min-w-0 flex-col justify-center">
											<div class="flex min-w-0 items-center gap-2">
												<h2 class="truncate text-base font-semibold">{spaceDisplayName(selectedSpace)}</h2>
												<Button
													size="icon"
													variant="ghost"
													class="size-7"
													onclick={startRenameSpace}
													aria-label="Rename space"
												>
													<PencilIcon class="size-4" />
												</Button>
											</div>
											<p class="truncate text-xs text-muted-foreground">
												{selectedSpace.member_count} members • {participantEmailArrayText(selectedSpace.participants)}
											</p>
										</div>
									{/if}
								</div>
								<div class="shrink-0 flex items-center gap-2">
								{#if selectedSpaceSessions.length > 0}
									<DropdownMenu.Root>
										<DropdownMenu.Trigger>
											<Button size="sm" variant="secondary">
												<MessageSquareIcon class="size-4" />
												Sessions ({selectedSpaceSessions.length})
											</Button>
										</DropdownMenu.Trigger>
										<DropdownMenu.Content class="w-72">
											{#each selectedSpaceSessions as session (session.session_id)}
												<DropdownMenu.Item onclick={() => openSelectedWorkspaceSession(session)}>
													<div class="min-w-0">
														<p class="truncate text-sm font-medium">{session.name}</p>
														<p class="truncate text-xs text-muted-foreground">
															{session.status} • {session.peer || session.owner}
														</p>
													</div>
												</DropdownMenu.Item>
											{/each}
										</DropdownMenu.Content>
									</DropdownMenu.Root>
								{/if}
								<Button size="sm" variant="secondary" onclick={openCreateSessionDialog}>
									<LockIcon class="size-4" />
									Start Session
								</Button>
							</div>
						</div>
					</div>

					<div class="min-h-0 flex-1">
						<ConversationPanel
							adapter={spaceConversationAdapter(selectedSpace)}
							reloadSignal={spaceChatReloadSignal}
						>
							{#snippet actions(msg)}
								{@const typed = msg as VaultMessage}
								{@const kind = getMessageKind(typed)}
								{#if kind === 'session_invite'}
									{@const sessionId = getSessionInviteId(typed)}
									{#if sessionId}
										<div class="mt-2 flex gap-2">
											<Button
												size="sm"
												class="h-7 text-xs"
												disabled={eventActionLoading[typed.id]}
												onclick={() => acceptSessionFromMessage(typed)}
											>
												Accept
											</Button>
											<Button
												variant="outline"
												size="sm"
												class="h-7 text-xs"
												disabled={eventActionLoading[typed.id]}
												onclick={() => declineSessionFromMessage(typed)}
											>
												Decline
											</Button>
											<Button
												variant="outline"
												size="sm"
												class="h-7 text-xs"
												onclick={() => navigateToSessionWorkspace(sessionId, 'overview')}
											>
												Workspace
											</Button>
										</div>
									{/if}
								{/if}
								{#if kind === 'flow_request'}
									<div class="mt-2 flex gap-2">
										<Button
											size="sm"
											variant="outline"
											class="h-7 text-xs"
											disabled={eventActionLoading[typed.id]}
											onclick={() => importFlowFromMessage(typed)}
										>
											Import Flow
										</Button>
									</div>
								{/if}
								{#if kind === 'flow_results'}
									<div class="mt-2 flex gap-2">
										<Button
											size="sm"
											variant="outline"
											class="h-7 text-xs"
											disabled={eventActionLoading[typed.id]}
											onclick={() => importFlowResultsFromMessage(typed)}
										>
											Import Results
										</Button>
									</div>
								{/if}
							{#if kind === 'session_response'}
								{@const responseSessionId = getSessionResponseId(typed)}
								{#if responseSessionId}
										<div class="mt-2 flex gap-2">
											<Button
												size="sm"
												variant="outline"
												class="h-7 text-xs"
												onclick={() => navigateToSessionWorkspace(responseSessionId, 'overview')}
											>
												Workspace
											</Button>
											<Button
												size="sm"
												variant="outline"
												class="h-7 text-xs"
												disabled={eventActionLoading[typed.id]}
												onclick={() => openSessionFromMessage(typed)}
											>
												Open Folder
											</Button>
									</div>
								{/if}
							{/if}
							{#if kind === 'space_event'}
								{@const spaceEvent = getSpaceEventMeta(typed)}
								{@const eventType = typeof spaceEvent?.type === 'string' ? spaceEvent.type : null}
								{#if eventType === 'session_created'}
									{@const eventSessionId =
										typeof spaceEvent?.session_id === 'string' ? spaceEvent.session_id : null}
									{@const eventSessionName =
										typeof spaceEvent?.session_name === 'string' ? spaceEvent.session_name : 'session'}
									{#if eventSessionId}
										<button
											type="button"
											class="underline underline-offset-2 hover:no-underline text-emerald-900/90"
											onclick={() => navigateToSessionWorkspace(eventSessionId, 'overview')}
										>
											{eventSessionName}
										</button>
									{/if}
								{/if}
							{/if}
						{/snippet}
					</ConversationPanel>
				</div>
				{:else}
					<div class="min-h-0 flex flex-1 items-center justify-center px-6 text-sm text-muted-foreground">
						Choose a space from the left, or create one.
					</div>
				{/if}
			</div>
		</div>
	{/if}

	<SyftboxSignInDialog bind:open={signInDialogOpen} />
	<Dialog.Root bind:open={createSessionDialogOpen}>
		<Dialog.Content class="sm:max-w-md">
			<Dialog.Header>
				<Dialog.Title>Start Session</Dialog.Title>
				<Dialog.Description>
					{selectedSpace
						? `Create a session from ${spaceDisplayName(selectedSpace)}.`
						: 'Create a new collaboration session.'}
				</Dialog.Description>
			</Dialog.Header>

			<div class="space-y-3 py-2">
				<Input placeholder="Session name..." bind:value={createSessionName} />
				{#if createSessionError}
					<p class="text-sm text-destructive">{createSessionError}</p>
				{/if}
			</div>

			<Dialog.Footer>
				<Dialog.Close class="inline-flex h-9 items-center justify-center rounded-md bg-muted/60 px-3 text-sm hover:bg-muted">
					Cancel
				</Dialog.Close>
				<Button onclick={createSessionFromContext} disabled={createSessionLoading || !createSessionName.trim()}>
					{#if createSessionLoading}
						<Loader2Icon class="size-4 animate-spin" />
						Creating...
					{:else}
						Start Session
					{/if}
				</Button>
			</Dialog.Footer>
		</Dialog.Content>
	</Dialog.Root>
	<Dialog.Root bind:open={createSpaceDialogOpen}>
		<Dialog.Content class="sm:max-w-lg">
			<Dialog.Header>
				<Dialog.Title>Create Space</Dialog.Title>
				<Dialog.Description>
					Select contacts and create a shared conversation space.
				</Dialog.Description>
			</Dialog.Header>

			<div class="space-y-3 py-2">
				<Input placeholder="Space name (optional)" bind:value={createSpaceName} />
				<Input placeholder="Search contacts..." bind:value={createSpaceQuery} />
				{#if createSpaceError}
					<p class="text-sm text-destructive">{createSpaceError}</p>
				{/if}
				<div class="max-h-72 overflow-auto rounded-lg bg-muted/20 p-1">
					{#if createSpaceLoading}
						<div class="p-4 text-sm text-muted-foreground">Loading contacts...</div>
					{:else if spaceCandidates.length === 0}
						<div class="p-4 text-sm text-muted-foreground">No contacts available</div>
					{:else}
						{#if contactCandidates.length > 0}
							<div class="sticky top-0 z-10 mb-1 flex items-center justify-between rounded-md bg-muted/70 px-2 py-1 text-[11px] font-medium text-muted-foreground backdrop-blur">
								<span>Contacts</span>
								<Badge variant="secondary" class="h-5 px-1.5 text-[10px]">
									{contactCandidates.length}
								</Badge>
							</div>
							{#each contactCandidates as contact (contact.identity)}
								{@const selected = createSpaceSelected.includes(contact.identity)}
								<button
									type="button"
									class="mb-1 flex w-full items-center justify-between rounded-md p-3 text-left hover:bg-background/80"
									onclick={() => toggleSpaceContact(contact.identity)}
								>
									<div class="min-w-0 flex items-center gap-3">
										<Avatar.Root class="size-8 shrink-0">
											<Avatar.Fallback class={`text-xs ${getIdentityAvatarTone(contact.identity)}`}
												>{initials(contact.identity)}</Avatar.Fallback
											>
										</Avatar.Root>
										<div class="min-w-0">
											<p class="truncate text-sm font-medium">{contact.identity}</p>
											<p class="text-xs text-muted-foreground">Trusted contact</p>
										</div>
									</div>
									<div class="flex items-center gap-2">
										<Badge variant="secondary" class="text-[10px]">Contact</Badge>
										<span class="inline-flex size-4 items-center justify-center">
											<CheckIcon
												class="size-4 transition-opacity {selected ? 'text-primary opacity-100' : 'opacity-0'}"
											/>
										</span>
									</div>
								</button>
							{/each}
						{/if}

						{#if discoveredCandidates.length > 0}
							<div class="sticky top-0 z-10 mb-1 mt-2 flex items-center justify-between rounded-md bg-amber-50/80 px-2 py-1 text-[11px] font-medium text-amber-800 backdrop-blur">
								<span>Discovered on network</span>
								<Badge variant="outline" class="h-5 border-amber-300 px-1.5 text-[10px] text-amber-800">
									{discoveredCandidates.length}
								</Badge>
							</div>
							{#each discoveredCandidates as contact (contact.identity)}
								{@const selected = createSpaceSelected.includes(contact.identity)}
								<button
									type="button"
									class="mb-1 flex w-full items-center justify-between rounded-md border border-amber-200/60 bg-amber-50/30 p-3 text-left hover:bg-amber-50/60"
									onclick={() => toggleSpaceContact(contact.identity)}
								>
									<div class="min-w-0 flex items-center gap-3">
										<Avatar.Root class="size-8 shrink-0">
											<Avatar.Fallback class={`text-xs ${getIdentityAvatarTone(contact.identity)}`}
												>{initials(contact.identity)}</Avatar.Fallback
											>
										</Avatar.Root>
										<div class="min-w-0">
											<p class="truncate text-sm font-medium">{contact.identity}</p>
											<p class="text-xs text-amber-800/80">Not in contacts yet</p>
										</div>
									</div>
									<div class="flex items-center gap-2">
										<Badge variant="outline" class="border-amber-300 text-[10px] text-amber-800">Discovered</Badge>
										<span class="inline-flex size-4 items-center justify-center">
											<CheckIcon
												class="size-4 transition-opacity {selected ? 'text-primary opacity-100' : 'opacity-0'}"
											/>
										</span>
									</div>
								</button>
							{/each}
						{/if}
					{/if}
				</div>
				{#if selectedDiscoveredCount > 0}
					<div class="min-h-20 rounded-md border border-amber-300/70 bg-amber-50/50 p-3">
						<label class="flex items-start gap-3">
							<input
								type="checkbox"
								class="mt-1 size-4"
								bind:checked={createSpaceConfirmAdd}
							/>
							<span class="space-y-0.5">
								<span class="block text-sm font-medium">
									Add selected discovered users to Contacts
								</span>
								<span class="block text-sm text-muted-foreground">
									If checked, {selectedDiscoveredCount} selected discovered {selectedDiscoveredCount === 1
										? 'user will be added'
										: 'users will be added'} to your Contacts before this space is created.
								</span>
							</span>
						</label>
					</div>
				{/if}
				<p class="text-xs text-muted-foreground">
					Selected: {createSpaceSelected.length}
				</p>
			</div>

			<Dialog.Footer>
				<Dialog.Close class="inline-flex h-9 items-center justify-center rounded-md bg-muted/60 px-3 text-sm hover:bg-muted">
					Cancel
				</Dialog.Close>
				<Button onclick={createSpaceFromDialog} disabled={createSpaceLoading}>
					{#if createSpaceLoading}
						<Loader2Icon class="size-4 animate-spin" />
						Creating...
					{:else}
						Create Space
					{/if}
				</Button>
			</Dialog.Footer>
		</Dialog.Content>
	</Dialog.Root>
</div>
