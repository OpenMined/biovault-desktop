<script lang="ts">
	import { invoke } from '@tauri-apps/api/core'
	import { onMount } from 'svelte'
	import PageHeader from '$lib/components/page-header.svelte'
	import * as Card from '$lib/components/ui/card/index.js'
	import UserIcon from '@lucide/svelte/icons/user'
	import MailIcon from '@lucide/svelte/icons/mail'
	import FolderIcon from '@lucide/svelte/icons/folder'
	import ServerIcon from '@lucide/svelte/icons/server'

	interface Settings {
		email: string
		biovault_path: string
		syftbox_server_url: string
		docker_path: string
		java_path: string
		syftbox_path: string
	}

	let settings: Settings | null = $state(null)
	let loading = $state(true)
	let error: string | null = $state(null)

	onMount(async () => {
		try {
			settings = await invoke<Settings>('get_settings')
		} catch (e) {
			error = e instanceof Error ? e.message : String(e)
		} finally {
			loading = false
		}
	})
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
	{/if}
		</div>
	</div>
</div>
