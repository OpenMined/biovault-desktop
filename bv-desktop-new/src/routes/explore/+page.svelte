<script lang="ts">
	import { invoke } from '@tauri-apps/api/core'
	import { onMount } from 'svelte'
	import PageHeader from '$lib/components/page-header.svelte'
	import * as Empty from '$lib/components/ui/empty/index.js'
	import * as Card from '$lib/components/ui/card/index.js'
	import * as Avatar from '$lib/components/ui/avatar/index.js'
	import { Button } from '$lib/components/ui/button/index.js'
	import { Input } from '$lib/components/ui/input/index.js'
	import { Badge } from '$lib/components/ui/badge/index.js'
	import CompassIcon from '@lucide/svelte/icons/compass'
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
		assets: Array<{ name: string; size?: number }>
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
		await loadDatasets()
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
							<Badge variant="outline" class="ml-1 text-xs text-muted-foreground">Soon</Badge>
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

				<!-- All Tab -->
				{#if activeTab === 'all'}
					{#if datasets.length === 0}
						<Empty.Root>
							<Empty.Header>
								<Empty.Media variant="icon">
									<CompassIcon class="size-6" />
								</Empty.Media>
								<Empty.Title>No Items Yet</Empty.Title>
								<Empty.Description>
									Datasets from your network will appear here. Make sure you're connected to peers who have published datasets.
								</Empty.Description>
							</Empty.Header>
						</Empty.Root>
					{:else}
						<!-- Your Datasets Section -->
						{#if ownDatasets.length > 0}
							<div class="mb-8">
								<h3 class="text-sm font-medium text-muted-foreground mb-4 flex items-center gap-2">
									<UserIcon class="size-4" />
									Your Published Datasets
								</h3>
								<div class="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
									{#each ownDatasets as dataset}
										<Card.Root class="hover:border-primary/50 transition-colors">
											<Card.Header class="pb-3">
												<div class="flex items-start justify-between gap-2">
													<div class="flex items-center gap-3">
														<div class="size-10 rounded-lg bg-primary/10 flex items-center justify-center">
															<DatabaseIcon class="size-5 text-primary" />
														</div>
														<div>
															<Card.Title class="text-base">{dataset.name}</Card.Title>
															<p class="text-xs text-muted-foreground">by you</p>
														</div>
													</div>
													<Badge variant="secondary">Yours</Badge>
												</div>
											</Card.Header>
											<Card.Content>
												{#if dataset.description}
													<p class="text-sm text-muted-foreground mb-3 line-clamp-2">{dataset.description}</p>
												{/if}
												<div class="flex items-center gap-4 text-xs text-muted-foreground">
													<span class="flex items-center gap-1">
														<FileIcon class="size-3" />
														{dataset.total_assets} files
													</span>
													{#if dataset.downloaded_bytes > 0}
														<span>{formatFileSize(dataset.downloaded_bytes)}</span>
													{/if}
												</div>
											</Card.Content>
										</Card.Root>
									{/each}
								</div>
							</div>
						{/if}

						<!-- Community Datasets Section -->
						{#if communityDatasets.length > 0}
							<div>
								<h3 class="text-sm font-medium text-muted-foreground mb-4 flex items-center gap-2">
									<GlobeIcon class="size-4" />
									From the Community
								</h3>
								<div class="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
									{#each communityDatasets as dataset}
										<Card.Root class="hover:border-primary/50 transition-colors">
											<Card.Header class="pb-3">
												<div class="flex items-start justify-between gap-2">
													<div class="flex items-center gap-3">
														<Avatar.Root class="size-10">
															<Avatar.Fallback>{getInitials(dataset.owner)}</Avatar.Fallback>
														</Avatar.Root>
														<div>
															<Card.Title class="text-base">{dataset.name}</Card.Title>
															<p class="text-xs text-muted-foreground truncate max-w-[150px]" title={dataset.owner}>
																{dataset.owner}
															</p>
														</div>
													</div>
													{#if dataset.is_trusted}
														<Badge variant="outline" class="text-emerald-600 border-emerald-200 bg-emerald-50">
															<ShieldCheckIcon class="size-3 mr-1" />
															Trusted
														</Badge>
													{/if}
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
														{#if dataset.expected_bytes}
															<span>{formatFileSize(dataset.expected_bytes)}</span>
														{/if}
													</div>
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
												</div>
											</Card.Content>
										</Card.Root>
									{/each}
								</div>
							</div>
						{/if}

						<!-- Coming Soon Teaser -->
						<div class="mt-8 p-6 rounded-lg border border-dashed bg-muted/30">
							<div class="flex items-center gap-4">
								<div class="size-12 rounded-full bg-primary/10 flex items-center justify-center">
									<RocketIcon class="size-6 text-primary" />
								</div>
								<div>
									<h4 class="font-medium">More coming soon!</h4>
									<p class="text-sm text-muted-foreground">
										Pipelines and Results will be available here. Stay tuned for workflow sharing, GitHub integration, and community showcases.
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
										</div>
									</Card.Content>
								</Card.Root>
							{/each}
						</div>
					{/if}
				{/if}

				<!-- Pipelines Tab (Coming Soon) -->
				{#if activeTab === 'pipelines'}
					<div class="flex items-center justify-center min-h-[400px]">
						<Empty.Root>
							<Empty.Header>
								<Empty.Media variant="icon">
									<WorkflowIcon class="size-6" />
								</Empty.Media>
								<Empty.Title>Pipelines Coming Soon</Empty.Title>
								<Empty.Description class="max-w-md">
									Discover and share analysis pipelines with the community. Browse workflows, see GitHub stars, and import pipelines directly into your projects.
								</Empty.Description>
							</Empty.Header>
							<Empty.Content>
								<div class="flex flex-wrap gap-2 justify-center">
									<Badge variant="outline">Nextflow</Badge>
									<Badge variant="outline">GitHub Integration</Badge>
									<Badge variant="outline">Version Control</Badge>
									<Badge variant="outline">Templates</Badge>
								</div>
							</Empty.Content>
						</Empty.Root>
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
