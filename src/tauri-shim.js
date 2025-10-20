// Tauri API shim for browser development

const isTauri = typeof window !== 'undefined' && window.__TAURI__

// Mock invoke function for browser
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

export const invoke = isTauri ? window.__TAURI__.core.invoke : mockInvoke
export const dialog = isTauri ? window.__TAURI__.dialog : mockDialog
export const event = isTauri ? window.__TAURI__.event : { listen: mockEvent.listen }
export const shell = isTauri && window.__TAURI__.shell ? window.__TAURI__.shell : null
export const windowApi = isTauri && window.__TAURI__.window ? window.__TAURI__.window : null

// Helper to check if running in Tauri
export const isRunningInTauri = () => isTauri

console.log(`🌐 Running in ${isTauri ? 'Tauri' : 'Browser'} mode`)
