<script lang="ts">
	import { goto } from '$app/navigation'
	import { page } from '$app/state'
	import { onMount } from 'svelte'

	onMount(() => {
		const tab = page.url.searchParams.get('tab')
		const target = `/collaborate/sessions/${encodeURIComponent(page.params.sessionId)}${tab ? `?tab=${encodeURIComponent(tab)}` : ''}`
		goto(target, { replaceState: true })
	})
</script>
