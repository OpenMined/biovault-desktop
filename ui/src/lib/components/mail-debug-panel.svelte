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

	let loading = $state(false)
	let error = $state<string | null>(null)
	let threads = $state<MessageThreadSummary[]>([])
	let failed = $state<FailedMessageInfo[]>([])
	let newMessages = $state(0)
	let newFailed = $state(0)
	let totalFailed = $state(0)
	let lastUpdated = $state<string | null>(null)
	let importLoadingById = $state<Record<string, boolean>>({})

	const unreadTotal = $derived(threads.reduce((sum, t) => sum + (t.unread_count || 0), 0))
	const topThreads = $derived(threads.slice(0, 8))
	const topFailed = $derived(failed.slice(0, 8))

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
		<span class="text-muted-foreground ml-auto text-xs">Updated: {fmtDate(lastUpdated)}</span>
	</div>

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
