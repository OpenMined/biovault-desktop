<script lang="ts">
	import type { Snippet } from 'svelte'

	interface Props {
		title: string
		description?: string
		children?: Snippet
	}

	let { title, description, children }: Props = $props()
</script>

<div class="flex items-center justify-between border-b px-6 py-4">
	<div>
		<h1 class="text-2xl font-semibold tracking-tight">{title}</h1>
		{#if description}
			<p class="text-muted-foreground text-sm">{description}</p>
		{/if}
	</div>
	{#if children}
		<div class="flex items-center gap-2">
			{@render children()}
		</div>
	{/if}
</div>
