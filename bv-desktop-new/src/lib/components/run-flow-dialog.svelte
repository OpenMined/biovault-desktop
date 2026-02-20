<script lang="ts">
	import { invoke } from '@tauri-apps/api/core'
	import * as Dialog from '$lib/components/ui/dialog/index.js'
	import { Button, buttonVariants } from '$lib/components/ui/button/index.js'
	import PackageIcon from '@lucide/svelte/icons/package'
	import PlayIcon from '@lucide/svelte/icons/play'
	import LoaderIcon from '@lucide/svelte/icons/loader'
	import CheckIcon from '@lucide/svelte/icons/check'
	import AlertCircleIcon from '@lucide/svelte/icons/alert-circle'
	import InfoIcon from '@lucide/svelte/icons/info'

	interface DatasetAsset {
		asset_key: string
		asset_uuid?: string
		kind?: string
		url?: string
		private_ref?: string
		mock_ref?: string
		private_path?: string
		mock_path?: string
		resolved_private_path?: string
		resolved_mock_path?: string
		private_file_id?: number
		mock_file_id?: number
	}

	interface DatasetWithAssets {
		dataset: {
			id: number
			name: string
			version: string
			author: string
			description?: string
		}
		assets: DatasetAsset[]
	}

	interface Props {
		open?: boolean
		onOpenChange?: (open: boolean) => void
		pipelineId: number
		pipelineName: string
		onRunStarted?: () => void
	}

	let { open = $bindable(false), onOpenChange, pipelineId, pipelineName, onRunStarted }: Props =
		$props()

	let datasets: DatasetWithAssets[] = $state([])
	let loading = $state(true)
	let running = $state(false)
	let error = $state<string | null>(null)
	let selectedDataset: DatasetWithAssets | null = $state(null)
	let runWithoutDataset = $state(false)

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

	function handleOpenChange(newOpen: boolean) {
		open = newOpen
		onOpenChange?.(newOpen)
		if (newOpen) {
			// Reset state when opening
			selectedDataset = null
			runWithoutDataset = false
			error = null
			loadDatasets()
		}
	}

	// Extract file URLs from dataset assets
	function extractUrlsFromAssets(assets: DatasetAsset[]): string[] {
		const urls: string[] = []

		for (const asset of assets) {
			// Try to get the file path in order of preference:
			// 1. resolved_private_path (actual file on disk)
			// 2. resolved_mock_path
			// 3. private_path
			// 4. mock_path
			// 5. Parse from private_ref/mock_ref if they contain URLs

			const path =
				asset.resolved_private_path ||
				asset.resolved_mock_path ||
				asset.private_path ||
				asset.mock_path

			if (path) {
				// Convert to file:// URL if it's a path
				if (path.startsWith('/')) {
					urls.push(`file://${path}`)
				} else if (path.startsWith('syft://') || path.startsWith('file://')) {
					urls.push(path)
				} else {
					urls.push(path)
				}
				continue
			}

			// Try parsing refs for URLs
			for (const ref of [asset.private_ref, asset.mock_ref]) {
				if (!ref) continue
				const trimmed = ref.trim()

				// If it's a plain URL
				if (trimmed.startsWith('syft://') || trimmed.startsWith('file://')) {
					urls.push(trimmed)
					break
				}

				// If it's JSON, try to extract URL
				if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
					try {
						const parsed = JSON.parse(trimmed)
						if (parsed.url) {
							urls.push(parsed.url)
							break
						}
						if (parsed.entries && Array.isArray(parsed.entries)) {
							for (const entry of parsed.entries) {
								if (entry.url) {
									urls.push(entry.url)
								}
							}
							break
						}
					} catch {
						// Ignore parse errors
					}
				}
			}
		}

		return urls
	}

	async function runFlow() {
		running = true
		error = null

		try {
			if (runWithoutDataset) {
				// Run without any dataset selection
				await invoke('run_flow', {
					flowId: pipelineId,
					inputOverrides: {},
					resultsDir: null,
					selection: null,
				})
			} else {
				if (!selectedDataset) {
					error = 'Please select a dataset or choose to run without one'
					running = false
					return
				}

				// Extract URLs from dataset assets
				const urls = extractUrlsFromAssets(selectedDataset.assets)

				console.log('Running pipeline with dataset files:', {
					datasetName: selectedDataset.dataset.name,
					assetCount: selectedDataset.assets.length,
					extractedUrls: urls,
				})

				if (urls.length === 0) {
					error = `No files found in dataset "${selectedDataset.dataset.name}". Make sure the dataset has assets with valid file paths.`
					running = false
					return
				}

				// Run with URLs extracted from dataset
				// NOTE: We intentionally DON'T pass datasetName here because that triggers
				// shape matching which fails for Map-shaped datasets. By only passing URLs,
				// the backend treats this like file selection from the Files tab.
				await invoke('run_flow', {
					flowId: pipelineId,
					inputOverrides: {},
					resultsDir: null,
					selection: {
						datasetName: null, // Don't pass - triggers shape matching
						datasetShape: null,
						datasetDataType: null,
						datasetOwner: null,
						fileIds: [],
						urls: urls,
						participantIds: [],
						assetKeys: [],
						dataType: null,
						dataSource: null,
					},
				})
			}

			handleOpenChange(false)
			onRunStarted?.()
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e)
			// Make the error more user-friendly
			if (msg.includes('No valid URLs')) {
				error = `Could not resolve file paths from the dataset. Make sure the dataset has assets with valid file paths.`
			} else if (msg.includes('Failed to resolve')) {
				error = `Could not locate the files on disk. The dataset's file paths may be invalid or the files may have been moved.`
			} else {
				error = msg
			}
		} finally {
			running = false
		}
	}

	function selectDataset(item: DatasetWithAssets) {
		selectedDataset = item
		runWithoutDataset = false
	}

	function selectNoDataset() {
		selectedDataset = null
		runWithoutDataset = true
	}

	// Load datasets when dialog opens
	$effect(() => {
		if (open) {
			loadDatasets()
		}
	})

	let canRun = $derived(runWithoutDataset || selectedDataset !== null)
</script>

<Dialog.Root bind:open onOpenChange={handleOpenChange}>
	<Dialog.Content class="max-w-lg">
		<Dialog.Header>
			<Dialog.Title>Run {pipelineName}</Dialog.Title>
			<Dialog.Description>Select a dataset to use as input, or run with defaults</Dialog.Description>
		</Dialog.Header>

		<div class="py-4">
			{#if loading}
				<div class="flex items-center justify-center py-8">
					<LoaderIcon class="size-6 animate-spin text-muted-foreground" />
				</div>
			{:else}
				<div class="space-y-3">
					<!-- Run without dataset option -->
					<button
						type="button"
						onclick={selectNoDataset}
						class="w-full flex items-center gap-3 rounded-lg border p-3 text-left transition-all hover:bg-accent {runWithoutDataset
							? 'border-primary bg-primary/5'
							: ''}"
					>
						<div
							class="flex size-10 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground"
						>
							<PlayIcon class="size-5" />
						</div>
						<div class="flex-1 min-w-0">
							<div class="font-medium text-sm">Run with defaults</div>
							<div class="text-muted-foreground text-xs">Use the flow's default input values</div>
						</div>
						{#if runWithoutDataset}
							<div class="flex size-6 items-center justify-center rounded-full bg-primary text-white">
								<CheckIcon class="size-4" />
							</div>
						{/if}
					</button>

					{#if datasets.length > 0}
						<div class="relative">
							<div class="absolute inset-0 flex items-center">
								<span class="w-full border-t"></span>
							</div>
							<div class="relative flex justify-center text-xs uppercase">
								<span class="bg-background px-2 text-muted-foreground">Or select a dataset</span>
							</div>
						</div>

						<div class="space-y-2 max-h-[240px] overflow-y-auto">
							{#each datasets as item (item.dataset.name)}
								<button
									type="button"
									onclick={() => selectDataset(item)}
									class="w-full flex items-center gap-3 rounded-lg border p-3 text-left transition-all hover:bg-accent {selectedDataset?.dataset.name ===
									item.dataset.name
										? 'border-primary bg-primary/5'
										: ''}"
								>
									<div
										class="flex size-10 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary"
									>
										<PackageIcon class="size-5" />
									</div>
									<div class="flex-1 min-w-0">
										<div class="font-medium text-sm">{item.dataset.name}</div>
										<div class="text-muted-foreground text-xs">
											v{item.dataset.version || '1.0.0'}
											{#if item.assets}
												• {item.assets.length}
												{item.assets.length === 1 ? 'file' : 'files'}
											{/if}
										</div>
									</div>
									{#if selectedDataset?.dataset.name === item.dataset.name}
										<div
											class="flex size-6 items-center justify-center rounded-full bg-primary text-white"
										>
											<CheckIcon class="size-4" />
										</div>
									{/if}
								</button>
							{/each}
						</div>
					{/if}
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
			<Button onclick={runFlow} disabled={running || !canRun || loading}>
				{#if running}
					<LoaderIcon class="size-4 animate-spin" />
					Running...
				{:else}
					<PlayIcon class="size-4" />
					Run Flow
				{/if}
			</Button>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>
