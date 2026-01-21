<script lang="ts">
	import PageHeader from '$lib/components/page-header.svelte'
</script>

<div class="flex h-full flex-col">
	<PageHeader title="Inbox" description="Messages and notifications" />

	<div class="flex-1 overflow-auto p-6">
		<p class="text-muted-foreground">Your messages will appear here.</p>
	</div>
</div>
