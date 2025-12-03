// Tauri API shim for browser development
// Supports both mock mode and WebSocket bridge to real Rust backend

const isTauri = typeof window !== 'undefined' && window.__TAURI__

const originalConsole = {
	log: console.log.bind(console),
	warn: console.warn.bind(console),
	error: console.error.bind(console),
	info: console.info ? console.info.bind(console) : console.log.bind(console),
}

function formatConsoleArg(arg) {
	if (typeof arg === 'string') {
		return arg
	}

	try {
		return JSON.stringify(arg)
	} catch (_err) {
		return String(arg)
	}
}

function forwardConsoleToDesktop(level, args) {
	if (!isTauri || !window.__TAURI__?.core?.invoke) {
		return
	}

	const message = args.map(formatConsoleArg).join(' ')
	if (!message) {
		return
	}

	window.__TAURI__.core.invoke('log_frontend_message', { level, message }).catch(() => {
		// Ignore logging transport errors so console output remains unaffected
	})
}

console.log = (...args) => {
	forwardConsoleToDesktop('info', args)
	originalConsole.log(...args)
}
console.warn = (...args) => {
	forwardConsoleToDesktop('warn', args)
	originalConsole.warn(...args)
}
console.error = (...args) => {
	forwardConsoleToDesktop('error', args)
	originalConsole.error(...args)
}
if (console.info) {
	console.info = (...args) => {
		forwardConsoleToDesktop('info', args)
		originalConsole.info(...args)
	}
}

// WebSocket connection manager for browser mode
class WsBridge {
	constructor(url = 'ws://localhost:3333') {
		this.url = url
		this.ws = null
		this.requestId = 0
		this.pendingRequests = new Map()
		this.connected = false
		this.connecting = false
		this.connectPromise = null
	}

	async connect() {
		if (this.connected) return
		if (this.connectPromise) return this.connectPromise

		this.connecting = true
		this.connectPromise = new Promise((resolve, reject) => {
			try {
				this.ws = new WebSocket(this.url)

				this.ws.onopen = () => {
					console.log('🔌 WebSocket connected to Rust backend')
					this.connected = true
					this.connecting = false
					this.connectPromise = null
					resolve()
				}

				this.ws.onmessage = (event) => {
					const response = JSON.parse(event.data)
					const pending = this.pendingRequests.get(response.id)
					if (pending) {
						this.pendingRequests.delete(response.id)
						if (response.error) {
							pending.reject(new Error(response.error))
						} else {
							pending.resolve(response.result)
						}
					}
				}

				this.ws.onerror = (_error) => {
					// Only log in real mode, not when using mocks
					const isRealMode =
						typeof process !== 'undefined' && process?.env?.USE_REAL_INVOKE === 'true'
					if (isRealMode) {
						console.log('🔌 WebSocket connection failed (no backend available)')
					}
					this.connecting = false
					this.connectPromise = null
					if (this.ws) {
						this.ws.close()
						this.ws = null
					}
					reject(new Error('WebSocket not available'))
				}

				this.ws.onclose = () => {
					console.log('🔌 WebSocket disconnected')
					this.connected = false
					this.connecting = false
					this.connectPromise = null
					// Reject all pending requests
					for (const [_id, pending] of this.pendingRequests.entries()) {
						pending.reject(new Error('WebSocket connection closed'))
					}
					this.pendingRequests.clear()
				}

				// Timeout after 500ms for faster test feedback
				setTimeout(() => {
					if (!this.connected) {
						this.connecting = false
						this.connectPromise = null
						reject(new Error('WebSocket connection timeout'))
					}
				}, 500)
			} catch (error) {
				this.connecting = false
				this.connectPromise = null
				reject(error)
			}
		})

		return this.connectPromise
	}

	async invoke(cmd, args = {}) {
		if (!this.connected) {
			await this.connect()
		}

		if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
			throw new Error('WebSocket not connected')
		}

		const id = ++this.requestId
		const request = { id, cmd, args }

		return new Promise((resolve, reject) => {
			this.pendingRequests.set(id, { resolve, reject })
			this.ws.send(JSON.stringify(request))

			// Timeout after 30 seconds
			setTimeout(() => {
				if (this.pendingRequests.has(id)) {
					this.pendingRequests.delete(id)
					reject(new Error(`Request timeout: ${cmd}`))
				}
			}, 30000)
		})
	}
}

// Create WebSocket bridge instance
const wsBridge = new WsBridge()

// WebSocket invoke function
async function wsInvoke(cmd, args = {}) {
	// If test override is present, skip WebSocket entirely and go straight to mock
	if (typeof window !== 'undefined' && window.__TEST_INVOKE_OVERRIDE__) {
		return mockInvoke(cmd, args)
	}

	const preferReal = typeof process !== 'undefined' && process?.env?.USE_REAL_INVOKE === 'true'
	if (preferReal) {
		console.log('[WS] Using real backend mode - will throw on WebSocket failure')
	}
	try {
		const result = await wsBridge.invoke(cmd, args)
		console.log(`[WS] Successfully invoked ${cmd}`)
		return result
	} catch (error) {
		if (preferReal) {
			console.error(`[WS] Failed to invoke ${cmd}:`, error)
			throw error
		}
		// In mock mode, silently fall back without error logging
	}

	// Fall back to mock when backend is unavailable
	// Only log in verbose/debug mode
	if (preferReal) {
		console.log(`[WS] Falling back to mock for ${cmd}`)
	}
	return mockInvoke(cmd, args)
}

// Mock invoke function for browser (fallback)
async function mockInvoke(cmd, args = {}) {
	console.log(`[Mock] invoke: ${cmd}`, args)

	if (typeof window !== 'undefined' && window.__TEST_INVOKE_OVERRIDE__) {
		const overrideResult = await window.__TEST_INVOKE_OVERRIDE__(cmd, args)
		if (overrideResult !== undefined) {
			return overrideResult
		}
	}

	// Return mock data for common commands
	switch (cmd) {
		case 'get_participants':
			return []
		case 'get_files':
			return []
		case 'get_projects':
			return []
		case 'get_runs':
			return []
		case 'get_command_logs':
			return []
		case 'get_desktop_log_text':
			return ''
		case 'get_desktop_log_dir':
			return '/tmp'
		case 'clear_desktop_log':
			return null
		case 'get_settings':
			return {
				docker_path: '/usr/local/bin/docker',
				java_path: '/usr/bin/java',
				syftbox_path: '/usr/local/bin/syftbox',
				biovault_path: 'bv',
				email: 'mock@example.com',
				ai_api_url: 'https://openrouter.ai/api/v1/chat/completions',
				ai_api_token: '',
				ai_model: 'openrouter/auto',
				syftbox_server_url: 'https://dev.syftbox.net',
			}
		case 'get_default_syftbox_server_url':
			return 'https://dev.syftbox.net'
		case 'get_env_var': {
			const key = args?.key || ''
			if (typeof key !== 'string') return ''
			if (typeof process !== 'undefined' && process?.env) {
				return process.env[key] || ''
			}
			return ''
		}
		case 'check_dependencies':
			return { installed: [], missing: [], errors: [] }
		case 'check_is_onboarded':
			// Default to true so main app loads
			// Onboarding tests override this via __TEST_INVOKE_OVERRIDE__
			return true
		case 'sql_list_tables':
			return [{ name: 'participants' }, { name: 'measurements' }]
		case 'sql_get_table_schema':
			return {
				columns: [
					{ name: 'id', type: 'INTEGER', nullable: false, primary_key: true },
					{ name: 'name', type: 'TEXT', nullable: true, primary_key: false },
				],
				indexes: ['idx_participants_name'],
				foreign_keys: [],
			}
		case 'sql_run_query':
			return {
				operation: 'read',
				headers: ['id', 'name'],
				rows: [
					['1', 'Alice'],
					['2', 'Bob'],
				],
				total_rows: 2,
				truncated: false,
				execution_time_ms: 2,
				affected_rows: null,
				message: null,
			}
		case 'sql_export_query':
			return {
				path: args?.destination || '/tmp/query-results.csv',
				rows_written: 2,
			}
		default:
			console.warn(`[Mock] Unhandled command: ${cmd}`)
			return null
	}
}

// Mock dialog
const mockDialog = {
	open: async (options) => {
		console.log('[Mock] dialog.open:', options)
		return null
	},
	save: async (options) => {
		console.log('[Mock] dialog.save:', options)
		return options?.defaultPath || 'mock-query-results.csv'
	},
	message: async (message, options) => {
		console.log('[Mock] dialog.message called:', message, options)
		try {
			// Use setTimeout to ensure alert() is called asynchronously
			// This prevents blocking the event loop and allows Playwright to intercept
			await new Promise((resolve) => {
				setTimeout(() => {
					console.log('[Mock] Calling alert now')
					alert(message)
					console.log('[Mock] Alert completed')
					resolve()
				}, 0)
			})
		} catch (error) {
			console.error('[Mock] dialog.message error:', error)
			throw error
		}
	},
	confirm: async (message, options) => {
		console.log('[Mock] dialog.confirm:', message, options)
		// Use setTimeout to ensure confirm() is called asynchronously
		// This prevents blocking the event loop and allows Playwright to intercept
		return new Promise((resolve) => {
			setTimeout(() => {
				const result = window.confirm(message)
				resolve(result)
			}, 0)
		})
	},
}

// Mock event listener
const mockEvent = {
	listen: async (event, _handler) => {
		console.log('[Mock] listen:', event)
		return () => {}
	},
}

// Export API - use WebSocket in browser mode, Tauri in app mode
export const invoke = isTauri ? window.__TAURI__.core.invoke : wsInvoke
export const dialog = isTauri ? window.__TAURI__.dialog : mockDialog
export const event = isTauri ? window.__TAURI__.event : { listen: mockEvent.listen }
export const shell = isTauri && window.__TAURI__.shell ? window.__TAURI__.shell : null
export const windowApi = isTauri && window.__TAURI__.window ? window.__TAURI__.window : null

// Helper to check if running in Tauri
export const isRunningInTauri = () => isTauri

console.log(`🌐 Running in ${isTauri ? 'Tauri' : 'Browser (WebSocket)'} mode`)
