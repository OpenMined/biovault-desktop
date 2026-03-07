<script lang="ts">
	import { goto } from '$app/navigation'
	import { invoke } from '@tauri-apps/api/core'
	import { onMount } from 'svelte'
	import { confirm } from '@tauri-apps/plugin-dialog'
	import PageHeader from '$lib/components/page-header.svelte'
	import CreateFlowDialog from '$lib/components/create-flow-dialog.svelte'
	import * as Empty from '$lib/components/ui/empty/index.js'
	import { Button } from '$lib/components/ui/button/index.js'
	import { toast } from 'svelte-sonner'
	import WorkflowIcon from '@lucide/svelte/icons/workflow'
	import PlusIcon from '@lucide/svelte/icons/plus'
	import ChevronRightIcon from '@lucide/svelte/icons/chevron-right'
	import Loader2Icon from '@lucide/svelte/icons/loader-2'
	import TrashIcon from '@lucide/svelte/icons/trash-2'
	import DnaIcon from '@lucide/svelte/icons/dna'
	import UserIcon from '@lucide/svelte/icons/user'
	import ScanEyeIcon from '@lucide/svelte/icons/scan-eye'

	interface PipelineSpec {
		inputs?: Record<string, unknown>
		steps?: Array<{ id: string }>
	}

	interface FlowProvenance {
		source_type: string
		source_sender?: string | null
		source_thread_id?: string | null
		source_thread_name?: string | null
		source_location?: string | null
		source_submission_id?: string | null
		imported_at: string
	}

	interface Pipeline {
		id: number
		name: string
		flow_path: string
		spec?: PipelineSpec
		created_at?: string
		provenance?: FlowProvenance | null
	}

	let flows: Pipeline[] = $state([])
	let loading = $state(true)
	let error: string | null = $state(null)
	let createDialogOpen = $state(false)
	let deletingFlowId: number | null = $state(null)
	let sourceFilter = $state<'all' | 'thread' | 'explore' | 'local'>('all')

	async function loadFlows() {
		try {
			loading = true
			flows = await invoke<Pipeline[]>('get_flows')
		} catch (e) {
			error = e instanceof Error ? e.message : String(e)
		} finally {
			loading = false
		}
	}

	onMount(loadFlows)

	function handleFlowCreated() {
		loadFlows()
	}

	async function deleteFlow(flow: Pipeline) {
		if (deletingFlowId !== null) return
		const ok = await confirm(`Delete flow "${flow.name}"? This cannot be undone.`, {
			title: 'Delete Flow',
			kind: 'warning',
		})
		if (!ok) return

		deletingFlowId = flow.id
		try {
			await invoke('delete_flow', { flowId: flow.id })
			flows = flows.filter((f) => f.id !== flow.id)
			toast.success(`Deleted flow "${flow.name}"`)
		} catch (e) {
			toast.error('Failed to delete flow', { description: String(e) })
		} finally {
			deletingFlowId = null
		}
	}

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
		// Default
		return { icon: WorkflowIcon, color: 'bg-primary' }
	}

	function getStepCount(flow: Pipeline): number {
		return flow.spec?.steps?.length ?? 0
	}

	function getInputCount(flow: Pipeline): number {
		return flow.spec?.inputs ? Object.keys(flow.spec.inputs).length : 0
	}

	function flowSource(flow: Pipeline): 'thread' | 'explore' | 'local' {
		const source = flow.provenance?.source_type || ''
		if (source === 'thread_request') return 'thread'
		if (source === 'explore') return 'explore'
		return 'local'
	}

	const filteredFlows = $derived.by(() => {
		if (sourceFilter === 'all') return flows
		return flows.filter((flow) => flowSource(flow) === sourceFilter)
	})

	function sourceBadgeText(flow: Pipeline): string {
		const source = flowSource(flow)
		if (source === 'thread') return 'From Thread'
		if (source === 'explore') return 'From Explore'
		return 'Local'
	}

	function sourceMetaText(flow: Pipeline): string | null {
		const p = flow.provenance
		if (!p) return null
		if (p.source_type === 'thread_request') {
			const from = p.source_sender ? `from ${p.source_sender}` : 'from thread'
			const when = p.imported_at ? ` • ${new Date(p.imported_at).toLocaleString()}` : ''
			return `${from}${when}`
		}
		if (p.source_type === 'explore') {
			const when = p.imported_at ? `Imported ${new Date(p.imported_at).toLocaleString()}` : 'Imported from Explore'
			return when
		}
		return null
	}
</script>

<div class="flex h-full flex-col">
	<PageHeader title="Flows" description="Create and manage your analysis workflows">
		<Button size="sm" data-testid="flows-new" onclick={() => (createDialogOpen = true)}>
			<PlusIcon class="size-4" />
			New Flow
		</Button>
	</PageHeader>

	<div class="flex-1 overflow-auto p-6">
			<div class="mb-4 inline-flex items-center gap-1 rounded-md border bg-background p-1">
				<Button size="sm" variant={sourceFilter === 'all' ? 'secondary' : 'ghost'} class="h-7 px-2 text-xs" onclick={() => (sourceFilter = 'all')}>All</Button>
				<Button size="sm" variant={sourceFilter === 'thread' ? 'secondary' : 'ghost'} class="h-7 px-2 text-xs" onclick={() => (sourceFilter = 'thread')}>From Thread</Button>
				<Button size="sm" variant={sourceFilter === 'explore' ? 'secondary' : 'ghost'} class="h-7 px-2 text-xs" onclick={() => (sourceFilter = 'explore')}>From Explore</Button>
				<Button size="sm" variant={sourceFilter === 'local' ? 'secondary' : 'ghost'} class="h-7 px-2 text-xs" onclick={() => (sourceFilter = 'local')}>Local</Button>
			</div>
		{#if loading}
			<div class="flex h-full items-center justify-center">
				<p class="text-muted-foreground">Loading flows...</p>
			</div>
		{:else if error}
			<div class="flex h-full items-center justify-center">
				<p class="text-destructive">Error: {error}</p>
			</div>
		{:else if filteredFlows.length === 0}
			<div class="flex h-full items-center justify-center">
				<Empty.Root>
					<Empty.Header>
						<Empty.Media variant="icon">
							<WorkflowIcon class="size-6" />
						</Empty.Media>
						<Empty.Title>No Flows Yet</Empty.Title>
						<Empty.Description>
							Flows are reusable analysis pipelines. Get started with a template or create your
							own.
						</Empty.Description>
					</Empty.Header>
					<Empty.Content>
						<div class="flex gap-2">
							<Button data-testid="flows-create" onclick={() => (createDialogOpen = true)}>
								<PlusIcon class="size-4" />
								Create Flow
							</Button>
						</div>
					</Empty.Content>
				</Empty.Root>
			</div>
		{:else}
			<div class="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
				{#each filteredFlows as flow (flow.id)}
					{@const style = getFlowStyle(flow.name)}
					{@const Icon = style.icon}
					<button
						type="button"
						onclick={() => goto(`/flows/${flow.name}`)}
						data-testid={`flow-card-${flow.name}`}
						class="group rounded-xl border bg-card p-5 transition-all hover:shadow-md hover:border-primary/20 text-left cursor-pointer"
					>
						<div class="flex items-start gap-4">
							<div
								class="flex size-12 shrink-0 items-center justify-center rounded-lg {style.color} text-white"
							>
								<Icon class="size-6" />
							</div>
							<div class="flex-1 min-w-0">
								<div class="flex items-center gap-2">
									<h3 class="font-semibold truncate">{flow.name}</h3>
									<span class="rounded border px-1.5 py-0.5 text-[10px] text-muted-foreground">{sourceBadgeText(flow)}</span>
								</div>
								<p class="text-muted-foreground text-sm mt-0.5">
									{getStepCount(flow)} steps
									{#if getInputCount(flow) > 0}
										• {getInputCount(flow)} inputs
									{/if}
								</p>
								{#if sourceMetaText(flow)}
									<p class="text-[11px] text-muted-foreground mt-0.5 truncate">{sourceMetaText(flow)}</p>
								{/if}
							</div>
							<Button
								type="button"
								size="icon"
								variant="ghost"
								class="size-8 text-muted-foreground hover:text-destructive"
								disabled={deletingFlowId === flow.id}
								onclick={(e) => {
									e.stopPropagation()
									void deleteFlow(flow)
								}}
								aria-label={`Delete ${flow.name}`}
							>
								{#if deletingFlowId === flow.id}
									<Loader2Icon class="size-4 animate-spin" />
								{:else}
									<TrashIcon class="size-4" />
								{/if}
							</Button>
							<ChevronRightIcon
								class="size-5 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity shrink-0"
							/>
						</div>
					</button>
				{/each}
			</div>
		{/if}
	</div>
</div>

<CreateFlowDialog bind:open={createDialogOpen} onCreated={handleFlowCreated} />
