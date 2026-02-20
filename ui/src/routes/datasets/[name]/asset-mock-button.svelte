<script lang="ts">
	import { Button } from '$lib/components/ui/button/index.js'
	import PlusIcon from '@lucide/svelte/icons/plus'
	import TrashIcon from '@lucide/svelte/icons/trash-2'

	let { assetId, hasMock, onSet, onRemove } = $props<{
		assetId: string
		hasMock: boolean
		onSet: (id: string) => void
		onRemove: (id: string) => void
	}>()
</script>

<div class="flex items-center gap-1">
	{#if hasMock}
		<Button variant="ghost" size="icon-sm" onclick={() => onRemove(assetId)} title="Remove mock">
			<TrashIcon class="size-3.5 text-muted-foreground hover:text-destructive transition-colors" />
		</Button>
	{:else}
		<Button
			variant="outline"
			size="sm"
			onclick={() => onSet(assetId)}
			class="h-7 gap-1 px-2 text-[11px]"
		>
			<PlusIcon class="size-3" />
			Add Mock
		</Button>
	{/if}
</div>
