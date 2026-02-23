<script lang="ts">
	import * as Dialog from '$lib/components/ui/dialog/index.js'
	import { Button } from '$lib/components/ui/button/index.js'
	import { Textarea } from '$lib/components/ui/textarea/index.js'
	import { Label } from '$lib/components/ui/label/index.js'
	import CircleHelpIcon from '@lucide/svelte/icons/circle-help'
	import SendIcon from '@lucide/svelte/icons/send'

	interface Props {
		open?: boolean
		onOpenChange?: (open: boolean) => void
	}

	let { open = $bindable(false), onOpenChange }: Props = $props()

	let message = $state('')

	function handleOpenChange(newOpen: boolean) {
		open = newOpen
		onOpenChange?.(newOpen)
		if (!newOpen) {
			message = ''
		}
	}

	function handleSubmit() {
		if (!message.trim()) return
		alert('Coming Soon')
		message = ''
		open = false
	}
</script>

<Dialog.Root bind:open onOpenChange={handleOpenChange}>
	<Dialog.Content class="sm:max-w-[425px]">
		<Dialog.Header>
			<div class="flex items-center gap-3">
				<div class="flex size-10 items-center justify-center rounded-lg bg-primary/10">
					<CircleHelpIcon class="size-5 text-primary" />
				</div>
				<div>
					<Dialog.Title>Help & Support</Dialog.Title>
					<Dialog.Description>Send us a message and we'll get back to you.</Dialog.Description>
				</div>
			</div>
		</Dialog.Header>

		<div class="py-4">
			<div class="space-y-2">
				<Label for="support-message">Your message</Label>
				<Textarea
					id="support-message"
					bind:value={message}
					placeholder="Describe your issue or question..."
					rows={5}
					class="resize-none"
				/>
			</div>
		</div>

		<Dialog.Footer>
			<Button variant="outline" onclick={() => (open = false)}>Cancel</Button>
			<Button onclick={handleSubmit} disabled={!message.trim()}>
				<SendIcon class="size-4" />
				Submit
			</Button>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>
