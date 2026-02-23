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
		actions,
		composerPrefix,
		composerDropActive = false,
		onComposerDragOver,
		onComposerDragLeave,
		onComposerDrop,
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
		actions?: Snippet<[ChatMessage]>
		composerPrefix?: Snippet
		composerDropActive?: boolean
		onComposerDragOver?: ((e: DragEvent) => void) | null
		onComposerDragLeave?: ((e: DragEvent) => void) | null
		onComposerDrop?: ((e: DragEvent) => void) | null
	} = $props()

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
</script>

<div class="flex h-full min-h-0 flex-col">
	<div class="min-h-0 flex-1 space-y-4 overflow-auto px-5 py-4">
		{#if loading}
			<div class="space-y-3">
				<Skeleton class="h-16 w-[70%] rounded-2xl" />
				<Skeleton class="ml-auto h-16 w-[70%] rounded-2xl" />
				<Skeleton class="h-16 w-[70%] rounded-2xl" />
			</div>
		{:else}
			{#each messages as msg (msg.id)}
				{@const outgoing = isOutgoing(msg)}
				<div class="flex {outgoing ? 'justify-end' : 'justify-start'}">
					<div class="max-w-[82%] rounded-2xl border px-4 py-3 {outgoing ? 'border-primary/25 bg-primary/10' : 'bg-card'}">
						<div class="mb-2 flex items-center gap-2">
							{#if kindLabel}
								{@const label = kindLabel(msg)}
								{#if label}
									<Badge variant="outline" class="h-5 text-[10px]">{label}</Badge>
								{/if}
							{/if}
							{#if !outgoing}
								<p class="truncate text-xs text-muted-foreground">{msg.from}</p>
							{/if}
						</div>

						<p class="text-sm whitespace-pre-wrap break-words">{msg.body}</p>
						{@render actions?.(msg)}

						<p class="mt-2 text-xs text-muted-foreground">{formatFullTime(msg.created_at)}</p>
					</div>
				</div>
			{:else}
				<div class="text-center text-sm text-muted-foreground">{emptyText}</div>
			{/each}
		{/if}
	</div>

	<div class="shrink-0 border-t px-5 py-4">
		<div
			class="flex gap-2 rounded-xl border border-transparent p-1 transition-colors {composerDropActive
				? 'border-primary/40 bg-primary/5'
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
				class="min-h-[40px] resize-none"
			/>
			<Button
				onclick={onSend}
				disabled={composerDisabled || sending || !draft.trim()}
				size="icon"
			>
				{#if sending}
					<Loader2Icon class="size-4 animate-spin" />
				{:else}
					<SendIcon class="size-4" />
				{/if}
			</Button>
		</div>
	</div>
</div>
