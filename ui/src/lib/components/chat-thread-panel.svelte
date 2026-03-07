<script lang="ts">
	import type { Snippet } from 'svelte'
	import { Button } from '$lib/components/ui/button/index.js'
	import { Textarea } from '$lib/components/ui/textarea/index.js'
	import { Skeleton } from '$lib/components/ui/skeleton/index.js'
	import { Badge } from '$lib/components/ui/badge/index.js'
	import * as Card from '$lib/components/ui/card/index.js'
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

	function formatBubbleTime(value: string): string {
		const date = new Date(value)
		return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
	}

	function dayKey(value: string): string {
		const date = new Date(value)
		const y = date.getFullYear()
		const m = String(date.getMonth() + 1).padStart(2, '0')
		const d = String(date.getDate()).padStart(2, '0')
		return `${y}-${m}-${d}`
	}

	function formatDayLabel(value: string): string {
		const date = new Date(value)
		const now = new Date()
		const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate())
		const startOfDate = new Date(date.getFullYear(), date.getMonth(), date.getDate())
		const diffDays = Math.round((startOfToday.getTime() - startOfDate.getTime()) / (1000 * 60 * 60 * 24))
		if (diffDays === 0) return 'Today'
		if (diffDays === 1) return 'Yesterday'
		return date.toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' })
	}

	function isOutgoing(msg: ChatMessage): boolean {
		return msg.from.toLowerCase() === currentUserEmail.toLowerCase()
	}

	function formatEventText(msg: ChatMessage): string {
		const actor = msg.from?.trim() || 'Unknown'
		const body = msg.body?.trim() || ''
		if (body.startsWith('Created thread:')) {
			const name = body.slice('Created thread:'.length).trim()
			return `${actor} created thread: ${name}`
		}
		if (body.startsWith('Created session:')) {
			return `${actor} created session:`
		}
		if (body.startsWith('Renamed thread to:')) {
			const name = body.slice('Renamed thread to:'.length).trim()
			return `${actor} renamed thread to: ${name}`
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

<div class="flex h-full min-h-0 min-w-0 flex-col bg-muted/20">
	<div bind:this={messagesContainer} class="min-h-0 flex-1 space-y-3 overflow-y-auto overflow-x-hidden [background-image:radial-gradient(circle_at_1px_1px,hsl(var(--border)/0.45)_1px,transparent_0)] [background-size:18px_18px] px-4 py-4">
		{#if loading}
			<div class="space-y-3">
				<Skeleton class="h-16 w-[70%] rounded-2xl" />
				<Skeleton class="ml-auto h-16 w-[70%] rounded-2xl" />
				<Skeleton class="h-16 w-[70%] rounded-2xl" />
			</div>
		{:else}
					{#each messages as msg, i (msg.id)}
						{@const outgoing = isOutgoing(msg)}
						{@const eventMessage = isEventMessage?.(msg) ?? false}
						{@const showDayDivider = i === 0 || dayKey(msg.created_at) !== dayKey(messages[i - 1].created_at)}
						{#if showDayDivider}
							<div class="flex justify-center py-1">
								<span class="rounded-full border border-border/70 bg-background/90 px-2.5 py-0.5 text-[11px] text-muted-foreground">
									{formatDayLabel(msg.created_at)}
								</span>
							</div>
						{/if}
						{#if eventMessage}
						<div class="flex justify-center py-1">
							<Card.Root class="max-w-[88%] border-0 bg-transparent px-2 py-0 text-center shadow-none">
								<Card.Content class="inline-flex items-center gap-[2px] px-0 text-xs font-medium text-muted-foreground whitespace-pre-wrap break-words">
									{formatEventText(msg)}
									{@render actions?.(msg)}
								</Card.Content>
							</Card.Root>
						</div>
					{:else}
						<div class="flex {outgoing ? 'justify-end' : 'justify-start'}">
								<Card.Root
									class="min-w-0 max-w-[80%] overflow-hidden gap-0 px-0 py-0 shadow-sm {outgoing
										? 'rounded-2xl rounded-br-md border-primary/30 bg-primary/10'
										: 'rounded-2xl rounded-bl-md bg-card'}"
								>
									<Card.Content class="relative min-w-0 px-3 py-2 pr-10 pb-6">
										<div class="mb-1 flex items-center gap-2">
									{#if kindLabel}
										{@const label = kindLabel(msg)}
										{#if label}
											<Badge variant="outline" class="h-4 border-0 bg-muted/80 px-1.5 text-[10px] font-medium text-foreground/75">{label}</Badge>
										{/if}
								{/if}
									{#if !outgoing}
										<p class="truncate text-[11px] font-medium text-muted-foreground">{msg.from}</p>
									{/if}
									</div>

										<p class="max-w-full min-w-0 whitespace-pre-wrap break-all text-[14px] leading-5 text-foreground/90">
											{msg.body}
										</p>
										{@render actions?.(msg)}
										<span class="absolute right-2.5 bottom-2 text-[11px] leading-none text-foreground/50" title={formatFullTime(msg.created_at)}>
											{formatBubbleTime(msg.created_at)}
										</span>
									</Card.Content>
								</Card.Root>
							</div>
					{/if}
				{:else}
					<div class="text-center text-sm text-muted-foreground">{emptyText}</div>
				{/each}
		{/if}
	</div>

		<div class="shrink-0 border-t border-border bg-background/80 px-3 py-1.5">
			<Card.Root
				class="flex min-w-0 flex-row items-end gap-1.5 overflow-hidden rounded-2xl border border-transparent bg-card p-1 shadow-sm transition-colors {composerDropActive
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
				class="min-h-0 h-6 min-w-0 max-w-full flex-1 py-0.5 px-2 text-sm leading-4 border-0 bg-transparent shadow-none focus-visible:ring-0 focus-visible:border-0 resize-none"
			/>
			<Button
				onclick={onSend}
				disabled={composerDisabled || sending || !draft.trim()}
				size="icon"
				class="size-7 rounded-full"
			>
				{#if sending}
					<Loader2Icon class="size-3.5 animate-spin" />
					{:else}
						<SendIcon class="size-3.5" />
					{/if}
				</Button>
			</Card.Root>
		</div>
	</div>
