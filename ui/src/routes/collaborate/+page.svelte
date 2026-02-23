<script lang="ts">
	import { invoke } from '@tauri-apps/api/core'
	import { goto } from '$app/navigation'
	import { onMount, onDestroy } from 'svelte'
	import { syftboxAuthStore } from '$lib/stores/syftbox-auth.svelte'
	import PageHeader from '$lib/components/page-header.svelte'
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
	import UsersIcon from '@lucide/svelte/icons/users'
	import Loader2Icon from '@lucide/svelte/icons/loader-2'
	import PlusIcon from '@lucide/svelte/icons/plus'
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

	type SpaceMessageKind = 'message' | 'session_invite' | 'session_response' | 'flow_request' | 'flow_results'

	function getMessageKind(msg: VaultMessage): SpaceMessageKind {
		const meta = msg.metadata || {}
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

	function badgeForKind(kind: SpaceMessageKind): string {
		switch (kind) {
			case 'session_invite':
				return 'Session Invite'
			case 'session_response':
				return 'Session Update'
			case 'flow_request':
				return 'Flow Request'
			case 'flow_results':
				return 'Flow Results'
			default:
				return 'Message'
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
	const selectedDiscoveredCount = $derived.by(
		() =>
			createSpaceSelected.filter((id) => {
				const safe = normalizeIdentity(id)
				return safe ? !contactIdentitySet.has(safe.toLowerCase()) : false
			}).length,
	)
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
			spaceName: space.name,
			participants: space.participants,
			currentUserEmail,
			dedupeMessages: dedupeSpaceMessages,
			kindLabel: (msg: VaultMessage) => badgeForKind(getMessageKind(msg)),
			onAfterSend: () => onAfterSpaceSend(space.space_id),
			attachPaths: (paths: string[]) => attachPathsToSession(paths),
		})
	}

	function openCreateSessionDialog() {
		createSessionError = ''
		createSessionName = selectedSpace ? `Session with ${selectedSpace.name}` : 'New session'
		createSessionDialogOpen = true
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
			createSessionDialogOpen = false
			await loadSessions()
			if (created?.session_id) navigateToSessionWorkspace(created.session_id, 'overview')
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
	<PageHeader title="Spaces" description="Collaborate with your team in shared spaces.">
		{#if isAuthenticated}
			<Button size="sm" onclick={openCreateSpaceDialog}>
				<PlusIcon class="size-4" />
				Create Space
			</Button>
		{/if}
	</PageHeader>

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
		<div class="flex min-h-0 flex-1 gap-4 overflow-hidden p-4">
			<div class="flex w-80 shrink-0 flex-col overflow-hidden rounded-2xl border bg-background/95 shadow-sm backdrop-blur">
				<div class="shrink-0 border-b bg-muted/20 px-4 py-3">
					<div class="flex items-center gap-2 text-sm font-medium">
						<UsersIcon class="size-4 text-muted-foreground" />
						Spaces
					</div>
				</div>

				<div class="shrink-0 border-b p-3.5">
					<div class="relative">
						<SearchIcon class="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
						<Input placeholder="Search spaces..." bind:value={listSearch} class="h-10 pl-9" />
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
								class="mb-1 w-full rounded-xl border p-3 text-left transition-colors hover:bg-muted/50 {selectedSpace?.space_id ===
								space.space_id
									? 'border-primary/40 bg-primary/10'
									: ''}"
							>
								<div class="flex items-center gap-3">
									<Avatar.Root class="size-9 shrink-0">
										<Avatar.Fallback class="text-xs">{initials(space.name || 'SP')}</Avatar.Fallback>
									</Avatar.Root>
									<div class="min-w-0 flex-1">
										<p class="truncate text-sm font-medium">{space.name}</p>
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

			<div class="min-h-0 flex flex-1 flex-col overflow-hidden rounded-2xl border bg-background/95 shadow-sm backdrop-blur">
				{#if selectedSpace}
					<div class="shrink-0 border-b px-5 py-4">
						<div class="flex items-center justify-between gap-3">
							<div class="min-w-0">
								<h2 class="truncate text-base font-semibold">{selectedSpace.name}</h2>
								<p class="text-sm text-muted-foreground">{selectedSpace.member_count} members</p>
							</div>
							<div class="flex items-center gap-2">
								{#if selectedSpaceSessions.length > 0}
									<DropdownMenu.Root>
										<DropdownMenu.Trigger>
											<Button size="sm" variant="outline">
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
								<Button size="sm" variant="outline" onclick={openCreateSessionDialog}>
									<LockIcon class="size-4" />
									Start Session
								</Button>
							</div>
						</div>
					</div>

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
						{/snippet}
					</ConversationPanel>
				{:else}
					<div class="flex h-full items-center justify-center px-6 text-sm text-muted-foreground">
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
						? `Create a session from ${selectedSpace.name}.`
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
				<Dialog.Close class="inline-flex h-9 items-center justify-center rounded-md border px-3 text-sm">
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
				<div class="max-h-72 overflow-auto rounded-md border">
					{#if createSpaceLoading}
						<div class="p-4 text-sm text-muted-foreground">Loading contacts...</div>
					{:else if spaceCandidates.length === 0}
						<div class="p-4 text-sm text-muted-foreground">No contacts available</div>
					{:else}
						{#each spaceCandidates as contact (contact.identity)}
							{@const selected = createSpaceSelected.includes(contact.identity)}
							<button
								type="button"
								class="flex w-full items-center justify-between border-b p-3 text-left last:border-b-0 hover:bg-muted/50"
								onclick={() => toggleSpaceContact(contact.identity)}
							>
								<div class="min-w-0">
									<p class="truncate text-sm font-medium">{contact.identity}</p>
									<p class="text-xs text-muted-foreground">
										{contact.source === 'contact' ? 'Contact' : 'Discovered'}
									</p>
								</div>
								<div class="flex items-center gap-2">
									{#if contact.source === 'discovered'}
										<Badge variant="outline" class="text-[10px]">New</Badge>
									{/if}
									{#if selected}
										<CheckIcon class="size-4 text-primary" />
									{/if}
								</div>
							</button>
						{/each}
					{/if}
				</div>
				{#if selectedDiscoveredCount > 0}
					<label class="flex items-start gap-2 rounded-md border p-2 text-xs text-muted-foreground">
						<input
							type="checkbox"
							class="mt-0.5"
							bind:checked={createSpaceConfirmAdd}
						/>
						<span>
							Add {selectedDiscoveredCount} selected discovered {selectedDiscoveredCount === 1 ? 'contact' : 'contacts'} before creating this space.
						</span>
					</label>
				{/if}
				<p class="text-xs text-muted-foreground">
					Selected: {createSpaceSelected.length}
				</p>
			</div>

			<Dialog.Footer>
				<Dialog.Close class="inline-flex h-9 items-center justify-center rounded-md border px-3 text-sm">
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
