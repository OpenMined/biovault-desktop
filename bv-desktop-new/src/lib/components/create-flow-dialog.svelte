<script lang="ts">
	import { invoke } from '@tauri-apps/api/core'
	import * as Dialog from '$lib/components/ui/dialog/index.js'
	import { Button, buttonVariants } from '$lib/components/ui/button/index.js'
	import { Input } from '$lib/components/ui/input/index.js'
	import { flowTemplates, templateColors, type FlowTemplate } from '$lib/data/flow-templates'
	import DnaIcon from '@lucide/svelte/icons/dna'
	import UserIcon from '@lucide/svelte/icons/user'
	import ScanEyeIcon from '@lucide/svelte/icons/scan-eye'
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
	let importingTemplate: string | null = $state(null)
	let error = $state<string | null>(null)
	let githubUrl = $state('')
	let blankName = $state('')

	function resetState() {
		view = 'picker'
		importing = false
		importingTemplate = null
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

	function getIcon(icon: FlowTemplate['icon']) {
		switch (icon) {
			case 'dna':
				return DnaIcon
			case 'user':
				return UserIcon
			case 'scan-eye':
				return ScanEyeIcon
		}
	}

	async function importTemplate(template: FlowTemplate) {
		importing = true
		importingTemplate = template.id
		error = null

		try {
			await invoke('import_pipeline_with_deps', {
				url: template.sourceUrl,
				nameOverride: null,
				overwrite: true,
			})
			handleOpenChange(false)
			onCreated?.()
		} catch (e) {
			error = e instanceof Error ? e.message : String(e)
		} finally {
			importing = false
			importingTemplate = null
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
			await invoke('import_pipeline_with_deps', {
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
			await invoke('create_pipeline', {
				request: {
					name: blankName.trim(),
					directory: null,
					pipelineFile: null,
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
							Choose a template to get started or import your own
						</Dialog.Description>
					</div>
				</div>
			</Dialog.Header>

			<div class="py-4 space-y-6">
				<!-- Template Pipelines -->
				<div>
					<h3 class="text-sm font-medium mb-3">Template Flows</h3>
					<div class="grid grid-cols-2 gap-3">
						{#each flowTemplates as template (template.id)}
							{@const Icon = getIcon(template.icon)}
							{@const colors = templateColors[template.color]}
							<button
								type="button"
								onclick={() => importTemplate(template)}
								disabled={importing}
								class="group relative flex items-center gap-3 rounded-xl border bg-card p-4 text-left transition-all hover:shadow-md hover:border-primary/20 disabled:opacity-50 disabled:cursor-not-allowed"
							>
								<div
									class="flex size-10 shrink-0 items-center justify-center rounded-lg bg-gradient-to-br {colors.gradient} text-white"
								>
									{#if importingTemplate === template.id}
										<LoaderIcon class="size-5 animate-spin" />
									{:else}
										<Icon class="size-5" />
									{/if}
								</div>
								<div class="flex-1 min-w-0">
									<div class="font-semibold text-sm">{template.name}</div>
									<div class="text-muted-foreground text-xs">{template.description}</div>
								</div>
							</button>
						{/each}
					</div>
				</div>

				<!-- Divider -->
				<div class="relative">
					<div class="absolute inset-0 flex items-center">
						<span class="w-full border-t"></span>
					</div>
					<div class="relative flex justify-center text-xs uppercase">
						<span class="bg-background px-2 text-muted-foreground">Or</span>
					</div>
				</div>

				<!-- Other Options -->
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
