<script lang="ts">
	import { invoke } from '@tauri-apps/api/core'
	import { Button } from '$lib/components/ui/button/index.js'
	import XIcon from '@lucide/svelte/icons/x'
	import FolderOpenIcon from '@lucide/svelte/icons/folder-open'

	interface Props {
		assetId: string
		assetPath: string
		exists: boolean
		onDelete: (id: string) => void
	}

	let { assetId, assetPath, exists, onDelete }: Props = $props()

	async function showInFolder() {
		try {
			await invoke('show_in_folder', { filePath: assetPath })
		} catch (e) {
			console.error('Failed to show in folder:', e)
		}
	}
</script>

<div class="flex items-center gap-1">
	<Button
		variant="ghost"
		size="icon-sm"
		onclick={showInFolder}
		disabled={!exists}
		class="text-muted-foreground hover:text-foreground disabled:opacity-30"
		title={exists ? 'Show in folder' : 'File not found'}
	>
		<FolderOpenIcon class="size-4" />
	</Button>
	<Button
		variant="ghost"
		size="icon-sm"
		onclick={() => onDelete(assetId)}
		class="text-muted-foreground hover:text-destructive"
		title="Remove from dataset"
	>
		<XIcon class="size-4" />
	</Button>
</div>
