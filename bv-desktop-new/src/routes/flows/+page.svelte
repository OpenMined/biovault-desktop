<script lang="ts">
	import { goto } from '$app/navigation'
	import { invoke } from '@tauri-apps/api/core'
	import { onMount } from 'svelte'
	import PageHeader from '$lib/components/page-header.svelte'
	import CreateFlowDialog from '$lib/components/create-flow-dialog.svelte'
	import * as Empty from '$lib/components/ui/empty/index.js'
	import { Button } from '$lib/components/ui/button/index.js'
	import WorkflowIcon from '@lucide/svelte/icons/workflow'
	import PlusIcon from '@lucide/svelte/icons/plus'
	import ChevronRightIcon from '@lucide/svelte/icons/chevron-right'
	import DnaIcon from '@lucide/svelte/icons/dna'
	import UserIcon from '@lucide/svelte/icons/user'
	import ScanEyeIcon from '@lucide/svelte/icons/scan-eye'

	interface PipelineSpec {
		inputs?: Record<string, unknown>
		steps?: Array<{ id: string }>
	}

	interface Pipeline {
		id: number
		name: string
		flow_path: string
		spec?: PipelineSpec
		created_at?: string
	}

	let flows: Pipeline[] = $state([])
	let loading = $state(true)
	let error: string | null = $state(null)
	let createDialogOpen = $state(false)

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
</script>

<div class="flex h-full flex-col">
	<PageHeader title="Flows" description="Create and manage your analysis workflows">
		<Button size="sm" onclick={() => (createDialogOpen = true)}>
			<PlusIcon class="size-4" />
			New Flow
		</Button>
	</PageHeader>

	<div class="flex-1 overflow-auto p-6">
		{#if loading}
			<div class="flex h-full items-center justify-center">
				<p class="text-muted-foreground">Loading flows...</p>
			</div>
		{:else if error}
			<div class="flex h-full items-center justify-center">
				<p class="text-destructive">Error: {error}</p>
			</div>
		{:else if flows.length === 0}
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
							<Button onclick={() => (createDialogOpen = true)}>
								<PlusIcon class="size-4" />
								Create Flow
							</Button>
						</div>
					</Empty.Content>
				</Empty.Root>
			</div>
		{:else}
			<div class="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
				{#each flows as flow (flow.id)}
					{@const style = getFlowStyle(flow.name)}
					{@const Icon = style.icon}
					<button
						type="button"
						onclick={() => goto(`/flows/${flow.name}`)}
						class="group rounded-xl border bg-card p-5 transition-all hover:shadow-md hover:border-primary/20 text-left cursor-pointer"
					>
						<div class="flex items-start gap-4">
							<div
								class="flex size-12 shrink-0 items-center justify-center rounded-lg {style.color} text-white"
							>
								<Icon class="size-6" />
							</div>
							<div class="flex-1 min-w-0">
								<h3 class="font-semibold truncate">{flow.name}</h3>
								<p class="text-muted-foreground text-sm mt-0.5">
									{getStepCount(flow)} steps
									{#if getInputCount(flow) > 0}
										• {getInputCount(flow)} inputs
									{/if}
								</p>
							</div>
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
