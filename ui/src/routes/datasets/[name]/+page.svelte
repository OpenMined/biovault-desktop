<script lang="ts">
	import { page } from '$app/stores'
	import { goto, beforeNavigate } from '$app/navigation'
	import { invoke } from '@tauri-apps/api/core'
	import { onMount, tick } from 'svelte'
	import {
		type ColumnDef,
		type PaginationState,
		type RowSelectionState,
		type ColumnFiltersState,
		type SortingState,
		getCoreRowModel,
		getFilteredRowModel,
		getPaginationRowModel,
		getSortedRowModel,
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
	import * as Dialog from '$lib/components/ui/dialog/index.js'
	import ArrowLeftIcon from '@lucide/svelte/icons/arrow-left'
	import PackageIcon from '@lucide/svelte/icons/package'
	import SaveIcon from '@lucide/svelte/icons/save'
	import TrashIcon from '@lucide/svelte/icons/trash-2'
	import FileIcon from '@lucide/svelte/icons/file'
	import FolderIcon from '@lucide/svelte/icons/folder'
	import SearchIcon from '@lucide/svelte/icons/search'
	import SendIcon from '@lucide/svelte/icons/send'
	import Loader2Icon from '@lucide/svelte/icons/loader-2'
	import ChevronLeftIcon from '@lucide/svelte/icons/chevron-left'
	import ChevronRightIcon from '@lucide/svelte/icons/chevron-right'
	import AlertTriangleIcon from '@lucide/svelte/icons/triangle-alert'
	import InfoIcon from '@lucide/svelte/icons/info'
	import GlobeIcon from '@lucide/svelte/icons/globe'
	import StarIcon from '@lucide/svelte/icons/star'
	import AssetDeleteButton from './asset-delete-button.svelte'
	import AssetFileCell from './asset-file-cell.svelte'
	import AssetMockCell from './asset-mock-cell.svelte'
	import AssetMockButton from './asset-mock-button.svelte'
	import * as Tooltip from '$lib/components/ui/tooltip/index.js'
	import RequestRunDialog from '$lib/components/request-run-dialog.svelte'
	import { syftboxAuthStore } from '$lib/stores/syftbox-auth.svelte'

	interface Asset {
		rowId: string
		fileId: number | null
		name: string
		path: string
		fileType: string
		participantId: string
		fileRole: string
		metadata: Record<string, string>
		exists: boolean
		mockPath?: string
		mockUrl?: string
		mockExists: boolean
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
		extra?: Record<string, unknown>
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
			extra: any
		}
		assets: DatasetAsset[]
	}

	interface ExtensionCount {
		extension: string
		count: number
	}

	interface DerivedColumnDefinition {
		key: string
		label: string
		description: string
	}

	interface DatasetUiExtra {
		enabled_columns?: string[]
		custom_columns?: string[]
	}

	interface DerivedDatasetAsset {
		path: string
		asset_name: string
		file_type: string
		participant_id: string
		file_role: string
		derived_fields: Record<string, string>
	}

	interface DerivedDatasetAssetSummary {
		assets: DerivedDatasetAsset[]
		suggested_columns: string[]
	}

	interface DatasetProcessingAction {
		key: string
		label: string
		description: string
	}

interface DatasetProcessingSummary {
	participant_count: number
	primary_asset_count: number
	reference_count: number
	index_count: number
	warnings: string[]
	suggested_actions: DatasetProcessingAction[]
}

interface ParticipantRecord {
	id: number
	participant_id: string
	file_count: number
	created_at: string
}

interface ReferenceDownloadResult {
	reference_dir: string
}

	const PENDING_DATASET_IMPORT_KEY = 'biovault.pendingDatasetImportPaths'
	const RESERVED_ASSET_EXTRA_KEYS = new Set(['file_type', 'participant_id', 'file_role'])
	const INTERNAL_ASSET_METADATA_KEYS = new Set([
		'__asset_structure',
		'__asset_group',
		'__entry_id',
		'entry_name',
	])
	const DISALLOWED_UI_COLUMNS = new Set(['kind', 'type', 'twin'])

	let datasetName = $derived($page.params.name ?? '')
	let isNewDataset = $derived(datasetName === 'new')

	let loading = $state(true)
	let saving = $state(false)
	let error = $state<string | null>(null)
	let isPublished = $state(false)
	let isNetwork = $state(false)
	let author = $state('')
	let requestRunDialogOpen = $state(false)
	const currentUserEmail = $derived(syftboxAuthStore.email || '')
	const canRequestRun = $derived(isNetwork && author && author.toLowerCase() !== currentUserEmail.toLowerCase())

	// Form state
	let currentName = $state($page.params.name ?? '')
	let description = $state('')
	let version = $state('1.0.0')
	let assets = $state<Asset[]>([])

	// Track changes for basic info only (assets auto-save)
	let originalName = $state($page.params.name ?? '')
	let originalDescription = $state('')
	let originalVersion = $state('1.0.0')
	let hasInfoChanges = $derived(
		currentName !== originalName || description !== originalDescription || version !== originalVersion,
	)

	let allAssetsHaveMocks = $derived(assets.length > 0 && assets.every((a) => a.mockPath || a.mockUrl))
	let missingMockCount = $derived(assets.filter((a) => !a.mockPath && !a.mockUrl).length)

	let customColumnDraft = $state('')
	let customColumns = $state<string[]>([])
	let enabledColumns = $state<string[]>([])
	let addColumnMenuOpen = $state(false)
	let processingColumns = $state<string[]>([])
	let suggestedColumns = $state<string[]>([])
let processingSummary = $state<DatasetProcessingSummary | null>(null)
let processingSummaryBusy = $state(false)
let referenceImporting = $state(false)
let knownParticipants = $state<ParticipantRecord[]>([])
let participantFilter = $state('all')
let mockUrlDialogOpen = $state(false)
	let pendingMockUrlAssetId = $state<string | null>(null)
	let mockUrlDraft = $state('')

	// Table state
	let pagination = $state<PaginationState>({ pageIndex: 0, pageSize: 20 })
	let rowSelection = $state<RowSelectionState>({})
	let columnFilters = $state<ColumnFiltersState>([])
	let sorting = $state<SortingState>([{ id: 'fileId', desc: false }])

	// File type selection (after folder pick)
	let fileTypeDialogOpen = $state(false)
	let pendingFolderPath = $state<string | null>(null)
	let fileTypeOptions = $state<ExtensionCount[]>([])
	let selectedExtensions = $state<Set<string>>(new Set())
	let allExtensionsSelected = $derived(
		fileTypeOptions.length > 0 && selectedExtensions.size === fileTypeOptions.length,
	)
	let someExtensionsSelected = $derived(
		selectedExtensions.size > 0 && selectedExtensions.size < fileTypeOptions.length,
	)
let sortedFileTypes = $derived(
	[...fileTypeOptions].sort((a, b) => a.extension.localeCompare(b.extension)),
)
let participantOptions = $derived.by(() => {
	const ids = new Set(
		[
			...knownParticipants.map((participant) => participant.participant_id),
			...assets.map((asset) => asset.participantId),
		]
			.map((value) => value.trim())
			.filter(Boolean),
	)
	return Array.from(ids).sort((a, b) => a.localeCompare(b))
})
let referenceAssets = $derived(
	assets.filter(
		(asset) => asset.fileRole.toLowerCase() === 'reference' || asset.fileType === 'Reference',
	),
)
let visibleAssets = $derived(
	participantFilter === 'all'
		? assets
		: assets.filter((asset) => asset.participantId.trim() === participantFilter),
)
	let processingSummarySignature = $derived(
		JSON.stringify(
			assets.map((asset) => ({
				name: asset.name,
				path: asset.path,
				mockPath: asset.mockPath || '',
				mockUrl: asset.mockUrl || '',
				fileType: asset.fileType,
				participantId: asset.participantId,
				fileRole: asset.fileRole,
				metadata: asset.metadata,
			})),
		),
	)

	const derivedColumnDefinitions: Record<string, DerivedColumnDefinition> = {
		participant_id: {
			key: 'participant_id',
			label: 'Participant ID',
			description: 'Extract from filenames',
		},
		file_role: {
			key: 'file_role',
			label: 'File Role',
			description: 'Primary, index, reference, or mock',
		},
		read_pair: {
			key: 'read_pair',
			label: 'Read Pair',
			description: 'Detect R1 or R2 from reads',
		},
		lane: {
			key: 'lane',
			label: 'Lane',
			description: 'Detect sequencing lane from filenames',
		},
		ref_version: {
			key: 'ref_version',
			label: 'Ref Version',
			description: 'Infer hg19, hg38, GRCh37, or GRCh38',
		},
		aligned_index: {
			key: 'aligned_index',
			label: 'Aligned Index',
			description: 'Link BAM/CRAM files to their index',
		},
		vcf_index: {
			key: 'vcf_index',
			label: 'VCF Index',
			description: 'Link VCF files to their index',
		},
		reference_file: {
			key: 'reference_file',
			label: 'Reference File',
			description: 'Attach matching reference files',
		},
		reference_index: {
			key: 'reference_index',
			label: 'Reference Index',
			description: 'Attach FASTA index files',
		},
	}

	function getExtension(path: string): string {
		const filename = getFileName(path).toLowerCase()
		if (filename.endsWith('.vcf.gz')) return 'vcf.gz'
		if (filename.endsWith('.fastq.gz')) return 'fastq.gz'
		if (filename.endsWith('.fq.gz')) return 'fq.gz'
		const idx = filename.lastIndexOf('.')
		return idx >= 0 ? filename.slice(idx + 1) : ''
	}

	function normalizeAssetName(value: string): string {
		return value
			.trim()
			.toLowerCase()
			.replace(/\.[^.]+$/g, '')
			.replace(/[^a-z0-9]+/g, '_')
			.replace(/^_+|_+$/g, '')
	}

	function toRecord(value: unknown): Record<string, unknown> {
		return value && typeof value === 'object' && !Array.isArray(value)
			? (value as Record<string, unknown>)
			: {}
	}

	function toStringOrEmpty(value: unknown): string {
		return typeof value === 'string' ? value : ''
	}

	function toNonEmptyStringOrUndefined(value: unknown): string | undefined {
		return typeof value === 'string' && value.trim() ? value : undefined
	}

	function sanitizeUiColumns(columns: string[]): string[] {
		return Array.from(
			new Set(
				columns.filter((column) => {
					const normalized = normalizeAssetName(column)
					return normalized && !DISALLOWED_UI_COLUMNS.has(normalized)
				}),
			),
		)
	}

	function createAssetFromPath(filePath: string, partial?: Partial<Asset>): Asset {
		return {
			rowId: partial?.rowId ?? crypto.randomUUID(),
			fileId: partial?.fileId ?? null,
			name: partial?.name ?? getFileName(filePath).split('.')[0] ?? '',
			path: filePath,
			fileType: partial?.fileType?.trim() ? partial.fileType : '',
			participantId: partial?.participantId?.trim() ? partial.participantId : '',
			fileRole: partial?.fileRole?.trim() ? partial.fileRole : '',
			metadata: partial?.metadata ?? {},
			exists: partial?.exists ?? true,
			mockPath: partial?.mockPath ?? '',
			mockUrl: partial?.mockUrl ?? '',
			mockExists: partial?.mockExists ?? false,
		}
	}

	function createProcessingPayload(sourceAssets: Asset[]): Array<{
		name: string
		path: string
		mock_path: string
		mock_url: string
		file_type: string
		participant_id: string
		file_role: string
		metadata: Record<string, string>
	}> {
		return sourceAssets.map((asset) => ({
			name: asset.name,
			path: asset.path,
			mock_path: asset.mockPath || '',
			mock_url: asset.mockUrl || '',
			file_type: asset.fileType,
			participant_id: asset.participantId,
			file_role: asset.fileRole,
			metadata: asset.metadata,
		}))
	}

	async function refreshProcessingSummary(sourceAssets: Asset[]) {
		if (sourceAssets.length === 0) {
			processingSummary = null
			return
		}
		processingSummaryBusy = true
		try {
			processingSummary = await invoke<DatasetProcessingSummary>('summarize_dataset_processing', {
				assets: createProcessingPayload(sourceAssets),
			})
		} catch {
			processingSummary = null
		} finally {
			processingSummaryBusy = false
		}
	}

	async function analyzeDatasetAssetSummary(
		paths: string[],
	): Promise<{ assetsByPath: Map<string, DerivedDatasetAsset>; suggestedColumns: string[] }> {
		const uniquePaths = [...new Set(paths.map((path) => path.trim()).filter(Boolean))]
		if (uniquePaths.length === 0) return { assetsByPath: new Map(), suggestedColumns: [] }
		const summary = await invoke<DerivedDatasetAssetSummary>('analyze_dataset_assets_summary', {
			paths: uniquePaths,
		}).catch(() => ({ assets: [], suggested_columns: [] } as DerivedDatasetAssetSummary))
		return {
			assetsByPath: new Map(summary.assets.map((analysis) => [analysis.path, analysis])),
			suggestedColumns: sanitizeUiColumns(summary.suggested_columns ?? []),
		}
	}

	async function createAssetsFromPaths(paths: string[]): Promise<Asset[]> {
		const uniquePaths = [...new Set(paths.map((path) => path.trim()).filter(Boolean))]
		const summary = await analyzeDatasetAssetSummary(uniquePaths)
		suggestedColumns = summary.suggestedColumns
		return uniquePaths.map((filePath) => {
			const analysis = summary.assetsByPath.get(filePath)
			return createAssetFromPath(filePath, {
				name: analysis?.asset_name || undefined,
				fileType: analysis?.file_type,
				participantId: analysis?.participant_id,
				fileRole: analysis?.file_role,
				metadata: analysis?.derived_fields ?? {},
			})
		})
	}

	function getPersistedAssetMetadata(extra: unknown): Record<string, string> {
		const record = toRecord(extra)
		return Object.fromEntries(
			Object.entries(record)
				.filter(
					([key, value]) =>
						!RESERVED_ASSET_EXTRA_KEYS.has(key) &&
						!INTERNAL_ASSET_METADATA_KEYS.has(key) &&
						typeof value === 'string',
				)
				.map(([key, value]) => [key, value as string]),
		)
	}

	function getInternalAssetMetadata(extra: unknown): Record<string, string> {
		const record = toRecord(extra)
		return Object.fromEntries(
			Object.entries(record)
				.filter(([key, value]) => INTERNAL_ASSET_METADATA_KEYS.has(key) && typeof value === 'string')
				.map(([key, value]) => [key, value as string]),
		)
	}

	function parseStructuredEntries(raw?: string): Array<Record<string, unknown>> {
		if (!raw) return []
		try {
			const parsed = JSON.parse(raw) as { entries?: unknown }
			return Array.isArray(parsed?.entries)
				? parsed.entries.filter(
						(entry): entry is Record<string, unknown> =>
							Boolean(entry) && typeof entry === 'object' && !Array.isArray(entry),
				  )
				: []
		} catch {
			return []
		}
	}

	function entryString(entry: Record<string, unknown>, key: string): string {
		const value = entry[key]
		return typeof value === 'string' ? value : ''
	}

	function buildAssetRowsFromTwinList(asset: DatasetAsset): Asset[] {
		const privateEntries = parseStructuredEntries(asset.private_ref)
		const mockEntries = parseStructuredEntries(asset.mock_ref)
		const rowCount = Math.max(privateEntries.length, mockEntries.length)
		const groupKey = asset.asset_key
		const rows: Asset[] = []

		for (let index = 0; index < rowCount; index += 1) {
			const privateEntry = privateEntries[index] ?? {}
			const mockEntry = mockEntries[index] ?? {}
			const participantId =
				entryString(privateEntry, 'participant_id') || entryString(mockEntry, 'participant_id')
			const fileType =
				entryString(privateEntry, 'file_type') ||
				entryString(mockEntry, 'file_type') ||
				toStringOrEmpty(asset.extra?.file_type)
			const fileRole =
				entryString(privateEntry, 'file_role') ||
				entryString(mockEntry, 'file_role') ||
				toStringOrEmpty(asset.extra?.file_role)
			const mockSourcePath = entryString(mockEntry, 'source_path')
			const mockUrl = entryString(mockEntry, 'url')
			const metadata: Record<string, string> = {
				__asset_structure: 'twin_list',
				__asset_group: groupKey,
			}

			for (const [key, value] of Object.entries(privateEntry)) {
				if (
					typeof value === 'string' &&
					!['id', 'file_path', 'participant_id', 'file_type', 'file_role', 'entry_name'].includes(key)
				) {
					metadata[key] = value
				}
			}
			for (const [key, value] of Object.entries(mockEntry)) {
				if (
					typeof value === 'string' &&
					!['id', 'url', 'source_path', 'participant_id', 'file_type', 'file_role', 'entry_name'].includes(key) &&
					!(key in metadata)
				) {
					metadata[key] = value
				}
			}

			const filePath = entryString(privateEntry, 'file_path')
			const rowName =
				entryString(privateEntry, 'entry_name') ||
				entryString(mockEntry, 'entry_name') ||
				`${asset.asset_key}_${index + 1}`
			rows.push(
				createAssetFromPath(filePath, {
					rowId: crypto.randomUUID(),
					fileId: asset.private_file_id ?? null,
					name: rowName,
					fileType,
					participantId,
					fileRole,
					metadata,
					exists: true,
					mockPath: mockSourcePath,
					mockUrl:
						mockUrl && (mockUrl.startsWith('http://') || mockUrl.startsWith('https://') || mockUrl.startsWith('syft://'))
							? mockUrl
							: '',
					mockExists: true,
				}),
			)
		}

		return rows
	}

	function getDatasetUiExtra(extra: unknown): DatasetUiExtra {
		const record = toRecord(extra)
		const enabledColumns = Array.isArray(record.enabled_columns)
			? record.enabled_columns.filter((value): value is string => typeof value === 'string')
			: []
		const customColumns = Array.isArray(record.custom_columns)
			? record.custom_columns.filter((value): value is string => typeof value === 'string')
			: []
		return {
			enabled_columns: sanitizeUiColumns(enabledColumns),
			custom_columns: sanitizeUiColumns(customColumns),
		}
	}

	function inferColumnsFromAssets(assetRows: Asset[]): string[] {
		const derived = new Set<string>()
		for (const asset of assetRows) {
			if (asset.participantId) derived.add('participant_id')
			if (asset.fileRole) derived.add('file_role')
			for (const [key, value] of Object.entries(asset.metadata)) {
				if (typeof value === 'string' && value.trim()) derived.add(key)
			}
		}
		return Array.from(derived)
	}

	function pathBasename(path: string): string {
		return path.replace(/\/+$/, '').split('/').pop() || path
	}

	function guessDatasetName(paths: string[]): string {
		const firstPath = paths[0]
		if (!firstPath) return 'dataset'
		return normalizeAssetName(pathBasename(firstPath)) || 'dataset'
	}

	const availableColumnSuggestions = $derived.by(() =>
		suggestedColumns.filter((column) => !enabledColumns.includes(column)),
	)
	function updateAsset(assetId: string, patch: Partial<Asset>) {
		assets = assets.map((asset) => (asset.rowId === assetId ? { ...asset, ...patch } : asset))
	}

	function updateAssetMetadata(assetId: string, key: string, value: string) {
		assets = assets.map((asset) =>
			asset.rowId === assetId
				? { ...asset, metadata: { ...asset.metadata, [key]: value } }
				: asset,
		)
	}

	async function addSuggestedColumn(column: string) {
		const normalized = normalizeAssetName(column)
		if (!normalized) return
		if (enabledColumns.includes(normalized)) return
		if (!availableColumnSuggestions.includes(normalized) && !customColumns.includes(normalized)) {
			customColumns = [...customColumns, normalized]
		}
		enabledColumns = [...enabledColumns, normalized]
		processingColumns = [...processingColumns, normalized]
		await tick()
		const summary = await analyzeDatasetAssetSummary(assets.map((asset) => asset.path))
		suggestedColumns = summary.suggestedColumns
		assets = assets.map((asset) => {
			const analysis = summary.assetsByPath.get(asset.path)
			if (!analysis) return asset
			if (normalized === 'participant_id') {
				return { ...asset, participantId: analysis.participant_id || asset.participantId }
			}
			if (normalized === 'file_role') {
				return { ...asset, fileRole: analysis.file_role || asset.fileRole }
			}
			return {
				...asset,
				metadata: {
					...asset.metadata,
					[normalized]: analysis.derived_fields[normalized] ?? asset.metadata[normalized] ?? '',
				},
			}
		})
		processingColumns = processingColumns.filter((value) => value !== normalized)
		customColumnDraft = ''
		addColumnMenuOpen = false
		toast.success(`Derived ${derivedColumnDefinitions[normalized]?.label ?? normalized}`)
	}

	// Column definitions
	const baseColumns: ColumnDef<Asset>[] = [
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
			accessorKey: 'fileId',
			header: 'ID',
			cell: ({ row }) => row.original.fileId ?? '—',
		},
		{
			accessorKey: 'path',
			header: 'Private File',
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
			accessorKey: 'fileType',
			header: 'File Type',
			cell: ({ row }) =>
				renderComponent(Input, {
					value: row.original.fileType,
					class: 'w-full min-w-[140px] border-0 bg-transparent px-0 shadow-none',
					oninput: (e: Event) =>
						updateAsset(row.original.rowId, {
							fileType: (e.currentTarget as HTMLInputElement).value,
						}),
				}),
		},
	]

	const dynamicColumns = $derived.by<ColumnDef<Asset>[]>(() =>
		enabledColumns.map((column) => {
			const label = column
				.split('_')
				.map((part) => part.charAt(0).toUpperCase() + part.slice(1))
				.join(' ')
			const headerLabel = derivedColumnDefinitions[column]?.label ?? label

			if (column === 'participant_id') {
				return {
					id: column,
					header: processingColumns.includes(column) ? `${headerLabel}...` : headerLabel,
					cell: ({ row }) =>
						renderComponent(Input, {
							value: row.original.participantId,
							class: 'w-full min-w-[140px] border-0 bg-transparent px-0 shadow-none',
							placeholder: 'participant',
							oninput: (e: Event) =>
								updateAsset(row.original.rowId, {
									participantId: (e.currentTarget as HTMLInputElement).value,
								}),
						}),
				} satisfies ColumnDef<Asset>
			}

			if (column === 'file_role') {
				return {
					id: column,
					header: processingColumns.includes(column) ? `${headerLabel}...` : headerLabel,
					cell: ({ row }) =>
						renderComponent(Input, {
							value: row.original.fileRole,
							class: 'w-full min-w-[140px] border-0 bg-transparent px-0 shadow-none',
							placeholder: 'role',
							oninput: (e: Event) =>
								updateAsset(row.original.rowId, {
									fileRole: (e.currentTarget as HTMLInputElement).value,
								}),
						}),
				} satisfies ColumnDef<Asset>
			}

			return {
				id: column,
				header: processingColumns.includes(column) ? `${headerLabel}...` : headerLabel,
				cell: ({ row }) =>
					renderComponent(Input, {
						value: row.original.metadata[column] ?? '',
						class: 'w-full min-w-[140px] border-0 bg-transparent px-0 shadow-none',
						placeholder: label.toLowerCase(),
						oninput: (e: Event) =>
							updateAssetMetadata(
								row.original.rowId,
								column,
								(e.currentTarget as HTMLInputElement).value,
							),
					}),
			} satisfies ColumnDef<Asset>
		}),
	)

	const addColumnAction: ColumnDef<Asset> = {
		id: 'add-column',
		header: () =>
			renderComponent(Button, {
				variant: 'ghost',
				size: 'sm',
				class:
					"h-7 w-7 rounded-full p-0 text-transparent after:text-muted-foreground after:content-['+'] after:text-base after:leading-none hover:after:text-foreground",
				'aria-label': 'Derive file columns',
				onclick: () => {
					addColumnMenuOpen = !addColumnMenuOpen
				},
			}),
		cell: () => '',
		enableSorting: false,
		enableHiding: false,
	}

	const trailingColumns: ColumnDef<Asset>[] = [
		{
			id: 'mock',
			header: 'Mock File',
			cell: ({ row }) => {
				const { mockPath, mockExists, rowId } = row.original
				if (!mockPath) {
				return renderComponent(AssetMockButton, {
					assetId: rowId,
					hasMock: false,
					onSet: setMockData,
					onSetUrl: openMockUrlDialog,
					onRemove: removeMockData,
				})
			}
				return renderComponent(AssetMockCell, {
					filename: row.original.mockUrl || getFileName(mockPath),
					exists: row.original.mockUrl ? true : mockExists,
					isUrl: Boolean(row.original.mockUrl),
				})
			},
		},
		{
			id: 'mockActions',
			header: '',
			cell: ({ row }) => {
				const { mockPath, rowId } = row.original
				if (!mockPath) return ''
				return renderComponent(AssetMockButton, {
					assetId: rowId,
					hasMock: true,
					onSet: setMockData,
					onSetUrl: openMockUrlDialog,
					onRemove: removeMockData,
				})
			},
		},
		{
			id: 'actions',
			header: '',
			cell: ({ row }) => {
				const { rowId: assetId, path: assetPath, exists } = row.original
				return renderComponent(AssetDeleteButton, {
					assetId,
					assetPath,
					exists,
					onDelete: confirmDeleteAsset,
				})
			},
		},
	]

	const tableColumns = $derived.by<ColumnDef<Asset>[]>(() => [
		...baseColumns,
		addColumnAction,
		...dynamicColumns,
		...trailingColumns,
	])
	const assetsTableMinWidth = $derived(`${940 + enabledColumns.length * 180}px`)

	const table = createSvelteTable({
		get data() {
			return visibleAssets
		},
		get columns() {
			return tableColumns
		},
		state: {
			get pagination() {
				return pagination
			},
			get sorting() {
				return sorting
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
		getSortedRowModel: getSortedRowModel(),
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
		onSortingChange: (updater) => {
			if (typeof updater === 'function') {
				sorting = updater(sorting)
			} else {
				sorting = updater
			}
		},
		onColumnFiltersChange: (updater) => {
			if (typeof updater === 'function') {
				columnFilters = updater(columnFilters)
			} else {
				columnFilters = updater
			}
		},
		getRowId: (row) => row.rowId,
	})

	onMount(async () => {
		await loadDataset()
		await loadParticipants()
	})

	$effect(() => {
		processingSummarySignature
		if (loading) return
		void refreshProcessingSummary(assets)
	})

	function consumePendingImportPaths(): string[] {
		try {
			const raw = sessionStorage.getItem(PENDING_DATASET_IMPORT_KEY)
			sessionStorage.removeItem(PENDING_DATASET_IMPORT_KEY)
			if (!raw) return []
			const parsed = JSON.parse(raw)
			return Array.isArray(parsed) ? parsed.filter((value): value is string => typeof value === 'string') : []
		} catch {
			return []
		}
	}

	async function buildAssets(datasetAssets: DatasetAsset[]) {
		const sourcePaths = datasetAssets
			.map((asset) => asset.resolved_private_path || asset.private_path || '')
			.filter(Boolean)
		const summary = await analyzeDatasetAssetSummary(sourcePaths)
		suggestedColumns = summary.suggestedColumns
		const loadedAssets = datasetAssets.flatMap((a) => {
			if (a.kind === 'twin_list') {
				return buildAssetRowsFromTwinList(a)
			}
			const assetPath = a.resolved_private_path || a.private_path || ''
			const analysis = summary.assetsByPath.get(assetPath)
			const metadata = {
				...(analysis?.derived_fields ?? {}),
				...getInternalAssetMetadata(a.extra),
				...getPersistedAssetMetadata(a.extra),
			}
			return [createAssetFromPath(assetPath, {
				rowId: crypto.randomUUID(),
				fileId: a.private_file_id ?? null,
				name: a.asset_key,
				fileType: toNonEmptyStringOrUndefined(a.extra?.file_type) ?? analysis?.file_type,
				participantId:
					toNonEmptyStringOrUndefined(a.extra?.participant_id) ?? analysis?.participant_id,
				fileRole: toNonEmptyStringOrUndefined(a.extra?.file_role) ?? analysis?.file_role,
				metadata,
				exists: true,
				mockPath: a.resolved_mock_path || a.mock_path || '',
				mockUrl:
					toNonEmptyStringOrUndefined(a.extra?.mock_url) ??
					(a.mock_ref?.startsWith('http://') ||
					a.mock_ref?.startsWith('https://') ||
					a.mock_ref?.startsWith('syft://')
						? a.mock_ref
						: ''),
				mockExists: true,
			})]
		})

		// Check which files exist
		const pathsToCheck: string[] = []
		for (const a of loadedAssets) {
			if (a.path) pathsToCheck.push(a.path)
			if (a.mockPath) pathsToCheck.push(a.mockPath)
		}

		if (pathsToCheck.length > 0) {
			const existsResults = await Promise.all(
				pathsToCheck.map((path) =>
					invoke<boolean>('path_exists', { path }).catch(() => true),
				),
			)
			let resultIdx = 0
			loadedAssets.forEach((asset) => {
				if (asset.path) {
					asset.exists = existsResults[resultIdx++] ?? true
				}
				if (asset.mockPath) {
					asset.mockExists = existsResults[resultIdx++] ?? true
				}
			})
		}

		return loadedAssets
	}

	async function loadDataset() {
		loading = true
		error = null

		try {
			if (isNewDataset) {
			currentName = ''
			description = ''
			version = '1.0.0'
			assets = []
				originalName = ''
				originalDescription = ''
			originalVersion = '1.0.0'
			isNetwork = false
			isPublished = false
			author = ''
			rowSelection = {}

			const pendingPaths = consumePendingImportPaths()
			if (pendingPaths.length > 0) {
				await importPendingPaths(pendingPaths)
				currentName = guessDatasetName(pendingPaths)
			}
			await refreshProcessingSummary(assets)
				return
			}

			const datasets = await invoke<DatasetWithAssets[]>('list_datasets_with_assets')
			const datasetWithAssets = datasets.find((d) => d.dataset.name === datasetName)

			if (!datasetWithAssets) {
				error = 'Dataset not found'
				return
			}

			const { dataset, assets: datasetAssets } = datasetWithAssets

			currentName = dataset.name
			description = dataset.description || ''
			version = dataset.version || '1.0.0'

			assets = await buildAssets(datasetAssets)
			const uiExtra = getDatasetUiExtra(dataset.extra)
			customColumns = uiExtra.custom_columns ?? []
			enabledColumns =
				uiExtra.enabled_columns && uiExtra.enabled_columns.length > 0
					? uiExtra.enabled_columns
					: inferColumnsFromAssets(assets)

			originalName = currentName
			originalDescription = description
			originalVersion = version

			isNetwork = dataset.extra?.is_network === true
			author = dataset.author || ''

			await checkPublishStatus()
			await refreshProcessingSummary(assets)
		} catch (e) {
			error = e instanceof Error ? e.message : String(e)
		} finally {
			loading = false
		}
	}

	async function loadParticipants() {
		try {
			knownParticipants = await invoke<ParticipantRecord[]>('get_participants')
		} catch {
			knownParticipants = []
		}
	}

	async function reloadAssets() {
		try {
			if (isNewDataset) {
				rowSelection = {}
				return
			}

			const datasets = await invoke<DatasetWithAssets[]>('list_datasets_with_assets')
			const datasetWithAssets = datasets.find((d) => d.dataset.name === datasetName)

			if (!datasetWithAssets) {
				error = 'Dataset not found'
				return
			}

			assets = await buildAssets(datasetWithAssets.assets)
			const uiExtra = getDatasetUiExtra(datasetWithAssets.dataset.extra)
			customColumns = uiExtra.custom_columns ?? []
			enabledColumns =
				uiExtra.enabled_columns && uiExtra.enabled_columns.length > 0
					? uiExtra.enabled_columns
					: inferColumnsFromAssets(assets)
			rowSelection = {}
			await refreshProcessingSummary(assets)
		} catch (e) {
			error = e instanceof Error ? e.message : String(e)
		}
	}

	// Helper to save the full dataset (used for asset changes)
	async function saveDataset() {
		await invoke('save_dataset_from_ui', {
			request: {
				name: currentName.trim(),
				description: description.trim() || null,
				version: version.trim() || '1.0.0',
				enabled_columns: enabledColumns,
				custom_columns: customColumns,
				assets: assets.map((asset) => ({
					name: asset.name,
					path: asset.path,
					mock_path: asset.mockPath || '',
					mock_url: asset.mockUrl || '',
					file_type: asset.fileType,
					participant_id: asset.participantId,
					file_role: asset.fileRole,
					metadata: asset.metadata,
				})),
				original_name: originalName || null,
			},
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
			const createdName = currentName.trim()
			if (isNewDataset && !originalName && createdName) {
				originalName = createdName
				originalDescription = description
				originalVersion = version
				toast.success(`Added ${newAssets.length} file${newAssets.length === 1 ? '' : 's'}`)
				goto(`/datasets/${createdName}`, { replaceState: true })
				return
			}
			await reloadAssets()
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

	function addCustomColumn() {
		const normalized = normalizeAssetName(customColumnDraft)
		if (!normalized) return
		if (customColumns.includes(normalized) || enabledColumns.includes(normalized)) {
			toast.info('Column already present')
			customColumnDraft = ''
			return
		}
		customColumns = [...customColumns, normalized]
		enabledColumns = [...enabledColumns, normalized]
		customColumnDraft = ''
	}

	function selectedAssetIds(): string[] {
		return Object.keys(rowSelection).filter((id) => rowSelection[id])
	}

	async function groupSelectedAsList() {
		const selectedIds = selectedAssetIds()
		if (selectedIds.length < 2) {
			toast.info('Select at least two assets to group')
			return
		}

		const selectedAssets = assets.filter((asset) => selectedIds.includes(asset.rowId))
		const participantIds = Array.from(
			new Set(selectedAssets.map((asset) => asset.participantId.trim()).filter(Boolean)),
		)
		const baseLabel =
			participantIds.length === 1
				? participantIds[0]
				: `${currentName || 'dataset'}_list_${Date.now().toString().slice(-5)}`
		const groupKey = normalizeAssetName(baseLabel) || `list_${Date.now()}`

		assets = assets.map((asset) =>
			selectedIds.includes(asset.rowId)
				? {
						...asset,
						metadata: {
							...asset.metadata,
							__asset_structure: 'twin_list',
							__asset_group: groupKey,
						},
				  }
				: asset,
		)

		savingAssets = true
		try {
			await saveDataset()
			await reloadAssets()
			toast.success(`Grouped ${selectedIds.length} assets as a list`)
		} catch (e) {
			error = e instanceof Error ? e.message : String(e)
		} finally {
			savingAssets = false
		}
	}

	async function ungroupSelectedListAssets() {
		const selectedIds = selectedAssetIds()
		if (selectedIds.length === 0) return

		assets = assets.map((asset) => {
			if (!selectedIds.includes(asset.rowId)) return asset
			const metadata = { ...asset.metadata }
			delete metadata.__asset_structure
			delete metadata.__asset_group
			delete metadata.__entry_id
			return { ...asset, metadata }
		})

		savingAssets = true
		try {
			await saveDataset()
			await reloadAssets()
			toast.success('Removed list grouping from selected assets')
		} catch (e) {
			error = e instanceof Error ? e.message : String(e)
		} finally {
			savingAssets = false
		}
	}

	async function groupAssetsByParticipant() {
		const participantAssets = assets.filter((asset) => asset.participantId.trim())
		if (participantAssets.length < 2) {
			toast.info('Need at least two participant-tagged assets to group')
			return
		}

		assets = assets.map((asset) => {
			const participantId = asset.participantId.trim()
			if (!participantId) return asset
			return {
				...asset,
				metadata: {
					...asset.metadata,
					__asset_structure: 'twin_list',
					__asset_group: normalizeAssetName(participantId) || participantId,
				},
			}
		})

		savingAssets = true
		try {
			await saveDataset()
			await reloadAssets()
			toast.success('Grouped assets by participant')
		} catch (e) {
			error = e instanceof Error ? e.message : String(e)
		} finally {
			savingAssets = false
		}
	}

	async function importPendingPaths(paths: string[]) {
		if (paths.length === 0) return

		const normalized = [...new Set(paths.map((path) => path.trim()).filter(Boolean))]
		const directoryFlags = await Promise.all(
			normalized.map((path) =>
				invoke<boolean>('is_directory', { path }).catch(() => false),
			),
		)

		const directFiles = normalized.filter((_path, index) => !directoryFlags[index])
		const folders = normalized.filter((_path, index) => directoryFlags[index])
		const discoveredFiles: string[] = [...directFiles]

		for (const folderPath of folders) {
			const extensionCounts = await invoke<ExtensionCount[]>('get_extensions', {
				path: folderPath,
			})
			const extensions = extensionCounts
				.map((item) => item.extension?.trim())
				.filter((extension): extension is string => Boolean(extension))

			if (extensions.length === 0) continue

			const folderFiles = await invoke<string[]>('search_txt_files', {
				path: folderPath,
				extensions,
			})
			discoveredFiles.push(...folderFiles)
		}

		const uniqueFiles = [...new Set(discoveredFiles)]
		if (uniqueFiles.length === 0) {
			toast.error('No importable files found in the selected files or folders')
			return
		}

		await addAssetsWithDuplicateCheck(await createAssetsFromPaths(uniqueFiles))
	}

	async function importReferenceBundle() {
		referenceImporting = true
		try {
			const result = await invoke<ReferenceDownloadResult>('fetch_reference_data_with_progress')
			const base = result.reference_dir
			const newAssets = await createAssetsFromPaths([
				`${base}/GRCh38_full_analysis_set_plus_decoy_hla.fa`,
				`${base}/GRCh38_full_analysis_set_plus_decoy_hla.fa.fai`,
			])
			await addAssetsWithDuplicateCheck(newAssets)
			toast.success('GRCh38 reference added to this dataset')
		} catch (e) {
			error = e instanceof Error ? e.message : String(e)
			toast.error('Failed to import GRCh38 reference')
		} finally {
			referenceImporting = false
		}
	}

	async function addFiles() {
		try {
			const { open: openDialog } = await import('@tauri-apps/plugin-dialog')
			const selected = await openDialog({
				multiple: true,
				directory: false,
				title: 'Add Files',
			})
			if (selected && Array.isArray(selected)) {
				const newAssets = await createAssetsFromPaths(selected)
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
				title: 'Add Folder',
			})
			if (selectedDir && typeof selectedDir === 'string') {
				// Get all extensions in the folder
				const extensionCounts = await invoke<ExtensionCount[]>('get_extensions', {
					path: selectedDir,
				})
				const normalized = extensionCounts.filter((ext) => ext.extension?.trim())

				if (normalized.length === 0) {
					toast.error('No file types found in folder')
					return
				}

				pendingFolderPath = selectedDir
				fileTypeOptions = normalized
				selectedExtensions = new Set(normalized.map((ext) => ext.extension))
				fileTypeDialogOpen = true
			}
		} catch (e) {
			console.error('Failed to open folder dialog:', e)
			error = e instanceof Error ? e.message : String(e)
		}
	}

	function toggleExtension(extension: string, checked: boolean) {
		const next = new Set(selectedExtensions)
		if (checked) {
			next.add(extension)
		} else {
			next.delete(extension)
		}
		selectedExtensions = next
	}

	function toggleAllExtensions(checked: boolean) {
		if (checked) {
			selectedExtensions = new Set(fileTypeOptions.map((ext) => ext.extension))
		} else {
			selectedExtensions = new Set()
		}
	}

	function closeFileTypeDialog() {
		fileTypeDialogOpen = false
		pendingFolderPath = null
		fileTypeOptions = []
		selectedExtensions = new Set()
	}

	async function confirmFileTypes() {
		if (!pendingFolderPath) return

		const extensions = Array.from(selectedExtensions)
		if (extensions.length === 0) {
			toast.error('Select at least one file type')
			return
		}

		try {
			const files = await invoke<string[]>('search_txt_files', {
				path: pendingFolderPath,
				extensions,
			})

			if (files.length === 0) {
				toast.error('No files found for the selected types')
				return
			}

			const newAssets = await createAssetsFromPaths(files)

			closeFileTypeDialog()
			await addAssetsWithDuplicateCheck(newAssets)
		} catch (e) {
			console.error('Failed to load files for selected types:', e)
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

		assets = assets.filter((a) => a.rowId !== pendingDeleteAssetId)
		const newSelection = { ...rowSelection }
		delete newSelection[pendingDeleteAssetId]
		rowSelection = newSelection

		deleteAssetDialogOpen = false
		pendingDeleteAssetId = null

		// Auto-save
		savingAssets = true
		try {
			await saveDataset()
			await reloadAssets()
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
		assets = assets.filter((a) => !selectedIds.includes(a.rowId))
		rowSelection = {}

		deleteBulkDialogOpen = false

		// Auto-save
		savingAssets = true
		try {
			await saveDataset()
			await reloadAssets()
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

			const oldName = originalName
			const newName = currentName.trim()

			originalName = newName
			originalDescription = description
			originalVersion = version

			toast.success('Dataset saved')

			if (oldName !== newName) {
				goto(`/datasets/${newName}`, { replaceState: true })
			}
		} catch (e) {
			error = e instanceof Error ? e.message : String(e)
			toast.error('Failed to save dataset')
		} finally {
			saving = false
		}
	}

	async function checkPublishStatus() {
		try {
			isPublished = await invoke('is_dataset_published', { name: originalName })
		} catch (e) {
			console.error('Failed to check publish status:', e)
		}
	}

	async function setMockData(assetId: string) {
		try {
			const { open: openDialog } = await import('@tauri-apps/plugin-dialog')
			const selected = await openDialog({
				multiple: false,
				directory: false,
				title: 'Select Mock File',
			})
			if (selected && typeof selected === 'string') {
				assets = assets.map((a) => {
					if (a.rowId === assetId) {
						return { ...a, mockPath: selected, mockUrl: '', mockExists: true }
					}
					return a
				})

				// Auto-save
				savingAssets = true
				try {
					await saveDataset()
					await reloadAssets()
					toast.success('Mock data added')
				} catch (e) {
					error = e instanceof Error ? e.message : String(e)
				} finally {
					savingAssets = false
				}
			}
		} catch (e) {
			console.error('Failed to open file dialog:', e)
			error = e instanceof Error ? e.message : String(e)
		}
	}

	async function removeMockData(assetId: string) {
		assets = assets.map((a) => {
			if (a.rowId === assetId) {
				return { ...a, mockPath: '', mockUrl: '', mockExists: false }
			}
			return a
		})

		// Auto-save
		savingAssets = true
		try {
			await saveDataset()
			await reloadAssets()
			toast.success('Mock data removed')
		} catch (e) {
			error = e instanceof Error ? e.message : String(e)
		} finally {
			savingAssets = false
		}
	}

	let publishing = $state(false)
	let publishConfirmOpen = $state(false)

	async function handlePublish() {
		publishConfirmOpen = false
		publishing = true
		try {
			await invoke('publish_dataset', {
				name: currentName,
				copyMock: true,
			})
			toast.success('Dataset published successfully!')
			await checkPublishStatus()
		} catch (e) {
			toast.error(e instanceof Error ? e.message : String(e))
		} finally {
			publishing = false
		}
	}

	let unpublishing = $state(false)
	let unpublishConfirmOpen = $state(false)

	async function handleUnpublish() {
		unpublishConfirmOpen = false
		unpublishing = true
		try {
			await invoke('unpublish_dataset', { name: currentName })
			toast.success('Dataset unpublished successfully')
			await checkPublishStatus()
		} catch (e) {
			toast.error(e instanceof Error ? e.message : String(e))
		} finally {
			unpublishing = false
		}
	}

	function getFileName(path: string): string {
		return path.split('/').pop() || path
	}

	function openMockUrlDialog(assetId: string) {
		const asset = assets.find((entry) => entry.rowId === assetId)
		pendingMockUrlAssetId = assetId
		mockUrlDraft = asset?.mockUrl || ''
		mockUrlDialogOpen = true
	}

	async function saveMockUrl() {
		if (!pendingMockUrlAssetId) return
		const trimmed = mockUrlDraft.trim()
		if (!trimmed) {
			toast.error('Mock URL cannot be empty')
			return
		}

		assets = assets.map((asset) =>
			asset.rowId === pendingMockUrlAssetId
				? { ...asset, mockUrl: trimmed, mockPath: '', mockExists: false }
				: asset,
		)
		mockUrlDialogOpen = false
		pendingMockUrlAssetId = null
		mockUrlDraft = ''

		savingAssets = true
		try {
			await saveDataset()
			await reloadAssets()
			toast.success('Mock URL added')
		} catch (e) {
			error = e instanceof Error ? e.message : String(e)
		} finally {
			savingAssets = false
		}
	}

	function closeMockUrlDialog() {
		mockUrlDialogOpen = false
		pendingMockUrlAssetId = null
		mockUrlDraft = ''
	}

	let validAssetCount = $derived(assets.filter((a) => a.name && (a.path || a.mockPath || a.mockUrl)).length)
	let missingCount = $derived(
		assets.filter((a) => !a.exists || (a.mockPath && !a.mockExists && !a.mockUrl)).length,
	)
	let selectedCount = $derived(Object.keys(rowSelection).filter((id) => rowSelection[id]).length)
	let selectedGroupedCount = $derived(
		assets.filter(
			(asset) => rowSelection[asset.rowId] && asset.metadata.__asset_structure === 'twin_list',
		).length,
	)

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
		table.getColumn('path')?.setFilterValue(value)
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
						<div class="flex items-center gap-2">
							<h1 class="font-semibold text-lg truncate">{currentName}</h1>
							{#if isNetwork}
								<Badge variant="secondary" class="h-5 text-[10px] uppercase font-bold tracking-wider">
									<StarIcon class="size-2.5 mr-1 fill-primary text-primary" />
									Network
								</Badge>
							{/if}
						</div>
						<p class="text-sm text-muted-foreground">
							v{version} • {validAssetCount}
							{validAssetCount === 1 ? 'asset' : 'assets'}
						</p>
					</div>
				</div>

					<div class="flex items-center gap-2">
						{#if canRequestRun}
							<Button
								variant="outline"
								size="sm"
								data-testid="dataset-request-run"
								onclick={() => (requestRunDialogOpen = true)}
							>
								<SendIcon class="size-4 mr-2" />
								Request Run
							</Button>
						{/if}

						{#if savingAssets}
					<Badge variant="secondary" class="gap-1 px-2">
						<Loader2Icon class="size-3 animate-spin" />
						Saving...
					</Badge>
				{/if}

				{#if !isNetwork}
					<Tooltip.Provider>
						<Tooltip.Root delayDuration={0}>
							<Tooltip.Trigger>
								{#snippet child({ props })}
									<div {...props}>
										{#if isPublished}
											<Button
												size="sm"
												variant="outline"
												disabled={unpublishing}
												onclick={() => (unpublishConfirmOpen = true)}
												class="gap-2"
											>
												{#if unpublishing}
													<Loader2Icon class="size-4 animate-spin" />
													Unpublishing...
												{:else}
													<GlobeIcon class="size-4 text-primary" />
													Unpublish
												{/if}
											</Button>
										{:else}
											<Button
												size="sm"
												variant="default"
												disabled={!allAssetsHaveMocks || publishing}
												onclick={() => (publishConfirmOpen = true)}
											>
												{#if publishing}
													<Loader2Icon class="size-4 animate-spin" />
													Publishing...
												{:else}
													<GlobeIcon class="size-4" />
													Publish
												{/if}
											</Button>
										{/if}
									</div>
								{/snippet}
							</Tooltip.Trigger>
							{#if !allAssetsHaveMocks}
								<Tooltip.Content side="bottom" class="max-w-xs">
									<div class="flex items-start gap-2">
										<AlertTriangleIcon class="size-4 text-warning shrink-0 mt-0.5" />
										<p>
											You must add mock data for all <b>{missingMockCount}</b> remaining assets in order
											to publish your dataset.
										</p>
									</div>
								</Tooltip.Content>
							{/if}
						</Tooltip.Root>
					</Tooltip.Provider>
				{/if}
			</div>
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

				{#if processingSummary && (processingSummary.warnings.length > 0 || processingSummary.suggested_actions.length > 0)}
					<div class="rounded-lg border px-4 py-3 text-sm">
						<div class="flex flex-wrap items-start justify-between gap-3">
							<div class="space-y-1">
								<p class="font-medium">Processing</p>
								<p class="text-muted-foreground">
									{processingSummary.primary_asset_count} primary assets, {processingSummary.participant_count}
									participant{processingSummary.participant_count === 1 ? '' : 's'}, {processingSummary.reference_count}
									reference{processingSummary.reference_count === 1 ? '' : 's'}
								</p>
							</div>
							{#if processingSummaryBusy}
								<Badge variant="secondary" class="gap-1 px-2">
									<Loader2Icon class="size-3 animate-spin" />
									Updating...
								</Badge>
							{/if}
						</div>
						{#if processingSummary.warnings.length > 0}
							<div class="mt-3 flex flex-wrap gap-2">
								{#each processingSummary.warnings as warning (warning)}
									<span class="text-muted-foreground">{warning}</span>
								{/each}
							</div>
						{/if}
						{#if processingSummary.suggested_actions.length > 0}
							<div class="mt-3 flex flex-wrap gap-1.5">
								{#each processingSummary.suggested_actions as action (action.key)}
									<Button
										variant="ghost"
										size="sm"
										class="h-8 px-2 text-muted-foreground hover:text-foreground"
										title={action.description}
										onclick={() => {
											if (action.key === 'group_by_participant') {
												groupAssetsByParticipant()
												return
											}
											addSuggestedColumn(action.key)
										}}
									>
										{action.label}
									</Button>
								{/each}
							</div>
						{/if}
					</div>
				{/if}

				<div class="rounded-lg border px-4 py-3 text-sm">
					<div class="flex flex-wrap items-center justify-between gap-3">
						<div>
							<p class="font-medium">Participants</p>
							<p class="text-muted-foreground">
								{participantOptions.length} known in this dataset view
							</p>
						</div>
						<div class="flex items-center gap-2">
							<label for="participant-filter" class="text-muted-foreground">Filter</label>
							<select
								id="participant-filter"
								bind:value={participantFilter}
								class="border-input bg-background rounded-md border px-2 py-1 text-sm"
							>
								<option value="all">All participants</option>
								{#each participantOptions as option (option)}
									<option value={option}>{option}</option>
								{/each}
							</select>
						</div>
					</div>
				</div>

				<div class="rounded-lg border px-4 py-3 text-sm">
					<div class="flex flex-wrap items-center justify-between gap-3">
						<div>
							<p class="font-medium">References</p>
							<p class="text-muted-foreground">
								{referenceAssets.length} reference asset{referenceAssets.length === 1 ? '' : 's'} detected
							</p>
						</div>
						<div class="flex flex-wrap items-center gap-2">
							<Button variant="outline" size="sm" onclick={() => addSuggestedColumn('reference_file')}>
								Attach References
							</Button>
							<Button
								variant="ghost"
								size="sm"
								onclick={importReferenceBundle}
								disabled={referenceImporting}
							>
								{#if referenceImporting}
									<Loader2Icon class="size-4 animate-spin" />
									Importing...
								{:else}
									Import GRCh38
								{/if}
							</Button>
						</div>
					</div>
				</div>

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
						<div class="grid gap-4 sm:grid-cols-2">
							<div class="space-y-2">
								<label for="name" class="text-sm font-medium">Dataset Name</label>
								<Input id="name" bind:value={currentName} placeholder="Dataset name" />
							</div>
							<div class="space-y-2">
								<label for="version" class="text-sm font-medium">Version</label>
								<Input id="version" bind:value={version} placeholder="1.0.0" />
							</div>
						</div>

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
					</Card.Content>
				</Card.Root>

				<!-- Assets -->
				<Card.Root class="shadow-none">
					<Card.Header>
						<div class="flex items-center justify-between">
							<div>
								<Card.Title class="text-base">Assets</Card.Title>
								<Card.Description>Files included in this dataset</Card.Description>
							</div>
							<div class="text-sm text-muted-foreground">{assets.length} assets</div>
						</div>
					</Card.Header>
					<Card.Content class="space-y-4">
						<div class="flex flex-wrap items-center justify-between gap-3">
							<div class="flex items-center gap-2">
								<Button variant="outline" data-testid="dataset-add-files" onclick={addFiles}>
									<FileIcon class="size-4" />
									Add Files
								</Button>
								<Button variant="ghost" data-testid="dataset-add-folder" onclick={addFolder}>
									<FolderIcon class="size-4" />
									Scan Folder
								</Button>
							</div>
							{#if missingCount > 0}
								<div class="text-sm text-destructive">{missingCount} missing</div>
							{/if}
						</div>

						{#if addColumnMenuOpen}
							<div class="space-y-2 border-y py-3 text-sm">
								<div class="flex items-center justify-between gap-3">
									<p class="text-muted-foreground">Derive columns from filenames and file relationships.</p>
									<Button variant="ghost" size="sm" class="h-7 px-2" onclick={() => (addColumnMenuOpen = false)}>
										Close
									</Button>
								</div>
								<div class="flex flex-wrap gap-1.5">
									{#each availableColumnSuggestions as column (column)}
										<Button
											variant="ghost"
											size="sm"
											class="h-8 px-2 text-muted-foreground hover:text-foreground"
											title={derivedColumnDefinitions[column]?.description ?? column}
											onclick={() => addSuggestedColumn(column)}
										>
											{derivedColumnDefinitions[column]?.label ?? column}
										</Button>
									{:else}
										<span class="text-muted-foreground">No derived columns suggested right now.</span>
									{/each}
								</div>
								<div class="flex gap-2 pt-1">
									<Input
										id="staged-custom-column"
										value={customColumnDraft}
										oninput={(e) => (customColumnDraft = e.currentTarget.value)}
										placeholder="Custom column"
										class="max-w-[220px] border-0 bg-transparent px-0 shadow-none"
									/>
									<Button variant="ghost" size="sm" class="h-8 px-2" onclick={() => addSuggestedColumn(normalizeAssetName(customColumnDraft))}>
										Add
									</Button>
								</div>
							</div>
						{/if}

						{#if assets.length === 0}
							<div class="py-10 text-center">
								<div class="flex flex-col items-center gap-2">
									<div>
										<p class="font-medium">No assets yet</p>
										<p class="text-muted-foreground text-sm">Scan files to start building this dataset</p>
									</div>
								</div>
							</div>
						{:else}
							<!-- Toolbar -->
							<div class="mb-3 flex items-center justify-between gap-4">
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
										<Button variant="outline" size="sm" onclick={groupSelectedAsList}>
											Group as List
										</Button>
										{#if selectedGroupedCount > 0}
											<Button variant="ghost" size="sm" onclick={ungroupSelectedListAssets}>
												Ungroup
											</Button>
										{/if}
										<Button variant="destructive" size="sm" onclick={confirmDeleteSelected}>
											<TrashIcon class="size-4" />
											Delete {selectedCount}
										</Button>
									{/if}
								</div>
							</div>

							<!-- Table -->
							<div class="overflow-x-auto">
								<Table.Root class="w-max min-w-full table-fixed" style={`min-width: ${assetsTableMinWidth};`}>
									<Table.Header>
										{#each table.getHeaderGroups() as headerGroup (headerGroup.id)}
											<Table.Row>
												{#each headerGroup.headers as header (header.id)}
													<Table.Head
														class="[&:has([role=checkbox])]:pl-3 {header.column.id === 'select'
															? 'w-10'
															: header.column.id === 'fileId'
																? 'w-20'
																: header.column.id === 'path'
																	? 'w-[320px]'
																	: header.column.id === 'fileType'
																		? 'w-[160px]'
																		: header.column.id === 'add-column'
																			? 'w-12'
																			: enabledColumns.includes(header.column.id)
																				? 'w-[180px]'
																				: header.column.id === 'mock'
																					? 'w-[260px]'
																	: header.column.id === 'mockActions' || header.column.id === 'actions'
																		? 'w-12'
																		: ''}"
													>
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
													<Table.Cell
														class="[&:has([role=checkbox])]:pl-3 {cell.column.id === 'path'
															? 'max-w-0 min-w-[320px] overflow-hidden'
															: cell.column.id === 'fileType'
																? 'min-w-[160px]'
																: cell.column.id === 'add-column'
																	? 'min-w-12'
																	: enabledColumns.includes(cell.column.id)
																		? 'min-w-[180px]'
																		: cell.column.id === 'mock'
																			? 'max-w-0 min-w-[260px] overflow-hidden'
																			: cell.column.id === 'mockActions' || cell.column.id === 'actions'
																				? 'min-w-12'
																				: ''}"
													>
														<FlexRender
															content={cell.column.columnDef.cell}
															context={cell.getContext()}
														/>
													</Table.Cell>
												{/each}
											</Table.Row>
										{:else}
											<Table.Row>
												<Table.Cell colspan={tableColumns.length} class="h-24 text-center">
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
											Are you sure you want to delete <strong>{currentName}</strong>? This action
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
				Are you sure you want to remove {selectedCount} asset{selectedCount === 1 ? '' : 's'} from the
				dataset?
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
				{duplicateNames.length} asset{duplicateNames.length === 1 ? '' : 's'} already exist{duplicateNames.length ===
				1
					? 's'
					: ''} in this dataset:
				<strong
					>{duplicateNames.slice(0, 3).join(', ')}{duplicateNames.length > 3
						? `, +${duplicateNames.length - 3} more`
						: ''}</strong
				>
			</AlertDialog.Description>
		</AlertDialog.Header>
		<AlertDialog.Footer>
			<AlertDialog.Cancel>Cancel</AlertDialog.Cancel>
			<Button variant="outline" onclick={handleDuplicateKeep}>Keep Existing</Button>
			<AlertDialog.Action onclick={handleDuplicateReplace}>Replace</AlertDialog.Action>
		</AlertDialog.Footer>
	</AlertDialog.Content>
</AlertDialog.Root>

<!-- File Types Dialog -->
<Dialog.Root
	bind:open={fileTypeDialogOpen}
	onOpenChange={(open) => {
		if (!open) closeFileTypeDialog()
	}}
>
	<Dialog.Content class="max-w-lg">
		<Dialog.Header>
			<Dialog.Title>Select file types to import</Dialog.Title>
			<Dialog.Description>
				Choose which file extensions from the folder should be included.
			</Dialog.Description>
		</Dialog.Header>
		<div class="space-y-3">
			<label class="flex items-center justify-between rounded-md border px-3 py-2">
				<div class="flex items-center gap-2">
					<Checkbox
						checked={allExtensionsSelected}
						indeterminate={someExtensionsSelected}
						onCheckedChange={(value) => toggleAllExtensions(!!value)}
					/>
					<span class="text-sm font-medium">All file types</span>
				</div>
				<Badge variant="outline">{fileTypeOptions.length}</Badge>
			</label>
			<div class="max-h-64 overflow-auto rounded-md border">
				{#each sortedFileTypes as option (option.extension)}
					<label class="flex items-center justify-between px-3 py-2">
						<div class="flex items-center gap-2">
							<Checkbox
								checked={selectedExtensions.has(option.extension)}
								onCheckedChange={(value) => toggleExtension(option.extension, !!value)}
							/>
							<span class="text-sm">{option.extension}</span>
						</div>
						<Badge variant="outline">{option.count}</Badge>
					</label>
				{/each}
			</div>
		</div>
		<Dialog.Footer class="mt-4">
			<Button variant="outline" onclick={closeFileTypeDialog}>Cancel</Button>
			<Button onclick={confirmFileTypes} disabled={selectedExtensions.size === 0}>
				Import selected
			</Button>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>

<Dialog.Root
	bind:open={mockUrlDialogOpen}
	onOpenChange={(open) => {
		if (!open) closeMockUrlDialog()
	}}
>
	<Dialog.Content class="max-w-md">
		<Dialog.Header>
			<Dialog.Title>Add Mock URL</Dialog.Title>
			<Dialog.Description>
				Use a public or Syft URL instead of a local mock file for this asset.
			</Dialog.Description>
		</Dialog.Header>
		<div class="space-y-2">
			<label for="mock-url" class="text-sm font-medium">Mock URL</label>
			<Input
				id="mock-url"
				bind:value={mockUrlDraft}
				placeholder="https://... or syft://..."
			/>
		</div>
		<Dialog.Footer class="mt-4">
			<Button variant="outline" onclick={closeMockUrlDialog}>Cancel</Button>
			<Button onclick={saveMockUrl} disabled={!mockUrlDraft.trim()}>
				Save URL
			</Button>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>

<!-- Publish Confirmation Dialog -->
<AlertDialog.Root bind:open={publishConfirmOpen}>
	<AlertDialog.Content>
		<AlertDialog.Header>
			<AlertDialog.Title>Publish Dataset</AlertDialog.Title>
			<AlertDialog.Description>
				Are you sure you want to publish <strong>{currentName}</strong>? This will make the dataset
				metadata and mock files visible to your peers on SyftBox.
			</AlertDialog.Description>
		</AlertDialog.Header>
		<AlertDialog.Footer>
			<AlertDialog.Cancel>Cancel</AlertDialog.Cancel>
			<AlertDialog.Action onclick={handlePublish}>Publish</AlertDialog.Action>
		</AlertDialog.Footer>
	</AlertDialog.Content>
</AlertDialog.Root>

<!-- Unpublish Confirmation Dialog -->
<AlertDialog.Root bind:open={unpublishConfirmOpen}>
	<AlertDialog.Content>
		<AlertDialog.Header>
			<AlertDialog.Title>Unpublish Dataset</AlertDialog.Title>
			<AlertDialog.Description>
				Are you sure you want to unpublish <strong>{currentName}</strong>? This will remove the
				dataset from the public index on SyftBox.
			</AlertDialog.Description>
		</AlertDialog.Header>
		<AlertDialog.Footer>
			<AlertDialog.Cancel>Cancel</AlertDialog.Cancel>
			<AlertDialog.Action onclick={handleUnpublish} class="bg-destructive text-white hover:bg-destructive/90">
				Unpublish
			</AlertDialog.Action>
		</AlertDialog.Footer>
	</AlertDialog.Content>
</AlertDialog.Root>

<RequestRunDialog
	bind:open={requestRunDialogOpen}
	datasetName={datasetName}
	authorEmail={author}
/>
