<script lang="ts">
	import { goto } from '$app/navigation'
	import { invoke } from '@tauri-apps/api/core'
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

	interface PipelineRun {
		id: number
		pipeline_id: number
		pipeline_name: string
		status: string
		work_dir: string
		results_dir?: string
		created_at: string
		selection_metadata?: string
	}

	let runs: PipelineRun[] = $state([])
	let loading = $state(true)
	let error: string | null = $state(null)

	async function loadRuns() {
		try {
			loading = true
			error = null
			runs = await invoke<PipelineRun[]>('get_flow_runs')
			// Sort by created_at descending (newest first)
			runs.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
		} catch (e) {
			error = e instanceof Error ? e.message : String(e)
		} finally {
			loading = false
		}
	}

	onMount(() => {
		loadRuns()
		// Auto-refresh every 5 seconds
		const interval = setInterval(loadRuns, 5000)
		return () => clearInterval(interval)
	})

	async function deleteRun(runId: number) {
		try {
			await invoke('delete_flow_run', { runId })
			runs = runs.filter((r) => r.id !== runId)
		} catch (e) {
			console.error('Failed to delete run:', e)
		}
	}

	async function openRunFolder(run: PipelineRun) {
		const path = run.results_dir || run.work_dir
		if (path) {
			try {
				await invoke('show_in_folder', { path })
			} catch (e) {
				console.error('Failed to open folder:', e)
			}
		}
	}

	function formatDate(dateStr: string): string {
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

	function getStatusInfo(status: string) {
		switch (status.toLowerCase()) {
			case 'completed':
			case 'success':
				return {
					variant: 'default' as const,
					icon: CheckCircleIcon,
					label: 'Completed',
					color: 'text-green-600',
					bgColor: 'bg-green-500',
				}
			case 'failed':
			case 'error':
				return {
					variant: 'destructive' as const,
					icon: XCircleIcon,
					label: 'Failed',
					color: 'text-red-600',
					bgColor: 'bg-red-500',
				}
			case 'running':
				return {
					variant: 'secondary' as const,
					icon: LoaderIcon,
					label: 'Running',
					color: 'text-blue-600',
					bgColor: 'bg-blue-500',
					animate: true,
				}
			case 'pending':
				return {
					variant: 'outline' as const,
					icon: ClockIcon,
					label: 'Pending',
					color: 'text-yellow-600',
					bgColor: 'bg-yellow-500',
				}
			default:
				return {
					variant: 'outline' as const,
					icon: ClockIcon,
					label: status,
					color: 'text-muted-foreground',
					bgColor: 'bg-muted',
				}
		}
	}

	// Group runs by status for summary
	let runningCount = $derived(runs.filter((r) => r.status.toLowerCase() === 'running').length)
	let completedCount = $derived(
		runs.filter((r) => ['completed', 'success'].includes(r.status.toLowerCase())).length,
	)
	let failedCount = $derived(
		runs.filter((r) => ['failed', 'error'].includes(r.status.toLowerCase())).length,
	)
</script>

<div class="flex h-full flex-col">
	<PageHeader title="Runs" description="Track your flow executions">
		<Button size="sm" variant="outline" onclick={loadRuns} disabled={loading}>
			<RefreshCwIcon class="size-4 {loading ? 'animate-spin' : ''}" />
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
			<!-- Summary Stats -->
			{#if runningCount > 0 || completedCount > 0 || failedCount > 0}
				<div class="flex gap-4 mb-6">
					{#if runningCount > 0}
						<div class="flex items-center gap-2 text-sm">
							<div class="size-2 rounded-full bg-blue-500 animate-pulse"></div>
							<span class="text-muted-foreground">{runningCount} running</span>
						</div>
					{/if}
					{#if completedCount > 0}
						<div class="flex items-center gap-2 text-sm">
							<div class="size-2 rounded-full bg-green-500"></div>
							<span class="text-muted-foreground">{completedCount} completed</span>
						</div>
					{/if}
					{#if failedCount > 0}
						<div class="flex items-center gap-2 text-sm">
							<div class="size-2 rounded-full bg-red-500"></div>
							<span class="text-muted-foreground">{failedCount} failed</span>
						</div>
					{/if}
				</div>
			{/if}

			<!-- Runs List -->
			<div class="space-y-3">
				{#each runs as run (run.id)}
					{@const statusInfo = getStatusInfo(run.status)}
					{@const StatusIcon = statusInfo.icon}
					<div
						class="flex items-center gap-4 rounded-xl border bg-card p-4 transition-all hover:shadow-sm"
					>
						<!-- Status indicator -->
						<div
							class="flex size-10 shrink-0 items-center justify-center rounded-lg {statusInfo.bgColor} text-white"
						>
							<StatusIcon class="size-5 {statusInfo.animate ? 'animate-spin' : ''}" />
						</div>

						<!-- Run info -->
						<div class="flex-1 min-w-0">
							<div class="flex items-center gap-2">
								<h3 class="font-semibold truncate">{run.pipeline_name}</h3>
								<Badge variant={statusInfo.variant} class="text-xs">
									{statusInfo.label}
								</Badge>
							</div>
							<p class="text-muted-foreground text-sm mt-0.5">
								Run #{run.id} • {formatDate(run.created_at)}
							</p>
						</div>

						<!-- Actions -->
						<div class="flex items-center gap-2">
							<Button
								variant="ghost"
								size="sm"
								onclick={() => goto(`/flows/${run.pipeline_name}`)}
							>
								View Flow
							</Button>
							<DropdownMenu.Root>
								<DropdownMenu.Trigger>
									{#snippet child({ props })}
										<Button {...props} variant="ghost" size="icon" class="size-8">
											<MoreVerticalIcon class="size-4" />
										</Button>
									{/snippet}
								</DropdownMenu.Trigger>
								<DropdownMenu.Content align="end">
									<DropdownMenu.Item onclick={() => openRunFolder(run)}>
										<FolderOpenIcon class="size-4" />
										Open Results Folder
									</DropdownMenu.Item>
									<DropdownMenu.Separator />
									<DropdownMenu.Item
										class="text-destructive"
										onclick={() => deleteRun(run.id)}
									>
										<TrashIcon class="size-4" />
										Delete Run
									</DropdownMenu.Item>
								</DropdownMenu.Content>
							</DropdownMenu.Root>
						</div>
					</div>
				{/each}
			</div>
		{/if}
	</div>
</div>
