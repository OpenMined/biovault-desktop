<script lang="ts">
	import './layout.css'
	import { onMount } from 'svelte'
	import { invoke } from '@tauri-apps/api/core'
	import { listen } from '@tauri-apps/api/event'
	import { getVersion } from '@tauri-apps/api/app'
	import { ModeWatcher } from 'mode-watcher'
	import * as Sidebar from '$lib/components/ui/sidebar/index.js'
	import * as Tooltip from '$lib/components/ui/tooltip/index.js'
	import * as Drawer from '$lib/components/ui/drawer/index.js'
	import { Toaster } from '$lib/components/ui/sonner/index.js'
	import { toast } from 'svelte-sonner'
	import AppSidebar from '$lib/components/app-sidebar.svelte'
	import SqlPanel from '$lib/components/sql-panel.svelte'
	import LogsPanel from '$lib/components/logs-panel.svelte'
	import MailDebugPanel from '$lib/components/mail-debug-panel.svelte'
	import NotificationsSheet from '$lib/components/notifications-sheet.svelte'
	import LearnSheet from '$lib/components/learn-sheet.svelte'
	import SupportDialog from '$lib/components/support-dialog.svelte'
	import InviteDialog from '$lib/components/invite-dialog.svelte'
	import SyftboxPanel from '$lib/components/syftbox-panel.svelte'
	import ProfileSwitcherDialog from '$lib/components/profile-switcher-dialog.svelte'
	// import AiAssistant from '$lib/components/ai-assistant.svelte'
	import DependenciesStatus from '$lib/components/dependencies-status.svelte'
	import {
		addNotification,
		notificationsStore,
		syncNotificationsProfileScope,
	} from '$lib/stores/notifications.svelte'
	import { profilesStore } from '$lib/stores/profiles.svelte'
	import SquareTerminalIcon from '@lucide/svelte/icons/square-terminal'
	import DatabaseIcon from '@lucide/svelte/icons/database'
	import FolderSyncIcon from '@lucide/svelte/icons/folder-sync'
	import MailIcon from '@lucide/svelte/icons/mail'
	import ChevronLeftIcon from '@lucide/svelte/icons/chevron-left'
	import ChevronRightIcon from '@lucide/svelte/icons/chevron-right'
	import LibraryBigIcon from '@lucide/svelte/icons/library-big'
	import BellIcon from '@lucide/svelte/icons/bell'
	import CircleHelpIcon from '@lucide/svelte/icons/circle-help'
	import UserPlusIcon from '@lucide/svelte/icons/user-plus'

	let { children } = $props()
	let sqlOpen = $state(false)
	let logsOpen = $state(false)
	let syftboxOpen = $state(false)
	let mailDebugOpen = $state(false)
	let devToolsOpen = $state(false)
	let notificationsOpen = $state(false)
	let learnOpen = $state(false)
	let supportOpen = $state(false)
	let inviteOpen = $state(false)
	let appVersion = $state('')
	let profileSwitcherOpen = $state(false)
	let profileGuardLoading = $state(true)
	const headerIconButtonClass =
		'text-white/80 hover:text-white flex size-9 items-center justify-center rounded-md transition-colors'
	const requiresProfileSelection = $derived(
		!profileGuardLoading &&
			profilesStore.enabled &&
			(profilesStore.shouldShowPicker || !profilesStore.currentProfileId)
	)

	function handleProfileSwitcherOpenChange(next: boolean) {
		if (requiresProfileSelection) {
			profileSwitcherOpen = true
			return
		}
		profileSwitcherOpen = next
	}

	async function copyAppVersion() {
		if (!appVersion) return

		try {
			await navigator.clipboard.writeText(appVersion)
			toast.success('Copied to clipboard')
		} catch {
			toast.error('Failed to copy version')
		}
	}

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
		getVersion()
			.then((v) => (appVersion = v))
			.catch(() => {})

		;(async () => {
			try {
				await profilesStore.load()
				syncNotificationsProfileScope(profilesStore.currentProfileId)
			} finally {
				profileGuardLoading = false
				if (profilesStore.enabled && !profilesStore.currentProfileId) {
					profileSwitcherOpen = true
				}
			}
		})()

		// Listen for pipeline completion events
		const unlistenPromise = listen<string>('flow-complete', (event) => {
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

	$effect(() => {
		if (profileGuardLoading) return
		syncNotificationsProfileScope(profilesStore.currentProfileId)
	})
</script>

<ModeWatcher />
<Sidebar.Provider class="!min-h-0">
	<div class="flex h-screen w-screen flex-col" data-testid="app-shell">
		<!-- Full-width header/titlebar at top -->
		<header
			data-tauri-drag-region
			data-testid="app-header"
			class="bg-primary fixed top-0 left-0 right-0 z-20 flex h-10 shrink-0 items-center justify-between border-b border-white/15 px-4"
		>
			<div class="ps-20 flex items-center gap-2">
				<span class="pointer-events-none select-none text-base font-bold text-white">
					BioVault Desktop
				</span>
				{#if appVersion}
					<button
						type="button"
						class="cursor-pointer select-none text-xs text-white/60 transition-colors hover:text-white focus-visible:text-white"
						aria-label={`Copy BioVault Desktop version ${appVersion} to clipboard`}
						onclick={copyAppVersion}
					>
						v{appVersion}
					</button>
				{/if}
			</div>
			<Tooltip.Provider delayDuration={0}>
				<div class="flex items-center gap-1">
					<div class="flex items-center gap-1">
						<Tooltip.Root>
							<Tooltip.Trigger
								class="{headerIconButtonClass} {devToolsOpen
									? 'bg-primary-foreground/10'
									: ''}"
								onclick={() => (devToolsOpen = !devToolsOpen)}
							>
								{#if devToolsOpen}
									<ChevronRightIcon class="size-5" />
								{:else}
									<ChevronLeftIcon class="size-5" />
								{/if}
							</Tooltip.Trigger>
							<Tooltip.Content>
								<p>{devToolsOpen ? 'Hide Dev Tools' : 'Show Dev Tools'}</p>
							</Tooltip.Content>
						</Tooltip.Root>

						<div
							class="flex items-center gap-1 overflow-hidden transition-all duration-300 ease-out {devToolsOpen
								? 'max-w-96 opacity-100 translate-x-0'
								: 'max-w-0 opacity-0 translate-x-3 pointer-events-none'}"
						>
							<Drawer.Root bind:open={logsOpen}>
								<Tooltip.Root>
									<Drawer.Trigger>
										{#snippet child({ props })}
											<Tooltip.Trigger
												{...props}
												class={headerIconButtonClass}
											>
												<SquareTerminalIcon class="size-5" />
											</Tooltip.Trigger>
										{/snippet}
									</Drawer.Trigger>
									<Tooltip.Content>
										<p>Logs</p>
									</Tooltip.Content>
								</Tooltip.Root>
								<Drawer.Content class="!max-h-[calc(100vh-40px)] h-[calc(100vh-40px)] !rounded-t-xl">
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
												class={headerIconButtonClass}
											>
												<DatabaseIcon class="size-5" />
											</Tooltip.Trigger>
										{/snippet}
									</Drawer.Trigger>
									<Tooltip.Content>
										<p>SQL Console</p>
									</Tooltip.Content>
								</Tooltip.Root>
								<Drawer.Content class="!max-h-[calc(100vh-40px)] h-[calc(100vh-40px)] !rounded-t-xl">
									<div class="h-full px-6 pb-8 pt-4">
										{#if sqlOpen}
											<SqlPanel mode="sheet" />
										{/if}
									</div>
								</Drawer.Content>
							</Drawer.Root>

							<Drawer.Root bind:open={mailDebugOpen}>
								<Tooltip.Root>
									<Drawer.Trigger>
										{#snippet child({ props })}
											<Tooltip.Trigger
												{...props}
												class={headerIconButtonClass}
											>
												<MailIcon class="size-5" />
											</Tooltip.Trigger>
										{/snippet}
									</Drawer.Trigger>
									<Tooltip.Content>
										<p>Mail Debug</p>
									</Tooltip.Content>
								</Tooltip.Root>
								<Drawer.Content class="!max-h-[calc(100vh-40px)] h-[calc(100vh-40px)] !rounded-t-xl">
									<div class="h-full px-6 pb-8 pt-4">
										{#if mailDebugOpen}
											<MailDebugPanel />
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
												class={headerIconButtonClass}
											>
												<FolderSyncIcon class="size-5" />
											</Tooltip.Trigger>
										{/snippet}
									</Drawer.Trigger>
									<Tooltip.Content>
										<p>SyftBox Sync</p>
									</Tooltip.Content>
								</Tooltip.Root>
								<Drawer.Content class="!max-h-[calc(100vh-40px)] h-[calc(100vh-40px)] !rounded-t-xl">
									<div class="h-full px-6 pb-8 pt-4">
										{#if syftboxOpen}
											<SyftboxPanel mode="sheet" />
										{/if}
									</div>
								</Drawer.Content>
							</Drawer.Root>
						</div>
					</div>

					<DependenciesStatus />

					<!--
					<Tooltip.Root>
						<Tooltip.Trigger
							class={headerIconButtonClass}
							onclick={() => (learnOpen = true)}
						>
							<LibraryBigIcon class="size-5" />
						</Tooltip.Trigger>
						<Tooltip.Content>
							<p>Learn</p>
						</Tooltip.Content>
					</Tooltip.Root>

					<Tooltip.Root>
						<Tooltip.Trigger
							class="{headerIconButtonClass} relative"
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
					-->

					<!--
					<Tooltip.Root>
						<Tooltip.Trigger
							class={headerIconButtonClass}
							onclick={() => (inviteOpen = true)}
						>
							<UserPlusIcon class="size-5" />
						</Tooltip.Trigger>
						<Tooltip.Content>
							<p>Invite to BioVault</p>
						</Tooltip.Content>
					</Tooltip.Root>
					-->

					<!--
					<Tooltip.Root>
						<Tooltip.Trigger
							class={headerIconButtonClass}
							onclick={() => (supportOpen = true)}
						>
							<CircleHelpIcon class="size-5" />
						</Tooltip.Trigger>
						<Tooltip.Content>
							<p>Help & Support</p>
						</Tooltip.Content>
					</Tooltip.Root>
					-->
				</div>
			</Tooltip.Provider>
		</header>

		<!-- Spacer for fixed header -->
		<div class="h-10 shrink-0"></div>

			<!-- Sidebar + content below header -->
			<div class="flex flex-1 overflow-hidden">
				<AppSidebar />
				<Sidebar.Inset>
					<div class="flex-1 overflow-auto">
						{#if requiresProfileSelection}
							<div class="text-muted-foreground flex h-full items-center justify-center px-6 text-sm">
								Select or create a profile to continue.
							</div>
						{:else}
							{@render children?.()}
						{/if}
					</div>
				</Sidebar.Inset>
			</div>
		</div>
	</Sidebar.Provider>

<NotificationsSheet bind:open={notificationsOpen} />
<LearnSheet bind:open={learnOpen} />
<SupportDialog bind:open={supportOpen} />
<InviteDialog bind:open={inviteOpen} />
<ProfileSwitcherDialog
	open={profileSwitcherOpen || requiresProfileSelection}
	required={requiresProfileSelection}
	onOpenChange={handleProfileSwitcherOpenChange}
/>
<!-- <AiAssistant /> -->
<Toaster />
