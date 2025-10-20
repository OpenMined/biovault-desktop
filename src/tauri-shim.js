// Tauri API shim for browser development
// Supports both mock mode and WebSocket bridge to real Rust backend

const isTauri = typeof window !== 'undefined' && window.__TAURI__

// WebSocket connection manager for browser mode
class WsBridge {
	constructor(url = 'ws://localhost:3333') {
		this.url = url
		this.ws = null
		this.requestId = 0
		this.pendingRequests = new Map()
		this.connected = false
		this.connecting = false
	}

	async connect() {
		if (this.connected || this.connecting) return

		this.connecting = true
		return new Promise((resolve, reject) => {
			try {
				this.ws = new WebSocket(this.url)

				this.ws.onopen = () => {
					console.log('🔌 WebSocket connected to Rust backend')
					this.connected = true
					this.connecting = false
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

				this.ws.onerror = (error) => {
					console.error('❌ WebSocket error:', error)
					this.connecting = false
					reject(error)
				}

				this.ws.onclose = () => {
					console.log('🔌 WebSocket disconnected')
					this.connected = false
					this.connecting = false
					// Reject all pending requests
					for (const [id, pending] of this.pendingRequests.entries()) {
						pending.reject(new Error('WebSocket connection closed'))
					}
					this.pendingRequests.clear()
				}

				// Timeout after 2 seconds
				setTimeout(() => {
					if (!this.connected) {
						this.connecting = false
						reject(new Error('WebSocket connection timeout'))
					}
				}, 2000)
			} catch (error) {
				this.connecting = false
				reject(error)
			}
		})
	}

	async invoke(cmd, args = {}) {
		if (!this.connected) {
			await this.connect()
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
	try {
		return await wsBridge.invoke(cmd, args)
	} catch (error) {
		console.error(`[WS] Failed to invoke ${cmd}:`, error)
		// Fall back to mock on error
		return mockInvoke(cmd, args)
	}
}

// Mock invoke function for browser (fallback)
async function mockInvoke(cmd, args = {}) {
	console.log(`[Mock] invoke: ${cmd}`, args)

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
		case 'get_settings':
			return { data_dir: '/mock/data', cli_path: '/mock/bv' }
		case 'check_dependencies':
			return { installed: [], missing: [], errors: [] }
		case 'check_is_onboarded':
			return false
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
	message: async (message, options) => {
		console.log('[Mock] dialog.message:', message, options)
		alert(message)
	},
	confirm: async (message, options) => {
		console.log('[Mock] dialog.confirm:', message, options)
		return window.confirm(message)
	},
}

// Mock event listener
const mockEvent = {
	listen: async (event, handler) => {
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
