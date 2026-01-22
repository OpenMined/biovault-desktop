import { invoke } from '@tauri-apps/api/core'

export interface ProfileSummary {
	id: string
	email: string | null
	biovault_home: string
	vault_path: string
	fingerprint: string | null
	onboarded: boolean
	running: boolean
	is_current: boolean
	last_used_at: string | null
}

export interface ProfilesBootState {
	enabled: boolean
	should_show_picker: boolean
	current_profile_id: string | null
	profiles: ProfileSummary[]
	startup_message: string | null
	opened_from_app: boolean
}

interface ProfilesState {
	enabled: boolean
	loading: boolean
	profiles: ProfileSummary[]
	currentProfileId: string | null
}

let state = $state<ProfilesState>({
	enabled: false,
	loading: true,
	profiles: [],
	currentProfileId: null
})

export const profilesStore = {
	get enabled() {
		return state.enabled
	},
	get loading() {
		return state.loading
	},
	get profiles() {
		return state.profiles
	},
	get currentProfileId() {
		return state.currentProfileId
	},
	get currentProfile() {
		return state.profiles.find((p) => p.is_current) || null
	},
	get hasMultipleProfiles() {
		return state.profiles.length > 1
	},

	async load(): Promise<void> {
		state.loading = true
		try {
			const bootState = await invoke<ProfilesBootState>('profiles_get_boot_state')
			state.enabled = bootState.enabled
			state.profiles = bootState.profiles
			state.currentProfileId = bootState.current_profile_id
		} catch (e) {
			console.error('Failed to load profiles:', e)
			state.enabled = false
			state.profiles = []
		} finally {
			state.loading = false
		}
	},

	async switchProfile(profileId: string): Promise<void> {
		await invoke('profiles_switch_in_place', { profileId })
		// App will reload after switch
	},

	async deleteProfile(profileId: string, deleteHome: boolean = true): Promise<void> {
		await invoke('profiles_delete_profile', { profileId, deleteHome })
		await this.load()
	},

	async createAndSwitch(homePath: string): Promise<string> {
		const result = await invoke<string>('profiles_create_and_switch_in_place', { homePath })
		return result
	},

	async getDefaultHome(): Promise<string> {
		return await invoke<string>('profiles_get_default_home')
	}
}
