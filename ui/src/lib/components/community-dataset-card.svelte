<script lang="ts">
	import * as Card from '$lib/components/ui/card/index.js'
	import * as Avatar from '$lib/components/ui/avatar/index.js'
	import { Button } from '$lib/components/ui/button/index.js'
	import RequestRunDialog from '$lib/components/request-run-dialog.svelte'
	import { getAvatarToneClass } from '$lib/utils.js'
	import StarIcon from '@lucide/svelte/icons/star'
	import DownloadIcon from '@lucide/svelte/icons/download'
	import FileIcon from '@lucide/svelte/icons/file'
	import RocketIcon from '@lucide/svelte/icons/rocket'
	import Loader2Icon from '@lucide/svelte/icons/loader-2'

	interface Props {
		name: string
		owner: string
		description?: string
		totalAssets: number
		presentAssets?: number
		expectedBytes?: number
		downloadedBytes?: number
		available?: boolean
		starred?: boolean
		pinning?: boolean
		unpinning?: boolean
		showVerifyMock?: boolean
		onVerifyMock?: () => void
		onStar?: () => void
		onUnstar?: () => void
		onOpen?: () => void
	}

	let {
		name,
		owner,
		description = '',
		totalAssets,
		presentAssets = 0,
		expectedBytes,
		downloadedBytes = 0,
		available = false,
		starred = false,
		pinning = false,
		unpinning = false,
		showVerifyMock = false,
		onVerifyMock,
		onStar,
		onUnstar,
		onOpen,
	}: Props = $props()

	let requestDialogOpen = $state(false)

	function getInitials(email: string): string {
		return email.substring(0, 2).toUpperCase()
	}

	function formatFileSize(bytes: number): string {
		if (bytes <= 0) return '0 B'
		const k = 1024
		const sizes = ['B', 'KB', 'MB', 'GB']
		const i = Math.floor(Math.log(bytes) / Math.log(k))
		return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`
	}

	function runOrNoop(handler?: () => void) {
		handler?.()
	}
</script>

<Card.Root
	class="rounded-lg border bg-card p-4 transition-colors {onOpen ? 'hover:border-primary/40 cursor-pointer' : 'hover:border-primary/40'}"
	onclick={() => runOrNoop(onOpen)}
>
	<div class="space-y-3">
		<div class="flex items-start justify-between gap-3">
			<div class="flex items-center gap-2.5 min-w-0">
				<Avatar.Root class="size-9">
					<Avatar.Fallback class={getAvatarToneClass(owner)}>{getInitials(owner)}</Avatar.Fallback>
				</Avatar.Root>
				<div class="min-w-0">
					<Card.Title class="truncate text-sm">{name}</Card.Title>
					<p class="truncate text-xs text-muted-foreground" title={owner}>{owner}</p>
				</div>
			</div>
			<div class="shrink-0 text-[11px] text-muted-foreground">
				{#if available}
					<span class="inline-flex items-center gap-1">
						<DownloadIcon class="size-3" />
						Available
					</span>
				{:else}
					<span>{presentAssets}/{totalAssets} synced</span>
				{/if}
			</div>
		</div>
		{#if description}
			<p class="line-clamp-2 min-h-9 text-sm text-muted-foreground">{description}</p>
		{/if}
		<div class="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
			<span class="inline-flex items-center gap-1">
				<FileIcon class="size-3" />
				{totalAssets} files
			</span>
			{#if expectedBytes || downloadedBytes}
				<span class="flex items-center gap-1">
					{formatFileSize(expectedBytes || downloadedBytes)}
				</span>
			{/if}
		</div>
		<div class="mt-1 flex items-center gap-2 pt-2 border-t">
			<Button
				variant="outline"
				size="sm"
				class="h-8 flex-1 text-xs"
				onclick={(event) => {
					event.stopPropagation()
					requestDialogOpen = true
				}}
			>
				Request Run
			</Button>
			{#if showVerifyMock}
				<Button
					variant="outline"
					size="sm"
					class="h-8 text-xs"
					onclick={(event) => {
						event.stopPropagation()
						runOrNoop(onVerifyMock)
					}}
				>
					<RocketIcon class="size-3 mr-1" />
					Run Mock
				</Button>
			{/if}
			{#if onStar || onUnstar}
				{#if starred}
					<Button
					variant="secondary"
					size="sm"
					class="h-8 w-8 p-0"
					disabled={unpinning}
					onclick={(event) => {
						event.stopPropagation()
							runOrNoop(onUnstar)
						}}
					>
						{#if unpinning}
							<Loader2Icon class="size-3 animate-spin" />
						{:else}
							<StarIcon class="size-3.5 fill-foreground text-foreground" />
						{/if}
					</Button>
				{:else}
					<Button
						variant="outline"
						size="sm"
						class="h-8 w-8 p-0"
						disabled={pinning}
						onclick={(event) => {
							event.stopPropagation()
							runOrNoop(onStar)
						}}
					>
						{#if pinning}
							<Loader2Icon class="size-3 animate-spin" />
						{:else}
							<StarIcon class="size-3.5" />
						{/if}
					</Button>
				{/if}
			{/if}
		</div>
	</div>
</Card.Root>

<RequestRunDialog bind:open={requestDialogOpen} datasetName={name} authorEmail={owner} />
