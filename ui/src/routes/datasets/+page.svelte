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
	import FolderIcon from '@lucide/svelte/icons/folder'
	import { Badge } from '$lib/components/ui/badge/index.js'
	import { toast } from 'svelte-sonner'

	const PENDING_DATASET_IMPORT_KEY = 'biovault.pendingDatasetImportPaths'

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
	let importDropActive = $state(false)

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

	function storePendingDatasetImport(paths: string[]) {
		sessionStorage.setItem(PENDING_DATASET_IMPORT_KEY, JSON.stringify(paths))
	}

	async function startImportedDataset(paths: string[]) {
		const normalized = [...new Set(paths.map((path) => path.trim()).filter(Boolean))]
		if (normalized.length === 0) {
			toast.error('No readable file or folder paths found')
			return
		}
		storePendingDatasetImport(normalized)
		await goto('/datasets/new?source=import')
	}

	async function selectImportFiles() {
		try {
			const { open: openDialog } = await import('@tauri-apps/plugin-dialog')
			const selected = await openDialog({
				multiple: true,
				directory: false,
				title: 'Select Files for Dataset',
			})
			if (selected && Array.isArray(selected)) {
				await startImportedDataset(selected)
			}
		} catch (e) {
			toast.error('Failed to select files', {
				description: e instanceof Error ? e.message : String(e),
			})
		}
	}

	async function selectImportFolder() {
		try {
			const { open: openDialog } = await import('@tauri-apps/plugin-dialog')
			const selected = await openDialog({
				multiple: false,
				directory: true,
				title: 'Select Folder for Dataset',
			})
			if (selected && typeof selected === 'string') {
				await startImportedDataset([selected])
			}
		} catch (e) {
			toast.error('Failed to select folder', {
				description: e instanceof Error ? e.message : String(e),
			})
		}
	}

	function handleImportDragOver(event: DragEvent) {
		event.preventDefault()
		importDropActive = true
	}

	function handleImportDragLeave(event: DragEvent) {
		event.preventDefault()
		importDropActive = false
	}

	async function handleImportDrop(event: DragEvent) {
		event.preventDefault()
		importDropActive = false
		const files = Array.from(event.dataTransfer?.files || [])
		const paths = files
			.map((file) => (file as File & { path?: string }).path)
			.filter((path): path is string => typeof path === 'string' && path.trim().length > 0)

		if (paths.length === 0) {
			toast.error('Could not read dropped file or folder paths', {
				description: 'Use Select Files or Select Folder if drag and drop is unavailable.',
			})
			return
		}

		await startImportedDataset(paths)
	}
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
							Drop in files or a folder to start a dataset immediately, or browse what already exists in BioVault Explorer.
						</Empty.Description>
					</Empty.Header>
					<Empty.Content>
						<div class="mx-auto flex w-full max-w-2xl flex-col gap-4">
							<div
								class="bg-card rounded-xl border border-dashed p-8 text-center transition-colors {importDropActive
									? 'border-primary bg-primary/5'
									: 'border-border'}"
								role="region"
								aria-label="Dataset import dropzone"
								ondragover={handleImportDragOver}
								ondragleave={handleImportDragLeave}
								ondrop={handleImportDrop}
							>
								<div class="mx-auto mb-4 flex size-12 items-center justify-center rounded-full bg-primary/10 text-primary">
									<UploadIcon class="size-5" />
								</div>
								<div class="space-y-2">
									<h3 class="text-base font-semibold">Drop files or a folder here</h3>
									<p class="text-muted-foreground text-sm">
										You can drag and drop files or folders, or pick them directly to open the dataset builder with everything staged.
									</p>
								</div>
								<div class="mt-5 flex flex-wrap items-center justify-center gap-2">
									<Button data-testid="datasets-import-files" onclick={selectImportFiles}>
										<UploadIcon class="size-4" />
										Select Files
									</Button>
									<Button variant="outline" onclick={selectImportFolder}>
										<FolderIcon class="size-4" />
										Select Folder
									</Button>
								</div>
							</div>

							<div class="flex items-center justify-center">
								<Button variant="outline" onclick={() => goto('/explore')}>
									<DatabaseIcon class="size-4" />
									Explore Datasets in BioVault Explorer
								</Button>
							</div>
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

<CreateDatasetDialog
	bind:open={createDialogOpen}
	onCreated={handleDatasetCreated}
	onExplore={() => goto('/explore')}
	onImportFiles={selectImportFiles}
	onImportFolder={selectImportFolder}
/>

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
