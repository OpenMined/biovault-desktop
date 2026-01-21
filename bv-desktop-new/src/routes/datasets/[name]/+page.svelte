<script lang="ts">
	import { page } from '$app/stores'
	import { goto, beforeNavigate } from '$app/navigation'
	import { invoke } from '@tauri-apps/api/core'
	import { onMount } from 'svelte'
	import {
		type ColumnDef,
		type PaginationState,
		type RowSelectionState,
		type ColumnFiltersState,
		getCoreRowModel,
		getFilteredRowModel,
		getPaginationRowModel,
	} from '@tanstack/table-core'
	import {
		createSvelteTable,
		FlexRender,
		renderComponent,
	} from '$lib/components/ui/data-table/index.js'
	import { toast } from 'svelte-sonner'
	import { Button } from '$lib/components/ui/button/index.js'
	import { Input } from '$lib/components/ui/input/index.js'
	import { Badge } from '$lib/components/ui/badge/index.js'
	import { Checkbox } from '$lib/components/ui/checkbox/index.js'
	import * as Card from '$lib/components/ui/card/index.js'
	import * as Table from '$lib/components/ui/table/index.js'
	import * as AlertDialog from '$lib/components/ui/alert-dialog/index.js'
	import ArrowLeftIcon from '@lucide/svelte/icons/arrow-left'
	import PackageIcon from '@lucide/svelte/icons/package'
	import SaveIcon from '@lucide/svelte/icons/save'
	import TrashIcon from '@lucide/svelte/icons/trash-2'
	import FileIcon from '@lucide/svelte/icons/file'
	import FolderIcon from '@lucide/svelte/icons/folder'
	import SearchIcon from '@lucide/svelte/icons/search'
	import Loader2Icon from '@lucide/svelte/icons/loader-2'
	import ChevronLeftIcon from '@lucide/svelte/icons/chevron-left'
	import ChevronRightIcon from '@lucide/svelte/icons/chevron-right'
	import AlertTriangleIcon from '@lucide/svelte/icons/triangle-alert'
	import AssetDeleteButton from './asset-delete-button.svelte'
	import AssetFileCell from './asset-file-cell.svelte'

	interface Asset {
		id: string
		name: string
		path: string
		exists: boolean
	}

	interface DatasetAsset {
		asset_key: string
		asset_uuid: string
		kind: string
		url: string
		private_ref?: string
		mock_ref?: string
		private_file_id?: number
		mock_file_id?: number
		private_path?: string
		mock_path?: string
		resolved_private_path?: string
		resolved_mock_path?: string
	}

	interface DatasetWithAssets {
		dataset: {
			id: number
			name: string
			version: string
			author: string
			description?: string
			schema: string
			public_url?: string
			private_url?: string
			http_relay_servers: string[]
			extra: unknown
		}
		assets: DatasetAsset[]
	}

	let datasetName = $derived($page.params.name)

	let loading = $state(true)
	let saving = $state(false)
	let error = $state<string | null>(null)

	// Form state
	let description = $state('')
	let version = $state('1.0.0')
	let assets = $state<Asset[]>([])

	// Track changes for basic info only (assets auto-save)
	let originalDescription = $state('')
	let originalVersion = $state('1.0.0')
	let hasInfoChanges = $derived(description !== originalDescription || version !== originalVersion)

	// Table state
	let pagination = $state<PaginationState>({ pageIndex: 0, pageSize: 20 })
	let rowSelection = $state<RowSelectionState>({})
	let columnFilters = $state<ColumnFiltersState>([])

	// Column definitions
	const columns: ColumnDef<Asset>[] = [
		{
			id: 'select',
			header: ({ table }) =>
				renderComponent(Checkbox, {
					checked: table.getIsAllPageRowsSelected(),
					indeterminate: table.getIsSomePageRowsSelected() && !table.getIsAllPageRowsSelected(),
					onCheckedChange: (value: boolean) => table.toggleAllPageRowsSelected(!!value),
					'aria-label': 'Select all',
				}),
			cell: ({ row }) =>
				renderComponent(Checkbox, {
					checked: row.getIsSelected(),
					onCheckedChange: (value: boolean) => row.toggleSelected(!!value),
					'aria-label': 'Select row',
				}),
			enableSorting: false,
			enableHiding: false,
		},
		{
			accessorKey: 'name',
			header: 'Name',
			cell: ({ row }) => row.original.name || '(unnamed)',
		},
		{
			accessorKey: 'path',
			header: 'File',
			cell: ({ row }) => {
				const { path, exists } = row.original
				if (!path) return '—'
				return renderComponent(AssetFileCell, {
					filename: getFileName(path),
					exists,
				})
			},
		},
		{
			id: 'actions',
			header: '',
			cell: ({ row }) => {
				const { id: assetId, path: assetPath, exists } = row.original
				return renderComponent(AssetDeleteButton, {
					assetId,
					assetPath,
					exists,
					onDelete: confirmDeleteAsset,
				})
			},
		},
	]

	const table = createSvelteTable({
		get data() {
			return assets
		},
		columns,
		state: {
			get pagination() {
				return pagination
			},
			get rowSelection() {
				return rowSelection
			},
			get columnFilters() {
				return columnFilters
			},
		},
		getCoreRowModel: getCoreRowModel(),
		getPaginationRowModel: getPaginationRowModel(),
		getFilteredRowModel: getFilteredRowModel(),
		onPaginationChange: (updater) => {
			if (typeof updater === 'function') {
				pagination = updater(pagination)
			} else {
				pagination = updater
			}
		},
		onRowSelectionChange: (updater) => {
			if (typeof updater === 'function') {
				rowSelection = updater(rowSelection)
			} else {
				rowSelection = updater
			}
		},
		onColumnFiltersChange: (updater) => {
			if (typeof updater === 'function') {
				columnFilters = updater(columnFilters)
			} else {
				columnFilters = updater
			}
		},
		getRowId: (row) => row.id,
	})

	onMount(async () => {
		await loadDataset()
	})

	async function loadDataset() {
		loading = true
		error = null

		try {
			const datasets = await invoke<DatasetWithAssets[]>('list_datasets_with_assets')
			const datasetWithAssets = datasets.find((d) => d.dataset.name === datasetName)

			if (!datasetWithAssets) {
				error = 'Dataset not found'
				return
			}

			const { dataset, assets: datasetAssets } = datasetWithAssets

			description = dataset.description || ''
			version = dataset.version || '1.0.0'

			// Build initial assets list
			const loadedAssets = datasetAssets.map((a) => ({
				id: crypto.randomUUID(),
				name: a.asset_key,
				path: a.resolved_private_path || a.private_path || '',
				exists: true, // Default to true, will check below
			}))

			// Check which files exist
			if (loadedAssets.length > 0) {
				const paths = loadedAssets.map((a) => a.path)
				const existsResults = await invoke<boolean[]>('check_files_exist', { paths })
				loadedAssets.forEach((asset, i) => {
					asset.exists = existsResults[i] ?? true
				})
			}

			assets = loadedAssets

			originalDescription = description
			originalVersion = version
		} catch (e) {
			error = e instanceof Error ? e.message : String(e)
		} finally {
			loading = false
		}
	}

	// Helper to save the full dataset (used for asset changes)
	async function saveDataset() {
		const manifestAssets: Record<
			string,
			{
				id?: string
				kind?: string
				url?: string
				mappings?: {
					private?: { file_path?: string; db_file_id?: number }
				}
			}
		> = {}

		for (const asset of assets.filter((a) => a.name && a.path)) {
			manifestAssets[asset.name] = {
				kind: 'twin',
				mappings: {
					private: { file_path: asset.path },
				},
			}
		}

		await invoke('save_dataset_with_files', {
			manifest: {
				name: datasetName,
				description: description.trim() || null,
				version: version.trim() || '1.0.0',
				schema: 'net.biovault.datasets:1.0.0',
				author: null,
				public_url: null,
				private_url: null,
				http_relay_servers: [],
				assets: manifestAssets,
			},
			originalName: datasetName,
		})
	}

	let savingAssets = $state(false)

	// Duplicate handling
	let duplicateDialogOpen = $state(false)
	let pendingNewAssets = $state<Asset[]>([])
	let duplicateNames = $state<string[]>([])

	function checkForDuplicates(newAssets: Asset[]): string[] {
		const existingNames = new Set(assets.map((a) => a.name))
		return newAssets.filter((a) => existingNames.has(a.name)).map((a) => a.name)
	}

	async function processNewAssets(newAssets: Asset[], mode: 'keep' | 'replace') {
		if (mode === 'replace') {
			// Remove existing assets with duplicate names
			const newNames = new Set(newAssets.map((a) => a.name))
			assets = assets.filter((a) => !newNames.has(a.name))
		} else {
			// Filter out duplicates from new assets
			const existingNames = new Set(assets.map((a) => a.name))
			newAssets = newAssets.filter((a) => !existingNames.has(a.name))
		}

		if (newAssets.length === 0) {
			toast.info('No new assets to add')
			return
		}

		assets = [...assets, ...newAssets]

		// Auto-save
		savingAssets = true
		try {
			await saveDataset()
			toast.success(`Added ${newAssets.length} file${newAssets.length === 1 ? '' : 's'}`)
		} catch (e) {
			error = e instanceof Error ? e.message : String(e)
		} finally {
			savingAssets = false
		}
	}

	function handleDuplicateKeep() {
		duplicateDialogOpen = false
		processNewAssets(pendingNewAssets, 'keep')
		pendingNewAssets = []
		duplicateNames = []
	}

	function handleDuplicateReplace() {
		duplicateDialogOpen = false
		processNewAssets(pendingNewAssets, 'replace')
		pendingNewAssets = []
		duplicateNames = []
	}

	async function addAssetsWithDuplicateCheck(newAssets: Asset[]) {
		const duplicates = checkForDuplicates(newAssets)

		if (duplicates.length > 0) {
			pendingNewAssets = newAssets
			duplicateNames = duplicates
			duplicateDialogOpen = true
		} else {
			await processNewAssets(newAssets, 'keep')
		}
	}

	async function addFiles() {
		try {
			const { open: openDialog } = await import('@tauri-apps/plugin-dialog')
			const selected = await openDialog({
				multiple: true,
				directory: false,
				title: 'Select Files',
			})
			if (selected && Array.isArray(selected)) {
				const newAssets = selected.map((filePath) => ({
					id: crypto.randomUUID(),
					name: getFileName(filePath).split('.')[0] || '',
					path: filePath,
					exists: true,
				}))
				await addAssetsWithDuplicateCheck(newAssets)
			}
		} catch (e) {
			console.error('Failed to open file dialog:', e)
			error = e instanceof Error ? e.message : String(e)
		}
	}

	async function addFolder() {
		try {
			const { open: openDialog } = await import('@tauri-apps/plugin-dialog')
			const selectedDir = await openDialog({
				multiple: false,
				directory: true,
				title: 'Select Folder',
			})
			if (selectedDir && typeof selectedDir === 'string') {
				// Get all extensions in the folder
				const extensionCounts = await invoke<{ extension: string; count: number }[]>(
					'get_extensions',
					{ path: selectedDir }
				)
				const extensions = extensionCounts.map((e) => e.extension)

				if (extensions.length === 0) {
					toast.error('No files found in folder')
					return
				}

				// Get all files with those extensions
				const files = await invoke<string[]>('search_txt_files', {
					path: selectedDir,
					extensions,
				})

				if (files.length === 0) {
					toast.error('No files found in folder')
					return
				}

				const newAssets = files.map((filePath) => ({
					id: crypto.randomUUID(),
					name: getFileName(filePath).split('.')[0] || '',
					path: filePath,
					exists: true,
				}))
				await addAssetsWithDuplicateCheck(newAssets)
			}
		} catch (e) {
			console.error('Failed to open folder dialog:', e)
			error = e instanceof Error ? e.message : String(e)
		}
	}

	// Asset deletion with confirmation
	let deleteAssetDialogOpen = $state(false)
	let pendingDeleteAssetId = $state<string | null>(null)
	let deleteBulkDialogOpen = $state(false)

	function confirmDeleteAsset(id: string) {
		pendingDeleteAssetId = id
		deleteAssetDialogOpen = true
	}

	async function executeDeleteAsset() {
		if (!pendingDeleteAssetId) return

		assets = assets.filter((a) => a.id !== pendingDeleteAssetId)
		const newSelection = { ...rowSelection }
		delete newSelection[pendingDeleteAssetId]
		rowSelection = newSelection

		deleteAssetDialogOpen = false
		pendingDeleteAssetId = null

		// Auto-save
		savingAssets = true
		try {
			await saveDataset()
			toast.success('Asset removed')
		} catch (e) {
			error = e instanceof Error ? e.message : String(e)
		} finally {
			savingAssets = false
		}
	}

	function confirmDeleteSelected() {
		deleteBulkDialogOpen = true
	}

	async function executeDeleteSelected() {
		const selectedIds = Object.keys(rowSelection).filter((id) => rowSelection[id])
		const count = selectedIds.length
		assets = assets.filter((a) => !selectedIds.includes(a.id))
		rowSelection = {}

		deleteBulkDialogOpen = false

		// Auto-save
		savingAssets = true
		try {
			await saveDataset()
			toast.success(`Removed ${count} asset${count === 1 ? '' : 's'}`)
		} catch (e) {
			error = e instanceof Error ? e.message : String(e)
		} finally {
			savingAssets = false
		}
	}

	async function handleSaveInfo() {
		saving = true
		error = null

		try {
			await saveDataset()
			originalDescription = description
			originalVersion = version
			toast.success('Dataset saved')
		} catch (e) {
			error = e instanceof Error ? e.message : String(e)
			toast.error('Failed to save dataset')
		} finally {
			saving = false
		}
	}

	function getFileName(path: string): string {
		return path.split('/').pop() || path
	}

	let validAssetCount = $derived(assets.filter((a) => a.name && a.path).length)
	let missingCount = $derived(assets.filter((a) => !a.exists).length)
	let selectedCount = $derived(Object.keys(rowSelection).filter((id) => rowSelection[id]).length)

	let deleting = $state(false)
	let deleteDialogOpen = $state(false)

	async function handleDelete() {
		deleting = true
		error = null

		try {
			await invoke('delete_dataset', { name: datasetName })
			goto('/datasets')
		} catch (e) {
			error = e instanceof Error ? e.message : String(e)
			deleting = false
			deleteDialogOpen = false
		}
	}

	let searchValue = $state('')

	function handleSearch(value: string) {
		searchValue = value
		table.getColumn('name')?.setFilterValue(value)
	}

	// Unsaved changes guard
	let unsavedDialogOpen = $state(false)
	let pendingNavigation = $state<(() => void) | null>(null)

	beforeNavigate(({ cancel, to }) => {
		if (hasInfoChanges && !unsavedDialogOpen) {
			cancel()
			pendingNavigation = () => {
				if (to?.url) {
					goto(to.url.pathname)
				}
			}
			unsavedDialogOpen = true
		}
	})

	function handleDiscardChanges() {
		// Reset to original values so hasInfoChanges becomes false
		description = originalDescription
		version = originalVersion
		unsavedDialogOpen = false
		// Navigate after state update
		if (pendingNavigation) {
			pendingNavigation()
			pendingNavigation = null
		}
	}

	function handleStayOnPage() {
		unsavedDialogOpen = false
		pendingNavigation = null
	}
</script>

<div class="flex h-full flex-col">
	<!-- Header -->
	<div class="border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60">
		<div class="flex items-center gap-4 p-4">
			<Button variant="ghost" size="icon" onclick={() => goto('/datasets')}>
				<ArrowLeftIcon class="size-5" />
			</Button>

			<div class="flex items-center gap-3 flex-1 min-w-0">
				<div class="flex size-10 items-center justify-center rounded-lg bg-primary/10 shrink-0">
					<PackageIcon class="size-5 text-primary" />
				</div>
				<div class="min-w-0">
					<h1 class="font-semibold text-lg truncate">{datasetName}</h1>
					<p class="text-sm text-muted-foreground">
						v{version} • {validAssetCount}
						{validAssetCount === 1 ? 'asset' : 'assets'}
					</p>
				</div>
			</div>

			{#if savingAssets}
				<Badge variant="secondary" class="gap-1">
					<Loader2Icon class="size-3 animate-spin" />
					Saving...
				</Badge>
			{/if}
		</div>
	</div>

	<!-- Content -->
	<div class="flex-1 overflow-auto">
		{#if loading}
			<div class="flex h-full items-center justify-center">
				<Loader2Icon class="size-8 animate-spin text-muted-foreground" />
			</div>
		{:else if error && !description}
			<div class="flex h-full items-center justify-center">
				<div class="text-center">
					<p class="text-destructive mb-4">{error}</p>
					<Button variant="outline" onclick={() => goto('/datasets')}>Back to Datasets</Button>
				</div>
			</div>
		{:else}
			<div class="max-w-5xl mx-auto p-6 space-y-6">
			{#if error}
				<div class="bg-destructive/10 text-destructive text-sm rounded-lg px-4 py-3">
					{error}
				</div>
			{/if}

			{#if missingCount > 0}
				<div
					class="flex items-start gap-3 rounded-lg border border-destructive/50 bg-destructive/10 px-4 py-3"
				>
					<AlertTriangleIcon class="size-5 text-destructive shrink-0 mt-0.5" />
					<div class="text-sm">
						<p class="font-medium text-destructive">Missing files detected</p>
						<p class="text-muted-foreground mt-0.5">
							{missingCount}
							{missingCount === 1 ? 'asset is' : 'assets are'} pointing to files that no longer exist.
							Consider removing them or updating the file paths.
						</p>
					</div>
				</div>
			{/if}

			<!-- Basic Information -->
				<Card.Root>
					<Card.Header>
						<div class="flex items-start justify-between">
							<div>
								<Card.Title class="text-base">Basic Information</Card.Title>
								<Card.Description>General details about your dataset</Card.Description>
							</div>
							<Button onclick={handleSaveInfo} disabled={saving || !hasInfoChanges} size="sm">
								{#if saving}
									<Loader2Icon class="size-4 animate-spin" />
									Saving...
								{:else}
									<SaveIcon class="size-4" />
									Save
								{/if}
							</Button>
						</div>
					</Card.Header>
					<Card.Content class="space-y-4">
						<div class="space-y-2">
							<label for="description" class="text-sm font-medium">Description</label>
							<textarea
								id="description"
								bind:value={description}
								placeholder="What's in this dataset and what is it used for?"
								rows="3"
								class="border-input bg-background placeholder:text-muted-foreground flex w-full rounded-md border px-3 py-2 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px] resize-none"
							></textarea>
						</div>

						<div class="space-y-2">
							<label for="version" class="text-sm font-medium">Version</label>
							<Input id="version" bind:value={version} placeholder="1.0.0" class="max-w-32" />
						</div>
					</Card.Content>
				</Card.Root>

				<!-- Data Assets -->
				<Card.Root>
					<Card.Header>
						<div class="flex items-center justify-between">
							<div>
								<Card.Title class="text-base flex items-center gap-2">
									Data Assets
									{#if assets.length > 0}
										<Badge variant="outline">{assets.length}</Badge>
									{/if}
									{#if missingCount > 0}
										<Badge variant="destructive" class="gap-1">
											<AlertTriangleIcon class="size-3" />
											{missingCount} missing
										</Badge>
									{/if}
								</Card.Title>
								<Card.Description>Files included in this dataset</Card.Description>
							</div>
						</div>
					</Card.Header>
					<Card.Content>
						{#if assets.length === 0}
							<div class="border-2 border-dashed rounded-lg p-8 text-center">
								<div class="flex flex-col items-center gap-2">
									<div class="size-12 rounded-full bg-muted flex items-center justify-center">
										<FileIcon class="size-6 text-muted-foreground" />
									</div>
									<div>
										<p class="font-medium">No assets yet</p>
										<p class="text-muted-foreground text-sm">
											Add files or a folder to your dataset
										</p>
									</div>
									<div class="flex gap-2 mt-2">
										<Button variant="outline" onclick={addFiles}>
											<FileIcon class="size-4" />
											Select Files
										</Button>
										<Button onclick={addFolder}>
											<FolderIcon class="size-4" />
											Select Folder
										</Button>
									</div>
								</div>
							</div>
						{:else}
							<!-- Toolbar -->
							<div class="flex items-center justify-between gap-4 mb-4">
								<div class="flex items-center gap-2 flex-1">
									<div class="relative max-w-sm flex-1">
										<SearchIcon
											class="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-muted-foreground"
										/>
										<Input
											placeholder="Search assets..."
											value={searchValue}
											oninput={(e) => handleSearch(e.currentTarget.value)}
											class="pl-9"
										/>
									</div>
									{#if selectedCount > 0}
										<Button variant="destructive" size="sm" onclick={confirmDeleteSelected}>
											<TrashIcon class="size-4" />
											Delete {selectedCount}
										</Button>
									{/if}
								</div>
								<div class="flex gap-2">
									<Button variant="outline" onclick={addFiles}>
										<FileIcon class="size-4" />
										Select Files
									</Button>
									<Button onclick={addFolder}>
										<FolderIcon class="size-4" />
										Select Folder
									</Button>
								</div>
							</div>

							<!-- Table -->
							<div class="rounded-md border">
								<Table.Root>
									<Table.Header>
										{#each table.getHeaderGroups() as headerGroup (headerGroup.id)}
											<Table.Row>
												{#each headerGroup.headers as header (header.id)}
													<Table.Head class="[&:has([role=checkbox])]:pl-3">
														{#if !header.isPlaceholder}
															<FlexRender
																content={header.column.columnDef.header}
																context={header.getContext()}
															/>
														{/if}
													</Table.Head>
												{/each}
											</Table.Row>
										{/each}
									</Table.Header>
									<Table.Body>
										{#each table.getRowModel().rows as row (row.id)}
											<Table.Row data-state={row.getIsSelected() && 'selected'}>
												{#each row.getVisibleCells() as cell (cell.id)}
													<Table.Cell class="[&:has([role=checkbox])]:pl-3">
														<FlexRender
															content={cell.column.columnDef.cell}
															context={cell.getContext()}
														/>
													</Table.Cell>
												{/each}
											</Table.Row>
										{:else}
											<Table.Row>
												<Table.Cell colspan={columns.length} class="h-24 text-center">
													No assets found.
												</Table.Cell>
											</Table.Row>
										{/each}
									</Table.Body>
								</Table.Root>
							</div>

							<!-- Pagination -->
							<div class="flex items-center justify-between pt-4">
								<div class="text-muted-foreground text-sm">
									{#if selectedCount > 0}
										{selectedCount} of {table.getFilteredRowModel().rows.length} selected
									{:else}
										{table.getFilteredRowModel().rows.length} assets
									{/if}
								</div>
								<div class="flex items-center gap-2">
									<Button
										variant="outline"
										size="sm"
										onclick={() => table.previousPage()}
										disabled={!table.getCanPreviousPage()}
									>
										<ChevronLeftIcon class="size-4" />
										Previous
									</Button>
									<span class="text-sm text-muted-foreground">
										Page {pagination.pageIndex + 1} of {table.getPageCount()}
									</span>
									<Button
										variant="outline"
										size="sm"
										onclick={() => table.nextPage()}
										disabled={!table.getCanNextPage()}
									>
										Next
										<ChevronRightIcon class="size-4" />
									</Button>
								</div>
							</div>
						{/if}
					</Card.Content>
				</Card.Root>

				<!-- Danger Zone -->
				<Card.Root class="border-destructive/50">
					<Card.Header>
						<Card.Title class="text-base text-destructive">Danger Zone</Card.Title>
						<Card.Description>Irreversible actions for this dataset</Card.Description>
					</Card.Header>
					<Card.Content>
						<div class="flex items-center justify-between">
							<div>
								<p class="font-medium text-sm">Delete Dataset</p>
								<p class="text-muted-foreground text-sm">
									Permanently remove this dataset and all its assets
								</p>
							</div>
							<AlertDialog.Root bind:open={deleteDialogOpen}>
								<AlertDialog.Trigger>
									{#snippet child({ props })}
										<Button variant="destructive" size="sm" {...props}>
											<TrashIcon class="size-4" />
											Delete
										</Button>
									{/snippet}
								</AlertDialog.Trigger>
								<AlertDialog.Content>
									<AlertDialog.Header>
										<AlertDialog.Title>Delete Dataset</AlertDialog.Title>
										<AlertDialog.Description>
											Are you sure you want to delete <strong>{datasetName}</strong>? This action
											cannot be undone.
										</AlertDialog.Description>
									</AlertDialog.Header>
									<AlertDialog.Footer>
										<AlertDialog.Cancel>Cancel</AlertDialog.Cancel>
										<AlertDialog.Action onclick={handleDelete} disabled={deleting}>
											{deleting ? 'Deleting...' : 'Delete'}
										</AlertDialog.Action>
									</AlertDialog.Footer>
								</AlertDialog.Content>
							</AlertDialog.Root>
						</div>
					</Card.Content>
				</Card.Root>
			</div>
		{/if}
	</div>
</div>

<!-- Unsaved Changes Dialog -->
<AlertDialog.Root bind:open={unsavedDialogOpen}>
	<AlertDialog.Content>
		<AlertDialog.Header>
			<AlertDialog.Title>Unsaved Changes</AlertDialog.Title>
			<AlertDialog.Description>
				You have unsaved changes to the dataset info. Are you sure you want to leave?
			</AlertDialog.Description>
		</AlertDialog.Header>
		<AlertDialog.Footer>
			<AlertDialog.Cancel onclick={handleStayOnPage}>Cancel</AlertDialog.Cancel>
			<AlertDialog.Action onclick={handleDiscardChanges}>Leave without saving</AlertDialog.Action>
		</AlertDialog.Footer>
	</AlertDialog.Content>
</AlertDialog.Root>

<!-- Delete Single Asset Dialog -->
<AlertDialog.Root bind:open={deleteAssetDialogOpen}>
	<AlertDialog.Content>
		<AlertDialog.Header>
			<AlertDialog.Title>Remove Asset</AlertDialog.Title>
			<AlertDialog.Description>
				Are you sure you want to remove this asset from the dataset?
			</AlertDialog.Description>
		</AlertDialog.Header>
		<AlertDialog.Footer>
			<AlertDialog.Cancel>Cancel</AlertDialog.Cancel>
			<AlertDialog.Action onclick={executeDeleteAsset}>Remove</AlertDialog.Action>
		</AlertDialog.Footer>
	</AlertDialog.Content>
</AlertDialog.Root>

<!-- Delete Multiple Assets Dialog -->
<AlertDialog.Root bind:open={deleteBulkDialogOpen}>
	<AlertDialog.Content>
		<AlertDialog.Header>
			<AlertDialog.Title>Remove {selectedCount} Assets</AlertDialog.Title>
			<AlertDialog.Description>
				Are you sure you want to remove {selectedCount} asset{selectedCount === 1 ? '' : 's'} from
				the dataset?
			</AlertDialog.Description>
		</AlertDialog.Header>
		<AlertDialog.Footer>
			<AlertDialog.Cancel>Cancel</AlertDialog.Cancel>
			<AlertDialog.Action onclick={executeDeleteSelected}>Remove</AlertDialog.Action>
		</AlertDialog.Footer>
	</AlertDialog.Content>
</AlertDialog.Root>

<!-- Duplicate Assets Dialog -->
<AlertDialog.Root bind:open={duplicateDialogOpen}>
	<AlertDialog.Content>
		<AlertDialog.Header>
			<AlertDialog.Title>Duplicate Assets Found</AlertDialog.Title>
			<AlertDialog.Description>
				{duplicateNames.length} asset{duplicateNames.length === 1 ? '' : 's'} already exist{duplicateNames.length === 1 ? 's' : ''} in
				this dataset: <strong>{duplicateNames.slice(0, 3).join(', ')}{duplicateNames.length > 3 ? `, +${duplicateNames.length - 3} more` : ''}</strong>
			</AlertDialog.Description>
		</AlertDialog.Header>
		<AlertDialog.Footer>
			<AlertDialog.Cancel>Cancel</AlertDialog.Cancel>
			<Button variant="outline" onclick={handleDuplicateKeep}>Keep Existing</Button>
			<AlertDialog.Action onclick={handleDuplicateReplace}>Replace</AlertDialog.Action>
		</AlertDialog.Footer>
	</AlertDialog.Content>
</AlertDialog.Root>
