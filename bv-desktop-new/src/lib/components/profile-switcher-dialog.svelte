<script lang="ts">
	import { profilesStore, type ProfileSummary } from '$lib/stores/profiles.svelte'
	import * as Dialog from '$lib/components/ui/dialog/index.js'
	import * as AlertDialog from '$lib/components/ui/alert-dialog/index.js'
	import * as Avatar from '$lib/components/ui/avatar/index.js'
	import { Button } from '$lib/components/ui/button/index.js'
	import { Badge } from '$lib/components/ui/badge/index.js'
	import { Separator } from '$lib/components/ui/separator/index.js'
	import UserIcon from '@lucide/svelte/icons/user'
	import UsersIcon from '@lucide/svelte/icons/users'
	import PlusIcon from '@lucide/svelte/icons/plus'
	import TrashIcon from '@lucide/svelte/icons/trash-2'
	import CheckIcon from '@lucide/svelte/icons/check'
	import Loader2Icon from '@lucide/svelte/icons/loader-2'
	import FolderIcon from '@lucide/svelte/icons/folder'
	import { open as openDialog, message as showMessage, confirm } from '@tauri-apps/plugin-dialog'

	interface Props {
		open?: boolean
		onOpenChange?: (open: boolean) => void
	}

	let { open = $bindable(false), onOpenChange }: Props = $props()

	let switching = $state(false)
	let deleting = $state<string | null>(null)
	let deleteConfirmOpen = $state(false)
	let profileToDelete = $state<ProfileSummary | null>(null)

	const profiles = $derived(profilesStore.profiles)
	const loading = $derived(profilesStore.loading)

	function handleOpenChange(newOpen: boolean) {
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

	function getInitials(profile: ProfileSummary): string {
		if (profile.email) {
			return profile.email.substring(0, 2).toUpperCase()
		}
		return '?'
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
	<Dialog.Content class="sm:max-w-lg">
		<Dialog.Header>
			<Dialog.Title class="flex items-center gap-2">
				<UsersIcon class="size-5" />
				Switch Profile
			</Dialog.Title>
			<Dialog.Description>
				Switch between different BioVault identities without re-authenticating.
			</Dialog.Description>
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
						<button
							type="button"
							class="w-full flex items-center gap-3 p-3 rounded-lg border transition-colors hover:bg-muted/50 {profile.is_current
								? 'border-primary bg-primary/5'
								: 'border-border'}"
							onclick={() => handleSwitch(profile)}
							disabled={profile.is_current || switching}
						>
							<Avatar.Root class="size-10">
								<Avatar.Fallback>{getInitials(profile)}</Avatar.Fallback>
							</Avatar.Root>

							<div class="flex-1 text-left min-w-0">
								<div class="font-medium truncate">
									{profile.email || '(Not set up)'}
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

							{#if !profile.is_current && !profile.running}
								<Button
									variant="ghost"
									size="icon"
									class="shrink-0 text-destructive hover:text-destructive hover:bg-destructive/10"
									onclick={(e) => {
										e.stopPropagation()
										confirmDelete(profile)
									}}
									disabled={deleting === profile.id}
								>
									{#if deleting === profile.id}
										<Loader2Icon class="size-4 animate-spin" />
									{:else}
										<TrashIcon class="size-4" />
									{/if}
								</Button>
							{/if}
						</button>
					{/each}
				</div>
			{/if}
		</div>

		<Separator />

		<Dialog.Footer class="sm:justify-between">
			<Button variant="outline" onclick={handleAddProfile} disabled={switching}>
				<PlusIcon class="size-4" />
				Add Profile
			</Button>
			<Button variant="ghost" onclick={() => handleOpenChange(false)}>Close</Button>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>

<AlertDialog.Root bind:open={deleteConfirmOpen}>
	<AlertDialog.Content>
		<AlertDialog.Header>
			<AlertDialog.Title>Delete Profile?</AlertDialog.Title>
			<AlertDialog.Description>
				This will remove the profile "{profileToDelete?.email || 'Unknown'}" and delete its home
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
