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
	<span class="truncate">{filename}</span>
{:else}
	<Tooltip.Provider delayDuration={0}>
		<Tooltip.Root>
			<Tooltip.Trigger class="flex items-center gap-1.5 text-destructive">
				<AlertTriangleIcon class="size-4 shrink-0" />
				<span class="truncate">{filename}</span>
			</Tooltip.Trigger>
			<Tooltip.Content>
				<p class="text-xs">File not found</p>
			</Tooltip.Content>
		</Tooltip.Root>
	</Tooltip.Provider>
{/if}
