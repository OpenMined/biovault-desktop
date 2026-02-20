<script lang="ts">
	import { page } from '$app/stores'
	import { goto } from '$app/navigation'
	import { invoke } from '@tauri-apps/api/core'
	import { onMount } from 'svelte'
	import { Button } from '$lib/components/ui/button/index.js'
	import * as Card from '$lib/components/ui/card/index.js'
	import { Badge } from '$lib/components/ui/badge/index.js'
	import RunFlowDialog from '$lib/components/run-flow-dialog.svelte'
	import ArrowLeftIcon from '@lucide/svelte/icons/arrow-left'
	import PlayIcon from '@lucide/svelte/icons/play'
	import SettingsIcon from '@lucide/svelte/icons/settings'
	import FileCodeIcon from '@lucide/svelte/icons/file-code'
	import ClockIcon from '@lucide/svelte/icons/clock'
	import CheckCircleIcon from '@lucide/svelte/icons/check-circle'
	import XCircleIcon from '@lucide/svelte/icons/x-circle'
	import LoaderIcon from '@lucide/svelte/icons/loader'
	import WorkflowIcon from '@lucide/svelte/icons/workflow'
	import DnaIcon from '@lucide/svelte/icons/dna'
	import UserIcon from '@lucide/svelte/icons/user'
	import ScanEyeIcon from '@lucide/svelte/icons/scan-eye'
	import FolderOpenIcon from '@lucide/svelte/icons/folder-open'
	import TrashIcon from '@lucide/svelte/icons/trash-2'

	interface PipelineInput {
		type?: string
		default?: string | number | boolean | null
		description?: string
	}

	interface PipelineStep {
		id: string
		uses?: string
	}

	interface PipelineSpec {
		inputs?: Record<string, PipelineInput>
		steps?: PipelineStep[]
	}

	interface Pipeline {
		id: number
		name: string
		flow_path: string
		spec?: PipelineSpec
		created_at?: string
	}

	interface PipelineRun {
		id: number
		pipeline_id: number
		pipeline_name: string
		status: string
		work_dir: string
		results_dir?: string
		created_at: string
	}

	let flowName = $derived($page.params.name)

	let loading = $state(true)
	let error = $state<string | null>(null)
	let flow = $state<Pipeline | null>(null)
	let runs = $state<PipelineRun[]>([])
	let runDialogOpen = $state(false)

	async function loadFlow() {
		try {
			loading = true
			error = null

			// Get all pipelines and find the one matching our name
			const pipelines = await invoke<Pipeline[]>('get_flows')
			flow = pipelines.find((p) => p.name === flowName) ?? null

			if (!flow) {
				error = `Flow "${flowName}" not found`
				return
			}

			// Get runs for this pipeline
			const allRuns = await invoke<PipelineRun[]>('get_flow_runs')
			runs = allRuns
				.filter((r) => r.pipeline_id === flow?.id)
				.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
				.slice(0, 10) // Show last 10 runs
		} catch (e) {
			error = e instanceof Error ? e.message : String(e)
		} finally {
			loading = false
		}
	}

	onMount(loadFlow)

	// Map known flow names to icons and colors
	function getFlowStyle(name: string): { icon: typeof DnaIcon; color: string } {
		const lowerName = name.toLowerCase()
		if (lowerName.includes('apol1')) {
			return { icon: DnaIcon, color: 'bg-blue-500' }
		}
		if (lowerName.includes('brca')) {
			return { icon: UserIcon, color: 'bg-violet-500' }
		}
		if (lowerName.includes('herc2')) {
			return { icon: ScanEyeIcon, color: 'bg-emerald-500' }
		}
		if (lowerName.includes('thalassemia')) {
			return { icon: DnaIcon, color: 'bg-red-500' }
		}
		return { icon: WorkflowIcon, color: 'bg-primary' }
	}

	async function refreshRuns() {
		if (!flow) return
		try {
			const allRuns = await invoke<PipelineRun[]>('get_flow_runs')
			runs = allRuns
				.filter((r) => r.pipeline_id === flow?.id)
				.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
				.slice(0, 10)
		} catch (e) {
			console.error('Failed to refresh runs:', e)
		}
	}

	async function openInFolder() {
		if (!flow) return
		try {
			await invoke('show_in_folder', { path: flow.flow_path })
		} catch (e) {
			console.error('Failed to open folder:', e)
		}
	}

	async function deleteRun(runId: number) {
		try {
			await invoke('delete_flow_run', { runId })
			runs = runs.filter((r) => r.id !== runId)
		} catch (e) {
			console.error('Failed to delete run:', e)
		}
	}

	function formatDate(dateStr: string): string {
		const date = new Date(dateStr)
		return date.toLocaleDateString(undefined, {
			month: 'short',
			day: 'numeric',
			hour: '2-digit',
			minute: '2-digit',
		})
	}

	function getStatusBadge(status: string) {
		switch (status.toLowerCase()) {
			case 'completed':
			case 'success':
				return { variant: 'default' as const, icon: CheckCircleIcon, label: 'Completed' }
			case 'failed':
			case 'error':
				return { variant: 'destructive' as const, icon: XCircleIcon, label: 'Failed' }
			case 'running':
				return { variant: 'secondary' as const, icon: LoaderIcon, label: 'Running' }
			default:
				return { variant: 'outline' as const, icon: ClockIcon, label: status }
		}
	}
</script>

<div class="flex h-full flex-col">
	<!-- Header -->
	<div class="flex items-center gap-4 border-b px-6 py-4">
		<Button variant="ghost" size="icon" onclick={() => goto('/flows')}>
			<ArrowLeftIcon class="size-5" />
		</Button>

		{#if flow}
			{@const style = getFlowStyle(flow.name)}
			{@const Icon = style.icon}
			<div class="flex size-10 items-center justify-center rounded-lg {style.color} text-white">
				<Icon class="size-5" />
			</div>
			<div class="flex-1">
				<h1 class="text-xl font-semibold">{flow.name}</h1>
				<p class="text-muted-foreground text-sm">
					{flow.spec?.steps?.length ?? 0} steps
					{#if flow.spec?.inputs}
						• {Object.keys(flow.spec.inputs).length} inputs
					{/if}
				</p>
			</div>
			<div class="flex gap-2">
				<Button variant="outline" size="sm" data-testid="flow-open-folder" onclick={openInFolder}>
					<FolderOpenIcon class="size-4" />
					Open Folder
				</Button>
				<Button size="sm" data-testid="flow-run" onclick={() => (runDialogOpen = true)}>
					<PlayIcon class="size-4" />
					Run Flow
				</Button>
			</div>
		{:else}
			<div class="flex-1">
				<h1 class="text-xl font-semibold">{flowName}</h1>
			</div>
		{/if}
	</div>

	<!-- Content -->
	<div class="flex-1 overflow-auto p-6">
		{#if loading}
			<div class="flex h-full items-center justify-center">
				<p class="text-muted-foreground">Loading flow...</p>
			</div>
		{:else if error}
			<div class="flex h-full items-center justify-center">
				<p class="text-destructive">Error: {error}</p>
			</div>
		{:else if flow}
			<div class="grid gap-6 lg:grid-cols-3">
				<!-- Flow Info -->
				<div class="lg:col-span-2 space-y-6">
					<!-- Inputs -->
					{#if flow.spec?.inputs && Object.keys(flow.spec.inputs).length > 0}
						<Card.Root>
							<Card.Header>
								<Card.Title class="flex items-center gap-2 text-base">
									<SettingsIcon class="size-4" />
									Inputs
								</Card.Title>
							</Card.Header>
							<Card.Content>
								<div class="space-y-3">
									{#each Object.entries(flow.spec.inputs) as [name, input]}
										<div class="flex items-start justify-between gap-4 rounded-lg border p-3">
											<div class="flex-1">
												<div class="font-medium text-sm">{name}</div>
												{#if input.description}
													<p class="text-muted-foreground text-xs mt-0.5">{input.description}</p>
												{/if}
											</div>
											<div class="text-right">
												{#if input.type}
													<Badge variant="outline" class="text-xs">{input.type}</Badge>
												{/if}
												{#if input.default !== undefined && input.default !== null}
													<p class="text-muted-foreground text-xs mt-1">
														Default: {String(input.default)}
													</p>
												{/if}
											</div>
										</div>
									{/each}
								</div>
							</Card.Content>
						</Card.Root>
					{/if}

					<!-- Steps -->
					{#if flow.spec?.steps && flow.spec.steps.length > 0}
						<Card.Root>
							<Card.Header>
								<Card.Title class="flex items-center gap-2 text-base">
									<WorkflowIcon class="size-4" />
									Steps
								</Card.Title>
							</Card.Header>
							<Card.Content>
								<div class="space-y-2">
									{#each flow.spec.steps as step, index}
										<div class="flex items-center gap-3 rounded-lg border p-3">
											<div
												class="flex size-8 shrink-0 items-center justify-center rounded-full bg-muted text-sm font-medium"
											>
												{index + 1}
											</div>
											<div class="flex-1 min-w-0">
												<div class="font-medium text-sm">{step.id}</div>
												{#if step.uses}
													<p class="text-muted-foreground text-xs truncate">uses: {step.uses}</p>
												{/if}
											</div>
										</div>
									{/each}
								</div>
							</Card.Content>
						</Card.Root>
					{/if}
				</div>

				<!-- Recent Runs -->
				<div>
					<Card.Root>
						<Card.Header>
							<Card.Title class="flex items-center gap-2 text-base">
								<ClockIcon class="size-4" />
								Recent Runs
							</Card.Title>
						</Card.Header>
						<Card.Content>
							{#if runs.length === 0}
								<p class="text-muted-foreground text-sm text-center py-4">No runs yet</p>
							{:else}
								<div class="space-y-2">
									{#each runs as run}
										{@const statusInfo = getStatusBadge(run.status)}
										{@const StatusIcon = statusInfo.icon}
										<div class="flex items-center gap-3 rounded-lg border p-3">
											<div
												class="flex size-8 shrink-0 items-center justify-center rounded-full bg-muted"
											>
												<StatusIcon
													class="size-4 {statusInfo.variant === 'destructive'
														? 'text-destructive'
														: statusInfo.label === 'Running'
															? 'animate-spin'
															: 'text-muted-foreground'}"
												/>
											</div>
											<div class="flex-1 min-w-0">
												<div class="font-medium text-sm">Run #{run.id}</div>
												<p class="text-muted-foreground text-xs">{formatDate(run.created_at)}</p>
											</div>
											<Badge variant={statusInfo.variant} class="text-xs">
												{statusInfo.label}
											</Badge>
											<Button
												variant="ghost"
												size="icon"
												class="size-7"
												onclick={() => deleteRun(run.id)}
											>
												<TrashIcon class="size-3.5" />
											</Button>
										</div>
									{/each}
								</div>
							{/if}
						</Card.Content>
					</Card.Root>

					<!-- Flow Info -->
					<Card.Root class="mt-4">
						<Card.Header>
							<Card.Title class="flex items-center gap-2 text-base">
								<FileCodeIcon class="size-4" />
								Flow Details
							</Card.Title>
						</Card.Header>
						<Card.Content>
							<dl class="space-y-2 text-sm">
								<div class="flex justify-between">
									<dt class="text-muted-foreground">ID</dt>
									<dd class="font-mono">{flow.id}</dd>
								</div>
								<div class="flex justify-between">
									<dt class="text-muted-foreground">Path</dt>
									<dd class="font-mono text-xs truncate max-w-[180px]" title={flow.flow_path}>
										{flow.flow_path.split('/').pop()}
									</dd>
								</div>
								{#if flow.created_at}
									<div class="flex justify-between">
										<dt class="text-muted-foreground">Created</dt>
										<dd>{formatDate(flow.created_at)}</dd>
									</div>
								{/if}
							</dl>
						</Card.Content>
					</Card.Root>
				</div>
			</div>
		{/if}
	</div>
</div>

{#if flow}
	<RunFlowDialog
		bind:open={runDialogOpen}
		pipelineId={flow.id}
		pipelineName={flow.name}
		onRunStarted={refreshRuns}
	/>
{/if}
