<script lang="ts">
	import type { Snippet } from 'svelte'
	import { Button } from '$lib/components/ui/button/index.js'
	import { Textarea } from '$lib/components/ui/textarea/index.js'
	import { Skeleton } from '$lib/components/ui/skeleton/index.js'
	import { Badge } from '$lib/components/ui/badge/index.js'
	import Loader2Icon from '@lucide/svelte/icons/loader-2'
	import SendIcon from '@lucide/svelte/icons/send'

	export interface ChatMessage {
		id: string
		from: string
		body: string
		created_at: string
	}

	let {
		messages,
		loading = false,
		currentUserEmail = '',
		draft = $bindable(''),
		sending = false,
		placeholder = 'Message...',
		emptyText = 'No messages yet',
		composerDisabled = false,
		onSend,
		onKeydown,
		kindLabel,
		isEventMessage,
		actions,
		composerPrefix,
		composerDropActive = false,
		onComposerDragOver,
		onComposerDragLeave,
		onComposerDrop,
		scrollToBottomToken = 0,
	}: {
		messages: ChatMessage[]
		loading?: boolean
		currentUserEmail?: string
		draft?: string
		sending?: boolean
		placeholder?: string
		emptyText?: string
		composerDisabled?: boolean
		onSend: () => void | Promise<void>
		onKeydown?: (e: KeyboardEvent) => void
		kindLabel?: ((msg: ChatMessage) => string | null | undefined) | null
		isEventMessage?: ((msg: ChatMessage) => boolean) | null
		actions?: Snippet<[ChatMessage]>
		composerPrefix?: Snippet
		composerDropActive?: boolean
		onComposerDragOver?: ((e: DragEvent) => void) | null
		onComposerDragLeave?: ((e: DragEvent) => void) | null
		onComposerDrop?: ((e: DragEvent) => void) | null
		scrollToBottomToken?: number
	} = $props()

	let messagesContainer: HTMLDivElement | null = null

	function formatFullTime(value: string): string {
		const date = new Date(value)
		return date.toLocaleString([], {
			month: 'short',
			day: 'numeric',
			hour: '2-digit',
			minute: '2-digit',
		})
	}

	function isOutgoing(msg: ChatMessage): boolean {
		return msg.from.toLowerCase() === currentUserEmail.toLowerCase()
	}

	function formatEventText(msg: ChatMessage): string {
		const actor = msg.from?.trim() || 'Unknown'
		const body = msg.body?.trim() || ''
		if (body.startsWith('Created space:')) {
			const name = body.slice('Created space:'.length).trim()
			return `${actor} created space: ${name}`
		}
		if (body.startsWith('Created session:')) {
			return `${actor} created session:`
		}
		if (body.startsWith('Renamed space to:')) {
			const name = body.slice('Renamed space to:'.length).trim()
			return `${actor} renamed space to: ${name}`
		}
		return `${actor}: ${body}`
	}

	function scrollToBottom(behavior: ScrollBehavior = 'smooth') {
		if (!messagesContainer) return
		messagesContainer.scrollTo({
			top: messagesContainer.scrollHeight,
			behavior,
		})
	}

	$effect(() => {
		scrollToBottomToken
		queueMicrotask(() => scrollToBottom('smooth'))
	})

	$effect(() => {
		messages.length
		queueMicrotask(() => scrollToBottom('auto'))
	})
</script>

<div class="flex h-full min-h-0 flex-col bg-emerald-50/70">
	<div bind:this={messagesContainer} class="min-h-0 flex-1 space-y-3 overflow-auto bg-[radial-gradient(circle_at_1px_1px,rgba(16,185,129,0.10)_1px,transparent_0)] [background-size:18px_18px] px-4 py-4">
		{#if loading}
			<div class="space-y-3">
				<Skeleton class="h-16 w-[70%] rounded-2xl" />
				<Skeleton class="ml-auto h-16 w-[70%] rounded-2xl" />
				<Skeleton class="h-16 w-[70%] rounded-2xl" />
			</div>
		{:else}
			{#each messages as msg (msg.id)}
				{@const outgoing = isOutgoing(msg)}
				{@const eventMessage = isEventMessage?.(msg) ?? false}
				{#if eventMessage}
					<div class="flex justify-center py-1">
						<div class="max-w-[88%] text-center">
							<p class="inline-flex items-center gap-[2px] rounded-full border border-emerald-300/60 bg-emerald-100/85 px-3 py-1 text-xs font-medium text-emerald-900/80 whitespace-pre-wrap break-words">
								{formatEventText(msg)}
								{@render actions?.(msg)}
							</p>
						</div>
					</div>
				{:else}
					<div class="flex {outgoing ? 'justify-end' : 'justify-start'}">
						<div
							class="max-w-[80%] px-3 py-2 shadow-sm {outgoing
								? 'rounded-2xl rounded-br-md bg-[#dcf8c6]'
								: 'rounded-2xl rounded-bl-md bg-white'}"
						>
							<div class="mb-1 flex items-center gap-2">
								{#if kindLabel}
									{@const label = kindLabel(msg)}
									{#if label}
										<Badge variant="outline" class="h-4 border-0 bg-black/10 px-1.5 text-[10px] font-medium text-foreground/75">{label}</Badge>
									{/if}
								{/if}
								{#if !outgoing}
									<p class="truncate text-[11px] font-medium text-emerald-700/90">{msg.from}</p>
								{/if}
							</div>

							<p class="text-[14px] leading-5 text-foreground/90 whitespace-pre-wrap break-words">{msg.body}</p>
							{@render actions?.(msg)}

							<p class="mt-1 text-right text-[11px] text-foreground/50">{formatFullTime(msg.created_at)}</p>
						</div>
					</div>
				{/if}
			{:else}
				<div class="text-center text-sm text-muted-foreground">{emptyText}</div>
			{/each}
		{/if}
	</div>

	<div class="shrink-0 border-t border-emerald-200/70 bg-emerald-100/60 px-3 py-1.5">
		<div
			class="flex items-end gap-1.5 rounded-2xl border border-transparent bg-white p-1 shadow-sm transition-colors {composerDropActive
				? 'border-primary/40 ring-2 ring-primary/20'
				: ''}"
			role="group"
			ondragover={onComposerDragOver}
			ondragleave={onComposerDragLeave}
			ondrop={onComposerDrop}
		>
			{@render composerPrefix?.()}
			<Textarea
				placeholder={placeholder}
				bind:value={draft}
				onkeydown={onKeydown}
				rows={1}
				disabled={composerDisabled}
				class="min-h-0 h-6 py-0.5 px-2 text-sm leading-4 border-0 bg-transparent shadow-none focus-visible:ring-0 focus-visible:border-0 resize-none"
			/>
			<Button
				onclick={onSend}
				disabled={composerDisabled || sending || !draft.trim()}
				size="icon"
				class="size-7 rounded-full bg-emerald-600 text-white hover:bg-emerald-700 disabled:bg-emerald-400"
			>
				{#if sending}
					<Loader2Icon class="size-3.5 animate-spin" />
				{:else}
					<SendIcon class="size-3.5" />
				{/if}
			</Button>
		</div>
	</div>
</div>
