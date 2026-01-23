<script lang="ts">
	import { invoke } from '@tauri-apps/api/core'
	import * as Dialog from '$lib/components/ui/dialog/index.js'
	import { Button } from '$lib/components/ui/button/index.js'
	import { Input } from '$lib/components/ui/input/index.js'
	import { profilesStore } from '$lib/stores/profiles.svelte'
	import UserPlusIcon from '@lucide/svelte/icons/user-plus'
	import CopyIcon from '@lucide/svelte/icons/copy'
	import CheckIcon from '@lucide/svelte/icons/check'
	import MailIcon from '@lucide/svelte/icons/mail'
	import MessageCircleIcon from '@lucide/svelte/icons/message-circle'

	interface Props {
		open?: boolean
		onOpenChange?: (open: boolean) => void
	}

	let { open = $bindable(false), onOpenChange }: Props = $props()

	let inviteUrl = $state('')
	let copied = $state(false)
	let loading = $state(false)

	async function generateInviteUrl() {
		loading = true
		try {
			const profile = profilesStore.currentProfile
			const email = profile?.email || ''
			let fingerprint = profile?.fingerprint || ''

			// If no fingerprint from profile, try getting from key status
			if (!fingerprint) {
				try {
					const keyStatus = await invoke<{
						vault_fingerprint?: string
						export_fingerprint?: string
					}>('key_get_status')
					fingerprint = keyStatus?.vault_fingerprint || keyStatus?.export_fingerprint || ''
				} catch (e) {
					console.warn('Could not get key fingerprint for invite:', e)
				}
			}

			const params = new URLSearchParams({
				from: email,
				fp: fingerprint,
				type: 'session'
			})
			inviteUrl = `https://app.biovault.net/invite?${params.toString()}`
		} catch (e) {
			console.error('Failed to generate invite URL:', e)
			inviteUrl = 'https://app.biovault.net/invite'
		} finally {
			loading = false
		}
	}

	// Generate invite URL when dialog opens
	$effect(() => {
		if (open) {
			generateInviteUrl()
			copied = false
		}
	})

	function handleOpenChange(newOpen: boolean) {
		open = newOpen
		onOpenChange?.(newOpen)
	}

	async function copyToClipboard() {
		try {
			await navigator.clipboard.writeText(inviteUrl)
			copied = true
			setTimeout(() => (copied = false), 2000)
		} catch (e) {
			// Fallback: select input text
			const input = document.querySelector<HTMLInputElement>('#invite-url-input')
			if (input) {
				input.select()
				document.execCommand('copy')
				copied = true
				setTimeout(() => (copied = false), 2000)
			}
		}
	}

	async function openUrl(url: string) {
		try {
			await invoke('open_url', { url })
		} catch {
			window.open(url, '_blank')
		}
	}

	async function getInviteMessage() {
		return `Hi!\n\nI'd like to invite you to an end-to-end encrypted collaborative session on BioVault - a platform for private data analysis.\n\nGet started here:\n${inviteUrl}\n\nLearn more:\n- https://biovault.net\n- https://openmined.org\n\nLooking forward to working together!`
	}

	async function shareVia(provider: 'gmail' | 'outlook' | 'email' | 'whatsapp') {
		const subject = encodeURIComponent('Join me on BioVault!')
		const body = encodeURIComponent(await getInviteMessage())
		const message = encodeURIComponent(await getInviteMessage())

		const urls: Record<string, string> = {
			gmail: `https://mail.google.com/mail/?view=cm&fs=1&su=${subject}&body=${body}`,
			outlook: `https://outlook.live.com/mail/0/deeplink/compose?subject=${subject}&body=${body}`,
			email: `mailto:?subject=${subject}&body=${body}`,
			whatsapp: `https://wa.me/?text=${message}`
		}

		if (urls[provider]) {
			await openUrl(urls[provider])
		}
	}
</script>

<Dialog.Root bind:open onOpenChange={handleOpenChange}>
	<Dialog.Content class="sm:max-w-[440px]">
		<Dialog.Header>
			<div class="flex items-center gap-3">
				<div class="flex size-10 items-center justify-center rounded-lg bg-primary/10">
					<UserPlusIcon class="size-5 text-primary" />
				</div>
				<div>
					<Dialog.Title>Invite to BioVault</Dialog.Title>
					<Dialog.Description>Share this link to invite someone to collaborate.</Dialog.Description>
				</div>
			</div>
		</Dialog.Header>

		<div class="space-y-4 py-4">
			<!-- Invite URL -->
			<div class="space-y-2">
				<label for="invite-url-input" class="text-sm font-medium">Invite Link</label>
				<div class="flex gap-2">
					<Input
						id="invite-url-input"
						value={inviteUrl}
						readonly
						class="flex-1 font-mono text-xs"
						onclick={(e) => (e.target as HTMLInputElement).select()}
					/>
					<Button variant="outline" size="icon" onclick={copyToClipboard} disabled={loading}>
						{#if copied}
							<CheckIcon class="size-4 text-green-500" />
						{:else}
							<CopyIcon class="size-4" />
						{/if}
					</Button>
				</div>
				{#if copied}
					<p class="text-xs text-green-600">Copied to clipboard!</p>
				{/if}
			</div>

			<!-- Share via options -->
			<div class="space-y-2">
				<p class="text-sm font-medium">Or share via</p>
				<div class="grid grid-cols-4 gap-2">
					<Button
						variant="outline"
						class="flex h-auto flex-col gap-1 py-3"
						onclick={() => shareVia('gmail')}
					>
						<MailIcon class="size-5" />
						<span class="text-xs">Gmail</span>
					</Button>
					<Button
						variant="outline"
						class="flex h-auto flex-col gap-1 py-3"
						onclick={() => shareVia('outlook')}
					>
						<MailIcon class="size-5" />
						<span class="text-xs">Outlook</span>
					</Button>
					<Button
						variant="outline"
						class="flex h-auto flex-col gap-1 py-3"
						onclick={() => shareVia('email')}
					>
						<MailIcon class="size-5" />
						<span class="text-xs">Email</span>
					</Button>
					<Button
						variant="outline"
						class="flex h-auto flex-col gap-1 py-3"
						onclick={() => shareVia('whatsapp')}
					>
						<MessageCircleIcon class="size-5" />
						<span class="text-xs">WhatsApp</span>
					</Button>
				</div>
			</div>
		</div>

		<Dialog.Footer>
			<Button variant="outline" onclick={() => (open = false)}>Close</Button>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>
