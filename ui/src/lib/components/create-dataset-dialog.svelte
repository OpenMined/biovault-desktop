<script lang="ts">
	import { invoke } from '@tauri-apps/api/core'
	import * as Dialog from '$lib/components/ui/dialog/index.js'
	import { Button, buttonVariants } from '$lib/components/ui/button/index.js'
	import { Input } from '$lib/components/ui/input/index.js'
	import PackageIcon from '@lucide/svelte/icons/package'
	import FolderOpenIcon from '@lucide/svelte/icons/folder-open'
	import UploadIcon from '@lucide/svelte/icons/upload'
	import PlusIcon from '@lucide/svelte/icons/plus'
	import ArrowLeftIcon from '@lucide/svelte/icons/arrow-left'

	interface Props {
		open?: boolean
		onOpenChange?: (open: boolean) => void
		onCreated?: (name: string) => void
		onExplore?: () => void | Promise<void>
		onImportFiles?: () => void | Promise<void>
		onImportFolder?: () => void | Promise<void>
	}

	type DialogView = 'picker' | 'blank-name'

	let {
		open = $bindable(false),
		onOpenChange,
		onCreated,
		onExplore,
		onImportFiles,
		onImportFolder
	}: Props = $props()

	let view = $state<DialogView>('picker')
	let name = $state('')
	let saving = $state(false)
	let error = $state<string | null>(null)

	function resetForm() {
		view = 'picker'
		name = ''
		error = null
		saving = false
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
			await invoke('save_dataset_with_files', {
				manifest: {
					name: name.trim(),
					description: null,
					version: '1.0.0',
					schema: 'net.biovault.datasets:1.0.0',
					author: null,
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

	async function chooseExplore() {
		handleOpenChange(false)
		await onExplore?.()
	}

	async function chooseImportFiles() {
		handleOpenChange(false)
		await onImportFiles?.()
	}

	async function chooseImportFolder() {
		handleOpenChange(false)
		await onImportFolder?.()
	}

	function handleKeydown(e: KeyboardEvent) {
		if (e.key === 'Enter' && !saving && view === 'blank-name') {
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
	<Dialog.Content class="max-w-2xl">
		{#if view === 'picker'}
			<Dialog.Header>
				<div class="flex items-center gap-3">
					<div class="flex size-10 items-center justify-center rounded-lg bg-primary/10">
						<PackageIcon class="size-5 text-primary" />
					</div>
					<div>
						<Dialog.Title>New Dataset</Dialog.Title>
						<Dialog.Description>
							Create one from scratch, stage files or a folder, or browse datasets in Explore
						</Dialog.Description>
					</div>
				</div>
			</Dialog.Header>

			<div class="space-y-2 py-4">
				<button
					type="button"
					onclick={() => {
						view = 'blank-name'
						error = null
					}}
					disabled={saving}
					class="flex w-full items-center gap-3 rounded-lg border bg-card p-3 text-left transition-all hover:bg-accent disabled:opacity-50"
				>
					<div class="flex size-9 items-center justify-center rounded-lg bg-muted text-muted-foreground">
						<PlusIcon class="size-4" />
					</div>
					<div class="flex-1">
						<div class="text-sm font-medium">New Dataset from Scratch</div>
						<div class="text-muted-foreground text-xs">Start with an empty dataset manifest</div>
					</div>
				</button>

				<button
					type="button"
					onclick={chooseImportFolder}
					disabled={saving}
					class="flex w-full items-center gap-3 rounded-lg border bg-card p-3 text-left transition-all hover:bg-accent disabled:opacity-50"
				>
					<div class="flex size-9 items-center justify-center rounded-lg bg-muted text-muted-foreground">
						<FolderOpenIcon class="size-4" />
					</div>
					<div class="flex-1">
						<div class="text-sm font-medium">New Dataset from Folder</div>
						<div class="text-muted-foreground text-xs">Stage a folder and open the dataset builder</div>
					</div>
				</button>

				<button
					type="button"
					onclick={chooseImportFiles}
					disabled={saving}
					class="flex w-full items-center gap-3 rounded-lg border bg-card p-3 text-left transition-all hover:bg-accent disabled:opacity-50"
				>
					<div class="flex size-9 items-center justify-center rounded-lg bg-muted text-muted-foreground">
						<UploadIcon class="size-4" />
					</div>
					<div class="flex-1">
						<div class="text-sm font-medium">New Dataset from Selected Files</div>
						<div class="text-muted-foreground text-xs">Pick files directly and open the dataset builder</div>
					</div>
				</button>

				<button
					type="button"
					onclick={chooseExplore}
					disabled={saving}
					class="flex w-full items-center gap-3 rounded-lg border bg-card p-3 text-left transition-all hover:bg-accent disabled:opacity-50"
				>
					<div class="flex size-9 items-center justify-center rounded-lg bg-muted text-muted-foreground">
						<PackageIcon class="size-4" />
					</div>
					<div class="flex-1">
						<div class="text-sm font-medium">Explore from BioVault Explorer Datasets</div>
						<div class="text-muted-foreground text-xs">Browse existing datasets in Explore</div>
					</div>
				</button>
			</div>

			<Dialog.Footer>
				<Dialog.Close class={buttonVariants({ variant: 'outline' })}>Cancel</Dialog.Close>
			</Dialog.Footer>
		{:else}
			<Dialog.Header>
				<div class="flex items-center gap-3">
					<button
						type="button"
						onclick={() => {
							view = 'picker'
							error = null
						}}
						class="flex size-10 items-center justify-center rounded-lg bg-muted transition-colors hover:bg-accent"
					>
						<ArrowLeftIcon class="size-5" />
					</button>
					<div>
						<Dialog.Title>New Dataset from Scratch</Dialog.Title>
						<Dialog.Description>Give your dataset a name</Dialog.Description>
					</div>
				</div>
			</Dialog.Header>

			<div class="py-4">
				<div class="space-y-2">
					<label for="dataset-name" class="text-sm font-medium">Dataset Name</label>
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
					<div class="bg-destructive/10 text-destructive mt-4 rounded-md px-3 py-2 text-sm">
						{error}
					</div>
				{/if}
			</div>

			<Dialog.Footer>
				<Dialog.Close class={buttonVariants({ variant: 'outline' })}>Cancel</Dialog.Close>
				<Button onclick={handleCreate} disabled={saving || !!nameError || !name.trim()}>
					{#if saving}
						Creating...
					{:else}
						Create
					{/if}
				</Button>
			</Dialog.Footer>
		{/if}
	</Dialog.Content>
</Dialog.Root>
