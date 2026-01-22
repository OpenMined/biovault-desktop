<script lang="ts">
	import * as Sheet from '$lib/components/ui/sheet/index.js'
	import { buttonVariants } from '$lib/components/ui/button/index.js'
	import { Badge } from '$lib/components/ui/badge/index.js'
	import LibraryBigIcon from '@lucide/svelte/icons/library-big'
	import PlayCircleIcon from '@lucide/svelte/icons/play-circle'
	import BookOpenIcon from '@lucide/svelte/icons/book-open'
	import GraduationCapIcon from '@lucide/svelte/icons/graduation-cap'
	import ChevronRightIcon from '@lucide/svelte/icons/chevron-right'

	interface Props {
		open?: boolean
		onOpenChange?: (open: boolean) => void
	}

	let { open = $bindable(false), onOpenChange }: Props = $props()

	function handleOpenChange(newOpen: boolean) {
		open = newOpen
		onOpenChange?.(newOpen)
	}

	const tutorials = [
		{
			id: 'getting-started',
			title: 'Getting Started',
			description: 'Learn the basics of BioVault and set up your first project',
			duration: '5 min',
			icon: PlayCircleIcon,
			badge: 'Beginner',
		},
		{
			id: 'import-data',
			title: 'Importing Datasets',
			description: 'How to import and manage your genomic datasets',
			duration: '8 min',
			icon: BookOpenIcon,
			badge: 'Beginner',
		},
		{
			id: 'run-flow',
			title: 'Running Your First Flow',
			description: 'Execute a genetic analysis pipeline on your data',
			duration: '10 min',
			icon: PlayCircleIcon,
			badge: 'Beginner',
		},
		{
			id: 'create-flow',
			title: 'Creating Custom Flows',
			description: 'Build your own analysis workflows with the Flow spec',
			duration: '15 min',
			icon: GraduationCapIcon,
			badge: 'Advanced',
		},
		{
			id: 'collaborate',
			title: 'Collaboration Features',
			description: 'Share data and results securely with collaborators',
			duration: '12 min',
			icon: BookOpenIcon,
			badge: 'Intermediate',
		},
	]
</script>

<Sheet.Root bind:open onOpenChange={handleOpenChange}>
	<Sheet.Content side="right" class="w-[400px] sm:w-[450px]">
		<Sheet.Header>
			<div class="flex items-center gap-3">
				<div class="flex size-10 items-center justify-center rounded-lg bg-primary/10">
					<LibraryBigIcon class="size-5 text-primary" />
				</div>
				<div>
					<Sheet.Title>Learn</Sheet.Title>
					<Sheet.Description>Tutorials and documentation</Sheet.Description>
				</div>
			</div>
		</Sheet.Header>

		<div class="flex-1 overflow-y-auto py-4 -mx-6 px-6">
			<div class="space-y-2">
				{#each tutorials as tutorial (tutorial.id)}
					{@const Icon = tutorial.icon}
					<button
						type="button"
						class="w-full flex items-start gap-3 rounded-lg border p-3 text-left transition-all hover:bg-accent"
					>
						<div class="shrink-0 mt-0.5">
							<div class="flex size-8 items-center justify-center rounded-md bg-muted">
								<Icon class="size-4 text-muted-foreground" />
							</div>
						</div>
						<div class="flex-1 min-w-0">
							<div class="flex items-center gap-2">
								<span class="font-medium text-sm">{tutorial.title}</span>
								<Badge variant="secondary" class="text-xs">{tutorial.badge}</Badge>
							</div>
							<p class="text-muted-foreground text-xs mt-0.5 line-clamp-2">
								{tutorial.description}
							</p>
							<span class="text-xs text-muted-foreground/60 mt-1 block">
								{tutorial.duration}
							</span>
						</div>
						<ChevronRightIcon class="size-4 text-muted-foreground shrink-0 mt-1" />
					</button>
				{/each}
			</div>

			<div class="mt-6 pt-6 border-t">
				<h4 class="text-sm font-medium mb-3">Documentation</h4>
				<div class="space-y-2">
					<button
						type="button"
						class="flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground transition-colors"
					>
						<BookOpenIcon class="size-4" />
						Flow Spec Reference
					</button>
					<button
						type="button"
						class="flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground transition-colors"
					>
						<BookOpenIcon class="size-4" />
						API Documentation
					</button>
					<button
						type="button"
						class="flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground transition-colors"
					>
						<BookOpenIcon class="size-4" />
						FAQ
					</button>
				</div>
			</div>
		</div>

		<Sheet.Footer class="border-t pt-4">
			<Sheet.Close class={buttonVariants({ variant: 'outline', class: 'w-full' })}>
				Close
			</Sheet.Close>
		</Sheet.Footer>
	</Sheet.Content>
</Sheet.Root>
