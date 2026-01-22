<script lang="ts">
	import * as Popover from '$lib/components/ui/popover/index.js'
	import { Button } from '$lib/components/ui/button/index.js'
	import { Textarea } from '$lib/components/ui/textarea/index.js'
	import SparklesIcon from '@lucide/svelte/icons/sparkles'
	import SendIcon from '@lucide/svelte/icons/send'
	import XIcon from '@lucide/svelte/icons/x'
	import BotIcon from '@lucide/svelte/icons/bot'
	import UserIcon from '@lucide/svelte/icons/user'

	let open = $state(false)
	let message = $state('')

	interface Message {
		id: string
		role: 'user' | 'assistant'
		content: string
	}

	let messages = $state<Message[]>([
		{
			id: '1',
			role: 'assistant',
			content: "Hi! I'm your BioVault assistant. How can I help you today?",
		},
	])

	function handleSubmit() {
		if (!message.trim()) return

		// Add user message
		const userMessage: Message = {
			id: `${Date.now()}-user`,
			role: 'user',
			content: message.trim(),
		}
		messages = [...messages, userMessage]
		message = ''

		// Simulate assistant response (Coming Soon)
		setTimeout(() => {
			const assistantMessage: Message = {
				id: `${Date.now()}-assistant`,
				role: 'assistant',
				content: "Thanks for your message! AI assistant features are coming soon. Stay tuned!",
			}
			messages = [...messages, assistantMessage]
		}, 500)
	}

	function handleKeydown(e: KeyboardEvent) {
		if (e.key === 'Enter' && !e.shiftKey) {
			e.preventDefault()
			handleSubmit()
		}
	}
</script>

<div class="fixed bottom-6 right-6 z-50">
	<Popover.Root bind:open>
		<Popover.Trigger>
			<button
				type="button"
				class="group flex size-14 items-center justify-center rounded-full bg-primary text-primary-foreground shadow-lg transition-all hover:scale-105 hover:shadow-xl active:scale-95"
			>
				<SparklesIcon
					class="size-6 transition-transform group-hover:rotate-12 group-hover:scale-110"
				/>
				<span class="sr-only">AI Assistant</span>
			</button>
		</Popover.Trigger>

		<Popover.Content
			side="top"
			align="end"
			sideOffset={12}
			class="w-[380px] p-0 overflow-hidden"
		>
			<!-- Header -->
			<div class="flex items-center justify-between border-b bg-muted/30 px-4 py-3">
				<div class="flex items-center gap-2">
					<div class="flex size-8 items-center justify-center rounded-full bg-primary/10">
						<SparklesIcon class="size-4 text-primary" />
					</div>
					<div>
						<h3 class="font-semibold text-sm">AI Assistant</h3>
						<p class="text-xs text-muted-foreground">Ask me anything</p>
					</div>
				</div>
				<Button variant="ghost" size="icon" class="size-8" onclick={() => (open = false)}>
					<XIcon class="size-4" />
				</Button>
			</div>

			<!-- Messages -->
			<div class="h-[300px] overflow-y-auto p-4 space-y-4">
				{#each messages as msg (msg.id)}
					<div class="flex gap-3 {msg.role === 'user' ? 'flex-row-reverse' : ''}">
						<div
							class="flex size-8 shrink-0 items-center justify-center rounded-full {msg.role === 'user'
								? 'bg-primary text-primary-foreground'
								: 'bg-muted'}"
						>
							{#if msg.role === 'user'}
								<UserIcon class="size-4" />
							{:else}
								<BotIcon class="size-4" />
							{/if}
						</div>
						<div
							class="max-w-[80%] rounded-lg px-3 py-2 text-sm {msg.role === 'user'
								? 'bg-primary text-primary-foreground'
								: 'bg-muted'}"
						>
							{msg.content}
						</div>
					</div>
				{/each}
			</div>

			<!-- Input -->
			<div class="border-t p-3">
				<div class="flex gap-2">
					<Textarea
						bind:value={message}
						placeholder="Ask a question..."
						rows={1}
						class="min-h-[40px] max-h-[120px] resize-none"
						onkeydown={handleKeydown}
					/>
					<Button
						size="icon"
						class="shrink-0 size-10"
						onclick={handleSubmit}
						disabled={!message.trim()}
					>
						<SendIcon class="size-4" />
					</Button>
				</div>
				<p class="text-xs text-muted-foreground mt-2 text-center">
					Press Enter to send, Shift+Enter for new line
				</p>
			</div>
		</Popover.Content>
	</Popover.Root>
</div>
