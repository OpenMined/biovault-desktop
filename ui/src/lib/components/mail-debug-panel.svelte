<script lang="ts">
	import { onMount } from 'svelte'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { Button } from '$lib/components/ui/button/index.js'
import { Badge } from '$lib/components/ui/badge/index.js'
import { toast } from 'svelte-sonner'
import RefreshCwIcon from '@lucide/svelte/icons/refresh-cw'
import MailWarningIcon from '@lucide/svelte/icons/mail-warning'
import InboxIcon from '@lucide/svelte/icons/inbox'
import TrashIcon from '@lucide/svelte/icons/trash-2'
import KeyRoundIcon from '@lucide/svelte/icons/key-round'

	interface MessageThreadSummary {
		thread_id: string
		subject: string
		participants: string[]
		unread_count: number
		last_message_at?: string
		last_message_preview: string
	}

	interface FailedMessageInfo {
		id: string
		sender_identity: string
		failure_reason: string
		failure_reason_display: string
		error_details: string
		suggested_action: string
		created_at: string
		dismissed: boolean
	}

	interface FailedMessagesResult {
		failed_messages: FailedMessageInfo[]
		count: number
	}

	interface RefreshMessagesBatchedResult {
		new_message_ids: string[]
		new_messages: number
		new_failed: number
		total_failed: number
		threads: MessageThreadSummary[]
	}

	interface KeyOperationResult {
		identity: string
		fingerprint: string
		vault_path: string
		bundle_path: string
		export_path: string
		mnemonic?: string
	}

	interface KeyStatusInfo {
		identity: string
		vault_path: string
		key_path: string
		vault_fingerprint?: string
		key_file_exists: boolean
		private_key_readable: boolean
		exists: boolean
	}

	interface ProfileSummary {
		is_current: boolean
		biovault_home: string
	}

	interface ProfilesBootState {
		profiles: ProfileSummary[]
	}

	let loading = $state(false)
	let error = $state<string | null>(null)
	let threads = $state<MessageThreadSummary[]>([])
	let failed = $state<FailedMessageInfo[]>([])
	let newMessages = $state(0)
	let newFailed = $state(0)
	let totalFailed = $state(0)
	let lastUpdated = $state<string | null>(null)
	let importLoadingById = $state<Record<string, boolean>>({})
	let keyLoadingById = $state<Record<string, boolean>>({})
	let keyStatus = $state<KeyStatusInfo | null>(null)
	let currentBiovaultHome = $state<string | null>(null)

	const unreadTotal = $derived(threads.reduce((sum, t) => sum + (t.unread_count || 0), 0))
	const topThreads = $derived(threads.slice(0, 8))
	const topFailed = $derived(failed.slice(0, 8))
	const failedRoots = $derived(
		Array.from(
			new Set(
				failed
					.map((msg) => extractRootFromFailedMessage(msg.error_details))
					.filter((value): value is string => !!value),
			),
		),
	)
	const crossRootFailedCount = $derived(
		failed.filter((msg) => isCrossRootFailure(msg.error_details)).length,
	)

	function normalizePath(path: string): string {
		return path.replace(/\/+$/, '')
	}

	function extractRootFromFailedMessage(errorDetails: string): string | null {
		if (!errorDetails) return null
		const pathMatch =
			errorDetails.match(/from:\s*"([^"]+)"/i) ||
			errorDetails.match(/"([^"]+\.request)"/i)
		const requestPath = pathMatch?.[1]
		if (!requestPath) return null

		const datasitesMarker = '/datasites/'
		const idx = requestPath.indexOf(datasitesMarker)
		if (idx <= 0) return null
		return normalizePath(requestPath.slice(0, idx))
	}

	function isCrossRootFailure(errorDetails: string): boolean {
		const root = extractRootFromFailedMessage(errorDetails)
		if (!root) return false
		if (!currentBiovaultHome) return failedRoots.length > 1
		return normalizePath(root) !== normalizePath(currentBiovaultHome)
	}

	async function resolveCurrentBiovaultHome() {
		try {
			const state = await invoke<ProfilesBootState>('profiles_get_boot_state')
			const current = state?.profiles?.find((profile) => profile.is_current)
			if (current?.biovault_home?.trim()) {
				currentBiovaultHome = normalizePath(current.biovault_home.trim())
				return
			}
		} catch {
			// Ignore and try fallback below.
		}

		if (keyStatus?.vault_path?.trim()) {
			const fallback = keyStatus.vault_path.trim().replace(/\/\.sbc$/, '')
			currentBiovaultHome = normalizePath(fallback)
			return
		}

		currentBiovaultHome = null
	}

	function fmtDate(value: string | null | undefined): string {
		if (!value) return 'n/a'
		const date = new Date(value)
		if (Number.isNaN(date.getTime())) return value
		return date.toLocaleString()
	}

	async function loadFailedMessages() {
		const result = await invoke<FailedMessagesResult>('list_failed_messages', {
			includeDismissed: false,
		})
		failed = result?.failed_messages || []
		totalFailed = result?.count ?? failed.length
	}

	async function refreshMailDebug() {
		loading = true
		error = null
		try {
			const batched = await invoke<RefreshMessagesBatchedResult>('refresh_messages_batched', {
				scope: 'all',
				limit: 80,
			})
			threads = batched?.threads || []
			newMessages = batched?.new_messages || 0
			newFailed = batched?.new_failed || 0
			totalFailed = batched?.total_failed || 0
			try {
				keyStatus = await invoke<KeyStatusInfo>('key_get_status', { email: null })
			} catch {
				keyStatus = null
			}
			await resolveCurrentBiovaultHome()
			await loadFailedMessages()
			lastUpdated = new Date().toISOString()
		} catch (e) {
			error = e instanceof Error ? e.message : String(e)
		} finally {
			loading = false
		}
	}

	async function dismissFailed(id: string) {
		try {
			await invoke('dismiss_failed_message', { id })
			await loadFailedMessages()
		} catch (e) {
			error = e instanceof Error ? e.message : String(e)
		}
	}

	function canImportSender(msg: FailedMessageInfo): boolean {
		return (
			msg.failure_reason === 'SenderBundleNotCached' &&
			!!msg.sender_identity &&
			msg.sender_identity !== 'unknown'
		)
	}

	function needsLocalKey(msg: FailedMessageInfo): boolean {
		const details = (msg.error_details || '').toLowerCase()
		return (
			details.includes('no identities found in vault') ||
			(details.includes('sbc key generate') && details.includes('vault'))
		)
	}

	function shouldOfferLocalKeyAction(msg: FailedMessageInfo): boolean {
		if (!needsLocalKey(msg)) return false
		// If key is already ready and no new failures are arriving, this is historical noise.
		if (keyStatus?.exists && newFailed === 0) return false
		return true
	}

	async function generateLocalKey(msg: FailedMessageInfo) {
		keyLoadingById = { ...keyLoadingById, [msg.id]: true }
		try {
			const result = await invoke<KeyOperationResult>('key_generate', {
				email: null,
				force: false,
			})
			toast.success(`Generated key for ${result.identity}`)
			if (result.mnemonic) {
				toast.info('Recovery phrase created', {
					description: 'Open Settings → Security to back it up.',
				})
			}
			await refreshMailDebug()
		} catch (e) {
			const message = e instanceof Error ? e.message : String(e)
			error = message
			toast.error('Failed to generate local key', { description: message })
		} finally {
			keyLoadingById = { ...keyLoadingById, [msg.id]: false }
		}
	}

	async function importSenderKey(msg: FailedMessageInfo) {
		if (!canImportSender(msg)) return
		importLoadingById = { ...importLoadingById, [msg.id]: true }
		try {
			await invoke('network_import_contact', { identity: msg.sender_identity })
			await refreshMailDebug()
			toast.success(`Imported key for ${msg.sender_identity}`)
		} catch (e) {
			const message = e instanceof Error ? e.message : String(e)
			error = message
			if (message.includes('failed to parse DID')) {
				toast.error(`Invalid DID for ${msg.sender_identity}`, {
					description:
						'Sender must regenerate/republish their public key (did.json), then retry import.',
				})
			} else {
				toast.error(`Failed to import key for ${msg.sender_identity}`)
			}
		} finally {
			importLoadingById = { ...importLoadingById, [msg.id]: false }
		}
	}

	onMount(() => {
		void refreshMailDebug()

		const interval = setInterval(() => {
			void refreshMailDebug()
		}, 15000)

		const unlistenPromise = listen('messages:rpc-activity', () => {
			void refreshMailDebug()
		})

		return () => {
			clearInterval(interval)
			unlistenPromise.then((unlisten) => unlisten())
		}
	})
</script>

<div class="flex h-full flex-col gap-4">
	<div class="flex items-center justify-between gap-3">
		<div class="flex items-center gap-3">
			<div class="flex size-10 items-center justify-center rounded-lg bg-muted">
				<MailWarningIcon class="size-5" />
			</div>
			<div>
				<h2 class="text-lg font-semibold">Mail Debug</h2>
				<p class="text-muted-foreground text-sm">Incoming message sync and decrypt diagnostics</p>
			</div>
		</div>
		<Button variant="outline" size="sm" onclick={refreshMailDebug} disabled={loading}>
			<RefreshCwIcon class="size-4 {loading ? 'animate-spin' : ''}" />
			Refresh
		</Button>
	</div>

	<div class="flex flex-wrap items-center gap-2 text-sm">
		<Badge variant="outline">Threads: {threads.length}</Badge>
		<Badge variant="outline">Unread: {unreadTotal}</Badge>
		<Badge variant="outline">Failed: {totalFailed}</Badge>
		<Badge variant="outline">New sync: {newMessages}</Badge>
		<Badge variant="outline">New failed: {newFailed}</Badge>
		{#if crossRootFailedCount > 0}
			<Badge variant="destructive">Cross-root failures: {crossRootFailedCount}</Badge>
		{/if}
		<span class="text-muted-foreground ml-auto text-xs">Updated: {fmtDate(lastUpdated)}</span>
	</div>

	{#if crossRootFailedCount > 0}
		<section class="rounded-xl border border-destructive/30 bg-destructive/10 p-3 text-xs">
			<p class="font-medium text-destructive">Failed decrypts from another BioVault root detected.</p>
			<p class="mt-1 text-destructive/90">
				Active root: <span class="font-mono break-all">{currentBiovaultHome || 'unknown'}</span>
			</p>
			<p class="mt-1 text-destructive/90">
				Failed entries reference: <span class="font-mono break-all">{failedRoots.join(', ')}</span>
			</p>
		</section>
	{/if}

	<section class="rounded-xl border p-3">
		<div class="mb-2 flex flex-wrap items-center gap-2">
			<p class="text-sm font-medium">Local Key Status</p>
			{#if keyStatus?.exists}
				<Badge variant="secondary">Ready</Badge>
			{:else}
				<Badge variant="destructive">Missing local key</Badge>
			{/if}
			{#if totalFailed > 0}
				{#if newFailed > 0}
					<Badge variant="destructive">New decrypt failures</Badge>
				{:else}
					<Badge variant="outline">Failures are historical</Badge>
				{/if}
			{/if}
		</div>
		<div class="grid gap-1 text-xs text-muted-foreground">
			<p>Identity: <span class="font-mono text-foreground">{keyStatus?.identity || 'unknown'}</span></p>
			<p>Vault: <span class="font-mono text-foreground break-all">{keyStatus?.vault_path || 'unknown'}</span></p>
			{#if keyStatus?.vault_fingerprint}
				<p>Fingerprint: <span class="font-mono text-foreground">{keyStatus.vault_fingerprint}</span></p>
			{/if}
		</div>
	</section>

	{#if error}
		<div class="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
			{error}
		</div>
	{/if}

	<div class="grid min-h-0 flex-1 grid-cols-1 gap-4 lg:grid-cols-2">
		<section class="flex min-h-0 flex-col overflow-hidden rounded-xl border">
			<div class="flex items-center gap-2 border-b px-3 py-2 text-sm font-medium">
				<InboxIcon class="size-4" />
				Recent Threads
			</div>
			<div class="min-h-0 flex-1 overflow-auto p-2">
				{#if topThreads.length === 0}
					<p class="text-muted-foreground p-3 text-sm">No message threads found.</p>
				{:else}
					{#each topThreads as thread (thread.thread_id)}
						<div class="mb-2 rounded-lg border p-2 text-xs">
							<div class="flex items-center justify-between gap-2">
								<p class="truncate font-medium">{thread.subject || 'No subject'}</p>
								{#if thread.unread_count > 0}
									<Badge variant="secondary">{thread.unread_count} unread</Badge>
								{/if}
							</div>
							<p class="text-muted-foreground mt-1 line-clamp-2">{thread.last_message_preview}</p>
							<p class="text-muted-foreground mt-1 truncate">
								{thread.participants.join(', ')}
							</p>
						</div>
					{/each}
				{/if}
			</div>
		</section>

		<section class="flex min-h-0 flex-col overflow-hidden rounded-xl border">
			<div class="flex items-center justify-between gap-2 border-b px-3 py-2 text-sm font-medium">
				<div class="flex items-center gap-2">
					<MailWarningIcon class="size-4" />
					Failed Decrypts
				</div>
				<Badge variant="outline">{totalFailed}</Badge>
			</div>
			<div class="min-h-0 flex-1 overflow-auto p-2">
				{#if topFailed.length === 0}
					<p class="text-muted-foreground p-3 text-sm">No failed messages.</p>
				{:else}
					{#each topFailed as msg (msg.id)}
						<div class="mb-2 rounded-lg border p-2 text-xs">
							<div class="flex items-start justify-between gap-2">
								<div class="min-w-0">
									<p class="truncate font-medium">{msg.sender_identity}</p>
									<p class="text-muted-foreground">{msg.failure_reason_display}</p>
								</div>
								<Button variant="ghost" size="icon" onclick={() => dismissFailed(msg.id)}>
									<TrashIcon class="size-3.5" />
								</Button>
							</div>
							<p class="text-muted-foreground mt-1 line-clamp-2">{msg.error_details}</p>
							<p class="mt-1 line-clamp-2">{msg.suggested_action}</p>
							{#if shouldOfferLocalKeyAction(msg)}
								<div class="mt-2">
									<Button
										variant="outline"
										size="sm"
										disabled={keyLoadingById[msg.id]}
										onclick={() => generateLocalKey(msg)}
									>
										<KeyRoundIcon class="size-3.5" />
										{keyLoadingById[msg.id] ? 'Generating key…' : 'Generate local key'}
									</Button>
								</div>
							{:else if needsLocalKey(msg) && keyStatus?.exists && newFailed === 0}
								<p class="mt-2 text-[11px] text-muted-foreground">
									Historical failure from before local key setup.
								</p>
							{/if}
							{#if canImportSender(msg)}
								<div class="mt-2">
									<Button
										variant="outline"
										size="sm"
										disabled={importLoadingById[msg.id]}
										onclick={() => importSenderKey(msg)}
									>
										{importLoadingById[msg.id] ? 'Importing…' : `Import ${msg.sender_identity}`}
									</Button>
								</div>
							{/if}
							<p class="text-muted-foreground mt-1">{fmtDate(msg.created_at)}</p>
						</div>
					{/each}
				{/if}
			</div>
		</section>
	</div>
</div>
