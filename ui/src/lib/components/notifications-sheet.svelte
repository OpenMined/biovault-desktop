<script lang="ts">
	import * as Sheet from '$lib/components/ui/sheet/index.js'
	import { Button } from '$lib/components/ui/button/index.js'
	import { Badge } from '$lib/components/ui/badge/index.js'
	import {
		notificationsStore,
		markAsRead,
		markAllAsRead,
		removeNotification,
		clearAllNotifications,
		type Notification,
	} from '$lib/stores/notifications.svelte'
	import BellIcon from '@lucide/svelte/icons/bell'
	import CheckCircleIcon from '@lucide/svelte/icons/check-circle'
	import XCircleIcon from '@lucide/svelte/icons/x-circle'
	import InfoIcon from '@lucide/svelte/icons/info'
	import AlertTriangleIcon from '@lucide/svelte/icons/triangle-alert'
	import TrashIcon from '@lucide/svelte/icons/trash-2'
	import CheckIcon from '@lucide/svelte/icons/check'
	import XIcon from '@lucide/svelte/icons/x'
	import FilterIcon from '@lucide/svelte/icons/filter'

	interface Props {
		open?: boolean
		onOpenChange?: (open: boolean) => void
	}

	let { open = $bindable(false), onOpenChange }: Props = $props()
	let unreadOnly = $state(false)

	function handleOpenChange(newOpen: boolean) {
		open = newOpen
		onOpenChange?.(newOpen)
	}

	function getIcon(type: Notification['type']) {
		switch (type) {
			case 'success':
				return CheckCircleIcon
			case 'error':
				return XCircleIcon
			case 'warning':
				return AlertTriangleIcon
			default:
				return InfoIcon
		}
	}

	function getIconColor(type: Notification['type']) {
		switch (type) {
			case 'success':
				return 'text-green-500'
			case 'error':
				return 'text-red-500'
			case 'warning':
				return 'text-yellow-500'
			default:
				return 'text-blue-500'
		}
	}

	function formatTimestamp(date: Date): string {
		const now = new Date()
		const diffMs = now.getTime() - date.getTime()
		const diffMins = Math.floor(diffMs / 60000)
		const diffHours = Math.floor(diffMs / 3600000)
		const diffDays = Math.floor(diffMs / 86400000)

		if (diffMins < 1) return 'Just now'
		if (diffMins < 60) return `${diffMins}m ago`
		if (diffHours < 24) return `${diffHours}h ago`
		if (diffDays < 7) return `${diffDays}d ago`

		return date.toLocaleDateString(undefined, {
			month: 'short',
			day: 'numeric',
		})
	}

	function dayLabel(date: Date): string {
		const today = new Date()
		const base = new Date(today.getFullYear(), today.getMonth(), today.getDate())
		const target = new Date(date.getFullYear(), date.getMonth(), date.getDate())
		const diffDays = Math.round((base.getTime() - target.getTime()) / 86400000)

		if (diffDays === 0) return 'Today'
		if (diffDays === 1) return 'Yesterday'
		return target.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
	}

	const filteredNotifications = $derived.by(() =>
		unreadOnly ? notificationsStore.all.filter((n) => !n.read) : notificationsStore.all,
	)

	function handleNotificationClick(notification: Notification) {
		if (!notification.read) {
			markAsRead(notification.id)
		}
	}
</script>

<Sheet.Root bind:open onOpenChange={handleOpenChange}>
	<Sheet.Content side="right" class="!top-10 !bottom-0 !h-auto w-[420px] !m-0 rounded-l-2xl border-l bg-background p-0 shadow-xl sm:w-[500px]">
		<div class="flex h-full min-h-0 flex-col">
			<div class="shrink-0 border-b bg-muted/30 px-5 py-4">
				<div class="flex items-start justify-between gap-3">
					<div class="flex min-w-0 items-center gap-3">
						<div class="flex size-10 items-center justify-center rounded-xl bg-primary/10 text-primary">
							<BellIcon class="size-5" />
						</div>
						<div class="min-w-0">
							<Sheet.Title>Notifications</Sheet.Title>
							<Sheet.Description>
								{#if notificationsStore.unreadCount > 0}
									{notificationsStore.unreadCount} unread
								{:else}
									All caught up
								{/if}
							</Sheet.Description>
						</div>
					</div>
					<div class="flex items-center gap-2">
						<Button
							variant={unreadOnly ? 'default' : 'outline'}
							size="sm"
							class="h-8"
							onclick={() => (unreadOnly = !unreadOnly)}
						>
							<FilterIcon class="size-4" />
							Unread
						</Button>
						{#if notificationsStore.unreadCount > 0}
							<Button variant="outline" size="sm" class="h-8" onclick={markAllAsRead}>
								<CheckIcon class="size-4" />
								Read all
							</Button>
						{/if}
						{#if notificationsStore.all.length > 0}
							<Button variant="outline" size="sm" class="h-8 text-destructive" onclick={clearAllNotifications}>
								<TrashIcon class="size-4" />
								Clear
							</Button>
						{/if}
					</div>
				</div>
				<div class="mt-3 flex items-center justify-between text-xs text-muted-foreground">
					<span>{filteredNotifications.length} shown</span>
					<span>{notificationsStore.all.length} total</span>
				</div>
			</div>

			<div class="min-h-0 flex-1 overflow-y-auto px-4 py-4">
				{#if filteredNotifications.length === 0}
					<div class="flex h-full min-h-[280px] flex-col items-center justify-center rounded-2xl border border-dashed bg-muted/20 px-6 text-center">
						<BellIcon class="mb-3 size-10 text-muted-foreground/35" />
						<p class="text-sm text-muted-foreground">
							{unreadOnly ? 'No unread notifications' : 'No notifications yet'}
						</p>
						<p class="mt-1 text-xs text-muted-foreground/70">
							{unreadOnly
								? 'Try turning off the unread filter.'
								: "You'll see run and system updates here."}
						</p>
					</div>
				{:else}
					<div class="space-y-3">
						{#each filteredNotifications as notification, index (notification.id)}
							{@const Icon = getIcon(notification.type)}
							{@const showDay =
								index === 0 ||
								dayLabel(filteredNotifications[index - 1].timestamp) !== dayLabel(notification.timestamp)}
							{#if showDay}
								<div class="sticky top-0 z-10 py-1">
									<div class="mx-auto w-fit rounded-full border bg-background/95 px-2.5 py-0.5 text-[11px] font-medium text-muted-foreground shadow-sm">
										{dayLabel(notification.timestamp)}
									</div>
								</div>
							{/if}
						<div
							role="button"
							tabindex="0"
							onclick={() => handleNotificationClick(notification)}
							onkeydown={(e) => e.key === 'Enter' && handleNotificationClick(notification)}
								class="group w-full cursor-pointer rounded-xl border p-3 text-left transition-all hover:border-border hover:bg-muted/30 {!notification.read
									? 'border-emerald-300/70 bg-emerald-50/60'
									: 'bg-card'}"
						>
								<div class="mt-0.5 shrink-0">
								<Icon class="size-5 {getIconColor(notification.type)}" />
							</div>
								<div class="min-w-0 flex-1">
									<div class="flex items-start justify-between gap-2">
										<span class="text-sm font-medium {!notification.read ? '' : 'text-muted-foreground'}">
										{notification.title}
									</span>
										<span class="shrink-0 text-xs text-muted-foreground">
										{formatTimestamp(notification.timestamp)}
									</span>
								</div>
									<p class="mt-0.5 line-clamp-3 text-xs text-muted-foreground">
									{notification.message}
								</p>
									<div class="mt-2 flex items-center gap-2">
										{#if !notification.read}
											<Badge variant="secondary" class="text-[10px]">Unread</Badge>
										{/if}
									</div>
							</div>
							<button
								type="button"
								onclick={(e) => {
									e.stopPropagation()
									removeNotification(notification.id)
								}}
									class="shrink-0 rounded p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
							>
								<XIcon class="size-4" />
							</button>
						</div>
					{/each}
					</div>
				{/if}
			</div>

			<div class="shrink-0 border-t px-4 py-3">
				<Sheet.Close>
					<Button variant="outline" class="w-full">Close</Button>
				</Sheet.Close>
			</div>
				</div>
	</Sheet.Content>
</Sheet.Root>
