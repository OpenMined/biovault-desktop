<script lang="ts">
	import { invoke } from '@tauri-apps/api/core'
	import { onMount, onDestroy } from 'svelte'
	import { Button } from '$lib/components/ui/button/index.js'
	import { Badge } from '$lib/components/ui/badge/index.js'
	import { Separator } from '$lib/components/ui/separator/index.js'
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

	interface Props {
		mode?: 'sheet' | 'page'
	}

	let { mode = 'sheet' }: Props = $props()

	// State
	let loading = $state(true)
	let refreshing = $state(false)
	let daemonRunning = $state(false)
	let wsConnected = $state(false)
	let serverUrl = $state('')
	let email = $state('')
	let clientUrl = $state('')
	let pid = $state<number | null>(null)
	let txBytes = $state(0)
	let rxBytes = $state(0)
	let dataDir = $state('')

	// Queue summary
	let queueSummary = $state({
		pending: 0,
		syncing: 0,
		completed: 0,
		error: 0
	})

	// Activity log
	interface ActivityEntry {
		path: string
		state: string
		progress?: number
		size?: number
		timestamp: string
	}
	let activityLog = $state<ActivityEntry[]>([])
	const MAX_ACTIVITY_ENTRIES = 50

	let refreshInterval: ReturnType<typeof setInterval> | null = null

	function formatBytes(bytes: number): string {
		if (!bytes || bytes === 0) return '0 B'
		const k = 1024
		const sizes = ['B', 'KB', 'MB', 'GB']
		const i = Math.floor(Math.log(bytes) / Math.log(k))
		return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i]
	}

	function formatRelativeTime(isoString: string): string {
		if (!isoString) return '-'
		const date = new Date(isoString)
		const now = new Date()
		const diffMs = now.getTime() - date.getTime()
		const diffSec = Math.floor(diffMs / 1000)
		const diffMin = Math.floor(diffSec / 60)

		if (diffSec < 60) return 'just now'
		if (diffMin < 60) return `${diffMin}m ago`
		return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
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
				return AlertCircleIcon
			default:
				return CheckCircleIcon
		}
	}

	function getStateColor(state: string): string {
		switch (state) {
			case 'completed':
				return 'text-green-500'
			case 'syncing':
			case 'uploading':
			case 'downloading':
				return 'text-blue-500'
			case 'pending':
				return 'text-yellow-500'
			case 'error':
				return 'text-red-500'
			default:
				return 'text-muted-foreground'
		}
	}

	async function refreshStatus() {
		refreshing = true
		try {
			const configInfo = await invoke<{
				is_authenticated?: boolean
				server_url?: string
				email?: string
				data_dir?: string
				config_path?: string
			}>('get_syftbox_config_info').catch(() => ({
				is_authenticated: false,
				server_url: '',
				email: '',
				data_dir: '',
				config_path: ''
			}))

			const syftboxState = await invoke<{
				running?: boolean
				mode?: string
				backend?: string
				client_url?: string
				pid?: number
				tx_bytes?: number
				rx_bytes?: number
			}>('get_syftbox_state').catch(() => ({
				running: false,
				mode: '',
				backend: '',
				client_url: '',
				pid: undefined,
				tx_bytes: 0,
				rx_bytes: 0
			}))

			daemonRunning = syftboxState.running || false
			serverUrl = configInfo.server_url || ''
			email = configInfo.email || ''
			clientUrl = syftboxState.client_url || ''
			pid = syftboxState.pid || null
			txBytes = syftboxState.tx_bytes || 0
			rxBytes = syftboxState.rx_bytes || 0
			dataDir = configInfo.data_dir || ''

			// Get queue status
			const queueStatus = await invoke<{
				sync?: {
					summary?: {
						pending?: number
						syncing?: number
						completed?: number
						error?: number
					}
					files?: Array<{
						path: string
						state: string
						progress?: number
						size?: number
						updated_at?: string
					}>
				}
				status?: {
					runtime?: {
						websocket?: {
							connected?: boolean
						}
					}
				}
			}>('syftbox_queue_status').catch(() => null)

			if (queueStatus?.sync?.summary) {
				queueSummary = {
					pending: queueStatus.sync.summary.pending || 0,
					syncing: queueStatus.sync.summary.syncing || 0,
					completed: queueStatus.sync.summary.completed || 0,
					error: queueStatus.sync.summary.error || 0
				}
			}

			// Update WebSocket status
			const ws = queueStatus?.status?.runtime?.websocket
			if (ws) {
				wsConnected = ws.connected === true
			} else if (queueStatus && daemonRunning) {
				// If we got a response, assume connected
				wsConnected = true
			}

			// Update activity log from sync files
			if (queueStatus?.sync?.files) {
				const newEntries = queueStatus.sync.files
					.filter((f) => !f.path.endsWith('/'))
					.map((f) => ({
						path: f.path.replace(/^.*?datasites\//, ''),
						state: f.state,
						progress: f.progress,
						size: f.size,
						timestamp: f.updated_at || new Date().toISOString()
					}))
					.slice(0, MAX_ACTIVITY_ENTRIES)

				// Merge with existing, keeping recent ones
				const pathSet = new Set(newEntries.map((e) => e.path))
				const existingKept = activityLog.filter((e) => !pathSet.has(e.path)).slice(0, 20)
				activityLog = [...newEntries, ...existingKept].slice(0, MAX_ACTIVITY_ENTRIES)
			}
		} catch (e) {
			console.error('Failed to refresh SyftBox status:', e)
		} finally {
			loading = false
			refreshing = false
		}
	}

	async function openDataFolder() {
		if (!dataDir) return
		try {
			await invoke('open_folder', { path: `${dataDir}/datasites` })
		} catch (e) {
			console.error('Failed to open folder:', e)
		}
	}

	onMount(() => {
		refreshStatus()
		refreshInterval = setInterval(refreshStatus, 3000)
	})

	onDestroy(() => {
		if (refreshInterval) {
			clearInterval(refreshInterval)
		}
	})
</script>

<div class="flex h-full flex-col gap-4">
	<!-- Header -->
	<div class="flex items-center justify-between shrink-0">
		<div class="flex items-center gap-3">
			<div class="flex size-10 items-center justify-center rounded-lg bg-muted">
				<FolderSyncIcon class="size-5" />
			</div>
			<div>
				<h2 class="text-lg font-semibold">SyftBox Sync</h2>
				<p class="text-muted-foreground text-sm">File synchronization status</p>
			</div>
		</div>
		<div class="flex items-center gap-2">
			<Button variant="outline" size="sm" onclick={refreshStatus} disabled={refreshing}>
				<RefreshCwIcon class="size-4 {refreshing ? 'animate-spin' : ''}" />
			</Button>
			{#if dataDir}
				<Button variant="outline" size="sm" onclick={openDataFolder}>
					<FolderOpenIcon class="size-4" />
				</Button>
			{/if}
		</div>
	</div>

	{#if loading}
		<div class="flex-1 flex items-center justify-center">
			<Loader2Icon class="size-8 animate-spin text-muted-foreground" />
		</div>
	{:else}
		<!-- Connection Status -->
		<div class="rounded-lg border p-3">
			<div class="flex items-center justify-between">
				<div class="flex items-center gap-2">
					{#if daemonRunning && wsConnected}
						<WifiIcon class="size-4 text-green-500" />
						<span class="text-sm font-medium text-green-600">Connected</span>
					{:else if daemonRunning}
						<WifiIcon class="size-4 text-yellow-500" />
						<span class="text-sm font-medium text-yellow-600">Connecting...</span>
					{:else}
						<WifiOffIcon class="size-4 text-muted-foreground" />
						<span class="text-sm font-medium text-muted-foreground">Offline</span>
					{/if}
				</div>
				{#if daemonRunning && pid}
					<Badge variant="secondary" class="text-xs">PID: {pid}</Badge>
				{/if}
			</div>
			<p class="text-xs text-muted-foreground truncate mt-1">{serverUrl || 'Not configured'}</p>
		</div>

		<!-- Transfer Stats -->
		<div class="flex items-center gap-4 text-sm">
			<div class="flex items-center gap-1.5">
				<UploadIcon class="size-3.5 text-muted-foreground" />
				<span class="text-muted-foreground">TX:</span>
				<span class="font-mono">{formatBytes(txBytes)}</span>
			</div>
			<div class="flex items-center gap-1.5">
				<DownloadIcon class="size-3.5 text-muted-foreground" />
				<span class="text-muted-foreground">RX:</span>
				<span class="font-mono">{formatBytes(rxBytes)}</span>
			</div>
		</div>

		<!-- Queue Summary -->
		<div class="flex items-center gap-2 flex-wrap">
			{#if queueSummary.syncing > 0}
				<Badge variant="default" class="gap-1">
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
				<Badge variant="outline" class="gap-1 text-green-600">
					<CheckCircleIcon class="size-3" />
					{queueSummary.completed} done
				</Badge>
			{/if}
			{#if queueSummary.error > 0}
				<Badge variant="destructive" class="gap-1">
					<AlertCircleIcon class="size-3" />
					{queueSummary.error} errors
				</Badge>
			{/if}
			{#if queueSummary.syncing === 0 && queueSummary.pending === 0 && queueSummary.completed === 0 && queueSummary.error === 0}
				<span class="text-sm text-muted-foreground">No recent activity</span>
			{/if}
		</div>

		<Separator />

		<!-- Activity Log -->
		<div class="flex-1 min-h-0 flex flex-col">
			<div class="flex items-center justify-between mb-2">
				<h3 class="text-sm font-medium">Recent Activity</h3>
				<span class="text-xs text-muted-foreground">{activityLog.length} items</span>
			</div>

			<div class="flex-1 min-h-0 rounded-lg border overflow-hidden">
				{#if activityLog.length === 0}
					<div class="flex items-center justify-center h-full text-muted-foreground text-sm">
						No recent sync activity
					</div>
				{:else}
					<div class="h-full overflow-auto">
						<div class="divide-y">
							{#each activityLog as entry (entry.path + entry.timestamp)}
								{@const StateIcon = getStateIcon(entry.state)}
								<div class="px-3 py-2 text-sm hover:bg-muted/50">
									<div class="flex items-center gap-2">
										<StateIcon
											class="size-3.5 shrink-0 {getStateColor(entry.state)} {entry.state ===
												'syncing' || entry.state === 'uploading'
												? 'animate-spin'
												: ''}"
										/>
										<span class="truncate flex-1 font-mono text-xs">{entry.path}</span>
										{#if entry.size}
											<span class="text-xs text-muted-foreground shrink-0">
												{formatBytes(entry.size)}
											</span>
										{/if}
									</div>
									<div class="flex items-center justify-between mt-0.5 pl-5">
										<span class="text-xs text-muted-foreground capitalize">{entry.state}</span>
										<span class="text-xs text-muted-foreground">
											{formatRelativeTime(entry.timestamp)}
										</span>
									</div>
								</div>
							{/each}
						</div>
					</div>
				{/if}
			</div>
		</div>
	{/if}
</div>
