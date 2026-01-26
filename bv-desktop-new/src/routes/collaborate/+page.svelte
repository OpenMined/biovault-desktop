<script lang="ts">
	import { invoke } from '@tauri-apps/api/core'
	import { onMount, onDestroy } from 'svelte'
	import { syftboxAuthStore } from '$lib/stores/syftbox-auth.svelte'
	import PageHeader from '$lib/components/page-header.svelte'
	import SyftboxSignInDialog from '$lib/components/syftbox-sign-in-dialog.svelte'
	import * as Empty from '$lib/components/ui/empty/index.js'
	import * as Avatar from '$lib/components/ui/avatar/index.js'
	import { Button } from '$lib/components/ui/button/index.js'
	import { Input } from '$lib/components/ui/input/index.js'
	import { Textarea } from '$lib/components/ui/textarea/index.js'
	import { Badge } from '$lib/components/ui/badge/index.js'
	import { Skeleton } from '$lib/components/ui/skeleton/index.js'
	import InboxIcon from '@lucide/svelte/icons/inbox'
	import SendIcon from '@lucide/svelte/icons/send'
	import PlusIcon from '@lucide/svelte/icons/plus'
	import SearchIcon from '@lucide/svelte/icons/search'
	import TrashIcon from '@lucide/svelte/icons/trash-2'
	import ArrowLeftIcon from '@lucide/svelte/icons/arrow-left'
	import Loader2Icon from '@lucide/svelte/icons/loader-2'
	import LogInIcon from '@lucide/svelte/icons/log-in'
	import ExternalLinkIcon from '@lucide/svelte/icons/external-link'
	import UsersIcon from '@lucide/svelte/icons/users'
	import MessageSquareIcon from '@lucide/svelte/icons/message-square'
	import UserPlusIcon from '@lucide/svelte/icons/user-plus'
	import UserCheckIcon from '@lucide/svelte/icons/user-check'
	import RefreshCwIcon from '@lucide/svelte/icons/refresh-cw'
	import FolderOpenIcon from '@lucide/svelte/icons/folder-open'
	import PlayIcon from '@lucide/svelte/icons/play'
	import SquareIcon from '@lucide/svelte/icons/square'
	import LockIcon from '@lucide/svelte/icons/lock'
	import DatabaseIcon from '@lucide/svelte/icons/database'

	async function openUrl(url: string) {
		try {
			await invoke('open_url', { url })
		} catch {
			window.open(url, '_blank')
		}
	}

	// Types matching backend
	interface MessageThreadSummary {
		thread_id: string
		subject: string
		participants: string[]
		unread_count: number
		last_message_at: string | null
		last_message_preview: string
		has_project: boolean
		session_id?: string
		session_name?: string
	}

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
		local_bundle_path?: string
		has_changed?: boolean
	}

	interface NetworkScanResult {
		contacts: Contact[]
		discovered: Contact[]
	}

	interface Session {
		session_id: string
		name: string
		description?: string
		status: string
		owner: string
		peer?: string
		created_at: string
		session_path?: string
		role?: string
	}

	interface SessionInvitation {
		session_id: string
		session_name: string
		requester: string
		description?: string
		created_at: string
	}

	// Main tab state
	let activeMainTab = $state<'messages' | 'sessions' | 'contacts'>('messages')

	// Messages state
	let threads = $state<MessageThreadSummary[]>([])
	let selectedThread = $state<MessageThreadSummary | null>(null)
	let messages = $state<VaultMessage[]>([])
	let loadingMessages = $state(false)
	let sending = $state(false)
	let searchQuery = $state('')
	let draftMessage = $state('')
	let isComposing = $state(false)
	let composeRecipient = $state('')
	let composeSubject = $state('')
	let composeBody = $state('')

	// Contacts state
	let contacts = $state<Contact[]>([])
	let discovered = $state<Contact[]>([])
	let loadingContacts = $state(false)
	let contactSearchQuery = $state('')

	// Sessions state
	let sessions = $state<Session[]>([])
	let sessionInvitations = $state<SessionInvitation[]>([])
	let selectedSession = $state<Session | null>(null)
	let loadingSessions = $state(false)
	let sessionSearchQuery = $state('')

	// Global state
	let loading = $state(true)
	let error = $state<string | null>(null)
	let currentUserEmail = $state('')

	// Refresh interval
	let refreshInterval: ReturnType<typeof setInterval> | null = null
	const AUTO_REFRESH_MS = 10000

	// SyftBox auth state
	let signInDialogOpen = $state(false)
	const isAuthenticated = $derived(syftboxAuthStore.isAuthenticated)
	const isCheckingAuth = $derived(syftboxAuthStore.isChecking)

	// Derived: filtered lists
	const filteredThreads = $derived(
		searchQuery.trim()
			? threads.filter((thread) => {
					const query = searchQuery.toLowerCase()
					return (
						thread.subject.toLowerCase().includes(query) ||
						thread.participants.some((p) => p.toLowerCase().includes(query)) ||
						thread.last_message_preview.toLowerCase().includes(query)
					)
				})
			: threads
	)

	const filteredContacts = $derived(
		contactSearchQuery.trim()
			? contacts.filter((c) => c.identity.toLowerCase().includes(contactSearchQuery.toLowerCase()))
			: contacts
	)

	const filteredDiscovered = $derived(
		contactSearchQuery.trim()
			? discovered.filter((c) =>
					c.identity.toLowerCase().includes(contactSearchQuery.toLowerCase())
				)
			: discovered
	)

	const filteredSessions = $derived(
		sessionSearchQuery.trim()
			? sessions.filter((s) => {
					const query = sessionSearchQuery.toLowerCase()
					return (
						s.name.toLowerCase().includes(query) ||
						(s.peer?.toLowerCase().includes(query) ?? false) ||
						s.status.toLowerCase().includes(query)
					)
				})
			: sessions
	)

	// Unread counts for badges
	const unreadMessageCount = $derived(threads.filter((t) => t.unread_count > 0).length)
	const pendingInvitesCount = $derived(sessionInvitations.length)

	let initialDataLoaded = $state(false)

	// Load data when user signs in
	$effect(() => {
		if (isAuthenticated && !initialDataLoaded && !loading) {
			initialDataLoaded = true
			loadAllData(true)
			startAutoRefresh()
		}
	})

	async function getCurrentUserEmail(): Promise<string> {
		try {
			const settings = await invoke<{ email?: string }>('get_settings')
			return settings?.email || ''
		} catch {
			return ''
		}
	}

	async function loadAllData(refresh = false) {
		await Promise.all([loadThreads(refresh), loadContacts(), loadSessions()])
	}

	// Messages functions
	async function loadThreads(refresh = false) {
		try {
			if (refresh) {
				const result = await invoke<{
					threads: MessageThreadSummary[]
					new_messages: number
				}>('refresh_messages_batched', { scope: 'all' })
				threads = result?.threads || []
			} else {
				threads = await invoke<MessageThreadSummary[]>('list_message_threads', {
					scope: 'all'
				})
			}
		} catch (e) {
			console.error('Failed to load threads:', e)
			error = e instanceof Error ? e.message : String(e)
		}
	}

	async function loadMessages(threadId: string) {
		loadingMessages = true
		try {
			messages = await invoke<VaultMessage[]>('get_thread_messages', { threadId })
			setTimeout(() => {
				const container = document.getElementById('message-container')
				if (container) container.scrollTop = container.scrollHeight
			}, 50)
		} catch (e) {
			console.error('Failed to load messages:', e)
			error = e instanceof Error ? e.message : String(e)
		} finally {
			loadingMessages = false
		}
	}

	function selectThread(thread: MessageThreadSummary) {
		isComposing = false
		selectedThread = thread
		loadMessages(thread.thread_id)
	}

	function startCompose() {
		isComposing = true
		selectedThread = null
		messages = []
		composeRecipient = ''
		composeSubject = ''
		composeBody = ''
	}

	function cancelCompose() {
		isComposing = false
		composeRecipient = ''
		composeSubject = ''
		composeBody = ''
	}

	async function sendMessage() {
		if (isComposing) {
			if (!composeRecipient.trim() || !composeBody.trim()) return

			sending = true
			try {
				const sent = await invoke<VaultMessage>('send_message', {
					request: {
						to: composeRecipient.trim(),
						subject: composeSubject.trim() || '(No Subject)',
						body: composeBody.trim()
					}
				})

				await loadThreads(false)
				const newThread = threads.find(
					(t) => t.thread_id === sent.thread_id || t.thread_id === sent.id
				)
				if (newThread) {
					selectThread(newThread)
				}
				isComposing = false
				composeRecipient = ''
				composeSubject = ''
				composeBody = ''
			} catch (e) {
				console.error('Failed to send message:', e)
				error = e instanceof Error ? e.message : String(e)
			} finally {
				sending = false
			}
		} else if (selectedThread && draftMessage.trim()) {
			sending = true
			try {
				const lastMessage = messages[messages.length - 1]
				await invoke('send_message', {
					request: {
						to: getOtherParticipant(selectedThread.participants),
						subject: selectedThread.subject,
						body: draftMessage.trim(),
						reply_to: lastMessage?.id
					}
				})

				draftMessage = ''
				await loadMessages(selectedThread.thread_id)
				await loadThreads(false)
			} catch (e) {
				console.error('Failed to send reply:', e)
				error = e instanceof Error ? e.message : String(e)
			} finally {
				sending = false
			}
		}
	}

	// Contacts functions
	async function loadContacts() {
		loadingContacts = true
		try {
			const result = await invoke<NetworkScanResult>('network_scan_datasites')
			contacts = result?.contacts || []
			discovered = result?.discovered || []
		} catch (e) {
			console.error('Failed to load contacts:', e)
		} finally {
			loadingContacts = false
		}
	}

	async function addContact(identity: string) {
		try {
			await invoke('network_import_contact', { identity })
			await loadContacts()
		} catch (e) {
			console.error('Failed to add contact:', e)
		}
	}

	async function removeContact(identity: string) {
		if (!confirm(`Remove ${identity} from your contacts?`)) return
		try {
			await invoke('network_remove_contact', { identity })
			await loadContacts()
		} catch (e) {
			console.error('Failed to remove contact:', e)
		}
	}

	function messageContact(identity: string) {
		activeMainTab = 'messages'
		isComposing = true
		selectedThread = null
		messages = []
		composeRecipient = identity
		composeSubject = ''
		composeBody = ''
	}

	// Sessions functions
	async function loadSessions() {
		loadingSessions = true
		try {
			const [sessionsResult, invitesResult] = await Promise.all([
				invoke<Session[]>('get_sessions'),
				invoke<SessionInvitation[]>('get_session_invitations')
			])
			sessions = sessionsResult || []
			// Filter out invites for sessions we already have
			const existingIds = new Set(sessions.map((s) => s.session_id))
			sessionInvitations = (invitesResult || []).filter((i) => !existingIds.has(i.session_id))
		} catch (e) {
			console.error('Failed to load sessions:', e)
		} finally {
			loadingSessions = false
		}
	}

	function selectSession(session: Session) {
		selectedSession = session
	}

	async function acceptInvitation(sessionId: string) {
		try {
			const session = await invoke<Session>('accept_session_invitation', { sessionId })
			await loadSessions()
			selectedSession = session
		} catch (e) {
			console.error('Failed to accept invitation:', e)
		}
	}

	async function rejectInvitation(sessionId: string) {
		if (!confirm('Decline this session invite?')) return
		try {
			await invoke('reject_session_invitation', { sessionId, reason: null })
			sessionInvitations = sessionInvitations.filter((i) => i.session_id !== sessionId)
			await loadSessions()
		} catch (e) {
			console.error('Failed to reject invitation:', e)
		}
	}

	async function openSessionFolder(sessionId: string) {
		try {
			await invoke('open_session_folder', { sessionId })
		} catch (e) {
			console.error('Failed to open folder:', e)
		}
	}

	// Utility functions
	function getOtherParticipant(participants: string[]): string {
		const other = participants.find(
			(p) => p.toLowerCase() !== currentUserEmail.toLowerCase()
		)
		return other || participants[0] || ''
	}

	function getInitials(email: string): string {
		if (!email) return '?'
		const name = email.split('@')[0]
		return name.slice(0, 2).toUpperCase()
	}

	function formatTime(dateStr: string | null): string {
		if (!dateStr) return ''
		const date = new Date(dateStr)
		const now = new Date()
		const diffDays = Math.floor((now.getTime() - date.getTime()) / (1000 * 60 * 60 * 24))

		if (diffDays === 0) {
			return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
		} else if (diffDays === 1) {
			return 'Yesterday'
		} else if (diffDays < 7) {
			return date.toLocaleDateString([], { weekday: 'short' })
		} else {
			return date.toLocaleDateString([], { month: 'short', day: 'numeric' })
		}
	}

	function formatFullTime(dateStr: string): string {
		const date = new Date(dateStr)
		return date.toLocaleString([], {
			month: 'short',
			day: 'numeric',
			hour: '2-digit',
			minute: '2-digit'
		})
	}

	function isOutgoing(msg: VaultMessage): boolean {
		return msg.from.toLowerCase() === currentUserEmail.toLowerCase()
	}

	function handleKeydown(e: KeyboardEvent) {
		if (e.key === 'Enter' && !e.shiftKey) {
			e.preventDefault()
			sendMessage()
		}
	}

	function startAutoRefresh() {
		if (refreshInterval) return
		refreshInterval = setInterval(() => {
			if (isAuthenticated) {
				loadThreads(true)
				loadSessions()
				if (selectedThread) {
					loadMessages(selectedThread.thread_id)
				}
			}
		}, AUTO_REFRESH_MS)
	}

	function stopAutoRefresh() {
		if (refreshInterval) {
			clearInterval(refreshInterval)
			refreshInterval = null
		}
	}

	onMount(async () => {
		await syftboxAuthStore.checkAuth()
		currentUserEmail = await getCurrentUserEmail()

		if (syftboxAuthStore.isAuthenticated) {
			await loadAllData(true)
		}
		loading = false

		if (syftboxAuthStore.isAuthenticated) {
			startAutoRefresh()
		}
	})

	onDestroy(() => {
		stopAutoRefresh()
	})
</script>

<div class="flex h-full flex-col">
	<PageHeader title="Collaborate" description="Messages, sessions, and contacts">
		{#if isAuthenticated}
			{#if activeMainTab === 'messages'}
				<Button size="sm" onclick={startCompose}>
					<PlusIcon class="size-4" />
					New Message
				</Button>
			{:else if activeMainTab === 'sessions'}
				<Button size="sm" disabled>
					<PlusIcon class="size-4" />
					New Session
				</Button>
			{/if}
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
						Connect to SyftBox to access secure messaging, sessions, and collaborate with others.
					</Empty.Description>
				</Empty.Header>
				<Empty.Content>
					<Button onclick={() => (signInDialogOpen = true)}>
						<LogInIcon class="size-4" />
						Connect to SyftBox
					</Button>
				</Empty.Content>
				<div class="mt-6 pt-6 border-t max-w-sm text-center">
					<p class="text-xs font-medium text-muted-foreground mb-1">What is SyftBox?</p>
					<p class="text-xs text-muted-foreground mb-3">
						An open-source network for privacy-first, offline-capable AI. Build apps, run federated
						learning, and advance PETs research.
					</p>
					<button
						type="button"
						class="text-xs text-primary hover:underline inline-flex items-center gap-1"
						onclick={() => openUrl('https://www.syftbox.net/')}
					>
						Learn more at syftbox.net
						<ExternalLinkIcon class="size-3" />
					</button>
				</div>
			</Empty.Root>
		</div>
	{:else}
		<div class="flex flex-1 overflow-hidden">
			<!-- Left Sidebar with Tabs -->
			<div class="w-80 shrink-0 border-r flex flex-col bg-muted/30">
				<!-- Main Tab Navigation -->
				<div class="flex flex-col h-full">
					<div class="flex border-b">
						<button
							type="button"
							onclick={() => (activeMainTab = 'messages')}
							class="flex-1 flex items-center justify-center gap-1.5 px-4 py-2.5 text-sm font-medium transition-colors {activeMainTab === 'messages'
								? 'text-foreground border-b-2 border-primary bg-background'
								: 'text-muted-foreground hover:text-foreground'}"
						>
							<MessageSquareIcon class="size-4" />
							Messages
							{#if unreadMessageCount > 0}
								<Badge variant="default" class="h-5 min-w-5 text-xs ml-1">
									{unreadMessageCount}
								</Badge>
							{/if}
						</button>
						<button
							type="button"
							onclick={() => (activeMainTab = 'sessions')}
							class="flex-1 flex items-center justify-center gap-1.5 px-4 py-2.5 text-sm font-medium transition-colors {activeMainTab === 'sessions'
								? 'text-foreground border-b-2 border-primary bg-background'
								: 'text-muted-foreground hover:text-foreground'}"
						>
							<LockIcon class="size-4" />
							Sessions
							{#if pendingInvitesCount > 0}
								<Badge variant="secondary" class="h-5 min-w-5 text-xs ml-1">
									{pendingInvitesCount}
								</Badge>
							{/if}
						</button>
						<button
							type="button"
							onclick={() => (activeMainTab = 'contacts')}
							class="flex-1 flex items-center justify-center gap-1.5 px-4 py-2.5 text-sm font-medium transition-colors {activeMainTab === 'contacts'
								? 'text-foreground border-b-2 border-primary bg-background'
								: 'text-muted-foreground hover:text-foreground'}"
						>
							<UsersIcon class="size-4" />
							Contacts
						</button>
					</div>

					<!-- Messages Tab Content -->
					{#if activeMainTab === 'messages'}
					<div class="flex-1 flex flex-col overflow-hidden">
						<div class="p-3 border-b">
							<div class="relative">
								<SearchIcon
									class="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-muted-foreground"
								/>
								<Input placeholder="Search messages..." bind:value={searchQuery} class="pl-9 h-9" />
							</div>
						</div>
						<div class="flex-1 overflow-auto">
							{#each filteredThreads as thread (thread.thread_id)}
								{@const otherParticipant = getOtherParticipant(thread.participants)}
								<button
									type="button"
									onclick={() => selectThread(thread)}
									class="w-full text-left p-3 border-b hover:bg-muted/50 transition-colors {selectedThread?.thread_id ===
									thread.thread_id
										? 'bg-muted'
										: ''}"
								>
									<div class="flex gap-3">
										<Avatar.Root class="size-10 shrink-0">
											<Avatar.Fallback class="text-xs">
												{thread.session_id ? '🔐' : getInitials(otherParticipant)}
											</Avatar.Fallback>
										</Avatar.Root>
										<div class="flex-1 min-w-0">
											<div class="flex items-center justify-between gap-2">
												<span
													class="font-medium truncate text-sm {thread.unread_count > 0
														? 'text-foreground'
														: 'text-muted-foreground'}"
												>
													{thread.session_id
														? thread.session_name || 'Secure Session'
														: otherParticipant || 'Unknown'}
												</span>
												<span class="text-xs text-muted-foreground shrink-0">
													{formatTime(thread.last_message_at)}
												</span>
											</div>
											<p
												class="text-sm truncate {thread.unread_count > 0
													? 'font-medium text-foreground'
													: 'text-muted-foreground'}"
											>
												{thread.subject}
											</p>
											<p class="text-xs text-muted-foreground truncate mt-0.5">
												{thread.last_message_preview}
											</p>
										</div>
										{#if thread.unread_count > 0}
											<Badge variant="default" class="shrink-0 h-5 min-w-5 justify-center">
												{thread.unread_count > 9 ? '9+' : thread.unread_count}
											</Badge>
										{/if}
									</div>
								</button>
							{:else}
								<div class="p-6 text-center text-muted-foreground text-sm">
									{searchQuery ? 'No matching conversations' : 'No conversations yet'}
								</div>
							{/each}
						</div>
					</div>
					{/if}

					<!-- Sessions Tab Content -->
					{#if activeMainTab === 'sessions'}
					<div class="flex-1 flex flex-col overflow-hidden">
						<div class="p-3 border-b flex gap-2">
							<div class="relative flex-1">
								<SearchIcon
									class="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-muted-foreground"
								/>
								<Input
									placeholder="Search sessions..."
									bind:value={sessionSearchQuery}
									class="pl-9 h-9"
								/>
							</div>
							<Button variant="outline" size="icon" class="h-9 w-9" onclick={loadSessions}>
								<RefreshCwIcon class="size-4 {loadingSessions ? 'animate-spin' : ''}" />
							</Button>
						</div>
						<div class="flex-1 overflow-auto">
							{#if loadingSessions && sessions.length === 0}
								<div class="flex items-center justify-center p-8">
									<Loader2Icon class="size-6 animate-spin text-muted-foreground" />
								</div>
							{:else}
								<!-- Pending Invitations -->
								{#if sessionInvitations.length > 0}
									<div
										class="px-3 py-2 text-xs font-medium text-muted-foreground bg-amber-50 dark:bg-amber-950/30 flex items-center gap-1.5"
									>
										<InboxIcon class="size-3.5" />
										Pending Invitations ({sessionInvitations.length})
									</div>
									{#each sessionInvitations as invite (invite.session_id)}
										<div
											class="p-3 border-b bg-amber-50/50 dark:bg-amber-950/20 hover:bg-amber-100/50 dark:hover:bg-amber-950/40 transition-colors"
										>
											<div class="flex items-start gap-3">
												<Avatar.Root class="size-10 shrink-0">
													<Avatar.Fallback class="text-xs bg-amber-100 dark:bg-amber-900">
														🔐
													</Avatar.Fallback>
												</Avatar.Root>
												<div class="flex-1 min-w-0">
													<p class="font-medium text-sm truncate">{invite.session_name}</p>
													<p class="text-xs text-muted-foreground truncate">
														From {invite.requester}
													</p>
													{#if invite.description}
														<p class="text-xs text-muted-foreground mt-1 line-clamp-2">
															{invite.description}
														</p>
													{/if}
													<div class="flex gap-2 mt-2">
														<Button
															size="sm"
															class="h-7 text-xs"
															onclick={() => acceptInvitation(invite.session_id)}
														>
															Accept
														</Button>
														<Button
															variant="outline"
															size="sm"
															class="h-7 text-xs"
															onclick={() => rejectInvitation(invite.session_id)}
														>
															Decline
														</Button>
													</div>
												</div>
											</div>
										</div>
									{/each}
								{/if}

								<!-- Active Sessions -->
								{#if filteredSessions.length > 0}
									{#if sessionInvitations.length > 0}
										<div
											class="px-3 py-2 text-xs font-medium text-muted-foreground bg-muted/50 flex items-center gap-1.5 mt-2"
										>
											<LockIcon class="size-3.5" />
											Your Sessions ({filteredSessions.length})
										</div>
									{/if}
									{#each filteredSessions as session (session.session_id)}
										<button
											type="button"
											onclick={() => selectSession(session)}
											class="w-full text-left p-3 border-b hover:bg-muted/50 transition-colors {selectedSession?.session_id ===
											session.session_id
												? 'bg-muted'
												: ''}"
										>
											<div class="flex items-center gap-3">
												<Avatar.Root class="size-10 shrink-0">
													<Avatar.Fallback class="text-xs">🔐</Avatar.Fallback>
												</Avatar.Root>
												<div class="flex-1 min-w-0">
													<div class="flex items-center justify-between gap-2">
														<span class="font-medium text-sm truncate">{session.name}</span>
														<Badge
															variant={session.status === 'active' ? 'default' : 'secondary'}
															class="text-xs"
														>
															{session.status}
														</Badge>
													</div>
													<p class="text-xs text-muted-foreground truncate">
														{session.peer ? `with ${session.peer}` : 'No collaborator yet'}
													</p>
													<p class="text-xs text-muted-foreground mt-0.5">
														{formatTime(session.created_at)}
													</p>
												</div>
											</div>
										</button>
									{/each}
								{:else if sessionInvitations.length === 0}
									<div class="p-6 text-center text-muted-foreground text-sm">
										{sessionSearchQuery ? 'No matching sessions' : 'No sessions yet'}
									</div>
								{/if}
							{/if}
						</div>
					</div>
					{/if}

					<!-- Contacts Tab Content -->
					{#if activeMainTab === 'contacts'}
					<div class="flex-1 flex flex-col overflow-hidden">
						<div class="p-3 border-b flex gap-2">
							<div class="relative flex-1">
								<SearchIcon
									class="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-muted-foreground"
								/>
								<Input
									placeholder="Search contacts..."
									bind:value={contactSearchQuery}
									class="pl-9 h-9"
								/>
							</div>
							<Button variant="outline" size="icon" class="h-9 w-9" onclick={loadContacts}>
								<RefreshCwIcon class="size-4 {loadingContacts ? 'animate-spin' : ''}" />
							</Button>
						</div>
						<div class="flex-1 overflow-auto">
							{#if loadingContacts && contacts.length === 0}
								<div class="flex items-center justify-center p-8">
									<Loader2Icon class="size-6 animate-spin text-muted-foreground" />
								</div>
							{:else}
								<!-- Trusted Contacts -->
								{#if filteredContacts.length > 0}
									<div
										class="px-3 py-2 text-xs font-medium text-muted-foreground bg-muted/50 flex items-center gap-1.5"
									>
										<UserCheckIcon class="size-3.5" />
										Trusted Contacts ({filteredContacts.length})
									</div>
									{#each filteredContacts as contact (contact.identity)}
										<div
											class="flex items-center gap-3 p-3 border-b hover:bg-muted/50 transition-colors"
										>
											<Avatar.Root class="size-10 shrink-0">
												<Avatar.Fallback class="text-xs">
													{getInitials(contact.identity)}
												</Avatar.Fallback>
											</Avatar.Root>
											<div class="flex-1 min-w-0">
												<p class="font-medium text-sm truncate">{contact.identity}</p>
												{#if contact.fingerprint}
													<p class="text-xs text-muted-foreground truncate">
														{contact.fingerprint.slice(0, 16)}...
													</p>
												{/if}
											</div>
											<div class="flex items-center gap-1">
												<Button
													variant="ghost"
													size="icon"
													class="h-8 w-8"
													onclick={() => messageContact(contact.identity)}
													title="Send message"
												>
													<MessageSquareIcon class="size-4" />
												</Button>
												<Button
													variant="ghost"
													size="icon"
													class="h-8 w-8 text-muted-foreground hover:text-destructive"
													onclick={() => removeContact(contact.identity)}
													title="Remove contact"
												>
													<TrashIcon class="size-4" />
												</Button>
											</div>
										</div>
									{/each}
								{/if}

								<!-- Discovered Users -->
								{#if filteredDiscovered.length > 0}
									<div
										class="px-3 py-2 text-xs font-medium text-muted-foreground bg-muted/50 flex items-center gap-1.5 {filteredContacts.length >
										0
											? 'mt-2'
											: ''}"
									>
										<UsersIcon class="size-3.5" />
										Network ({filteredDiscovered.length})
									</div>
									{#each filteredDiscovered as user (user.identity)}
										<div
											class="flex items-center gap-3 p-3 border-b hover:bg-muted/50 transition-colors"
										>
											<Avatar.Root class="size-10 shrink-0">
												<Avatar.Fallback class="text-xs bg-muted">
													{getInitials(user.identity)}
												</Avatar.Fallback>
											</Avatar.Root>
											<div class="flex-1 min-w-0">
												<p class="text-sm truncate text-muted-foreground">{user.identity}</p>
											</div>
											<Button
												variant="outline"
												size="sm"
												class="h-8 gap-1"
												onclick={() => addContact(user.identity)}
											>
												<UserPlusIcon class="size-3.5" />
												Add
											</Button>
										</div>
									{/each}
								{/if}

								{#if filteredContacts.length === 0 && filteredDiscovered.length === 0}
									<div class="p-6 text-center text-muted-foreground text-sm">
										{#if contactSearchQuery}
											No contacts found matching "{contactSearchQuery}"
										{:else}
											No contacts yet
										{/if}
									</div>
								{/if}
							{/if}
						</div>
					</div>
					{/if}
				</div>
			</div>

			<!-- Main Content Area -->
			<div class="flex-1 flex flex-col min-w-0">
				{#if activeMainTab === 'messages'}
					<!-- Messages View -->
					{#if isComposing}
						<div class="border-b p-4">
							<div class="flex items-center gap-3">
								<Button variant="ghost" size="icon" onclick={cancelCompose}>
									<ArrowLeftIcon class="size-5" />
								</Button>
								<h2 class="font-semibold">New Message</h2>
							</div>
						</div>
						<div class="flex-1 overflow-auto p-4 space-y-4">
							<div class="space-y-2">
								<label for="recipient" class="text-sm font-medium">To</label>
								<Input
									id="recipient"
									placeholder="recipient@example.com"
									bind:value={composeRecipient}
								/>
							</div>
							<div class="space-y-2">
								<label for="subject" class="text-sm font-medium">Subject</label>
								<Input id="subject" placeholder="Subject" bind:value={composeSubject} />
							</div>
							<div class="space-y-2">
								<label for="body" class="text-sm font-medium">Message</label>
								<Textarea
									id="body"
									placeholder="Write your message..."
									bind:value={composeBody}
									rows={8}
									class="resize-none"
								/>
							</div>
						</div>
						<div class="border-t p-4">
							<div class="flex justify-end gap-2">
								<Button variant="outline" onclick={cancelCompose}>Cancel</Button>
								<Button
									onclick={sendMessage}
									disabled={sending || !composeRecipient.trim() || !composeBody.trim()}
								>
									{#if sending}
										<Loader2Icon class="size-4 animate-spin" />
										Sending...
									{:else}
										<SendIcon class="size-4" />
										Send
									{/if}
								</Button>
							</div>
						</div>
					{:else if selectedThread}
						<div class="border-b p-4">
							<div class="flex items-center gap-3">
								<Avatar.Root class="size-10">
									<Avatar.Fallback>
										{selectedThread.session_id
											? '🔐'
											: getInitials(getOtherParticipant(selectedThread.participants))}
									</Avatar.Fallback>
								</Avatar.Root>
								<div class="flex-1 min-w-0">
									<h2 class="font-semibold truncate">
										{selectedThread.session_id
											? selectedThread.session_name || 'Secure Session'
											: getOtherParticipant(selectedThread.participants)}
									</h2>
									<p class="text-sm text-muted-foreground truncate">
										{selectedThread.subject}
									</p>
								</div>
							</div>
						</div>
						<div id="message-container" class="flex-1 overflow-auto p-4 space-y-4">
							{#if loadingMessages}
								<div class="space-y-4">
									{#each [1, 2, 3] as _}
										<div class="flex gap-3">
											<Skeleton class="size-8 rounded-full" />
											<div class="space-y-2">
												<Skeleton class="h-4 w-48" />
												<Skeleton class="h-16 w-64 rounded-lg" />
											</div>
										</div>
									{/each}
								</div>
							{:else}
								{#each messages as msg (msg.id)}
									{@const outgoing = isOutgoing(msg)}
									<div class="flex {outgoing ? 'justify-end' : 'justify-start'}">
										<div
											class="max-w-[70%] {outgoing
												? 'bg-primary text-primary-foreground'
												: 'bg-muted'} rounded-2xl px-4 py-2.5"
										>
											<p class="text-sm whitespace-pre-wrap break-words">{msg.body}</p>
											<p
												class="text-xs mt-1 {outgoing
													? 'text-primary-foreground/70'
													: 'text-muted-foreground'}"
											>
												{formatFullTime(msg.created_at)}
											</p>
										</div>
									</div>
								{/each}
							{/if}
						</div>
						<div class="border-t p-4">
							<div class="flex gap-2">
								<Textarea
									placeholder="Write a reply..."
									bind:value={draftMessage}
									onkeydown={handleKeydown}
									rows={1}
									class="resize-none min-h-[40px]"
								/>
								<Button onclick={sendMessage} disabled={sending || !draftMessage.trim()} size="icon">
									{#if sending}
										<Loader2Icon class="size-4 animate-spin" />
									{:else}
										<SendIcon class="size-4" />
									{/if}
								</Button>
							</div>
						</div>
					{:else}
						<div class="flex-1 flex items-center justify-center text-muted-foreground">
							<div class="text-center">
								<InboxIcon class="size-12 mx-auto mb-4 opacity-50" />
								<p>Select a conversation to view messages</p>
							</div>
						</div>
					{/if}
				{:else if activeMainTab === 'sessions'}
					<!-- Sessions View -->
					{#if selectedSession}
						<div class="border-b p-4">
							<div class="flex items-center justify-between">
								<div class="flex items-center gap-3">
									<Avatar.Root class="size-10">
										<Avatar.Fallback>🔐</Avatar.Fallback>
									</Avatar.Root>
									<div>
										<h2 class="font-semibold">{selectedSession.name}</h2>
										<p class="text-sm text-muted-foreground">
											{selectedSession.peer
												? `with ${selectedSession.peer}`
												: 'No collaborator yet'}
										</p>
									</div>
								</div>
								<div class="flex items-center gap-2">
									<Badge
										variant={selectedSession.status === 'active' ? 'default' : 'secondary'}
									>
										{selectedSession.status}
									</Badge>
									<Button
										variant="outline"
										size="sm"
										onclick={() => openSessionFolder(selectedSession!.session_id)}
									>
										<FolderOpenIcon class="size-4" />
										Open Folder
									</Button>
								</div>
							</div>
						</div>
						<div class="flex-1 overflow-auto p-6">
							<div class="space-y-6">
								<!-- Session Details -->
								<div class="space-y-4">
									<h3 class="font-medium text-sm text-muted-foreground">Session Details</h3>
									<div class="grid grid-cols-2 gap-4">
										<div>
											<p class="text-xs text-muted-foreground">Owner</p>
											<p class="text-sm">{selectedSession.owner}</p>
										</div>
										<div>
											<p class="text-xs text-muted-foreground">Created</p>
											<p class="text-sm">{formatFullTime(selectedSession.created_at)}</p>
										</div>
										{#if selectedSession.session_path}
											<div class="col-span-2">
												<p class="text-xs text-muted-foreground">Path</p>
												<p class="text-sm font-mono text-xs truncate">
													{selectedSession.session_path}
												</p>
											</div>
										{/if}
									</div>
								</div>

								<!-- Placeholder for datasets and Jupyter -->
								<div class="space-y-4">
									<h3 class="font-medium text-sm text-muted-foreground">Linked Datasets</h3>
									<div
										class="border border-dashed rounded-lg p-6 text-center text-muted-foreground"
									>
										<DatabaseIcon class="size-8 mx-auto mb-2 opacity-50" />
										<p class="text-sm">No datasets linked yet</p>
									</div>
								</div>

								<div class="space-y-4">
									<h3 class="font-medium text-sm text-muted-foreground">Jupyter Notebook</h3>
									<div
										class="border border-dashed rounded-lg p-6 text-center text-muted-foreground"
									>
										<PlayIcon class="size-8 mx-auto mb-2 opacity-50" />
										<p class="text-sm">Jupyter not running</p>
										<Button variant="outline" size="sm" class="mt-3" disabled>
											Launch Jupyter
										</Button>
									</div>
								</div>
							</div>
						</div>
					{:else}
						<div class="flex-1 flex items-center justify-center text-muted-foreground">
							<div class="text-center">
								<LockIcon class="size-12 mx-auto mb-4 opacity-50" />
								<p>Select a session to view details</p>
							</div>
						</div>
					{/if}
				{:else if activeMainTab === 'contacts'}
					<!-- Contacts View - show selected contact details or empty state -->
					<div class="flex-1 flex items-center justify-center text-muted-foreground">
						<div class="text-center">
							<UsersIcon class="size-12 mx-auto mb-4 opacity-50" />
							<p>Select a contact from the sidebar</p>
							<p class="text-sm mt-1">or discover new users on the network</p>
						</div>
					</div>
				{/if}
			</div>
		</div>
	{/if}
</div>

<SyftboxSignInDialog bind:open={signInDialogOpen} />
