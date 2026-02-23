<script lang="ts">
	import { profilesStore, type ProfileSummary } from '$lib/stores/profiles.svelte'
	import { syftboxAuthStore } from '$lib/stores/syftbox-auth.svelte'
	import { invoke } from '@tauri-apps/api/core'
	import { getAvatarToneClass } from '$lib/utils.js'
	import * as Dialog from '$lib/components/ui/dialog/index.js'
	import * as AlertDialog from '$lib/components/ui/alert-dialog/index.js'
	import * as Avatar from '$lib/components/ui/avatar/index.js'
	import { Button } from '$lib/components/ui/button/index.js'
	import { Badge } from '$lib/components/ui/badge/index.js'
	import UserIcon from '@lucide/svelte/icons/user'
	import UsersIcon from '@lucide/svelte/icons/users'
	import PlusIcon from '@lucide/svelte/icons/plus'
	import TrashIcon from '@lucide/svelte/icons/trash-2'
	import CheckIcon from '@lucide/svelte/icons/check'
	import Loader2Icon from '@lucide/svelte/icons/loader-2'
	import FolderIcon from '@lucide/svelte/icons/folder'
	import LogOutIcon from '@lucide/svelte/icons/log-out'
	import { open as openDialog, message as showMessage, confirm } from '@tauri-apps/plugin-dialog'
	import { toast } from 'svelte-sonner'

	interface Props {
		open?: boolean
		required?: boolean
		onOpenChange?: (open: boolean) => void
	}

	let { open = $bindable(false), required = false, onOpenChange }: Props = $props()

	let switching = $state(false)
	let signingOut = $state(false)
	let deleting = $state<string | null>(null)
	let deleteConfirmOpen = $state(false)
	let profileToDelete = $state<ProfileSummary | null>(null)
	let lastRequiredToastAt = 0

	const profiles = $derived(profilesStore.profiles)
	const loading = $derived(profilesStore.loading)

	function notifyProfileRequired() {
		const now = Date.now()
		if (now - lastRequiredToastAt < 1200) return
		lastRequiredToastAt = now
		toast.error('Profile setup required', {
			description: 'Select or create a profile before continuing.'
		})
	}

	function handleOpenChange(newOpen: boolean) {
		if (required && !newOpen) {
			notifyProfileRequired()
			return
		}
		open = newOpen
		onOpenChange?.(newOpen)
		if (newOpen) {
			profilesStore.load()
		}
	}

	async function handleSwitch(profile: ProfileSummary) {
		if (profile.is_current || switching) return

		switching = true
		try {
			await profilesStore.switchProfile(profile.id)
			// App will reload
			location.reload()
		} catch (e) {
			console.error('Failed to switch profile:', e)
			await showMessage(String(e), { title: 'Failed to Switch Profile', kind: 'error' })
		} finally {
			switching = false
		}
	}

	function confirmDelete(profile: ProfileSummary) {
		profileToDelete = profile
		deleteConfirmOpen = true
	}

	async function handleDelete() {
		if (!profileToDelete) return

		deleting = profileToDelete.id
		try {
			await profilesStore.deleteProfile(profileToDelete.id, true)
			deleteConfirmOpen = false
			profileToDelete = null
		} catch (e) {
			console.error('Failed to delete profile:', e)
			await showMessage(String(e), { title: 'Failed to Delete Profile', kind: 'error' })
		} finally {
			deleting = null
		}
	}

	async function handleAddProfile() {
		try {
			await showMessage(
				'Choose a folder to use as this profile\'s BioVault Home.\n\nTip: use "New Folder" in the picker to create one.',
				{ title: 'Add Profile', kind: 'info' }
			)

			const selection = await openDialog({ directory: true, multiple: false })
			if (!selection) return

			const chosen = typeof selection === 'string' ? selection : selection

			const ok = await confirm(`Create and switch to profile at:\n\n${chosen}`, {
				title: 'Add Profile',
				kind: 'warning'
			})
			if (!ok) return

			switching = true
			await profilesStore.createAndSwitch(chosen)

			await showMessage('Profile created! The app will now reload.', {
				title: 'Profile Created',
				kind: 'info'
			})

			location.reload()
		} catch (e) {
			console.error('Failed to add profile:', e)
			await showMessage(String(e), { title: 'Failed to Add Profile', kind: 'error' })
		} finally {
			switching = false
		}
	}

	async function handleSignOutCurrentProfile() {
		if (signingOut) return

		const ok = await confirm(
			'Sign out of this profile and return to the profile picker?',
			{
				title: 'Sign out of Profile',
				kind: 'warning'
			}
		)
		if (!ok) return

		signingOut = true
		try {
			// Signing out of profile should also bring SyftBox offline for this window.
			try {
				await syftboxAuthStore.goOffline(false)
			} catch {
				// Continue with profile sign-out even if daemon stop fails.
			}
			await invoke('profiles_open_picker')
			await showMessage('Signing out of this profile.', {
				title: 'Signed Out',
				kind: 'info'
			})
		} catch (e) {
			const message = String(e)
			if (message.includes('DEV_MODE_RESTART_REQUIRED')) {
				await showMessage('Please restart the app to open the profile picker in dev mode.', {
					title: 'Restart Required',
					kind: 'info'
				})
			} else {
				console.error('Failed to sign out of profile:', e)
				await showMessage(message, { title: 'Failed to Sign Out', kind: 'error' })
			}
		} finally {
			signingOut = false
		}
	}

	function getInitials(profile: ProfileSummary): string {
		if (profile.email) {
			return profile.email.substring(0, 2).toUpperCase()
		}
		return 'GU'
	}

	function getAvatarTone(profile: ProfileSummary): string {
		return getAvatarToneClass(profile.email || `guest:${profile.id}`)
	}

	function getStatusBadge(profile: ProfileSummary) {
		if (profile.running) return { text: 'Running', variant: 'default' as const }
		if (profile.onboarded) return { text: 'Ready', variant: 'secondary' as const }
		return { text: 'Needs setup', variant: 'outline' as const }
	}

	function shortenPath(path: string): string {
		const home = '~'
		// Try to shorten home directory
		if (path.startsWith('/Users/')) {
			const parts = path.split('/')
			if (parts.length >= 3) {
				return home + path.substring(`/Users/${parts[2]}`.length)
			}
		}
		return path
	}
</script>

<Dialog.Root bind:open onOpenChange={handleOpenChange}>
		<Dialog.Content
		class="sm:max-w-2xl"
		showCloseButton={!required}
		onInteractOutside={(e) => {
			if (required) {
				e.preventDefault()
				notifyProfileRequired()
			}
		}}
		onEscapeKeyDown={(e) => {
			if (required) {
				e.preventDefault()
				notifyProfileRequired()
			}
		}}
	>
			<Dialog.Header>
				<div class="flex items-start justify-between gap-3">
					<div>
						<Dialog.Title class="flex items-center gap-2">
							<UsersIcon class="size-5" />
							Switch Profile
						</Dialog.Title>
						<Dialog.Description>
							Switch between BioVault profiles or sign out to return to the profile picker.
						</Dialog.Description>
					</div>
					<Button variant="outline" onclick={handleAddProfile} disabled={switching}>
						<PlusIcon class="size-4" />
						Add Profile
					</Button>
				</div>
			</Dialog.Header>

		<div class="py-4">
			{#if loading}
				<div class="flex items-center justify-center py-8">
					<Loader2Icon class="size-6 animate-spin text-muted-foreground" />
				</div>
			{:else if profiles.length === 0}
				<div class="text-center py-8 text-muted-foreground">
					<UserIcon class="size-12 mx-auto mb-3 opacity-50" />
					<p>No profiles configured</p>
				</div>
			{:else}
				<div class="space-y-2 max-h-[300px] overflow-y-auto">
					{#each profiles as profile (profile.id)}
						{@const status = getStatusBadge(profile)}
						<div
							class="w-full flex items-center gap-3 p-3 rounded-lg border transition-colors {profile.is_current
								? 'border-primary bg-primary/5'
								: 'border-border hover:bg-muted/50'}"
						>
							<button
								type="button"
								class="flex-1 flex items-center gap-3 text-left"
								onclick={() => handleSwitch(profile)}
								disabled={profile.is_current || switching}
							>
								<Avatar.Root class="size-10">
									<Avatar.Fallback class={getAvatarTone(profile)}>{getInitials(profile)}</Avatar.Fallback>
								</Avatar.Root>

								<div class="flex-1 min-w-0">
									<div class="font-medium truncate">
										{profile.email || 'Guest'}
									</div>
									<div
										class="text-xs text-muted-foreground truncate flex items-center gap-1"
										title={profile.biovault_home}
									>
										<FolderIcon class="size-3 shrink-0" />
										{shortenPath(profile.biovault_home)}
									</div>
								</div>

								<div class="flex items-center gap-2 shrink-0">
									<Badge variant={status.variant}>{status.text}</Badge>
									{#if profile.is_current}
										<CheckIcon class="size-4 text-primary" />
									{/if}
								</div>
							</button>

							{#if !profile.is_current && !profile.running}
								<Button
									variant="ghost"
									size="icon"
									class="shrink-0 text-destructive hover:text-destructive hover:bg-destructive/10"
									onclick={() => confirmDelete(profile)}
									disabled={deleting === profile.id}
								>
									{#if deleting === profile.id}
										<Loader2Icon class="size-4 animate-spin" />
									{:else}
										<TrashIcon class="size-4" />
									{/if}
								</Button>
								{:else if profile.is_current}
									<Button
										variant="ghost"
										size="icon"
										class="shrink-0"
										onclick={handleSignOutCurrentProfile}
										disabled={signingOut}
										title="Sign out of profile"
									>
									{#if signingOut}
										<Loader2Icon class="size-4 animate-spin" />
									{:else}
										<LogOutIcon class="size-4" />
									{/if}
								</Button>
							{/if}
						</div>
					{/each}
				</div>
			{/if}
		</div>

		</Dialog.Content>
	</Dialog.Root>

<AlertDialog.Root bind:open={deleteConfirmOpen}>
	<AlertDialog.Content>
		<AlertDialog.Header>
			<AlertDialog.Title>Delete Profile?</AlertDialog.Title>
			<AlertDialog.Description>
				This will remove the profile "{profileToDelete?.email || 'Guest'}" and delete its home
				folder. This action cannot be undone.
			</AlertDialog.Description>
		</AlertDialog.Header>
		<AlertDialog.Footer>
			<AlertDialog.Cancel disabled={!!deleting}>Cancel</AlertDialog.Cancel>
			<AlertDialog.Action
				onclick={handleDelete}
				disabled={!!deleting}
				class="bg-destructive text-destructive-foreground hover:bg-destructive/90"
			>
				{#if deleting}
					Deleting...
				{:else}
					Delete Profile
				{/if}
			</AlertDialog.Action>
		</AlertDialog.Footer>
	</AlertDialog.Content>
</AlertDialog.Root>
