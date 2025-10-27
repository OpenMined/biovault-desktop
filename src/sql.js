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

const STRING_REGEX = /'(?:''|[^'])*'|"(?:""|[^"])*"/g

function escapeHtml(text) {
	return text
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&#39;')
}

function buildKeywordRegex(keywords) {
	return new RegExp(`\\b(${keywords.join('|')})\\b`, 'gi')
}

const KEYWORD_REGEX = buildKeywordRegex(SINGLE_KEYWORDS)

function highlightSql(text) {
	if (!text) return ''

	const placeholders = []
	let working = text.replace(STRING_REGEX, (match) => {
		const placeholder = `__STR${placeholders.length}__`
		placeholders.push(match)
		return placeholder
	})

	let escaped = escapeHtml(working)

	// Highlight multi-word keywords first
	let highlighted = MULTI_KEYWORDS.reduce((acc, phrase) => {
		const pattern = new RegExp(phrase.split(' ').join('\\s+'), 'gi')
		return acc.replace(pattern, (m) => `<span class="sql-token-keyword">${m.toUpperCase()}</span>`)
	}, escaped)

	// Single keywords
	highlighted = highlighted.replace(KEYWORD_REGEX, (match) => {
		return `<span class="sql-token-keyword">${match.toUpperCase()}</span>`
	})

	// Restore strings
	placeholders.forEach((value, index) => {
		const safeValue = escapeHtml(value)
		highlighted = highlighted.replace(
			`__STR${index}__`,
			`<span class="sql-token-string">${safeValue}</span>`,
		)
	})

	return highlighted
}

function formatSql(input) {
	if (!input) return ''

	const hasSemicolon = /;\s*$/.test(input)
	const placeholders = []

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

	// Collapse whitespace to single spaces for easier formatting
	text = text.replace(/\s+/g, ' ')

	// Multi-keywords first to preserve spacing
	MULTI_KEYWORDS.forEach((phrase) => {
		const pattern = new RegExp(phrase.split(' ').join('\\s+'), 'gi')
		text = text.replace(pattern, phrase.toUpperCase())
	})

	// Single-word keywords
	text = text.replace(KEYWORD_REGEX, (match) => match.toUpperCase())

	// Ensure newline before key clauses
	NEWLINE_KEYWORDS.forEach((keyword) => {
		const pattern = new RegExp(`\\s+${keyword}`, 'g')
		text = text.replace(pattern, `\n${keyword}`)
	})

	// Inline clause keywords for readability
	CLAUSE_KEYWORDS.forEach((keyword) => {
		const pattern = new RegExp(`\\s+${keyword}\\b`, 'g')
		text = text.replace(pattern, `\n  ${keyword}`)
	})

	// Clean up whitespace around commas
	text = text.replace(/\s*,\s*/g, ', ')

	// Normalize spacing around parentheses
	text = text.replace(/\s*\(\s*/g, ' (')
	text = text.replace(/\s*\)\s*/g, ') ')

	// Reduce repeated whitespace/newlines
	text = text.replace(/\n{2,}/g, '\n')

	// Trim each line
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

function extractSqlFromAi(content) {
	if (!content) return ''
	const trimmed = content.trim()
	const fenceMatch = trimmed.match(/```(?:sql)?\s*([\s\S]*?)```/i)
	if (fenceMatch) {
		return fenceMatch[1].trim()
	}
	return trimmed
}

function detectFormatFromPath(path) {
	if (!path) return 'csv'
	if (path.toLowerCase().endsWith('.tsv')) return 'tsv'
	return 'csv'
}

export function createSqlModule({ invoke, dialog }) {
	const state = {
		initialized: false,
		tablesLoaded: false,
		activeTable: null,
		lastQuery: '',
		lastResult: null,
		recentError: null,
		aiConfig: null,
		aiAbortController: null,
	}

	const elements = {}

	function cacheElements() {
		if (elements.editor) return true

		// SQL content is now in the workbench panel
		elements.view =
			document.getElementById('workbench-sql-panel') || document.getElementById('sql-view')
		elements.tableList = document.getElementById('sql-table-list')
		elements.tableSchema = document.getElementById('sql-table-schema')
		elements.refreshTablesBtn = document.getElementById('sql-refresh-tables-btn')
		elements.editor = document.getElementById('sql-editor-input')
		elements.highlight = document.getElementById('sql-editor-highlight')
		elements.formatBtn = document.getElementById('sql-format-btn')
		elements.runBtn = document.getElementById('sql-run-btn')
		elements.downloadBtn = document.getElementById('sql-download-btn')
		elements.status = document.getElementById('sql-status')
		elements.resultMeta = document.getElementById('sql-result-meta')
		elements.resultTable = document.getElementById('sql-result-table')
		elements.resultTableHead = document.querySelector('#sql-result-table thead')
		elements.resultTableBody = document.querySelector('#sql-result-table tbody')
		elements.resultPlaceholder = document.getElementById('sql-result-placeholder')
		elements.aiPrompt = document.getElementById('sql-ai-prompt')
		elements.aiButton = document.getElementById('sql-ai-submit-btn')
		elements.aiStatus = document.getElementById('sql-ai-status')
		elements.aiHistory = document.getElementById('sql-ai-history')

		const found = Boolean(elements.editor && elements.highlight && elements.tableList)
		console.log('🔍 SQL elements cached:', {
			found,
			tableList: !!elements.tableList,
			editor: !!elements.editor,
		})
		return found
	}

	function setStatus(message, tone = 'info') {
		if (!elements.status) return

		// Update status text (handle both old and new structure)
		const statusText = document.getElementById('sql-status-text')
		if (statusText) {
			statusText.textContent = message
		} else {
			elements.status.textContent = message
		}

		// Update visual tone
		elements.status.className = 'sql-status'
		if (tone === 'error') {
			elements.status.classList.add('error')
		} else if (tone === 'success') {
			elements.status.classList.add('success')
		}
		elements.status.dataset.tone = tone
	}

	function updateHighlight() {
		if (!elements.editor || !elements.highlight) return
		elements.highlight.innerHTML = highlightSql(elements.editor.value || '')
		elements.highlight.scrollTop = elements.editor.scrollTop
		elements.highlight.scrollLeft = elements.editor.scrollLeft
	}

	function onEditorInput() {
		state.lastQuery = elements.editor.value
		updateHighlight()
	}

	function onEditorScroll() {
		if (!elements.highlight) return
		elements.highlight.scrollTop = elements.editor.scrollTop
		elements.highlight.scrollLeft = elements.editor.scrollLeft
	}

	function setEditorValue(value, { format = false } = {}) {
		if (!elements.editor) return
		const nextValue = format ? formatSql(value) : value
		elements.editor.value = nextValue
		state.lastQuery = nextValue
		updateHighlight()
	}

	async function refreshTableList(force = false) {
		if (state.tablesLoaded && !force) return
		if (!elements.tableList) return

		elements.tableList.innerHTML = '<li class="sql-list-placeholder">Loading tables…</li>'

		try {
			const tables = await invoke('sql_list_tables')
			state.tablesLoaded = true
			renderTableList(tables)
		} catch (error) {
			console.error('Failed to load tables', error)
			elements.tableList.innerHTML = `<li class="sql-list-placeholder sql-list-placeholder--error">Failed to load tables: ${
				error?.message || error
			}</li>`
		}
	}

	function renderTableList(tables) {
		if (!elements.tableList) return
		if (!Array.isArray(tables) || tables.length === 0) {
			elements.tableList.innerHTML = '<li class="sql-list-placeholder">No tables found</li>'
			return
		}

		elements.tableList.innerHTML = ''
		tables.forEach((table) => {
			const li = document.createElement('li')
			li.className = 'sql-table-item'
			li.innerHTML = `<button type="button" class="sql-table-btn" data-table="${table.name}">${table.name}</button>`
			elements.tableList.appendChild(li)
		})

		// Update table count
		const tableCount = document.getElementById('sql-table-count')
		if (tableCount) {
			tableCount.textContent = tables.length
		}

		elements.tableList.querySelectorAll('.sql-table-btn').forEach((btn) => {
			btn.addEventListener('click', () => {
				handleTableSelected(btn.dataset.table)
			})
		})
	}

	function markActiveTable(name) {
		if (!elements.tableList) return
		elements.tableList.querySelectorAll('.sql-table-btn').forEach((btn) => {
			btn.classList.toggle('active', btn.dataset.table === name)
		})
		state.activeTable = name
	}

	async function handleTableSelected(name) {
		if (!name) return
		markActiveTable(name)
		const escaped = name.replace(/"/g, '""')
		const query = `SELECT * FROM "${escaped}" LIMIT 100`
		setEditorValue(query, { format: true })
		await loadTableSchema(name)
		await runQuery()
	}

	async function loadTableSchema(name) {
		if (!elements.tableSchema) return
		elements.tableSchema.innerHTML = '<div class="sql-schema-loading">Loading schema…</div>'
		try {
			const schema = await invoke('sql_get_table_schema', { table: name })
			displayTableSchema(schema)
		} catch (error) {
			console.error('Failed to load schema', error)
			elements.tableSchema.innerHTML = `<div class="sql-schema-error">${
				error?.message || error
			}</div>`
		}
	}

	function displayTableSchema(schema) {
		if (!elements.tableSchema) return
		if (!schema?.columns?.length) {
			elements.tableSchema.innerHTML =
				'<div class="sql-schema-empty">No schema information available.</div>'
			return
		}

		const columnsHtml = schema.columns
			.map((col) => {
				const flags = []
				if (col.primary_key) flags.push('PK')
				if (!col.nullable) flags.push('NOT NULL')
				if (col.default_value) flags.push(`DEFAULT ${col.default_value}`)
				return `
					<li>
						<div class="sql-schema-column">
							<span class="sql-schema-column-name">${col.name}</span>
							<span class="sql-schema-column-type">${col.type}</span>
						</div>
						${flags.length ? `<div class="sql-schema-flags">${flags.join(', ')}</div>` : ''}
					</li>
				`
			})
			.join('')

		const indexesHtml = schema.indexes?.length
			? `<div class="sql-schema-section"><strong>Indexes</strong><ul>${schema.indexes
					.map((idx) => `<li>${idx}</li>`)
					.join('')}</ul></div>`
			: ''

		const fkHtml = schema.foreign_keys?.length
			? `<div class="sql-schema-section"><strong>Foreign Keys</strong><ul>${schema.foreign_keys
					.map((fk) => `<li>${fk}</li>`)
					.join('')}</ul></div>`
			: ''

		elements.tableSchema.innerHTML = `
			<div class="sql-schema-section">
				<strong>Columns</strong>
				<ul>${columnsHtml}</ul>
			</div>
			${indexesHtml}
			${fkHtml}
		`
	}

	async function runQuery() {
		if (!elements.editor) return
		const query = elements.editor.value.trim()
		if (!query) {
			setStatus('Enter a SQL query to run.', 'warn')
			return
		}

		setStatus('Running query…', 'info')
		elements.runBtn?.classList.add('loading')
		elements.runBtn?.setAttribute('disabled', 'disabled')

		try {
			const response = await invoke('sql_run_query', {
				query,
				options: { maxRows: 500 },
			})
			state.lastQuery = query
			state.lastResult = response
			renderQueryResults(response)
		} catch (error) {
			console.error('Failed to run query', error)
			setStatus(error?.message || 'Failed to run query', 'error')
			renderEmptyResults()
		} finally {
			elements.runBtn?.classList.remove('loading')
			elements.runBtn?.removeAttribute('disabled')
		}
	}

	function renderEmptyResults() {
		if (!elements.resultTableHead || !elements.resultTableBody) return
		elements.resultTableHead.innerHTML = ''
		elements.resultTableBody.innerHTML = ''
		elements.resultPlaceholder?.classList.remove('hidden')
		elements.downloadBtn?.setAttribute('disabled', 'disabled')
		if (elements.resultMeta) {
			elements.resultMeta.textContent = ''
		}
	}

	function renderQueryResults(result) {
		if (!elements.resultTableHead || !elements.resultTableBody) return

		if (result.operation !== 'read') {
			renderEmptyResults()
			const message =
				result.message ||
				(result.operation === 'write'
					? `Query executed. ${result.affected_rows || 0} rows affected.`
					: 'Query executed successfully.')
			setStatus(message, 'success')
			return
		}

		elements.resultPlaceholder?.classList.add('hidden')
		const headers = result.headers || []
		const rows = Array.isArray(result.rows) ? result.rows : []

		if (!headers.length) {
			renderEmptyResults()
			setStatus('Query executed but returned no columns.', 'warn')
			return
		}

		const headHtml = `<tr>${headers.map((header) => `<th>${header}</th>`).join('')}</tr>`
		const bodyHtml = rows
			.map(
				(row) =>
					`<tr>${row.map((value) => `<td>${escapeHtml(String(value ?? ''))}</td>`).join('')}</tr>`,
			)
			.join('')

		elements.resultTableHead.innerHTML = headHtml
		elements.resultTableBody.innerHTML =
			bodyHtml || '<tr><td colspan="' + headers.length + '">No rows returned.</td></tr>'

		const summaryParts = []
		summaryParts.push(`${rows.length} row${rows.length === 1 ? '' : 's'} displayed`)
		if (result.total_rows !== rows.length) {
			summaryParts.push(`Total rows: ${result.total_rows}`)
		}
		summaryParts.push(`Time: ${result.execution_time_ms} ms`)
		if (result.truncated) {
			summaryParts.push('Results truncated to first 500 rows.')
		}
		if (elements.resultMeta) {
			elements.resultMeta.textContent = summaryParts.join(' • ')
		}

		elements.downloadBtn?.removeAttribute('disabled')
		setStatus('Query completed successfully.', 'success')
	}

	async function exportResults() {
		if (!state.lastQuery) {
			setStatus('Run a query before exporting.', 'warn')
			return
		}

		let suggestedName = 'query-results.csv'
		if (state.activeTable) {
			suggestedName = `${state.activeTable.toLowerCase()}-results.csv`
		}

		let destination = null
		if (dialog?.save) {
			try {
				destination = await dialog.save({
					defaultPath: suggestedName,
					filters: [
						{ name: 'CSV', extensions: ['csv'] },
						{ name: 'TSV', extensions: ['tsv'] },
					],
				})
			} catch (error) {
				console.error('Failed to open save dialog', error)
				setStatus('Unable to open save dialog. Enter a destination path manually.', 'warn')
			}
		}

		if (!destination) {
			destination = window.prompt('Enter a path to save the results', suggestedName)
		}

		if (!destination) {
			return
		}

		const format = detectFormatFromPath(destination)
		setStatus(`Exporting results as ${format.toUpperCase()}…`, 'info')

		try {
			const response = await invoke('sql_export_query', {
				query: state.lastQuery,
				destination,
				options: { format },
			})
			setStatus(`Exported ${response.rows_written} rows to ${response.path}`, 'success')
		} catch (error) {
			console.error('Failed to export query', error)
			setStatus(error?.message || 'Failed to export results', 'error')
		}
	}

	async function loadAiConfig() {
		try {
			const settings = await invoke('get_settings')
			state.aiConfig = {
				url: (settings.ai_api_url || '').trim(),
				token: (settings.ai_api_token || '').trim(),
				model: (settings.ai_model || '').trim() || 'openrouter/auto',
			}
		} catch (error) {
			console.error('Failed to load AI configuration', error)
			state.aiConfig = null
		}
	}

	function getAiProvider() {
		if (typeof window !== 'undefined' && window.__SQL_AI_PROVIDER__) {
			return window.__SQL_AI_PROVIDER__
		}
		return null
	}

	function setAiStatus(message, tone = 'info') {
		if (!elements.aiStatus) return
		elements.aiStatus.textContent = message
		elements.aiStatus.dataset.tone = tone
	}

	async function generateSqlFromAi() {
		if (!elements.aiPrompt) return
		const prompt = elements.aiPrompt.value.trim()
		if (!prompt) {
			setAiStatus('Enter a prompt to generate SQL.', 'warn')
			return
		}

		if (state.aiAbortController) {
			state.aiAbortController.abort()
		}

		const provider = getAiProvider()
		setAiStatus('Generating SQL…', 'info')
		elements.aiButton?.setAttribute('disabled', 'disabled')

		try {
			let generatedSql = ''
			if (provider?.generate) {
				generatedSql = await provider.generate(prompt)
			} else {
				if (!state.aiConfig) {
					await loadAiConfig()
				}
				if (!state.aiConfig?.url || !state.aiConfig?.token) {
					setAiStatus('AI configuration incomplete. Set API URL and token in Settings.', 'error')
					return
				}

				state.aiAbortController = new AbortController()
				const response = await fetch(state.aiConfig.url, {
					method: 'POST',
					headers: {
						'Content-Type': 'application/json',
						Authorization: `Bearer ${state.aiConfig.token}`,
						'HTTP-Referer': 'https://biovault.desktop/sql',
						'X-Title': 'BioVault Desktop',
					},
					body: JSON.stringify({
						model: state.aiConfig.model || 'openrouter/auto',
						messages: [
							{
								role: 'system',
								content:
									'You are a helpful assistant that writes SQLite-compatible SQL queries for the BioVault schema. Only respond with SQL unless explicitly asked otherwise.',
							},
							{
								role: 'user',
								content: prompt,
							},
						],
						temperature: 0.2,
						response_format: { type: 'text' },
					}),
					signal: state.aiAbortController.signal,
				})

				if (!response.ok) {
					const errorText = await response.text()
					throw new Error(`AI request failed: ${errorText}`)
				}

				const json = await response.json()
				const content = json?.choices?.[0]?.message?.content
				generatedSql = extractSqlFromAi(content)
			}

			if (!generatedSql) {
				setAiStatus('AI response did not include SQL.', 'warn')
				return
			}

			setEditorValue(generatedSql, { format: true })
			setAiStatus('SQL generated. Review and run when ready.', 'success')
		} catch (error) {
			if (error.name === 'AbortError') {
				setAiStatus('Cancelled previous AI request.', 'warn')
				return
			}
			console.error('Failed to generate SQL from AI', error)
			setAiStatus(error?.message || 'Failed to generate SQL', 'error')
		} finally {
			state.aiAbortController = null
			elements.aiButton?.removeAttribute('disabled')
		}
	}

	function setupEventListeners() {
		if (!elements.editor) return

		elements.editor.addEventListener('input', onEditorInput)
		elements.editor.addEventListener('scroll', onEditorScroll)
		elements.editor.addEventListener('keydown', (event) => {
			if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
				event.preventDefault()
				runQuery()
			}
		})

		elements.formatBtn?.addEventListener('click', () => {
			setEditorValue(elements.editor.value, { format: true })
			setStatus('Formatted SQL query.', 'info')
		})

		elements.runBtn?.addEventListener('click', () => runQuery())
		elements.downloadBtn?.addEventListener('click', () => exportResults())
		elements.refreshTablesBtn?.addEventListener('click', () => refreshTableList(true))

		elements.aiButton?.addEventListener('click', () => generateSqlFromAi())
		elements.aiPrompt?.addEventListener('keydown', (event) => {
			if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
				event.preventDefault()
				generateSqlFromAi()
			}
		})
	}

	async function initializeSqlTab() {
		if (state.initialized) return
		if (!cacheElements()) {
			console.warn('SQL view not ready for initialization')
			return
		}

		state.initialized = true
		setupEventListeners()
		updateHighlight()
		setStatus('Ready to run SQL queries.', 'info')
		await loadAiConfig()
	}

	async function activateSqlTab() {
		await initializeSqlTab()
		if (!state.tablesLoaded) {
			await refreshTableList()
		}
		if (elements.editor && !elements.editor.value) {
			elements.editor.focus()
		}
	}

	function invalidateAiConfig() {
		state.aiConfig = null
	}

	return {
		initializeSqlTab,
		activateSqlTab,
		invalidateAiConfig,
	}
}

export const __private__ = { highlightSql, formatSql, extractSqlFromAi }
