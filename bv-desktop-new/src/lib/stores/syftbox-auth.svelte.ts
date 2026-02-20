import { invoke } from '@tauri-apps/api/core'
import { toast } from 'svelte-sonner'

interface SyftBoxState {
	running: boolean
	mode: string
	backend: string
	log_path?: string
	error?: string
	pid?: number
	client_url?: string
	tx_bytes: number
	rx_bytes: number
}

// SyftBox authentication state
interface SyftBoxAuthState {
	isAuthenticated: boolean
	isChecking: boolean
	email: string
	isOnline: boolean
	isTogglingOnline: boolean
	isAuthEnabled: boolean
}

let state = $state<SyftBoxAuthState>({
	isAuthenticated: false,
	isChecking: true,
	email: '',
	isOnline: false,
	isTogglingOnline: false,
	isAuthEnabled: true
})

// Cooldown to prevent rapid toggling (1 second)
const TOGGLE_COOLDOWN_MS = 1000
let lastToggleTime = 0

function canToggle(): boolean {
	const now = Date.now()
	if (now - lastToggleTime < TOGGLE_COOLDOWN_MS) {
		return false
	}
	lastToggleTime = now
	return true
}

export const syftboxAuthStore = {
	get isAuthenticated() {
		return state.isAuthenticated
	},
	get isChecking() {
		return state.isChecking
	},
	get email() {
		return state.email
	},
	get isOnline() {
		return state.isOnline
	},
	get isTogglingOnline() {
		return state.isTogglingOnline
	},
	get isAuthEnabled() {
		return state.isAuthEnabled
	},

	async checkAuthEnabled() {
		try {
			const authEnabledVar = await invoke<string | null>('get_env_var', {
				key: 'SYFTBOX_AUTH_ENABLED'
			})
			if (authEnabledVar === '0' || authEnabledVar === 'false') {
				state.isAuthEnabled = false
			} else {
				state.isAuthEnabled = true
			}
		} catch (e) {
			console.warn('Failed to check SYFTBOX_AUTH_ENABLED:', e)
		}
	},

	async checkAuth() {
		state.isChecking = true

		// Check if auth is disabled via environment variable
		await this.checkAuthEnabled()

		// When auth is bypassed, ensure BioVault is initialized
		if (!state.isAuthEnabled) {
			try {
				const settings = await invoke<{ email?: string }>('get_settings')
				const email = settings?.email || 'dev@localhost'
				await invoke('complete_onboarding', { email })
			} catch (e) {
				console.warn('Auto-init during auth bypass failed:', e)
			}
		}

		try {
			const isAuth = await invoke<boolean>('check_syftbox_auth')
			state.isAuthenticated = isAuth

			if (state.isAuthenticated) {
				// Get the email and preferences from settings
				const settings = await invoke<{ email?: string; syftbox_prefer_online?: boolean }>(
					'get_settings'
				)
				state.email = settings?.email || ''
				const preferOnline = settings?.syftbox_prefer_online ?? false

				// Check if SyftBox daemon is running
				try {
					const syftboxState = await invoke<SyftBoxState>('get_syftbox_state')
					state.isOnline = syftboxState.running

					// If user prefers to be online but daemon isn't running, auto-start it
					if (preferOnline && !syftboxState.running) {
						console.log('Auto-starting SyftBox daemon (prefer online)')
						await this.goOnline(false)
					}
				} catch {
					state.isOnline = false
					// Still try to auto-start if preferred
					if (preferOnline) {
						console.log('Auto-starting SyftBox daemon (prefer online, state check failed)')
						await this.goOnline(false)
					}
				}
			}
		} catch (e) {
			console.error('Failed to check SyftBox auth:', e)
			state.isAuthenticated = false
		} finally {
			state.isChecking = false
		}
		return state.isAuthenticated
	},

	async requestOtp(email: string, serverUrl?: string): Promise<void> {
		// Re-check bypass status immediately before request
		await this.checkAuthEnabled()

		await invoke('syftbox_request_otp', {
			email,
			server_url: serverUrl || null
		})
	},

	async submitOtp(email: string, otp: string, serverUrl?: string): Promise<void> {
		// Re-check bypass status immediately before submit
		await this.checkAuthEnabled()

		try {
			await invoke('syftbox_submit_otp', {
				code: otp,
				email,
				server_url: serverUrl || null
			})
		} catch (e) {
			console.error('Backend syftbox_submit_otp failed:', e)
			throw e
		}

		// Initialize BioVault config and directory structure if needed
		try {
			await invoke('complete_onboarding', { email })
		} catch (e) {
			console.error('Failed to complete onboarding:', e)
		}

		// Update profile email to match the signed-in account
		try {
			const currentSettings = await invoke<{ email?: string }>('get_settings')
			if (currentSettings.email !== email) {
				await invoke('save_settings', {
					settings: { ...currentSettings, email }
				})
			}
		} catch (e) {
			console.error('Failed to update profile email:', e)
		}

		// Re-check auth after successful OTP submission
		await this.checkAuth()
		// Auto go online after signing in
		await this.goOnline(false)
		// Show success toast
		toast.success('Connected to SyftBox', {
			description: `Signed in as ${email}`
		})
	},

	setAuthenticated(value: boolean, email?: string) {
		state.isAuthenticated = value
		if (email) {
			state.email = email
		}
	},

	async disconnect(): Promise<void> {
		try {
			// Stop daemon first if running
			if (state.isOnline) {
				await this.goOffline()
			}
			// Clear SyftBox credentials via settings update
			await invoke('clear_syftbox_credentials')
			state.isAuthenticated = false
			state.email = ''
			state.isOnline = false
		} catch (e) {
			console.error('Failed to disconnect from SyftBox:', e)
			throw e
		}
	},

	async goOnline(showToast = true): Promise<void> {
		if (state.isTogglingOnline) return
		state.isTogglingOnline = true
		// Optimistic update
		const previousState = state.isOnline
		state.isOnline = true
		try {
			const result = await invoke<SyftBoxState>('start_syftbox_client')
			state.isOnline = result.running
			// Save preference
			await invoke('set_syftbox_prefer_online', { enabled: true })
			if (showToast && result.running) {
				toast.success('Connected to SyftBox network', {
					description: 'You are now online and syncing'
				})
			}
		} catch (e) {
			// Revert on failure
			state.isOnline = previousState
			console.error('Failed to go online:', e)
			if (showToast) {
				toast.error('Failed to connect', {
					description: String(e)
				})
			}
			throw e
		} finally {
			state.isTogglingOnline = false
		}
	},

	async goOffline(showToast = true): Promise<void> {
		if (state.isTogglingOnline) return
		state.isTogglingOnline = true
		// Optimistic update
		const previousState = state.isOnline
		state.isOnline = false
		try {
			const result = await invoke<SyftBoxState>('stop_syftbox_client')
			state.isOnline = result.running
			// Save preference
			await invoke('set_syftbox_prefer_online', { enabled: false })
			if (showToast && !result.running) {
				toast.info('Disconnected from SyftBox network', {
					description: 'You are now offline'
				})
			}
		} catch (e) {
			// Revert on failure
			state.isOnline = previousState
			console.error('Failed to go offline:', e)
			if (showToast) {
				toast.error('Failed to disconnect', {
					description: String(e)
				})
			}
			throw e
		} finally {
			state.isTogglingOnline = false
		}
	},

	async toggleOnline(): Promise<void> {
		// Cooldown prevents crashes from rapid clicking
		if (state.isTogglingOnline || !canToggle()) return
		if (state.isOnline) {
			await this.goOffline()
		} else {
			await this.goOnline()
		}
	}
}
