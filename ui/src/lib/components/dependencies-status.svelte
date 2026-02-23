<script lang="ts">
	import { invoke } from '@tauri-apps/api/core'
	import { onMount } from 'svelte'
	import * as Popover from '$lib/components/ui/popover/index.js'
	import * as Tooltip from '$lib/components/ui/tooltip/index.js'
	import { Button } from '$lib/components/ui/button/index.js'
	import { Badge } from '$lib/components/ui/badge/index.js'
	import { Separator } from '$lib/components/ui/separator/index.js'
	import PackageIcon from '@lucide/svelte/icons/package'
	import CheckCircleIcon from '@lucide/svelte/icons/check-circle'
	import XCircleIcon from '@lucide/svelte/icons/x-circle'
	import AlertCircleIcon from '@lucide/svelte/icons/alert-circle'
	import RefreshCwIcon from '@lucide/svelte/icons/refresh-cw'
	import ExternalLinkIcon from '@lucide/svelte/icons/external-link'
	import Loader2Icon from '@lucide/svelte/icons/loader-2'

	interface Dependency {
		name: string
		found: boolean
		path?: string
		version?: string
		running?: boolean
	}

	interface DependencyCheckResult {
		dependencies: Dependency[]
		all_found: boolean
	}

	let loading = $state(true)
	let refreshing = $state(false)
	let dependencies = $state<Dependency[]>([])
	let allFound = $state(false)
	let popoverOpen = $state(false)

	// Count missing and warning dependencies
	const missingCount = $derived(dependencies.filter((d) => !d.found).length)
	const warningCount = $derived(
		dependencies.filter((d) => d.found && d.name.toLowerCase() === 'docker' && d.running === false)
			.length
	)
	const hasIssues = $derived(missingCount > 0 || warningCount > 0)

	async function checkDependencies() {
		try {
			const result = await invoke<DependencyCheckResult>('check_dependencies')
			dependencies = result.dependencies
			allFound = result.all_found
		} catch (e) {
			console.error('Failed to check dependencies:', e)
		}
	}

	async function refresh() {
		refreshing = true
		await checkDependencies()
		refreshing = false
	}

	function getStatusIcon(dep: Dependency) {
		if (!dep.found) return XCircleIcon
		if (dep.name.toLowerCase() === 'docker' && dep.running === false) return AlertCircleIcon
		return CheckCircleIcon
	}

	function getStatusColor(dep: Dependency): string {
		if (!dep.found) return 'text-destructive'
		if (dep.name.toLowerCase() === 'docker' && dep.running === false) return 'text-amber-500'
		return 'text-emerald-500'
	}

	function getStatusText(dep: Dependency): string {
		if (!dep.found) return 'Not installed'
		if (dep.name.toLowerCase() === 'docker' && dep.running === false) return 'Installed but not running'
		return dep.version || dep.path || 'Installed'
	}

	function getInstallUrl(name: string): string | null {
		const urls: Record<string, string> = {
			java: 'https://adoptium.net/',
			docker: 'https://www.docker.com/products/docker-desktop/',
			nextflow: 'https://www.nextflow.io/docs/latest/install.html',
			uv: 'https://docs.astral.sh/uv/getting-started/installation/'
		}
		return urls[name.toLowerCase()] || null
	}

	async function openUrl(url: string) {
		try {
			await invoke('open_url', { url })
		} catch {
			window.open(url, '_blank')
		}
	}

	onMount(async () => {
		await checkDependencies()
		loading = false
	})
</script>

<Popover.Root bind:open={popoverOpen}>
	<Tooltip.Root>
		<Popover.Trigger>
			{#snippet child({ props })}
				<Tooltip.Trigger
					{...props}
					class="text-primary-foreground/80 hover:text-primary-foreground rounded-md p-2 transition-colors relative"
				>
					<PackageIcon class="size-5" />
					{#if hasIssues}
						<span
							class="absolute -top-0.5 -right-0.5 flex size-4 items-center justify-center rounded-full {missingCount > 0
								? 'bg-destructive'
								: 'bg-amber-500'} text-white text-[10px] font-bold"
						>
							{missingCount + warningCount}
						</span>
					{/if}
				</Tooltip.Trigger>
			{/snippet}
		</Popover.Trigger>
		{#if !popoverOpen}
			<Tooltip.Content>
				<p>
					Dependencies
					{#if hasIssues}
						({missingCount + warningCount} {missingCount + warningCount === 1 ? 'issue' : 'issues'})
					{/if}
				</p>
			</Tooltip.Content>
		{/if}
	</Tooltip.Root>

	<Popover.Content class="w-80 p-0" align="end">
		<div class="p-4 pb-2">
			<div class="flex items-center justify-between">
				<h3 class="font-semibold">Dependencies</h3>
				<Button variant="ghost" size="icon" class="size-8" onclick={refresh} disabled={refreshing}>
					<RefreshCwIcon class="size-4 {refreshing ? 'animate-spin' : ''}" />
				</Button>
			</div>
			<p class="text-sm text-muted-foreground mt-1">
				{#if allFound}
					All dependencies are installed
				{:else if missingCount > 0}
					{missingCount} missing {missingCount === 1 ? 'dependency' : 'dependencies'}
				{:else if warningCount > 0}
					{warningCount} {warningCount === 1 ? 'issue' : 'issues'} detected
				{/if}
			</p>
		</div>

		<Separator />

		<div class="p-2">
			{#if loading}
				<div class="flex items-center justify-center py-8">
					<Loader2Icon class="size-6 animate-spin text-muted-foreground" />
				</div>
			{:else}
				<div class="space-y-1">
					{#each dependencies as dep (dep.name)}
						{@const StatusIcon = getStatusIcon(dep)}
						{@const installUrl = getInstallUrl(dep.name)}
						<div
							class="flex items-center justify-between rounded-md px-3 py-2 hover:bg-muted/50 transition-colors"
						>
							<div class="flex items-center gap-3">
								<StatusIcon class="size-4 {getStatusColor(dep)}" />
								<div>
									<p class="text-sm font-medium capitalize">{dep.name}</p>
									<p class="text-xs text-muted-foreground truncate max-w-[140px]">
										{getStatusText(dep)}
									</p>
								</div>
							</div>
							{#if !dep.found && installUrl}
								<Button
									variant="ghost"
									size="sm"
									class="h-7 text-xs"
									onclick={() => openUrl(installUrl)}
								>
									Install
									<ExternalLinkIcon class="size-3 ml-1" />
								</Button>
							{:else if dep.name.toLowerCase() === 'docker' && dep.found && dep.running === false}
								<Badge variant="outline" class="text-amber-600 border-amber-300">Start Docker</Badge>
							{:else if dep.found}
								<Badge variant="outline" class="text-emerald-600 border-emerald-300">Ready</Badge>
							{/if}
						</div>
					{/each}
				</div>
			{/if}
		</div>

		{#if missingCount > 0}
			<Separator />
			<div class="p-3">
				<p class="text-xs text-muted-foreground">
					Some features require these dependencies. Click "Install" to get started.
				</p>
			</div>
		{/if}
	</Popover.Content>
</Popover.Root>
