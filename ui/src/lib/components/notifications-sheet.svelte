<script lang="ts">
	import * as Sheet from '$lib/components/ui/sheet/index.js'
	import { Button, buttonVariants } from '$lib/components/ui/button/index.js'
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

	interface Props {
		open?: boolean
		onOpenChange?: (open: boolean) => void
	}

	let { open = $bindable(false), onOpenChange }: Props = $props()

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

	function handleNotificationClick(notification: Notification) {
		if (!notification.read) {
			markAsRead(notification.id)
		}
	}
</script>

<Sheet.Root bind:open onOpenChange={handleOpenChange}>
	<Sheet.Content side="right" class="!top-10 !bottom-0 !h-auto w-[400px] !m-0 rounded-l-xl border-l shadow-2xl sm:w-[450px]">
		<Sheet.Header>
			<div class="flex items-center justify-between">
				<div class="flex items-center gap-3">
					<div class="flex size-10 items-center justify-center rounded-lg bg-primary/10">
						<BellIcon class="size-5 text-primary" />
					</div>
					<div>
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
			</div>
		</Sheet.Header>

		<div class="flex items-center justify-between py-4 border-b">
			<span class="text-sm text-muted-foreground">
				{notificationsStore.all.length} notifications
			</span>
			<div class="flex gap-2">
				{#if notificationsStore.unreadCount > 0}
					<Button variant="ghost" size="sm" onclick={markAllAsRead}>
						<CheckIcon class="size-4" />
						Mark all read
					</Button>
				{/if}
				{#if notificationsStore.all.length > 0}
					<Button variant="ghost" size="sm" onclick={clearAllNotifications}>
						<TrashIcon class="size-4" />
						Clear all
					</Button>
				{/if}
			</div>
		</div>

		<div class="flex-1 overflow-y-auto py-4 -mx-6 px-6">
			{#if notificationsStore.all.length === 0}
				<div class="flex flex-col items-center justify-center py-12 text-center">
					<BellIcon class="size-12 text-muted-foreground/30 mb-4" />
					<p class="text-muted-foreground text-sm">No notifications yet</p>
					<p class="text-muted-foreground/60 text-xs mt-1">
						You'll be notified when flows complete
					</p>
				</div>
			{:else}
				<div class="space-y-2">
					{#each notificationsStore.all as notification (notification.id)}
						{@const Icon = getIcon(notification.type)}
						<div
							role="button"
							tabindex="0"
							onclick={() => handleNotificationClick(notification)}
							onkeydown={(e) => e.key === 'Enter' && handleNotificationClick(notification)}
							class="w-full flex items-start gap-3 rounded-lg border p-3 text-left transition-all hover:bg-accent cursor-pointer {!notification.read
								? 'bg-primary/5 border-primary/20'
								: ''}"
						>
							<div class="shrink-0 mt-0.5">
								<Icon class="size-5 {getIconColor(notification.type)}" />
							</div>
							<div class="flex-1 min-w-0">
								<div class="flex items-start justify-between gap-2">
									<span class="font-medium text-sm {!notification.read ? '' : 'text-muted-foreground'}">
										{notification.title}
									</span>
									<span class="text-xs text-muted-foreground shrink-0">
										{formatTimestamp(notification.timestamp)}
									</span>
								</div>
								<p class="text-muted-foreground text-xs mt-0.5 line-clamp-2">
									{notification.message}
								</p>
								{#if !notification.read}
									<Badge variant="secondary" class="mt-2 text-xs">New</Badge>
								{/if}
							</div>
							<button
								type="button"
								onclick={(e) => {
									e.stopPropagation()
									removeNotification(notification.id)
								}}
								class="shrink-0 p-1 rounded hover:bg-muted text-muted-foreground hover:text-foreground transition-colors"
							>
								<XIcon class="size-4" />
							</button>
						</div>
					{/each}
				</div>
			{/if}
		</div>

		<Sheet.Footer class="border-t pt-4">
			<Sheet.Close class={buttonVariants({ variant: 'outline', class: 'w-full' })}>
				Close
			</Sheet.Close>
		</Sheet.Footer>
	</Sheet.Content>
</Sheet.Root>
