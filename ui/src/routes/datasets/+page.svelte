<script lang="ts">
	import { goto } from '$app/navigation'
	import { invoke } from '@tauri-apps/api/core'
	import { onMount } from 'svelte'
	import PageHeader from '$lib/components/page-header.svelte'
	import CreateDatasetDialog from '$lib/components/create-dataset-dialog.svelte'
	import CommunityDatasetCard from '$lib/components/community-dataset-card.svelte'
	import VerifyMockDialog from '$lib/components/verify-mock-dialog.svelte'
	import * as Empty from '$lib/components/ui/empty/index.js'
	import * as Tooltip from '$lib/components/ui/tooltip/index.js'
	import { Button } from '$lib/components/ui/button/index.js'
	import DatabaseIcon from '@lucide/svelte/icons/database'
	import PlusIcon from '@lucide/svelte/icons/plus'
	import UploadIcon from '@lucide/svelte/icons/upload'
	import PackageIcon from '@lucide/svelte/icons/package'
	import StarIcon from '@lucide/svelte/icons/star'
	import CircleHelpIcon from '@lucide/svelte/icons/circle-help'
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

	interface DiscoveredDatasetAsset {
		key: string
		kind?: string
		mock_url?: string
		mock_size?: number
		mock_path?: string
		mock_entries?: Array<{ url: string; participant_id?: string }>
	}

	interface FavoritedCommunityDataset {
		name: string
		owner: string
		description?: string
		assets: DiscoveredDatasetAsset[]
		total_assets: number
		present_assets: number
		is_subscribed: boolean
		is_own: boolean
	}

	interface NetworkDatasetScanResult {
		datasets: FavoritedCommunityDataset[]
	}

	let datasets: DatasetWithAssets[] = $state([])
	let favoritedCommunityDatasets: FavoritedCommunityDataset[] = $state([])
	let loading = $state(true)
	let error: string | null = $state(null)
	let createDialogOpen = $state(false)
	let unpinning = $state<string | null>(null)
	let verifyDialogOpen = $state(false)
	let selectedForVerify = $state<FavoritedCommunityDataset | null>(null)

	async function loadDatasets() {
		try {
			loading = true
			error = null
			datasets = await invoke<DatasetWithAssets[]>('list_datasets_with_assets')
		} catch (e) {
			error = e instanceof Error ? e.message : String(e)
		} finally {
			loading = false
		}
	}

	async function loadFavoritedCommunityDatasets() {
		try {
			const result = await invoke<NetworkDatasetScanResult>('network_scan_datasets')
			favoritedCommunityDatasets = (result.datasets || []).filter(
				(dataset) => dataset.is_subscribed && !dataset.is_own
			)
		} catch (e) {
			console.error('Failed to load favorited community datasets:', e)
			favoritedCommunityDatasets = []
		}
	}

	function favoritedKey(owner: string, name: string): string {
		return `${owner.toLowerCase()}::${name.toLowerCase()}`
	}

	async function unpinDataset(owner: string, name: string) {
		const key = favoritedKey(owner, name)
		unpinning = key
		try {
			await invoke('unsubscribe_dataset', { owner, name })
			toast.success(`Unstarred ${name}`)
			await Promise.all([loadDatasets(), loadFavoritedCommunityDatasets()])
		} catch (e) {
			toast.error(`Failed to unstar dataset: ${e}`)
		} finally {
			unpinning = null
		}
	}

	function handleDatasetCreated() {
		void Promise.all([loadDatasets(), loadFavoritedCommunityDatasets()])
	}

	function openFavoritedDataset(item: FavoritedCommunityDataset) {
		const hasLocalCopy = datasets.some((d) => d.dataset.name === item.name)
		if (hasLocalCopy) {
			goto(`/datasets/${item.name}`)
			return
		}
		goto('/explore')
	}

	function openVerifyDialog(item: FavoritedCommunityDataset) {
		selectedForVerify = item
		verifyDialogOpen = true
	}

	function extractMockUrls(dataset: FavoritedCommunityDataset): string[] {
		const urls: string[] = []
		for (const asset of dataset.assets || []) {
			if (asset.mock_entries && asset.mock_entries.length > 0) {
				for (const entry of asset.mock_entries) {
					urls.push(entry.url)
				}
			} else if (asset.mock_url) {
				urls.push(asset.mock_url)
			}
		}
		return urls
	}

	onMount(async () => {
		await Promise.all([loadDatasets(), loadFavoritedCommunityDatasets()])
	})
</script>

<div class="flex h-full flex-col">
	<PageHeader title="Datasets" description="Manage your datasets and data sources">
		<Button size="sm" data-testid="datasets-new" onclick={() => (createDialogOpen = true)}>
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
		{:else if datasets.length === 0 && favoritedCommunityDatasets.length === 0}
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
							<Button data-testid="datasets-create" onclick={() => (createDialogOpen = true)}>
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
			<div class="space-y-8">
				{#if favoritedCommunityDatasets.length > 0}
					<section>
						<div class="mb-3 flex items-center gap-2">
							<StarIcon class="size-4 fill-foreground text-foreground" />
							<h2 class="text-sm font-semibold">Favorited Community Datasets</h2>
							<Tooltip.Root>
								<Tooltip.Trigger
									class="text-muted-foreground hover:text-foreground rounded-sm transition-colors"
									aria-label="About favorited datasets"
								>
									<CircleHelpIcon class="size-3.5" />
								</Tooltip.Trigger>
								<Tooltip.Content side="top" class="max-w-xs">
									<p>
										Favoriting a community dataset also subscribes it for sync, so updates can be fetched locally.
									</p>
								</Tooltip.Content>
							</Tooltip.Root>
							<Badge variant="secondary">{favoritedCommunityDatasets.length}</Badge>
						</div>
						<div class="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
							{#each favoritedCommunityDatasets as item (favoritedKey(item.owner, item.name))}
								<CommunityDatasetCard
									name={item.name}
									owner={item.owner}
									description={item.description}
									totalAssets={item.total_assets}
									presentAssets={item.present_assets}
									available={item.present_assets === item.total_assets && item.total_assets > 0}
									starred={true}
									showVerifyMock={true}
									onVerifyMock={() => openVerifyDialog(item)}
									unpinning={unpinning === favoritedKey(item.owner, item.name)}
									onUnstar={() => unpinDataset(item.owner, item.name)}
									onOpen={() => openFavoritedDataset(item)}
								/>
							{/each}
						</div>
					</section>
				{/if}

				<section>
					<div class="mb-3 flex items-center gap-2">
						<PackageIcon class="size-4" />
						<h2 class="text-sm font-semibold">Local Datasets</h2>
						<Badge variant="outline">{datasets.length}</Badge>
					</div>
					<div class="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
						{#each datasets as item (item.dataset.name)}
							<button
								type="button"
								onclick={() => goto(`/datasets/${item.dataset.name}`)}
								data-testid={`dataset-card-${item.dataset.name}`}
								class="rounded-lg border bg-card p-4 text-left transition-colors hover:border-primary/40 cursor-pointer"
							>
								<div class="flex items-start gap-3">
									<div
										class="flex size-9 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary"
									>
										<PackageIcon class="size-4" />
									</div>
									<div class="flex-1 min-w-0">
										<div class="flex items-center gap-2">
											<h3 class="truncate text-sm font-semibold">{item.dataset.name}</h3>
											{#if item.dataset.extra?.is_network}
												<Badge variant="outline" class="h-5 text-[10px] uppercase tracking-wider">
													<StarIcon class="mr-1 size-2.5 fill-foreground text-foreground" />
													Network
												</Badge>
											{/if}
										</div>
										<p class="mt-0.5 text-xs text-muted-foreground">
											v{item.dataset.version || '1.0.0'}
											{#if item.assets}
												• {item.assets.length}
												{item.assets.length === 1 ? 'asset' : 'assets'}
											{/if}
										</p>
									</div>
								</div>
								{#if item.dataset.description}
									<p class="mt-2 line-clamp-2 text-sm text-muted-foreground">{item.dataset.description}</p>
								{/if}
							</button>
						{/each}
					</div>
				</section>
			</div>
		{/if}
	</div>
</div>

<CreateDatasetDialog bind:open={createDialogOpen} onCreated={handleDatasetCreated} />

{#if selectedForVerify}
	<VerifyMockDialog
		bind:open={verifyDialogOpen}
		datasetName={selectedForVerify.name}
		mockUrls={extractMockUrls(selectedForVerify)}
		onRunStarted={() => {
			toast.success('Verification run started')
			goto('/runs')
		}}
	/>
{/if}
