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
	import FlaskConicalIcon from '@lucide/svelte/icons/flask-conical'
	import LoaderCircleIcon from '@lucide/svelte/icons/loader-circle'

	interface Props {
		open?: boolean
		onOpenChange?: (open: boolean) => void
		onCreated?: (name: string) => void
		onExplore?: () => void | Promise<void>
		onImportFiles?: () => void | Promise<void>
		onImportFolder?: () => void | Promise<void>
		onImportSampleData?: (paths: string[]) => void | Promise<void>
	}

	type DialogView = 'picker' | 'blank-name' | 'sample-data' | 'import-data'

	interface SampleDatasetOption {
		id: string
		title: string
		description: string
		tag: string
	}

	const sampleDatasetOptions: SampleDatasetOption[] = [
		{
			id: 'dynamic-dna',
			title: 'Dynamic DNA Genotype (Build 38)',
			description: '100001_X_X_GSAv3-DTC_GRCh38-07-01-2025.txt',
			tag: 'Genotype',
		},
		{
			id: '23andme',
			title: '23andMe Genotype (v4 Full)',
			description: 'genome_Zeeshan_Usamani_v4_Full.txt',
			tag: 'Genotype',
		},
		{
			id: 'na06985-chry',
			title: 'NA06985 chrY (CRAM + Reference)',
			description: 'Chromosome Y aligned CRAM with matching GRCh38 chrY reference',
			tag: 'Raw + Reference',
		},
		{
			id: 'na06985-full',
			title: 'NA06985 (Full CRAM + Reference)',
			description: 'High coverage CRAM with full GRCh38 reference (~20GB)',
			tag: 'Large Download',
		},
		{
			id: 'clinvar-grch38',
			title: 'ClinVar Database (GRCh38)',
			description: 'NCBI ClinVar variant annotations for clinical significance',
			tag: 'Variant Database',
		},
		{
			id: 'clinvar-grch37',
			title: 'ClinVar Database (GRCh37)',
			description: 'NCBI ClinVar variant annotations for clinical significance',
			tag: 'Variant Database',
		},
	]

	let {
		open = $bindable(false),
		onOpenChange,
		onCreated,
		onExplore,
		onImportFiles,
		onImportFolder,
		onImportSampleData
	}: Props = $props()

	let view = $state<DialogView>('picker')
	let name = $state('')
	let saving = $state(false)
	let loadingSampleId = $state<string | null>(null)
	let error = $state<string | null>(null)

	function resetForm() {
		view = 'picker'
		name = ''
		error = null
		saving = false
		loadingSampleId = null
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

	async function chooseSampleData(sampleId: string) {
		loadingSampleId = sampleId
		error = null

		try {
			const existingPath = await invoke<string | null>('check_sample_downloaded', { sampleId })
			const samplePath =
				existingPath ||
				(await invoke<{ sample_dir?: string; sampleDir?: string }>('fetch_sample_data_with_progress', {
					samples: [sampleId],
				}).then((result) => result?.sample_dir || result?.sampleDir || null))

			if (!samplePath) {
				throw new Error('Sample data downloaded, but no importable folder was returned')
			}

			handleOpenChange(false)
			await onImportSampleData?.([samplePath])
		} catch (e) {
			error = e instanceof Error ? e.message : String(e)
		} finally {
			loadingSampleId = null
		}
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
					onclick={() => {
						view = 'import-data'
						error = null
					}}
					disabled={saving || !!loadingSampleId}
					class="flex w-full items-center gap-3 rounded-lg border bg-card p-3 text-left transition-all hover:bg-accent disabled:opacity-50"
				>
					<div class="flex size-9 items-center justify-center rounded-lg bg-muted text-muted-foreground">
						<FolderOpenIcon class="size-4" />
					</div>
					<div class="flex-1">
						<div class="text-sm font-medium">Import Data into a New Dataset</div>
						<div class="text-muted-foreground text-xs">
							Choose files or a folder, then open the dataset builder
						</div>
					</div>
				</button>

				<button
					type="button"
					onclick={() => {
						view = 'sample-data'
						error = null
					}}
					disabled={saving || !!loadingSampleId}
					class="flex w-full items-center gap-3 rounded-lg border bg-card p-3 text-left transition-all hover:bg-accent disabled:opacity-50"
				>
					<div class="flex size-9 items-center justify-center rounded-lg bg-muted text-muted-foreground">
						<FlaskConicalIcon class="size-4" />
					</div>
					<div class="flex-1">
						<div class="text-sm font-medium">New Dataset from Sample Data</div>
						<div class="text-muted-foreground text-xs">
							Download one of the BioVault sample datasets and stage it automatically
						</div>
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
		{:else if view === 'import-data'}
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
						<Dialog.Title>Import Data</Dialog.Title>
						<Dialog.Description>
							Choose whether to stage selected files or a folder for a new dataset.
						</Dialog.Description>
					</div>
				</div>
			</Dialog.Header>

			<div class="space-y-2 py-4">
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
						<div class="text-sm font-medium">Choose Folder</div>
						<div class="text-muted-foreground text-xs">
							Stage a folder and open the dataset builder
						</div>
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
						<div class="text-sm font-medium">Choose Files</div>
						<div class="text-muted-foreground text-xs">
							Pick files directly and open the dataset builder
						</div>
					</div>
				</button>
			</div>

			<Dialog.Footer>
				<Dialog.Close class={buttonVariants({ variant: 'outline' })}>Cancel</Dialog.Close>
			</Dialog.Footer>
		{:else if view === 'sample-data'}
			<Dialog.Header>
				<div class="flex items-center gap-3">
					<button
						type="button"
						onclick={() => {
							view = 'picker'
							error = null
						}}
						class="flex size-10 items-center justify-center rounded-lg bg-muted transition-colors hover:bg-accent"
						disabled={!!loadingSampleId}
					>
						<ArrowLeftIcon class="size-5" />
					</button>
					<div>
						<Dialog.Title>New Dataset from Sample Data</Dialog.Title>
						<Dialog.Description>
							Choose from the existing sample-data presets. Each selection downloads if needed, then opens the dataset builder with that folder staged.
						</Dialog.Description>
					</div>
				</div>
			</Dialog.Header>

			<div class="space-y-2 py-4">
				{#each sampleDatasetOptions as option}
					<button
						type="button"
						onclick={() => chooseSampleData(option.id)}
						disabled={!!loadingSampleId}
						class="flex w-full items-center gap-3 rounded-lg border bg-card p-3 text-left transition-all hover:bg-accent disabled:opacity-50"
					>
						<div class="flex size-9 items-center justify-center rounded-lg bg-muted text-muted-foreground">
							{#if loadingSampleId === option.id}
								<LoaderCircleIcon class="size-4 animate-spin" />
							{:else}
								<FlaskConicalIcon class="size-4" />
							{/if}
						</div>
						<div class="min-w-0 flex-1">
							<div class="flex items-center gap-2">
								<div class="text-sm font-medium">{option.title}</div>
								<span class="bg-muted text-muted-foreground rounded-full px-2 py-0.5 text-[11px]">
									{option.tag}
								</span>
							</div>
							<div class="text-muted-foreground text-xs">{option.description}</div>
						</div>
					</button>
				{/each}

				{#if error}
					<div class="bg-destructive/10 text-destructive rounded-md px-3 py-2 text-sm">
						{error}
					</div>
				{/if}
			</div>

			<Dialog.Footer>
				<Dialog.Close class={buttonVariants({ variant: 'outline' })} disabled={!!loadingSampleId}>
					Cancel
				</Dialog.Close>
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
