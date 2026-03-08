<script lang="ts">
	import { invoke } from '@tauri-apps/api/core'
	import * as Dialog from '$lib/components/ui/dialog/index.js'
	import { Button, buttonVariants } from '$lib/components/ui/button/index.js'
	import { Textarea } from '$lib/components/ui/textarea/index.js'
	import { Label } from '$lib/components/ui/label/index.js'
	import WorkflowIcon from '@lucide/svelte/icons/workflow'
	import SendIcon from '@lucide/svelte/icons/send'
	import LoaderIcon from '@lucide/svelte/icons/loader'
	import CheckIcon from '@lucide/svelte/icons/check'
	import AlertCircleIcon from '@lucide/svelte/icons/alert-circle'
	import DnaIcon from '@lucide/svelte/icons/dna'
	import UserIcon from '@lucide/svelte/icons/user'
	import ScanEyeIcon from '@lucide/svelte/icons/scan-eye'
	import { toast } from 'svelte-sonner'

	interface Flow {
		id: number
		name: string
		flow_path: string
	}

	interface Props {
		open?: boolean
		onOpenChange?: (open: boolean) => void
		datasetName: string
		authorEmail: string
		onSent?: () => void
	}

	let { open = $bindable(false), onOpenChange, datasetName, authorEmail, onSent }: Props =
		$props()

	let flows: Flow[] = $state([])
	let loading = $state(true)
	let sending = $state(false)
	let error = $state<string | null>(null)
	let selectedFlow: Flow | null = $state(null)
	let requestMessage = $state("")

	async function loadFlows() {
		try {
			loading = true
			error = null
			flows = await invoke<Flow[]>('get_flows')
		} catch (e) {
			error = e instanceof Error ? e.message : String(e)
		} finally {
			loading = false
		}
	}

	function handleOpenChange(newOpen: boolean) {
		open = newOpen
		onOpenChange?.(newOpen)
		if (newOpen) {
			selectedFlow = null
			requestMessage = ""
			error = null
			loadFlows()
		}
	}

	async function sendRequest() {
		if (!selectedFlow) return
		sending = true
		error = null

		try {
			await invoke('send_flow_request', {
				flowName: selectedFlow.name,
				flowVersion: "1.0.0", // For now hardcoded, backend handles it
				datasetName: datasetName,
				recipient: authorEmail,
				message:
					requestMessage.trim() ||
					`Please run the ${selectedFlow.name} flow on your private data in dataset ${datasetName}.`
			})

			toast.success(`Request sent to ${authorEmail}`)
			handleOpenChange(false)
			onSent?.()
		} catch (e) {
			error = e instanceof Error ? e.message : String(e)
			toast.error(`Failed to send request: ${error}`)
		} finally {
			sending = false
		}
	}

	function getFlowIcon(name: string) {
		const lower = name.toLowerCase()
		if (lower.includes('dna') || lower.includes('gene')) return DnaIcon
		if (lower.includes('user') || lower.includes('profile')) return UserIcon
		if (lower.includes('eye') || lower.includes('scan')) return ScanEyeIcon
		return WorkflowIcon
	}

	$effect(() => {
		if (open) {
			loadFlows()
		}
	})
</script>

<Dialog.Root bind:open onOpenChange={handleOpenChange}>
	<Dialog.Content class="max-w-lg">
		<Dialog.Header>
			<Dialog.Title>Request Run on {datasetName}</Dialog.Title>
			<Dialog.Description>
				Send a request to <b>{authorEmail}</b> to execute a flow on their private data.
			</Dialog.Description>
		</Dialog.Header>

		<div class="py-4 space-y-4">
			<div class="space-y-2">
				<Label>Select Flow</Label>
				{#if loading}
					<div class="flex items-center justify-center py-8">
						<LoaderIcon class="size-6 animate-spin text-muted-foreground" />
					</div>
				{:else if flows.length === 0}
					<div class="text-center py-8 text-muted-foreground border rounded-lg bg-muted/20">
						<WorkflowIcon class="size-12 mx-auto mb-3 opacity-20" />
						<p>No flows installed.</p>
						<p class="text-xs">Install a flow from the Explore tab first.</p>
					</div>
				{:else}
					<div class="space-y-2 max-h-[200px] overflow-y-auto pr-1">
						{#each flows as flow (flow.id)}
							{@const Icon = getFlowIcon(flow.name)}
							<button
								type="button"
								onclick={() => (selectedFlow = flow)}
								data-testid={`request-run-flow-${flow.name}`}
								class="w-full flex items-center gap-3 rounded-lg border p-3 text-left transition-all hover:bg-accent {selectedFlow?.id ===
								flow.id
									? 'border-primary bg-primary/5'
									: ''}"
							>
								<div
									class="flex size-10 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary"
								>
									<Icon class="size-5" />
								</div>
								<div class="flex-1 min-w-0">
									<div class="font-medium text-sm">{flow.name}</div>
									<div class="text-muted-foreground text-xs truncate">
										{flow.flow_path.split('/').pop()}
									</div>
								</div>
								{#if selectedFlow?.id === flow.id}
									<div class="flex size-6 items-center justify-center rounded-full bg-primary text-white">
										<CheckIcon class="size-4" />
									</div>
								{/if}
							</button>
						{/each}
					</div>
				{/if}
			</div>

			<div class="space-y-2">
				<Label for="request-message">Message (Optional)</Label>
				<Textarea
					id="request-message"
					placeholder="Add a note to your request..."
					bind:value={requestMessage}
					class="min-h-[100px] resize-none"
				/>
			</div>

			{#if error}
				<div
					class="mt-4 flex items-start gap-2 bg-destructive/10 text-destructive text-sm rounded-md px-3 py-2"
				>
					<AlertCircleIcon class="size-4 shrink-0 mt-0.5" />
					<div>{error}</div>
				</div>
			{/if}
		</div>

		<Dialog.Footer>
			<Dialog.Close class={buttonVariants({ variant: 'outline' })}>Cancel</Dialog.Close>
			<Button
				data-testid="request-run-submit"
				onclick={sendRequest}
				disabled={sending || !selectedFlow || loading}
			>
				{#if sending}
					<LoaderIcon class="size-4 animate-spin mr-2" />
					Sending...
				{:else}
					<SendIcon class="size-4 mr-2" />
					Send Request
				{/if}
			</Button>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>
