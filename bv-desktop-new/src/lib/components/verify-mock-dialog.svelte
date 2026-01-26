<script lang="ts">
	import { invoke } from '@tauri-apps/api/core'
	import * as Dialog from '$lib/components/ui/dialog/index.js'
	import { Button, buttonVariants } from '$lib/components/ui/button/index.js'
	import WorkflowIcon from '@lucide/svelte/icons/workflow'
	import PlayIcon from '@lucide/svelte/icons/play'
	import LoaderIcon from '@lucide/svelte/icons/loader'
	import CheckIcon from '@lucide/svelte/icons/check'
	import AlertCircleIcon from '@lucide/svelte/icons/alert-circle'
	import DnaIcon from '@lucide/svelte/icons/dna'
	import UserIcon from '@lucide/svelte/icons/user'
	import ScanEyeIcon from '@lucide/svelte/icons/scan-eye'

	interface Pipeline {
		id: number
		name: string
		pipeline_path: string
	}

	interface Props {
		open?: boolean
		onOpenChange?: (open: boolean) => void
		datasetName: string
		mockUrls: string[]
		onRunStarted?: () => void
	}

	let { open = $bindable(false), onOpenChange, datasetName, mockUrls, onRunStarted }: Props =
		$props()

	let pipelines: Pipeline[] = $state([])
	let loading = $state(true)
	let running = $state(false)
	let error = $state<string | null>(null)
	let selectedPipeline: Pipeline | null = $state(null)

	async function loadPipelines() {
		try {
			loading = true
			error = null
			pipelines = await invoke<Pipeline[]>('get_pipelines')
		} catch (e) {
			error = e instanceof Error ? e.message : String(e)
		} finally {
			loading = false
		}
	}

	function handleOpenChange(newOpen: boolean) {
		open = newOpen
		onOpenChange?.(newOpen)
		if (newOpen) {
			selectedPipeline = null
			error = null
			loadPipelines()
		}
	}

	async function runVerifiedFlow() {
		if (!selectedPipeline) return
		running = true
		error = null

		try {
			await invoke('run_pipeline', {
				pipelineId: selectedPipeline.id,
				inputOverrides: {},
				resultsDir: null,
				selection: {
					urls: mockUrls,
					dataSource: 'network_dataset',
					datasetName: datasetName,
				},
			})

			handleOpenChange(false)
			onRunStarted?.()
		} catch (e) {
			error = e instanceof Error ? e.message : String(e)
		} finally {
			running = false
		}
	}

	function getFlowIcon(name: string) {
		const lower = name.toLowerCase()
		if (lower.includes('dna') || lower.includes('gene')) return DnaIcon
		if (lower.includes('user') || lower.includes('profile')) return UserIcon
		if (lower.includes('eye') || lower.includes('scan')) return ScanEyeIcon
		return WorkflowIcon
	}

	$effect(() => {
		if (open) {
			loadPipelines()
		}
	})
</script>

<Dialog.Root bind:open onOpenChange={handleOpenChange}>
	<Dialog.Content class="max-w-lg">
		<Dialog.Header>
			<Dialog.Title>Verify {datasetName} on Mock</Dialog.Title>
			<Dialog.Description>
				Select a pipeline to run against the mock data of this dataset.
			</Dialog.Description>
		</Dialog.Header>

		<div class="py-4">
			{#if loading}
				<div class="flex items-center justify-center py-8">
					<LoaderIcon class="size-6 animate-spin text-muted-foreground" />
				</div>
			{:else if pipelines.length === 0}
				<div class="text-center py-8 text-muted-foreground">
					<WorkflowIcon class="size-12 mx-auto mb-3 opacity-20" />
					<p>No pipelines installed.</p>
					<p class="text-xs">Install a pipeline from the Explore tab first.</p>
				</div>
			{:else}
				<div class="space-y-2 max-h-[300px] overflow-y-auto pr-1">
					{#each pipelines as pipeline (pipeline.id)}
						{@const Icon = getFlowIcon(pipeline.name)}
						<button
							type="button"
							onclick={() => (selectedPipeline = pipeline)}
							class="w-full flex items-center gap-3 rounded-lg border p-3 text-left transition-all hover:bg-accent {selectedPipeline?.id ===
							pipeline.id
								? 'border-primary bg-primary/5'
								: ''}"
						>
							<div
								class="flex size-10 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary"
							>
								<Icon class="size-5" />
							</div>
							<div class="flex-1 min-w-0">
								<div class="font-medium text-sm">{pipeline.name}</div>
								<div class="text-muted-foreground text-xs truncate">
									{pipeline.pipeline_path.split('/').pop()}
								</div>
							</div>
							{#if selectedPipeline?.id === pipeline.id}
								<div class="flex size-6 items-center justify-center rounded-full bg-primary text-white">
									<CheckIcon class="size-4" />
								</div>
							{/if}
						</button>
					{/each}
				</div>
			{/if}

			{#if error}
				<div
					class="mt-4 flex items-start gap-2 bg-destructive/10 text-destructive text-sm rounded-md px-3 py-2"
				>
					<AlertCircleIcon class="size-4 shrink-0 mt-0.5" />
					<div>{error}</div>
				</div>
			{/if}
		</div>

		<Dialog.Footer>
			<Dialog.Close class={buttonVariants({ variant: 'outline' })}>Cancel</Dialog.Close>
			<Button onclick={runVerifiedFlow} disabled={running || !selectedPipeline || loading}>
				{#if running}
					<LoaderIcon class="size-4 animate-spin mr-2" />
					Starting...
				{:else}
					<PlayIcon class="size-4 mr-2" />
					Run Verification
				{/if}
			</Button>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>
