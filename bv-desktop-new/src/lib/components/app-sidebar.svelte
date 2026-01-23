<script lang="ts">
	import { invoke } from '@tauri-apps/api/core'
	import { onMount } from 'svelte'
	import { goto } from '$app/navigation'
	import { page } from '$app/stores'
	import { syftboxAuthStore } from '$lib/stores/syftbox-auth.svelte'
	import { profilesStore } from '$lib/stores/profiles.svelte'
	import SyftboxSignInDialog from '$lib/components/syftbox-sign-in-dialog.svelte'
	import ProfileSwitcherDialog from '$lib/components/profile-switcher-dialog.svelte'
	import PlayCircleIcon from '@lucide/svelte/icons/play-circle'
	import ChevronUpIcon from '@lucide/svelte/icons/chevron-up'
	import CompassIcon from '@lucide/svelte/icons/compass'
	import DatabaseIcon from '@lucide/svelte/icons/database'
	import LogOutIcon from '@lucide/svelte/icons/log-out'
	import LogInIcon from '@lucide/svelte/icons/log-in'
	import SettingsIcon from '@lucide/svelte/icons/settings'
	import UserIcon from '@lucide/svelte/icons/user'
	import UsersIcon from '@lucide/svelte/icons/users'
	import ArrowRightLeftIcon from '@lucide/svelte/icons/arrow-right-left'
	import WorkflowIcon from '@lucide/svelte/icons/workflow'
	import WifiIcon from '@lucide/svelte/icons/wifi'
	import WifiOffIcon from '@lucide/svelte/icons/wifi-off'
	import Loader2Icon from '@lucide/svelte/icons/loader-2'
	import * as AlertDialog from '$lib/components/ui/alert-dialog/index.js'
	import * as Tooltip from '$lib/components/ui/tooltip/index.js'
	import { Switch } from '$lib/components/ui/switch/index.js'
	import * as Avatar from '$lib/components/ui/avatar/index.js'
	import * as DropdownMenu from '$lib/components/ui/dropdown-menu/index.js'
	import * as Sidebar from '$lib/components/ui/sidebar/index.js'
	import { useSidebar } from '$lib/components/ui/sidebar/index.js'
	import { ChevronsLeft, ChevronsRight } from '@lucide/svelte'

	const sidebar = useSidebar()

	// Navigation items
	const navItems = [
		{ title: 'Explore', url: '/explore', icon: CompassIcon },
		{ title: 'Flows', url: '/flows', icon: WorkflowIcon },
		{ title: 'Datasets', url: '/datasets', icon: DatabaseIcon },
		{ title: 'Collaborate', url: '/collaborate', icon: UsersIcon },
		{ title: 'Results', url: '/runs', icon: PlayCircleIcon },
	]

	// User identity from BioVault settings
	let userEmail = $state('')
	let userLoading = $state(true)
	let signInDialogOpen = $state(false)
	let disconnectDialogOpen = $state(false)
	let disconnecting = $state(false)
	let profileSwitcherOpen = $state(false)

	// Derive display name from email (part before @)
	const userName = $derived(userEmail ? userEmail.split('@')[0] : 'Not signed in')

	// Derive initials from email
	const userInitials = $derived(userEmail ? userEmail.substring(0, 2).toUpperCase() : '?')

	// Check if user is authenticated to SyftBox
	const isAuthenticated = $derived(syftboxAuthStore.isAuthenticated)
	const isOnline = $derived(syftboxAuthStore.isOnline)
	const isTogglingOnline = $derived(syftboxAuthStore.isTogglingOnline)

	async function handleToggleOnline() {
		try {
			await syftboxAuthStore.toggleOnline()
		} catch (e) {
			console.error('Failed to toggle online status:', e)
		}
	}

	// Update email when auth state changes
	$effect(() => {
		if (syftboxAuthStore.isAuthenticated && syftboxAuthStore.email) {
			userEmail = syftboxAuthStore.email
		}
	})

	onMount(async () => {
		try {
			// Check SyftBox auth status and load profiles in parallel
			await Promise.all([syftboxAuthStore.checkAuth(), profilesStore.load()])

			// Get email from settings
			const settings = await invoke<{ email: string }>('get_settings')
			userEmail = settings.email || ''
		} catch (e) {
			console.error('Failed to load settings:', e)
		} finally {
			userLoading = false
		}
	})

	function handleSignIn() {
		signInDialogOpen = true
	}

	async function handleDisconnect() {
		disconnecting = true
		try {
			await syftboxAuthStore.disconnect()
			userEmail = ''
		} catch (e) {
			console.error('Failed to disconnect:', e)
		} finally {
			disconnecting = false
			disconnectDialogOpen = false
		}
	}
</script>

<Sidebar.Root collapsible="icon">
	<Sidebar.Content class="pt-2">
		<Sidebar.Group>
			<Sidebar.GroupContent>
				<Sidebar.Menu>
					{#each navItems as item (item.title)}
						<Sidebar.MenuItem>
							<Sidebar.MenuButton isActive={$page.url.pathname.startsWith(item.url)}>
								{#snippet child({ props })}
									<a href={item.url} {...props}>
										<item.icon />
										<span>{item.title}</span>
									</a>
								{/snippet}
							</Sidebar.MenuButton>
						</Sidebar.MenuItem>
					{/each}
				</Sidebar.Menu>
			</Sidebar.GroupContent>
		</Sidebar.Group>
	</Sidebar.Content>
	<Sidebar.Footer>
		<Sidebar.Menu>
			<Sidebar.MenuItem>
				<DropdownMenu.Root>
					<DropdownMenu.Trigger>
						{#snippet child({ props })}
							<Sidebar.MenuButton
								{...props}
								size="lg"
								class="data-[state=open]:bg-sidebar-accent data-[state=open]:text-sidebar-accent-foreground"
							>
								<Tooltip.Provider delayDuration={0}>
									<Tooltip.Root>
										<Tooltip.Trigger class="relative">
											<Avatar.Root class="h-8 w-8 rounded-lg">
												<Avatar.Fallback class="rounded-lg">
													{userLoading ? '...' : userInitials}
												</Avatar.Fallback>
											</Avatar.Root>
											{#if isAuthenticated}
												<span
													class="absolute -bottom-0.5 -right-0.5 size-3 rounded-full border-2 border-sidebar {isOnline
														? 'bg-emerald-500'
														: 'bg-slate-400'}"
												></span>
											{/if}
										</Tooltip.Trigger>
										<Tooltip.Content side="top">
											{#if !isAuthenticated}
												Not connected to SyftBox
											{:else if isOnline}
												SyftBox Online
											{:else}
												SyftBox Offline
											{/if}
										</Tooltip.Content>
									</Tooltip.Root>
								</Tooltip.Provider>
								<div
									class="group-data-[collapsible=icon]:hidden grid flex-1 text-left text-sm leading-tight"
								>
									<span class="truncate font-semibold">{userLoading ? 'Loading...' : userName}</span
									>
									<span class="truncate text-xs"
										>{userLoading ? '' : userEmail || 'Not configured'}</span
									>
								</div>
								<ChevronUpIcon class="group-data-[collapsible=icon]:hidden ml-auto size-4" />
							</Sidebar.MenuButton>
						{/snippet}
					</DropdownMenu.Trigger>
					<DropdownMenu.Content
						side="top"
						class="w-[--bits-dropdown-menu-anchor-width] min-w-56 rounded-lg"
					>
						<DropdownMenu.Label class="p-0 font-normal">
							<div class="flex items-center gap-2 px-1 py-1.5 text-left text-sm">
								<Avatar.Root class="h-8 w-8 rounded-lg">
									<Avatar.Fallback class="rounded-lg">
										{userInitials}
									</Avatar.Fallback>
								</Avatar.Root>
								<div class="grid flex-1 text-left text-sm leading-tight">
									<span class="truncate font-semibold">{userName}</span>
									<span class="truncate text-xs">{userEmail || 'Not configured'}</span>
								</div>
							</div>
						</DropdownMenu.Label>
						<DropdownMenu.Separator />
						<DropdownMenu.Group>
							<DropdownMenu.Item onclick={() => goto('/settings')}>
								<SettingsIcon />
								Settings
							</DropdownMenu.Item>
							<DropdownMenu.Item onclick={() => (profileSwitcherOpen = true)}>
								<ArrowRightLeftIcon />
								Switch Profile
							</DropdownMenu.Item>
						</DropdownMenu.Group>
						<DropdownMenu.Separator />
						{#if isAuthenticated}
							<DropdownMenu.Group>
								<DropdownMenu.Label class="text-xs text-muted-foreground font-normal">
									SyftBox Network
								</DropdownMenu.Label>
								<div class="flex items-center justify-between px-2 py-1.5">
									<div class="flex items-center gap-2 text-sm">
										{#if isTogglingOnline}
											<Loader2Icon class="size-4 animate-spin" />
										{:else if isOnline}
											<WifiIcon class="size-4 text-emerald-500" />
										{:else}
											<WifiOffIcon class="size-4 text-muted-foreground" />
										{/if}
										<span>{isOnline ? 'Online' : 'Offline'}</span>
									</div>
									<Switch
										checked={isOnline}
										onCheckedChange={handleToggleOnline}
										disabled={isTogglingOnline}
									/>
								</div>
							</DropdownMenu.Group>
							<DropdownMenu.Separator />
							<DropdownMenu.Item onclick={() => (disconnectDialogOpen = true)}>
								<LogOutIcon />
								Disconnect from SyftBox
							</DropdownMenu.Item>
						{:else}
							<DropdownMenu.Item onclick={handleSignIn}>
								<LogInIcon />
								Connect to SyftBox
							</DropdownMenu.Item>
						{/if}
					</DropdownMenu.Content>
				</DropdownMenu.Root>
			</Sidebar.MenuItem>
		</Sidebar.Menu>
	</Sidebar.Footer>
	<Sidebar.Rail class="group/rail flex items-center justify-center cursor-pointer">
		<div
			class="bg-sidebar-accent text-sidebar-accent-foreground hover:bg-sidebar-border flex h-6 w-6 items-center justify-center rounded-full border opacity-0 shadow-sm transition-all group-hover:opacity-100 z-1 cursor-pointer"
		>
			{#if sidebar.state === 'collapsed'}
				<ChevronsRight class="size-4" />
			{:else}
				<ChevronsLeft class="size-4" />
			{/if}
		</div>
	</Sidebar.Rail>
</Sidebar.Root>

<SyftboxSignInDialog bind:open={signInDialogOpen} />

<AlertDialog.Root bind:open={disconnectDialogOpen}>
	<AlertDialog.Content>
		<AlertDialog.Header>
			<AlertDialog.Title>Disconnect from SyftBox?</AlertDialog.Title>
			<AlertDialog.Description>
				You will be disconnected from the SyftBox network. You can reconnect at any time by signing
				in again.
			</AlertDialog.Description>
		</AlertDialog.Header>
		<AlertDialog.Footer>
			<AlertDialog.Cancel disabled={disconnecting}>Cancel</AlertDialog.Cancel>
			<AlertDialog.Action onclick={handleDisconnect} disabled={disconnecting}>
				{#if disconnecting}
					Disconnecting...
				{:else}
					Disconnect
				{/if}
			</AlertDialog.Action>
		</AlertDialog.Footer>
	</AlertDialog.Content>
</AlertDialog.Root>

<ProfileSwitcherDialog bind:open={profileSwitcherOpen} />
