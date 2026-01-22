<script lang="ts">
	import { invoke } from '@tauri-apps/api/core'
	import { onMount } from 'svelte'
	import { syftboxAuthStore } from '$lib/stores/syftbox-auth.svelte'
	import PageHeader from '$lib/components/page-header.svelte'
	import SyftboxSignInDialog from '$lib/components/syftbox-sign-in-dialog.svelte'
	import * as Empty from '$lib/components/ui/empty/index.js'
	import { Button } from '$lib/components/ui/button/index.js'
	import CompassIcon from '@lucide/svelte/icons/compass'
	import LogInIcon from '@lucide/svelte/icons/log-in'
	import ExternalLinkIcon from '@lucide/svelte/icons/external-link'
	import Loader2Icon from '@lucide/svelte/icons/loader-2'

	async function openUrl(url: string) {
		try {
			await invoke('open_url', { url })
		} catch {
			window.open(url, '_blank')
		}
	}

	let loading = $state(true)
	let signInDialogOpen = $state(false)
	const isAuthenticated = $derived(syftboxAuthStore.isAuthenticated)
	const isCheckingAuth = $derived(syftboxAuthStore.isChecking)

	onMount(async () => {
		await syftboxAuthStore.checkAuth()
		loading = false
	})
</script>

<div class="flex h-full flex-col">
	<PageHeader title="Explore" description="Discover flows and datasets from the community" />

	{#if loading || isCheckingAuth}
		<div class="flex h-full items-center justify-center">
			<Loader2Icon class="size-8 animate-spin text-muted-foreground" />
		</div>
	{:else if !isAuthenticated}
		<div class="flex h-full items-center justify-center p-6">
			<Empty.Root>
				<Empty.Header>
					<Empty.Media variant="icon">
						<LogInIcon class="size-6" />
					</Empty.Media>
					<Empty.Title>Connect to SyftBox</Empty.Title>
					<Empty.Description>
						Connect to SyftBox to discover and explore flows from the community.
					</Empty.Description>
				</Empty.Header>
				<Empty.Content>
					<Button onclick={() => (signInDialogOpen = true)}>
						<LogInIcon class="size-4" />
						Connect to SyftBox
					</Button>
				</Empty.Content>
				<div class="mt-6 pt-6 border-t max-w-sm text-center">
					<p class="text-xs font-medium text-muted-foreground mb-1">What is SyftBox?</p>
					<p class="text-xs text-muted-foreground mb-3">
						An open-source network for privacy-first, offline-capable AI. Build apps, run federated learning, and advance PETs research.
					</p>
					<button
						type="button"
						class="text-xs text-primary hover:underline inline-flex items-center gap-1"
						onclick={() => openUrl('https://www.syftbox.net/')}
					>
						Learn more at syftbox.net
						<ExternalLinkIcon class="size-3" />
					</button>
				</div>
			</Empty.Root>
		</div>
	{:else}
		<div class="flex h-full items-center justify-center p-6">
			<Empty.Root>
				<Empty.Header>
					<Empty.Media variant="icon">
						<CompassIcon class="size-6" />
					</Empty.Media>
					<Empty.Title>Coming Soon</Empty.Title>
					<Empty.Description>
						Explore community flows and datasets here.
					</Empty.Description>
				</Empty.Header>
			</Empty.Root>
		</div>
	{/if}
</div>

<SyftboxSignInDialog bind:open={signInDialogOpen} />
