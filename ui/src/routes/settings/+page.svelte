<script lang="ts">
	import { invoke } from '@tauri-apps/api/core'
	import { onMount } from 'svelte'
	import PageHeader from '$lib/components/page-header.svelte'
	import * as Card from '$lib/components/ui/card/index.js'
	import * as Dialog from '$lib/components/ui/dialog/index.js'
	import * as AlertDialog from '$lib/components/ui/alert-dialog/index.js'
	import { Button } from '$lib/components/ui/button/index.js'
	import { Input } from '$lib/components/ui/input/index.js'
	import { Label } from '$lib/components/ui/label/index.js'
	import UserIcon from '@lucide/svelte/icons/user'
	import MailIcon from '@lucide/svelte/icons/mail'
	import FolderIcon from '@lucide/svelte/icons/folder'
	import ServerIcon from '@lucide/svelte/icons/server'
	import ShieldIcon from '@lucide/svelte/icons/shield'
	import KeyIcon from '@lucide/svelte/icons/key'
	import CopyIcon from '@lucide/svelte/icons/copy'
	import CheckIcon from '@lucide/svelte/icons/check'
	import RefreshCwIcon from '@lucide/svelte/icons/refresh-cw'
	import DownloadIcon from '@lucide/svelte/icons/download'
	import Loader2Icon from '@lucide/svelte/icons/loader-2'
	import { toast } from 'svelte-sonner'

	interface Settings {
		email: string
		biovault_path: string
		syftbox_server_url: string
		docker_path: string
		java_path: string
		syftbox_path: string
	}

	interface KeyStatus {
		identity: string
		exists: boolean
		vault_fingerprint?: string
		bundle_path?: string
	}

	interface KeyOperationResult {
		identity: string
		fingerprint: string
		vault_path: string
		bundle_path: string
		export_path: string
		mnemonic?: string
	}

	interface RepublishResult {
		identity: string
		fingerprint: string
		export_path: string
		vault_matches_export: boolean
	}

	let settings: Settings | null = $state(null)
	let keyStatus: KeyStatus | null = $state(null)
	let loading = $state(true)
	let error: string | null = $state(null)

	// Key management state
	let showRestoreDialog = $state(false)
	let showRegenerateConfirm = $state(false)
	let restoreMnemonic = $state('')
	let restoring = $state(false)
	let regenerating = $state(false)
	let republishing = $state(false)
	let newRecoveryPhrase = $state<string | null>(null)
	let showNewRecoveryDialog = $state(false)
	let copied = $state(false)

	async function loadKeyStatus() {
		if (!settings?.email) return
		try {
			keyStatus = await invoke<KeyStatus>('key_get_status', { email: settings.email })
		} catch (e) {
			console.error('Failed to load key status:', e)
		}
	}

	onMount(async () => {
		try {
			settings = await invoke<Settings>('get_settings')
			await loadKeyStatus()
		} catch (e) {
			error = e instanceof Error ? e.message : String(e)
		} finally {
			loading = false
		}
	})

	async function handleRestore() {
		if (!restoreMnemonic.trim() || !settings?.email) return

		restoring = true
		try {
			await invoke<KeyOperationResult>('key_restore', {
				email: settings.email,
				mnemonic: restoreMnemonic.trim()
			})
			toast.success('Key restored successfully')
			showRestoreDialog = false
			restoreMnemonic = ''
			await loadKeyStatus()
		} catch (e) {
			toast.error('Failed to restore key', {
				description: e instanceof Error ? e.message : String(e)
			})
		} finally {
			restoring = false
		}
	}

	async function handleRegenerate() {
		if (!settings?.email) return

		regenerating = true
		try {
			const result = await invoke<KeyOperationResult>('key_generate', {
				email: settings.email,
				force: true
			})
			showRegenerateConfirm = false
			await loadKeyStatus()

			if (result.mnemonic) {
				newRecoveryPhrase = result.mnemonic
				showNewRecoveryDialog = true
			} else {
				toast.success('Key regenerated successfully')
			}
		} catch (e) {
			toast.error('Failed to regenerate key', {
				description: e instanceof Error ? e.message : String(e)
			})
		} finally {
			regenerating = false
		}
	}

	async function copyFingerprint() {
		if (keyStatus?.vault_fingerprint) {
			await navigator.clipboard.writeText(keyStatus.vault_fingerprint)
			copied = true
			toast.success('Fingerprint copied to clipboard')
			setTimeout(() => {
				copied = false
			}, 2000)
		}
	}

	async function copyRecoveryPhrase() {
		if (newRecoveryPhrase) {
			await navigator.clipboard.writeText(newRecoveryPhrase)
			toast.success('Recovery phrase copied to clipboard')
		}
	}

	async function handleRepublishDid() {
		if (!settings?.email) return
		republishing = true
		try {
			const result = await invoke<RepublishResult>('key_republish', {
				email: settings.email
			})
			toast.success('DID republished successfully', {
				description: `Fingerprint: ${result.fingerprint}`
			})
			await loadKeyStatus()
		} catch (e) {
			toast.error('Failed to republish DID', {
				description: e instanceof Error ? e.message : String(e)
			})
		} finally {
			republishing = false
		}
	}
</script>

<div class="flex h-full flex-col">
	<PageHeader title="Settings" description="Configure your BioVault preferences" />

	<div class="flex-1 overflow-auto p-6">
		<div class="mx-auto max-w-2xl space-y-6">

	{#if loading}
		<div class="text-muted-foreground">Loading settings...</div>
	{:else if error}
		<Card.Root class="border-destructive">
			<Card.Header>
				<Card.Title class="text-destructive">Error</Card.Title>
			</Card.Header>
			<Card.Content>
				<p>{error}</p>
			</Card.Content>
		</Card.Root>
	{:else if settings}
		<Card.Root>
			<Card.Header>
				<Card.Title class="flex items-center gap-2">
					<UserIcon class="size-5" />
					Identity
				</Card.Title>
				<Card.Description>Your BioVault identity and account information</Card.Description>
			</Card.Header>
			<Card.Content class="space-y-4">
				<div class="flex items-center gap-3">
					<MailIcon class="text-muted-foreground size-4" />
					<div>
						<div class="text-muted-foreground text-sm">Email</div>
						<div class="font-medium">{settings.email || 'Not configured'}</div>
					</div>
				</div>
			</Card.Content>
		</Card.Root>

		<Card.Root>
			<Card.Header>
				<Card.Title class="flex items-center gap-2">
					<FolderIcon class="size-5" />
					Paths
				</Card.Title>
				<Card.Description>File system paths and locations</Card.Description>
			</Card.Header>
			<Card.Content class="space-y-4">
				<div>
					<div class="text-muted-foreground text-sm">BioVault Home</div>
					<div class="font-mono text-sm">{settings.biovault_path || 'Not set'}</div>
				</div>
			</Card.Content>
		</Card.Root>

		<Card.Root>
			<Card.Header>
				<Card.Title class="flex items-center gap-2">
					<ServerIcon class="size-5" />
					Server
				</Card.Title>
				<Card.Description>SyftBox server configuration</Card.Description>
			</Card.Header>
			<Card.Content class="space-y-4">
				<div>
					<div class="text-muted-foreground text-sm">SyftBox Server URL</div>
					<div class="font-mono text-sm">{settings.syftbox_server_url || 'Default'}</div>
				</div>
			</Card.Content>
		</Card.Root>

		<Card.Root>
			<Card.Header>
				<Card.Title class="flex items-center gap-2">
					<ShieldIcon class="size-5" />
					Security
				</Card.Title>
				<Card.Description>Encryption keys and recovery options</Card.Description>
			</Card.Header>
			<Card.Content class="space-y-4">
				{#if keyStatus?.exists}
					<div class="flex items-start justify-between gap-4">
						<div class="flex-1 min-w-0">
							<div class="text-muted-foreground text-sm">Key Fingerprint</div>
							<div class="font-mono text-sm truncate" title={keyStatus.vault_fingerprint}>
								{keyStatus.vault_fingerprint || 'Unknown'}
							</div>
						</div>
						<Button variant="ghost" size="icon" onclick={copyFingerprint}>
							{#if copied}
								<CheckIcon class="size-4 text-emerald-500" />
							{:else}
								<CopyIcon class="size-4" />
							{/if}
						</Button>
					</div>

					<div class="flex gap-2 pt-2">
						<Button variant="outline" size="sm" onclick={() => (showRestoreDialog = true)}>
							<DownloadIcon class="size-4" />
							Restore from Backup
						</Button>
						<Button variant="outline" size="sm" onclick={() => (showRegenerateConfirm = true)}>
							<RefreshCwIcon class="size-4" />
							Regenerate Key
						</Button>
						<Button variant="outline" size="sm" onclick={handleRepublishDid} disabled={republishing}>
							{#if republishing}
								<Loader2Icon class="size-4 animate-spin" />
								Republishing...
							{:else}
								<RefreshCwIcon class="size-4" />
								Republish DID
							{/if}
						</Button>
					</div>
				{:else}
					<div class="text-muted-foreground text-sm">
						No encryption key found. Sign in to SyftBox to generate one.
					</div>
				{/if}
			</Card.Content>
		</Card.Root>
	{/if}
		</div>
	</div>
</div>

<!-- Restore Key Dialog -->
<Dialog.Root bind:open={showRestoreDialog}>
	<Dialog.Content class="sm:max-w-md">
		<Dialog.Header>
			<Dialog.Title class="flex items-center gap-2">
				<KeyIcon class="size-5" />
				Restore Key from Backup
			</Dialog.Title>
			<Dialog.Description>
				Enter your recovery phrase to restore your encryption key.
			</Dialog.Description>
		</Dialog.Header>

		<div class="space-y-4 py-4">
			<div class="space-y-2">
				<Label for="mnemonic">Recovery Phrase</Label>
				<Input
					id="mnemonic"
					type="text"
					placeholder="Enter your recovery phrase..."
					bind:value={restoreMnemonic}
					disabled={restoring}
				/>
			</div>
		</div>

		<Dialog.Footer>
			<Button variant="outline" onclick={() => (showRestoreDialog = false)} disabled={restoring}>
				Cancel
			</Button>
			<Button onclick={handleRestore} disabled={restoring || !restoreMnemonic.trim()}>
				{#if restoring}
					<Loader2Icon class="size-4 animate-spin" />
					Restoring...
				{:else}
					Restore Key
				{/if}
			</Button>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>

<!-- Regenerate Confirmation -->
<AlertDialog.Root bind:open={showRegenerateConfirm}>
	<AlertDialog.Content>
		<AlertDialog.Header>
			<AlertDialog.Title>Regenerate Encryption Key?</AlertDialog.Title>
			<AlertDialog.Description>
				This will create a new encryption key and invalidate your old one. Make sure you have backed
				up any data encrypted with your current key. This action cannot be undone.
			</AlertDialog.Description>
		</AlertDialog.Header>
		<AlertDialog.Footer>
			<AlertDialog.Cancel disabled={regenerating}>Cancel</AlertDialog.Cancel>
			<AlertDialog.Action
				onclick={handleRegenerate}
				disabled={regenerating}
				class="bg-destructive text-destructive-foreground hover:bg-destructive/90"
			>
				{#if regenerating}
					Regenerating...
				{:else}
					Regenerate Key
				{/if}
			</AlertDialog.Action>
		</AlertDialog.Footer>
	</AlertDialog.Content>
</AlertDialog.Root>

<!-- New Recovery Phrase Dialog -->
<Dialog.Root bind:open={showNewRecoveryDialog}>
	<Dialog.Content class="sm:max-w-md">
		<Dialog.Header>
			<Dialog.Title class="flex items-center gap-2">
				<ShieldIcon class="size-5" />
				New Recovery Phrase
			</Dialog.Title>
			<Dialog.Description>
				Your new encryption key has been generated. Save this recovery phrase - you won't see it
				again.
			</Dialog.Description>
		</Dialog.Header>

		<div class="space-y-4 py-4">
			<div class="relative">
				<div
					class="bg-muted rounded-lg p-4 font-mono text-sm break-all select-all border-2 border-amber-500/50"
				>
					{newRecoveryPhrase}
				</div>
				<Button variant="outline" size="sm" class="absolute top-2 right-2" onclick={copyRecoveryPhrase}>
					<CopyIcon class="size-4" />
				</Button>
			</div>

			<div
				class="bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800 rounded-lg p-3"
			>
				<p class="text-sm text-amber-800 dark:text-amber-200">
					<strong>Important:</strong> Write this down or save it in a password manager. This is the
					only way to recover your encryption key.
				</p>
			</div>
		</div>

		<Dialog.Footer>
			<Button onclick={() => (showNewRecoveryDialog = false)}>I've Saved It</Button>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>
