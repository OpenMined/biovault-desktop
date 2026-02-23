<script lang="ts">
	import { invoke } from '@tauri-apps/api/core'
	import { syftboxAuthStore } from '$lib/stores/syftbox-auth.svelte'
	import { profilesStore } from '$lib/stores/profiles.svelte'
	import * as Dialog from '$lib/components/ui/dialog/index.js'
	import * as InputOTP from '$lib/components/ui/input-otp/index.js'
	import { Button } from '$lib/components/ui/button/index.js'
	import { Input } from '$lib/components/ui/input/index.js'
	import { Label } from '$lib/components/ui/label/index.js'
	import { Checkbox } from '$lib/components/ui/checkbox/index.js'
	import MailIcon from '@lucide/svelte/icons/mail'
	import KeyIcon from '@lucide/svelte/icons/key'
	import ShieldIcon from '@lucide/svelte/icons/shield'
	import Loader2Icon from '@lucide/svelte/icons/loader-2'
	import CheckCircleIcon from '@lucide/svelte/icons/check-circle'
	import ArrowLeftIcon from '@lucide/svelte/icons/arrow-left'
	import ExternalLinkIcon from '@lucide/svelte/icons/external-link'
	import CopyIcon from '@lucide/svelte/icons/copy'
	import CheckIcon from '@lucide/svelte/icons/check'
	import { toast } from 'svelte-sonner'

	async function openUrl(url: string) {
		try {
			await invoke('open_url', { url })
		} catch {
			window.open(url, '_blank')
		}
	}

	interface KeyOperationResult {
		identity: string
		fingerprint: string
		vault_path: string
		bundle_path: string
		export_path: string
		mnemonic?: string
	}

	interface Props {
		open?: boolean
		onOpenChange?: (open: boolean) => void
	}

	let { open = $bindable(false), onOpenChange }: Props = $props()

	type Step = 'email' | 'otp' | 'recovery' | 'success'

	let step = $state<Step>('email')
	let email = $state('')
	let otp = $state('')
	let loading = $state(false)
let error = $state<string | null>(null)
let recoveryPhrase = $state<string | null>(null)
let recoveryAcknowledged = $state(false)
let copied = $state(false)
let autoAttemptedForOpen = $state(false)
let otpRequested = $state(false)

function normalizedEmail(value: string): string {
	return value.trim().toLowerCase()
}

function normalizedOtp(value: string): string {
	return value.replace(/\D/g, '').trim()
}

async function loadKnownEmail(): Promise<string> {
	try {
		const settings = await invoke<{ email?: string }>('get_settings')
		const candidate = (
			settings?.email ||
				syftboxAuthStore.email ||
				profilesStore.currentProfile?.email ||
				''
			).trim()
			return candidate
		} catch {
			return (syftboxAuthStore.email || profilesStore.currentProfile?.email || '').trim()
		}
	}

async function maybeSkipToOtp() {
	const knownEmail = await loadKnownEmail()
	if (!knownEmail || !knownEmail.includes('@')) return
	email = normalizedEmail(knownEmail)
	step = 'otp'
	otp = ''
	error = null
	otpRequested = false
	try {
		await syftboxAuthStore.requestOtp(email)
		otpRequested = true
	} catch (e) {
		console.error('Auto request OTP failed:', e)
		error = e instanceof Error ? e.message : String(e)
	}
}

	function handleOpenChange(newOpen: boolean) {
		// Don't allow closing during recovery step without acknowledgment
		if (!newOpen && step === 'recovery' && !recoveryAcknowledged) {
			return
		}
		open = newOpen
		onOpenChange?.(newOpen)
		if (!newOpen) {
			// Reset state when dialog closes
			setTimeout(() => {
				step = 'email'
				email = ''
				otp = ''
				error = null
				otpRequested = false
				recoveryPhrase = null
				recoveryAcknowledged = false
				copied = false
			}, 200)
		}
	}

	$effect(() => {
		if (open && !autoAttemptedForOpen) {
			autoAttemptedForOpen = true
			step = 'email'
			otp = ''
			error = null
			otpRequested = false
			void maybeSkipToOtp()
		}
		if (!open) {
			autoAttemptedForOpen = false
		}
	})

async function handleRequestOtp() {
	email = normalizedEmail(email)
	if (!email || !email.includes('@')) {
		error = 'Please enter a valid email address'
		return
	}

		loading = true
		error = null

	try {
		await syftboxAuthStore.requestOtp(email)
		otpRequested = true
		
		if (!syftboxAuthStore.isAuthEnabled) {
				// Bypass OTP step in dev/test mode
				console.log('Auth disabled, performing instant bypass...')
				await syftboxAuthStore.submitOtp(email, '00000000')
				
				step = 'success'
				setTimeout(() => {
					handleOpenChange(false)
				}, 1500)
		} else {
			step = 'otp'
		}
		} catch (e) {
			console.error('handleRequestOtp error:', e)
			error = e instanceof Error ? e.message : String(e)
			// Special handling for lock errors to make them more user-friendly
			if (error.includes('lock') || error.includes('acquire')) {
				error = 'SyftBox is busy (lock error). Try again in a moment or check if SyftBox is already running.'
			}
		} finally {
			// Always clear request loading so OTP input is enabled after switching steps.
			loading = false
		}
	}

async function handleSubmitOtp() {
	const code = normalizedOtp(otp)
	otp = code
	email = normalizedEmail(email)
	if (code.length !== 8) {
		error = 'Please enter the 8-digit code'
		return
	}

	loading = true
	error = null

	try {
		await syftboxAuthStore.submitOtp(email, code)
		step = 'success'
		setTimeout(() => {
			handleOpenChange(false)
		}, 500)

		// Run key setup in background so Verify stays fast.
		void (async () => {
			try {
				const keyResult = await invoke<KeyOperationResult>('key_generate', {
					email,
					force: false
				})
				if (keyResult.mnemonic) {
					toast.info('Encryption key created', {
						description: 'Open Settings → Security to back up your recovery phrase.'
					})
				}
			} catch (keyError) {
				console.error('Background key generation error:', keyError)
			}
		})()
	} catch (e) {
		console.error('handleSubmitOtp error:', e)
		error = e instanceof Error ? e.message : 'Invalid verification code'
		otp = ''
	} finally {
		loading = false
	}
}

	async function handleCopyRecovery() {
		if (recoveryPhrase) {
			await navigator.clipboard.writeText(recoveryPhrase)
			copied = true
			toast.success('Recovery phrase copied to clipboard')
			setTimeout(() => {
				copied = false
			}, 2000)
		}
	}

	function handleRecoveryComplete() {
		if (!recoveryAcknowledged) {
			error = 'Please confirm you have saved your recovery phrase'
			return
		}
		step = 'success'
		setTimeout(() => {
			handleOpenChange(false)
		}, 1500)
	}

function handleBack() {
	step = 'email'
	otp = ''
	error = null
	otpRequested = false
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
				{#if !otpRequested && !loading}
					<p class="text-xs text-muted-foreground text-center">
						Code not sent yet. Click <strong>Resend</strong> to request a fresh code.
					</p>
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
				<Button onclick={handleSubmitOtp} disabled={loading || otp.length !== 8 || !otpRequested}>
					{#if loading}
						<Loader2Icon class="size-4 animate-spin" />
						Verifying...
					{:else}
						Verify
					{/if}
				</Button>
			</Dialog.Footer>
		{:else if step === 'recovery'}
			<Dialog.Header>
				<Dialog.Title class="flex items-center gap-2">
					<ShieldIcon class="size-5" />
					Save Your Recovery Phrase
				</Dialog.Title>
				<Dialog.Description>
					This is your only way to recover your encryption keys. Save it somewhere safe - you won't
					see it again.
				</Dialog.Description>
			</Dialog.Header>

			<div class="space-y-4 py-4">
				<div class="relative">
					<div
						class="bg-muted rounded-lg p-4 font-mono text-sm break-all select-all border-2 border-amber-500/50"
					>
						{recoveryPhrase}
					</div>
					<Button
						variant="outline"
						size="sm"
						class="absolute top-2 right-2"
						onclick={handleCopyRecovery}
					>
						{#if copied}
							<CheckIcon class="size-4 text-emerald-500" />
						{:else}
							<CopyIcon class="size-4" />
						{/if}
					</Button>
				</div>

				<div
					class="bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800 rounded-lg p-3"
				>
					<p class="text-sm text-amber-800 dark:text-amber-200">
						<strong>Important:</strong> Write this down or save it in a password manager. If you lose
						access to your device, this phrase is the only way to recover your encrypted data.
					</p>
				</div>

				<div class="flex items-start gap-3 pt-2">
					<Checkbox id="recovery-ack" bind:checked={recoveryAcknowledged} />
					<label for="recovery-ack" class="text-sm leading-tight cursor-pointer">
						I have saved my recovery phrase somewhere safe and understand I cannot recover my data
						without it.
					</label>
				</div>

				{#if error}
					<p class="text-sm text-destructive">{error}</p>
				{/if}
			</div>

			<Dialog.Footer>
				<Button onclick={handleRecoveryComplete} disabled={!recoveryAcknowledged}>Continue</Button>
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
