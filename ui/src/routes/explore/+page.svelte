<script lang="ts">
	import { invoke } from '@tauri-apps/api/core'
	import { onMount } from 'svelte'
	import { goto } from '$app/navigation'
	import { toast } from 'svelte-sonner'
	import PageHeader from '$lib/components/page-header.svelte'
	import CommunityDatasetCard from '$lib/components/community-dataset-card.svelte'
	import { flowTemplates, templateColors, type FlowTemplate } from '$lib/data/flow-templates'
	import * as Empty from '$lib/components/ui/empty/index.js'
	import * as Card from '$lib/components/ui/card/index.js'
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
		is_subscribed: boolean
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
	let subscribedDatasetKeys = $state<Set<string>>(new Set())

	function datasetKey(owner: string, name: string): string {
		return `${owner.toLowerCase()}::${name.toLowerCase()}`
	}

	async function pinDataset(dataset: DiscoveredDataset) {
		if (!dataset.public_url) return
		const key = datasetKey(dataset.owner, dataset.name)
		pinning = key
		subscribedDatasetKeys = new Set([...subscribedDatasetKeys, key])
		try {
			await invoke('subscribe_dataset', {
				owner: dataset.owner,
				name: dataset.name
			})
			toast.success(`Starred ${dataset.name}`)
		} catch (e) {
			const next = new Set(subscribedDatasetKeys)
			next.delete(key)
			subscribedDatasetKeys = next
			toast.error(`Failed to star dataset: ${e}`)
		} finally {
			pinning = null
		}
	}

	async function unpinDataset(dataset: DiscoveredDataset) {
		const key = datasetKey(dataset.owner, dataset.name)
		unpinning = key
		const next = new Set(subscribedDatasetKeys)
		next.delete(key)
		subscribedDatasetKeys = next
		try {
			await invoke('unsubscribe_dataset', { owner: dataset.owner, name: dataset.name })
			toast.success(`Unstarred ${dataset.name}`)
		} catch (e) {
			subscribedDatasetKeys = new Set([...subscribedDatasetKeys, key])
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
	interface ModuleListEntry {
		name: string
		version?: string | null
	}
	type LocalFlowTemplates = Record<string, string>
	let installedPipelines = $state<InstalledPipeline[]>([])
	let installingPipeline = $state<string | null>(null)
	let localFlowTemplates = $state<LocalFlowTemplates>({})
	let installedModuleRefs = $state<Set<string>>(new Set())

	function normalizeModuleRef(value: string): string {
		return value.trim().toLowerCase()
	}

	function isModuleInstalled(dep: string): boolean {
		return installedModuleRefs.has(normalizeModuleRef(dep))
	}

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

	async function loadInstalledModules() {
		try {
			const modules = await invoke<ModuleListEntry[]>('get_modules')
			const refs = new Set<string>()
			for (const module of modules || []) {
				const name = (module.name || '').trim()
				if (!name) continue
				refs.add(normalizeModuleRef(name))
				const version = typeof module.version === 'string' ? module.version.trim() : ''
				if (version) refs.add(normalizeModuleRef(`${name}@${version}`))
			}
			installedModuleRefs = refs
		} catch {
			installedModuleRefs = new Set()
		}
	}

	async function installPipeline(template: FlowTemplate) {
		installingPipeline = template.id
		try {
			const localSource =
				template.localTemplateKey && localFlowTemplates[template.localTemplateKey]
					? localFlowTemplates[template.localTemplateKey]
					: null
			await invoke('import_flow_with_deps', {
				url: localSource || template.sourceUrl,
				nameOverride: null,
				overwrite: true
			})
			await loadInstalledPipelines()
			await loadInstalledModules()
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
			subscribedDatasetKeys = new Set(
				result.datasets
					.filter((d) => d.is_subscribed)
					.map((d) => datasetKey(d.owner, d.name))
			)
		} catch (e) {
			console.error('Failed to load datasets:', e)
			datasets = []
			subscribedDatasetKeys = new Set()
		}
	}

	async function loadLocalFlowTemplates() {
		try {
			localFlowTemplates = await invoke<LocalFlowTemplates>('get_local_flow_templates')
		} catch {
			localFlowTemplates = {}
		}
	}

	async function refresh() {
		refreshing = true
		await loadDatasets()
		refreshing = false
	}

	onMount(async () => {
		await Promise.all([
			loadDatasets(),
			loadInstalledPipelines(),
			loadLocalFlowTemplates(),
			loadInstalledModules()
		])
		loading = false
	})

	function formatFileSize(bytes: number): string {
		if (bytes === 0) return '0 B'
		const k = 1024
		const sizes = ['B', 'KB', 'MB', 'GB']
		const i = Math.floor(Math.log(bytes) / Math.log(k))
		return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i]
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
							{#if template.dependencies && template.dependencies.length > 0}
								<div class="mb-2">
									<div class="text-[11px] text-muted-foreground mb-1">Dependencies</div>
									<div class="flex flex-wrap gap-1">
										{#each template.dependencies as dep (dep)}
											<Badge
												variant="outline"
												class={`text-[10px] ${
													isModuleInstalled(dep)
														? 'border-emerald-500/40 text-emerald-700'
														: 'border-amber-500/40 text-amber-700'
												}`}
											>
												{dep} • {isModuleInstalled(dep) ? 'installed' : 'missing'}
											</Badge>
										{/each}
									</div>
								</div>
							{/if}
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

				{#snippet ownDatasetCard(dataset: DiscoveredDataset)}
					<Card.Root class="rounded-lg border bg-card p-4 transition-colors hover:border-primary/40">
						<div class="space-y-3">
							<div class="flex items-start justify-between gap-3">
								<div class="flex items-center gap-2.5 min-w-0">
									<div class="flex size-9 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary">
										<DatabaseIcon class="size-4" />
									</div>
									<div class="min-w-0">
										<Card.Title class="truncate text-sm">{dataset.name}</Card.Title>
										<p class="truncate text-xs text-muted-foreground" title={dataset.owner}>by you</p>
									</div>
								</div>
								<Badge variant="secondary" class="h-5 text-[10px]">Yours</Badge>
							</div>
							{#if dataset.description}
								<p class="line-clamp-2 min-h-9 text-sm text-muted-foreground">{dataset.description}</p>
							{/if}
							<div class="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
								<span class="inline-flex items-center gap-1">
										<FileIcon class="size-3" />
										{dataset.total_assets} files
								</span>
								{#if dataset.expected_bytes || dataset.downloaded_bytes}
									<span>{formatFileSize(dataset.expected_bytes || dataset.downloaded_bytes)}</span>
								{/if}
							</div>
						</div>
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
									{@render ownDatasetCard(dataset)}
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
									<CommunityDatasetCard
										name={dataset.name}
										owner={dataset.owner}
										description={dataset.description}
										totalAssets={dataset.total_assets}
										presentAssets={dataset.present_assets}
										expectedBytes={dataset.expected_bytes}
										downloadedBytes={dataset.downloaded_bytes}
										available={dataset.available}
										starred={subscribedDatasetKeys.has(datasetKey(dataset.owner, dataset.name))}
										pinning={pinning === datasetKey(dataset.owner, dataset.name)}
										unpinning={unpinning === datasetKey(dataset.owner, dataset.name)}
										showVerifyMock={true}
										onVerifyMock={() => openVerifyDialog(dataset)}
										onStar={() => pinDataset(dataset)}
										onUnstar={() => unpinDataset(dataset)}
									/>
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
								{#if dataset.is_own}
									{@render ownDatasetCard(dataset)}
								{:else}
									<CommunityDatasetCard
										name={dataset.name}
										owner={dataset.owner}
										description={dataset.description}
										totalAssets={dataset.total_assets}
										presentAssets={dataset.present_assets}
										expectedBytes={dataset.expected_bytes}
										downloadedBytes={dataset.downloaded_bytes}
										available={dataset.available}
										starred={subscribedDatasetKeys.has(datasetKey(dataset.owner, dataset.name))}
										pinning={pinning === datasetKey(dataset.owner, dataset.name)}
										unpinning={unpinning === datasetKey(dataset.owner, dataset.name)}
										showVerifyMock={true}
										onVerifyMock={() => openVerifyDialog(dataset)}
										onStar={() => pinDataset(dataset)}
										onUnstar={() => unpinDataset(dataset)}
									/>
								{/if}
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
