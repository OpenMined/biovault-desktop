export type TauriInternals = {
	invoke: (cmd: string, args?: unknown) => Promise<unknown>
	transformCallback: (callback: (...args: unknown[]) => void) => number
	metadata: {
		currentWebview: { label: string }
		currentWindow: { label: string }
	}
}

declare global {
	interface Window {
		__TAURI_INTERNALS__?: TauriInternals
		__TAURI__?: {
			core?: { invoke?: (cmd: string, args?: unknown) => Promise<unknown> }
			dialog?: Record<string, unknown>
			event?: Record<string, unknown>
			shell?: Record<string, unknown> | null
			window?: Record<string, unknown> | null
		}
	}
}

function ensureCallbackRegistry() {
	const w = window as Window & Record<string, unknown>
	if (!w.__TAURI_CALLBACKS__) {
		Object.defineProperty(w, '__TAURI_CALLBACKS__', {
			value: new Map<number, (...args: unknown[]) => void>(),
			writable: false,
			enumerable: false,
		})
	}
	return w.__TAURI_CALLBACKS__ as Map<number, (...args: unknown[]) => void>
}

function makeTransformCallback() {
	return (callback: (...args: unknown[]) => void) => {
		const registry = ensureCallbackRegistry()
		const id = Math.floor(Math.random() * Number.MAX_SAFE_INTEGER)
		registry.set(id, callback)
		return id
	}
}

export async function ensureTauriBridge(): Promise<void> {
	if (typeof window === 'undefined') return

	if (window.__TAURI_INTERNALS__?.invoke) return

	// Load the browser shim (served from /static/tauri-shim.js)
	const shim =
		typeof window !== 'undefined' && (window as any).__TAURI_SHIM__
			? (window as any).__TAURI_SHIM__
			: await import(
					/* @vite-ignore */ new URL('/tauri-shim.js', window.location.href).toString()
				)
	const invoke = shim?.invoke
	const dialog = shim?.dialog
	const event = shim?.event
	const shell = shim?.shell ?? null
	const windowApi = shim?.windowApi ?? null

	if (typeof invoke !== 'function') {
		throw new Error('tauri-shim did not export invoke')
	}

	const { mockIPC, mockWindows, mockConvertFileSrc } = await import('@tauri-apps/api/mocks')
	mockIPC((cmd, args) => invoke(cmd, args ?? {}), { shouldMockEvents: true })
	mockWindows('main')
	mockConvertFileSrc('macos')

	window.__TAURI__ = {
		core: { invoke: (cmd: string, args?: unknown) => invoke(cmd, args ?? {}) },
		dialog,
		event,
		shell,
		window: windowApi,
	}
}
