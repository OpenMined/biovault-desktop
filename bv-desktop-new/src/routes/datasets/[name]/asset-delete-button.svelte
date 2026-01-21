<script lang="ts">
	import { Button } from '$lib/components/ui/button/index.js'
	import TrashIcon from '@lucide/svelte/icons/trash-2'

	interface Props {
		assetId: string
		onDelete: (id: string) => void
	}

	let { assetId, onDelete }: Props = $props()
</script>

<Button
	variant="ghost"
	size="icon-sm"
	onclick={() => onDelete(assetId)}
	class="text-muted-foreground hover:text-destructive"
>
	<TrashIcon class="size-4" />
</Button>
