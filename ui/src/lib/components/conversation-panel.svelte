<script lang="ts">
	import { onMount } from 'svelte'
	import { toast } from 'svelte-sonner'
	import type { Snippet } from 'svelte'
	import ChatThreadPanel, { type ChatMessage } from '$lib/components/chat-thread-panel.svelte'
	import type { ConversationAdapter } from '$lib/collab/conversation-adapters'
	import * as DropdownMenu from '$lib/components/ui/dropdown-menu/index.js'
	import { Button } from '$lib/components/ui/button/index.js'
	import Loader2Icon from '@lucide/svelte/icons/loader-2'
	import PlusIcon from '@lucide/svelte/icons/plus'
	import PaperclipIcon from '@lucide/svelte/icons/paperclip'
	import FolderUpIcon from '@lucide/svelte/icons/folder-up'

	let {
		adapter,
		actions,
		reloadSignal = 0,
	}: {
		adapter: ConversationAdapter
		actions?: Snippet<[ChatMessage]>
		reloadSignal?: number
	} = $props()

	let messages = $state<ChatMessage[]>([])
	let loading = $state(false)
	let draft = $state('')
	let sending = $state(false)
	let attaching = $state(false)
	let composerDropActive = $state(false)
	let lastLoadedKey = $state('')
	let lastReloadSignal = $state(-1)

	async function refreshMessages() {
		loading = true
		try {
			messages = await adapter.loadMessages()
		} catch (e) {
			toast.error('Failed to load messages', { description: String(e) })
		} finally {
			loading = false
		}
	}

	async function sendCurrentMessage() {
		const body = draft.trim()
		if (!body || sending) return
		sending = true
		try {
			await adapter.sendMessage(body)
			draft = ''
			await refreshMessages()
		} catch (e) {
			toast.error('Failed to send message', { description: String(e) })
		} finally {
			sending = false
		}
	}

	async function attachPaths(paths: string[]) {
		if (!adapter.attachPaths || attaching) return
		const clean = paths.map((p) => p.trim()).filter((p) => p.length > 0)
		if (clean.length === 0) return
		attaching = true
		try {
			await adapter.attachPaths(clean)
			await refreshMessages()
		} catch (e) {
			toast.error('Failed to attach files', { description: String(e) })
		} finally {
			attaching = false
		}
	}

	async function pickAndAttachFiles() {
		if (!adapter.attachPaths || attaching) return
		const { open: openDialog } = await import('@tauri-apps/plugin-dialog')
		const picked = await openDialog({
			multiple: true,
			directory: false,
		})
		const paths = Array.isArray(picked) ? picked : picked ? [picked] : []
		await attachPaths(paths.map(String))
	}

	async function pickAndAttachFolder() {
		if (!adapter.attachPaths || attaching) return
		const { open: openDialog } = await import('@tauri-apps/plugin-dialog')
		const picked = await openDialog({
			multiple: false,
			directory: true,
		})
		const paths = Array.isArray(picked) ? picked : picked ? [picked] : []
		await attachPaths(paths.map(String))
	}

	function handleComposerDragOver(event: DragEvent) {
		if (!adapter.attachPaths) return
		event.preventDefault()
		composerDropActive = true
	}

	function handleComposerDragLeave(event: DragEvent) {
		if (!adapter.attachPaths) return
		event.preventDefault()
		composerDropActive = false
	}

	async function handleComposerDrop(event: DragEvent) {
		if (!adapter.attachPaths) return
		event.preventDefault()
		composerDropActive = false
		if (attaching) return

		const files = Array.from(event.dataTransfer?.files || [])
		const paths = files
			.map((f) => (f as File & { path?: string }).path)
			.filter((p): p is string => typeof p === 'string' && p.trim().length > 0)

		if (paths.length === 0) {
			toast.error('Could not read dropped file paths', {
				description: 'Use the + button to attach files or folders.',
			})
			return
		}
		await attachPaths(paths)
	}

	function handleDraftKeydown(e: KeyboardEvent) {
		if (e.key === 'Enter' && !e.shiftKey) {
			e.preventDefault()
			void sendCurrentMessage()
		}
	}

	onMount(async () => {
		await refreshMessages()
		lastLoadedKey = adapter.key
		lastReloadSignal = reloadSignal
	})

	$effect(() => {
		if (adapter.key && adapter.key !== lastLoadedKey) {
			lastLoadedKey = adapter.key
			void refreshMessages()
		}
	})

	$effect(() => {
		if (reloadSignal !== lastReloadSignal) {
			lastReloadSignal = reloadSignal
			void refreshMessages()
		}
	})
</script>

<ChatThreadPanel
	{messages}
	{loading}
	currentUserEmail={adapter.currentUserEmail}
	bind:draft
	{sending}
	placeholder={adapter.placeholder}
	emptyText={adapter.emptyText}
	onSend={sendCurrentMessage}
	onKeydown={handleDraftKeydown}
	kindLabel={adapter.kindLabel}
	composerDropActive={composerDropActive}
	onComposerDragOver={handleComposerDragOver}
	onComposerDragLeave={handleComposerDragLeave}
	onComposerDrop={handleComposerDrop}
>
	{#snippet actions(msg)}
		{@render actions?.(msg)}
	{/snippet}
	{#snippet composerPrefix()}
		<DropdownMenu.Root>
			<DropdownMenu.Trigger>
				<Button size="icon" variant="outline" disabled={!adapter.attachPaths || attaching}>
					{#if attaching}
						<Loader2Icon class="size-4 animate-spin" />
					{:else}
						<PlusIcon class="size-4" />
					{/if}
				</Button>
			</DropdownMenu.Trigger>
			<DropdownMenu.Content class="w-52">
				<DropdownMenu.Item onclick={pickAndAttachFiles} disabled={!adapter.attachPaths}>
					<PaperclipIcon class="mr-2 size-4" />
					Attach files
				</DropdownMenu.Item>
				<DropdownMenu.Item onclick={pickAndAttachFolder} disabled={!adapter.attachPaths}>
					<FolderUpIcon class="mr-2 size-4" />
					Attach folder
				</DropdownMenu.Item>
			</DropdownMenu.Content>
		</DropdownMenu.Root>
	{/snippet}
</ChatThreadPanel>
