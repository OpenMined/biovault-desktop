<script lang="ts">
	import { invoke } from '@tauri-apps/api/core'
	import { onMount } from 'svelte'
	import { goto } from '$app/navigation'
	import { toast } from 'svelte-sonner'
	import PageHeader from '$lib/components/page-header.svelte'
	import { flowTemplates, templateColors, type FlowTemplate } from '$lib/data/flow-templates'
	import * as Empty from '$lib/components/ui/empty/index.js'
	import * as Card from '$lib/components/ui/card/index.js'
	import * as Avatar from '$lib/components/ui/avatar/index.js'
	import { Button } from '$lib/components/ui/button/index.js'
	import { Input } from '$lib/components/ui/input/index.js'
	import { Badge } from '$lib/components/ui/badge/index.js'
	import VerifyMockDialog from '$lib/components/verify-mock-dialog.svelte'
	import CompassIcon from '@lucide/svelte/icons/compass'
	import StarIcon from '@lucide/svelte/icons/star'
	import CheckCircleIcon from '@lucide/svelte/icons/check-circle'
	import Loader2Icon from '@lucide/svelte/icons/loader-2'
	import SearchIcon from '@lucide/svelte/icons/search'
	import DatabaseIcon from '@lucide/svelte/icons/database'
	import WorkflowIcon from '@lucide/svelte/icons/workflow'
	import GlobeIcon from '@lucide/svelte/icons/globe'
	import PackageIcon from '@lucide/svelte/icons/package'
	import UserIcon from '@lucide/svelte/icons/user'
	import ShieldCheckIcon from '@lucide/svelte/icons/shield-check'
	import DownloadIcon from '@lucide/svelte/icons/download'
	import FileIcon from '@lucide/svelte/icons/file'
	import SparklesIcon from '@lucide/svelte/icons/sparkles'
	import RocketIcon from '@lucide/svelte/icons/rocket'
	import RefreshCwIcon from '@lucide/svelte/icons/refresh-cw'
	import DnaIcon from '@lucide/svelte/icons/dna'
	import ScanEyeIcon from '@lucide/svelte/icons/scan-eye'
	import CheckIcon from '@lucide/svelte/icons/check'
	import UsersIcon from '@lucide/svelte/icons/users'

	interface DiscoveredDatasetAsset {
		key: string
		kind?: string
		mock_url?: string
		mock_size?: number
		mock_path?: string
		mock_entries: Array<{ url: string; participant_id?: string }>
	}

	interface DiscoveredDataset {
		name: string
		owner: string
		owner_fingerprint?: string
		description?: string
		version?: string
		schema?: string
		author?: string
		public_url?: string
		dataset_path: string
		assets: DiscoveredDatasetAsset[]
		is_trusted: boolean
		is_own: boolean
		available: boolean
		present_assets: number
		total_assets: number
		missing_assets: number
		downloaded_bytes: number
		expected_bytes?: number
	}

	interface NetworkDatasetScanResult {
		datasets: DiscoveredDataset[]
		current_identity: string
	}

	let loading = $state(true)
	let refreshing = $state(false)
	let activeTab = $state('all')
	let searchQuery = $state('')
	let datasets = $state<DiscoveredDataset[]>([])
	let currentIdentity = $state('')

	let verifyDialogOpen = $state(false)
	let selectedForVerify = $state<DiscoveredDataset | null>(null)
	let pinning = $state<string | null>(null)
	let unpinning = $state<string | null>(null)
	let localDatasetNames = $state<Set<string>>(new Set())

	async function loadLocalDatasetNames() {
		try {
			const localDatasets = await invoke<any[]>('list_datasets_with_assets')
			localDatasetNames = new Set(localDatasets.map((d) => d.dataset.name))
		} catch (e) {
			console.error('Failed to load local datasets:', e)
		}
	}

	async function pinDataset(dataset: DiscoveredDataset) {
		if (!dataset.public_url) return
		pinning = dataset.name
		try {
			await invoke('subscribe_dataset', {
				owner: dataset.owner,
				name: dataset.name
			})
			toast.success(`Starred ${dataset.name}`)
			await loadLocalDatasetNames()
		} catch (e) {
			toast.error(`Failed to star dataset: ${e}`)
		} finally {
			pinning = null
		}
	}

	async function unpinDataset(dataset: DiscoveredDataset) {
		unpinning = dataset.name
		try {
			await invoke('delete_dataset', { name: dataset.name })
			toast.success(`Unstarred ${dataset.name}`)
			await loadLocalDatasetNames()
		} catch (e) {
			toast.error(`Failed to unstar dataset: ${e}`)
		} finally {
			unpinning = null
		}
	}

	function openVerifyDialog(dataset: DiscoveredDataset) {
		selectedForVerify = dataset
		verifyDialogOpen = true
	}

	function extractMockUrls(dataset: DiscoveredDataset): string[] {
		const urls: string[] = []
		for (const asset of dataset.assets) {
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

	// Pipelines state
	interface InstalledPipeline {
		id: number
		name: string
		flow_path: string
	}
	let installedPipelines = $state<InstalledPipeline[]>([])
	let installingPipeline = $state<string | null>(null)

	// Check if a template is already installed
	function isInstalled(templateId: string): boolean {
		const templateName = flowTemplates.find((t) => t.id === templateId)?.name.toLowerCase()
		if (!templateName) return false
		return installedPipelines.some((p) => p.name.toLowerCase().includes(templateId))
	}

	// Get icon component for template
	function getTemplateIcon(icon: FlowTemplate['icon']) {
		switch (icon) {
			case 'dna':
				return DnaIcon
			case 'user':
				return UserIcon
			case 'scan-eye':
				return ScanEyeIcon
		}
	}

	async function loadInstalledPipelines() {
		try {
			installedPipelines = await invoke<InstalledPipeline[]>('get_flows')
		} catch (e) {
			console.error('Failed to load pipelines:', e)
		}
	}

	async function installPipeline(template: FlowTemplate) {
		installingPipeline = template.id
		try {
			await invoke('import_flow_with_deps', {
				url: template.sourceUrl,
				nameOverride: null,
				overwrite: true
			})
			await loadInstalledPipelines()
			toast.success(`Installed ${template.name}`, {
				description: 'Flow is now available in your Flows page'
			})
		} catch (e) {
			console.error('Failed to install pipeline:', e)
			toast.error(`Failed to install ${template.name}`, {
				description: e instanceof Error ? e.message : String(e)
			})
		} finally {
			installingPipeline = null
		}
	}

	// Filter datasets based on search query
	const filteredDatasets = $derived(() => {
		if (!searchQuery.trim()) return datasets
		const query = searchQuery.toLowerCase()
		return datasets.filter(
			(d) =>
				d.name.toLowerCase().includes(query) ||
				d.owner.toLowerCase().includes(query) ||
				d.description?.toLowerCase().includes(query)
		)
	})

	// Separate own datasets from others
	const ownDatasets = $derived(filteredDatasets().filter((d) => d.is_own))
	const communityDatasets = $derived(filteredDatasets().filter((d) => !d.is_own))

	async function loadDatasets() {
		try {
			const result = await invoke<NetworkDatasetScanResult>('network_scan_datasets')
			datasets = result.datasets
			currentIdentity = result.current_identity
		} catch (e) {
			console.error('Failed to load datasets:', e)
			datasets = []
		}
	}

	async function refresh() {
		refreshing = true
		await loadDatasets()
		refreshing = false
	}

	onMount(async () => {
		await Promise.all([loadDatasets(), loadInstalledPipelines(), loadLocalDatasetNames()])
		loading = false
	})

	function formatFileSize(bytes: number): string {
		if (bytes === 0) return '0 B'
		const k = 1024
		const sizes = ['B', 'KB', 'MB', 'GB']
		const i = Math.floor(Math.log(bytes) / Math.log(k))
		return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i]
	}

	function getInitials(email: string): string {
		return email.substring(0, 2).toUpperCase()
	}
</script>

<div class="flex h-full flex-col">
	<PageHeader title="Explore" description="Discover datasets, pipelines, and results from the community">
		<Button variant="outline" size="sm" onclick={refresh} disabled={refreshing}>
			{#if refreshing}
				<Loader2Icon class="size-4 animate-spin" />
			{:else}
				<RefreshCwIcon class="size-4" />
			{/if}
			Refresh
		</Button>
	</PageHeader>

	{#if loading}
		<div class="flex h-full items-center justify-center">
			<Loader2Icon class="size-8 animate-spin text-muted-foreground" />
		</div>
	{:else}
		<div class="flex-1 overflow-auto">
			<div class="p-6">
				<!-- Search and Filters -->
				<div class="mb-6">
					<div class="relative max-w-md">
						<SearchIcon class="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-muted-foreground" />
						<Input
							type="search"
							placeholder="Search datasets, pipelines, results..."
							class="pl-10"
							bind:value={searchQuery}
						/>
					</div>
				</div>

				<!-- Category Tabs -->
				<div class="mb-6">
					<div class="inline-flex items-center gap-1 p-1 bg-muted rounded-lg">
						<button
							class="inline-flex items-center gap-2 px-3 py-1.5 text-sm font-medium rounded-md transition-colors {activeTab === 'all' ? 'bg-background shadow-sm' : 'hover:bg-background/50'}"
							onclick={() => (activeTab = 'all')}
						>
							<PackageIcon class="size-4" />
							All
						</button>
						<button
							class="inline-flex items-center gap-2 px-3 py-1.5 text-sm font-medium rounded-md transition-colors {activeTab === 'datasets' ? 'bg-background shadow-sm' : 'hover:bg-background/50'}"
							onclick={() => (activeTab = 'datasets')}
						>
							<DatabaseIcon class="size-4" />
							Datasets
							{#if datasets.length > 0}
								<Badge variant="secondary" class="ml-1 text-xs">{datasets.length}</Badge>
							{/if}
						</button>
						<button
							class="inline-flex items-center gap-2 px-3 py-1.5 text-sm font-medium rounded-md transition-colors {activeTab === 'pipelines' ? 'bg-background shadow-sm' : 'hover:bg-background/50'}"
							onclick={() => (activeTab = 'pipelines')}
						>
							<WorkflowIcon class="size-4" />
							Pipelines
							<Badge variant="secondary" class="ml-1 text-xs">{flowTemplates.length}</Badge>
						</button>
						<button
							class="inline-flex items-center gap-2 px-3 py-1.5 text-sm font-medium rounded-md transition-colors {activeTab === 'results' ? 'bg-background shadow-sm' : 'hover:bg-background/50'}"
							onclick={() => (activeTab = 'results')}
						>
							<GlobeIcon class="size-4" />
							Results
							<Badge variant="outline" class="ml-1 text-xs text-muted-foreground">Soon</Badge>
						</button>
					</div>
				</div>

				{#snippet pipelineCard(template: FlowTemplate)}
					{@const Icon = getTemplateIcon(template.icon)}
					{@const colors = templateColors[template.color]}
					{@const installed = isInstalled(template.id)}
					<Card.Root class="hover:border-primary/50 transition-colors">
						<Card.Header class="pb-2">
							<div class="flex items-center gap-3">
								<div
									class="size-9 rounded-lg bg-gradient-to-br {colors.gradient} flex items-center justify-center text-white"
								>
									<Icon class="size-4" />
								</div>
								<div class="flex-1 min-w-0">
									<Card.Title class="text-sm">{template.name}</Card.Title>
									<p class="text-xs text-muted-foreground">{template.description}</p>
								</div>
							</div>
						</Card.Header>
						<Card.Content class="pt-2">
							<div class="flex items-center justify-between">
								<Badge variant="secondary" class="text-xs">Pipeline</Badge>
								{#if installed}
									<Badge variant="outline" class="text-xs text-green-600">
										<CheckIcon class="size-3 mr-1" />
										Installed
									</Badge>
								{:else}
									<Button
										variant="ghost"
										size="sm"
										class="h-7 text-xs"
										onclick={() => installPipeline(template)}
										disabled={installingPipeline !== null}
									>
										{#if installingPipeline === template.id}
											<Loader2Icon class="size-3 animate-spin" />
										{:else}
											<DownloadIcon class="size-3" />
											Install
										{/if}
									</Button>
								{/if}
							</div>
						</Card.Content>
					</Card.Root>
				{/snippet}

				{#snippet datasetCard(dataset: DiscoveredDataset)}
					<Card.Root class="hover:border-primary/50 transition-colors">
						<Card.Header class="pb-3">
							<div class="flex items-start justify-between gap-2">
								<div class="flex items-center gap-3">
									{#if dataset.is_own}
										<div class="size-10 rounded-lg bg-primary/10 flex items-center justify-center">
											<DatabaseIcon class="size-5 text-primary" />
										</div>
									{:else}
										<Avatar.Root class="size-10">
											<Avatar.Fallback>{getInitials(dataset.owner)}</Avatar.Fallback>
										</Avatar.Root>
									{/if}
									<div>
										<Card.Title class="text-base">{dataset.name}</Card.Title>
										<p class="text-xs text-muted-foreground truncate max-w-[150px]" title={dataset.owner}>
											{dataset.is_own ? 'by you' : dataset.owner}
										</p>
									</div>
								</div>
								<div class="flex items-center gap-1">
									{#if dataset.is_own}
										<Badge variant="secondary">Yours</Badge>
									{:else if dataset.is_trusted}
										<Badge variant="outline" class="text-emerald-600 border-emerald-200 bg-emerald-50">
											<ShieldCheckIcon class="size-3 mr-1" />
											Trusted
										</Badge>
									{/if}
								</div>
							</div>
						</Card.Header>
						<Card.Content>
							{#if dataset.description}
								<p class="text-sm text-muted-foreground mb-3 line-clamp-2">{dataset.description}</p>
							{/if}
							<div class="flex items-center justify-between">
								<div class="flex items-center gap-4 text-xs text-muted-foreground">
									<span class="flex items-center gap-1">
										<FileIcon class="size-3" />
										{dataset.total_assets} files
									</span>
									{#if dataset.expected_bytes || dataset.downloaded_bytes}
										<span>{formatFileSize(dataset.expected_bytes || dataset.downloaded_bytes)}</span>
									{/if}
								</div>
								{#if !dataset.is_own}
									{#if dataset.available}
										<Badge variant="secondary" class="text-xs">
											<DownloadIcon class="size-3 mr-1" />
											Available
										</Badge>
									{:else if dataset.missing_assets > 0}
										<Badge variant="outline" class="text-xs">
											{dataset.present_assets}/{dataset.total_assets} synced
										</Badge>
									{/if}
								{/if}
							</div>
							{#if !dataset.is_own}
								<div class="flex items-center gap-2 mt-4 pt-4 border-t">
									<Button
										variant="outline"
										size="sm"
										class="flex-1 text-xs"
										onclick={() => openVerifyDialog(dataset)}
									>
										<RocketIcon class="size-3 mr-1" />
										Verify Mock
									</Button>
									{#if localDatasetNames.has(dataset.name)}
										<Button
											variant="secondary"
											size="sm"
											class="text-xs gap-1.5"
											onclick={() => unpinDataset(dataset)}
											disabled={unpinning === dataset.name}
										>
											{#if unpinning === dataset.name}
												<Loader2Icon class="size-3 animate-spin" />
											{:else}
												<StarIcon class="size-3 fill-primary text-primary" />
												Starred
											{/if}
										</Button>
									{:else}
										<Button
											variant="outline"
											size="sm"
											class="text-xs"
											onclick={() => pinDataset(dataset)}
											disabled={pinning === dataset.name}
										>
											{#if pinning === dataset.name}
												<Loader2Icon class="size-3 animate-spin" />
											{:else}
												<StarIcon class="size-3" />
											{/if}
										</Button>
									{/if}
								</div>
							{/if}
						</Card.Content>
					</Card.Root>
				{/snippet}

				<!-- All Tab -->
				{#if activeTab === 'all'}
					<!-- Official Pipelines Section -->
					<div class="mb-8">
						<h3 class="text-sm font-medium text-muted-foreground mb-4 flex items-center gap-2">
							<ShieldCheckIcon class="size-4" />
							Official Pipelines
						</h3>
						<div class="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
							{#each flowTemplates as template (template.id)}
								{@render pipelineCard(template)}
							{/each}
						</div>
					</div>

					<!-- Your Datasets Section -->
					{#if ownDatasets.length > 0}
						<div class="mb-8">
							<h3 class="text-sm font-medium text-muted-foreground mb-4 flex items-center gap-2">
								<UserIcon class="size-4" />
								Your Published Datasets
							</h3>
							<div class="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
								{#each ownDatasets as dataset}
									{@render datasetCard(dataset)}
								{/each}
							</div>
						</div>
					{/if}

					<!-- Community Datasets Section -->
					{#if communityDatasets.length > 0}
						<div class="mb-8">
							<h3 class="text-sm font-medium text-muted-foreground mb-4 flex items-center gap-2">
								<GlobeIcon class="size-4" />
								Community Datasets
							</h3>
							<div class="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
								{#each communityDatasets as dataset}
									{@render datasetCard(dataset)}
								{/each}
							</div>
						</div>
					{/if}

					<!-- Empty state if nothing at all -->
					{#if datasets.length === 0}
						<div class="mt-4 p-6 rounded-lg border border-dashed bg-muted/30">
							<div class="flex items-center gap-4">
								<div class="size-12 rounded-full bg-muted flex items-center justify-center">
									<DatabaseIcon class="size-6 text-muted-foreground" />
								</div>
								<div>
									<h4 class="font-medium">No datasets discovered yet</h4>
									<p class="text-sm text-muted-foreground">
										Connect to the SyftBox network to discover datasets from peers.
									</p>
								</div>
							</div>
						</div>
					{/if}
				{/if}

				<!-- Datasets Tab -->
				{#if activeTab === 'datasets'}
					{#if filteredDatasets().length === 0}
						<Empty.Root>
							<Empty.Header>
								<Empty.Media variant="icon">
									<DatabaseIcon class="size-6" />
								</Empty.Media>
								<Empty.Title>No Datasets Found</Empty.Title>
								<Empty.Description>
									{#if searchQuery}
										No datasets match your search. Try a different query.
									{:else}
										Datasets from your network will appear here.
									{/if}
								</Empty.Description>
							</Empty.Header>
						</Empty.Root>
					{:else}
						<div class="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
							{#each filteredDatasets() as dataset}
								{@render datasetCard(dataset)}
							{/each}
						</div>
					{/if}
				{/if}

				<!-- Pipelines Tab -->
				{#if activeTab === 'pipelines'}
					<!-- From BioVault Team Section -->
					<div class="mb-8">
						<h3 class="text-sm font-medium text-muted-foreground mb-4 flex items-center gap-2">
							<ShieldCheckIcon class="size-4" />
							From BioVault Team
						</h3>
						<div class="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
							{#each flowTemplates as template (template.id)}
								{@render pipelineCard(template)}
							{/each}
						</div>
					</div>

					<!-- From Community Section -->
					<div>
						<h3 class="text-sm font-medium text-muted-foreground mb-4 flex items-center gap-2">
							<UsersIcon class="size-4" />
							From Community
						</h3>
						<div class="flex items-center justify-center min-h-[200px] rounded-lg border border-dashed bg-muted/30">
							<div class="text-center p-6">
								<UsersIcon class="size-10 mx-auto mb-3 text-muted-foreground/50" />
								<p class="text-sm font-medium text-muted-foreground">No community pipelines yet</p>
								<p class="text-xs text-muted-foreground mt-1">
									Community-shared pipelines will appear here
								</p>
							</div>
						</div>
					</div>
				{/if}

				<!-- Results Tab (Coming Soon) -->
				{#if activeTab === 'results'}
					<div class="flex items-center justify-center min-h-[400px]">
						<Empty.Root>
							<Empty.Header>
								<Empty.Media variant="icon">
									<SparklesIcon class="size-6" />
								</Empty.Media>
								<Empty.Title>Results Showcase Coming Soon</Empty.Title>
								<Empty.Description class="max-w-md">
									Explore published results, visualizations, and research findings from the BioVault community. Share your discoveries and see what others have achieved.
								</Empty.Description>
							</Empty.Header>
							<Empty.Content>
								<div class="flex flex-wrap gap-2 justify-center">
									<Badge variant="outline">Visualizations</Badge>
									<Badge variant="outline">Publications</Badge>
									<Badge variant="outline">Interactive Reports</Badge>
									<Badge variant="outline">Benchmarks</Badge>
								</div>
							</Empty.Content>
						</Empty.Root>
					</div>
				{/if}
			</div>
		</div>
	{/if}
</div>

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
