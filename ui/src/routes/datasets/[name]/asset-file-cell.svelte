<script lang="ts">
	import AlertTriangleIcon from '@lucide/svelte/icons/triangle-alert'
	import * as Tooltip from '$lib/components/ui/tooltip/index.js'

	interface Props {
		filename: string
		exists: boolean
	}

	let { filename, exists }: Props = $props()
</script>

{#if exists}
	<div class="min-w-0 max-w-full">
		<span class="block truncate" title={filename}>{filename}</span>
	</div>
{:else}
	<Tooltip.Provider delayDuration={0}>
		<Tooltip.Root>
			<Tooltip.Trigger class="flex min-w-0 max-w-full items-center gap-1.5 text-destructive">
				<AlertTriangleIcon class="size-4 shrink-0" />
				<span class="block min-w-0 truncate" title={filename}>{filename}</span>
			</Tooltip.Trigger>
			<Tooltip.Content>
				<p class="text-xs">File not found</p>
			</Tooltip.Content>
		</Tooltip.Root>
	</Tooltip.Provider>
{/if}
