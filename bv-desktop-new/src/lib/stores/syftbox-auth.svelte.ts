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
}

let state = $state<SyftBoxAuthState>({
	isAuthenticated: false,
	isChecking: true,
	email: '',
	isOnline: false,
	isTogglingOnline: false
})

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

	async checkAuth() {
		state.isChecking = true
		try {
			const isAuth = await invoke<boolean>('check_syftbox_auth')
			state.isAuthenticated = isAuth

			if (isAuth) {
				// Get the email from settings
				const settings = await invoke<{ email?: string }>('get_settings')
				state.email = settings?.email || ''

				// Check if SyftBox daemon is running (respect current state)
				try {
					const syftboxState = await invoke<SyftBoxState>('get_syftbox_state')
					state.isOnline = syftboxState.running
				} catch {
					state.isOnline = false
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
		await invoke('syftbox_request_otp', {
			email,
			server_url: serverUrl || null
		})
	},

	async submitOtp(email: string, otp: string, serverUrl?: string): Promise<void> {
		await invoke('syftbox_submit_otp', {
			code: otp,
			email,
			server_url: serverUrl || null
		})
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
		state.isTogglingOnline = true
		try {
			const result = await invoke<SyftBoxState>('start_syftbox_client')
			state.isOnline = result.running
			if (showToast && result.running) {
				toast.success('Connected to SyftBox network', {
					description: 'You are now online and syncing'
				})
			}
		} catch (e) {
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
		state.isTogglingOnline = true
		try {
			const result = await invoke<SyftBoxState>('stop_syftbox_client')
			state.isOnline = result.running
			if (showToast && !result.running) {
				toast.info('Disconnected from SyftBox network', {
					description: 'You are now offline'
				})
			}
		} catch (e) {
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
		if (state.isOnline) {
			await this.goOffline()
		} else {
			await this.goOnline()
		}
	}
}
