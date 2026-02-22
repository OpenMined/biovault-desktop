<script lang="ts">
	import { goto } from '$app/navigation'
	import { invoke } from '@tauri-apps/api/core'
	import * as Dialog from '$lib/components/ui/dialog/index.js'
	import { Button, buttonVariants } from '$lib/components/ui/button/index.js'
	import { Input } from '$lib/components/ui/input/index.js'
	import WorkflowIcon from '@lucide/svelte/icons/workflow'
	import FolderOpenIcon from '@lucide/svelte/icons/folder-open'
	import GithubIcon from '@lucide/svelte/icons/github'
	import PlusIcon from '@lucide/svelte/icons/plus'
	import LoaderIcon from '@lucide/svelte/icons/loader'
	import ArrowLeftIcon from '@lucide/svelte/icons/arrow-left'

	interface Props {
		open?: boolean
		onOpenChange?: (open: boolean) => void
		onCreated?: () => void
	}

	let { open = $bindable(false), onOpenChange, onCreated }: Props = $props()

	type DialogView = 'picker' | 'github-url' | 'blank-name'

	let view: DialogView = $state('picker')
	let importing = $state(false)
	let error = $state<string | null>(null)
	let githubUrl = $state('')
	let blankName = $state('')

	function resetState() {
		view = 'picker'
		importing = false
		error = null
		githubUrl = ''
		blankName = ''
	}

	function handleOpenChange(newOpen: boolean) {
		open = newOpen
		onOpenChange?.(newOpen)
		if (!newOpen) {
			resetState()
		}
	}

	async function importFromGithub() {
		if (!githubUrl.trim()) {
			error = 'Please enter a GitHub URL'
			return
		}

		importing = true
		error = null

		try {
			await invoke('import_flow_with_deps', {
				url: githubUrl.trim(),
				nameOverride: null,
				overwrite: true,
			})
			handleOpenChange(false)
			onCreated?.()
		} catch (e) {
			error = e instanceof Error ? e.message : String(e)
		} finally {
			importing = false
		}
	}

	async function createBlankFlow() {
		if (!blankName.trim()) {
			error = 'Flow name is required'
			return
		}

		if (!/^[a-z0-9_-]+$/.test(blankName)) {
			error = 'Use lowercase letters, numbers, hyphens, and underscores only'
			return
		}

		importing = true
		error = null

		try {
			await invoke('create_flow', {
				request: {
					name: blankName.trim(),
					directory: null,
					flowFile: null,
					overwrite: false,
				},
			})
			handleOpenChange(false)
			onCreated?.()
		} catch (e) {
			error = e instanceof Error ? e.message : String(e)
		} finally {
			importing = false
		}
	}

	function handleKeydown(e: KeyboardEvent) {
		if (e.key === 'Enter' && !importing) {
			e.preventDefault()
			if (view === 'github-url') {
				importFromGithub()
			} else if (view === 'blank-name') {
				createBlankFlow()
			}
		}
	}

	async function goToExplorer() {
		handleOpenChange(false)
		await goto('/explore')
	}
</script>

<Dialog.Root bind:open onOpenChange={handleOpenChange}>
	<Dialog.Content class="max-w-2xl">
		{#if view === 'picker'}
			<Dialog.Header>
				<div class="flex items-center gap-3">
					<div class="flex size-10 items-center justify-center rounded-lg bg-primary/10">
						<WorkflowIcon class="size-5 text-primary" />
					</div>
					<div>
						<Dialog.Title>New Flow</Dialog.Title>
						<Dialog.Description>
							Create a new flow, import one from GitHub, or find existing flows in Explore
						</Dialog.Description>
					</div>
				</div>
			</Dialog.Header>

			<div class="py-4 space-y-2">
				<div class="space-y-2">
					<button
						type="button"
						onclick={() => (view = 'github-url')}
						disabled={importing}
						class="flex w-full items-center gap-3 rounded-lg border bg-card p-3 text-left transition-all hover:bg-accent disabled:opacity-50"
					>
						<div
							class="flex size-9 items-center justify-center rounded-lg bg-muted text-muted-foreground"
						>
							<GithubIcon class="size-4" />
						</div>
						<div class="flex-1">
							<div class="font-medium text-sm">Import from GitHub</div>
							<div class="text-muted-foreground text-xs">Import a flow from a GitHub repository</div>
						</div>
					</button>

					<button
						type="button"
						onclick={() => (view = 'blank-name')}
						disabled={importing}
						class="flex w-full items-center gap-3 rounded-lg border bg-card p-3 text-left transition-all hover:bg-accent disabled:opacity-50"
					>
						<div
							class="flex size-9 items-center justify-center rounded-lg bg-muted text-muted-foreground"
						>
							<PlusIcon class="size-4" />
						</div>
						<div class="flex-1">
							<div class="font-medium text-sm">Create Blank Flow</div>
							<div class="text-muted-foreground text-xs">Start with an empty flow configuration</div>
						</div>
					</button>

					<button
						type="button"
						onclick={goToExplorer}
						disabled={importing}
						class="flex w-full items-center gap-3 rounded-lg border bg-card p-3 text-left transition-all hover:bg-accent disabled:opacity-50"
					>
						<div
							class="flex size-9 items-center justify-center rounded-lg bg-muted text-muted-foreground"
						>
							<FolderOpenIcon class="size-4" />
						</div>
						<div class="flex-1">
							<div class="font-medium text-sm">Find in BioVault Explorer</div>
							<div class="text-muted-foreground text-xs">
								Browse and install existing flows from Explore
							</div>
						</div>
					</button>
				</div>

				{#if error}
					<div class="bg-destructive/10 text-destructive text-sm rounded-md px-3 py-2">
						{error}
					</div>
				{/if}
			</div>

			<Dialog.Footer>
				<Dialog.Close class={buttonVariants({ variant: 'outline' })}>Cancel</Dialog.Close>
			</Dialog.Footer>
		{:else if view === 'github-url'}
			<Dialog.Header>
				<div class="flex items-center gap-3">
					<button
						type="button"
						onclick={() => {
							view = 'picker'
							error = null
						}}
						class="flex size-10 items-center justify-center rounded-lg bg-muted hover:bg-accent transition-colors"
					>
						<ArrowLeftIcon class="size-5" />
					</button>
					<div>
						<Dialog.Title>Import from GitHub</Dialog.Title>
						<Dialog.Description>
							Enter the URL to a flow.yaml file on GitHub
						</Dialog.Description>
					</div>
				</div>
			</Dialog.Header>

			<div class="py-4">
				<div class="space-y-2">
					<label for="github-url" class="text-sm font-medium">GitHub URL</label>
					<Input
						id="github-url"
						bind:value={githubUrl}
						placeholder="https://github.com/owner/repo/blob/main/flow.yaml"
						onkeydown={handleKeydown}
						autofocus
					/>
					<p class="text-muted-foreground text-xs">
						Link to a flow.yaml or pipeline.yaml file in a GitHub repository
					</p>
				</div>

				{#if error}
					<div class="mt-4 bg-destructive/10 text-destructive text-sm rounded-md px-3 py-2">
						{error}
					</div>
				{/if}
			</div>

			<Dialog.Footer>
				<Dialog.Close class={buttonVariants({ variant: 'outline' })}>Cancel</Dialog.Close>
				<Button onclick={importFromGithub} disabled={importing || !githubUrl.trim()}>
					{#if importing}
						<LoaderIcon class="size-4 animate-spin" />
						Importing...
					{:else}
						Import
					{/if}
				</Button>
			</Dialog.Footer>
		{:else if view === 'blank-name'}
			<Dialog.Header>
				<div class="flex items-center gap-3">
					<button
						type="button"
						onclick={() => {
							view = 'picker'
							error = null
						}}
						class="flex size-10 items-center justify-center rounded-lg bg-muted hover:bg-accent transition-colors"
					>
						<ArrowLeftIcon class="size-5" />
					</button>
					<div>
						<Dialog.Title>Create Blank Flow</Dialog.Title>
						<Dialog.Description>Give your new flow a name</Dialog.Description>
					</div>
				</div>
			</Dialog.Header>

			<div class="py-4">
				<div class="space-y-2">
					<label for="flow-name" class="text-sm font-medium">Flow Name</label>
					<Input
						id="flow-name"
						bind:value={blankName}
						placeholder="e.g., my-analysis-flow"
						autocapitalize="off"
						autocorrect="off"
						spellcheck="false"
						onkeydown={handleKeydown}
						autofocus
					/>
					<p class="text-muted-foreground text-xs">
						Lowercase letters, numbers, hyphens, and underscores only
					</p>
				</div>

				{#if error}
					<div class="mt-4 bg-destructive/10 text-destructive text-sm rounded-md px-3 py-2">
						{error}
					</div>
				{/if}
			</div>

			<Dialog.Footer>
				<Dialog.Close class={buttonVariants({ variant: 'outline' })}>Cancel</Dialog.Close>
				<Button onclick={createBlankFlow} disabled={importing || !blankName.trim()}>
					{#if importing}
						<LoaderIcon class="size-4 animate-spin" />
						Creating...
					{:else}
						Create
					{/if}
				</Button>
			</Dialog.Footer>
		{/if}
	</Dialog.Content>
</Dialog.Root>
