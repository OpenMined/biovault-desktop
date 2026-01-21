<script lang="ts">
	import { onMount } from 'svelte'
	import { invoke } from '@tauri-apps/api/core'
	import { toast } from 'svelte-sonner'
	import { Button } from '$lib/components/ui/button/index.js'
	import { Badge } from '$lib/components/ui/badge/index.js'
	import * as Table from '$lib/components/ui/table/index.js'
	import ChevronLeftIcon from '@lucide/svelte/icons/chevron-left'
	import ChevronRightIcon from '@lucide/svelte/icons/chevron-right'
	import Loader2Icon from '@lucide/svelte/icons/loader-2'
	import PlayIcon from '@lucide/svelte/icons/play'
	import Wand2Icon from '@lucide/svelte/icons/wand-2'
	import DownloadIcon from '@lucide/svelte/icons/download'

	interface Props {
		mode?: 'sheet' | 'page'
	}

	let { mode = 'page' }: Props = $props()

	interface SqlQueryResponse {
		operation: string
		headers: string[]
		rows: string[][]
		total_rows: number
		truncated: boolean
		execution_time_ms: number
		affected_rows?: number
		message?: string
	}

	interface SqlTableSchema {
		columns: { name: string; type: string; nullable: boolean; primary_key: boolean }[]
		indexes: string[]
		foreign_keys: string[]
	}

	let loading = $state(false)
	let error = $state<string | null>(null)
	let response = $state<SqlQueryResponse | null>(null)

	let query = $state('SELECT *\nFROM files\nLIMIT 50;')

	// Pagination
	const PAGE_SIZE = 20
	let currentPage = $state(1)
	const totalPages = $derived(response ? Math.ceil(response.rows.length / PAGE_SIZE) : 1)
	const paginatedRows = $derived(() => {
		if (!response) return []
		const start = (currentPage - 1) * PAGE_SIZE
		return response.rows.slice(start, start + PAGE_SIZE)
	})

	let tablesLoading = $state(false)
	let tables = $state<string[]>([])
	let selectedTable = $state<string | null>(null)
	let schemaLoading = $state(false)
	let tableSchema = $state<SqlTableSchema | null>(null)

	onMount(async () => {
		await loadTables()
		await runQuery()
	})

	async function loadTables() {
		tablesLoading = true
		try {
			const result = await invoke<{ name: string }[]>('sql_list_tables')
			tables = result.map((t) => t.name)
		} catch (e) {
			console.error('Failed to load tables', e)
		} finally {
			tablesLoading = false
		}
	}

	async function setQueryFromTable(table: string) {
		query = `SELECT *\nFROM ${table}\nLIMIT 50;`
		selectedTable = table
		loadSchema(table)
		await runQuery()
	}

	async function loadSchema(table: string) {
		schemaLoading = true
		try {
			tableSchema = await invoke<SqlTableSchema>('sql_get_table_schema', { table })
		} catch (e) {
			console.error('Failed to load table schema', e)
			tableSchema = null
		} finally {
			schemaLoading = false
		}
	}

	async function runQuery() {
		error = null
		response = null
		loading = true
		currentPage = 1
		try {
			response = await invoke<SqlQueryResponse>('sql_run_query', {
				query,
				options: undefined,
			})
			if (response.message) {
				toast.success(response.message)
			}
		} catch (e) {
			error = e instanceof Error ? e.message : String(e)
		} finally {
			loading = false
		}
	}

	function clearQuery() {
		query = ''
		response = null
		error = null
	}

	const canRun = $derived(query.trim().length > 0 && !loading)
	const canExport = $derived(
		!!response && response.operation === 'read' && response.headers.length > 0 && !loading,
	)

	function formatQuery() {
		query = formatSql(query)
	}

	async function downloadCsv() {
		if (!response || response.operation !== 'read') return

		try {
			const { save } = await import('@tauri-apps/plugin-dialog')
			const destination = await save({
				defaultPath: 'query-results.csv',
				filters: [{ name: 'CSV', extensions: ['csv'] }],
			})

			if (!destination) return

			const exportResult = await invoke<{ path: string; rows_written: number }>(
				'sql_export_query',
				{
					query,
					destination,
					options: { format: 'csv', allow_write: false, allow_ddl: false },
				},
			)

			toast.success(`Exported ${exportResult.rows_written} rows`)
		} catch (e) {
			error = e instanceof Error ? e.message : String(e)
			toast.error('Failed to export CSV')
		}
	}

	const SINGLE_KEYWORDS = [
		'add',
		'all',
		'and',
		'any',
		'as',
		'between',
		'by',
		'case',
		'cast',
		'count',
		'delete',
		'desc',
		'distinct',
		'exists',
		'explain',
		'from',
		'group',
		'having',
		'in',
		'inner',
		'insert',
		'into',
		'is',
		'join',
		'left',
		'limit',
		'like',
		'not',
		'null',
		'on',
		'or',
		'order',
		'outer',
		'right',
		'select',
		'set',
		'top',
		'union',
		'update',
		'values',
		'where',
	]

	const MULTI_KEYWORDS = [
		'group by',
		'inner join',
		'left join',
		'right join',
		'full outer join',
		'order by',
		'join on',
	]

	const NEWLINE_KEYWORDS = [
		'SELECT',
		'FROM',
		'WHERE',
		'GROUP BY',
		'HAVING',
		'ORDER BY',
		'LIMIT',
		'UNION',
		'UNION ALL',
		'EXCEPT',
		'INTERSECT',
		'INNER JOIN',
		'LEFT JOIN',
		'RIGHT JOIN',
		'FULL OUTER JOIN',
	]

	const CLAUSE_KEYWORDS = ['AND', 'OR']
	const STRING_REGEX = /'(?:''|[^'])*'|"(?:\"\"|[^"])*"/g

	function formatSql(input: string) {
		if (!input) return ''

		const hasSemicolon = /;\s*$/.test(input)
		const placeholders: string[] = []

		let text = input.trim()
		if (!text) return ''

		text = text.replace(STRING_REGEX, (match) => {
			const token = `__STR${placeholders.length}__`
			placeholders.push(match)
			return token
		})

		if (hasSemicolon) {
			text = text.replace(/;\s*$/, '')
		}

		text = text.replace(/\s+/g, ' ')

		MULTI_KEYWORDS.forEach((phrase) => {
			const pattern = new RegExp(phrase.split(' ').join('\\s+'), 'gi')
			text = text.replace(pattern, phrase.toUpperCase())
		})

		const keywordRegex = new RegExp(`\\b(${SINGLE_KEYWORDS.join('|')})\\b`, 'gi')
		text = text.replace(keywordRegex, (match) => match.toUpperCase())

		NEWLINE_KEYWORDS.forEach((keyword) => {
			const pattern = new RegExp(`\\s+${keyword}`, 'g')
			text = text.replace(pattern, `\n${keyword}`)
		})

		CLAUSE_KEYWORDS.forEach((keyword) => {
			const pattern = new RegExp(`\\s+${keyword}\\b`, 'g')
			text = text.replace(pattern, `\n  ${keyword}`)
		})

		text = text.replace(/\s*,\s*/g, ', ')
		text = text.replace(/\s*\(\s*/g, ' (')
		text = text.replace(/\s*\)\s*/g, ') ')
		text = text.replace(/\n{2,}/g, '\n')

		const formatted = text
			.split('\n')
			.map((line) => line.trim())
			.filter((line) => line.length > 0)
			.join('\n')

		let finalText = formatted
		placeholders.forEach((value, index) => {
			finalText = finalText.replace(`__STR${index}__`, value)
		})

		if (hasSemicolon) {
			finalText = `${finalText};`
		}

		return finalText
	}
</script>

<div class="flex flex-col h-full">
	<div class="flex gap-3 min-w-0 flex-1 min-h-0">
		<!-- Left: Tables list -->
		<div class="w-40 shrink-0 flex flex-col">
			<div class="rounded-md border bg-muted/20 flex-1 overflow-auto">
				{#if tablesLoading}
					<div class="flex items-center justify-center py-6 text-muted-foreground">
						<Loader2Icon class="size-4 animate-spin" />
					</div>
				{:else if tables.length === 0}
					<div class="py-6 text-center text-xs text-muted-foreground">No tables found</div>
				{:else}
					{#each tables as tableName (tableName)}
						<button
							type="button"
							class="w-full text-left px-3 py-1.5 text-sm hover:bg-muted transition-colors {selectedTable ===
							tableName
								? 'bg-muted font-medium'
								: ''}"
							onclick={() => setQueryFromTable(tableName)}
						>
							{tableName}
						</button>
					{/each}
				{/if}
			</div>
		</div>

		<!-- Middle: Query + Results -->
		<div class="flex-1 min-w-0 flex flex-col gap-2">
			<!-- Query section with Columns on the right -->
			<div class="flex gap-3">
				<div class="flex-1 min-w-0 relative h-56">
					<textarea
						placeholder="Write a SQL query..."
						bind:value={query}
						class="font-mono text-sm w-full h-full resize-none rounded-md border border-input bg-transparent px-3 py-2 pr-28 pb-12 ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
					></textarea>
					<!-- Top right: Format + Clear -->
					<div class="absolute top-2 right-2 flex items-center gap-1">
						<Button
							variant="ghost"
							size="sm"
							class="h-6 px-2 text-xs"
							onclick={formatQuery}
							disabled={loading || !query.trim()}
						>
							<Wand2Icon class="size-3" />
							Format
						</Button>
						<Button
							variant="ghost"
							size="sm"
							class="h-6 px-2 text-xs"
							onclick={clearQuery}
							disabled={loading}
						>
							Clear
						</Button>
					</div>
					<!-- Bottom right: Run -->
					<div class="absolute bottom-2 right-2">
						<Button size="sm" onclick={runQuery} disabled={!canRun}>
							{#if loading}
								<Loader2Icon class="size-3 animate-spin" />
							{:else}
								<PlayIcon class="size-3" />
							{/if}
							Run
						</Button>
					</div>
				</div>

				<!-- Right: Columns panel -->
				<div class="w-48 shrink-0 rounded-md border bg-muted/10 h-56 flex flex-col">
					<div class="flex items-center justify-between px-2 py-1.5 border-b shrink-0">
						<span class="text-xs font-medium">Columns</span>
						{#if selectedTable}
							<Badge variant="outline" class="text-[10px] px-1 py-0">{selectedTable}</Badge>
						{/if}
					</div>
					<div class="flex-1 overflow-auto">
						{#if !selectedTable}
							<div class="py-4 text-center text-xs text-muted-foreground">Select a table</div>
						{:else if schemaLoading}
							<div class="flex items-center justify-center py-4 text-muted-foreground">
								<Loader2Icon class="size-4 animate-spin" />
							</div>
						{:else if !tableSchema || tableSchema.columns.length === 0}
							<div class="py-4 text-center text-xs text-muted-foreground">No columns</div>
						{:else}
							{#each tableSchema.columns as column (column.name)}
								<div
									class="flex items-center justify-between px-2 py-1 text-xs border-b last:border-b-0"
								>
									<div class="flex items-center gap-1 min-w-0">
										<span class="font-medium truncate">{column.name}</span>
										{#if column.primary_key}
											<Badge variant="outline" class="text-[9px] px-0.5 py-0">PK</Badge>
										{/if}
									</div>
									<span class="text-muted-foreground shrink-0 text-[10px]">{column.type}</span>
								</div>
							{/each}
						{/if}
					</div>
				</div>
			</div>

			<!-- Results -->
			<div class="flex-1 flex flex-col min-h-0">
				<div class="flex items-center justify-between gap-2 mb-1.5 shrink-0">
					<div class="flex items-center gap-2">
						<span class="text-sm font-medium">Results</span>
						{#if response}
							<Badge variant="outline">{response.total_rows} rows</Badge>
							<span class="text-xs text-muted-foreground">{response.execution_time_ms}ms</span>
							{#if response.truncated}
								<Badge variant="destructive">truncated</Badge>
							{/if}
						{/if}
					</div>
					<Button variant="outline" size="sm" onclick={downloadCsv} disabled={!canExport}>
						<DownloadIcon class="size-3" />
						CSV
					</Button>
				</div>
				{#if error}
					<div class="bg-destructive/10 text-destructive text-sm rounded-lg px-4 py-3">
						{error}
					</div>
				{:else if !response}
					<div
						class="flex-1 min-h-48 rounded-md border flex items-center justify-center text-muted-foreground text-sm"
					>
						Run a query to see results.
					</div>
				{:else if response.headers.length === 0}
					<div
						class="flex-1 min-h-48 rounded-md border flex items-center justify-center text-sm text-muted-foreground"
					>
						{response.message ?? 'Query executed.'}
						{#if response.affected_rows !== undefined}
							<span>&nbsp;{response.affected_rows} rows affected.</span>
						{/if}
					</div>
				{:else}
					<div class="rounded-md border flex-1 min-h-48 overflow-hidden">
						<div class="h-full w-full overflow-auto">
							<Table.Root>
								<Table.Header class="sticky top-0 bg-background">
									<Table.Row>
										{#each response.headers as header (header)}
											<Table.Head class="text-xs whitespace-nowrap">{header}</Table.Head>
										{/each}
									</Table.Row>
								</Table.Header>
								<Table.Body>
									{#each paginatedRows() as row, rowIdx (rowIdx)}
										<Table.Row>
											{#each row as cell, idx (idx)}
												<Table.Cell class="text-xs font-mono py-1 whitespace-nowrap">{cell}</Table.Cell>
											{/each}
										</Table.Row>
									{:else}
										<Table.Row>
											<Table.Cell colspan={response.headers.length} class="h-24 text-center">
												No rows returned.
											</Table.Cell>
										</Table.Row>
									{/each}
								</Table.Body>
							</Table.Root>
						</div>
					</div>
					{#if totalPages > 1}
						<div class="flex items-center justify-between pt-1.5 shrink-0">
							<span class="text-xs text-muted-foreground">
								Page {currentPage} of {totalPages}
							</span>
							<div class="flex items-center gap-1">
								<Button
									variant="outline"
									size="icon"
									class="size-7"
									disabled={currentPage <= 1}
									onclick={() => (currentPage = currentPage - 1)}
								>
									<ChevronLeftIcon class="size-4" />
								</Button>
								<Button
									variant="outline"
									size="icon"
									class="size-7"
									disabled={currentPage >= totalPages}
									onclick={() => (currentPage = currentPage + 1)}
								>
									<ChevronRightIcon class="size-4" />
								</Button>
							</div>
						</div>
					{/if}
				{/if}
			</div>
		</div>
	</div>
</div>
