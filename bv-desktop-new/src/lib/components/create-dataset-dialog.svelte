<script lang="ts">
	import { invoke } from '@tauri-apps/api/core'
	import * as Dialog from '$lib/components/ui/dialog/index.js'
	import { Button, buttonVariants } from '$lib/components/ui/button/index.js'
	import { Input } from '$lib/components/ui/input/index.js'
	import PackageIcon from '@lucide/svelte/icons/package'

	interface Props {
		open?: boolean
		onOpenChange?: (open: boolean) => void
		onCreated?: (name: string) => void
	}

	let { open = $bindable(false), onOpenChange, onCreated }: Props = $props()

	let name = $state('')
	let saving = $state(false)
	let error = $state<string | null>(null)

	function resetForm() {
		name = ''
		error = null
	}

	function handleOpenChange(newOpen: boolean) {
		open = newOpen
		onOpenChange?.(newOpen)
		if (!newOpen) {
			resetForm()
		}
	}

	async function handleCreate() {
		if (!name.trim()) {
			error = 'Dataset name is required'
			return
		}

		if (!/^[a-z0-9_]+$/.test(name)) {
			error = 'Use lowercase letters, numbers, and underscores only'
			return
		}

		saving = true
		error = null

		try {
			// Use save_dataset_with_files which handles both create and update
			// The manifest structure matches biovault::cli::commands::datasets::DatasetManifest
			await invoke('save_dataset_with_files', {
				manifest: {
					name: name.trim(),
					description: null,
					version: '1.0.0',
					schema: 'net.biovault.datasets:1.0.0',
					author: null, // Will be filled by backend
					public_url: null,
					private_url: null,
					http_relay_servers: [],
					assets: {},
				},
				originalName: null,
			})

			const datasetName = name.trim()
			handleOpenChange(false)
			onCreated?.(datasetName)
		} catch (e) {
			error = e instanceof Error ? e.message : String(e)
		} finally {
			saving = false
		}
	}

	function handleKeydown(e: KeyboardEvent) {
		if (e.key === 'Enter' && !saving) {
			e.preventDefault()
			handleCreate()
		}
	}

	let nameError = $derived.by(() => {
		if (!name) return null
		if (!/^[a-z0-9_]+$/.test(name)) {
			return 'Use lowercase letters, numbers, and underscores only'
		}
		return null
	})
</script>

<Dialog.Root bind:open onOpenChange={handleOpenChange}>
	<Dialog.Content class="max-w-md">
		<Dialog.Header>
			<div class="flex items-center gap-3">
				<div class="flex size-10 items-center justify-center rounded-lg bg-primary/10">
					<PackageIcon class="size-5 text-primary" />
				</div>
				<div>
					<Dialog.Title>New Dataset</Dialog.Title>
					<Dialog.Description>Create a dataset to package your files</Dialog.Description>
				</div>
			</div>
		</Dialog.Header>

		<div class="py-4">
			<div class="space-y-2">
				<label for="dataset-name" class="text-sm font-medium"> Dataset Name </label>
				<Input
					id="dataset-name"
					bind:value={name}
					placeholder="e.g., single_cell_analysis"
					autocapitalize="off"
					autocorrect="off"
					spellcheck="false"
					aria-invalid={!!nameError}
					onkeydown={handleKeydown}
					autofocus
				/>
				{#if nameError}
					<p class="text-destructive text-xs">{nameError}</p>
				{:else}
					<p class="text-muted-foreground text-xs">
						Lowercase letters, numbers, and underscores only
					</p>
				{/if}
			</div>

			{#if error}
				<div class="mt-4 bg-destructive/10 text-destructive text-sm rounded-md px-3 py-2">
					{error}
				</div>
			{/if}
		</div>

		<Dialog.Footer>
			<Dialog.Close class={buttonVariants({ variant: 'outline' })}>Cancel</Dialog.Close>
			<Button onclick={handleCreate} disabled={saving || !!nameError || !name}>
				{#if saving}
					Creating...
				{:else}
					Create
				{/if}
			</Button>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>
