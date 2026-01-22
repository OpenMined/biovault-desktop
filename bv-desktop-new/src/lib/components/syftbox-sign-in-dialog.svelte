<script lang="ts">
	import { invoke } from '@tauri-apps/api/core'
	import { syftboxAuthStore } from '$lib/stores/syftbox-auth.svelte'
	import * as Dialog from '$lib/components/ui/dialog/index.js'
	import * as InputOTP from '$lib/components/ui/input-otp/index.js'
	import { Button } from '$lib/components/ui/button/index.js'
	import { Input } from '$lib/components/ui/input/index.js'
	import { Label } from '$lib/components/ui/label/index.js'
	import MailIcon from '@lucide/svelte/icons/mail'
	import KeyIcon from '@lucide/svelte/icons/key'
	import Loader2Icon from '@lucide/svelte/icons/loader-2'
	import CheckCircleIcon from '@lucide/svelte/icons/check-circle'
	import ArrowLeftIcon from '@lucide/svelte/icons/arrow-left'
	import ExternalLinkIcon from '@lucide/svelte/icons/external-link'

	async function openUrl(url: string) {
		try {
			await invoke('open_url', { url })
		} catch {
			window.open(url, '_blank')
		}
	}

	interface Props {
		open?: boolean
		onOpenChange?: (open: boolean) => void
	}

	let { open = $bindable(false), onOpenChange }: Props = $props()

	type Step = 'email' | 'otp' | 'success'

	let step = $state<Step>('email')
	let email = $state('')
	let otp = $state('')
	let loading = $state(false)
	let error = $state<string | null>(null)

	function handleOpenChange(newOpen: boolean) {
		open = newOpen
		onOpenChange?.(newOpen)
		if (!newOpen) {
			// Reset state when dialog closes
			setTimeout(() => {
				step = 'email'
				email = ''
				otp = ''
				error = null
			}, 200)
		}
	}

	async function handleRequestOtp() {
		if (!email.trim() || !email.includes('@')) {
			error = 'Please enter a valid email address'
			return
		}

		loading = true
		error = null

		try {
			await syftboxAuthStore.requestOtp(email.trim())
			step = 'otp'
		} catch (e) {
			error = e instanceof Error ? e.message : 'Failed to send verification code'
		} finally {
			loading = false
		}
	}

	async function handleSubmitOtp() {
		if (otp.length !== 8) {
			error = 'Please enter the 8-digit code'
			return
		}

		loading = true
		error = null

		try {
			await syftboxAuthStore.submitOtp(email.trim(), otp)
			step = 'success'
			// Auto-close after success
			setTimeout(() => {
				handleOpenChange(false)
			}, 1500)
		} catch (e) {
			error = e instanceof Error ? e.message : 'Invalid verification code'
			otp = ''
		} finally {
			loading = false
		}
	}

	function handleBack() {
		step = 'email'
		otp = ''
		error = null
	}

	function handleKeydown(e: KeyboardEvent) {
		if (e.key === 'Enter' && !loading) {
			if (step === 'email') {
				handleRequestOtp()
			}
		}
	}
</script>

<Dialog.Root bind:open onOpenChange={handleOpenChange}>
	<Dialog.Content class="sm:max-w-md">
		{#if step === 'email'}
			<Dialog.Header>
				<Dialog.Title class="flex items-center gap-2">
					<MailIcon class="size-5" />
					Connect to SyftBox
				</Dialog.Title>
				<Dialog.Description>
					Enter your email to receive a verification code and access network features.
				</Dialog.Description>
			</Dialog.Header>

			<div class="space-y-4 py-4">
				<div class="space-y-2">
					<Label for="email">Email address</Label>
					<Input
						id="email"
						type="email"
						placeholder="you@example.com"
						bind:value={email}
						onkeydown={handleKeydown}
						disabled={loading}
					/>
				</div>

				{#if error}
					<p class="text-sm text-destructive">{error}</p>
				{/if}
			</div>

			<Dialog.Footer class="sm:justify-between">
				<button
					type="button"
					class="text-xs text-muted-foreground hover:text-foreground flex items-center gap-1 transition-colors"
					onclick={() => openUrl('https://www.syftbox.net/')}
				>
					What is SyftBox?
					<ExternalLinkIcon class="size-3" />
				</button>
				<div class="flex gap-2">
					<Button variant="outline" onclick={() => handleOpenChange(false)}>Cancel</Button>
					<Button onclick={handleRequestOtp} disabled={loading || !email.trim()}>
						{#if loading}
							<Loader2Icon class="size-4 animate-spin" />
							Sending...
						{:else}
							Send Code
						{/if}
					</Button>
				</div>
			</Dialog.Footer>
		{:else if step === 'otp'}
			<Dialog.Header>
				<Dialog.Title class="flex items-center gap-2">
					<KeyIcon class="size-5" />
					Enter Verification Code
				</Dialog.Title>
				<Dialog.Description>
					We sent an 8-digit code to <strong>{email}</strong>. Check your inbox and enter it below.
				</Dialog.Description>
			</Dialog.Header>

			<div class="space-y-4 py-6">
				<div class="flex justify-center">
					<InputOTP.Root maxlength={8} bind:value={otp} disabled={loading}>
						{#snippet children({ cells })}
							<InputOTP.Group>
								{#each cells.slice(0, 4) as cell (cell)}
									<InputOTP.Slot {cell} />
								{/each}
							</InputOTP.Group>
							<InputOTP.Separator />
							<InputOTP.Group>
								{#each cells.slice(4, 8) as cell (cell)}
									<InputOTP.Slot {cell} />
								{/each}
							</InputOTP.Group>
						{/snippet}
					</InputOTP.Root>
				</div>

				{#if error}
					<p class="text-sm text-destructive text-center">{error}</p>
				{/if}

				<p class="text-xs text-muted-foreground text-center">
					Didn't receive the code?
					<button
						type="button"
						class="text-primary hover:underline"
						onclick={handleRequestOtp}
						disabled={loading}
					>
						Resend
					</button>
				</p>
			</div>

			<Dialog.Footer class="sm:justify-between">
				<Button variant="ghost" size="sm" onclick={handleBack} disabled={loading}>
					<ArrowLeftIcon class="size-4" />
					Back
				</Button>
				<Button onclick={handleSubmitOtp} disabled={loading || otp.length !== 8}>
					{#if loading}
						<Loader2Icon class="size-4 animate-spin" />
						Verifying...
					{:else}
						Verify
					{/if}
				</Button>
			</Dialog.Footer>
		{:else if step === 'success'}
			<div class="flex flex-col items-center justify-center py-8 gap-4">
				<div class="size-16 rounded-full bg-emerald-100 flex items-center justify-center">
					<CheckCircleIcon class="size-8 text-emerald-600" />
				</div>
				<div class="text-center">
					<h3 class="font-semibold text-lg">You're signed in!</h3>
					<p class="text-sm text-muted-foreground mt-1">
						Welcome to SyftBox, {email.split('@')[0]}
					</p>
				</div>
			</div>
		{/if}
	</Dialog.Content>
</Dialog.Root>
