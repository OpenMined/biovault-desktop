<script lang="ts">
	import FileIcon from '@lucide/svelte/icons/file'
	import AlertTriangleIcon from '@lucide/svelte/icons/triangle-alert'
	import LinkIcon from '@lucide/svelte/icons/link'
	import { cn } from '$lib/utils.js'

	let { filename, exists, isUrl = false } = $props<{ filename: string; exists: boolean; isUrl?: boolean }>()
</script>

<div class="flex items-center gap-2 max-w-full">
	<div
		class={cn(
			'flex size-8 shrink-0 items-center justify-center rounded-md',
			isUrl ? 'bg-primary/10 text-primary' : exists ? 'bg-muted' : 'bg-destructive/10 text-destructive'
		)}
	>
		{#if isUrl}
			<LinkIcon class="size-4" />
		{:else if exists}
			<FileIcon class="size-4" />
		{:else}
			<AlertTriangleIcon class="size-4" />
		{/if}
	</div>
	<div class="min-w-0 flex-1">
		<p
			class={cn(
				'text-sm truncate leading-tight',
				exists ? 'text-foreground font-medium' : 'text-destructive font-semibold'
			)}
			title={filename}
		>
			{filename}
		</p>
		{#if isUrl}
			<p class="text-[11px] text-muted-foreground font-medium leading-none mt-0.5">URL</p>
		{:else if !exists}
			<p class="text-[11px] text-destructive/80 font-medium leading-none mt-0.5">Missing</p>
		{/if}
	</div>
</div>
