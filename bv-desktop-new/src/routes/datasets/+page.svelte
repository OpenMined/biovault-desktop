<script lang="ts">
	import { goto } from '$app/navigation'
	import { invoke } from '@tauri-apps/api/core'
	import { onMount } from 'svelte'
	import PageHeader from '$lib/components/page-header.svelte'
	import CreateDatasetDialog from '$lib/components/create-dataset-dialog.svelte'
	import * as Empty from '$lib/components/ui/empty/index.js'
	import { Button } from '$lib/components/ui/button/index.js'
	import DatabaseIcon from '@lucide/svelte/icons/database'
	import PlusIcon from '@lucide/svelte/icons/plus'
	import UploadIcon from '@lucide/svelte/icons/upload'
	import PackageIcon from '@lucide/svelte/icons/package'
	import ChevronRightIcon from '@lucide/svelte/icons/chevron-right'
	import StarIcon from '@lucide/svelte/icons/star'
	import Loader2Icon from '@lucide/svelte/icons/loader-2'
	import { Badge } from '$lib/components/ui/badge/index.js'
	import { toast } from 'svelte-sonner'

	interface DatasetAsset {
		asset_key: string
		resolved_private_path?: string
	}

	interface DatasetWithAssets {
		dataset: {
			id: number
			name: string
			version: string
			author: string
			description?: string
			extra?: any
		}
		assets: DatasetAsset[]
	}

	let datasets: DatasetWithAssets[] = $state([])
	let loading = $state(true)
	let error: string | null = $state(null)
	let createDialogOpen = $state(false)
	let unpinning = $state<string | null>(null)

	async function loadDatasets() {
		try {
			loading = true
			datasets = await invoke<DatasetWithAssets[]>('list_datasets_with_assets')
		} catch (e) {
			error = e instanceof Error ? e.message : String(e)
		} finally {
			loading = false
		}
	}

	onMount(loadDatasets)

	async function unpinDataset(name: string) {
		unpinning = name
		try {
			await invoke('delete_dataset', { name })
			toast.success(`Unstarred ${name}`)
			await loadDatasets()
		} catch (e) {
			toast.error(`Failed to unstar dataset: ${e}`)
		} finally {
			unpinning = null
		}
	}

	function handleDatasetCreated() {
		loadDatasets()
	}
</script>

<div class="flex h-full flex-col">
	<PageHeader title="Datasets" description="Manage your datasets and data sources">
		<Button size="sm" onclick={() => (createDialogOpen = true)}>
			<PlusIcon class="size-4" />
			New Dataset
		</Button>
	</PageHeader>

	<div class="flex-1 overflow-auto p-6">
		{#if loading}
			<div class="flex h-full items-center justify-center">
				<p class="text-muted-foreground">Loading datasets...</p>
			</div>
		{:else if error}
			<div class="flex h-full items-center justify-center">
				<p class="text-destructive">Error: {error}</p>
			</div>
		{:else if datasets.length === 0}
			<div class="flex h-full items-center justify-center">
				<Empty.Root>
					<Empty.Header>
						<Empty.Media variant="icon">
							<DatabaseIcon class="size-6" />
						</Empty.Media>
						<Empty.Title>No Datasets Yet</Empty.Title>
						<Empty.Description>
							You haven't added any datasets yet. Get started by creating or importing your first
							dataset.
						</Empty.Description>
					</Empty.Header>
					<Empty.Content>
						<div class="flex gap-2">
							<Button onclick={() => (createDialogOpen = true)}>
								<PlusIcon class="size-4" />
								Create Dataset
							</Button>
							<Button variant="outline">
								<UploadIcon class="size-4" />
								Import Dataset
							</Button>
						</div>
					</Empty.Content>
				</Empty.Root>
			</div>
		{:else}
			<div class="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
				{#each datasets as item (item.dataset.name)}
					<button
						type="button"
						onclick={() => goto(`/datasets/${item.dataset.name}`)}
						class="group rounded-xl border bg-card p-5 transition-all hover:shadow-md hover:border-primary/20 text-left cursor-pointer"
					>
						<div class="flex items-start gap-4">
							<div
								class="flex size-12 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary"
							>
								<PackageIcon class="size-6" />
							</div>
							<div class="flex-1 min-w-0">
								<div class="flex items-center gap-2">
									<h3 class="font-semibold truncate">{item.dataset.name}</h3>
									{#if item.dataset.extra?.is_network}
										<Badge variant="secondary" class="h-5 text-[10px] uppercase font-bold tracking-wider">
											<StarIcon class="size-2.5 mr-1 fill-primary text-primary" />
											Network
										</Badge>
										<Button
											variant="ghost"
											size="icon"
											class="size-6 ml-auto -mr-1 text-muted-foreground hover:text-primary"
											onclick={(e) => {
												e.stopPropagation()
												unpinDataset(item.dataset.name)
											}}
											disabled={unpinning === item.dataset.name}
										>
											{#if unpinning === item.dataset.name}
												<Loader2Icon class="size-3 animate-spin" />
											{:else}
												<StarIcon class="size-3 fill-primary text-primary" />
											{/if}
										</Button>
									{/if}
								</div>
								<p class="text-muted-foreground text-sm mt-0.5">
									v{item.dataset.version || '1.0.0'}
									{#if item.assets}
										• {item.assets.length}
										{item.assets.length === 1 ? 'asset' : 'assets'}
									{/if}
								</p>
							</div>
							<ChevronRightIcon class="size-5 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity shrink-0" />
						</div>
						{#if item.dataset.description}
							<p class="text-muted-foreground text-sm mt-3 line-clamp-2">{item.dataset.description}</p>
						{/if}
					</button>
				{/each}
			</div>
		{/if}
	</div>
</div>

<CreateDatasetDialog bind:open={createDialogOpen} onCreated={handleDatasetCreated} />
