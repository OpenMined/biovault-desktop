<script lang="ts">
	import { goto } from '$app/navigation'
	import { invoke } from '@tauri-apps/api/core'
	import { onDestroy, onMount } from 'svelte'
	import { syftboxAuthStore } from '$lib/stores/syftbox-auth.svelte'
	import { Button } from '$lib/components/ui/button/index.js'
	import { Badge } from '$lib/components/ui/badge/index.js'
	import RefreshCwIcon from '@lucide/svelte/icons/refresh-cw'
	import WifiIcon from '@lucide/svelte/icons/wifi'
	import WifiOffIcon from '@lucide/svelte/icons/wifi-off'
	import FolderSyncIcon from '@lucide/svelte/icons/folder-sync'
	import CheckCircleIcon from '@lucide/svelte/icons/check-circle'
	import AlertCircleIcon from '@lucide/svelte/icons/alert-circle'
	import ClockIcon from '@lucide/svelte/icons/clock'
	import Loader2Icon from '@lucide/svelte/icons/loader-2'
	import UploadIcon from '@lucide/svelte/icons/upload'
	import DownloadIcon from '@lucide/svelte/icons/download'
	import FolderOpenIcon from '@lucide/svelte/icons/folder-open'
	import SettingsIcon from '@lucide/svelte/icons/settings'
	import ChevronRightIcon from '@lucide/svelte/icons/chevron-right'
	import ChevronDownIcon from '@lucide/svelte/icons/chevron-down'
	import FileIcon from '@lucide/svelte/icons/file'
	import FolderIcon from '@lucide/svelte/icons/folder'
	import SearchIcon from '@lucide/svelte/icons/search'
	import LinkIcon from '@lucide/svelte/icons/link'
	import GlobeIcon from '@lucide/svelte/icons/globe'
	import ActivityIcon from '@lucide/svelte/icons/activity'
	import ShieldIcon from '@lucide/svelte/icons/shield'

	interface Props {
		mode?: 'sheet' | 'page'
	}

	type TabKey = 'activity' | 'tree' | 'shared' | 'diagnostics'

	interface ConfigInfo {
		is_authenticated?: boolean
		server_url?: string
		email?: string
		data_dir?: string
		config_path?: string
		log_path?: string
	}

	interface SyftboxState {
		running?: boolean
		mode?: string
		backend?: string
		client_url?: string
		pid?: number
		tx_bytes?: number
		rx_bytes?: number
		error?: string
	}

	interface QueueSummary {
		pending: number
		syncing: number
		completed: number
		error: number
	}

	interface SyncFileStatus {
		path: string
		state: string
		progress?: number
		error?: string
		updated_at?: string
	}

	interface UploadInfo {
		id: string
		key: string
		state: string
		size?: number
		uploaded_bytes?: number
		progress?: number
		error?: string
		updated_at?: string
	}

	interface RuntimeSocket {
		connected?: boolean
		last_error?: string
		last_sent_at?: string
		last_recv_at?: string
	}

	interface RuntimeHttp {
		last_error?: string
		last_sent_at?: string
		last_recv_at?: string
	}

	interface LatencyStats {
		serverUrl?: string
		avgMs?: number
		minMs?: number
		maxMs?: number
		lastPingMs?: number
		samples?: number[]
	}

	interface QueueStatus {
		sync?: {
			summary?: Partial<QueueSummary>
			files?: SyncFileStatus[]
		}
		uploads?: UploadInfo[]
		status?: {
			status?: string
			version?: string
			runtime?: {
				websocket?: RuntimeSocket
				http?: RuntimeHttp
				client?: {
					version?: string
					revision?: string
					uptime_sec?: number
					server_url?: string
					client_url?: string
				}
				sync?: {
					syncing_files?: number
				}
			}
			datasite?: {
				status?: string
				error?: string
				config?: {
					data_dir?: string
					email?: string
					server_url?: string
				}
			}
		}
		latency?: LatencyStats
		error?: string
	}

	interface SyncTreeNode {
		name: string
		path: string
		is_dir: boolean
		size?: number
		sync_state: string
		conflict_state: string
		progress?: number
		is_ignored: boolean
		is_essential: boolean
		is_subscribed: boolean
		child_count?: number
		has_mixed_state: boolean
		has_mixed_ignore: boolean
		last_modified?: string
	}

	interface SyncTreeDetails {
		path: string
		name: string
		is_dir: boolean
		size: number
		file_count?: number
		sync_state: string
		conflict_state: string
		progress?: number
		error?: string
		error_count: number
		last_modified?: string
		last_synced?: string
		etag?: string
		local_etag?: string
		upload_id?: string
		uploaded_bytes?: number
		total_bytes?: number
		is_ignored: boolean
		ignore_pattern?: string
		is_essential: boolean
		essential_pattern?: string
		is_priority: boolean
		file_content?: string
		file_type?: string
		syft_pub_info?: {
			description?: string
			permissions: Array<{
				user: string
				access: string
				is_wildcard: boolean
			}>
		}
	}

	interface SharedWithMeItem {
		owner: string
		path: string
		description?: string
		access: string
		is_subscribed: boolean
	}

	interface IgnorePatterns {
		default_patterns: string[]
		custom_patterns: string[]
		syftignore_path: string
	}

	interface ConnectionLogEntry {
		timestamp: string
		type: 'daemon' | 'websocket' | 'refresh' | 'error'
		status: string
		message: string
	}

	interface TurnProbeResult {
		ok: boolean
		turn_url: string
		tcp_reachable: boolean
		udp_send_ok: boolean
		udp_response_ok: boolean
		stun_binding_ok: boolean
		reflexive_addr?: string
		rtt_ms?: number
		resolved_addrs?: string[]
		details?: string
		attempt_logs?: string[]
	}

	interface PeerLinkTestResult {
		ok: boolean
		local_email: string
		peer_email: string
		run_id: string
		rounds: number
		completed_rounds: number
		failed_rounds: number
		payload_bytes: number
		min_rtt_ms?: number
		avg_rtt_ms?: number
		p50_rtt_ms?: number
		p95_rtt_ms?: number
		max_rtt_ms?: number
		details?: string
		attempt_logs?: string[]
	}

	interface TreeRow {
		node: SyncTreeNode
		depth: number
	}

	let { mode = 'sheet' }: Props = $props()

	const CONNECTION_LOG_STORAGE_KEY = 'syftbox-panel-connection-log-v1'
	const MAX_ACTIVITY_ENTRIES = 80
	const MAX_CONNECTION_LOG_ENTRIES = 120

	let loading = $state(true)
	let refreshing = $state(false)
	let treeRefreshing = $state(false)
	let sharedRefreshing = $state(false)
	let detailsLoading = $state(false)
	let subscriptionUpdating = $state<string | null>(null)
	let activeTab = $state<TabKey>('activity')
	let filterText = $state('')
	let sharedFilter = $state('')

	let configInfo = $state<ConfigInfo>({})
	let syftboxState = $state<SyftboxState>({})
	let queueStatus = $state<QueueStatus | null>(null)
	let daemonRunning = $state(false)
	let wsConnected = $state(false)
	let queueSummary = $state<QueueSummary>({
		pending: 0,
		syncing: 0,
		completed: 0,
		error: 0
	})
	let activityLog = $state<Array<SyncFileStatus | UploadInfo & { path?: string }>>([])
	let sharedItems = $state<SharedWithMeItem[]>([])
	let ignorePatterns = $state<IgnorePatterns | null>(null)
	let selectedPath = $state<string | null>(null)
	let selectedDetails = $state<SyncTreeDetails | null>(null)
	let rootNodes = $state<SyncTreeNode[]>([])
	let childrenByPath = $state<Record<string, SyncTreeNode[]>>({})
	let expandedPaths = $state<Set<string>>(new Set())
	let loadingPaths = $state<Set<string>>(new Set())
	let connectionLog = $state<ConnectionLogEntry[]>([])
	let turnTesting = $state(false)
	let turnTestResult = $state('TURN test not run yet.')
	let peerEmailInput = $state('')
	let peerRoundsInput = $state('3')
	let peerPayloadKbInput = $state('32')
	let peerTesting = $state(false)
	let peerTestResult = $state('Peer email is required.')

	let refreshInterval: ReturnType<typeof setInterval> | null = null

	const isAuthenticated = $derived(Boolean(configInfo.is_authenticated || syftboxAuthStore.isAuthenticated))
	const email = $derived(configInfo.email || syftboxAuthStore.email || '')
	const dataDir = $derived(configInfo.data_dir || '')
	const serverUrl = $derived(configInfo.server_url || '')
	const clientUrl = $derived(syftboxState.client_url || queueStatus?.status?.runtime?.client?.client_url || '')
	const pid = $derived(syftboxState.pid || null)
	const txBytes = $derived(syftboxState.tx_bytes || 0)
	const rxBytes = $derived(syftboxState.rx_bytes || 0)
	const latency = $derived(queueStatus?.latency || null)
	const runtimeSocket = $derived(queueStatus?.status?.runtime?.websocket || null)
	const runtimeHttp = $derived(queueStatus?.status?.runtime?.http || null)
	const runtimeClient = $derived(queueStatus?.status?.runtime?.client || null)
	const panelHeightClass = $derived(mode === 'sheet' ? 'min-h-0 flex-1' : 'h-full')

	function formatBytes(bytes: number | undefined): string {
		if (!bytes || bytes <= 0) return '0 B'
		const units = ['B', 'KB', 'MB', 'GB', 'TB']
		let size = bytes
		let index = 0
		while (size >= 1024 && index < units.length - 1) {
			size /= 1024
			index += 1
		}
		return `${size.toFixed(size >= 10 || index === 0 ? 0 : 1)} ${units[index]}`
	}

	function formatRelativeTime(isoString?: string): string {
		if (!isoString) return '-'
		const date = new Date(isoString)
		const diffMs = Date.now() - date.getTime()
		if (Number.isNaN(diffMs)) return '-'
		const diffSec = Math.floor(diffMs / 1000)
		if (diffSec < 60) return `${Math.max(diffSec, 1)}s ago`
		const diffMin = Math.floor(diffSec / 60)
		if (diffMin < 60) return `${diffMin}m ago`
		const diffHr = Math.floor(diffMin / 60)
		if (diffHr < 24) return `${diffHr}h ago`
		return date.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
	}

	function formatAbsoluteTime(isoString?: string): string {
		if (!isoString) return '-'
		const date = new Date(isoString)
		if (Number.isNaN(date.getTime())) return '-'
		return date.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
	}

	function formatUptime(seconds?: number): string {
		if (!seconds || seconds < 1) return '-'
		const hrs = Math.floor(seconds / 3600)
		const mins = Math.floor((seconds % 3600) / 60)
		if (hrs > 0) return `${hrs}h ${mins}m`
		return `${mins}m`
	}

	function normalizeSyncPath(path?: string): string {
		if (!path) return ''
		return path.replace(/^.*?datasites\//, '').replace(/^datasites\//, '')
	}

	function getStateIcon(state: string) {
		switch (state) {
			case 'completed':
				return CheckCircleIcon
			case 'syncing':
			case 'uploading':
			case 'downloading':
				return Loader2Icon
			case 'pending':
				return ClockIcon
			case 'error':
			case 'failed':
				return AlertCircleIcon
			default:
				return FileIcon
		}
	}

	function getStateTone(state: string): string {
		switch (state) {
			case 'completed':
				return 'text-emerald-600'
			case 'syncing':
			case 'uploading':
			case 'downloading':
				return 'text-sky-600'
			case 'pending':
				return 'text-amber-600'
			case 'error':
			case 'failed':
				return 'text-rose-600'
			default:
				return 'text-muted-foreground'
		}
	}

	function nodeSyncStatus(path: string): { state: string; progress?: number; error?: string } {
		const normalized = normalizeSyncPath(path)
		const match = queueStatus?.sync?.files?.find((file) => normalizeSyncPath(file.path) === normalized)
		return {
			state: match?.state || 'completed',
			progress: match?.progress,
			error: match?.error
		}
	}

	function addConnectionLog(type: ConnectionLogEntry['type'], status: string, message: string) {
		const next = [{ timestamp: new Date().toISOString(), type, status, message }, ...connectionLog]
		connectionLog = next.slice(0, MAX_CONNECTION_LOG_ENTRIES)
		localStorage.setItem(CONNECTION_LOG_STORAGE_KEY, JSON.stringify(connectionLog))
	}

	function loadConnectionLog() {
		try {
			const raw = localStorage.getItem(CONNECTION_LOG_STORAGE_KEY)
			if (raw) {
				connectionLog = JSON.parse(raw)
			}
		} catch {
			connectionLog = []
		}
	}

	async function refreshStatus() {
		refreshing = true
		try {
			const [nextConfigInfo, nextSyftboxState, nextQueueStatus, nextIgnorePatterns] = await Promise.all([
				invoke<ConfigInfo>('get_syftbox_config_info').catch(() => ({} as ConfigInfo)),
				invoke<SyftboxState>('get_syftbox_state').catch(() => ({} as SyftboxState)),
				invoke<QueueStatus>('syftbox_queue_status').catch(() => null),
				invoke<IgnorePatterns>('sync_tree_get_ignore_patterns').catch(() => null)
			])

			const wasRunning = daemonRunning
			const wasWsConnected = wsConnected

			configInfo = nextConfigInfo || {}
			syftboxState = nextSyftboxState || {}
			queueStatus = nextQueueStatus
			ignorePatterns = nextIgnorePatterns

			daemonRunning = Boolean(nextSyftboxState?.running)
			wsConnected = Boolean(nextQueueStatus?.status?.runtime?.websocket?.connected)
			queueSummary = {
				pending: nextQueueStatus?.sync?.summary?.pending || 0,
				syncing: nextQueueStatus?.sync?.summary?.syncing || 0,
				completed: nextQueueStatus?.sync?.summary?.completed || 0,
				error: nextQueueStatus?.sync?.summary?.error || 0
			}

			const syncActivity =
				nextQueueStatus?.sync?.files?.map((file) => ({
					...file,
					path: normalizeSyncPath(file.path)
				})) || []
			const uploadActivity =
				nextQueueStatus?.uploads?.map((upload) => ({
					...upload,
					path: normalizeSyncPath(upload.key)
				})) || []

			activityLog = [...syncActivity, ...uploadActivity]
				.sort((a, b) => {
					const aTime = new Date((a as SyncFileStatus).updated_at || 0).getTime()
					const bTime = new Date((b as SyncFileStatus).updated_at || 0).getTime()
					return bTime - aTime
				})
				.slice(0, MAX_ACTIVITY_ENTRIES)

			if (daemonRunning !== wasRunning) {
				addConnectionLog('daemon', daemonRunning ? 'running' : 'stopped', daemonRunning ? 'SyftBox daemon running' : 'SyftBox daemon stopped')
			}
			if (wsConnected !== wasWsConnected) {
				addConnectionLog('websocket', wsConnected ? 'connected' : 'disconnected', wsConnected ? 'WebSocket connected' : 'WebSocket disconnected')
			}
			if (nextQueueStatus?.error) {
				addConnectionLog('error', 'queue-error', nextQueueStatus.error)
			}

			if (!rootNodes.length) {
				await refreshTree()
			}
			if (!sharedItems.length) {
				await refreshShared()
			}
			if (selectedPath) {
				void loadDetails(selectedPath)
			}
		} catch (error) {
			console.error('Failed to refresh SyftBox status:', error)
			addConnectionLog('error', 'refresh-failed', String(error))
		} finally {
			loading = false
			refreshing = false
		}
	}

	async function refreshTree() {
		treeRefreshing = true
		try {
			await invoke<boolean>('sync_tree_init_default_policy').catch(() => false)
			const roots = await invoke<SyncTreeNode[]>('sync_tree_list_dir', { path: null }).catch(() => [])
			rootNodes = roots
			if (selectedPath && selectedPath.includes('/')) {
				const ancestorParts = selectedPath.split('/').slice(0, -1)
				let runningPath = ''
				for (const part of ancestorParts) {
					runningPath = runningPath ? `${runningPath}/${part}` : part
					if (!expandedPaths.has(runningPath)) {
						expandedPaths = new Set([...expandedPaths, runningPath])
					}
					await ensureChildrenLoaded(runningPath)
				}
			}
			if (!selectedPath && roots.length > 0) {
				selectedPath = roots[0].path
				void loadDetails(selectedPath)
			}
		} finally {
			treeRefreshing = false
		}
	}

	async function ensureChildrenLoaded(path: string) {
		if (childrenByPath[path] || loadingPaths.has(path)) return
		loadingPaths = new Set([...loadingPaths, path])
		try {
			const children = await invoke<SyncTreeNode[]>('sync_tree_list_dir', { path })
			childrenByPath = { ...childrenByPath, [path]: children }
		} catch (error) {
			console.error(`Failed to load tree children for ${path}:`, error)
		} finally {
			const next = new Set(loadingPaths)
			next.delete(path)
			loadingPaths = next
		}
	}

	async function toggleExpand(path: string) {
		if (expandedPaths.has(path)) {
			const next = new Set(expandedPaths)
			next.delete(path)
			expandedPaths = next
			return
		}
		expandedPaths = new Set([...expandedPaths, path])
		await ensureChildrenLoaded(path)
	}

	async function loadDetails(path: string) {
		selectedPath = path
		detailsLoading = true
		try {
			selectedDetails = await invoke<SyncTreeDetails>('sync_tree_get_details', { path })
		} catch (error) {
			console.error(`Failed to load details for ${path}:`, error)
			selectedDetails = null
		} finally {
			detailsLoading = false
		}
	}

	async function refreshShared() {
		sharedRefreshing = true
		try {
			sharedItems = await invoke<SharedWithMeItem[]>('sync_tree_get_shared_with_me').catch(() => [])
		} finally {
			sharedRefreshing = false
		}
	}

	async function toggleSubscription(node: SyncTreeNode, allow: boolean) {
		subscriptionUpdating = node.path
		try {
			await invoke('sync_tree_set_subscription', { path: node.path, allow, isDir: node.is_dir })
			await Promise.all([refreshTree(), refreshShared()])
			if (selectedPath === node.path) {
				await loadDetails(node.path)
			}
		} catch (error) {
			console.error(`Failed to update subscription for ${node.path}:`, error)
		} finally {
			subscriptionUpdating = null
		}
	}

	async function toggleSharedSubscription(item: SharedWithMeItem) {
		subscriptionUpdating = item.path
		try {
			if (item.is_subscribed) {
				await invoke('sync_tree_unsubscribe', { path: item.path })
			} else {
				await invoke('sync_tree_subscribe', { path: item.path })
			}
			await Promise.all([refreshShared(), refreshTree()])
			if (selectedPath === item.path) {
				await loadDetails(item.path)
			}
		} catch (error) {
			console.error(`Failed to update shared subscription for ${item.path}:`, error)
		} finally {
			subscriptionUpdating = null
		}
	}

	function treeMatchesFilter(node: SyncTreeNode): boolean {
		if (!filterText.trim()) return true
		const query = filterText.trim().toLowerCase()
		if (node.name.toLowerCase().includes(query) || node.path.toLowerCase().includes(query)) return true
		const children = childrenByPath[node.path] || []
		return children.some((child) => treeMatchesFilter(child))
	}

	function buildTreeRows(nodes: SyncTreeNode[], depth = 0): TreeRow[] {
		const rows: TreeRow[] = []
		for (const node of nodes) {
			if (!treeMatchesFilter(node)) continue
			rows.push({ node, depth })
			if (node.is_dir && expandedPaths.has(node.path)) {
				rows.push(...buildTreeRows(childrenByPath[node.path] || [], depth + 1))
			}
		}
		return rows
	}

	const visibleTreeRows = $derived(buildTreeRows(rootNodes))
	const filteredSharedItems = $derived(
		sharedItems.filter((item) => {
			const query = sharedFilter.trim().toLowerCase()
			if (!query) return true
			return (
				item.owner.toLowerCase().includes(query) ||
				item.path.toLowerCase().includes(query) ||
				(item.description || '').toLowerCase().includes(query)
			)
		})
	)

	async function openDatasitesFolder() {
		if (!dataDir) return
		try {
			await invoke('open_folder', { path: `${dataDir}/datasites` })
		} catch (error) {
			console.error('Failed to open datasites folder:', error)
		}
	}

	async function openSettings() {
		await goto('/settings')
	}

	async function toggleOnline() {
		try {
			if (syftboxAuthStore.isOnline) {
				await syftboxAuthStore.goOffline()
			} else {
				await syftboxAuthStore.goOnline()
			}
			await refreshStatus()
		} catch (error) {
			console.error('Failed to toggle SyftBox online state:', error)
		}
	}

	function isActivityUploading(entry: SyncFileStatus | UploadInfo & { path?: string }) {
		return 'key' in entry
	}

	function isStateBusy(state: string) {
		return state === 'syncing' || state === 'uploading' || state === 'downloading'
	}

	function syftboxStatusBadgeText() {
		if (isAuthenticated) {
			return daemonRunning ? 'CONNECTED (● RUNNING)' : 'CONNECTED (○ STOPPED)'
		}
		return 'NOT AUTHENTICATED'
	}

	async function runTurnTest() {
		turnTesting = true
		turnTestResult = 'Testing TURN/STUN connectivity...'
		try {
			const probe = await invoke<TurnProbeResult>('test_turn_connection', {
				serverUrl: serverUrl || null
			})
			const addresses = Array.isArray(probe.resolved_addrs) ? probe.resolved_addrs : []
			const attempts = Array.isArray(probe.attempt_logs) ? probe.attempt_logs : []
			const lines = [
				`${probe.ok ? 'PASS' : 'CHECK'}: ${probe.turn_url}`,
				`tcp=${probe.tcp_reachable ? 'ok' : 'fail'} | udp_send=${probe.udp_send_ok ? 'ok' : 'fail'} | udp_response=${probe.udp_response_ok ? 'ok' : 'fail'} | stun_binding=${probe.stun_binding_ok ? 'ok' : 'fail'}`
			]
			if (probe.reflexive_addr) lines.push(`reflexive_addr=${probe.reflexive_addr}`)
			if (probe.rtt_ms !== null && probe.rtt_ms !== undefined) lines.push(`rtt_ms=${probe.rtt_ms}`)
			if (addresses.length) lines.push(`resolved_addrs=${addresses.join(', ')}`)
			if (probe.details) lines.push(`details=${probe.details}`)
			if (attempts.length) {
				lines.push('trace:')
				lines.push(...attempts.map((line) => `  - ${line}`))
			}
			turnTestResult = lines.join('\n')
		} catch (error) {
			turnTestResult = `FAIL: ${error instanceof Error ? error.message : String(error)}`
		} finally {
			turnTesting = false
		}
	}

	async function runPeerLinkTest() {
		const peerEmail = peerEmailInput.trim()
		if (!peerEmail) {
			peerTestResult = 'Peer email is required.'
			return
		}

		peerTesting = true
		peerTestResult = 'Running peer link test...'
		try {
			const rounds = Math.max(1, Math.min(100, Number.parseInt(peerRoundsInput || '3', 10) || 3))
			const payloadKb = Math.max(1, Math.min(1024, Number.parseInt(peerPayloadKbInput || '32', 10) || 32))
			const result = await invoke<PeerLinkTestResult>('test_peer_link', {
				options: {
					peerEmail,
					rounds,
					payloadKb
				}
			})
			const lines = [
				`${result.ok ? 'PASS' : 'CHECK'}: ${result.local_email} ↔ ${result.peer_email}`,
				`run_id=${result.run_id}`,
				`rounds=${result.rounds} | completed=${result.completed_rounds} | failed=${result.failed_rounds} | payload=${formatBytes(result.payload_bytes)}`
			]
			if (result.min_rtt_ms !== null && result.min_rtt_ms !== undefined) {
				lines.push(
					`rtt_ms min=${result.min_rtt_ms} p50=${result.p50_rtt_ms ?? '-'} p95=${result.p95_rtt_ms ?? '-'} avg=${result.avg_rtt_ms ?? '-'} max=${result.max_rtt_ms ?? '-'}`
				)
			}
			if (result.details) lines.push(`details=${result.details}`)
			if (result.attempt_logs?.length) {
				lines.push('trace:')
				lines.push(...result.attempt_logs.map((line) => `  - ${line}`))
			}
			peerTestResult = lines.join('\n')
		} catch (error) {
			peerTestResult = `FAIL: ${error instanceof Error ? error.message : String(error)}`
		} finally {
			peerTesting = false
		}
	}

	onMount(() => {
		loadConnectionLog()
		void refreshStatus()
		refreshInterval = setInterval(() => {
			void refreshStatus()
		}, 3000)
	})

	onDestroy(() => {
		if (refreshInterval) clearInterval(refreshInterval)
	})
</script>

<div class={`flex ${panelHeightClass} flex-col gap-4 overflow-hidden`}>
	<div class="flex shrink-0 items-start justify-between gap-3">
		<div class="flex items-center gap-3">
			<div class="flex size-10 items-center justify-center rounded-xl border bg-muted/60">
				<FolderSyncIcon class="size-5" />
			</div>
			<div>
				<h2 class="text-lg font-semibold">SyftBox Sync</h2>
				<p class="text-muted-foreground text-sm">
					Status, sync tree, shared content, and diagnostics
				</p>
			</div>
		</div>
		<div class="flex items-center gap-2">
			<Button variant="outline" size="sm" onclick={refreshStatus} disabled={refreshing}>
				<RefreshCwIcon class={`size-4 ${refreshing ? 'animate-spin' : ''}`} />
			</Button>
			{#if dataDir}
				<Button variant="outline" size="sm" onclick={openDatasitesFolder}>
					<FolderOpenIcon class="size-4" />
				</Button>
			{/if}
			<Button variant="outline" size="sm" onclick={openSettings}>
				<SettingsIcon class="size-4" />
			</Button>
		</div>
	</div>

	{#if loading}
		<div class="flex flex-1 items-center justify-center">
			<Loader2Icon class="size-8 animate-spin text-muted-foreground" />
		</div>
	{:else}
		<div class="grid shrink-0 gap-3 lg:grid-cols-[1.3fr_1fr]">
			<div class="rounded-xl border p-4">
				<div class="flex items-center justify-between gap-3">
					<div class="flex items-center gap-2">
						{#if daemonRunning && wsConnected}
							<WifiIcon class="size-4 text-emerald-600" />
							<span class="text-sm font-medium text-emerald-700">Connected</span>
						{:else if daemonRunning}
							<WifiIcon class="size-4 text-amber-600" />
							<span class="text-sm font-medium text-amber-700">Daemon running</span>
						{:else}
							<WifiOffIcon class="size-4 text-muted-foreground" />
							<span class="text-sm font-medium text-muted-foreground">Offline</span>
						{/if}
						{#if email}
							<Badge variant="secondary">{email}</Badge>
						{/if}
					</div>
					<div class="flex items-center gap-2">
						{#if isAuthenticated}
							<Button
								variant={syftboxAuthStore.isOnline ? 'outline' : 'default'}
								size="sm"
								onclick={toggleOnline}
								disabled={syftboxAuthStore.isTogglingOnline}
							>
								{#if syftboxAuthStore.isTogglingOnline}
									<Loader2Icon class="mr-1 size-4 animate-spin" />
								{/if}
								{syftboxAuthStore.isOnline ? 'Go Offline' : 'Go Online'}
							</Button>
						{:else}
							<Button size="sm" onclick={openSettings}>Sign In</Button>
						{/if}
					</div>
				</div>
				<div class="mt-3 grid gap-2 text-sm text-muted-foreground md:grid-cols-2">
					<div class="truncate">Server: {serverUrl || 'Not configured'}</div>
					<div class="truncate">Client: {clientUrl || 'Unavailable'}</div>
					<div>Backend: {syftboxState.backend || syftboxState.mode || 'Unknown'}</div>
					<div>PID: {pid || '-'}</div>
				</div>
				<div class="mt-3 flex flex-wrap gap-2">
					{#if queueSummary.syncing > 0}
						<Badge class="gap-1">
							<Loader2Icon class="size-3 animate-spin" />
							{queueSummary.syncing} syncing
						</Badge>
					{/if}
					{#if queueSummary.pending > 0}
						<Badge variant="secondary" class="gap-1">
							<ClockIcon class="size-3" />
							{queueSummary.pending} pending
						</Badge>
					{/if}
					{#if queueSummary.completed > 0}
						<Badge variant="outline" class="gap-1 text-emerald-700">
							<CheckCircleIcon class="size-3" />
							{queueSummary.completed} completed
						</Badge>
					{/if}
					{#if queueSummary.error > 0}
						<Badge variant="destructive" class="gap-1">
							<AlertCircleIcon class="size-3" />
							{queueSummary.error} errors
						</Badge>
					{/if}
					{#if queueSummary.syncing === 0 && queueSummary.pending === 0 && queueSummary.completed === 0 && queueSummary.error === 0}
						<span class="text-sm text-muted-foreground">No active sync work</span>
					{/if}
				</div>
			</div>

			<div class="rounded-xl border p-4">
				<div class="grid gap-3 sm:grid-cols-2">
					<div class="rounded-lg bg-muted/40 p-3">
						<div class="flex items-center gap-2 text-xs uppercase tracking-[0.12em] text-muted-foreground">
							<UploadIcon class="size-3.5" />
							Outbound
						</div>
						<div class="mt-2 font-mono text-lg">{formatBytes(txBytes)}</div>
					</div>
					<div class="rounded-lg bg-muted/40 p-3">
						<div class="flex items-center gap-2 text-xs uppercase tracking-[0.12em] text-muted-foreground">
							<DownloadIcon class="size-3.5" />
							Inbound
						</div>
						<div class="mt-2 font-mono text-lg">{formatBytes(rxBytes)}</div>
					</div>
				</div>
				<div class="mt-3 grid gap-2 text-sm text-muted-foreground sm:grid-cols-2">
					<div>Latency: {latency?.lastPingMs ? `${latency.lastPingMs} ms` : '-'}</div>
					<div>Average: {latency?.avgMs ? `${latency.avgMs} ms` : '-'}</div>
					<div>Uptime: {formatUptime(runtimeClient?.uptime_sec)}</div>
					<div>Version: {runtimeClient?.version || queueStatus?.status?.version || '-'}</div>
				</div>
			</div>
		</div>

		<div class="flex shrink-0 flex-wrap gap-2">
			{#each [
				{ key: 'activity', label: 'Activity', icon: ActivityIcon },
				{ key: 'tree', label: 'Sync Tree', icon: FolderSyncIcon },
				{ key: 'shared', label: 'Shared', icon: GlobeIcon },
				{ key: 'diagnostics', label: 'Diagnostics', icon: ShieldIcon }
			] as tab}
				<Button
					variant={activeTab === tab.key ? 'default' : 'outline'}
					size="sm"
					onclick={() => (activeTab = tab.key as TabKey)}
				>
					<tab.icon class="mr-1 size-4" />
					{tab.label}
				</Button>
			{/each}
		</div>

		<div class="min-h-0 flex-1 overflow-hidden rounded-xl border">
			{#if activeTab === 'activity'}
				<div class="flex h-full flex-col">
					<div class="flex shrink-0 items-center justify-between border-b px-4 py-3">
						<div>
							<h3 class="font-medium">Recent Activity</h3>
							<p class="text-muted-foreground text-sm">Sync files and uploads from the active queue</p>
						</div>
						<span class="text-muted-foreground text-xs">{activityLog.length} items</span>
					</div>
					<div class="min-h-0 flex-1 overflow-auto">
						{#if activityLog.length === 0}
							<div class="flex h-full items-center justify-center text-sm text-muted-foreground">
								No recent sync activity
							</div>
						{:else}
							<div class="divide-y">
								{#each activityLog as entry, index (`${entry.path || ('id' in entry ? entry.id : index)}-${entry.updated_at || index}`)}
									{@const entryState = entry.state || 'pending'}
									{@const StateIcon = getStateIcon(entryState)}
									<div class="px-4 py-3">
										<div class="flex items-start gap-3">
											<div class={`mt-0.5 ${getStateTone(entryState)}`}>
												<StateIcon class={`size-4 ${isStateBusy(entryState) ? 'animate-spin' : ''}`} />
											</div>
											<div class="min-w-0 flex-1">
												<div class="flex items-start justify-between gap-3">
													<div class="min-w-0">
														<div class="truncate font-mono text-xs">
															{entry.path || ('key' in entry ? entry.key : '')}
														</div>
														<div class="mt-1 flex flex-wrap gap-2 text-xs text-muted-foreground">
															<span class="capitalize">{entryState}</span>
															{#if isActivityUploading(entry)}
																<span>upload</span>
															{:else}
																<span>sync</span>
															{/if}
															{#if 'progress' in entry && entry.progress}
																<span>{Math.round(entry.progress)}%</span>
															{/if}
															{#if 'size' in entry && entry.size}
																<span>{formatBytes(entry.size)}</span>
															{/if}
														</div>
													</div>
													<div class="shrink-0 text-right text-xs text-muted-foreground">
														<div>{formatRelativeTime(entry.updated_at)}</div>
														<div>{formatAbsoluteTime(entry.updated_at)}</div>
													</div>
												</div>
												{#if entry.error}
													<div class="mt-2 rounded-md bg-rose-50 px-2 py-1 text-xs text-rose-700 dark:bg-rose-950/30 dark:text-rose-300">
														{entry.error}
													</div>
												{/if}
											</div>
										</div>
									</div>
								{/each}
							</div>
						{/if}
					</div>
				</div>
			{:else if activeTab === 'tree'}
				<div class="grid h-full min-h-0 lg:grid-cols-[1.2fr_0.8fr]">
					<div class="flex min-h-0 flex-col border-b lg:border-r lg:border-b-0">
						<div class="flex shrink-0 items-center gap-2 border-b px-4 py-3">
							<div class="relative flex-1">
								<SearchIcon class="text-muted-foreground absolute top-1/2 left-3 size-4 -translate-y-1/2" />
								<input
									class="border-input bg-background w-full rounded-md border py-2 pr-3 pl-9 text-sm outline-none"
									placeholder="Filter files or folders"
									bind:value={filterText}
								/>
							</div>
							<Button variant="outline" size="sm" onclick={refreshTree} disabled={treeRefreshing}>
								<RefreshCwIcon class={`size-4 ${treeRefreshing ? 'animate-spin' : ''}`} />
							</Button>
						</div>
						<div class="min-h-0 flex-1 overflow-auto">
							{#if visibleTreeRows.length === 0}
								<div class="flex h-full items-center justify-center text-sm text-muted-foreground">
									No matching sync tree entries
								</div>
							{:else}
								<div class="divide-y">
									{#each visibleTreeRows as row (row.node.path)}
										{@const nodeStatus = nodeSyncStatus(row.node.path)}
										<div
											class={`flex items-center gap-2 px-4 py-2 text-sm ${selectedPath === row.node.path ? 'bg-muted/60' : ''}`}
											style={`padding-left:${16 + row.depth * 18}px`}
										>
											<button
												class="flex size-5 items-center justify-center rounded hover:bg-muted disabled:opacity-40"
												onclick={() => row.node.is_dir && toggleExpand(row.node.path)}
												disabled={!row.node.is_dir}
											>
												{#if row.node.is_dir}
													{#if expandedPaths.has(row.node.path)}
														<ChevronDownIcon class="size-4" />
													{:else}
														<ChevronRightIcon class="size-4" />
													{/if}
												{/if}
											</button>
											<button
												class="flex min-w-0 flex-1 items-center gap-2 text-left"
												onclick={() => loadDetails(row.node.path)}
											>
												{#if row.node.is_dir}
													<FolderIcon class="size-4 shrink-0 text-amber-600" />
												{:else}
													<FileIcon class="size-4 shrink-0 text-muted-foreground" />
												{/if}
												<span class="truncate">{row.node.name}</span>
												{#if row.node.child_count}
													<span class="text-muted-foreground text-xs">({row.node.child_count})</span>
												{/if}
											</button>
											<div class="flex items-center gap-1">
												{#if row.node.is_essential}
													<Badge variant="secondary">required</Badge>
												{:else if row.node.is_ignored}
													<Badge variant="outline">ignored</Badge>
												{/if}
												{#if nodeStatus.state !== 'completed'}
													<Badge variant="outline" class={getStateTone(nodeStatus.state)}>
														{nodeStatus.state}
													</Badge>
												{/if}
											</div>
											<Button
												variant={row.node.is_subscribed ? 'secondary' : 'outline'}
												size="sm"
												onclick={() => toggleSubscription(row.node, !row.node.is_subscribed)}
												disabled={row.node.is_essential || subscriptionUpdating === row.node.path}
											>
												{#if subscriptionUpdating === row.node.path}
													<Loader2Icon class="size-4 animate-spin" />
												{:else}
													{row.node.is_subscribed ? 'On' : 'Off'}
												{/if}
											</Button>
										</div>
										{#if loadingPaths.has(row.node.path)}
											<div
												class="text-muted-foreground px-4 py-2 text-xs"
												style={`padding-left:${34 + row.depth * 18}px`}
											>
												Loading…
											</div>
										{/if}
									{/each}
								</div>
							{/if}
						</div>
					</div>

					<div class="flex min-h-0 flex-col">
						<div class="border-b px-4 py-3">
							<h3 class="font-medium">Details</h3>
							<p class="text-muted-foreground text-sm">
								Select a file or folder to inspect status and metadata
							</p>
						</div>
						<div class="min-h-0 flex-1 overflow-auto px-4 py-4">
							{#if detailsLoading}
								<div class="flex items-center gap-2 text-sm text-muted-foreground">
									<Loader2Icon class="size-4 animate-spin" />
									Loading details…
								</div>
							{:else if !selectedDetails}
								<div class="flex h-full items-center justify-center text-sm text-muted-foreground">
									No item selected
								</div>
							{:else}
								<div class="space-y-4">
									<div>
										<div class="font-medium">{selectedDetails.name}</div>
										<div class="text-muted-foreground mt-1 break-all font-mono text-xs">
											{selectedDetails.path}
										</div>
									</div>

									<div class="grid gap-2 text-sm sm:grid-cols-2">
										<div class="rounded-lg bg-muted/40 p-3">
											<div class="text-muted-foreground text-xs uppercase tracking-[0.12em]">Type</div>
											<div class="mt-1">{selectedDetails.is_dir ? 'Folder' : 'File'}</div>
										</div>
										<div class="rounded-lg bg-muted/40 p-3">
											<div class="text-muted-foreground text-xs uppercase tracking-[0.12em]">Size</div>
											<div class="mt-1">{formatBytes(selectedDetails.size)}</div>
										</div>
										{#if selectedDetails.file_count !== undefined}
											<div class="rounded-lg bg-muted/40 p-3">
												<div class="text-muted-foreground text-xs uppercase tracking-[0.12em]">Files</div>
												<div class="mt-1">{selectedDetails.file_count}</div>
											</div>
										{/if}
										<div class="rounded-lg bg-muted/40 p-3">
											<div class="text-muted-foreground text-xs uppercase tracking-[0.12em]">Modified</div>
											<div class="mt-1">{formatRelativeTime(selectedDetails.last_modified)}</div>
										</div>
									</div>

									<div class="flex flex-wrap gap-2">
										<Badge variant={selectedDetails.is_ignored ? 'outline' : 'secondary'}>
											{selectedDetails.is_ignored ? 'Ignored' : 'Included'}
										</Badge>
										{#if selectedDetails.is_essential}
											<Badge>Required</Badge>
										{/if}
										{#if selectedDetails.is_priority}
											<Badge variant="outline">Priority</Badge>
										{/if}
									</div>

									{#if selectedDetails.ignore_pattern}
										<div class="rounded-lg border p-3 text-sm">
											<div class="font-medium">Ignore rule</div>
											<div class="text-muted-foreground mt-1 break-all font-mono text-xs">
												{selectedDetails.ignore_pattern}
											</div>
										</div>
									{/if}

									{#if selectedDetails.essential_pattern}
										<div class="rounded-lg border p-3 text-sm">
											<div class="font-medium">Required by policy</div>
											<div class="text-muted-foreground mt-1 break-all font-mono text-xs">
												{selectedDetails.essential_pattern}
											</div>
										</div>
									{/if}

									{#if selectedDetails.error}
										<div class="rounded-lg bg-rose-50 p-3 text-sm text-rose-700 dark:bg-rose-950/30 dark:text-rose-300">
											{selectedDetails.error}
										</div>
									{/if}

									{#if selectedDetails.syft_pub_info}
										<div class="rounded-lg border p-3">
											<div class="flex items-center gap-2">
												<LinkIcon class="size-4" />
												<div class="font-medium">Sharing permissions</div>
											</div>
											{#if selectedDetails.syft_pub_info.description}
												<p class="text-muted-foreground mt-2 text-sm">
													{selectedDetails.syft_pub_info.description}
												</p>
											{/if}
											<div class="mt-3 space-y-2">
												{#each selectedDetails.syft_pub_info.permissions as permission}
													<div class="flex items-center justify-between rounded-md bg-muted/40 px-3 py-2 text-sm">
														<span class="truncate font-mono text-xs">{permission.user}</span>
														<Badge variant={permission.is_wildcard ? 'secondary' : 'outline'}>
															{permission.access}
														</Badge>
													</div>
												{/each}
											</div>
										</div>
									{/if}

									{#if selectedDetails.file_content}
										<div class="rounded-lg border">
											<div class="border-b px-3 py-2 text-sm font-medium">
												Preview {selectedDetails.file_type ? `(${selectedDetails.file_type})` : ''}
											</div>
											<pre class="max-h-80 overflow-auto px-3 py-3 text-xs whitespace-pre-wrap break-words">{selectedDetails.file_content}</pre>
										</div>
									{/if}
								</div>
							{/if}
						</div>
					</div>
				</div>
			{:else if activeTab === 'shared'}
				<div class="flex h-full flex-col">
					<div class="flex shrink-0 items-center gap-2 border-b px-4 py-3">
						<div class="relative flex-1">
							<SearchIcon class="text-muted-foreground absolute top-1/2 left-3 size-4 -translate-y-1/2" />
							<input
								class="border-input bg-background w-full rounded-md border py-2 pr-3 pl-9 text-sm outline-none"
								placeholder="Filter shared items"
								bind:value={sharedFilter}
							/>
						</div>
						<Button variant="outline" size="sm" onclick={refreshShared} disabled={sharedRefreshing}>
							<RefreshCwIcon class={`size-4 ${sharedRefreshing ? 'animate-spin' : ''}`} />
						</Button>
					</div>
					<div class="min-h-0 flex-1 overflow-auto">
						{#if filteredSharedItems.length === 0}
							<div class="flex h-full items-center justify-center text-sm text-muted-foreground">
								No shared content discovered
							</div>
						{:else}
							<div class="divide-y">
								{#each filteredSharedItems as item (item.path)}
									<div class="px-4 py-3">
										<div class="flex items-start justify-between gap-3">
											<div class="min-w-0 flex-1">
												<div class="flex items-center gap-2">
													<GlobeIcon class="size-4 shrink-0 text-sky-600" />
													<span class="truncate font-medium">{item.owner}</span>
													<Badge variant="outline">{item.access}</Badge>
													{#if item.is_subscribed}
														<Badge>Subscribed</Badge>
													{/if}
												</div>
												<div class="text-muted-foreground mt-2 break-all font-mono text-xs">
													{item.path}
												</div>
												{#if item.description}
													<div class="text-muted-foreground mt-2 text-sm">{item.description}</div>
												{/if}
											</div>
											<div class="flex shrink-0 items-center gap-2">
												<Button
													variant="outline"
													size="sm"
													onclick={() => loadDetails(item.path)}
												>
													View
												</Button>
												<Button
													variant={item.is_subscribed ? 'secondary' : 'default'}
													size="sm"
													onclick={() => toggleSharedSubscription(item)}
													disabled={subscriptionUpdating === item.path}
												>
													{#if subscriptionUpdating === item.path}
														<Loader2Icon class="size-4 animate-spin" />
													{:else}
														{item.is_subscribed ? 'Unsubscribe' : 'Subscribe'}
													{/if}
												</Button>
											</div>
										</div>
									</div>
								{/each}
							</div>
						{/if}
					</div>
				</div>
			{:else}
				<div class="grid h-full min-h-0 lg:grid-cols-[0.95fr_1.05fr]">
					<div class="min-h-0 overflow-auto border-b px-4 py-4 lg:border-r lg:border-b-0">
						<h3 class="font-medium">Runtime Diagnostics</h3>
						<p class="text-muted-foreground mt-1 text-sm">
							Current client status, latency, and sync policy details
						</p>

						<div class="mt-4 space-y-3 text-sm">
							<div class="rounded-lg border p-3">
								<div class="font-medium">Connectivity</div>
								<div class="mt-2 grid gap-2 sm:grid-cols-2">
									<div>Daemon: {daemonRunning ? 'running' : 'stopped'}</div>
									<div>WebSocket: {wsConnected ? 'connected' : 'disconnected'}</div>
									<div>Status: {queueStatus?.status?.status || '-'}</div>
									<div>Datasite: {queueStatus?.status?.datasite?.status || '-'}</div>
								</div>
							</div>

							<div class="rounded-lg border p-3">
								<div class="font-medium">Secure Data Sharing</div>
								<p class="text-muted-foreground mt-1 text-sm">
									Configure the SyftBox server for secure data sharing.
								</p>
								<div class="mt-3 flex flex-wrap items-center gap-2">
									<span class={`inline-flex items-center rounded-full px-2.5 py-1 text-xs font-medium ${
										isAuthenticated
											? 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-300'
											: 'bg-amber-100 text-amber-800 dark:bg-amber-950/40 dark:text-amber-300'
									}`}>
										Status: {syftboxStatusBadgeText()}
									</span>
								</div>
								<p class="text-muted-foreground mt-3 text-sm">
									View sync status, manage files, and configure sync policies in this panel.
								</p>
								<div class="mt-3 flex flex-wrap gap-2">
									<Button variant={isAuthenticated ? 'outline' : 'default'} size="sm" onclick={openSettings}>
										{isAuthenticated ? 'Reauthenticate' : 'Authenticate'}
									</Button>
									<Button variant="outline" size="sm" onclick={() => (activeTab = 'tree')}>
										Open Sync Tree
									</Button>
									<Button variant="outline" size="sm" onclick={runTurnTest} disabled={turnTesting}>
										{#if turnTesting}
											<Loader2Icon class="mr-1 size-4 animate-spin" />
										{/if}
										Test TURN Connection
									</Button>
								</div>
								<pre class="text-muted-foreground mt-3 overflow-auto whitespace-pre-wrap break-words rounded-md bg-muted/40 p-3 text-xs">{turnTestResult}</pre>

								<div class="mt-4 border-t pt-4">
									<div class="font-medium">Peer Link Test (No Syqure)</div>
									<div class="mt-3 grid gap-2 md:grid-cols-[minmax(0,1fr)_120px_120px_auto]">
										<input
											class="border-input bg-background w-full rounded-md border px-3 py-2 text-sm outline-none"
											placeholder="Peer email (e.g. me@example.com)"
											bind:value={peerEmailInput}
										/>
										<input
											class="border-input bg-background w-full rounded-md border px-3 py-2 text-sm outline-none"
											type="number"
											min="1"
											max="100"
											bind:value={peerRoundsInput}
										/>
										<input
											class="border-input bg-background w-full rounded-md border px-3 py-2 text-sm outline-none"
											type="number"
											min="1"
											max="1024"
											bind:value={peerPayloadKbInput}
										/>
										<Button size="sm" onclick={runPeerLinkTest} disabled={peerTesting}>
											{#if peerTesting}
												<Loader2Icon class="mr-1 size-4 animate-spin" />
											{/if}
											Test Peer Link
										</Button>
									</div>
									<pre class="text-muted-foreground mt-3 overflow-auto whitespace-pre-wrap break-words rounded-md bg-muted/40 p-3 text-xs">{peerTestResult}</pre>
								</div>
							</div>

							<div class="rounded-lg border p-3">
								<div class="font-medium">Paths</div>
								<div class="mt-2 space-y-2 text-xs">
									<div class="break-all font-mono">data_dir: {dataDir || '-'}</div>
									<div class="break-all font-mono">client_url: {clientUrl || '-'}</div>
									<div class="break-all font-mono">log_path: {configInfo.log_path || '-'}</div>
								</div>
							</div>

							<div class="rounded-lg border p-3">
								<div class="font-medium">Latency</div>
								<div class="mt-2 grid gap-2 sm:grid-cols-2">
									<div>Last: {latency?.lastPingMs ? `${latency.lastPingMs} ms` : '-'}</div>
									<div>Avg: {latency?.avgMs ? `${latency.avgMs} ms` : '-'}</div>
									<div>Min: {latency?.minMs ? `${latency.minMs} ms` : '-'}</div>
									<div>Max: {latency?.maxMs ? `${latency.maxMs} ms` : '-'}</div>
								</div>
							</div>

							<div class="rounded-lg border p-3">
								<div class="font-medium">Last errors</div>
								<div class="mt-2 space-y-2 text-xs">
									<div class="break-words">WebSocket: {runtimeSocket?.last_error || '-'}</div>
									<div class="break-words">HTTP: {runtimeHttp?.last_error || '-'}</div>
									<div class="break-words">Daemon: {syftboxState.error || queueStatus?.error || '-'}</div>
								</div>
							</div>

							<div class="rounded-lg border p-3">
								<div class="font-medium">Ignore Patterns</div>
								<div class="text-muted-foreground mt-1 text-xs break-all font-mono">
									{ignorePatterns?.syftignore_path || '-'}
								</div>
								<div class="mt-3 flex flex-wrap gap-2">
									{#if ignorePatterns?.custom_patterns?.length}
										{#each ignorePatterns.custom_patterns as pattern (pattern)}
											<Badge variant="outline" class="max-w-full truncate">{pattern}</Badge>
										{/each}
									{:else}
										<span class="text-muted-foreground text-sm">No custom patterns</span>
									{/if}
								</div>
							</div>
						</div>
					</div>

					<div class="min-h-0 overflow-auto px-4 py-4">
						<div class="flex items-center justify-between">
							<div>
								<h3 class="font-medium">Connection History</h3>
								<p class="text-muted-foreground text-sm">Local panel log of status transitions and refresh failures</p>
							</div>
							<Button variant="outline" size="sm" onclick={() => {
								connectionLog = []
								localStorage.removeItem(CONNECTION_LOG_STORAGE_KEY)
							}}>
								Clear
							</Button>
						</div>

						<div class="mt-4 rounded-lg border">
							{#if connectionLog.length === 0}
								<div class="px-4 py-8 text-center text-sm text-muted-foreground">
									No connection events yet
								</div>
							{:else}
								<div class="divide-y">
									{#each connectionLog as entry (`${entry.timestamp}-${entry.type}-${entry.status}`)}
										<div class="px-4 py-3 text-sm">
											<div class="flex items-start justify-between gap-3">
												<div class="min-w-0">
													<div class="flex items-center gap-2">
														<Badge variant="outline">{entry.type}</Badge>
														<span class="font-medium">{entry.status}</span>
													</div>
													<div class="text-muted-foreground mt-1">{entry.message}</div>
												</div>
												<div class="shrink-0 text-xs text-muted-foreground">
													{formatAbsoluteTime(entry.timestamp)}
												</div>
											</div>
										</div>
									{/each}
								</div>
							{/if}
						</div>
					</div>
				</div>
			{/if}
		</div>
	{/if}
</div>
