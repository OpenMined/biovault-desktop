<script lang="ts">
	import { invoke } from '@tauri-apps/api/core'
	import { onMount } from 'svelte'
	import { Button } from '$lib/components/ui/button/index.js'
	import { Badge } from '$lib/components/ui/badge/index.js'
	import RefreshCwIcon from '@lucide/svelte/icons/refresh-cw'
	import TrashIcon from '@lucide/svelte/icons/trash-2'
	import DownloadIcon from '@lucide/svelte/icons/download'
	import FolderOpenIcon from '@lucide/svelte/icons/folder-open'
	import SquareTerminalIcon from '@lucide/svelte/icons/square-terminal'

	interface Props {
		mode?: 'sheet' | 'page'
	}

	let { mode = 'sheet' }: Props = $props()

	let logText = $state('')
	let loading = $state(true)
	let error = $state<string | null>(null)
	let autoScroll = $state(true)
	let logContainer: HTMLPreElement | null = $state(null)

	async function loadLogs() {
		try {
			loading = true
			error = null
			// Get last 50KB of logs
			logText = await invoke<string>('get_desktop_log_text', { maxBytes: 50000 })
		} catch (e) {
			error = e instanceof Error ? e.message : String(e)
		} finally {
			loading = false
		}
	}

	async function clearLogs() {
		try {
			await invoke('clear_desktop_log')
			logText = ''
		} catch (e) {
			console.error('Failed to clear logs:', e)
		}
	}

	async function openLogFolder() {
		try {
			const logDir = await invoke<string>('get_desktop_log_dir')
			await invoke('show_in_folder', { path: logDir })
		} catch (e) {
			console.error('Failed to open log folder:', e)
		}
	}

	async function downloadLogs() {
		try {
			const fullLogs = await invoke<string>('get_desktop_log_text', { maxBytes: 10000000 })
			const blob = new Blob([fullLogs], { type: 'text/plain' })
			const url = URL.createObjectURL(blob)
			const a = document.createElement('a')
			a.href = url
			a.download = `biovault-logs-${new Date().toISOString().split('T')[0]}.txt`
			document.body.appendChild(a)
			a.click()
			document.body.removeChild(a)
			URL.revokeObjectURL(url)
		} catch (e) {
			console.error('Failed to download logs:', e)
		}
	}

	// Auto-scroll to bottom when logs change
	$effect(() => {
		if (autoScroll && logContainer && logText) {
			logContainer.scrollTop = logContainer.scrollHeight
		}
	})

	onMount(() => {
		loadLogs()
		// Auto-refresh every 2 seconds
		const interval = setInterval(loadLogs, 2000)
		return () => clearInterval(interval)
	})

	// Parse log text into lines with coloring
	let logLines = $derived(logText.split('\n').filter((line) => line.trim()))

	function getLineClass(line: string): string {
		if (line.includes('ERROR') || line.includes('❌') || line.includes('Failed')) {
			return 'text-red-400'
		}
		if (line.includes('WARN') || line.includes('⚠️')) {
			return 'text-yellow-400'
		}
		if (line.includes('✅') || line.includes('SUCCESS') || line.includes('Completed')) {
			return 'text-green-400'
		}
		if (line.includes('🔧') || line.includes('🔍') || line.includes('📂')) {
			return 'text-blue-400'
		}
		return 'text-gray-300'
	}
</script>

<div class="flex h-full flex-col gap-4">
	<!-- Header -->
	<div class="flex items-center justify-between shrink-0">
		<div class="flex items-center gap-3">
			<div class="flex size-10 items-center justify-center rounded-lg bg-muted">
				<SquareTerminalIcon class="size-5" />
			</div>
			<div>
				<h2 class="text-lg font-semibold">Application Logs</h2>
				<p class="text-muted-foreground text-sm">Real-time log output from BioVault</p>
			</div>
		</div>
		<div class="flex items-center gap-2">
			<Button variant="outline" size="sm" onclick={loadLogs} disabled={loading}>
				<RefreshCwIcon class="size-4 {loading ? 'animate-spin' : ''}" />
			</Button>
			<Button variant="outline" size="sm" onclick={openLogFolder}>
				<FolderOpenIcon class="size-4" />
			</Button>
			<Button variant="outline" size="sm" onclick={downloadLogs}>
				<DownloadIcon class="size-4" />
			</Button>
			<Button variant="outline" size="sm" onclick={clearLogs}>
				<TrashIcon class="size-4" />
			</Button>
		</div>
	</div>

	<!-- Status bar -->
	<div class="flex items-center gap-3 text-sm">
		<Badge variant="outline" class="font-mono">
			{logLines.length} lines
		</Badge>
		<label class="flex items-center gap-2 text-muted-foreground">
			<input type="checkbox" bind:checked={autoScroll} class="rounded" />
			Auto-scroll
		</label>
	</div>

	<!-- Log viewer -->
	<div class="flex-1 min-h-0 rounded-lg border bg-[#1e1e1e] overflow-hidden">
		{#if error}
			<div class="p-4 text-red-400">Error loading logs: {error}</div>
		{:else if logLines.length === 0}
			<div class="p-4 text-gray-500">No logs yet...</div>
		{:else}
			<pre
				bind:this={logContainer}
				class="h-full overflow-auto p-4 font-mono text-xs leading-relaxed"
			>{#each logLines as line, i}<span class={getLineClass(line)}>{line}</span>
{/each}</pre>
		{/if}
	</div>
</div>
