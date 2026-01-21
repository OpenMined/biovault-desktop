<script lang="ts">
	import PageHeader from '$lib/components/page-header.svelte'
	import { Button } from '$lib/components/ui/button/index.js'
	import PlusIcon from '@lucide/svelte/icons/plus'
</script>

<div class="flex h-full flex-col">
	<PageHeader title="Collaborate" description="Work together with your team">
		<Button size="sm">
			<PlusIcon class="size-4" />
			New Project
		</Button>
	</PageHeader>

	<div class="flex-1 overflow-auto p-6">
		<p class="text-muted-foreground">Your collaborative projects will appear here.</p>
	</div>
</div>
