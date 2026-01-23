<script lang="ts">
	import './layout.css'
	import { onMount } from 'svelte'
	import { invoke } from '@tauri-apps/api/core'
	import { listen } from '@tauri-apps/api/event'
	import { getVersion } from '@tauri-apps/api/app'
	import * as Sidebar from '$lib/components/ui/sidebar/index.js'
	import * as Tooltip from '$lib/components/ui/tooltip/index.js'
	import * as Drawer from '$lib/components/ui/drawer/index.js'
	import { Toaster } from '$lib/components/ui/sonner/index.js'
	import { toast } from 'svelte-sonner'
	import AppSidebar from '$lib/components/app-sidebar.svelte'
	import SqlPanel from '$lib/components/sql-panel.svelte'
	import LogsPanel from '$lib/components/logs-panel.svelte'
	import NotificationsSheet from '$lib/components/notifications-sheet.svelte'
	import LearnSheet from '$lib/components/learn-sheet.svelte'
	import SupportDialog from '$lib/components/support-dialog.svelte'
	import InviteDialog from '$lib/components/invite-dialog.svelte'
	import SyftboxPanel from '$lib/components/syftbox-panel.svelte'
	import AiAssistant from '$lib/components/ai-assistant.svelte'
	import DependenciesStatus from '$lib/components/dependencies-status.svelte'
	import { addNotification, notificationsStore } from '$lib/stores/notifications.svelte'
	import SquareTerminalIcon from '@lucide/svelte/icons/square-terminal'
	import DatabaseIcon from '@lucide/svelte/icons/database'
	import FolderSyncIcon from '@lucide/svelte/icons/folder-sync'
	import LibraryBigIcon from '@lucide/svelte/icons/library-big'
	import BellIcon from '@lucide/svelte/icons/bell'
	import CircleHelpIcon from '@lucide/svelte/icons/circle-help'
	import UserPlusIcon from '@lucide/svelte/icons/user-plus'

	let { children } = $props()
	let sqlOpen = $state(false)
	let logsOpen = $state(false)
	let syftboxOpen = $state(false)
	let notificationsOpen = $state(false)
	let learnOpen = $state(false)
	let supportOpen = $state(false)
	let inviteOpen = $state(false)
	let appVersion = $state('')

	// Send native system notification
	async function sendNativeNotification(title: string, body: string) {
		try {
			// Try AppleScript notification first (most reliable on macOS)
			await invoke('send_notification_applescript', { title, body })
		} catch {
			// Fallback to mac-notification-sys
			try {
				await invoke('send_native_notification', { title, body })
			} catch {
				// Silent fallback - toast notification already shown
			}
		}
	}

	onMount(() => {
		// Get app version
		getVersion().then((v) => (appVersion = v)).catch(() => {})

		// Listen for pipeline completion events
		const unlistenPromise = listen<string>('pipeline-complete', (event) => {
			const status = event.payload

			if (status === 'success') {
				// Add to notification store
				addNotification('Flow Completed', 'Your flow has completed successfully.', 'success')

				// Show toast
				toast.success('Flow completed successfully')

				// Send native notification
				sendNativeNotification('Flow Completed', 'Your flow has completed successfully.')
			} else if (status === 'failed') {
				// Add to notification store
				addNotification('Flow Failed', 'Your flow encountered an error.', 'error')

				// Show toast
				toast.error('Flow failed')

				// Send native notification
				sendNativeNotification('Flow Failed', 'Your flow encountered an error.')
			}
		})

		return () => {
			unlistenPromise.then((unlisten) => unlisten())
		}
	})
</script>

<Sidebar.Provider class="!min-h-0">
	<div class="flex h-screen w-screen flex-col">
		<!-- Full-width header/titlebar at top -->
		<header
			data-tauri-drag-region
			class="bg-primary fixed top-0 left-0 right-0 z-20 flex h-12 shrink-0 items-center justify-between border-b border-primary/80 px-4"
		>
			<div class="ps-20 flex items-center gap-2">
				<span class="text-primary-foreground font-bold text-base">BioVault Desktop</span>
				{#if appVersion}
					<span class="text-primary-foreground/60 text-xs">v{appVersion}</span>
				{/if}
			</div>
			<Tooltip.Provider delayDuration={0}>
				<div class="flex items-center gap-1">
					<DependenciesStatus />

					<Drawer.Root bind:open={logsOpen}>
						<Tooltip.Root>
							<Drawer.Trigger>
								{#snippet child({ props })}
									<Tooltip.Trigger
										{...props}
										class="text-primary-foreground/80 hover:text-primary-foreground rounded-md p-2 transition-colors"
									>
										<SquareTerminalIcon class="size-5" />
									</Tooltip.Trigger>
								{/snippet}
							</Drawer.Trigger>
							<Tooltip.Content>
								<p>Logs</p>
							</Tooltip.Content>
						</Tooltip.Root>
						<Drawer.Content class="!max-h-[85vh] h-[85vh]">
							<div class="h-full px-6 pb-8 pt-4">
								{#if logsOpen}
									<LogsPanel mode="sheet" />
								{/if}
							</div>
						</Drawer.Content>
					</Drawer.Root>

					<Drawer.Root bind:open={sqlOpen}>
						<Tooltip.Root>
							<Drawer.Trigger>
								{#snippet child({ props })}
									<Tooltip.Trigger
										{...props}
										class="text-primary-foreground/80 hover:text-primary-foreground rounded-md p-2 transition-colors"
									>
										<DatabaseIcon class="size-5" />
									</Tooltip.Trigger>
								{/snippet}
							</Drawer.Trigger>
							<Tooltip.Content>
								<p>SQL Console</p>
							</Tooltip.Content>
						</Tooltip.Root>
						<Drawer.Content class="!max-h-[95vh] h-[95vh]">
							<div class="h-full px-6 pb-8 pt-4">
								{#if sqlOpen}
									<SqlPanel mode="sheet" />
								{/if}
							</div>
						</Drawer.Content>
					</Drawer.Root>

					<Drawer.Root bind:open={syftboxOpen}>
						<Tooltip.Root>
							<Drawer.Trigger>
								{#snippet child({ props })}
									<Tooltip.Trigger
										{...props}
										class="text-primary-foreground/80 hover:text-primary-foreground rounded-md p-2 transition-colors"
									>
										<FolderSyncIcon class="size-5" />
									</Tooltip.Trigger>
								{/snippet}
							</Drawer.Trigger>
							<Tooltip.Content>
								<p>SyftBox Sync</p>
							</Tooltip.Content>
						</Tooltip.Root>
						<Drawer.Content class="!max-h-[85vh] h-[85vh]">
							<div class="h-full px-6 pb-8 pt-4">
								{#if syftboxOpen}
									<SyftboxPanel mode="sheet" />
								{/if}
							</div>
						</Drawer.Content>
					</Drawer.Root>

					<Tooltip.Root>
						<Tooltip.Trigger
							class="text-primary-foreground/80 hover:text-primary-foreground rounded-md p-2 transition-colors"
							onclick={() => (learnOpen = true)}
						>
							<LibraryBigIcon class="size-5" />
						</Tooltip.Trigger>
						<Tooltip.Content>
							<p>Learn</p>
						</Tooltip.Content>
					</Tooltip.Root>

					<!-- Notifications Bell with Badge -->
					<Tooltip.Root>
						<Tooltip.Trigger
							class="text-primary-foreground/80 hover:text-primary-foreground rounded-md p-2 transition-colors relative"
							onclick={() => (notificationsOpen = true)}
						>
							<BellIcon class="size-5" />
							{#if notificationsStore.unreadCount > 0}
								<span
									class="absolute -top-0.5 -right-0.5 flex size-5 items-center justify-center rounded-full bg-destructive text-destructive-foreground text-xs font-medium"
								>
									{notificationsStore.unreadCount > 9 ? '9+' : notificationsStore.unreadCount}
								</span>
							{/if}
						</Tooltip.Trigger>
						<Tooltip.Content>
							<p>
								Notifications
								{#if notificationsStore.unreadCount > 0}
									({notificationsStore.unreadCount} unread)
								{/if}
							</p>
						</Tooltip.Content>
					</Tooltip.Root>

					<Tooltip.Root>
						<Tooltip.Trigger
							class="text-primary-foreground/80 hover:text-primary-foreground rounded-md p-2 transition-colors"
							onclick={() => (inviteOpen = true)}
						>
							<UserPlusIcon class="size-5" />
						</Tooltip.Trigger>
						<Tooltip.Content>
							<p>Invite to BioVault</p>
						</Tooltip.Content>
					</Tooltip.Root>

					<Tooltip.Root>
						<Tooltip.Trigger
							class="text-primary-foreground/80 hover:text-primary-foreground rounded-md p-2 transition-colors"
							onclick={() => (supportOpen = true)}
						>
							<CircleHelpIcon class="size-5" />
						</Tooltip.Trigger>
						<Tooltip.Content>
							<p>Help & Support</p>
						</Tooltip.Content>
					</Tooltip.Root>
				</div>
			</Tooltip.Provider>
		</header>

		<!-- Spacer for fixed header -->
		<div class="h-12 shrink-0"></div>

		<!-- Sidebar + content below header -->
		<div class="flex flex-1 overflow-hidden">
			<AppSidebar />
			<Sidebar.Inset>
				<div class="flex-1 overflow-auto">
					{@render children?.()}
				</div>
			</Sidebar.Inset>
		</div>
	</div>
</Sidebar.Provider>

<NotificationsSheet bind:open={notificationsOpen} />
<LearnSheet bind:open={learnOpen} />
<SupportDialog bind:open={supportOpen} />
<InviteDialog bind:open={inviteOpen} />
<AiAssistant />
<Toaster />
