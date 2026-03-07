<script lang="ts">
	import { invoke } from '@tauri-apps/api/core'
	import { confirm } from '@tauri-apps/plugin-dialog'
	import { goto } from '$app/navigation'
	import { onMount, onDestroy } from 'svelte'
	import { syftboxAuthStore } from '$lib/stores/syftbox-auth.svelte'
	import { getAvatarToneClass } from '$lib/utils.js'
	import SyftboxSignInDialog from '$lib/components/syftbox-sign-in-dialog.svelte'
	import ConversationPanel from '$lib/components/conversation-panel.svelte'
	import { buildThreadConversationAdapter, type ConversationAdapter } from '$lib/collab/conversation-adapters'
	import * as Empty from '$lib/components/ui/empty/index.js'
	import * as Dialog from '$lib/components/ui/dialog/index.js'
	import * as DropdownMenu from '$lib/components/ui/dropdown-menu/index.js'
	import * as Collapsible from '$lib/components/ui/collapsible/index.js'
	import * as Tooltip from '$lib/components/ui/tooltip/index.js'
	import * as Avatar from '$lib/components/ui/avatar/index.js'
	import { Button } from '$lib/components/ui/button/index.js'
	import { Input } from '$lib/components/ui/input/index.js'
	import { Badge } from '$lib/components/ui/badge/index.js'
	import { Select } from '$lib/components/ui/select/index.js'
	import { Checkbox } from '$lib/components/ui/checkbox/index.js'
	import { Skeleton } from '$lib/components/ui/skeleton/index.js'
	import LogInIcon from '@lucide/svelte/icons/log-in'
	import SearchIcon from '@lucide/svelte/icons/search'
	import Loader2Icon from '@lucide/svelte/icons/loader-2'
	import PlusIcon from '@lucide/svelte/icons/plus'
	import CheckIcon from '@lucide/svelte/icons/check'
	import Clock3Icon from '@lucide/svelte/icons/clock-3'
	import MessageSquareIcon from '@lucide/svelte/icons/message-square'
	import PlayIcon from '@lucide/svelte/icons/play'
	import SquareIcon from '@lucide/svelte/icons/square'
	import CircleHelpIcon from '@lucide/svelte/icons/circle-help'
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
	interface ThreadCandidate extends Contact {
		source: 'contact' | 'discovered'
	}

	interface NetworkScanResult {
		contacts: Contact[]
		discovered: Contact[]
	}

	interface CollaborationThread {
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

	interface SessionJupyterStatus {
		session_id: string
		running: boolean
		port?: number | null
		url?: string | null
		token?: string | null
	}

	interface SessionDataset {
		id: number
		session_id: string
		dataset_public_url: string
		dataset_owner: string
		dataset_name: string
		role: string
		created_at: string
	}

	interface SessionInvitation {
		session_id: string
		session_name: string
		requester: string
		description?: string
		created_at: string
	}

	interface FailedMessageInfo {
		id: string
		sender_identity: string
		failure_reason: string
		failure_reason_display: string
		error_details: string
		suggested_action: string
		created_at: string
		dismissed: boolean
	}

	interface FailedMessagesResult {
		failed_messages: FailedMessageInfo[]
		count: number
	}

	interface KeyStatusInfo {
		identity: string
		exists: boolean
	}

	interface KeyOperationResult {
		identity: string
		fingerprint: string
		vault_path: string
		bundle_path: string
		export_path: string
		mnemonic?: string
	}

	interface RepublishResult {
		identity: string
		fingerprint: string
		export_path: string
		vault_matches_export: boolean
	}

	interface FlowRequestSyncStatus {
		ready: boolean
		source_present: boolean
		flow_yaml_present: boolean
		missing_paths: string[]
		reason?: string | null
	}

	interface ModuleListEntry {
		name: string
		version?: string | null
	}

	interface InstalledFlow {
		id: number
		name: string
		flow_path: string
	}

	interface FlowRun {
		id: number
		flow_id: number
		status?: string | null
		created_at?: string | null
		results_dir?: string | null
		work_dir?: string | null
	}

	interface DatasetAssetForRun {
		resolved_private_path?: string | null
		resolved_mock_path?: string | null
		private_path?: string | null
		mock_path?: string | null
		private_ref?: string | null
		mock_ref?: string | null
	}

	interface DatasetWithAssetsForRun {
		dataset: {
			name: string
		}
		assets: DatasetAssetForRun[]
	}

	let signInDialogOpen = $state(false)
	let createSessionDialogOpen = $state(false)
	let sessionsDialogOpen = $state(false)
	let sessionsDialogSelectedId = $state('')
	let createSessionName = $state('')
	let createSessionLoading = $state(false)
	let createSessionError = $state('')
	let sessionDatasetsDialogOpen = $state(false)
	let connectionIssuesOpen = $state(false)
	let createThreadDialogOpen = $state(false)
	let createThreadName = $state('')
	let createThreadQuery = $state('')
	let createThreadLoading = $state(false)
	let createThreadError = $state('')
	let createThreadSelected = $state<string[]>([])
	let createThreadConfirmAdd = $state(false)
	let renameThreadOpen = $state(false)
	let renameThreadName = $state('')
	let renameThreadLoading = $state(false)
	let renameThreadError = $state('')

	let contacts = $state<Contact[]>([])
	let discovered = $state<Contact[]>([])
	let threads = $state<CollaborationThread[]>([])
	let sessions = $state<Session[]>([])
	let invitations = $state<SessionInvitation[]>([])
	let failedMessages = $state<FailedMessageInfo[]>([])
	let importContactLoadingByIdentity = $state<Record<string, boolean>>({})
	let trustRepairLoading = $state(false)

	let selectedThread = $state<CollaborationThread | null>(null)
	let activeSessionIdByThread = $state<Record<string, string>>({})
	let activeSessionDatasets = $state<SessionDataset[]>([])
	let activeSessionJupyter = $state<SessionJupyterStatus | null>(null)
	let activeSessionLoading = $state(false)
	let activeSessionJupyterLoading = $state(false)
	let activeSessionDatasetUrl = $state('')
	let activeSessionDatasetAdding = $state(false)
	let selectedThreadSessionIds = $state<string[]>([])
	let threadChatReloadSignal = $state(0)
	let selectedThreadLatestMessageBySender = $state<Record<string, number>>({})
	let installedModuleRefs = $state<Set<string>>(new Set())
	let installedFlows = $state<InstalledFlow[]>([])
	let flowRuns = $state<FlowRun[]>([])
	let selectedRunIdByMessage = $state<Record<string, number>>({})

	let listSearch = $state('')
	let currentUserEmail = $state('')
	let loading = $state(true)
	let loadingList = $state(false)
	let loadingSessions = $state(false)
	let eventActionLoading = $state<Record<string, boolean>>({})
	let refreshTimer: ReturnType<typeof setInterval> | null = null

	const AUTO_REFRESH_MS = 10000
	const ACTIVE_SESSION_STORAGE_PREFIX = 'bv-active-session-by-thread'
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

	function threadDisplayName(
		thread: Pick<CollaborationThread, 'name' | 'participants'> | null | undefined,
	): string {
		if (!thread) return 'New Thread'
		const named = normalizeIdentity(thread.name)
		if (named) return named
		const participants = thread.participants
			.map((p) => normalizeIdentity(p))
			.filter((p): p is string => !!p)
		if (participants.length > 0) return participants.join(', ')
		return 'New Thread'
	}

	function participantSummaryList(participants: string[]): string[] {
		const safe = participants
			.map((p) => normalizeIdentity(p))
			.filter((p): p is string => !!p)
		const currentUser = normalizeIdentityLower(currentUserEmail)
		const others = currentUser ? safe.filter((p) => p.toLowerCase() !== currentUser) : safe
		return others.length > 0 ? others : safe
	}

	const selectedThreadParticipantSummary = $derived.by(() =>
		selectedThread ? participantSummaryList(selectedThread.participants) : [],
	)

	function normalizeIdentityLower(value: unknown): string | null {
		const safe = normalizeIdentity(value)
		return safe ? safe.toLowerCase() : null
	}

	function normalizeModuleRef(value: string): string {
		return value.trim().toLowerCase()
	}

	function activeSessionStorageKey(profileId: string): string {
		const normalized = normalizeIdentityLower(profileId) || 'global'
		return `${ACTIVE_SESSION_STORAGE_PREFIX}:${normalized}`
	}

	function loadPersistedActiveSessions(profileId: string) {
		if (typeof window === 'undefined') return
		try {
			const stored = localStorage.getItem(activeSessionStorageKey(profileId))
			if (!stored) return
			const parsed = JSON.parse(stored) as Record<string, unknown>
			const normalized = Object.fromEntries(
				Object.entries(parsed).filter(
					([threadId, sessionId]) =>
						typeof threadId === 'string' &&
						threadId.trim().length > 0 &&
						typeof sessionId === 'string' &&
						sessionId.trim().length > 0,
				),
			) as Record<string, string>
			activeSessionIdByThread = normalized
		} catch {
			// Ignore storage errors and invalid payloads.
		}
	}

	function persistActiveSessions(profileId: string, value: Record<string, string>) {
		if (typeof window === 'undefined') return
		try {
			localStorage.setItem(activeSessionStorageKey(profileId), JSON.stringify(value))
		} catch {
			// Ignore storage errors.
		}
	}

	function getThreadAvatarTone(thread: CollaborationThread): string {
		return getAvatarToneClass(`thread:${thread.thread_id}`)
	}

	function threadRecipients(thread: CollaborationThread): string[] {
		return thread.participants.filter(
			(p) => normalizeIdentity(p)?.toLowerCase() !== currentUserEmail.toLowerCase(),
		)
	}

	type ThreadMessageKind =
		| 'message'
		| 'thread_event'
		| 'session_invite'
		| 'session_response'
		| 'flow_request'
		| 'flow_results'

	function getMessageKind(msg: VaultMessage): ThreadMessageKind {
		const meta = msg.metadata || {}
		if (meta.thread_event) return 'thread_event'
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

	function getSessionInviteName(msg: VaultMessage): string | null {
		const meta = msg.metadata || {}
		const invite = meta.session_invite as Record<string, unknown> | undefined
		const name = invite?.session_name
		return typeof name === 'string' && name.trim().length > 0 ? name.trim() : null
	}

	function getFlowRequestMeta(msg: VaultMessage): Record<string, unknown> | null {
		const meta = msg.metadata || {}
		const fr = meta.flow_request
		return fr && typeof fr === 'object' ? (fr as Record<string, unknown>) : null
	}

	function getFlowRequestFlowName(msg: VaultMessage): string | null {
		const requestMeta = getFlowRequestMeta(msg)
		const byMeta = requestMeta?.flow_name
		if (typeof byMeta === 'string' && byMeta.trim()) return byMeta.trim()
		const flowSpecCandidate = requestMeta?.flow_spec as Record<string, unknown> | undefined
		const bySpecName = flowSpecCandidate?.name
		if (typeof bySpecName === 'string' && bySpecName.trim()) return bySpecName.trim()
		const bySpecMetadata = (flowSpecCandidate?.metadata as Record<string, unknown> | undefined)?.name
		if (typeof bySpecMetadata === 'string' && bySpecMetadata.trim()) return bySpecMetadata.trim()
		return null
	}

	function getFlowRequestDatasetName(msg: VaultMessage): string | null {
		const requestMeta = getFlowRequestMeta(msg)
		const datasetName = requestMeta?.dataset_name
		if (typeof datasetName === 'string' && datasetName.trim()) return datasetName.trim()
		return null
	}

	function extractUrlsFromAssetsForRun(
		assets: DatasetAssetForRun[],
		dataType: 'mock' | 'real',
	): string[] {
		const urls: string[] = []
		for (const asset of assets) {
			const preferredPath =
				dataType === 'real'
					? asset.resolved_private_path || asset.private_path
					: asset.resolved_mock_path || asset.mock_path

			if (preferredPath && preferredPath.trim()) {
				const path = preferredPath.trim()
				if (path.startsWith('/')) {
					urls.push(`file://${path}`)
				} else {
					urls.push(path)
				}
				continue
			}

			const preferredRef = dataType === 'real' ? asset.private_ref : asset.mock_ref
			if (typeof preferredRef !== 'string') continue
			const trimmed = preferredRef.trim()
			if (!trimmed) continue
			if (trimmed.startsWith('syft://') || trimmed.startsWith('file://')) {
				urls.push(trimmed)
			}
		}
		return urls
	}

	function getImportedFlowForRequest(msg: VaultMessage): InstalledFlow | null {
		const flowName = getFlowRequestFlowName(msg)
		if (!flowName) return null
		const target = flowName.toLowerCase()
		return installedFlows.find((flow) => flow.name.toLowerCase() === target) ?? null
	}

	function getCompletedRunsForRequest(msg: VaultMessage): FlowRun[] {
		const flow = getImportedFlowForRequest(msg)
		if (!flow) return []
		const completed = flowRuns.filter(
			(run) =>
				run.flow_id === flow.id &&
				(run.status || '').toLowerCase() !== 'running' &&
				(run.status || '').toLowerCase() !== 'pending',
		)
		return completed.sort((a, b) => {
			const aTs = Date.parse(a.created_at || '')
			const bTs = Date.parse(b.created_at || '')
			return (Number.isNaN(bTs) ? 0 : bTs) - (Number.isNaN(aTs) ? 0 : aTs)
		})
	}

	function selectedRunIdForMessage(msg: VaultMessage): number | null {
		const explicit = selectedRunIdByMessage[msg.id]
		if (typeof explicit === 'number' && Number.isFinite(explicit)) return explicit
		const runs = getCompletedRunsForRequest(msg)
		return runs[0]?.id ?? null
	}

	function getFlowRequestModuleDependencies(msg: VaultMessage): string[] {
		const requestMeta = getFlowRequestMeta(msg)
		const flowSpecCandidate = requestMeta?.flow_spec as Record<string, unknown> | undefined
		const nestedSpec =
			flowSpecCandidate && typeof flowSpecCandidate.spec === 'object'
				? (flowSpecCandidate.spec as Record<string, unknown>)
				: null
		const stepsRaw: unknown[] = Array.isArray(flowSpecCandidate?.steps)
			? (flowSpecCandidate.steps as unknown[])
			: Array.isArray(nestedSpec?.steps)
				? (nestedSpec?.steps as unknown[])
				: []

		const deps = new Set<string>()
		for (const step of stepsRaw) {
			if (!step || typeof step !== 'object') continue
			const usesRaw = (step as Record<string, unknown>).uses
			if (typeof usesRaw !== 'string') continue
			const moduleRef = usesRaw.trim()
			if (!moduleRef) continue
			if (
				moduleRef.startsWith('http://') ||
				moduleRef.startsWith('https://') ||
				moduleRef.startsWith('syft://')
			) {
				continue
			}
			if (
				moduleRef.startsWith('/') ||
				moduleRef.startsWith('./') ||
				moduleRef.startsWith('../') ||
				moduleRef.includes('/') ||
				moduleRef.includes('\\')
			) {
				continue
			}
			deps.add(moduleRef)
		}
		return Array.from(deps).sort()
	}

	function isModuleDependencyInstalled(moduleRef: string): boolean {
		return installedModuleRefs.has(normalizeModuleRef(moduleRef))
	}

	function getMissingFlowRequestModuleDependencies(msg: VaultMessage): string[] {
		return getFlowRequestModuleDependencies(msg).filter((dep) => !isModuleDependencyInstalled(dep))
	}

	function getFlowResultsMeta(msg: VaultMessage): Record<string, unknown> | null {
		const meta = msg.metadata || {}
		const fr = meta.flow_results
		return fr && typeof fr === 'object' ? (fr as Record<string, unknown>) : null
	}

	function getThreadEventMeta(msg: VaultMessage): Record<string, unknown> | null {
		const meta = msg.metadata || {}
		const ev = meta.thread_event
		return ev && typeof ev === 'object' ? (ev as Record<string, unknown>) : null
	}

	function getThreadLinkedSessionId(msg: VaultMessage): string | null {
		const direct = getSessionMessageId(msg)
		if (direct) return direct
		const threadEvent = getThreadEventMeta(msg)
		const sessionId = threadEvent?.session_id
		return typeof sessionId === 'string' && sessionId.trim().length > 0 ? sessionId.trim() : null
	}

	function badgeForKind(kind: ThreadMessageKind): string | null {
		switch (kind) {
			case 'thread_event':
				return null
			case 'session_invite':
				return 'Session Invite'
			case 'session_response':
				return 'Session Update'
			case 'flow_request':
				return null
			case 'flow_results':
				return null
			default:
				return null
		}
	}

	function setEventLoading(messageId: string, loading: boolean) {
		eventActionLoading = { ...eventActionLoading, [messageId]: loading }
	}

	const filteredThreads = $derived(
		listSearch.trim()
			? threads.filter((s) => {
					const q = listSearch.toLowerCase()
					return (
						s.name.toLowerCase().includes(q) ||
						s.participants.some((p) => p.toLowerCase().includes(q))
					)
				})
			: threads,
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
	const threadCandidates = $derived.by<ThreadCandidate[]>(() => {
		const q = createThreadQuery.trim().toLowerCase()
		const merged: ThreadCandidate[] = [
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
		threadCandidates.filter((candidate) => candidate.source === 'contact'),
	)
	const discoveredCandidates = $derived(
		threadCandidates.filter((candidate) => candidate.source === 'discovered'),
	)
	const selectedDiscoveredCount = $derived.by(
		() =>
			createThreadSelected.filter((id) => {
				const safe = normalizeIdentity(id)
				return safe ? !contactIdentitySet.has(safe.toLowerCase()) : false
			}).length,
	)
	$effect(() => {
		if (selectedDiscoveredCount === 0 && createThreadConfirmAdd) {
			createThreadConfirmAdd = false
		}
	})
	const selectedThreadParticipantSet = $derived.by(() => {
		const set = new Set<string>()
		if (!selectedThread) return set
		for (const p of selectedThread.participants) {
			const safe = normalizeIdentity(p)
			if (safe) set.add(safe.toLowerCase())
		}
		return set
	})
	const failedBySenderIdentity = $derived.by(() => {
		const grouped = new Map<string, FailedMessageInfo[]>()
		for (const msg of failedMessages) {
			const sender = normalizeIdentityLower(msg.sender_identity)
			if (!sender) continue
			if (!grouped.has(sender)) grouped.set(sender, [])
			grouped.get(sender)?.push(msg)
		}
		return grouped
	})
	const selectedThreadRecipients = $derived.by(() => {
		if (!selectedThread) return []
		return selectedThread.participants
			.map((p) => normalizeIdentity(p))
			.filter((p): p is string => !!p)
			.filter((p) => p.toLowerCase() !== currentUserEmail.toLowerCase())
	})
	const selectedThreadMissingContacts = $derived.by(() =>
		selectedThreadRecipients.filter((p) => !contactIdentitySet.has(p.toLowerCase())),
	)
	const selectedThreadInvalidSignatureSenders = $derived.by(() =>
		selectedThreadRecipients.filter((recipient) => {
			const entries = failedBySenderIdentity.get(recipient.toLowerCase()) || []
			return entries.some((msg) => {
				const reason = `${msg.failure_reason} ${msg.failure_reason_display} ${msg.error_details}`.toLowerCase()
				if (!reason.includes('invalid signature')) return false
				const failedAt = Date.parse(msg.created_at || '')
				const lastSenderMessageAt = selectedThreadLatestMessageBySender[recipient.toLowerCase()] ?? 0
				// If we've received a newer message from this sender, the old failure is historical.
				return Number.isNaN(failedAt) ? true : failedAt >= lastSenderMessageAt
			})
		}),
	)
	const selectedThreadSenderKeyMissing = $derived.by(() =>
		selectedThreadRecipients.filter((recipient) => {
			const entries = failedBySenderIdentity.get(recipient.toLowerCase()) || []
			return entries.some((msg) => {
				const reason = `${msg.failure_reason} ${msg.failure_reason_display} ${msg.error_details}`.toLowerCase()
				if (!reason.includes('senderbundlenotcached')) return false
				const failedAt = Date.parse(msg.created_at || '')
				const lastSenderMessageAt = selectedThreadLatestMessageBySender[recipient.toLowerCase()] ?? 0
				return Number.isNaN(failedAt) ? true : failedAt >= lastSenderMessageAt
			})
		}),
	)
	const selectedThreadSenderNoIdentity = $derived.by(() =>
		selectedThreadRecipients.filter((recipient) => {
			const entries = failedBySenderIdentity.get(recipient.toLowerCase()) || []
			return entries.some((msg) => {
				const reason = `${msg.failure_reason} ${msg.failure_reason_display} ${msg.error_details}`.toLowerCase()
				if (!reason.includes('no identities found in vault')) return false
				const failedAt = Date.parse(msg.created_at || '')
				const lastSenderMessageAt = selectedThreadLatestMessageBySender[recipient.toLowerCase()] ?? 0
				return Number.isNaN(failedAt) ? true : failedAt >= lastSenderMessageAt
			})
		}),
	)
	const selectedThreadHasAssistance = $derived(
		selectedThreadMissingContacts.length > 0 ||
			selectedThreadInvalidSignatureSenders.length > 0 ||
			selectedThreadSenderKeyMissing.length > 0 ||
			selectedThreadSenderNoIdentity.length > 0,
	)
	const selectedThreadSessions = $derived.by(() => {
		if (!selectedThread) return []
		const linked = new Set(selectedThreadSessionIds)
		if (linked.size === 0) return []
		return sessions.filter((session) => linked.has(session.session_id))
	})
	const activeSelectedThreadSession = $derived.by(() => {
		if (!selectedThread) return null
		const selected = [...selectedThreadSessions].sort((a, b) => {
			const aTs = Date.parse(a.created_at || '')
			const bTs = Date.parse(b.created_at || '')
			if (Number.isNaN(aTs) && Number.isNaN(bTs)) return 0
			if (Number.isNaN(aTs)) return 1
			if (Number.isNaN(bTs)) return -1
			return bTs - aTs
		})
		if (selected.length === 0) return null
		const preferredId = activeSessionIdByThread[selectedThread.thread_id]
		if (!preferredId) return selected[0]
		const matched = selected.find((session) => session.session_id === preferredId)
		return matched || selected[0]
	})
	function dedupeThreadMessages(messages: VaultMessage[]): VaultMessage[] {
		const normalized = messages.map((msg) => {
			const kind = getMessageKind(msg)
			if (kind !== 'session_invite' || !isOutgoingMessage(msg)) return msg
			const sessionId = getSessionInviteId(msg)
			const sessionName = getSessionInviteName(msg) || 'session'
			if (!sessionId) return msg
			return {
				...msg,
				body: `You invited ${msg.to} to the session "${sessionName}" (ID: ${sessionId}).`,
			}
		})

		return normalized.filter((msg, idx, arr) => {
			const kind = getMessageKind(msg)
			if (kind === 'thread_event') {
				const meta = getThreadEventMeta(msg)
				const eventType = typeof meta?.type === 'string' ? meta.type : ''
				const eventName = typeof meta?.name === 'string' ? meta.name : ''
				const sessionId =
					typeof meta?.session_id === 'string' ? meta.session_id : getThreadLinkedSessionId(msg) || ''
				const dedupeKey = `${eventType}|${eventName}|${sessionId}|${msg.body.trim()}`
				for (let i = idx + 1; i < arr.length; i++) {
					const next = arr[i]
					if (getMessageKind(next) !== 'thread_event') continue
					const nextMeta = getThreadEventMeta(next)
					const nextType = typeof nextMeta?.type === 'string' ? nextMeta.type : ''
					const nextName = typeof nextMeta?.name === 'string' ? nextMeta.name : ''
					const nextSessionId =
						typeof nextMeta?.session_id === 'string'
							? nextMeta.session_id
							: getThreadLinkedSessionId(next) || ''
					const nextKey = `${nextType}|${nextName}|${nextSessionId}|${next.body.trim()}`
					if (nextKey === dedupeKey) return false
				}
				return true
			}
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

	function formatSessionCreated(value: string | null | undefined): string {
		if (!value) return 'Created recently'
		const date = new Date(value)
		const now = new Date()
		const diffDays = Math.floor((now.getTime() - date.getTime()) / (1000 * 60 * 60 * 24))
		if (diffDays === 0) {
			return `Created today, ${date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`
		}
		if (diffDays === 1) return 'Created yesterday'
		if (diffDays < 7) return `Created ${date.toLocaleDateString([], { weekday: 'long' })}`
		return `Created ${date.toLocaleDateString([], { month: 'short', day: 'numeric' })}`
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

	function delay(ms: number): Promise<void> {
		return new Promise((resolve) => setTimeout(resolve, ms))
	}

	async function waitForFlowRequestReady(
		flowLocation: string,
		maxAttempts = 20,
		waitMs = 900,
	): Promise<FlowRequestSyncStatus | null> {
		let lastStatus: FlowRequestSyncStatus | null = null
		for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
			try {
				await invoke('sync_messages')
			} catch {
				// Best-effort sync.
			}
			try {
				const status = await invoke<FlowRequestSyncStatus>('flow_request_sync_status', {
					flowLocation,
				})
				lastStatus = status
				if (status.ready) return status
			} catch {
				// Keep retrying while files are still arriving.
			}
			await delay(waitMs)
		}
		return lastStatus
	}

	async function importFlowFromRequestWithRetry(
		msg: VaultMessage,
		flowLocation: string,
		overwrite: boolean,
	): Promise<void> {
		let lastError: unknown = null
		await waitForFlowRequestReady(flowLocation)
		for (let attempt = 1; attempt <= 20; attempt += 1) {
			try {
				await invoke('import_flow_from_request', {
					name: null,
					flowLocation,
					overwrite,
					sourceSender: msg.from,
					sourceThreadId: selectedThread?.thread_id ?? null,
					sourceThreadName: selectedThread ? threadDisplayName(selectedThread) : null,
				})
				return
			} catch (e) {
				lastError = e
				const errorText = String(e)
				if (errorText.includes('already exists')) {
					throw e
				}
				const shouldRetry =
					errorText.includes('missing module dependencies') ||
					errorText.includes('Flow source folder not found') ||
					errorText.includes('flow.yaml not found')
				if (!shouldRetry || attempt >= 20) {
					throw e
				}
				await delay(900)
			}
		}
		throw lastError instanceof Error ? lastError : new Error(String(lastError))
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

	async function loadThreads() {
		threads = await invoke<CollaborationThread[]>('list_threads', { limit: 300 })
	}

	async function loadInstalledModules() {
		try {
			const modules = await invoke<ModuleListEntry[]>('get_modules')
			const refs = new Set<string>()
			for (const module of modules || []) {
				const name = (module.name || '').trim()
				if (!name) continue
				refs.add(normalizeModuleRef(name))
				const version = typeof module.version === 'string' ? module.version.trim() : ''
				if (version) refs.add(normalizeModuleRef(`${name}@${version}`))
			}
			installedModuleRefs = refs
		} catch {
			installedModuleRefs = new Set()
		}
	}

	async function loadFlowsAndRuns() {
		try {
			const [flows, runs] = await Promise.all([
				invoke<InstalledFlow[]>('get_flows'),
				invoke<FlowRun[]>('get_flow_runs'),
			])
			installedFlows = flows || []
			flowRuns = runs || []
		} catch {
			installedFlows = []
			flowRuns = []
		}
	}

	async function loadFailedMessages() {
		const result = await invoke<FailedMessagesResult>('list_failed_messages', {
			includeDismissed: false,
		})
		failedMessages = result?.failed_messages || []
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

	async function openUrl(url: string) {
		try {
			await invoke('open_url', { url })
		} catch {
			window.open(url, '_blank')
		}
	}

	function setActiveSessionForSelectedThread(sessionId: string) {
		if (!selectedThread) return
		activeSessionIdByThread = {
			...activeSessionIdByThread,
			[selectedThread.thread_id]: sessionId,
		}
	}

	async function loadActiveSessionResources() {
		const active = activeSelectedThreadSession
		if (!active) {
			activeSessionDatasets = []
			activeSessionJupyter = null
			return
		}
		activeSessionLoading = true
		try {
			const [datasets, jupyter] = await Promise.all([
				invoke<SessionDataset[]>('list_session_datasets', { sessionId: active.session_id }),
				invoke<SessionJupyterStatus>('get_session_jupyter_status', { sessionId: active.session_id }),
			])
			activeSessionDatasets = datasets || []
			activeSessionJupyter = jupyter || null
		} catch {
			activeSessionDatasets = []
			activeSessionJupyter = null
		} finally {
			activeSessionLoading = false
		}
	}

	async function launchActiveSessionJupyter() {
		const active = activeSelectedThreadSession
		if (!active || activeSessionJupyterLoading) return
		activeSessionJupyterLoading = true
		try {
			activeSessionJupyter = await invoke<SessionJupyterStatus>('launch_session_jupyter', {
				sessionId: active.session_id,
				pythonVersion: null,
				copyExamples: true,
			})
			toast.success('Notebook launched')
		} catch (e) {
			toast.error('Failed to launch notebook', { description: String(e) })
		} finally {
			activeSessionJupyterLoading = false
		}
	}

	async function stopActiveSessionJupyter() {
		const active = activeSelectedThreadSession
		if (!active || activeSessionJupyterLoading) return
		activeSessionJupyterLoading = true
		try {
			activeSessionJupyter = await invoke<SessionJupyterStatus>('stop_session_jupyter', {
				sessionId: active.session_id,
			})
			toast.success('Notebook stopped')
		} catch (e) {
			toast.error('Failed to stop notebook', { description: String(e) })
		} finally {
			activeSessionJupyterLoading = false
		}
	}

	async function resetActiveSessionJupyter() {
		const active = activeSelectedThreadSession
		if (!active || activeSessionJupyterLoading) return
		activeSessionJupyterLoading = true
		try {
			activeSessionJupyter = await invoke<SessionJupyterStatus>('reset_session_jupyter', {
				sessionId: active.session_id,
				pythonVersion: null,
			})
			toast.success('Notebook reset')
		} catch (e) {
			toast.error('Failed to reset notebook', { description: String(e) })
		} finally {
			activeSessionJupyterLoading = false
		}
	}

	async function resetSessionJupyterById(sessionId: string) {
		if (!sessionId || activeSessionJupyterLoading) return
		activeSessionJupyterLoading = true
		try {
			activeSessionJupyter = await invoke<SessionJupyterStatus>('reset_session_jupyter', {
				sessionId,
				pythonVersion: null,
			})
			if (selectedThread?.thread_id) {
				activeSessionIdByThread = {
					...activeSessionIdByThread,
					[selectedThread.thread_id]: sessionId,
				}
			}
			toast.success('Notebook reset')
		} catch (e) {
			toast.error('Failed to reset notebook', { description: String(e) })
		} finally {
			activeSessionJupyterLoading = false
		}
	}

	async function addDatasetToActiveSession() {
		const active = activeSelectedThreadSession
		const url = activeSessionDatasetUrl.trim()
		if (!active || !url || activeSessionDatasetAdding) return
		activeSessionDatasetAdding = true
		try {
			await invoke('add_dataset_to_session', {
				sessionId: active.session_id,
				datasetUrl: url,
				role: 'shared',
			})
			activeSessionDatasetUrl = ''
			await loadActiveSessionResources()
			toast.success('Dataset linked')
		} catch (e) {
			toast.error('Failed to link dataset', { description: String(e) })
		} finally {
			activeSessionDatasetAdding = false
		}
	}

	async function removeDatasetFromActiveSession(datasetUrl: string) {
		const active = activeSelectedThreadSession
		if (!active) return
		try {
			await invoke('remove_dataset_from_session', {
				sessionId: active.session_id,
				datasetUrl,
			})
			await loadActiveSessionResources()
			toast.success('Dataset removed')
		} catch (e) {
			toast.error('Failed to remove dataset', { description: String(e) })
		}
	}

	async function loadSidebar(refresh = false) {
		loadingList = true
		try {
			await Promise.all([
				loadContacts(),
				loadThreads(),
				loadSessions(),
				loadFailedMessages(),
				loadInstalledModules(),
				loadFlowsAndRuns(),
			])
			if (!selectedThread && threads.length > 0) {
				selectThread(threads[0])
			} else if (selectedThread) {
				const refreshed = threads.find((s) => s.thread_id === selectedThread?.thread_id)
				if (refreshed) {
					selectedThread = refreshed
					await loadSelectedThreadSenderActivity(refreshed)
				}
			}
			await loadActiveSessionResources()
		} finally {
			loadingList = false
		}
	}

	async function loadSelectedThreadSenderActivity(thread: CollaborationThread) {
		try {
			const threadMessages = await invoke<VaultMessage[]>('get_thread_messages', {
				threadId: thread.thread_id,
			})
			const latestBySender: Record<string, number> = {}
			const sessionIds = new Set<string>()
			for (const msg of threadMessages || []) {
				const sender = normalizeIdentity(msg.from)?.toLowerCase()
				if (!sender || sender === currentUserEmail.toLowerCase()) continue
				const ts = Date.parse(msg.created_at || '')
				if (Number.isNaN(ts)) continue
				const prev = latestBySender[sender] ?? 0
				if (ts > prev) latestBySender[sender] = ts
			}
			for (const msg of threadMessages || []) {
				const sessionId = getThreadLinkedSessionId(msg)
				if (sessionId) sessionIds.add(sessionId)
			}
			selectedThreadLatestMessageBySender = latestBySender
			selectedThreadSessionIds = Array.from(sessionIds)
		} catch {
			selectedThreadLatestMessageBySender = {}
			selectedThreadSessionIds = []
		}
	}

	async function importContactIdentity(identity: string) {
		const safe = normalizeIdentity(identity)
		if (!safe) return
		importContactLoadingByIdentity = { ...importContactLoadingByIdentity, [safe.toLowerCase()]: true }
		try {
			await invoke('network_import_contact', { identity: safe })
			await Promise.all([loadContacts(), loadFailedMessages()])
			toast.success(`Imported ${safe}`)
		} catch (e) {
			toast.error(`Failed to import ${safe}`, { description: String(e) })
		} finally {
			importContactLoadingByIdentity = {
				...importContactLoadingByIdentity,
				[safe.toLowerCase()]: false,
			}
		}
	}

	async function importAllMissingContactsForSelectedThread() {
		if (selectedThreadMissingContacts.length === 0) return
		for (const identity of selectedThreadMissingContacts) {
			// Keep sequential import to make failures easy to understand in UI toasts.
			await importContactIdentity(identity)
		}
	}

	async function repairTrustForSelectedThread() {
		if (!selectedThread || trustRepairLoading) return
		trustRepairLoading = true
		try {
			const selectedThreadId = selectedThread.thread_id
			let generatedLocalKey = false
			let republishedDid = false
			let importedCount = 0
			let importFailureCount = 0

			try {
				const status = await invoke<KeyStatusInfo>('key_get_status', { email: null })
				if (!status?.exists) {
					await invoke<KeyOperationResult>('key_generate', { email: null, force: false })
					generatedLocalKey = true
				}
			} catch (e) {
				toast.error('Unable to verify or generate local key', { description: String(e) })
			}

			try {
				await invoke<RepublishResult>('key_republish', { email: null })
				republishedDid = true
			} catch (e) {
				toast.error('Failed to republish DID', { description: String(e) })
			}

			for (const identity of selectedThreadRecipients) {
				try {
					await invoke('network_import_contact', { identity })
					importedCount += 1
				} catch {
					importFailureCount += 1
				}
			}

			await Promise.all([loadContacts(), loadFailedMessages(), loadThreads()])
			const refreshed = threads.find((s) => s.thread_id === selectedThreadId)
			if (refreshed) {
				selectedThread = refreshed
			}

			const summary: string[] = []
			if (generatedLocalKey) summary.push('generated local key')
			if (republishedDid) summary.push('republished DID')
			summary.push(`re-imported ${importedCount}/${selectedThreadRecipients.length} contacts`)

			if (importFailureCount > 0) {
				toast.warning('Trust repair completed with partial issues', {
					description: `${summary.join(', ')}. ${importFailureCount} import(s) still need sender-side fixes.`,
				})
			} else {
				toast.success('Trust repair completed', { description: summary.join(', ') })
			}
		} finally {
			trustRepairLoading = false
		}
	}

	function selectThread(thread: CollaborationThread) {
		selectedThread = thread
		renameThreadOpen = false
		renameThreadName = ''
		renameThreadError = ''
		selectedThreadSessionIds = []
		threadChatReloadSignal += 1
		void loadSelectedThreadSenderActivity(thread)
	}

	$effect(() => {
		const threadId = selectedThread?.thread_id
		const active = activeSelectedThreadSession
		if (!threadId || !active) return
		if (activeSessionIdByThread[threadId] === active.session_id) return
		activeSessionIdByThread = {
			...activeSessionIdByThread,
			[threadId]: active.session_id,
		}
	})

	$effect(() => {
		const profileId = normalizeIdentity(currentUserEmail)
		if (!profileId) return
		persistActiveSessions(profileId, activeSessionIdByThread)
	})

	$effect(() => {
		if (!sessionsDialogOpen) return
		if (selectedThreadSessions.length === 0) {
			sessionsDialogSelectedId = ''
			return
		}
		const hasSelected = selectedThreadSessions.some(
			(session) => session.session_id === sessionsDialogSelectedId,
		)
		if (!hasSelected) {
			sessionsDialogSelectedId =
				activeSelectedThreadSession?.session_id || selectedThreadSessions[0]?.session_id || ''
		}
	})

	$effect(() => {
		const threadId = selectedThread?.thread_id || ''
			const sessionId = activeSelectedThreadSession?.session_id || ''
			if (!threadId || !sessionId) {
				activeSessionDatasets = []
				activeSessionJupyter = null
				return
			}
		void loadActiveSessionResources()
	})

	async function onAfterThreadSend(threadId: string) {
		await loadSidebar(false)
		const refreshed = threads.find((s) => s.thread_id === threadId)
		if (refreshed) {
			selectedThread = refreshed
			threadChatReloadSignal += 1
			await loadSelectedThreadSenderActivity(refreshed)
		}
	}

	function getAttachmentTargetSession(): Session | null {
		return activeSelectedThreadSession
	}

	async function attachPathsToSession(paths: string[]) {
		if (!selectedThread) return
		const clean = paths.map((p) => p.trim()).filter((p) => p.length > 0)
		if (clean.length === 0) return
		const target = getAttachmentTargetSession()
		if (!target) {
			toast.error('No session available in this thread', {
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
			await threadConversationAdapter(selectedThread).sendMessage(
				`Attached ${count} item${count === 1 ? '' : 's'} to session "${target.name}".`,
			)
			toast.success(`Attached ${count} item${count === 1 ? '' : 's'}`)
		}
	}

	function threadConversationAdapter(thread: CollaborationThread): ConversationAdapter {
		return buildThreadConversationAdapter<VaultMessage>({
			invoke,
			threadId: thread.thread_id,
			threadName: threadDisplayName(thread),
			participants: thread.participants,
			currentUserEmail,
			dedupeMessages: dedupeThreadMessages,
			kindLabel: (msg: VaultMessage) => badgeForKind(getMessageKind(msg)),
				isEventMessage: (msg: VaultMessage) =>
					getMessageKind(msg) === 'thread_event' ||
					msg.body.startsWith('Created thread:') ||
					msg.body.startsWith('Renamed thread to:') ||
					msg.body.startsWith('Created session:'),
				onAfterSend: () => onAfterThreadSend(thread.thread_id),
				// attachPaths: (paths: string[]) => attachPathsToSession(paths),
				buildMessageMetadata: () => {
				const active = activeSelectedThreadSession
				if (!active) return null
				return {
					session_context: {
						session_id: active.session_id,
						session_name: active.name,
					},
				}
			},
		}) as unknown as ConversationAdapter
	}

	function openCreateSessionDialog() {
		createSessionError = ''
		createSessionName = selectedThread ? `Session with ${threadDisplayName(selectedThread)}` : 'New session'
		createSessionDialogOpen = true
	}

	function openSessionsDialog() {
		sessionsDialogSelectedId =
			activeSelectedThreadSession?.session_id || selectedThreadSessions[0]?.session_id || ''
		sessionsDialogOpen = true
	}

	function startRenameThread() {
		if (!selectedThread) return
		renameThreadOpen = true
		renameThreadError = ''
		renameThreadName = threadDisplayName(selectedThread)
	}

	function cancelRenameThread() {
		renameThreadOpen = false
		renameThreadError = ''
		renameThreadName = ''
	}

	async function saveRenameThread() {
		if (!selectedThread || renameThreadLoading) return
		const nextName = renameThreadName.trim()
		if (!nextName) {
			renameThreadError = 'Thread name is required'
			return
		}
		const currentName = threadDisplayName(selectedThread)
		if (nextName === currentName) {
			cancelRenameThread()
			return
		}
		const recipients = threadRecipients(selectedThread)
		if (recipients.length < 1) {
			renameThreadError = 'This thread has no recipients yet'
			return
		}

		renameThreadLoading = true
		renameThreadError = ''
		try {
			await invoke('send_message', {
				request: {
					recipients,
					subject: nextName,
					body: `Renamed thread to: ${nextName}`,
					metadata: {
						thread_event: {
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
			const refreshed = threads.find((s) => s.thread_id === selectedThread?.thread_id)
			if (refreshed) selectedThread = refreshed
			cancelRenameThread()
			toast.success('Thread renamed')
		} catch (e) {
			renameThreadError = String(e)
		} finally {
			renameThreadLoading = false
		}
	}

	async function createSessionFromContext() {
		const name = createSessionName.trim()
		if (!name || createSessionLoading) return
		createSessionLoading = true
		createSessionError = ''
		try {
			const peer =
				selectedThread?.participants.find(
					(p) => normalizeIdentity(p)?.toLowerCase() !== currentUserEmail.toLowerCase(),
				) || null
			const created = await invoke<Session>('create_session', {
				request: { name, peer },
			})
			if (selectedThread && created?.session_id) {
				const recipients = threadRecipients(selectedThread)
				if (recipients.length > 0) {
					await invoke('send_message', {
						request: {
							recipients,
							subject: threadDisplayName(selectedThread),
							body: `Created session: ${name}`,
							metadata: {
								thread_event: {
									type: 'session_created',
									session_id: created.session_id,
									session_name: name,
								},
								group_chat: {
									name: threadDisplayName(selectedThread),
									participants: selectedThread.participants,
								},
							},
						},
					})
				}
			}
				createSessionDialogOpen = false
				await loadSidebar(true)
				await loadSessions()
				if (selectedThread?.thread_id && created?.session_id) {
					activeSessionIdByThread = {
						...activeSessionIdByThread,
						[selectedThread.thread_id]: created.session_id,
					}
				}
				threadChatReloadSignal += 1
			} catch (e) {
				createSessionError = String(e)
		} finally {
			createSessionLoading = false
		}
	}

	function toggleThreadContact(identity: string) {
		const safeIdentity = normalizeIdentity(identity)
		if (!safeIdentity) return
		if (createThreadSelected.includes(safeIdentity)) {
			createThreadSelected = createThreadSelected.filter((v) => v !== safeIdentity)
		} else {
			createThreadSelected = [...createThreadSelected, safeIdentity]
		}
	}

	async function openCreateThreadDialog(preselectIdentity?: unknown) {
		const preselected = normalizeIdentity(preselectIdentity)
		createThreadError = ''
		createThreadName = preselected ? `Thread with ${preselected}` : ''
		createThreadQuery = ''
		createThreadSelected = preselected ? [preselected] : []
		createThreadConfirmAdd = false
		createThreadLoading = true
		try {
			await loadContacts()
			createThreadDialogOpen = true
		} catch (e) {
			createThreadError = String(e)
		} finally {
			createThreadLoading = false
		}
	}

	async function createThreadFromDialog() {
		if (createThreadLoading) return
		if (createThreadSelected.length < 1) {
			createThreadError = 'Select at least 1 contact'
			return
		}
		const toImport = createThreadSelected.filter(
			(id) => {
				const safe = normalizeIdentity(id)
				return safe ? !contactIdentitySet.has(safe.toLowerCase()) : false
			},
		)
		if (toImport.length > 0 && !createThreadConfirmAdd) {
			createThreadError =
				'Confirm adding selected discovered contacts before creating the thread'
			return
		}
		createThreadLoading = true
		createThreadError = ''
		try {
			for (const identity of toImport) {
				await invoke('network_import_contact', { identity })
			}
			const current = normalizeIdentity(currentUserEmail)
			const desiredParticipants = [
				...createThreadSelected,
				...(current ? [current] : []),
			]
			const desiredSig = participantSignature(desiredParticipants)
			const existing = threads.find((s) => participantSignature(s.participants) === desiredSig)
			if (existing) {
				createThreadDialogOpen = false
				selectThread(existing)
				toast.info('Thread already exists. Opened it.')
				return
			}

			const threadLabel = createThreadName.trim() || 'New Thread'
			await invoke('send_message', {
					request: {
						recipients: createThreadSelected,
						subject: threadLabel,
						body: `Created thread: ${threadLabel}`,
						metadata: {
							thread_event: {
								type: 'created',
								name: threadLabel,
							},
							group_chat: {
								name: threadLabel,
							},
						},
					},
				})
			createThreadDialogOpen = false
			await loadSidebar(true)
			const created = threads.find((s) => participantSignature(s.participants) === desiredSig)
			if (created) {
				selectThread(created)
			}
			toast.success('Thread created')
		} catch (e) {
			createThreadError = String(e)
		} finally {
			createThreadLoading = false
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

	async function openSessionFolderById(sessionId: string) {
		await invoke('open_session_folder', { sessionId })
	}

	async function importFlowFromMessage(msg: VaultMessage) {
		const meta = getFlowRequestMeta(msg)
		const flowLocation = meta?.flow_location
		if (typeof flowLocation !== 'string' || !flowLocation.trim()) return
		setEventLoading(msg.id, true)
		try {
			await importFlowFromRequestWithRetry(msg, flowLocation, false)
			await Promise.all([loadInstalledModules(), loadFlowsAndRuns()])
			toast.success('Flow imported')
		} catch (e) {
			const errorText = String(e)
			if (errorText.includes('already exists')) {
				const shouldOverwrite = await confirm(
					'A flow with this name already exists. Replace it with this imported flow?',
					{
						title: 'Overwrite Existing Flow?',
						kind: 'warning',
						okLabel: 'Overwrite',
						cancelLabel: 'Cancel',
					},
				)
				if (shouldOverwrite) {
					try {
						await importFlowFromRequestWithRetry(msg, flowLocation, true)
						await Promise.all([loadInstalledModules(), loadFlowsAndRuns()])
						toast.success('Flow overwritten')
					} catch (overwriteError) {
						toast.error('Failed to overwrite flow', { description: String(overwriteError) })
					}
				}
				return
			}
			toast.error('Failed to import flow', { description: errorText })
		} finally {
			setEventLoading(msg.id, false)
		}
	}

	async function syncFlowRequestFromMessage(msg: VaultMessage) {
		const meta = getFlowRequestMeta(msg)
		const flowLocation = meta?.flow_location
		if (typeof flowLocation !== 'string' || !flowLocation.trim()) return
		setEventLoading(msg.id, true)
		try {
			const status = await waitForFlowRequestReady(flowLocation, 12, 700)
			if (status?.ready) {
				toast.success('Flow request synced')
			} else {
				toast.info('Sync requested', {
					description: status?.reason || 'Flow files may still be arriving.',
				})
			}
		} catch (e) {
			toast.error('Failed to sync request', { description: String(e) })
		} finally {
			setEventLoading(msg.id, false)
		}
	}

	async function openFlowRequestFolderFromMessage(msg: VaultMessage) {
		const meta = getFlowRequestMeta(msg)
		const flowLocation = meta?.flow_location
		if (typeof flowLocation !== 'string' || !flowLocation.trim()) return
		setEventLoading(msg.id, true)
		try {
			await invoke('sync_messages')
			const path = await invoke<string>('resolve_syft_url_to_local_path', { syftUrl: flowLocation })
			const exists = await invoke<boolean>('path_exists', { path })
			if (!exists) {
				throw new Error('Flow request folder is not synced locally yet')
			}
			await invoke('open_folder', { path })
		} catch (e) {
			toast.error('Failed to open request folder', { description: String(e) })
		} finally {
			setEventLoading(msg.id, false)
		}
	}

	function openRequestedFlow(msg: VaultMessage) {
		const flow = getImportedFlowForRequest(msg)
		if (!flow) {
			toast.info('Import flow first')
			return
		}
		goto(`/flows/${encodeURIComponent(flow.name)}`)
	}

	async function sendResultsBackFromMessage(msg: VaultMessage) {
		const runId = selectedRunIdForMessage(msg)
		if (!runId) {
			toast.info('No completed run found yet')
			return
		}
		setEventLoading(msg.id, true)
		try {
			await invoke('send_flow_request_results', {
				requestId: msg.id,
				runId,
				message: null,
				outputPaths: null,
			})
			toast.success('Results sent back')
			await loadSidebar(true)
			threadChatReloadSignal += 1
		} catch (e) {
			toast.error('Failed to send results', { description: String(e) })
		} finally {
			setEventLoading(msg.id, false)
		}
	}

	async function runRequestedFlowFromMessage(msg: VaultMessage, dataType: 'mock' | 'real') {
		const flow = getImportedFlowForRequest(msg)
		if (!flow) {
			toast.info('Import flow first')
			return
		}
		const datasetName = getFlowRequestDatasetName(msg)
		if (!datasetName) {
			toast.error('Request missing dataset name')
			return
		}
		setEventLoading(msg.id, true)
		try {
			const datasets = await invoke<DatasetWithAssetsForRun[]>('list_datasets_with_assets')
			const dataset =
				(datasets || []).find((entry) => entry.dataset.name === datasetName) ||
				(datasets || []).find((entry) => entry.dataset.name.toLowerCase() === datasetName.toLowerCase())
			if (!dataset) {
				throw new Error(`Dataset '${datasetName}' not found locally`)
			}

			const urls = extractUrlsFromAssetsForRun(dataset.assets || [], dataType)
			if (urls.length === 0) {
				throw new Error(
					dataType === 'mock'
						? `No mock assets found for '${datasetName}'`
						: `No private assets found for '${datasetName}'`,
				)
			}

			await invoke('run_flow', {
				flowId: flow.id,
				inputOverrides: {},
				resultsDir: null,
				selection: {
					datasetName: null,
					datasetShape: null,
					datasetDataType: null,
					datasetOwner: null,
					fileIds: [],
					urls,
					participantIds: [],
					assetKeys: [],
					dataType,
					dataSource: null,
				},
			})
			toast.success(`Started ${dataType} run for ${datasetName}`)
			await loadSidebar(true)
			threadChatReloadSignal += 1
		} catch (e) {
			toast.error(`Failed to run ${dataType}`, { description: String(e) })
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

	async function openFlowResultsFolderFromMessage(msg: VaultMessage) {
		const meta = getFlowResultsMeta(msg)
		const resultsLocation = meta?.results_location
		if (typeof resultsLocation !== 'string' || !resultsLocation.trim()) return
		setEventLoading(msg.id, true)
		try {
			await invoke('sync_messages')
			const path = await invoke<string>('resolve_syft_url_to_local_path', { syftUrl: resultsLocation })
			const exists = await invoke<boolean>('path_exists', { path })
			if (!exists) {
				throw new Error('Results folder is not synced locally yet')
			}
			await invoke('open_folder', { path })
		} catch (e) {
			toast.error('Failed to open results folder', { description: String(e) })
		} finally {
			setEventLoading(msg.id, false)
		}
	}

	function startAutoRefresh() {
		if (refreshTimer) return
		refreshTimer = setInterval(async () => {
			if (!isAuthenticated) return
			await loadSidebar(true)
			if (selectedThread) {
				const refreshed = threads.find((s) => s.thread_id === selectedThread?.thread_id)
				if (refreshed) {
					selectedThread = refreshed
					threadChatReloadSignal += 1
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
		loadPersistedActiveSessions(currentUserEmail)
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
				<div class="flex w-72 shrink-0 flex-col overflow-hidden rounded-r-2xl bg-background/90 shadow-[0_10px_30px_-18px_hsl(var(--foreground)/0.35)] ring-1 ring-border/40 backdrop-blur">
				<div class="shrink-0 border-b bg-background/70 px-4 py-2 backdrop-blur">
					<div class="flex h-11 items-center justify-between gap-2">
						<div>
							<h1 class="text-base font-semibold">Messages</h1>
							<p class="text-xs text-muted-foreground">Collaborate with others</p>
						</div>
							<Button
								size="icon"
								variant="ghost"
								class="h-11 w-11 shrink-0 rounded-lg"
								onclick={openCreateThreadDialog}
								aria-label="Create thread"
							>
							<PlusIcon class="size-4" />
						</Button>
					</div>
				</div>
				<div class="shrink-0 px-3 pb-2 pt-2">
					<div class="flex items-center gap-2">
						<div class="relative min-w-0 flex-1">
							<SearchIcon class="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
							<Input placeholder="Search threads..." bind:value={listSearch} class="h-10 pl-9" />
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
							{#each filteredThreads as thread (thread.thread_id)}
											<Button
												variant="ghost"
												size="default"
												onclick={() => selectThread(thread)}
												class="mb-1.5 h-auto w-full justify-start rounded-xl bg-background/70 px-2.5 py-2 text-left font-normal transition-[background,box-shadow] hover:bg-muted/45 {selectedThread?.thread_id ===
													thread.thread_id
														? 'bg-primary/[0.08] shadow-sm ring-1 ring-primary/25'
														: 'ring-1 ring-transparent'}"
											>
												<div class="flex w-full min-w-0 items-center gap-3">
												<Avatar.Root class="size-9 shrink-0">
												<Avatar.Fallback class={`text-xs ${getThreadAvatarTone(thread)}`}
												>{initials(threadDisplayName(thread) || 'SP')}</Avatar.Fallback
												>
											</Avatar.Root>
											<div class="min-w-0 flex-1">
											<p class="truncate text-sm font-medium">{threadDisplayName(thread)}</p>
												<p class="truncate text-xs text-muted-foreground">
												{thread.member_count} members • {thread.last_message_preview}
												</p>
											</div>
											<span class="text-xs text-muted-foreground">{formatTime(thread.last_activity_at)}</span>
											</div>
										</Button>
						{:else}
							<div class="p-6 text-center text-sm text-muted-foreground">
								No threads found
							</div>
						{/each}
					{/if}
				</div>
			</div>

				<div class="w-px shrink-0 self-stretch bg-border/60"></div>
				<div class="min-h-0 min-w-0 flex flex-1 flex-col overflow-hidden">
					{#if selectedThread}
								<div class="shrink-0 border-b bg-background/70 px-4 py-2 backdrop-blur">
									<div class="flex min-h-11 items-center justify-between gap-4">
										<div class="min-w-0 flex-1">
											<div class="flex min-w-0 flex-col justify-center">
												<button
													type="button"
													class="min-w-0 text-left"
											onclick={startRenameThread}
											aria-label="Edit thread"
										>
											<h2 class="truncate text-base font-semibold">{threadDisplayName(selectedThread)}</h2>
												</button>
												<button
													type="button"
													class="flex min-w-0 items-center gap-1.5 text-left text-xs text-muted-foreground"
													onclick={startRenameThread}
													aria-label="Edit thread participants"
												>
													<span class="truncate">
														{#if selectedThreadParticipantSummary.length === 0}
															{selectedThread.member_count} members
														{:else if selectedThreadParticipantSummary.length === 1}
															{selectedThreadParticipantSummary[0]}
														{:else}
															{selectedThreadParticipantSummary.slice(0, 2).join(', ')}
															{#if selectedThreadParticipantSummary.length > 2}
																+ {selectedThreadParticipantSummary.length - 2} more
															{/if}
														{/if}
													</span>
												{#if selectedThreadParticipantSummary.length > 2}
													<Tooltip.Root>
														<Tooltip.Trigger class="inline-flex size-4 shrink-0 items-center justify-center rounded-sm text-muted-foreground hover:text-foreground">
															<CircleHelpIcon class="size-3.5" />
															</Tooltip.Trigger>
															<Tooltip.Content class="max-w-xs text-xs">
															{selectedThreadParticipantSummary.join(', ')}
														</Tooltip.Content>
													</Tooltip.Root>
												{/if}
											</button>
									</div>
								</div>
								<div class="shrink-0 flex min-w-0 flex-col items-end justify-center gap-0.5">
									{#if selectedThreadSessions.length === 0}
										<button
											type="button"
											class="text-sm font-semibold text-foreground/80 transition-colors hover:text-foreground"
											onclick={openSessionsDialog}
										>
											Start session
										</button>
									{:else if activeSelectedThreadSession}
										<button
											type="button"
											class="min-w-0 text-right transition-colors hover:text-foreground"
											aria-label="Open sessions"
											onclick={openSessionsDialog}
										>
											<span class="truncate text-sm font-semibold text-foreground/80">{activeSelectedThreadSession.name}</span>
										</button>
										<div class="flex flex-wrap items-center justify-end gap-3">
											<button
												type="button"
												class="text-xs text-muted-foreground transition-colors hover:text-foreground disabled:opacity-50"
												disabled={!activeSelectedThreadSession}
												onclick={() => (sessionDatasetsDialogOpen = true)}
											>
												Datasets ({activeSessionDatasets.length})
											</button>
											{#if activeSessionJupyter?.running}
												<button
													type="button"
													class="inline-flex items-center gap-1 text-xs text-amber-700 transition-colors hover:text-amber-800 disabled:opacity-50 dark:text-amber-300"
													disabled={activeSessionJupyterLoading}
													onclick={stopActiveSessionJupyter}
												>
													{#if activeSessionJupyterLoading}
														<Loader2Icon class="size-3 animate-spin" />
													{:else}
														<SquareIcon class="size-3" />
													{/if}
													Stop
												</button>
											{:else}
												<button
													type="button"
													class="inline-flex items-center gap-1 text-xs text-muted-foreground transition-colors hover:text-foreground disabled:opacity-50"
													disabled={activeSessionJupyterLoading}
													onclick={launchActiveSessionJupyter}
												>
													{#if activeSessionJupyterLoading}
														<Loader2Icon class="size-3 animate-spin" />
													{:else}
														<PlayIcon class="size-3" />
													{/if}
													Launch
												</button>
											{/if}
											{#if activeSessionLoading}
												<Loader2Icon class="size-3.5 animate-spin text-muted-foreground" />
											{/if}
										</div>
									{/if}
								</div>
							</div>
						</div>
										{#if selectedThreadHasAssistance}
							<div class="border-t border-border/60 pt-2">
								<Collapsible.Root bind:open={connectionIssuesOpen}>
									<Collapsible.Trigger class="flex h-8 w-full items-center justify-between rounded-md px-2 text-xs hover:bg-muted/40">
										<span>Connection Issues</span>
										<Badge variant="outline" class="text-[10px]">Needs attention</Badge>
									</Collapsible.Trigger>
									<Collapsible.Content class="space-y-2 pt-2">
										<div class="rounded-md border border-border/70 bg-muted/30 p-2 text-xs">
											<div class="flex items-center justify-between gap-2">
												<p class="text-muted-foreground">
													Repair trust runs key checks, DID republish, and contact key re-import for this thread.
												</p>
												<Button
													size="sm"
													variant="secondary"
													class="h-7 text-xs"
													disabled={trustRepairLoading}
													onclick={repairTrustForSelectedThread}
												>
													{#if trustRepairLoading}
														<Loader2Icon class="size-3.5 animate-spin" />
														Repairing...
													{:else}
														Repair trust
													{/if}
												</Button>
											</div>
										</div>
										{#if selectedThreadMissingContacts.length > 0}
											<div class="rounded-md border border-amber-300/70 bg-amber-50/40 p-2 text-xs">
												<div class="flex items-center justify-between gap-2">
													<p class="text-amber-900">
														Discovered but not trusted contacts: {selectedThreadMissingContacts.join(', ')}
													</p>
													<Button size="sm" variant="outline" class="h-7 text-xs" onclick={importAllMissingContactsForSelectedThread}>
														Import all
													</Button>
												</div>
											</div>
										{/if}
										{#if selectedThreadInvalidSignatureSenders.length > 0}
											<div class="rounded-md border border-destructive/40 bg-destructive/10 p-2 text-xs">
												<p class="text-destructive">
													Signature verification failed for: {selectedThreadInvalidSignatureSenders.join(', ')}.
												</p>
												<div class="mt-2 flex flex-wrap gap-2">
													{#each selectedThreadInvalidSignatureSenders as identity (identity)}
														<Button
															size="sm"
															variant="outline"
															class="h-7 text-xs"
															disabled={importContactLoadingByIdentity[identity.toLowerCase()]}
															onclick={() => importContactIdentity(identity)}
														>
															{importContactLoadingByIdentity[identity.toLowerCase()]
																? `Importing ${identity}...`
																: `Re-import ${identity}`}
														</Button>
													{/each}
												</div>
											</div>
										{/if}
										{#if selectedThreadSenderKeyMissing.length > 0}
											<div class="rounded-md border border-muted-foreground/30 bg-muted/40 p-2 text-xs text-muted-foreground">
												Missing sender key bundle: {selectedThreadSenderKeyMissing.join(', ')}.
											</div>
										{/if}
										{#if selectedThreadSenderNoIdentity.length > 0}
											<div class="rounded-md border border-muted-foreground/30 bg-muted/40 p-2 text-xs text-muted-foreground">
												Sender lacked local identity key: {selectedThreadSenderNoIdentity.join(', ')}.
											</div>
										{/if}
									</Collapsible.Content>
								</Collapsible.Root>
							</div>
						{/if}

							<div class="min-h-0 min-w-0 flex-1 overflow-hidden">
								<ConversationPanel
									adapter={threadConversationAdapter(selectedThread)}
									reloadSignal={threadChatReloadSignal}
								>
								{#snippet actions(msg)}
									{@const typed = msg as VaultMessage}
									{@const kind = getMessageKind(typed)}
									{#if kind === 'session_invite'}
										{@const sessionId = getSessionInviteId(typed)}
										{@const outgoingInvite = isOutgoingMessage(typed)}
										{#if sessionId}
											<div class="mt-2 flex gap-2">
												{#if outgoingInvite}
													<p class="text-xs text-muted-foreground self-center">
														Invitation sent to {typed.to}
													</p>
												{:else}
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
												{/if}
												<Button
													variant="outline"
													size="sm"
													class="h-7 text-xs"
													onclick={() => openSessionFolderById(sessionId)}
												>
													Open Folder
											</Button>
										</div>
								{/if}
								{/if}
								{#if kind === 'flow_request'}
									{@const moduleDeps = getFlowRequestModuleDependencies(typed)}
									{@const missingModuleDeps = getMissingFlowRequestModuleDependencies(typed)}
									{@const importedFlow = getImportedFlowForRequest(typed)}
									{@const completedRuns = getCompletedRunsForRequest(typed)}
									{@const datasetName = getFlowRequestDatasetName(typed)}
									<div class="mt-2 space-y-2 rounded-md border border-border/70 bg-muted/20 p-2">
										<div class="flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
											<span class="rounded border px-1.5 py-0.5">
												Flow: {importedFlow ? 'imported' : 'not imported'}
											</span>
											<span class="rounded border px-1.5 py-0.5">
												Dependencies: {moduleDeps.length - missingModuleDeps.length}/{moduleDeps.length} installed
											</span>
											{#if completedRuns.length > 0}
												<span class="rounded border px-1.5 py-0.5">
													Runs ready: {completedRuns.length}
												</span>
											{/if}
										</div>
										{#if datasetName}
											<p class="text-[11px] text-muted-foreground">
												Dataset: <span class="font-medium text-foreground">{datasetName}</span>
											</p>
										{/if}
										{#if moduleDeps.length > 0}
											<div class="flex flex-wrap gap-1">
												{#each moduleDeps as dep (dep)}
													<Badge
														variant="outline"
														class={`text-[10px] ${
															missingModuleDeps.includes(dep)
																? 'border-amber-500/40 text-amber-700'
																: 'border-emerald-500/40 text-emerald-700'
														}`}
													>
														{dep} • {missingModuleDeps.includes(dep) ? 'missing' : 'installed'}
													</Badge>
												{/each}
											</div>
										{/if}
										<div class="flex flex-wrap items-center gap-2">
											{#if importedFlow}
												<Button
													size="sm"
													class="h-7 text-xs"
													disabled={eventActionLoading[typed.id]}
													onclick={() => openRequestedFlow(typed)}
												>
													Open Flow
												</Button>
											{:else}
												<Button
													size="sm"
													class="h-7 text-xs"
													disabled={eventActionLoading[typed.id]}
													onclick={() => importFlowFromMessage(typed)}
												>
													Import Flow
												</Button>
											{/if}
											{#if importedFlow}
												<Button
													size="sm"
													variant="outline"
													class="h-7 text-xs"
													disabled={eventActionLoading[typed.id] || !datasetName}
													onclick={() => runRequestedFlowFromMessage(typed, 'mock')}
												>
													Run Mock
												</Button>
												<Button
													size="sm"
													variant="outline"
													class="h-7 text-xs"
													disabled={eventActionLoading[typed.id] || !datasetName}
													onclick={() => runRequestedFlowFromMessage(typed, 'real')}
												>
													Run Real
												</Button>
											{/if}
											<Button
												size="sm"
												variant="outline"
												class="h-7 text-xs"
												disabled={eventActionLoading[typed.id]}
												onclick={() => syncFlowRequestFromMessage(typed)}
											>
												Sync Request
											</Button>
											<Button
												size="sm"
												variant="outline"
												class="h-7 text-xs"
												disabled={eventActionLoading[typed.id]}
												onclick={() => openFlowRequestFolderFromMessage(typed)}
											>
												Open Folder
											</Button>
											{#if importedFlow && completedRuns.length > 0}
													<Select
														class="h-7 rounded-md border bg-background px-2 text-xs"
														value={String(selectedRunIdForMessage(typed) ?? '')}
														onchange={(e) => {
															const selectedValue = Number((e.currentTarget as HTMLSelectElement).value)
															selectedRunIdByMessage = {
															...selectedRunIdByMessage,
															[typed.id]: selectedValue,
														}
													}}
												>
														{#each completedRuns as run (run.id)}
															<option value={run.id}>Run #{run.id}</option>
														{/each}
													</Select>
												<Button
													size="sm"
													variant="outline"
													class="h-7 text-xs"
													disabled={eventActionLoading[typed.id]}
													onclick={() => sendResultsBackFromMessage(typed)}
												>
													Send Results
												</Button>
											{/if}
										</div>
									</div>
								{/if}
									{#if kind === 'flow_results'}
										<div class="mt-2 flex gap-2">
											<Button
												size="sm"
												class="h-7 text-xs"
												disabled={eventActionLoading[typed.id]}
												onclick={() => openFlowResultsFolderFromMessage(typed)}
											>
												Open Folder
											</Button>
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
													onclick={() => openSessionFolderById(responseSessionId)}
												>
													Open Folder
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
							{#if kind === 'thread_event'}
								{@const threadEvent = getThreadEventMeta(typed)}
								{@const eventType = typeof threadEvent?.type === 'string' ? threadEvent.type : null}
								{#if eventType === 'session_created'}
									{@const eventSessionId =
										typeof threadEvent?.session_id === 'string' ? threadEvent.session_id : null}
									{@const eventSessionName =
										typeof threadEvent?.session_name === 'string' ? threadEvent.session_name : 'session'}
									{#if eventSessionId}
											<Button
												variant="link"
												size="sm"
												class="h-auto p-0 text-emerald-900/90"
												onclick={() => setActiveSessionForSelectedThread(eventSessionId)}
											>
												{eventSessionName}
											</Button>
									{/if}
								{/if}
							{/if}
								{/snippet}
							</ConversationPanel>
						</div>
				{:else}
					<div class="min-h-0 flex flex-1 items-center justify-center px-6 text-sm text-muted-foreground">
						Choose a thread from the left, or create one.
					</div>
				{/if}
			</div>
		</div>
	{/if}

	<SyftboxSignInDialog bind:open={signInDialogOpen} />
	<Dialog.Root bind:open={createSessionDialogOpen}>
		<Dialog.Content showCloseButton={false} class="border-border/70 p-0 shadow-soft sm:max-w-[420px]">
			<div class="px-6 py-6">
				<Dialog.Header class="gap-2">
					<Dialog.Title class="text-xl font-semibold">New Session</Dialog.Title>
					<Dialog.Description class="text-sm leading-6">
						{selectedThread
							? `Create a session for ${threadDisplayName(selectedThread)}. Sessions create a shared workspace for this thread, including notebook runtime and linked assets.`
							: 'Create a new collaboration session. Sessions create a shared workspace, including notebook runtime and linked assets.'}
					</Dialog.Description>
				</Dialog.Header>

				<div class="mt-6 space-y-3">
					<label for="session-name" class="text-sm font-medium text-foreground">Session name</label>
					<Input
						id="session-name"
						class="h-11 rounded-lg border-border/70 shadow-none"
						placeholder="Clinical review"
						bind:value={createSessionName}
					/>
					{#if createSessionError}
						<p class="text-sm text-destructive">{createSessionError}</p>
					{/if}
				</div>
			</div>

			<Dialog.Footer class="border-t border-border/70 px-6 py-4 sm:justify-between">
				<Dialog.Close class="inline-flex h-10 items-center justify-center rounded-lg border border-border/70 bg-background px-4 text-sm hover:bg-muted/30">
					Cancel
				</Dialog.Close>
				<Button
					class="h-10 rounded-lg px-4"
					onclick={createSessionFromContext}
					disabled={createSessionLoading || !createSessionName.trim()}
				>
					{#if createSessionLoading}
						<Loader2Icon class="size-4 animate-spin" />
						Creating...
					{:else}
						Create Session
					{/if}
				</Button>
			</Dialog.Footer>
		</Dialog.Content>
	</Dialog.Root>
	<Dialog.Root bind:open={sessionsDialogOpen}>
		<Dialog.Content showCloseButton={false} class="border-border/70 p-0 shadow-soft sm:max-w-[640px]">
			<div class="px-6 py-6">
				<div class="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
					<Dialog.Header class="gap-2">
						<Dialog.Title class="text-xl font-semibold">Sessions</Dialog.Title>
						<Dialog.Description class="text-sm leading-6">
							Choose which session this thread should use.
							{#if selectedThread}
								<span class="block">{threadDisplayName(selectedThread)}</span>
							{/if}
						</Dialog.Description>
					</Dialog.Header>
					<Button
						size="sm"
						class="h-9 rounded-lg px-3"
						onclick={() => {
							sessionsDialogOpen = false
							openCreateSessionDialog()
						}}
					>
						<PlusIcon class="size-4" />
						New Session
					</Button>
				</div>

				<div class="mt-6">
				{#if selectedThreadSessions.length === 0}
					<div class="rounded-xl border border-dashed border-border/70 px-5 py-8 text-center">
						<p class="text-sm font-medium">No sessions yet</p>
						<p class="mt-1 text-sm text-muted-foreground">
							Create the first session for this thread to start sharing work and datasets.
						</p>
					</div>
				{:else}
					<div class="max-h-[420px] space-y-3 overflow-auto pr-1">
						{#each selectedThreadSessions as session (session.session_id)}
							<div class="rounded-xl border border-border/70 px-4 py-4">
								<div class="flex items-start justify-between gap-3">
									<div class="min-w-0">
										<div class="flex flex-wrap items-center gap-2">
											<p class="truncate text-sm font-medium">{session.name}</p>
											{#if activeSelectedThreadSession?.session_id === session.session_id}
												<span class="rounded-full bg-primary/10 px-2 py-0.5 text-[11px] font-medium text-primary">
													Current
												</span>
											{/if}
										</div>
										<div class="mt-1 flex items-center gap-1.5 text-xs text-muted-foreground">
											<Clock3Icon class="size-3.5" />
											{formatSessionCreated(session.created_at)}
										</div>
									</div>
									{#if activeSelectedThreadSession?.session_id === session.session_id}
										<CheckIcon class="mt-0.5 size-4 shrink-0 text-primary" />
									{/if}
								</div>

								<div class="mt-4 flex flex-wrap gap-2">
									<Button
										size="sm"
										class="h-9 rounded-lg px-3"
										onclick={() => {
											setActiveSessionForSelectedThread(session.session_id)
											sessionsDialogOpen = false
										}}
										disabled={activeSelectedThreadSession?.session_id === session.session_id}
									>
										Use Session
									</Button>
									<Button
										size="sm"
										variant="outline"
										class="h-9 rounded-lg px-3"
										onclick={() => openSessionFolderById(session.session_id)}
									>
										Open Folder
									</Button>
									<Button
										size="sm"
										variant="outline"
										class="h-9 rounded-lg px-3"
										disabled={activeSessionJupyterLoading}
										onclick={() => resetSessionJupyterById(session.session_id)}
									>
										Reset Notebook
									</Button>
								</div>
							</div>
						{/each}
					</div>
				{/if}
				</div>
			</div>
		</Dialog.Content>
	</Dialog.Root>
	<Dialog.Root bind:open={sessionDatasetsDialogOpen}>
		<Dialog.Content class="sm:max-w-xl">
			<Dialog.Header>
				<Dialog.Title>Datasets</Dialog.Title>
				<Dialog.Description>
					{activeSelectedThreadSession ? activeSelectedThreadSession.name : 'No active session'}
				</Dialog.Description>
			</Dialog.Header>

			<div class="space-y-3 py-2">
				<div class="flex gap-2">
					<Input
						class="h-9"
						placeholder="syft://.../dataset.yaml"
						bind:value={activeSessionDatasetUrl}
					/>
					<Button
						size="sm"
						disabled={activeSessionDatasetAdding || !activeSessionDatasetUrl.trim() || !activeSelectedThreadSession}
						onclick={addDatasetToActiveSession}
					>
						{#if activeSessionDatasetAdding}
							<Loader2Icon class="size-3.5 animate-spin" />
						{:else}
							Add
						{/if}
					</Button>
				</div>
					{#if activeSessionLoading}
						<p class="text-sm text-muted-foreground">Loading datasets...</p>
					{:else if activeSessionDatasets.length === 0}
					<p class="text-sm text-muted-foreground">No linked datasets.</p>
					{:else}
						<div class="max-h-72 space-y-2 overflow-auto">
							{#each activeSessionDatasets as ds (ds.id)}
							<div class="rounded-md border p-2">
								<p class="truncate text-sm font-medium">{ds.dataset_name}</p>
								<p class="truncate text-xs text-muted-foreground">{ds.dataset_public_url}</p>
								<div class="mt-1 flex items-center justify-between">
									<Badge variant="outline" class="text-[10px]">{ds.role}</Badge>
									<Button
										size="sm"
										variant="ghost"
										class="h-7 px-2 text-xs"
										onclick={() => removeDatasetFromActiveSession(ds.dataset_public_url)}
									>
										Remove
									</Button>
								</div>
							</div>
							{/each}
							</div>
						{/if}
			</div>
				</Dialog.Content>
			</Dialog.Root>
		<Dialog.Root bind:open={renameThreadOpen}>
			<Dialog.Content class="sm:max-w-md">
				<Dialog.Header>
					<Dialog.Title>Edit Thread</Dialog.Title>
					<Dialog.Description>
						Update the thread name for everyone in this conversation.
					</Dialog.Description>
				</Dialog.Header>

				<div class="space-y-3 py-2">
					<Input
						placeholder="Thread name"
						bind:value={renameThreadName}
						onkeydown={(e) => {
							if (e.key === 'Enter') {
								e.preventDefault()
								void saveRenameThread()
							}
							if (e.key === 'Escape') {
								e.preventDefault()
								cancelRenameThread()
							}
						}}
					/>
					{#if renameThreadError}
						<p class="text-sm text-destructive">{renameThreadError}</p>
					{/if}
				</div>

				<Dialog.Footer>
					<Dialog.Close class="inline-flex h-9 items-center justify-center rounded-md bg-muted/60 px-3 text-sm hover:bg-muted">
						Cancel
					</Dialog.Close>
					<Button onclick={saveRenameThread} disabled={renameThreadLoading || !renameThreadName.trim()}>
						{#if renameThreadLoading}
							<Loader2Icon class="size-4 animate-spin" />
							Saving...
						{:else}
							Save
						{/if}
					</Button>
				</Dialog.Footer>
			</Dialog.Content>
		</Dialog.Root>
		<Dialog.Root bind:open={createThreadDialogOpen}>
			<Dialog.Content class="sm:max-w-lg">
			<Dialog.Header>
				<Dialog.Title>Create Thread</Dialog.Title>
				<Dialog.Description>
					Select contacts and create a shared conversation thread.
				</Dialog.Description>
			</Dialog.Header>

			<div class="space-y-3 py-2">
				<Input placeholder="Thread name (optional)" bind:value={createThreadName} />
				<Input placeholder="Search contacts..." bind:value={createThreadQuery} />
				{#if createThreadError}
					<p class="text-sm text-destructive">{createThreadError}</p>
				{/if}
				<div class="max-h-72 overflow-auto rounded-lg bg-muted/20 p-1">
					{#if createThreadLoading}
						<div class="p-4 text-sm text-muted-foreground">Loading contacts...</div>
					{:else if threadCandidates.length === 0}
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
								{@const selected = createThreadSelected.includes(contact.identity)}
								<Button
									variant="ghost"
									size="default"
									class="mb-1 h-auto w-full items-center justify-between rounded-md p-3 text-left font-normal hover:bg-background/80"
									onclick={() => toggleThreadContact(contact.identity)}
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
								</Button>
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
								{@const selected = createThreadSelected.includes(contact.identity)}
								<Button
									variant="ghost"
									size="default"
									class="mb-1 h-auto w-full items-center justify-between rounded-md border border-amber-200/60 bg-amber-50/30 p-3 text-left font-normal hover:bg-amber-50/60"
									onclick={() => toggleThreadContact(contact.identity)}
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
								</Button>
							{/each}
						{/if}
					{/if}
				</div>
				{#if selectedDiscoveredCount > 0}
						<div class="min-h-20 rounded-md border border-amber-300/70 bg-amber-50/50 p-3">
							<label class="flex items-start gap-3">
								<Checkbox class="mt-1" bind:checked={createThreadConfirmAdd} />
								<span class="space-y-0.5">
								<span class="block text-sm font-medium">
									Add selected discovered users to Contacts
								</span>
								<span class="block text-sm text-muted-foreground">
									If checked, {selectedDiscoveredCount} selected discovered {selectedDiscoveredCount === 1
										? 'user will be added'
										: 'users will be added'} to your Contacts before this thread is created.
								</span>
							</span>
						</label>
					</div>
				{/if}
				<p class="text-xs text-muted-foreground">
					Selected: {createThreadSelected.length}
				</p>
			</div>

			<Dialog.Footer>
				<Dialog.Close class="inline-flex h-9 items-center justify-center rounded-md bg-muted/60 px-3 text-sm hover:bg-muted">
					Cancel
				</Dialog.Close>
				<Button onclick={createThreadFromDialog} disabled={createThreadLoading}>
					{#if createThreadLoading}
						<Loader2Icon class="size-4 animate-spin" />
						Creating...
					{:else}
						Create Thread
					{/if}
				</Button>
			</Dialog.Footer>
			</Dialog.Content>
		</Dialog.Root>

	</div>
