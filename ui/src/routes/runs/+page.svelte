<script lang="ts">
	import { goto } from '$app/navigation'
	import { invoke } from '@tauri-apps/api/core'
	import { confirm } from '@tauri-apps/plugin-dialog'
	import { onMount } from 'svelte'
	import PageHeader from '$lib/components/page-header.svelte'
	import * as Empty from '$lib/components/ui/empty/index.js'
	import { Button } from '$lib/components/ui/button/index.js'
	import { Badge } from '$lib/components/ui/badge/index.js'
	import * as DropdownMenu from '$lib/components/ui/dropdown-menu/index.js'
	import PlayCircleIcon from '@lucide/svelte/icons/play-circle'
	import RefreshCwIcon from '@lucide/svelte/icons/refresh-cw'
	import CheckCircleIcon from '@lucide/svelte/icons/check-circle'
	import XCircleIcon from '@lucide/svelte/icons/x-circle'
	import LoaderIcon from '@lucide/svelte/icons/loader'
	import ClockIcon from '@lucide/svelte/icons/clock'
	import FolderOpenIcon from '@lucide/svelte/icons/folder-open'
	import TrashIcon from '@lucide/svelte/icons/trash-2'
	import MoreVerticalIcon from '@lucide/svelte/icons/more-vertical'
	import WorkflowIcon from '@lucide/svelte/icons/workflow'
	import PauseIcon from '@lucide/svelte/icons/pause'
	import PlayIcon from '@lucide/svelte/icons/play'
	import RotateCcwIcon from '@lucide/svelte/icons/rotate-ccw'
	import ChevronDownIcon from '@lucide/svelte/icons/chevron-down'
	import ChevronRightIcon from '@lucide/svelte/icons/chevron-right'
	import TerminalSquareIcon from '@lucide/svelte/icons/terminal-square'
	import HardDriveIcon from '@lucide/svelte/icons/hard-drive'
	import ActivityIcon from '@lucide/svelte/icons/activity'

	interface RunRecord {
		id: number
		flow_id?: number | null
		module_id?: number | null
		status: string
		work_dir: string
		results_dir?: string | null
		participant_count?: number | null
		metadata?: string | null
		created_at: string
		completed_at?: string | null
	}

	interface FlowRecord {
		id: number
		name: string
		flow_path: string
	}

	interface FlowState {
		completed?: number
		total?: number
		concurrency?: number | null
		container_count?: number
		last_updated?: string | null
		status?: string | null
		nextflow_command?: string | null
	}

	type RunAction = 'pause' | 'resume' | 'retry' | 'delete' | null

	let runs = $state<RunRecord[]>([])
	let loading = $state(true)
	let refreshing = $state(false)
	let error: string | null = $state(null)
	let flowNames = $state<Record<number, string>>({})
	let expandedRunIds = $state<number[]>([])
	let runLogs = $state<Record<number, string>>({})
	let runStates = $state<Record<number, FlowState | null>>({})
	let pendingActions = $state<Record<number, RunAction>>({})
	let logsLoading = $state<Record<number, boolean>>({})
	let stateLoading = $state<Record<number, boolean>>({})

	function sortRuns(items: RunRecord[]): RunRecord[] {
		return [...items].sort(
			(a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime(),
		)
	}

	function parseMetadata(run: RunRecord): Record<string, unknown> {
		if (!run.metadata) return {}
		try {
			const parsed = JSON.parse(run.metadata)
			return parsed && typeof parsed === 'object' ? parsed : {}
		} catch {
			return {}
		}
	}

	function getFlowName(run: RunRecord): string {
		if (run.flow_id && flowNames[run.flow_id]) return flowNames[run.flow_id]
		return run.module_id ? `Module Run #${run.id}` : `Run #${run.id}`
	}

	function getRunTitle(run: RunRecord): string {
		const metadata = parseMetadata(run)
		const selection =
			metadata.data_selection && typeof metadata.data_selection === 'object'
				? (metadata.data_selection as Record<string, unknown>)
				: {}
		const parts: string[] = []

		if (metadata.type === 'multiparty') parts.push('Multiparty')
		parts.push(getFlowName(run))

		if (typeof metadata.my_role === 'string' && metadata.my_role) {
			parts.push(`(${metadata.my_role})`)
		}
		if (typeof selection.dataset_name === 'string' && selection.dataset_name) {
			parts.push(selection.dataset_name)
		}
		if (Array.isArray(selection.asset_keys) && selection.asset_keys.length > 0) {
			parts.push(selection.asset_keys.join(', '))
		}

		return parts.join(' ')
	}

	function formatTimestamp(dateStr: string): string {
		const date = new Date(dateStr)
		const now = new Date()
		const diffMs = now.getTime() - date.getTime()
		const diffMins = Math.floor(diffMs / 60000)
		const diffHours = Math.floor(diffMs / 3600000)
		const diffDays = Math.floor(diffMs / 86400000)

		if (diffMins < 1) return 'Just now'
		if (diffMins < 60) return `${diffMins}m ago`
		if (diffHours < 24) return `${diffHours}h ago`
		if (diffDays < 7) return `${diffDays}d ago`

		return date.toLocaleDateString(undefined, {
			month: 'short',
			day: 'numeric',
			hour: '2-digit',
			minute: '2-digit',
		})
	}

	function formatDuration(run: RunRecord): string {
		const start = new Date(run.created_at).getTime()
		const end =
			run.status.toLowerCase() === 'running'
				? Date.now()
				: run.completed_at
					? new Date(run.completed_at).getTime()
					: Date.now()
		const totalSeconds = Math.max(0, Math.floor((end - start) / 1000))
		const hours = Math.floor(totalSeconds / 3600)
		const minutes = Math.floor((totalSeconds % 3600) / 60)
		const seconds = totalSeconds % 60
		if (hours > 0) return `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
		return `${minutes}:${String(seconds).padStart(2, '0')}`
	}

	function getStatusInfo(status: string) {
		switch (status.toLowerCase()) {
			case 'completed':
			case 'success':
				return {
					variant: 'default' as const,
					icon: CheckCircleIcon,
					label: 'Completed',
					bgColor: 'bg-green-500',
				}
			case 'failed':
			case 'error':
				return {
					variant: 'destructive' as const,
					icon: XCircleIcon,
					label: 'Failed',
					bgColor: 'bg-red-500',
				}
			case 'paused':
				return {
					variant: 'outline' as const,
					icon: PauseIcon,
					label: 'Paused',
					bgColor: 'bg-amber-500',
				}
			case 'running':
				return {
					variant: 'secondary' as const,
					icon: LoaderIcon,
					label: 'Running',
					bgColor: 'bg-blue-500',
					animate: true,
				}
			case 'pending':
				return {
					variant: 'outline' as const,
					icon: ClockIcon,
					label: 'Pending',
					bgColor: 'bg-yellow-500',
				}
			default:
				return {
					variant: 'outline' as const,
					icon: ClockIcon,
					label: status,
					bgColor: 'bg-muted',
				}
		}
	}

	function isExpanded(runId: number): boolean {
		return expandedRunIds.includes(runId)
	}

	function setPending(runId: number, action: RunAction) {
		pendingActions = { ...pendingActions, [runId]: action }
	}

	function clearPending(runId: number) {
		const next = { ...pendingActions }
		delete next[runId]
		pendingActions = next
	}

	function isActionPending(runId: number, action?: RunAction): boolean {
		return action ? pendingActions[runId] === action : !!pendingActions[runId]
	}

	async function loadRunState(runId: number) {
		stateLoading = { ...stateLoading, [runId]: true }
		try {
			runStates = {
				...runStates,
				[runId]: await invoke<FlowState | null>('get_flow_state', { runId }),
			}
		} catch {
			runStates = { ...runStates, [runId]: null }
		} finally {
			stateLoading = { ...stateLoading, [runId]: false }
		}
	}

	async function loadRunLogs(runId: number, lines = 200) {
		logsLoading = { ...logsLoading, [runId]: true }
		try {
			runLogs = {
				...runLogs,
				[runId]: await invoke<string>('get_flow_run_logs_tail', { runId, lines }),
			}
		} catch (e) {
			runLogs = {
				...runLogs,
				[runId]: e instanceof Error ? e.message : String(e),
			}
		} finally {
			logsLoading = { ...logsLoading, [runId]: false }
		}
	}

	async function expandRun(runId: number) {
		if (!isExpanded(runId)) {
			expandedRunIds = [...expandedRunIds, runId]
		}
		await Promise.all([loadRunState(runId), loadRunLogs(runId)])
	}

	async function toggleRun(runId: number) {
		if (isExpanded(runId)) {
			expandedRunIds = expandedRunIds.filter((id) => id !== runId)
			return
		}
		await expandRun(runId)
	}

	async function loadRuns(showSpinner = true) {
		if (showSpinner) loading = true
		else refreshing = true

		try {
			error = null
			await invoke('reconcile_flow_runs').catch(() => {})

			const [runRows, flows] = await Promise.all([
				invoke<RunRecord[]>('get_flow_runs'),
				invoke<FlowRecord[]>('get_flows').catch(() => []),
			])

			runs = sortRuns(runRows || [])
			flowNames = Object.fromEntries((flows || []).map((flow) => [flow.id, flow.name]))

			if (runs.length > 0 && expandedRunIds.length === 0) {
				const autoExpand = runs.find((run) => run.status.toLowerCase() === 'running') || runs[0]
				if (autoExpand) {
					await expandRun(autoExpand.id)
				}
			} else {
				const existing = new Set(runs.map((run) => run.id))
				expandedRunIds = expandedRunIds.filter((id) => existing.has(id))
				await Promise.all(
					expandedRunIds.map(async (runId) => {
						await Promise.all([loadRunState(runId), loadRunLogs(runId, 120)])
					}),
				)
			}
		} catch (e) {
			error = e instanceof Error ? e.message : String(e)
		} finally {
			loading = false
			refreshing = false
		}
	}

	onMount(() => {
		loadRuns()
		const interval = setInterval(() => {
			void loadRuns(false)
		}, 5000)
		return () => clearInterval(interval)
	})

	async function deleteRun(run: RunRecord) {
		const confirmed = await confirm(
			`Delete ${getFlowName(run)} (Run #${run.id}) and all its results? This cannot be undone.`,
			{ title: 'Delete Run', kind: 'warning' },
		)
		if (!confirmed) return

		setPending(run.id, 'delete')
		try {
			await invoke('delete_flow_run', { runId: run.id })
			runs = runs.filter((item) => item.id !== run.id)
			expandedRunIds = expandedRunIds.filter((id) => id !== run.id)
		} finally {
			clearPending(run.id)
		}
	}

	async function openResultsFolder(run: RunRecord) {
		const path = run.results_dir || run.work_dir
		if (!path) return
		await invoke('open_folder', { path })
	}

	async function openWorkFolder(run: RunRecord) {
		const path = await invoke<string>('get_flow_run_work_dir', { runId: run.id })
		if (path) {
			await invoke('open_folder', { path })
		}
	}

	function flowUrl(run: RunRecord): string | null {
		const flowName = getFlowName(run)
		if (!run.flow_id || !flowName) return null
		return `/flows/${encodeURIComponent(flowName)}`
	}

	async function pauseRun(run: RunRecord) {
		setPending(run.id, 'pause')
		try {
			await invoke('pause_flow_run', { runId: run.id })
			await loadRuns(false)
		} finally {
			clearPending(run.id)
		}
	}

	async function resumeRun(run: RunRecord, forceRemoveLock = false) {
		setPending(run.id, 'resume')
		try {
			await invoke('resume_flow_run', {
				runId: run.id,
				nextflowMaxForks: null,
				forceRemoveLock,
			})
			await loadRuns(false)
		} catch (e) {
			const message = e instanceof Error ? e.message : String(e)
			if (
				!forceRemoveLock &&
				(message.includes('NEXTFLOW_LOCKS_REMAIN') || message.includes('NEXTFLOW_CACHE_CORRUPTED'))
			) {
				const confirmed = await confirm(
					'Nextflow resume state looks stale or corrupted. Force clear locks/cache and resume anyway?',
					{ title: 'Resume Run', kind: 'warning' },
				)
				if (confirmed) {
					await resumeRun(run, true)
				}
				return
			}
			throw e
		} finally {
			clearPending(run.id)
		}
	}

	async function retryRun(run: RunRecord) {
		setPending(run.id, 'retry')
		try {
			await invoke('resume_flow_run', {
				runId: run.id,
				nextflowMaxForks: null,
				forceRemoveLock: false,
			})
			await loadRuns(false)
		} catch (e) {
			const message = e instanceof Error ? e.message : String(e)
			if (message.includes('NEXTFLOW_LOCKS_REMAIN') || message.includes('NEXTFLOW_CACHE_CORRUPTED')) {
				const confirmed = await confirm(
					'Nextflow retry state looks stale or corrupted. Force clear locks/cache and retry anyway?',
					{ title: 'Retry Run', kind: 'warning' },
				)
				if (confirmed) {
					await invoke('resume_flow_run', {
						runId: run.id,
						nextflowMaxForks: null,
						forceRemoveLock: true,
					})
					await loadRuns(false)
				}
				return
			}
			throw e
		} finally {
			clearPending(run.id)
		}
	}

	function progressPercent(runId: number): number {
		const state = runStates[runId]
		if (!state?.total || state.total <= 0) return 0
		return Math.max(0, Math.min(100, Math.round(((state.completed || 0) / state.total) * 100)))
	}

	const runningCount = $derived(runs.filter((r) => r.status.toLowerCase() === 'running').length)
	const pausedCount = $derived(runs.filter((r) => r.status.toLowerCase() === 'paused').length)
	const completedCount = $derived(
		runs.filter((r) => ['completed', 'success'].includes(r.status.toLowerCase())).length,
	)
	const failedCount = $derived(
		runs.filter((r) => ['failed', 'error'].includes(r.status.toLowerCase())).length,
	)
</script>

<div class="flex h-full flex-col">
	<PageHeader title="Runs" description="Flow execution history, status, and logs">
		<Button size="sm" variant="outline" onclick={() => loadRuns(false)} disabled={loading || refreshing}>
			<RefreshCwIcon class="size-4 {loading || refreshing ? 'animate-spin' : ''}" />
			Refresh
		</Button>
	</PageHeader>

	<div class="flex-1 overflow-auto p-6">
		{#if loading && runs.length === 0}
			<div class="flex h-full items-center justify-center">
				<LoaderIcon class="size-6 animate-spin text-muted-foreground" />
			</div>
		{:else if error}
			<div class="flex h-full items-center justify-center">
				<p class="text-destructive">Error: {error}</p>
			</div>
		{:else if runs.length === 0}
			<div class="flex h-full items-center justify-center">
				<Empty.Root>
					<Empty.Header>
						<Empty.Media variant="icon">
							<PlayCircleIcon class="size-6" />
						</Empty.Media>
						<Empty.Title>No Runs Yet</Empty.Title>
						<Empty.Description>
							Run a flow on your datasets to see executions here.
						</Empty.Description>
					</Empty.Header>
					<Empty.Content>
						<Button onclick={() => goto('/flows')}>
							<WorkflowIcon class="size-4" />
							Go to Flows
						</Button>
					</Empty.Content>
				</Empty.Root>
			</div>
		{:else}
			<div class="mb-6 flex flex-wrap gap-4 text-sm">
				{#if runningCount > 0}
					<div class="flex items-center gap-2">
						<div class="size-2 rounded-full bg-blue-500 animate-pulse"></div>
						<span class="text-muted-foreground">{runningCount} running</span>
					</div>
				{/if}
				{#if pausedCount > 0}
					<div class="flex items-center gap-2">
						<div class="size-2 rounded-full bg-amber-500"></div>
						<span class="text-muted-foreground">{pausedCount} paused</span>
					</div>
				{/if}
				{#if completedCount > 0}
					<div class="flex items-center gap-2">
						<div class="size-2 rounded-full bg-green-500"></div>
						<span class="text-muted-foreground">{completedCount} completed</span>
					</div>
				{/if}
				{#if failedCount > 0}
					<div class="flex items-center gap-2">
						<div class="size-2 rounded-full bg-red-500"></div>
						<span class="text-muted-foreground">{failedCount} failed</span>
					</div>
				{/if}
			</div>

			<div class="space-y-4">
				{#each runs as run (run.id)}
					{@const statusInfo = getStatusInfo(run.status)}
					{@const StatusIcon = statusInfo.icon}
					{@const metadata = parseMetadata(run)}
					{@const state = runStates[run.id]}
					<div class="overflow-hidden rounded-xl border bg-card">
						<div
							role="button"
							tabindex="0"
							class="flex w-full items-center gap-4 p-4 text-left transition-colors hover:bg-muted/40"
							onclick={() => toggleRun(run.id)}
							onkeydown={(e) => {
								if (e.key === 'Enter' || e.key === ' ') {
									e.preventDefault()
									void toggleRun(run.id)
								}
							}}
						>
							<div class="text-muted-foreground shrink-0">
								{#if isExpanded(run.id)}
									<ChevronDownIcon class="size-4" />
								{:else}
									<ChevronRightIcon class="size-4" />
								{/if}
							</div>

							<div class="flex size-10 shrink-0 items-center justify-center rounded-lg {statusInfo.bgColor} text-white">
								<StatusIcon class="size-5 {statusInfo.animate ? 'animate-spin' : ''}" />
							</div>

							<div class="min-w-0 flex-1">
								<div class="flex flex-wrap items-center gap-2">
									<h3 class="truncate font-semibold">{getRunTitle(run)}</h3>
									<Badge variant={statusInfo.variant} class="text-xs">{statusInfo.label}</Badge>
									{#if metadata.type === 'multiparty'}
										<Badge variant="outline" class="text-xs">Multiparty</Badge>
									{/if}
								</div>
								<p class="text-muted-foreground mt-0.5 text-sm">
									Run #{run.id} • {formatTimestamp(run.created_at)} • {formatDuration(run)}
									{#if run.participant_count}
										• {run.participant_count} participants
									{/if}
								</p>
								{#if state?.total && state.total > 0}
									<div class="mt-2 flex items-center gap-3">
										<div class="bg-muted h-1.5 flex-1 overflow-hidden rounded-full">
											<div
												class="h-full bg-primary transition-all"
												style={`width: ${progressPercent(run.id)}%`}
											></div>
										</div>
										<span class="text-muted-foreground text-xs">
											{state.completed || 0}/{state.total}
										</span>
									</div>
								{/if}
							</div>

							<div class="flex items-center gap-2" onclick={(e) => e.stopPropagation()}>
								{#if flowUrl(run)}
									<Button variant="ghost" size="sm" onclick={() => goto(flowUrl(run)!)}>
										View Flow
									</Button>
								{/if}
								{#if run.status.toLowerCase() === 'running'}
									<Button
										variant="outline"
										size="sm"
										onclick={() => pauseRun(run)}
										disabled={isActionPending(run.id)}
									>
										<PauseIcon class="size-4" />
										{isActionPending(run.id, 'pause') ? 'Pausing...' : 'Pause'}
									</Button>
								{:else if run.status.toLowerCase() === 'paused'}
									<Button
										variant="outline"
										size="sm"
										onclick={() => resumeRun(run)}
										disabled={isActionPending(run.id)}
									>
										<PlayIcon class="size-4" />
										{isActionPending(run.id, 'resume') ? 'Resuming...' : 'Resume'}
									</Button>
								{:else if ['failed', 'error'].includes(run.status.toLowerCase())}
									<Button
										variant="outline"
										size="sm"
										onclick={() => retryRun(run)}
										disabled={isActionPending(run.id)}
									>
										<RotateCcwIcon class="size-4" />
										{isActionPending(run.id, 'retry') ? 'Retrying...' : 'Retry'}
									</Button>
								{/if}
								<DropdownMenu.Root>
									<DropdownMenu.Trigger>
										{#snippet child({ props })}
											<Button {...props} variant="ghost" size="icon" class="size-8">
												<MoreVerticalIcon class="size-4" />
											</Button>
										{/snippet}
									</DropdownMenu.Trigger>
									<DropdownMenu.Content align="end">
										<DropdownMenu.Item onclick={() => openResultsFolder(run)}>
											<FolderOpenIcon class="size-4" />
											Open Results Folder
										</DropdownMenu.Item>
										<DropdownMenu.Item onclick={() => openWorkFolder(run)}>
											<HardDriveIcon class="size-4" />
											Open Work Folder
										</DropdownMenu.Item>
										<DropdownMenu.Separator />
										<DropdownMenu.Item class="text-destructive" onclick={() => deleteRun(run)}>
											<TrashIcon class="size-4" />
											Delete Run
										</DropdownMenu.Item>
									</DropdownMenu.Content>
								</DropdownMenu.Root>
							</div>
						</div>

						{#if isExpanded(run.id)}
							<div class="border-t bg-muted/20 p-4">
								<div class="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.15fr)]">
									<div class="space-y-4">
										<div class="rounded-lg border bg-background p-4">
											<div class="mb-3 flex items-center gap-2 text-sm font-medium">
												<ActivityIcon class="size-4" />
												Run State
											</div>
											{#if stateLoading[run.id]}
												<div class="text-muted-foreground text-sm">Loading state...</div>
											{:else}
												<div class="grid gap-3 text-sm sm:grid-cols-2">
													<div>
														<div class="text-muted-foreground">Status</div>
														<div class="font-medium">{state?.status || run.status}</div>
													</div>
													<div>
														<div class="text-muted-foreground">Duration</div>
														<div class="font-medium">{formatDuration(run)}</div>
													</div>
													<div>
														<div class="text-muted-foreground">Progress</div>
														<div class="font-medium">
															{state?.completed ?? 0}/{state?.total ?? 0}
														</div>
													</div>
													<div>
														<div class="text-muted-foreground">Concurrency</div>
														<div class="font-medium">{state?.concurrency ?? 'Auto'}</div>
													</div>
													<div>
														<div class="text-muted-foreground">Containers</div>
														<div class="font-medium">{state?.container_count ?? 0}</div>
													</div>
													<div>
														<div class="text-muted-foreground">Updated</div>
														<div class="font-medium">
															{state?.last_updated ? formatTimestamp(state.last_updated) : '-'}
														</div>
													</div>
												</div>
											{/if}
											{#if state?.nextflow_command}
												<div class="mt-3">
													<div class="text-muted-foreground mb-1 text-sm">Nextflow Command</div>
													<code class="bg-muted block overflow-x-auto rounded-md border px-3 py-2 text-xs">
														{state.nextflow_command}
													</code>
												</div>
											{/if}
										</div>

										<div class="rounded-lg border bg-background p-4">
											<div class="mb-3 text-sm font-medium">Paths</div>
											<div class="space-y-3 text-sm">
												<div>
													<div class="text-muted-foreground">Results Directory</div>
													<div class="font-mono break-all">{run.results_dir || run.work_dir}</div>
												</div>
												<div>
													<div class="text-muted-foreground">Work Directory</div>
													<div class="font-mono break-all">{run.work_dir}</div>
												</div>
											</div>
											<div class="mt-3 flex flex-wrap gap-2">
												<Button variant="outline" size="sm" onclick={() => openResultsFolder(run)}>
													<FolderOpenIcon class="size-4" />
													Results
												</Button>
												<Button variant="outline" size="sm" onclick={() => openWorkFolder(run)}>
													<HardDriveIcon class="size-4" />
													Work Dir
												</Button>
											</div>
										</div>

										{#if run.metadata}
											<div class="rounded-lg border bg-background p-4">
												<div class="mb-2 text-sm font-medium">Metadata</div>
												<pre class="bg-muted overflow-x-auto rounded-md border p-3 text-xs">{JSON.stringify(metadata, null, 2)}</pre>
											</div>
										{/if}
									</div>

									<div class="rounded-lg border bg-background p-4">
										<div class="mb-3 flex items-center justify-between gap-3">
											<div class="flex items-center gap-2 text-sm font-medium">
												<TerminalSquareIcon class="size-4" />
												Live Logs
											</div>
											<div class="flex items-center gap-2">
												<Button
													variant="outline"
													size="sm"
													onclick={() => loadRunLogs(run.id, 500)}
													disabled={logsLoading[run.id]}
												>
													<RefreshCwIcon class="size-4 {logsLoading[run.id] ? 'animate-spin' : ''}" />
													Refresh Logs
												</Button>
											</div>
										</div>
										<pre class="bg-muted min-h-[24rem] overflow-auto rounded-md border p-3 text-xs leading-5 whitespace-pre-wrap">{runLogs[run.id] || 'No logs available for this flow run yet. Logs will appear once execution starts.'}</pre>
									</div>
								</div>
							</div>
						{/if}
					</div>
				{/each}
			</div>
		{/if}
	</div>
</div>
