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

function ensureProcessEnv() {
	if (typeof window === 'undefined') return null
	const w = /** @type {any} */ window
	w.process = w.process || {}
	w.process.env = w.process.env || {}
	return w.process.env
}

function getQueryParam(name) {
	if (typeof window === 'undefined') return null
	try {
		const value = new URLSearchParams(window.location.search).get(name)
		return value && value.trim() ? value.trim() : null
	} catch (_err) {
		return null
	}
}

// Allow manual browser runs to opt into real backend mode:
// - `?real=1` forces real invoke (throws if WS is unavailable)
// - `?ws=3333` (or `?wsPort=3333`) selects which backend instance to talk to
// eslint-disable-next-line no-extra-semi
;(() => {
	const real = getQueryParam('real')
	if (real === '1' || real === 'true') {
		const env = ensureProcessEnv()
		if (env) env.USE_REAL_INVOKE = 'true'
		// A window-scoped flag is also supported in case `process` is polyfilled differently.
		window.__PREFER_REAL_INVOKE__ = true
	}
	const ws = getQueryParam('ws') || getQueryParam('wsPort') || getQueryParam('devWsPort')
	if (ws) {
		const n = Number.parseInt(ws, 10)
		if (Number.isFinite(n) && n > 0) {
			window.__DEV_WS_BRIDGE_PORT__ = n
			try {
				window.localStorage.setItem('DEV_WS_BRIDGE_PORT', String(n))
			} catch (_err) {
				// ignore
			}
		}
	}
})()

const defaultWsPort = (() => {
	const fromWindow = typeof window !== 'undefined' ? window.__DEV_WS_BRIDGE_PORT__ : null
	const fromQuery =
		typeof window !== 'undefined'
			? getQueryParam('ws') || getQueryParam('wsPort') || getQueryParam('devWsPort')
			: null
	const fromLocalStorage =
		typeof window !== 'undefined'
			? (() => {
					try {
						return window.localStorage.getItem('DEV_WS_BRIDGE_PORT')
					} catch (_err) {
						return null
					}
				})()
			: null
	const fromEnv =
		typeof process !== 'undefined' && process?.env
			? process.env.DEV_WS_BRIDGE_PORT
			: typeof window !== 'undefined' && window.process?.env
				? window.process.env.DEV_WS_BRIDGE_PORT
				: null

	const port = Number.parseInt(fromWindow || fromQuery || fromLocalStorage || fromEnv || '3333', 10)
	return Number.isFinite(port) && port > 0 ? port : 3333
})()

// WebSocket connection manager for browser mode
class WsBridge {
	constructor(url = `ws://localhost:${defaultWsPort}`) {
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

		const preferReal =
			(typeof window !== 'undefined' && window.__PREFER_REAL_INVOKE__ === true) ||
			(typeof process !== 'undefined' && process?.env?.USE_REAL_INVOKE === 'true') ||
			(typeof window !== 'undefined' && window.process?.env?.USE_REAL_INVOKE === 'true')
		const envConnectTimeout =
			(typeof process !== 'undefined' && process?.env?.WS_CONNECT_TIMEOUT_MS) ||
			(typeof window !== 'undefined' && window.process?.env?.WS_CONNECT_TIMEOUT_MS) ||
			null
		const connectTimeoutMs = (() => {
			const fromEnv = Number.parseInt(envConnectTimeout || '', 10)
			if (Number.isFinite(fromEnv) && fromEnv > 0) return fromEnv
			// When running in real-backend mode, allow the backend a bit longer to restart.
			return preferReal ? 5000 : 500
		})()

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
						if (pending.timeout) {
							clearTimeout(pending.timeout)
						}
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
						if (pending.timeout) {
							clearTimeout(pending.timeout)
						}
						pending.reject(new Error('WebSocket connection closed'))
					}
					this.pendingRequests.clear()
				}

				// Timeout quickly in mock mode; allow longer in real-backend mode (restarts can take >500ms).
				setTimeout(() => {
					if (!this.connected) {
						this.connecting = false
						this.connectPromise = null
						reject(new Error('WebSocket connection timeout'))
					}
				}, connectTimeoutMs)
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

		// Allow per-call timeouts without sending control fields to the backend.
		const rawArgs = args && typeof args === 'object' ? args : {}
		const timeoutOverride =
			typeof rawArgs.__wsTimeoutMs === 'number'
				? rawArgs.__wsTimeoutMs
				: typeof rawArgs.__timeoutMs === 'number'
					? rawArgs.__timeoutMs
					: null
		const cleanArgs = (() => {
			if (!rawArgs || (rawArgs.__wsTimeoutMs === undefined && rawArgs.__timeoutMs === undefined))
				return rawArgs
			const { __wsTimeoutMs: _a, __timeoutMs: _b, ...rest } = rawArgs
			return rest
		})()

		const defaultTimeoutMs = Number.parseInt(
			(typeof process !== 'undefined' && process?.env?.WS_REQUEST_TIMEOUT_MS) || '30000',
			10,
		)
		const longTimeoutMs = Number.parseInt(
			(typeof process !== 'undefined' && process?.env?.WS_LONG_REQUEST_TIMEOUT_MS) || '180000',
			10,
		)
		const longRunning = new Set([
			'launch_session_jupyter',
			'stop_session_jupyter',
			'reset_session_jupyter',
			'launch_jupyter',
			'stop_jupyter',
			'reset_jupyter',
			'syftbox_queue_status',
			'syftbox_upload_action',
			'sync_messages',
			'sync_messages_with_failures',
			'refresh_messages_batched',
			'install_dependencies',
			'install_dependency',
			'install_brew',
			'install_command_line_tools',
			'import_flow_with_deps',
			'import_flow',
		])
		const timeoutMs = Math.max(
			1000,
			Number.isFinite(timeoutOverride)
				? timeoutOverride
				: longRunning.has(cmd)
					? longTimeoutMs
					: defaultTimeoutMs,
		)

		const id = ++this.requestId
		const request = { id, cmd, args: cleanArgs }

		return new Promise((resolve, reject) => {
			const timeout = setTimeout(() => {
				if (this.pendingRequests.has(id)) {
					this.pendingRequests.delete(id)
					reject(new Error(`Request timeout: ${cmd}`))
				}
			}, timeoutMs)

			this.pendingRequests.set(id, { resolve, reject, timeout })
			this.ws.send(JSON.stringify(request))
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

	const preferReal =
		(typeof window !== 'undefined' && window.__PREFER_REAL_INVOKE__ === true) ||
		(typeof process !== 'undefined' && process?.env?.USE_REAL_INVOKE === 'true')
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
		case 'get_modules':
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
		if (typeof window !== 'undefined' && typeof window.__TEST_DIALOG_OPEN__ === 'function') {
			return window.__TEST_DIALOG_OPEN__(options)
		}
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
	ask: async (message, options) => {
		console.log('[Mock] dialog.ask:', message, options)
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
