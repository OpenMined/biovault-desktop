/**
 * SyftBox module - Sync explorer and status management
 */

export function createSyftBoxModule({
	invoke,
	dialog,
	templateLoader: _templateLoader,
	shellApi: _shellApi,
}) {
	let _initialized = false
	let _refreshTimer = null
	let _globalStatusTimer = null // Timer for updating global status bar "Xs ago" text
	let _sseConnection = null
	let _sseReconnectTimer = null
	let _sseReconnectAttempts = 0
	const SSE_RECONNECT_DELAYS = [1000, 2000, 5000, 10000, 30000] // Exponential backoff
	let _sseFallbackMode = false // When true, use polling instead of SSE
	let _fastPollingTimer = null // Timer for fast polling when SSE unavailable
	const FAST_POLL_INTERVAL = 1000 // Poll every 1s when SSE unavailable and actively syncing
	const NORMAL_POLL_INTERVAL = 5000 // Poll every 5s when idle
	let _lastSseProbeAt = 0
	const SSE_PROBE_COOLDOWN_MS = 15000
	let _ssePreferredAuth = 'query' // 'query' | 'bearer'
	const SSE_ENABLED = false
	let _wsEventsActive = false
	let _wsEventListenerCleanup = null
	let _wsStatusListenerCleanup = null
	let _lastWsEventAt = 0
	let _treeState = {
		nodes: new Map(),
		expanded: new Set(),
		selected: null,
		loading: new Set(),
		trustedDatasites: new Set(), // Datasites the user has subscribed to
		collapsedSections: new Set(['network', 'discovery']), // Collapsed section IDs (network and discovery collapsed by default)
		currentUserEmail: null, // Current user's email for identifying "Your Files"
		discoveryFiles: [], // Files available to subscribe to (from /v1/discovery/files)
	}
	let _currentView = 'tree' // 'tree', 'log', or 'conn'
	let _activityLog = [] // Array of activity events, newest first
	let _activitySortBy = 'time' // 'time' or 'size'
	let _activitySortDesc = true // true = descending (largest/newest first), false = ascending
	const MAX_LOG_ENTRIES = 500 // Keep last 500 entries
	const ACTIVITY_LOG_STORAGE_KEY = 'syftbox_activity_log'

	// Connection log for tracking all connection events
	let _connectionLog = [] // Array of connection events
	const MAX_CONN_LOG_ENTRIES = 200
	const CONN_LOG_STORAGE_KEY = 'syftbox_connection_log'
	let _lastControlPlaneErrorLog = null // Timestamp of last error log to avoid flooding
	let _lastControlPlaneSuccessLog = null // Timestamp of last success log to avoid flooding

	function redactTokenFromUrl(url) {
		if (!url) return url
		try {
			const parsed = new URL(url)
			if (parsed.searchParams.has('token')) {
				parsed.searchParams.set('token', '[redacted]')
			}
			return parsed.toString()
		} catch (_e) {
			return url.replace(/token=[^&]+/gi, 'token=[redacted]')
		}
	}

	function createTauriSSEConnection({ url, token, includeAuthHeader, onOpen, onMessage, onError }) {
		const controller = new AbortController()
		let closed = false
		let readyState = 0 // 0=connecting, 1=open, 2=closed
		const hasTokenParam = typeof url === 'string' && url.includes('token=')

		const connection = {
			close: () => {
				if (closed) return
				closed = true
				readyState = 2
				controller.abort()
			},
			get readyState() {
				return readyState
			},
		}

		;(async () => {
			try {
				const makeRequest = async (useAuthHeader) => {
					const headers = { Accept: 'text/event-stream' }
					if (useAuthHeader && token) {
						headers.Authorization = `Bearer ${token}`
					}
					return fetch(url, {
						method: 'GET',
						headers,
						cache: 'no-store',
						signal: controller.signal,
					})
				}

				let response = await makeRequest(includeAuthHeader)
				console.log('[SyftBox] SSE fetch response', {
					url: redactTokenFromUrl(url),
					status: response.status,
					authHeaderUsed: Boolean(includeAuthHeader),
				})
				if (!response.ok && (response.status === 401 || response.status === 403) && hasTokenParam) {
					// Retry without Authorization header if token query param exists.
					response = await makeRequest(false)
					console.log('[SyftBox] SSE fetch retry (no auth header)', {
						url: redactTokenFromUrl(url),
						status: response.status,
						authHeaderUsed: false,
					})
				}

				if (!response.ok) {
					const err = new Error(`HTTP ${response.status}`)
					err.httpStatus = response.status
					onError(err)
					return
				}

				if (!response.body) {
					onError(new Error('SSE response body is missing'))
					return
				}

				readyState = 1
				onOpen()

				const reader = response.body.getReader()
				const decoder = new TextDecoder()
				let buffer = ''
				let eventData = ''

				while (!closed) {
					const { done, value } = await reader.read()
					if (done) break
					buffer += decoder.decode(value, { stream: true })
					const lines = buffer.split(/\r?\n/)
					buffer = lines.pop() || ''

					for (const line of lines) {
						if (line.startsWith('data:')) {
							eventData += line.slice(5).trimStart()
							eventData += '\n'
							continue
						}
						if (line.startsWith(':')) {
							continue
						}
						if (line === '') {
							if (eventData) {
								const data = eventData.replace(/\n$/, '')
								eventData = ''
								onMessage({ data })
							}
						}
					}
				}

				if (!closed) {
					onError(new Error('SSE stream closed'))
				}
			} catch (err) {
				if (closed) return
				onError(err)
			}
		})()

		return connection
	}

	// Load activity log from localStorage on module init
	function loadActivityLog() {
		try {
			const saved = localStorage.getItem(ACTIVITY_LOG_STORAGE_KEY)
			if (saved) {
				_activityLog = JSON.parse(saved)
				console.log(`[SyftBox] Loaded ${_activityLog.length} activity entries from storage`)
			}
		} catch (e) {
			console.warn('[SyftBox] Failed to load activity log from storage:', e)
		}
	}

	// Save activity log to localStorage
	function saveActivityLog() {
		try {
			localStorage.setItem(ACTIVITY_LOG_STORAGE_KEY, JSON.stringify(_activityLog))
		} catch (e) {
			console.warn('[SyftBox] Failed to save activity log to storage:', e)
		}
	}

	// Load connection log from localStorage
	function loadConnectionLog() {
		try {
			const saved = localStorage.getItem(CONN_LOG_STORAGE_KEY)
			if (saved) {
				_connectionLog = JSON.parse(saved)
				console.log(`[SyftBox] Loaded ${_connectionLog.length} connection log entries`)
			}
		} catch (e) {
			console.warn('[SyftBox] Failed to load connection log:', e)
		}
	}

	// Save connection log to localStorage
	function saveConnectionLog() {
		try {
			localStorage.setItem(CONN_LOG_STORAGE_KEY, JSON.stringify(_connectionLog))
		} catch (e) {
			console.warn('[SyftBox] Failed to save connection log:', e)
		}
	}

	// Add a connection log entry
	// type: 'control_plane' | 'server' | 'websocket' | 'sse'
	// status: 'connected' | 'disconnected' | 'error' | 'timeout' | 'request' | 'response'
	function addConnectionLogEntry(entry) {
		const logEntry = {
			timestamp: new Date().toISOString(),
			type: entry.type || 'unknown',
			status: entry.status || 'unknown',
			url: entry.url || '',
			port: entry.port || null,
			protocol: entry.protocol || 'https',
			httpStatus: entry.httpStatus || null,
			latencyMs: entry.latencyMs || null,
			message: entry.message || '',
			details: entry.details || null,
		}

		_connectionLog.unshift(logEntry)

		// Trim to max entries
		if (_connectionLog.length > MAX_CONN_LOG_ENTRIES) {
			_connectionLog = _connectionLog.slice(0, MAX_CONN_LOG_ENTRIES)
		}

		saveConnectionLog()

		// Re-render if connection view is active
		if (_currentView === 'conn') {
			renderConnectionLog()
		}
	}

	// Clear connection log
	function clearConnectionLog() {
		_connectionLog = []
		saveConnectionLog()
		renderConnectionLog()
	}

	// Render connection log
	function renderConnectionLog() {
		const logList = document.getElementById('connection-log-list')
		if (!logList) return

		if (_connectionLog.length === 0) {
			logList.innerHTML = '<div class="log-empty">No connection events yet</div>'
			return
		}

		let html = '<div class="conn-log-table">'

		for (const entry of _connectionLog) {
			const statusClass = getConnStatusClass(entry.status)
			const typeIcon = getConnTypeIcon(entry.type)
			const time = formatConnTime(entry.timestamp)
			const urlDisplay = entry.url ? formatConnUrl(entry.url) : '-'

			html += `
				<div class="conn-log-row ${statusClass}">
					<span class="conn-time">${time}</span>
					<span class="conn-type" title="${entry.type}">${typeIcon}</span>
					<span class="conn-status status-${statusClass}">${entry.status}</span>
					<span class="conn-url" title="${escapeHtml(entry.url || '')}">${urlDisplay}</span>
					${entry.httpStatus ? `<span class="conn-http-status">${entry.httpStatus}</span>` : ''}
					${entry.latencyMs ? `<span class="conn-latency">${entry.latencyMs}ms</span>` : ''}
					${entry.message ? `<span class="conn-message" title="${escapeHtml(entry.message)}">${escapeHtml(entry.message.substring(0, 50))}</span>` : ''}
				</div>
			`
		}

		html += '</div>'
		logList.innerHTML = html
	}

	function getConnStatusClass(status) {
		const map = {
			connected: 'success',
			connecting: 'pending',
			disconnected: 'warning',
			error: 'error',
			timeout: 'error',
			request: 'pending',
			response: 'success',
		}
		return map[status] || 'unknown'
	}

	function getConnTypeIcon(type) {
		const map = {
			control_plane: '🎛️',
			server: '🌐',
			websocket: '🔌',
			sse: '📡',
			http: '📤',
		}
		return map[type] || '•'
	}

	function formatConnTime(isoString) {
		const date = new Date(isoString)
		return (
			date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) +
			'.' +
			String(date.getMilliseconds()).padStart(3, '0')
		)
	}

	function formatConnUrl(url) {
		try {
			const parsed = new URL(url)
			return `${parsed.hostname}:${parsed.port || (parsed.protocol === 'https:' ? 443 : 80)}`
		} catch {
			return url.substring(0, 40)
		}
	}
	let _status = {
		connected: false,
		authenticated: false,
		daemonRunning: false,
		serverUrl: '',
		email: '',
		mode: 'Unknown',
		backend: 'Unknown',
		clientUrl: '',
		pid: null,
		txBytes: 0,
		rxBytes: 0,
		wsConnected: false,
		lastSuccessfulCheck: null, // timestamp of last successful status check
		checkHistory: [], // Array of { timestamp, interval } for sparkline and average
		latencyHistory: [], // Array of latency samples (ms) from existing checks - no extra traffic
	}
	const CHECK_HISTORY_MAX = 60 // Keep last 60 check intervals (about 3 mins at 3s polling)
	const LATENCY_HISTORY_MAX = 60 // Keep last 60 latency samples
	const MIN_CHECK_INTERVAL = 500 // Ignore intervals smaller than 500ms (likely anomalies)
	let _checkDisplayMode = 'avg' // 'avg' or 'last' - toggles on click
	let _queueSummary = {
		pending: 0,
		syncing: 0,
		completed: 0,
		error: 0,
	}

	// Status icons
	const STATUS_ICONS = {
		completed: '✓',
		syncing: '↻',
		uploading: '↑',
		downloading: '↓',
		pending: '⏳',
		error: '✗',
		conflicted: '⚠',
		rejected: '⛔',
		ignored: '◌',
		partial: '●',
		paused: '⏸',
	}

	// File type icons
	function getFileIcon(filename) {
		const ext = filename.split('.').pop()?.toLowerCase()
		const iconMap = {
			json: '📋',
			yaml: '📋',
			yml: '📋',
			csv: '📊',
			tsv: '📊',
			txt: '📄',
			md: '📝',
			pdf: '📕',
			png: '🖼',
			jpg: '🖼',
			jpeg: '🖼',
			gif: '🖼',
			py: '🐍',
			js: '📜',
			ts: '📜',
			rs: '🦀',
			zip: '📦',
			gz: '📦',
			tar: '📦',
		}
		return iconMap[ext] || '📄'
	}

	function formatBytes(bytes) {
		if (!bytes || bytes === 0) return '0 B'
		const k = 1024
		const sizes = ['B', 'KB', 'MB', 'GB', 'TB']
		const i = Math.floor(Math.log(bytes) / Math.log(k))
		return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i]
	}

	function formatRelativeTime(isoString) {
		if (!isoString) return '-'
		const date = new Date(isoString)
		const now = new Date()
		const diffMs = now - date
		const diffSec = Math.floor(diffMs / 1000)
		const diffMin = Math.floor(diffSec / 60)
		const diffHour = Math.floor(diffMin / 60)
		const diffDay = Math.floor(diffHour / 24)

		if (diffSec < 60) return 'just now'
		if (diffMin < 60) return `${diffMin}m ago`
		if (diffHour < 24) return `${diffHour}h ago`
		if (diffDay < 7) return `${diffDay}d ago`
		return date.toLocaleDateString()
	}

	function escapeHtml(str) {
		if (!str) return ''
		return str
			.replace(/&/g, '&amp;')
			.replace(/</g, '&lt;')
			.replace(/>/g, '&gt;')
			.replace(/"/g, '&quot;')
	}

	async function initialize() {
		if (_initialized) return
		_initialized = true

		console.log('[SyftBox] Initializing...')

		// Load persisted logs from localStorage
		loadActivityLog()
		loadConnectionLog()

		// Template is loaded by main.js, just bind event handlers
		bindEventHandlers()

		// Check if BioVault is onboarded before making sync_tree calls
		const isOnboarded = await invoke('check_is_onboarded').catch(() => false)
		if (!isOnboarded) {
			console.log('[SyftBox] Skipping initialization - BioVault not yet onboarded')
			// Still start polling so we can detect when onboarding completes
			startPolling()
			return
		}

		// Initialize default sync policy if not yet configured
		try {
			const initialized = await invoke('sync_tree_init_default_policy')
			if (initialized) {
				console.log('[SyftBox] Initialized default sync policy')
			}
		} catch (err) {
			// Only log if it's not a "not configured" error (expected during onboarding)
			if (!err?.message?.includes('not configured') && !err?.message?.includes('not initialized')) {
				console.warn('[SyftBox] Could not initialize sync policy:', err)
			}
		}

		// Load initial status, trusted contacts, shared items, then tree (in order)
		await refreshStatus()
		console.log('[SyftBox] Current user email:', _treeState.currentUserEmail)
		await startWsEvents()
		await refreshQueue() // Get initial WebSocket status for global status bar
		await refreshTrustedContacts()
		console.log('[SyftBox] Trusted datasites:', Array.from(_treeState.trustedDatasites))
		await refreshSharedWithMe()
		await refreshTree()

		// Ensure default subscription rules are set up
		await ensureDefaultSubscriptions()

		// Load discovery files (available to sync)
		await refreshDiscoveryFiles()

		// Start polling for updates
		startPolling()

		console.log('[SyftBox] Initialized')
	}

	function init() {
		return initialize()
	}

	function bindEventHandlers() {
		// Refresh button
		const refreshBtn = document.getElementById('syftbox-refresh-btn')
		if (refreshBtn) {
			refreshBtn.addEventListener('click', () => refreshAll())
		}

		// Tree refresh button
		const treeRefreshBtn = document.getElementById('tree-refresh-btn')
		if (treeRefreshBtn) {
			treeRefreshBtn.addEventListener('click', () => refreshTree())
		}

		// Diagnostics toggle
		const diagToggle = document.getElementById('diagnostics-toggle')
		if (diagToggle) {
			diagToggle.addEventListener('click', toggleDiagnostics)
		}

		// Auth button
		const authBtn = document.getElementById('syftbox-auth-btn')
		if (authBtn) {
			authBtn.addEventListener('click', handleAuthenticate)
		}

		// Settings button (navigate to settings)
		const settingsBtn = document.getElementById('syftbox-settings-btn')
		if (settingsBtn) {
			settingsBtn.addEventListener('click', () => {
				window.navigateTo?.('settings')
			})
		}

		// Start/Stop daemon buttons
		const startBtn = document.getElementById('diag-start-btn')
		const stopBtn = document.getElementById('diag-stop-btn')
		if (startBtn) {
			startBtn.addEventListener('click', handleStartDaemon)
		}
		if (stopBtn) {
			stopBtn.addEventListener('click', handleStopDaemon)
		}

		// Open folder buttons
		document.querySelectorAll('[data-action^="open-"]').forEach((btn) => {
			btn.addEventListener('click', () => handleOpenPath(btn.dataset.action))
		})

		// Copy buttons
		document.querySelectorAll('[data-action^="copy-"]').forEach((el) => {
			el.addEventListener('click', () => handleCopyPath(el.dataset.action))
		})

		// Clickable values (click to copy)
		document.querySelectorAll('.diag-value.clickable').forEach((el) => {
			el.addEventListener('click', () => {
				const text = el.textContent
				if (text && text !== '-') {
					copyToClipboard(text)
				}
			})
		})

		// Tree container click delegation
		const treeContainer = document.getElementById('sync-tree-list')
		if (treeContainer) {
			treeContainer.addEventListener('click', handleTreeClick)
			treeContainer.addEventListener('change', handleCheckboxClick)
		}

		// Shared section
		const refreshSharedBtn = document.getElementById('refresh-shared-btn')
		if (refreshSharedBtn) {
			refreshSharedBtn.addEventListener('click', refreshSharedWithMe)
		}

		const sharedList = document.getElementById('shared-list')
		if (sharedList) {
			sharedList.addEventListener('click', handleSharedClick)
		}

		// Tree filter
		const treeFilter = document.getElementById('tree-filter')
		if (treeFilter) {
			treeFilter.addEventListener('input', handleTreeFilter)
		}

		// View tabs
		const viewTabs = document.querySelectorAll('.view-tab')
		viewTabs.forEach((tab) => {
			tab.addEventListener('click', () => switchView(tab.dataset.view))
		})

		// Activity log click delegation
		const logList = document.getElementById('activity-log-list')
		if (logList) {
			logList.addEventListener('click', handleLogClick)
		}

		// Connection log clear button
		const connLogClear = document.getElementById('conn-log-clear')
		if (connLogClear) {
			connLogClear.addEventListener('click', clearConnectionLog)
		}
	}

	function switchView(view) {
		if (view === _currentView) return
		_currentView = view

		// Update tab buttons
		document.querySelectorAll('.view-tab').forEach((tab) => {
			tab.classList.toggle('active', tab.dataset.view === view)
		})

		// Update view containers
		document.getElementById('sync-tree-view')?.classList.toggle('active', view === 'tree')
		document.getElementById('sync-log-view')?.classList.toggle('active', view === 'log')
		document.getElementById('sync-conn-view')?.classList.toggle('active', view === 'conn')

		// Refresh the active view
		if (view === 'log') {
			renderActivityLog()
		} else if (view === 'conn') {
			renderConnectionLog()
		}
	}

	function handleLogClick(event) {
		const openBtn = event.target.closest('.btn-open')
		if (openBtn) {
			const path = openBtn.dataset.path
			if (path) openInFinder(path)
			return
		}

		const pauseBtn = event.target.closest('.btn-pause')
		if (pauseBtn) {
			const uploadId = pauseBtn.dataset.uploadId
			const isPaused = pauseBtn.classList.contains('paused')
			const action = isPaused ? 'resume' : 'pause'

			// Toggle visual state immediately for responsiveness
			pauseBtn.classList.toggle('paused')
			pauseBtn.textContent = pauseBtn.classList.contains('paused') ? '▶' : '⏸'

			// Call backend to pause/resume if we have an upload ID
			if (uploadId) {
				invoke('syftbox_upload_action', { uploadId, action }).catch((err) => {
					console.warn(`[SyftBox] Failed to ${action} upload:`, err)
					// Revert visual state on error
					pauseBtn.classList.toggle('paused')
					pauseBtn.textContent = pauseBtn.classList.contains('paused') ? '▶' : '⏸'
				})
			}
		}
	}

	function addActivityLogEntry(entry) {
		// Skip directories - only show files in activity log
		// Directories typically have no extension or end with /
		const path = entry.path || ''
		if (path.endsWith('/')) return
		// Check if it looks like a directory (no extension in last segment)
		const lastSegment = path.split('/').pop() || ''
		if (!lastSegment.includes('.') && entry.is_dir !== false) {
			// Might be a directory - skip unless explicitly marked as file
			// But allow paths that look like files (have extension)
			if (entry.is_dir === true) return
		}

		// Check if we already have an entry for this path - update it instead of adding duplicate
		const existingIndex = _activityLog.findIndex((e) => e.path === entry.path)
		if (existingIndex !== -1) {
			// Update existing entry
			_activityLog[existingIndex] = { ..._activityLog[existingIndex], ...entry }
			// Move to front if state changed
			if (entry.state) {
				const [updated] = _activityLog.splice(existingIndex, 1)
				_activityLog.unshift(updated)
			}
		} else {
			// Add new entry at the front
			_activityLog.unshift(entry)
		}

		// Trim to max entries
		if (_activityLog.length > MAX_LOG_ENTRIES) {
			_activityLog = _activityLog.slice(0, MAX_LOG_ENTRIES)
		}

		// Persist to localStorage
		saveActivityLog()

		// Re-render if log view is active
		if (_currentView === 'log') {
			renderActivityLog()
		}
	}

	function renderActivityLog() {
		const logList = document.getElementById('activity-log-list')
		if (!logList) return

		const filterInput = document.getElementById('tree-filter')
		const filterQuery = filterInput?.value?.toLowerCase().trim() || ''

		// Filter entries
		let filtered = filterQuery
			? _activityLog.filter((e) => e.path.toLowerCase().includes(filterQuery))
			: [..._activityLog]

		// Sort entries
		if (_activitySortBy === 'size') {
			filtered.sort((a, b) => {
				const diff = (b.size || 0) - (a.size || 0)
				return _activitySortDesc ? diff : -diff
			})
		} else {
			// 'time' - sort by timestamp
			filtered.sort((a, b) => {
				const timeA = a.timestamp ? new Date(a.timestamp).getTime() : 0
				const timeB = b.timestamp ? new Date(b.timestamp).getTime() : 0
				const diff = timeB - timeA
				return _activitySortDesc ? diff : -diff
			})
		}

		if (filtered.length === 0) {
			logList.innerHTML = '<div class="log-empty">No recent activity</div>'
			return
		}

		// Table-like layout with header
		const sizeArrow = _activitySortBy === 'size' ? (_activitySortDesc ? '▼' : '▲') : ''
		const timeArrow = _activitySortBy === 'time' ? (_activitySortDesc ? '▼' : '▲') : ''
		let html = `
			<div class="log-table">
				<div class="log-header">
					<span class="log-col-status">Status</span>
					<span class="log-col-path">Path</span>
					<span class="log-col-size clickable" data-sort="size">Size ${sizeArrow}</span>
					<span class="log-col-time clickable" data-sort="time">Time ${timeArrow}</span>
					<span class="log-col-actions">Actions</span>
				</div>
		`

		for (const entry of filtered) {
			html += renderLogItem(entry)
		}
		html += '</div>'
		logList.innerHTML = html

		// Bind header clicks for sorting
		logList.querySelectorAll('.log-header .clickable').forEach((col) => {
			col.addEventListener('click', () => {
				const newSort = col.dataset.sort
				if (_activitySortBy === newSort) {
					// Same column - toggle direction
					_activitySortDesc = !_activitySortDesc
				} else {
					// Different column - start descending
					_activitySortBy = newSort
					_activitySortDesc = true
				}
				renderActivityLog()
			})
		})
	}

	function formatSizeMB(bytes) {
		if (!bytes || bytes === 0) return '-'
		const mb = bytes / (1024 * 1024)
		if (mb < 0.01) return '<0.01 MB'
		if (mb < 1) return mb.toFixed(2) + ' MB'
		if (mb < 100) return mb.toFixed(1) + ' MB'
		return Math.round(mb) + ' MB'
	}

	function renderLogItem(entry) {
		// Support both 'state' and 'status' field names
		const state = entry.state || entry.status || 'unknown'
		const statusIcon = STATUS_ICONS[state] || '•'
		const statusClass = state
		const time = entry.timestamp ? formatLogTime(entry.timestamp) : '-'
		const sizeStr = formatSizeMB(entry.size)
		const showProgress =
			(state === 'syncing' || state === 'uploading') &&
			entry.progress !== undefined &&
			entry.progress > 0
		const directionClass = entry.direction === 'upload' ? 'upload' : 'download'

		const isActive =
			state === 'syncing' || state === 'uploading' || state === 'downloading' || state === 'pending'
		const isPaused = state === 'paused'
		const progressPct = Math.min(100, Math.max(0, entry.progress || 0))

		return `
			<div class="log-row ${statusClass}">
				<span class="log-col-status">
					<span class="status-icon status-${statusClass}">${statusIcon}</span>
				</span>
				<span class="log-col-path" title="${escapeHtml(entry.path)}">${escapeHtml(entry.path)}</span>
				<span class="log-col-size">${sizeStr}</span>
				<span class="log-col-time">${time}</span>
				<span class="log-col-actions">
					${isActive || isPaused ? `<button class="btn-pause ${isPaused ? 'paused' : ''}" data-path="${escapeHtml(entry.path)}" data-upload-id="${entry.uploadId || ''}">${isPaused ? '▶' : '⏸'}</button>` : ''}
					<button class="btn-open" data-path="${escapeHtml(entry.path)}">Open</button>
				</span>
				${
					showProgress
						? `<div class="log-row-progress"><div class="log-progress-bar ${directionClass}" style="width: ${progressPct}%"></div></div>`
						: ''
				}
				${showProgress ? `<span class="log-progress-text">${progressPct.toFixed(0)}%</span>` : ''}
				${entry.error ? `<div class="log-row-error">⚠ ${escapeHtml(entry.error)}</div>` : ''}
			</div>
		`
	}

	function formatLogTime(isoString) {
		const date = new Date(isoString)
		const now = new Date()
		const diffMs = now - date

		// Sub-second precision for very recent
		if (diffMs < 1000) return `${diffMs}ms ago`
		if (diffMs < 10000) return `${(diffMs / 1000).toFixed(1)}s ago`
		if (diffMs < 60000) return `${Math.floor(diffMs / 1000)}s ago`
		if (diffMs < 3600000) return `${Math.floor(diffMs / 60000)}m ago`

		// Today: show time
		if (date.toDateString() === now.toDateString()) {
			return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
		}

		// Yesterday or older: show date and time
		return (
			date.toLocaleDateString([], { month: 'short', day: 'numeric' }) +
			' ' +
			date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
		)
	}

	async function refreshStatus() {
		try {
			const [configInfo, syftboxState] = await Promise.all([
				invoke('get_syftbox_config_info').catch(() => ({})),
				invoke('get_syftbox_state').catch(() => ({ running: false })),
			])

			const wasDaemonRunning = _status.daemonRunning
			const oldClientUrl = _status.clientUrl

			_status.authenticated = configInfo.is_authenticated || false
			_status.daemonRunning = syftboxState.running || false
			_status.mode = syftboxState.mode || 'Unknown'
			_status.backend = syftboxState.backend || 'Unknown'
			_status.serverUrl = configInfo.server_url || ''
			_status.email = configInfo.email || ''
			_status.clientUrl = syftboxState.client_url || ''
			_status.clientToken = syftboxState.client_token || ''
			_status.pid = syftboxState.pid || null
			_status.txBytes = syftboxState.tx_bytes || 0
			_status.rxBytes = syftboxState.rx_bytes || 0

			// Mark successful check if daemon is running
			if (_status.daemonRunning) {
				_status.lastSuccessfulCheck = Date.now()
			}

			// Try to extract email from config path if not set directly
			// Config path format: .../sandbox/client2@sandbox.local/.syftbox/config.json
			if (!_status.email && configInfo.config_path) {
				const pathMatch = configInfo.config_path.match(/\/([^/]+@[^/]+)\/.syftbox/)
				if (pathMatch) {
					_status.email = pathMatch[1]
					console.log('[SyftBox] Extracted email from config path:', _status.email)
				}
			}

			// Store current user email for tree organization
			_treeState.currentUserEmail = _status.email

			// Determine connection status
			_status.connected = _status.daemonRunning && _status.authenticated

			updateStatusBar()
			updateDiagnostics(configInfo, syftboxState)
			updateGlobalStatusBar()

			// Connect/reconnect SSE if daemon just started or URL changed
			if (_status.daemonRunning && _status.clientUrl) {
				if (!wasDaemonRunning || oldClientUrl !== _status.clientUrl || !_sseConnection) {
					connectSSE()
				}
			} else if (!_status.daemonRunning && _sseConnection) {
				disconnectSSE()
				clearLatencyHistory()
			}
		} catch (err) {
			console.error('[SyftBox] Failed to refresh status:', err)
		}
	}

	async function refreshQueue() {
		try {
			// Save previous check time BEFORE making any updates
			const previousCheckTime = _status.lastSuccessfulCheck
			const now = Date.now()
			const requestStart = Date.now()

			const queueStatus = await invoke('syftbox_queue_status').catch((e) => {
				console.warn('[SyftBox] syftbox_queue_status failed:', e)

				// Log control plane error (only occasionally to avoid flooding)
				if (!_lastControlPlaneErrorLog || Date.now() - _lastControlPlaneErrorLog > 30000) {
					_lastControlPlaneErrorLog = Date.now()
					addConnectionLogEntry({
						type: 'control_plane',
						status: 'error',
						url: _status.clientUrl || 'localhost',
						message: 'Control plane request failed',
						details: e?.message || String(e),
					})
				}

				return null
			})

			if (queueStatus?.sync?.summary) {
				_queueSummary = queueStatus.sync.summary
			}

			// Get WebSocket connected status from backend (SyftBox client -> SyftBox server)
			const runtime = queueStatus?.status?.runtime
			const ws = runtime?.websocket

			if (ws) {
				// Handle both boolean and string values for connected
				const rawConnected = ws.connected
				_status.wsConnected = rawConnected === true || rawConnected === 'true'
				_status.wsBytesRecv = ws.bytes_recv_total || ws.bytesRecvTotal || 0
				_status.wsBytesSent = ws.bytes_sent_total || ws.bytesSentTotal || 0
			} else if (queueStatus?.status) {
				// Got status but no websocket info - treat as connected if we got any response
				// If we can reach the control plane, the daemon is running and likely connected
				_status.wsConnected = true
			}

			// If we got a successful response from the control plane, we're at least running
			if (queueStatus && !queueStatus.error) {
				const latencyMs = Date.now() - requestStart

				// Record latency sample from this check (no extra traffic - uses existing poll)
				_status.latencyHistory.push(latencyMs)
				if (_status.latencyHistory.length > LATENCY_HISTORY_MAX) {
					_status.latencyHistory.shift()
				}
				updateServerLatencyDisplay()

				// Record interval since last check for sparkline (using saved previous time)
				if (previousCheckTime) {
					const interval = now - previousCheckTime
					// Only record intervals above minimum threshold to filter out anomalies
					if (interval >= MIN_CHECK_INTERVAL) {
						_status.checkHistory.push({ timestamp: now, interval })
						// Trim to max size
						if (_status.checkHistory.length > CHECK_HISTORY_MAX) {
							_status.checkHistory.shift()
						}
					}
				}
				// Update lastSuccessfulCheck AFTER recording the interval
				_status.lastSuccessfulCheck = now
				// If no explicit WS status but control plane responds, assume connected
				if (_status.wsConnected === undefined || _status.wsConnected === false) {
					// Check if we have any indication the client is working
					if (
						queueStatus.status?.status === 'ok' ||
						queueStatus.status?.datasite?.status === 'ok'
					) {
						_status.wsConnected = true
					}
				}

				// Log control plane success periodically (every 60 seconds) to show it's working
				if (!_lastControlPlaneSuccessLog || Date.now() - _lastControlPlaneSuccessLog > 60000) {
					_lastControlPlaneSuccessLog = Date.now()
					const serverUrl = queueStatus?.status?.datasite?.server_url || _status.serverUrl
					addConnectionLogEntry({
						type: 'control_plane',
						status: 'response',
						url: _status.clientUrl || 'localhost',
						latencyMs,
						httpStatus: 200,
						message: 'Control plane responding',
						details: serverUrl ? `Server: ${serverUrl}` : null,
					})
				}
			}

			updateActivitySummary()
			updateGlobalStatusBar()
		} catch (err) {
			console.error('[SyftBox] Failed to refresh queue:', err)
		}
	}

	function connectSSE() {
		if (!SSE_ENABLED) {
			enableSSEFallbackMode()
			return
		}
		if (_sseConnection) {
			_sseConnection.close()
			_sseConnection = null
		}

		if (!_status.clientUrl || !_status.daemonRunning) {
			console.log('[SyftBox] SSE not connecting - no client URL or daemon not running', {
				clientUrl: _status.clientUrl || null,
				daemonRunning: _status.daemonRunning,
			})
			return
		}

		// If WS events are active, skip SSE to avoid duplicate streams
		if (_wsEventsActive) {
			return
		}

		// If already in fallback mode, don't try SSE again
		if (_sseFallbackMode) {
			return
		}

		console.log('[SyftBox] SSE diagnostics', {
			clientUrl: _status.clientUrl,
			daemonRunning: _status.daemonRunning,
			hasToken: Boolean(_status.clientToken),
			tokenLength: _status.clientToken?.length || 0,
			reconnectAttempts: _sseReconnectAttempts,
			fallbackMode: _sseFallbackMode,
			preferredAuth: _ssePreferredAuth,
		})

		const sseUrl = _status.clientToken
			? `${_status.clientUrl}/v1/sync/events?token=${encodeURIComponent(_status.clientToken)}`
			: `${_status.clientUrl}/v1/sync/events`
		const safeSseUrl = redactTokenFromUrl(sseUrl)

		// In browser mode (not Tauri), SSE connections to different ports always fail due to CORS
		// The control plane runs on a different port than the dev server, so always use polling
		const isBrowserMode = typeof window !== 'undefined' && !window.__TAURI__
		if (isBrowserMode) {
			try {
				const sseOrigin = new URL(sseUrl).origin
				const currentOrigin = window.location.origin
				// Normalize localhost/127.0.0.1/[::1] for comparison
				const normalizeHost = (origin) => {
					return origin
						.replace('://localhost:', '://127.0.0.1:')
						.replace('://[::1]:', '://127.0.0.1:')
				}
				const normalizedSse = normalizeHost(sseOrigin)
				const normalizedCurrent = normalizeHost(currentOrigin)
				if (normalizedSse !== normalizedCurrent) {
					console.log(
						`[SyftBox] SSE skipped in browser mode (CORS: ${normalizedSse} !== ${normalizedCurrent}), using polling fallback`,
					)
					enableSSEFallbackMode()
					return
				}
			} catch (_e) {
				// Ignore URL parsing errors, try SSE anyway
			}
		}

		console.log('[SyftBox] Connecting to SSE:', safeSseUrl)

		// Log connection attempt
		addConnectionLogEntry({
			type: 'sse',
			status: 'connecting',
			url: safeSseUrl,
			protocol: sseUrl.startsWith('https') ? 'https' : 'http',
			message: 'Initiating SSE connection',
		})

		try {
			const connectStart = Date.now()
			const isTauri = typeof window !== 'undefined' && window.__TAURI__
			const useFetchSSE = isTauri && _status.clientToken

			const onOpen = () => {
				console.log('[SyftBox] SSE connected')
				_sseReconnectAttempts = 0
				_status.wsConnected = true
				_status.lastSuccessfulCheck = Date.now()
				updateConnectionIndicator(true)
				updateGlobalStatusBar()

				// Log successful connection
				addConnectionLogEntry({
					type: 'sse',
					status: 'connected',
					url: safeSseUrl,
					protocol: sseUrl.startsWith('https') ? 'https' : 'http',
					latencyMs: Date.now() - connectStart,
					message: 'SSE connection established',
				})
			}

			const onMessage = (event) => {
				try {
					const data = JSON.parse(event.data)
					handleSyncEvent(data)
				} catch (err) {
					console.warn('[SyftBox] Failed to parse SSE event:', err)
				}
			}

			const onError = (err) => {
				const readyState = _sseConnection?.readyState
				console.warn('[SyftBox] SSE error:', err)
				console.warn('[SyftBox] SSE error details:', {
					url: safeSseUrl,
					readyState,
					reconnectAttempts: _sseReconnectAttempts,
					hasToken: Boolean(_status.clientToken),
					tokenLength: _status.clientToken?.length || 0,
					preferredAuth: _ssePreferredAuth,
					usingFetchSSE: useFetchSSE,
				})

				// Log SSE error
				addConnectionLogEntry({
					type: 'sse',
					status: 'error',
					url: safeSseUrl,
					protocol: sseUrl.startsWith('https') ? 'https' : 'http',
					httpStatus: err?.httpStatus || null,
					message: 'SSE connection error',
					details:
						err?.message || `Connection failed or lost (readyState=${readyState ?? 'unknown'})`,
				})

				_sseConnection?.close()
				_sseConnection = null
				_status.wsConnected = false
				updateConnectionIndicator(false)
				updateGlobalStatusBar()

				maybeProbeSSE()

				// After 2 failed attempts, switch to polling fallback mode
				// (CORS errors in browser mode will fail immediately)
				if (_sseReconnectAttempts >= 2) {
					enableSSEFallbackMode()
				} else {
					scheduleSSEReconnect()
				}
			}

			if (useFetchSSE) {
				const includeAuthHeader = _ssePreferredAuth === 'bearer'
				console.log('[SyftBox] Using fetch-based SSE', {
					authMode: _ssePreferredAuth,
					includeAuthHeader,
				})
				_sseConnection = createTauriSSEConnection({
					url: sseUrl,
					token: _status.clientToken,
					includeAuthHeader,
					onOpen,
					onMessage,
					onError,
				})
			} else {
				if (isTauri && _ssePreferredAuth === 'query') {
					console.log('[SyftBox] Using EventSource SSE with token query param')
				}
				_sseConnection = new EventSource(sseUrl)
				_sseConnection.onopen = onOpen
				_sseConnection.onmessage = onMessage
				_sseConnection.onerror = onError
			}
		} catch (err) {
			console.error('[SyftBox] Failed to create SSE connection:', err)

			// Log connection failure
			addConnectionLogEntry({
				type: 'sse',
				status: 'error',
				url: sseUrl,
				message: 'Failed to create SSE connection',
				details: err?.message || String(err),
			})

			// Immediately switch to fallback if we can't even create the connection
			enableSSEFallbackMode()
		}
	}

	function enableSSEFallbackMode() {
		if (_sseFallbackMode) return

		_sseFallbackMode = true
		console.log('[SyftBox] SSE unavailable, switching to polling fallback mode')

		addConnectionLogEntry({
			type: 'control_plane',
			status: 'response',
			message: 'Using polling mode (SSE unavailable)',
			details: 'Will poll for sync status updates',
		})

		// Start fast polling for activity updates
		startFastPolling()
	}

	function startFastPolling() {
		if (_fastPollingTimer) {
			clearInterval(_fastPollingTimer)
		}

		// Poll immediately, then on interval
		pollSyncStatus()

		_fastPollingTimer = setInterval(() => {
			pollSyncStatus()
		}, FAST_POLL_INTERVAL)
	}

	async function startWsEvents() {
		const isTauri = typeof window !== 'undefined' && window.__TAURI__
		if (!isTauri || _wsEventListenerCleanup) return

		try {
			await invoke('syftbox_ws_start')
		} catch (err) {
			console.warn('[SyftBox] Failed to start WS events:', err)
			return
		}

		const { event } = window.__TAURI__
		_wsEventListenerCleanup = await event.listen('syftbox_ws_event', () => {
			const now = Date.now()
			if (now - _lastWsEventAt < 250) return
			_lastWsEventAt = now
			refreshQueue()
		})

		_wsStatusListenerCleanup = await event.listen('syftbox_ws_status', (e) => {
			const payload = e?.payload || {}
			if (payload.status === 'connected') {
				_wsEventsActive = true
				disconnectSSE()
			} else if (payload.status === 'disconnected') {
				_wsEventsActive = false
			}
			addConnectionLogEntry({
				type: 'websocket',
				status: payload.status || 'unknown',
				url: payload.url || '',
				protocol: payload.url?.startsWith('wss') ? 'wss' : 'ws',
				message: payload.message || 'WS event stream',
				details: payload.details || null,
			})
		})
	}

	async function stopWsEvents() {
		const isTauri = typeof window !== 'undefined' && window.__TAURI__
		if (!isTauri) return

		try {
			await invoke('syftbox_ws_stop')
		} catch (err) {
			console.warn('[SyftBox] Failed to stop WS events:', err)
		}

		if (_wsEventListenerCleanup) {
			_wsEventListenerCleanup()
			_wsEventListenerCleanup = null
		}
		if (_wsStatusListenerCleanup) {
			_wsStatusListenerCleanup()
			_wsStatusListenerCleanup = null
		}
		_wsEventsActive = false
	}

	async function maybeProbeSSE() {
		const now = Date.now()
		if (now - _lastSseProbeAt < SSE_PROBE_COOLDOWN_MS) return
		_lastSseProbeAt = now

		const isTauri = typeof window !== 'undefined' && window.__TAURI__
		if (!isTauri || !_status.clientToken) return

		try {
			const result = await invoke('syftbox_probe_sse', { timeoutMs: 3000 })
			if (result?.auth_mode) {
				_ssePreferredAuth = result.auth_mode
			}
			const truncatedEvent =
				typeof result?.first_event === 'string' ? result.first_event.slice(0, 200) : null
			console.log('[SyftBox] SSE probe result:', result)
			addConnectionLogEntry({
				type: 'sse',
				status: result?.error ? 'error' : 'connected',
				url: redactTokenFromUrl(result?.url || ''),
				protocol: result?.url?.startsWith('https') ? 'https' : 'http',
				httpStatus: result?.http_status ?? null,
				message: result?.error ? 'SSE probe failed' : 'SSE probe success',
				details: JSON.stringify({
					authMode: result?.auth_mode || null,
					contentType: result?.content_type || null,
					bytesRead: result?.bytes_read ?? null,
					firstEvent: truncatedEvent,
					error: result?.error || null,
				}),
			})
			if (_sseFallbackMode && !result?.error && _status.daemonRunning) {
				_sseFallbackMode = false
				_sseReconnectAttempts = 0
				setTimeout(() => connectSSE(), 250)
			}
		} catch (err) {
			console.warn('[SyftBox] SSE probe error:', err)
		}
	}

	function stopFastPolling() {
		if (_fastPollingTimer) {
			clearInterval(_fastPollingTimer)
			_fastPollingTimer = null
		}
	}

	async function pollSyncStatus() {
		try {
			const queueStatus = await invoke('syftbox_queue_status').catch(() => null)
			if (!queueStatus) return

			// Update activity log from sync files
			if (queueStatus.sync?.files) {
				updateActivityFromSyncFiles(queueStatus.sync.files)
			}

			// Update from uploads
			if (queueStatus.uploads) {
				updateActivityFromUploads(queueStatus.uploads)
			}

			// Check if there's active syncing - if not, slow down polling
			const hasActiveSyncing =
				queueStatus.sync?.files?.some((f) => f.state === 'syncing' || f.state === 'pending') ||
				queueStatus.uploads?.some((u) => u.state === 'uploading' || u.state === 'pending')

			// Adjust polling speed based on activity
			if (_fastPollingTimer && !hasActiveSyncing) {
				// Slow down if nothing is syncing
				clearInterval(_fastPollingTimer)
				_fastPollingTimer = setInterval(() => pollSyncStatus(), NORMAL_POLL_INTERVAL)
			} else if (_fastPollingTimer && hasActiveSyncing) {
				// Speed up if things are syncing
				clearInterval(_fastPollingTimer)
				_fastPollingTimer = setInterval(() => pollSyncStatus(), FAST_POLL_INTERVAL)
			}
		} catch (err) {
			console.warn('[SyftBox] Poll sync status error:', err)
		}
	}

	function updateActivityFromSyncFiles(files) {
		if (!files || !Array.isArray(files)) return

		let updated = false
		for (const file of files) {
			const existing = _activityLog.find((a) => a.path === file.path)
			if (existing) {
				// Update existing entry
				if (
					existing.status !== file.state ||
					existing.progress !== file.progress ||
					existing.error !== file.error
				) {
					existing.status = file.state
					existing.progress = file.progress || 0
					existing.error = file.error || null
					existing.timestamp = file.updated_at || new Date().toISOString()
					updated = true
				}
			} else {
				// Add new entry
				_activityLog.unshift({
					id: `sync-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
					path: file.path,
					status: file.state,
					progress: file.progress || 0,
					error: file.error || null,
					timestamp: file.updated_at || new Date().toISOString(),
					direction: file.state === 'uploading' ? 'upload' : 'download',
					size: null,
				})
				updated = true
			}
		}

		if (updated) {
			// Trim to max size
			if (_activityLog.length > MAX_LOG_ENTRIES) {
				_activityLog = _activityLog.slice(0, MAX_LOG_ENTRIES)
			}
			saveActivityLog()
			if (_currentView === 'log') {
				renderActivityLog()
			}
			updateActivitySummary()
		}
	}

	function updateActivityFromUploads(uploads) {
		if (!uploads || !Array.isArray(uploads)) return

		let updated = false
		for (const upload of uploads) {
			const path = upload.local_path || upload.key
			const existing = _activityLog.find((a) => a.path === path || a.uploadId === upload.id)
			if (existing) {
				// Update existing entry
				const newStatus = mapUploadState(upload.state)
				if (
					existing.status !== newStatus ||
					existing.progress !== upload.progress ||
					existing.error !== upload.error
				) {
					existing.status = newStatus
					existing.progress = upload.progress || 0
					existing.error = upload.error || null
					existing.timestamp = upload.updated_at || new Date().toISOString()
					existing.uploadId = upload.id
					updated = true
				}
			} else if (upload.state !== 'completed') {
				// Add new entry for non-completed uploads
				_activityLog.unshift({
					id: `upload-${upload.id}`,
					uploadId: upload.id,
					path: path,
					status: mapUploadState(upload.state),
					progress: upload.progress || 0,
					error: upload.error || null,
					timestamp: upload.updated_at || new Date().toISOString(),
					direction: 'upload',
					size: upload.size || null,
				})
				updated = true
			}
		}

		if (updated) {
			if (_activityLog.length > MAX_LOG_ENTRIES) {
				_activityLog = _activityLog.slice(0, MAX_LOG_ENTRIES)
			}
			saveActivityLog()
			if (_currentView === 'log') {
				renderActivityLog()
			}
			updateActivitySummary()
		}
	}

	function mapUploadState(state) {
		const map = {
			uploading: 'syncing',
			pending: 'pending',
			completed: 'completed',
			failed: 'error',
			paused: 'pending',
		}
		return map[state] || state
	}

	function scheduleSSEReconnect() {
		if (_sseReconnectTimer) {
			clearTimeout(_sseReconnectTimer)
		}

		const delay =
			SSE_RECONNECT_DELAYS[Math.min(_sseReconnectAttempts, SSE_RECONNECT_DELAYS.length - 1)]
		_sseReconnectAttempts++

		console.log(`[SyftBox] SSE reconnecting in ${delay}ms (attempt ${_sseReconnectAttempts})`)

		_sseReconnectTimer = setTimeout(() => {
			if (_status.daemonRunning && _status.clientUrl) {
				connectSSE()
			}
		}, delay)
	}

	function disconnectSSE() {
		if (_sseReconnectTimer) {
			clearTimeout(_sseReconnectTimer)
			_sseReconnectTimer = null
		}
		if (_sseConnection) {
			// Log disconnection
			addConnectionLogEntry({
				type: 'sse',
				status: 'disconnected',
				url: _status.clientUrl ? `${_status.clientUrl}/v1/sync/events` : '',
				message: 'SSE connection closed',
			})

			_sseConnection.close()
			_sseConnection = null
		}
		_sseReconnectAttempts = 0
		_status.wsConnected = false
		updateGlobalStatusBar()
	}

	function updateConnectionIndicator(connected) {
		const statusEl = document.getElementById('syftbox-connection-status')
		if (statusEl) {
			if (connected) {
				statusEl.classList.add('connected')
				statusEl.classList.remove('syncing', 'disconnected')
			}
		}
	}

	function handleSyncEvent(event) {
		const { path, state, progress } = event

		// Update last successful check timestamp (we received a server event)
		_status.lastSuccessfulCheck = Date.now()
		updateGlobalStatusBar()

		// Update queue summary from event if available
		if (event.summary) {
			_queueSummary = event.summary
			updateActivitySummary()
		}

		if (!path) return

		// Convert path to relative path (remove datasites prefix if present)
		const relativePath = path.replace(/^.*?datasites\//, '')

		// Add to activity log (files only)
		console.log('[SyftBox] SSE event for activity log:', { relativePath, state, progress })
		addActivityLogEntry({
			path: relativePath,
			state: state || 'unknown',
			progress: progress,
			direction: event.direction || (state === 'syncing' ? 'download' : null),
			size: event.size,
			is_dir: event.is_dir,
			error: event.error,
			timestamp: new Date().toISOString(),
		})

		// Find and update the node
		const node = _treeState.nodes.get(relativePath)
		if (node) {
			if (state) node.sync_state = state
			if (progress !== undefined) node.progress = progress
			if (event.conflict_state) node.conflict_state = event.conflict_state

			// Re-render the specific node
			rerenderNode(relativePath)

			// Update details pane if this node is selected
			if (_treeState.selected === relativePath) {
				showDetails(relativePath)
			}
		}

		// Update parent folder states
		updateParentStates(relativePath)
	}

	function rerenderNode(path) {
		const nodeEl = document.querySelector(`.tree-node[data-path="${CSS.escape(path)}"]`)
		if (!nodeEl) return

		const node = _treeState.nodes.get(path)
		if (!node) return

		// Update status icon
		const statusEl = nodeEl.querySelector('.tree-status')
		if (statusEl) {
			const statusIcon = node.is_ignored
				? STATUS_ICONS.ignored
				: STATUS_ICONS[node.sync_state] || STATUS_ICONS.completed
			const statusClass = node.is_ignored ? 'ignored' : node.sync_state
			statusEl.textContent = statusIcon
			statusEl.className = `tree-status status-${statusClass}`

			// Add syncing animation
			if (node.sync_state === 'syncing') {
				statusEl.classList.add('animate-spin')
			} else {
				statusEl.classList.remove('animate-spin')
			}
		}

		// Update checkbox
		const checkbox = nodeEl.querySelector('.sync-checkbox')
		if (checkbox) {
			checkbox.checked = !node.is_ignored
		}

		// Update tracking styling
		const isTracked = !node.is_ignored
		const isPartial = node.has_mixed_ignore
		nodeEl.classList.toggle('tracked', isTracked)
		nodeEl.classList.toggle('partial', isPartial)
	}

	function updateParentStates(path) {
		// Walk up the path and update parent folder states
		const parts = path.split('/')
		for (let i = parts.length - 1; i > 0; i--) {
			const parentPath = parts.slice(0, i).join('/')
			const parentNode = _treeState.nodes.get(parentPath)
			if (parentNode && parentNode.is_dir) {
				// Check children states
				const children = Array.from(_treeState.nodes.values()).filter(
					(n) =>
						n.path.startsWith(parentPath + '/') &&
						!n.path.substring(parentPath.length + 1).includes('/'),
				)

				const states = new Set(children.map((c) => c.sync_state))
				const hasIgnored = children.some((c) => c.is_ignored)
				const hasNotIgnored = children.some((c) => !c.is_ignored)

				parentNode.has_mixed_state = states.size > 1
				parentNode.has_mixed_ignore = hasIgnored && hasNotIgnored

				// Determine aggregate state
				if (children.some((c) => c.sync_state === 'error')) {
					parentNode.sync_state = 'error'
				} else if (children.some((c) => c.sync_state === 'syncing')) {
					parentNode.sync_state = 'syncing'
				} else if (children.some((c) => c.sync_state === 'pending')) {
					parentNode.sync_state = 'pending'
				} else {
					parentNode.sync_state = 'completed'
				}

				rerenderNode(parentPath)
			}
		}
	}

	async function refreshDiscoveryFiles() {
		try {
			const files = await invoke('syftbox_discovery_files')
			_treeState.discoveryFiles = files || []
			console.log('[SyftBox] Discovery found', _treeState.discoveryFiles.length, 'available files')
			renderTreeFromNodes()
		} catch (err) {
			console.warn('[SyftBox] Failed to refresh discovery files:', err)
			_treeState.discoveryFiles = []
		}
	}

	async function ensureDefaultSubscriptions() {
		try {
			const added = await invoke('syftbox_ensure_default_subscriptions')
			if (added) {
				console.log('[SyftBox] Default subscriptions initialized')
			}
		} catch (err) {
			console.warn('[SyftBox] Failed to ensure default subscriptions:', err)
		}
	}

	async function subscribeToPath(path, isFolder = false) {
		try {
			await invoke('syftbox_subscribe', { path, isFolder })
			console.log('[SyftBox] Subscribed to:', path)
			// Refresh discovery files to remove the subscribed item
			await refreshDiscoveryFiles()
			// Trigger a sync to start downloading
			await invoke('trigger_syftbox_sync').catch(() => {})
		} catch (err) {
			console.error('[SyftBox] Failed to subscribe:', err)
			throw err
		}
	}

	async function handleDiscoverySubscribe(event) {
		event.stopPropagation()
		const btn = event.currentTarget
		const path = btn.dataset.path
		const isFolder = btn.classList.contains('btn-subscribe-folder')

		btn.disabled = true
		btn.textContent = '...'

		try {
			await subscribeToPath(path, isFolder)
		} catch (err) {
			console.error('[SyftBox] Subscribe failed:', err)
			alert(`Failed to subscribe: ${err.message || err}`)
		} finally {
			btn.disabled = false
			btn.textContent = isFolder ? 'Subscribe' : '+'
		}
	}

	async function handleDiscoverySubscribeAll(event) {
		event.stopPropagation()
		const btn = event.currentTarget
		const datasite = btn.dataset.datasite

		btn.disabled = true
		btn.textContent = '...'

		try {
			// Subscribe to the entire datasite's public folder
			await subscribeToPath(`${datasite}/public`, true)
		} catch (err) {
			console.error('[SyftBox] Subscribe all failed:', err)
			alert(`Failed to subscribe: ${err.message || err}`)
		} finally {
			btn.disabled = false
			btn.textContent = 'Subscribe All'
		}
	}

	async function refreshTree(parentPath = null) {
		const treeList = document.getElementById('sync-tree-list')
		if (!treeList) return

		// Set no-selection if nothing selected
		const explorer = document.querySelector('.syftbox-explorer')
		if (explorer && !_treeState.selected) {
			explorer.classList.add('no-selection')
		}

		// Only show loading for root level
		if (!parentPath) {
			treeList.innerHTML = `
				<div class="tree-loading">
					<span class="spinner"></span>
					<span>Loading datasites...</span>
				</div>
			`
		}

		try {
			const nodes = await invoke('sync_tree_list_dir', { path: parentPath })

			if (!parentPath) {
				_treeState.nodes.clear()
			}

			// Store nodes and populate activity log with initial state
			for (const node of nodes) {
				_treeState.nodes.set(node.path, node)

				// Add to activity log (limit initial entries, files only)
				if (_activityLog.length < 100 && !node.is_dir) {
					addActivityLogEntry({
						path: node.path,
						state: node.sync_state || 'completed',
						size: node.size,
						is_dir: node.is_dir,
						timestamp: new Date().toISOString(),
					})
				}
			}

			if (!parentPath && nodes.length === 0) {
				treeList.innerHTML = `
					<div class="tree-empty">
						<span class="empty-icon">📂</span>
						<span>No datasites found</span>
						<p class="empty-hint">Datasites will appear here when SyftBox syncs</p>
					</div>
				`
				return
			}

			// Re-render from root
			if (!parentPath) {
				renderTreeFromNodes()
			} else {
				renderTreeFromNodes()
			}
		} catch (err) {
			console.error('[SyftBox] Failed to refresh tree:', err)
			if (!parentPath) {
				treeList.innerHTML = `
					<div class="tree-error">
						<span class="error-icon">⚠</span>
						<span>Failed to load: ${escapeHtml(err.message || String(err))}</span>
					</div>
				`
			}
		}
	}

	function renderTreeFromNodes() {
		const treeList = document.getElementById('sync-tree-list')
		if (!treeList) return

		// Get root level nodes (no slashes in path)
		const rootNodes = Array.from(_treeState.nodes.values()).filter((n) => !n.path.includes('/'))

		if (rootNodes.length === 0) {
			treeList.innerHTML = `
				<div class="tree-empty">
					<span class="empty-icon">📂</span>
					<span>No datasites found</span>
				</div>
			`
			return
		}

		// Organize into sections (case-insensitive comparison for email matching)
		const currentUser = _treeState.currentUserEmail?.toLowerCase() || ''
		const trusted = _treeState.trustedDatasites

		const yourFiles = rootNodes.filter((n) => n.name.toLowerCase() === currentUser)
		const yourContacts = rootNodes.filter((n) => {
			const nameLower = n.name.toLowerCase()
			if (nameLower === currentUser) return false
			// Check if trusted (case-insensitive)
			for (const t of trusted) {
				if (t.toLowerCase() === nameLower) return true
			}
			return false
		})
		const theNetwork = rootNodes.filter((n) => {
			const nameLower = n.name.toLowerCase()
			if (nameLower === currentUser) return false
			// Check if NOT trusted
			for (const t of trusted) {
				if (t.toLowerCase() === nameLower) return false
			}
			return true
		})

		console.log('[SyftBox] Tree sections:', {
			currentUser,
			trustedSet: Array.from(trusted),
			rootNodeNames: rootNodes.map((n) => n.name),
			yourFiles: yourFiles.map((n) => n.name),
			yourContacts: yourContacts.map((n) => n.name),
			theNetwork: theNetwork.map((n) => n.name),
		})

		let html = ''

		// My Datasite section
		if (yourFiles.length > 0) {
			html += renderSection('your-files', '📁 My Datasite', yourFiles, false)
		}

		// Trusted Contacts section (keys imported to vault)
		if (yourContacts.length > 0) {
			html += renderSection('contacts', '🔐 Trusted Contacts', yourContacts, false)
		}

		// Other Users section (collapsed by default)
		if (theNetwork.length > 0) {
			const isCollapsed = _treeState.collapsedSections.has('network')
			html += renderSection('network', '🌐 Other Users', theNetwork, isCollapsed)
		}

		// Available to Sync section (discovery files)
		if (_treeState.discoveryFiles.length > 0) {
			const isCollapsed = _treeState.collapsedSections.has('discovery')
			html += renderDiscoverySection(isCollapsed)
		}

		treeList.innerHTML = html

		// Bind section toggle handlers
		treeList.querySelectorAll('.tree-section-header').forEach((header) => {
			if (!header.dataset.bound) {
				header.addEventListener('click', handleSectionToggle)
				header.dataset.bound = 'true'
			}
		})

		// Set indeterminate state on checkboxes (must be done via JS after render)
		treeList.querySelectorAll('.sync-checkbox[data-indeterminate="true"]').forEach((checkbox) => {
			checkbox.indeterminate = true
		})

		// Bind discovery subscribe button handlers
		treeList.querySelectorAll('.btn-subscribe-file, .btn-subscribe-folder').forEach((btn) => {
			btn.addEventListener('click', handleDiscoverySubscribe)
		})
		treeList.querySelectorAll('.btn-subscribe-all').forEach((btn) => {
			btn.addEventListener('click', handleDiscoverySubscribeAll)
		})
	}

	function renderSection(id, title, nodes, isCollapsed) {
		const collapseIcon = isCollapsed ? '▶' : '▼'
		const contentStyle = isCollapsed ? 'display: none;' : ''
		const count = nodes.length

		let html = `
			<div class="tree-section" data-section="${id}">
				<div class="tree-section-header ${isCollapsed ? 'collapsed' : ''}" data-section="${id}">
					<span class="section-icon">${collapseIcon}</span>
					<span class="section-title">${title}</span>
					<span class="section-count">(${count})</span>
				</div>
				<div class="tree-section-content" style="${contentStyle}">
		`

		for (const node of nodes) {
			html += renderNode(node, 0)
		}

		html += '</div></div>'
		return html
	}

	function renderDiscoverySection(isCollapsed) {
		const files = _treeState.discoveryFiles
		const collapseIcon = isCollapsed ? '▶' : '▼'
		const contentStyle = isCollapsed ? 'display: none;' : ''
		const count = files.length

		// Group files by datasite (first path segment)
		const byDatasite = new Map()
		for (const file of files) {
			const parts = file.path.split('/')
			const datasite = parts[0] || 'unknown'
			if (!byDatasite.has(datasite)) {
				byDatasite.set(datasite, [])
			}
			byDatasite.get(datasite).push(file)
		}

		let html = `
			<div class="tree-section discovery-section" data-section="discovery">
				<div class="tree-section-header ${isCollapsed ? 'collapsed' : ''}" data-section="discovery">
					<span class="section-icon">${collapseIcon}</span>
					<span class="section-title">📥 Available to Sync</span>
					<span class="section-count">(${count} files)</span>
				</div>
				<div class="tree-section-content" style="${contentStyle}">
		`

		for (const [datasite, datasiteFiles] of byDatasite) {
			html += `<div class="discovery-datasite" data-datasite="${escapeHtml(datasite)}">`
			html += `<div class="discovery-datasite-header">
				<span class="tree-icon">📁</span>
				<span class="discovery-datasite-name">${escapeHtml(datasite)}</span>
				<button class="btn-subscribe-all" data-datasite="${escapeHtml(datasite)}" title="Subscribe to all files from this datasite">Subscribe All</button>
			</div>`

			// Group by folder paths
			const byFolder = new Map()
			for (const file of datasiteFiles) {
				const pathParts = file.path.split('/')
				const folderPath = pathParts.slice(0, -1).join('/')
				if (!byFolder.has(folderPath)) {
					byFolder.set(folderPath, [])
				}
				byFolder.get(folderPath).push(file)
			}

			for (const [folderPath, folderFiles] of byFolder) {
				const displayPath = folderPath.split('/').slice(1).join('/') || '/'
				html += `<div class="discovery-folder">
					<div class="discovery-folder-header">
						<span class="discovery-folder-path">${escapeHtml(displayPath)}</span>
						<button class="btn-subscribe-folder" data-path="${escapeHtml(folderPath)}" title="Subscribe to this folder">Subscribe</button>
					</div>
				</div>`

				for (const file of folderFiles) {
					const fileName = file.path.split('/').pop()
					const sizeStr = file.size ? formatBytes(file.size) : ''
					html += `<div class="discovery-file" data-path="${escapeHtml(file.path)}">
						<span class="tree-icon">${getFileIcon(fileName)}</span>
						<span class="discovery-file-name">${escapeHtml(fileName)}</span>
						<span class="discovery-file-size">${sizeStr}</span>
						<button class="btn-subscribe-file" data-path="${escapeHtml(file.path)}" title="Subscribe to this file">+</button>
					</div>`
				}
			}

			html += '</div>'
		}

		html += '</div></div>'
		return html
	}

	function handleSectionToggle(event) {
		const header = event.currentTarget
		const sectionId = header.dataset.section
		const section = header.closest('.tree-section')
		const content = section?.querySelector('.tree-section-content')
		const icon = header.querySelector('.section-icon')

		if (!content || !icon) return

		const isCollapsed = _treeState.collapsedSections.has(sectionId)

		if (isCollapsed) {
			_treeState.collapsedSections.delete(sectionId)
			content.style.display = ''
			icon.textContent = '▼'
			header.classList.remove('collapsed')
		} else {
			_treeState.collapsedSections.add(sectionId)
			content.style.display = 'none'
			icon.textContent = '▶'
			header.classList.add('collapsed')
		}
	}

	function renderNode(node, depth) {
		const indent = depth * 12
		const isExpanded = _treeState.expanded.has(node.path)
		const isSelected = _treeState.selected === node.path
		const icon = node.is_dir ? (isExpanded ? '▼' : '▶') : ''
		const fileIcon = node.is_dir ? '📁' : getFileIcon(node.name)
		const statusIcon = node.is_ignored
			? STATUS_ICONS.ignored
			: STATUS_ICONS[node.sync_state] || STATUS_ICONS.completed
		const statusClass = node.is_ignored ? 'ignored' : node.sync_state
		const isChecked = !node.is_ignored
		const isEssential = node.is_essential || false

		// Check if this is a root-level datasite that we've subscribed to (trusted)
		const isRootDatasite = depth === 0 && node.is_dir
		let isTrusted = false
		if (isRootDatasite) {
			const nameLower = node.name.toLowerCase()
			for (const t of _treeState.trustedDatasites) {
				if (t.toLowerCase() === nameLower) {
					isTrusted = true
					break
				}
			}
		}

		// Check if this node is in the user's own datasite (no checkbox needed)
		const currentUser = _treeState.currentUserEmail?.toLowerCase() || ''
		const pathRoot = node.path.split('/')[0].toLowerCase()
		const isOwnDatasite = currentUser && pathRoot === currentUser

		// Essential paths show a lock icon, own datasite shows nothing, others show checkbox
		let syncControl = ''
		if (isEssential) {
			syncControl = `<span class="sync-lock" title="Required for BioVault - always synced">🔒</span>`
		} else if (isOwnDatasite) {
			// No checkbox for own datasite - just a spacer for alignment
			syncControl = `<span class="sync-spacer" style="width: 13px; display: inline-block;"></span>`
		} else {
			syncControl = `<input type="checkbox" class="sync-checkbox"
					${isChecked ? 'checked' : ''}
					${node.has_mixed_ignore ? 'data-indeterminate="true"' : ''}
					data-path="${escapeHtml(node.path)}"
					title="${node.is_ignored ? 'Track this path' : 'Stop tracking'}">`
		}

		// Tracking status: tracked = NOT ignored (syncing), partial = some children tracked
		// Own datasite is always tracked
		const isTracked = isOwnDatasite || !node.is_ignored
		const isPartial = !isOwnDatasite && node.has_mixed_ignore

		const nodeClasses = [
			'tree-node',
			node.is_dir ? 'folder' : 'file',
			isSelected ? 'selected' : '',
			isTracked ? 'tracked' : '',
			isPartial ? 'partial' : '',
			isEssential ? 'essential' : '',
			isTrusted ? 'trusted' : '',
			isOwnDatasite ? 'own-datasite' : '',
		]
			.filter(Boolean)
			.join(' ')

		let html = `
			<div class="${nodeClasses}"
				 data-path="${escapeHtml(node.path)}"
				 style="padding-left: ${indent}px">
				${syncControl}
				<span class="tree-expand ${node.is_dir ? 'clickable' : ''}">${icon}</span>
				<span class="tree-icon">${fileIcon}</span>
				<span class="tree-name">${escapeHtml(node.name)}</span>
				<span class="tree-status status-${statusClass}">${statusIcon}</span>
				${node.child_count !== null && node.child_count !== undefined ? `<span class="tree-count">(${node.child_count})</span>` : ''}
			</div>
		`

		// Render children if expanded
		if (node.is_dir && isExpanded) {
			const children = Array.from(_treeState.nodes.values()).filter((n) => {
				if (!n.path.startsWith(node.path + '/')) return false
				const relPath = n.path.substring(node.path.length + 1)
				return !relPath.includes('/')
			})
			for (const child of children) {
				html += renderNode(child, depth + 1)
			}
		}

		return html
	}

	async function handleCheckboxClick(event) {
		const checkbox = event.target
		if (!checkbox.classList.contains('sync-checkbox')) return

		event.stopPropagation()
		const path = checkbox.dataset.path
		const shouldSync = checkbox.checked

		checkbox.disabled = true
		try {
			if (shouldSync) {
				// Remove from ignore (add whitelist pattern)
				await invoke('sync_tree_remove_ignore', { pattern: path })
				// Also try removing with trailing slash for directories
				await invoke('sync_tree_remove_ignore', { pattern: `${path}/` }).catch(() => {})
			} else {
				// Add to ignore
				await invoke('sync_tree_add_ignore', { pattern: path })
			}

			// Refresh the node
			const nodeData = _treeState.nodes.get(path)
			if (nodeData) {
				nodeData.is_ignored = !shouldSync
			}
			renderTreeFromNodes()

			// Refresh details if this node is selected
			if (_treeState.selected === path) {
				showDetails(path, checkbox.closest('.tree-node').classList.contains('folder'))
			}
		} catch (err) {
			console.error('[SyftBox] Failed to toggle sync:', err)
			checkbox.checked = !shouldSync // Revert
		} finally {
			checkbox.disabled = false
		}
	}

	async function handleTreeClick(event) {
		// Don't handle if clicking checkbox
		if (event.target.classList.contains('sync-checkbox')) return

		const node = event.target.closest('.tree-node')
		if (!node) return

		const path = node.dataset.path
		const isFolder = node.classList.contains('folder')
		const clickedExpand = event.target.classList.contains('tree-expand')

		if (isFolder && clickedExpand) {
			// Toggle expand/collapse
			if (_treeState.expanded.has(path)) {
				_treeState.expanded.delete(path)
				renderTreeFromNodes()
			} else {
				_treeState.expanded.add(path)
				// Load children if not already loaded
				const hasChildren = Array.from(_treeState.nodes.values()).some((n) =>
					n.path.startsWith(path + '/'),
				)
				if (!hasChildren) {
					await refreshTree(path)
				} else {
					renderTreeFromNodes()
				}
			}
		} else {
			// Select node
			_treeState.selected = path
			document.querySelectorAll('.tree-node').forEach((n) => n.classList.remove('selected'))
			node.classList.add('selected')

			// Show detail pane
			const explorer = document.querySelector('.syftbox-explorer')
			if (explorer) {
				explorer.classList.remove('no-selection')
			}

			showDetails(path)
		}
	}

	function handleTreeFilter(event) {
		const query = event.target.value.toLowerCase().trim()
		const nodes = document.querySelectorAll('.tree-node')

		nodes.forEach((node) => {
			const path = node.dataset.path?.toLowerCase() || ''
			const matches = !query || path.includes(query)
			node.style.display = matches ? 'flex' : 'none'
		})
	}

	async function showDetails(path) {
		const detailsPane = document.getElementById('sync-tree-details')
		if (!detailsPane) return

		// Show loading
		detailsPane.innerHTML = `
			<div class="detail-loading">
				<span class="spinner"></span>
				<span>Loading...</span>
			</div>
		`

		try {
			const details = await invoke('sync_tree_get_details', { path })

			const icon = details.is_dir ? '📁' : getFileIcon(details.name)
			const state = details.is_ignored ? 'ignored' : details.sync_state
			const stateLabel = state.charAt(0).toUpperCase() + state.slice(1)

			detailsPane.innerHTML = `
				<div class="detail-header">
					<span class="detail-icon">${icon}</span>
					<div class="detail-info">
						<div class="detail-name">${escapeHtml(details.name)}</div>
						<div class="detail-path">${escapeHtml(details.path)}</div>
					</div>
				</div>

				<div class="detail-meta">
					<div class="meta-item">
						<div class="meta-label">Status</div>
						<div class="meta-value status-${state}">
							${STATUS_ICONS[state] || '✓'} ${stateLabel}
						</div>
					</div>
					<div class="meta-item">
						<div class="meta-label">Size</div>
						<div class="meta-value">${formatBytes(details.size)}</div>
					</div>
					${
						details.file_count !== null && details.file_count !== undefined
							? `
					<div class="meta-item">
						<div class="meta-label">Files</div>
						<div class="meta-value">${details.file_count}</div>
					</div>
					`
							: ''
					}
					${
						details.last_modified
							? `
					<div class="meta-item">
						<div class="meta-label">Modified</div>
						<div class="meta-value">${formatRelativeTime(details.last_modified)}</div>
					</div>
					`
							: ''
					}
					${
						details.progress
							? `
					<div class="meta-item">
						<div class="meta-label">Progress</div>
						<div class="meta-value">${details.progress.toFixed(1)}%</div>
					</div>
					`
							: ''
					}
					${
						details.is_ignored && details.ignore_pattern
							? `
					<div class="meta-item">
						<div class="meta-label">Ignored By</div>
						<div class="meta-value">${escapeHtml(details.ignore_pattern)}</div>
					</div>
					`
							: ''
					}
				</div>

				${
					details.error
						? `
				<div class="detail-error-box">
					<div class="error-label">Error</div>
					<div class="error-message">${escapeHtml(details.error)}</div>
				</div>
				`
						: ''
				}

				${renderFilePreview(details)}

				<div class="detail-actions">
					<button class="btn btn-secondary" onclick="window.__syftboxModule?.openInFinder('${escapeHtml(path)}')">
						Open in Finder
					</button>
				</div>
			`
		} catch (err) {
			console.error('[SyftBox] Failed to show details:', err)
			detailsPane.innerHTML = `
				<div class="detail-error">
					<span>Failed to load details: ${escapeHtml(err.message || String(err))}</span>
				</div>
			`
		}
	}

	function renderFilePreview(details) {
		// Special handling for syft.pub.yaml - show friendly permissions view
		if (details.syft_pub_info) {
			return renderSyftPubPreview(details.syft_pub_info)
		}

		// Regular file preview for JSON/YAML
		if (details.file_content && details.file_type) {
			const langClass =
				details.file_type === 'json' ? 'json' : details.file_type === 'yaml' ? 'yaml' : ''
			return `
				<div class="file-preview">
					<div class="preview-header">
						<span class="preview-title">Preview</span>
						<span class="preview-type">${details.file_type.toUpperCase()}</span>
					</div>
					<pre class="preview-content ${langClass}">${escapeHtml(details.file_content)}</pre>
				</div>
			`
		}

		return ''
	}

	function renderSyftPubPreview(info) {
		let html = `
			<div class="syft-pub-preview">
				<div class="preview-header">
					<span class="preview-title">📋 Permissions</span>
				</div>
		`

		if (info.description) {
			html += `<div class="pub-description">${escapeHtml(info.description)}</div>`
		}

		html += '<div class="pub-permissions">'

		for (const perm of info.permissions) {
			const icon = perm.is_wildcard ? '🌍' : '👤'
			const userLabel = perm.is_wildcard ? 'Everyone' : perm.user
			const accessClass =
				perm.access === 'read' ? 'read' : perm.access === 'write' ? 'write' : 'admin'

			html += `
				<div class="pub-permission">
					<span class="perm-icon">${icon}</span>
					<span class="perm-user">${escapeHtml(userLabel)}</span>
					<span class="perm-access ${accessClass}">${perm.access}</span>
				</div>
			`
		}

		html += '</div></div>'
		return html
	}

	async function openInFinder(path) {
		try {
			const configInfo = await invoke('get_syftbox_config_info').catch(() => ({}))
			const dataDir = configInfo.data_dir
			if (dataDir) {
				const fullPath = `${dataDir}/datasites/${path}`
				await invoke('open_folder', { path: fullPath })
			}
		} catch (err) {
			console.error('[SyftBox] Failed to open in Finder:', err)
		}
	}

	function updateStatusBar() {
		const statusEl = document.getElementById('syftbox-connection-status')
		const emailEl = document.getElementById('syftbox-user-email')
		const authBtn = document.getElementById('syftbox-auth-btn')

		if (statusEl) {
			const dot = statusEl.querySelector('.status-dot')
			const text = statusEl.querySelector('.status-text')

			if (_status.daemonRunning && _status.authenticated) {
				dot?.classList.add('connected')
				dot?.classList.remove('disconnected', 'connecting')
				if (text)
					text.textContent = `Connected to ${_status.serverUrl || 'https://dev.syftbox.net'}`
			} else if (_status.daemonRunning) {
				dot?.classList.add('connecting')
				dot?.classList.remove('connected', 'disconnected')
				if (text) text.textContent = 'Not authenticated'
			} else {
				dot?.classList.add('disconnected')
				dot?.classList.remove('connected', 'connecting')
				if (text) text.textContent = 'Offline'
			}
		}

		if (emailEl) {
			emailEl.textContent = _status.email || ''
		}

		if (authBtn) {
			authBtn.textContent = _status.authenticated ? 'Reauthenticate' : 'Authenticate'
		}
	}

	function updateActivitySummary() {
		const els = {
			syncing: document.getElementById('activity-syncing'),
			pending: document.getElementById('activity-pending'),
			completed: document.getElementById('activity-completed'),
			errors: document.getElementById('activity-errors'),
		}

		if (els.syncing) els.syncing.textContent = `↻ ${_queueSummary.syncing}`
		if (els.pending) els.pending.textContent = `⏳ ${_queueSummary.pending}`
		if (els.completed) els.completed.textContent = `✓ ${_queueSummary.completed}`
		if (els.errors) els.errors.textContent = `✗ ${_queueSummary.error}`
	}

	function updateGlobalStatusBar() {
		const els = {
			wsStatus: document.getElementById('global-ws-status'),
			lastSync: document.getElementById('global-last-sync'),
			pid: document.getElementById('global-pid'),
			mode: document.getElementById('global-mode'),
			tx: document.getElementById('global-tx'),
			rx: document.getElementById('global-rx'),
		}

		// WebSocket status (SyftBox client -> SyftBox server connection)
		if (els.wsStatus) {
			const dot = els.wsStatus.querySelector('.ws-dot')
			const label = els.wsStatus.querySelector('.ws-label')

			if (_status.wsConnected) {
				dot?.classList.add('connected')
				dot?.classList.remove('disconnected', 'error')
				if (label) label.textContent = 'SyftBox WS: Connected'
			} else if (_status.daemonRunning) {
				dot?.classList.remove('connected', 'error')
				dot?.classList.add('disconnected')
				if (label) label.textContent = 'SyftBox WS: Connecting...'
			} else {
				dot?.classList.add('disconnected')
				dot?.classList.remove('connected', 'error')
				if (label) label.textContent = 'SyftBox: Offline'
			}
		}

		// Server RTT with sparkline and average/last (click to toggle)
		// Uses latency from existing checks - no extra traffic created
		if (els.lastSync) {
			if (_status.latencyHistory && _status.latencyHistory.length > 0) {
				const stats = getServerLatencyStats()
				let text = ''
				if (_checkDisplayMode === 'avg' && stats.avg > 0) {
					text = `rtt avg ${stats.avg}ms`
				} else if (_checkDisplayMode === 'last' && stats.last > 0) {
					text = `rtt last ${stats.last}ms`
				} else if (stats.avg > 0) {
					text = `rtt avg ${stats.avg}ms`
				}
				if (stats.sparkline) {
					text += ` ${stats.sparkline}`
				}
				els.lastSync.textContent = text || 'checking...'
				els.lastSync.classList.toggle('recent', Date.now() - _status.lastSuccessfulCheck < 10000)
				els.lastSync.classList.add('clickable')
				els.lastSync.title = `Click to show ${_checkDisplayMode === 'avg' ? 'last' : 'average'} RTT (from existing checks)`
				// Bind click handler if not already bound
				if (!els.lastSync.dataset.bound) {
					els.lastSync.dataset.bound = 'true'
					els.lastSync.addEventListener('click', () => {
						_checkDisplayMode = _checkDisplayMode === 'avg' ? 'last' : 'avg'
						updateGlobalStatusBar()
					})
				}
			} else {
				els.lastSync.textContent = 'RTT: -'
				els.lastSync.classList.remove('recent')
			}
		}

		// PID (show embedded if no PID)
		if (els.pid) {
			if (_status.pid) {
				els.pid.textContent = `PID: ${_status.pid}`
			} else if (_status.daemonRunning) {
				els.pid.textContent = 'PID: embedded'
			} else {
				els.pid.textContent = 'PID: -'
			}
		}

		// Mode
		if (els.mode) {
			els.mode.textContent = `Mode: ${_status.mode || '-'}`
		}

		// TX/RX
		if (els.tx) {
			els.tx.textContent = `TX: ${formatBytes(_status.txBytes || 0)}`
		}
		if (els.rx) {
			els.rx.textContent = `RX: ${formatBytes(_status.rxBytes || 0)}`
		}
	}

	function getCheckStats() {
		const history = _status.checkHistory
		if (history.length === 0) return { avg: 0, last: 0, sparkline: '' }

		// Calculate average
		const sum = history.reduce((acc, h) => acc + h.interval, 0)
		const avg = Math.round(sum / history.length)

		// Get last interval
		const last = history.length > 0 ? history[history.length - 1].interval : 0

		// Generate sparkline (last 20 checks, using block chars)
		const recent = history.slice(-20)
		if (recent.length < 2) return { avg, last, sparkline: '' }

		// Normalize intervals to 0-7 range for sparkline chars
		const intervals = recent.map((h) => h.interval)
		const min = Math.min(...intervals)
		const max = Math.max(...intervals)
		const range = max - min || 1

		// Sparkline block characters from low to high
		const blocks = ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█']
		const sparkline = intervals
			.map((v) => {
				const idx = Math.min(7, Math.floor(((v - min) / range) * 7))
				return blocks[idx]
			})
			.join('')

		return { avg, last, sparkline }
	}

	function getServerLatencyStats() {
		const samples = _status.latencyHistory || []
		if (samples.length === 0) return { avg: 0, last: 0, sparkline: '' }
		const avg = Math.round(samples.reduce((sum, v) => sum + v, 0) / samples.length)
		const last = samples[samples.length - 1] || 0

		let sparkline = ''
		if (samples.length >= 2) {
			const blocks = ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█']
			const recent = samples.slice(-20)
			const min = Math.min(...recent)
			const max = Math.max(...recent)
			const range = max - min || 1
			sparkline = recent
				.map((v) => {
					const idx = Math.min(7, Math.floor(((v - min) / range) * 7))
					return blocks[idx]
				})
				.join('')
		}

		return { avg, last, sparkline }
	}

	function updateServerLatencyDisplay() {
		const el = document.getElementById('diag-server-latency')
		if (!el) return

		const samples = _status.latencyHistory
		if (!samples || samples.length === 0) {
			el.textContent = 'RTT: -'
			el.title = 'Server round-trip time (from existing checks - no extra traffic)'
			return
		}

		const avgMs = Math.round(samples.reduce((a, b) => a + b, 0) / samples.length)
		const minMs = Math.min(...samples)
		const maxMs = Math.max(...samples)
		const lastMs = samples[samples.length - 1]

		// Generate sparkline for latency samples
		let sparkline = ''
		if (samples.length >= 2) {
			const blocks = ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█']
			const min = minMs
			const max = maxMs
			const range = max - min || 1
			sparkline = samples
				.slice(-20)
				.map((v) => {
					const idx = Math.min(7, Math.floor(((v - min) / range) * 7))
					return blocks[idx]
				})
				.join('')
		}

		el.textContent = `${avgMs}ms ${sparkline}`
		el.title = `Server: ${_status.serverUrl || _status.clientUrl}\nAvg: ${avgMs}ms, Min: ${minMs}ms, Max: ${maxMs}ms, Last: ${lastMs}ms\n${samples.length} samples (from existing checks)`
	}

	function clearLatencyHistory() {
		_status.latencyHistory = []
		updateServerLatencyDisplay()
	}

	async function refreshTrustedContacts() {
		try {
			// Get contacts from vault (imported keys = trusted)
			const contacts = await invoke('key_list_contacts', { currentEmail: _status.email })
			_treeState.trustedDatasites.clear()
			for (const contact of contacts) {
				_treeState.trustedDatasites.add(contact.identity)
			}
			console.log(
				'[SyftBox] Loaded trusted contacts from vault:',
				contacts.map((c) => c.identity),
			)
		} catch (err) {
			console.warn('[SyftBox] Could not load trusted contacts:', err)
		}
	}

	async function refreshSharedWithMe() {
		const listEl = document.getElementById('shared-list')
		if (!listEl) return

		try {
			const items = await invoke('sync_tree_get_shared_with_me')

			if (!items || items.length === 0) {
				listEl.innerHTML = '<div class="shared-empty">No shared content discovered</div>'
				return
			}

			// Separate into trusted (imported keys) and untrusted
			// Use trustedDatasites which is populated from key_list_contacts
			const trusted = _treeState.trustedDatasites
			const trustedItems = items.filter((item) => trusted.has(item.owner))
			const untrustedItems = items.filter((item) => !trusted.has(item.owner))

			let html = ''

			// Trusted contacts section (keys imported to vault)
			if (trustedItems.length > 0) {
				html += '<div class="shared-group">'
				html += '<div class="shared-group-label trusted">🔐 Trusted Contacts</div>'
				for (const item of trustedItems) {
					html += renderSharedItem(item, true)
				}
				html += '</div>'
			}

			// Divider if both sections have items
			if (trustedItems.length > 0 && untrustedItems.length > 0) {
				html += '<div class="shared-divider"></div>'
			}

			// Untrusted section (keys not imported)
			if (untrustedItems.length > 0) {
				html += '<div class="shared-group">'
				html += '<div class="shared-group-label">🌐 Other Users</div>'
				for (const item of untrustedItems) {
					html += renderSharedItem(item, false)
				}
				html += '</div>'
			}

			listEl.innerHTML = html

			// Re-render tree to reflect trusted status
			renderTreeFromNodes()
		} catch (err) {
			console.error('[SyftBox] Failed to load shared items:', err)
			listEl.innerHTML = '<div class="shared-empty">Failed to load shared content</div>'
		}
	}

	function renderSharedItem(item, isTrusted) {
		const shortPath = item.path.split('/').slice(-2).join('/')
		const itemClass = isTrusted ? 'shared-item trusted' : 'shared-item untrusted'
		return `
			<div class="${itemClass}" data-path="${escapeHtml(item.path)}">
				<span class="shared-icon">${isTrusted ? '✓' : '📤'}</span>
				<div class="shared-info">
					<div class="shared-owner">${escapeHtml(item.owner)}</div>
					<div class="shared-path" title="${escapeHtml(item.path)}">${escapeHtml(shortPath)}</div>
					${item.description ? `<div class="shared-desc">${escapeHtml(item.description)}</div>` : ''}
				</div>
				<div class="shared-actions">
					<button class="btn-subscribe ${item.is_subscribed ? 'subscribed' : ''}"
						data-path="${escapeHtml(item.path)}"
						data-subscribed="${item.is_subscribed}">
						${item.is_subscribed ? 'Unsubscribe' : 'Subscribe'}
					</button>
				</div>
			</div>
		`
	}

	async function handleSharedClick(event) {
		const btn = event.target.closest('.btn-subscribe')
		if (!btn) return

		const path = btn.dataset.path
		const isSubscribed = btn.dataset.subscribed === 'true'

		btn.disabled = true
		try {
			if (isSubscribed) {
				await invoke('sync_tree_unsubscribe', { path })
			} else {
				await invoke('sync_tree_subscribe', { path })
			}
			// Refresh both the shared list (to reorganize sections) and tree
			await Promise.all([refreshSharedWithMe(), refreshTree()])
		} catch (err) {
			console.error('[SyftBox] Failed to toggle subscription:', err)
			showToast('Failed to update subscription')
		}
	}

	async function updateDiagnostics(configInfo, syftboxState) {
		const els = {
			pid: document.getElementById('diag-pid'),
			mode: document.getElementById('diag-mode'),
			tx: document.getElementById('diag-tx'),
			rx: document.getElementById('diag-rx'),
			configPath: document.getElementById('diag-config-path'),
			dataDir: document.getElementById('diag-data-dir'),
			datasites: document.getElementById('diag-datasites'),
			logPath: document.getElementById('diag-log-path'),
			daemonStatus: document.getElementById('diag-daemon-status'),
			serverUrl: document.getElementById('diag-server-url'),
			clientUrl: document.getElementById('diag-client-url'),
			backend: document.getElementById('diag-backend'),
			syftignore: document.getElementById('diag-syftignore'),
		}

		if (els.pid) els.pid.textContent = `PID: ${syftboxState.pid || '-'}`
		if (els.mode) els.mode.textContent = `Mode: ${syftboxState.mode || '-'}`
		if (els.tx) els.tx.textContent = `TX: ${formatBytes(syftboxState.tx_bytes || 0)}`
		if (els.rx) els.rx.textContent = `RX: ${formatBytes(syftboxState.rx_bytes || 0)}`
		if (els.configPath) els.configPath.textContent = configInfo.config_path || '-'
		if (els.dataDir) els.dataDir.textContent = configInfo.data_dir || '-'
		if (els.datasites)
			els.datasites.textContent = configInfo.data_dir ? `${configInfo.data_dir}/datasites` : '-'
		if (els.logPath) els.logPath.textContent = configInfo.log_path || syftboxState.log_path || '-'
		if (els.daemonStatus) {
			els.daemonStatus.textContent = syftboxState.running ? 'Running' : 'Stopped'
			els.daemonStatus.className = `diag-value ${syftboxState.running ? 'status-running' : 'status-stopped'}`
		}
		if (els.serverUrl) els.serverUrl.textContent = configInfo.server_url || '-'
		if (els.clientUrl) els.clientUrl.textContent = syftboxState.client_url || '-'
		if (els.backend) els.backend.textContent = syftboxState.backend || '-'

		// Get syftignore path
		if (els.syftignore) {
			try {
				const ignorePatterns = await invoke('sync_tree_get_ignore_patterns').catch(() => ({}))
				els.syftignore.textContent = ignorePatterns.syftignore_path || '-'
			} catch {
				els.syftignore.textContent = '-'
			}
		}

		// Enable/disable start/stop buttons based on daemon state
		const startBtn = document.getElementById('diag-start-btn')
		const stopBtn = document.getElementById('diag-stop-btn')
		if (startBtn) startBtn.disabled = syftboxState.running
		if (stopBtn) stopBtn.disabled = !syftboxState.running

		// Enable/disable open buttons based on path availability
		document.querySelectorAll('[data-action^="open-"]').forEach((btn) => {
			const action = btn.dataset.action
			let hasPath = false
			if (action === 'open-config') hasPath = !!configInfo.config_path
			if (action === 'open-data') hasPath = !!configInfo.data_dir
			if (action === 'open-datasites') hasPath = !!configInfo.data_dir
			if (action === 'open-log') hasPath = !!(configInfo.log_path || syftboxState.log_path)
			if (action === 'open-syftignore') hasPath = !!configInfo.data_dir
			btn.disabled = !hasPath
		})
	}

	function toggleDiagnostics() {
		const panel = document.getElementById('diagnostics-panel')
		const toggle = document.getElementById('diagnostics-toggle')
		const icon = toggle?.querySelector('.toggle-icon')

		if (panel) {
			const isHidden = panel.style.display === 'none'
			panel.style.display = isHidden ? 'block' : 'none'
			if (icon) icon.textContent = isHidden ? '▼' : '▶'
			if (toggle) {
				toggle.classList.toggle('expanded', isHidden)
			}
		}
	}

	async function handleAuthenticate() {
		// Navigate to settings and trigger auth flow
		window.navigateTo?.('settings')
		// The settings module will handle the auth flow
	}

	async function handleStartDaemon() {
		const btn = document.getElementById('diag-start-btn')
		if (btn) {
			btn.disabled = true
			btn.textContent = 'Starting...'
		}

		try {
			await invoke('start_syftbox_client')
			await refreshStatus()
		} catch (err) {
			console.error('[SyftBox] Failed to start daemon:', err)
			await dialog.message(`Failed to start SyftBox: ${err}`, { title: 'Error', type: 'error' })
		} finally {
			if (btn) {
				btn.disabled = false
				btn.textContent = 'Start'
			}
		}
	}

	async function handleStopDaemon() {
		const btn = document.getElementById('diag-stop-btn')
		if (btn) {
			btn.disabled = true
			btn.textContent = 'Stopping...'
		}

		try {
			await invoke('stop_syftbox_client')
			await refreshStatus()
		} catch (err) {
			console.error('[SyftBox] Failed to stop daemon:', err)
			await dialog.message(`Failed to stop SyftBox: ${err}`, { title: 'Error', type: 'error' })
		} finally {
			if (btn) {
				btn.disabled = false
				btn.textContent = 'Stop'
			}
		}
	}

	async function copyToClipboard(text) {
		try {
			await navigator.clipboard.writeText(text)
			showToast('Copied to clipboard')
		} catch (err) {
			console.error('[SyftBox] Failed to copy:', err)
		}
	}

	function showToast(message) {
		// Simple toast notification
		const existing = document.querySelector('.syftbox-toast')
		if (existing) existing.remove()

		const toast = document.createElement('div')
		toast.className = 'syftbox-toast'
		toast.textContent = message
		document.body.appendChild(toast)

		setTimeout(() => toast.classList.add('show'), 10)
		setTimeout(() => {
			toast.classList.remove('show')
			setTimeout(() => toast.remove(), 300)
		}, 2000)
	}

	async function handleCopyPath(action) {
		try {
			const configInfo = await invoke('get_syftbox_config_info').catch(() => ({}))
			const syftboxState = await invoke('get_syftbox_state').catch(() => ({}))
			const ignorePatterns = await invoke('sync_tree_get_ignore_patterns').catch(() => ({}))

			let text = null
			if (action === 'copy-config') text = configInfo.config_path
			if (action === 'copy-data') text = configInfo.data_dir
			if (action === 'copy-datasites')
				text = configInfo.data_dir ? `${configInfo.data_dir}/datasites` : null
			if (action === 'copy-log') text = configInfo.log_path || syftboxState.log_path
			if (action === 'copy-server') text = configInfo.server_url
			if (action === 'copy-client') text = syftboxState.client_url
			if (action === 'copy-syftignore') text = ignorePatterns.syftignore_path

			if (text) {
				await copyToClipboard(text)
			}
		} catch (err) {
			console.error('[SyftBox] Failed to copy path:', err)
		}
	}

	async function handleOpenPath(action) {
		try {
			const configInfo = await invoke('get_syftbox_config_info').catch(() => ({}))
			const syftboxState = await invoke('get_syftbox_state').catch(() => ({}))
			const ignorePatterns = await invoke('sync_tree_get_ignore_patterns').catch(() => ({}))

			let path = null
			let openFile = false

			if (action === 'open-config' && configInfo.config_path) {
				// Open parent directory of config file
				path = configInfo.config_path.substring(0, configInfo.config_path.lastIndexOf('/'))
			}
			if (action === 'open-data' && configInfo.data_dir) {
				path = configInfo.data_dir
			}
			if (action === 'open-datasites' && configInfo.data_dir) {
				path = `${configInfo.data_dir}/datasites`
			}
			if (action === 'open-log') {
				const logPath = configInfo.log_path || syftboxState.log_path
				if (logPath) {
					path = logPath.substring(0, logPath.lastIndexOf('/'))
				}
			}
			if (action === 'open-syftignore' && ignorePatterns.syftignore_path) {
				path = ignorePatterns.syftignore_path
				openFile = true
			}

			if (path) {
				if (openFile) {
					// Open file with default editor
					await invoke('open_path_in_file_manager', { path })
				} else {
					await invoke('open_folder', { path })
				}
			}
		} catch (err) {
			console.error('[SyftBox] Failed to open path:', err)
		}
	}

	async function refreshAll() {
		// Load status first to get current user email
		await refreshStatus()
		// Load trusted contacts from vault
		await refreshTrustedContacts()
		// Load shared items (uses trustedDatasites)
		await refreshSharedWithMe()
		// Then refresh tree (which uses currentUserEmail and trustedDatasites)
		await Promise.all([refreshQueue(), refreshTree()])
	}

	function startPolling() {
		if (_refreshTimer) {
			clearInterval(_refreshTimer)
		}
		_refreshTimer = setInterval(() => {
			// Always refresh queue to get WebSocket status for global status bar
			refreshQueue()
		}, 3000)

		// Start global status bar timer (always runs to update time display)
		if (_globalStatusTimer) {
			clearInterval(_globalStatusTimer)
		}
		_globalStatusTimer = setInterval(() => {
			updateGlobalStatusBar()
		}, 1000) // Update every second for precise timing
	}

	function stopPolling() {
		if (_refreshTimer) {
			clearInterval(_refreshTimer)
			_refreshTimer = null
		}
		if (_globalStatusTimer) {
			clearInterval(_globalStatusTimer)
			_globalStatusTimer = null
		}
	}

	function activate() {
		console.log('[SyftBox] Activating tab')
		refreshAll()
	}

	function deactivate() {
		console.log('[SyftBox] Deactivating tab')
		// Could stop polling here if needed
	}

	function cleanup() {
		stopPolling()
		stopFastPolling()
		disconnectSSE()
		stopWsEvents()
	}

	// Expose for onclick handlers
	window.__syftboxModule = {
		openInFinder,
	}

	return {
		init,
		initialize,
		activate,
		deactivate,
		cleanup,
		refreshAll,
		getStatus: () => _status,
	}
}
