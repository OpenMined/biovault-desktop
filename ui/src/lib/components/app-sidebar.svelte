<script lang="ts">
	import { invoke } from '@tauri-apps/api/core'
	import { onMount } from 'svelte'
	import { page } from '$app/stores'
	import { getAvatarToneClass } from '$lib/utils.js'
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
	import TriangleAlertIcon from '@lucide/svelte/icons/triangle-alert'
	import CircleIcon from '@lucide/svelte/icons/circle'
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
		{ title: 'Explore', url: '/explore', icon: CompassIcon, testId: 'nav-explore' },
		{ title: 'Flows', url: '/flows', icon: WorkflowIcon, testId: 'nav-flows' },
		{ title: 'Datasets', url: '/datasets', icon: DatabaseIcon, testId: 'nav-datasets' },
		{ title: 'Messages', url: '/collaborate', icon: UsersIcon, testId: 'nav-collaborate' },
		{ title: 'Results', url: '/runs', icon: PlayCircleIcon, testId: 'nav-results' },
		{ title: 'Settings', url: '/settings', icon: SettingsIcon, testId: 'nav-settings' },
	]

	// SyftBox auth identity (network account), separate from selected profile identity.
	let syftboxEmail = $state('')
	let userLoading = $state(true)
	let signInDialogOpen = $state(false)
	let disconnectDialogOpen = $state(false)
	let disconnecting = $state(false)
	let profileSwitcherOpen = $state(false)
	let devstackHealthWarning = $state(false)
	let devstackRefresh429Count = $state(0)

	const currentProfileEmail = $derived(profilesStore.currentProfile?.email || '')
	const displayIdentityEmail = $derived(currentProfileEmail || syftboxEmail)

	// Derive display name from profile first, then SyftBox account as fallback.
	const userName = $derived(
		currentProfileEmail
			? currentProfileEmail.split('@')[0]
			: profilesStore.currentProfile
				? syftboxEmail
					? syftboxEmail.split('@')[0]
					: 'Guest'
				: displayIdentityEmail
					? displayIdentityEmail.split('@')[0]
					: 'No profile'
	)

	const userSubline = $derived(
		profilesStore.currentProfile
			? currentProfileEmail || syftboxEmail || 'Local profile'
			: displayIdentityEmail || 'No profile selected'
	)
	const avatarSeed = $derived(
		displayIdentityEmail || (profilesStore.currentProfile ? `guest:${profilesStore.currentProfile.id}` : '')
	)
	const userAvatarTone = $derived(getAvatarToneClass(avatarSeed))

	// Derive initials from email
	const userInitials = $derived(
		displayIdentityEmail
			? displayIdentityEmail.substring(0, 2).toUpperCase()
			: profilesStore.currentProfile
				? 'GU'
				: '?'
	)

	// Check if user is authenticated to SyftBox
	const isAuthenticated = $derived(syftboxAuthStore.isAuthenticated)
	const isOnline = $derived(syftboxAuthStore.isOnline)
	const isTogglingOnline = $derived(syftboxAuthStore.isTogglingOnline)
	const profileRequired = $derived(
		profilesStore.enabled && (profilesStore.shouldShowPicker || !profilesStore.currentProfileId)
	)
	const isAuthenticatedForUi = $derived(!profileRequired && isAuthenticated)
	const isOnlineForUi = $derived(!profileRequired && isOnline)

	async function handleToggleOnline() {
		if (profileRequired) return
		try {
			await syftboxAuthStore.toggleOnline()
		} catch (e) {
			console.error('Failed to toggle online status:', e)
		}
	}

	// Update SyftBox account email when auth state changes
	$effect(() => {
		if (!profileRequired && syftboxAuthStore.isAuthenticated && syftboxAuthStore.email) {
			syftboxEmail = syftboxAuthStore.email
		}
		if (profileRequired) {
			syftboxEmail = ''
		}
	})

	onMount(() => {
		let healthPoll: ReturnType<typeof setInterval> | null = null

		const refreshDevstackHealth = async () => {
			try {
				const health = await invoke<{
					active: boolean
					has_refresh_429_warning: boolean
					refresh_429_count: number
				}>('get_devstack_sync_health')
				devstackHealthWarning = Boolean(health?.active && health?.has_refresh_429_warning)
				devstackRefresh429Count = Number(health?.refresh_429_count || 0)
			} catch {
				devstackHealthWarning = false
				devstackRefresh429Count = 0
			}
		}

		;(async () => {
			try {
				await profilesStore.load()
				const needsProfile =
					profilesStore.enabled && (profilesStore.shouldShowPicker || !profilesStore.currentProfileId)

				if (needsProfile) {
					try {
						await syftboxAuthStore.goOffline(false)
					} catch {
						// no-op
					}
					syftboxAuthStore.setAuthenticated(false, '')
					syftboxEmail = ''
				} else {
					await syftboxAuthStore.checkAuth()
					const settings = await invoke<{ email: string }>('get_settings')
					syftboxEmail = settings.email || ''
				}
				await refreshDevstackHealth()
				healthPoll = setInterval(refreshDevstackHealth, 15000)
			} catch (e) {
				console.error('Failed to load settings:', e)
			} finally {
				userLoading = false
			}
		})()

		return () => {
			if (healthPoll) clearInterval(healthPoll)
		}
	})

	function handleSignIn() {
		signInDialogOpen = true
	}

	async function handleDisconnect() {
		disconnecting = true
		try {
			await syftboxAuthStore.disconnect()
			syftboxEmail = ''
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
									<a href={item.url} data-testid={item.testId} {...props}>
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
												<Avatar.Fallback class={`rounded-lg ${userAvatarTone}`}>
													{userLoading ? '...' : userInitials}
												</Avatar.Fallback>
											</Avatar.Root>
											{#if !profileRequired}
												<span
													class="group-data-[collapsible=icon]:block absolute -bottom-0.5 -right-0.5 hidden size-2.5 rounded-full border border-sidebar {isAuthenticatedForUi && isOnlineForUi
														? 'bg-emerald-500'
														: 'bg-slate-400'}"
												></span>
											{/if}
										</Tooltip.Trigger>
										<Tooltip.Content side="top">
												{#if profileRequired}
													No profile selected
												{:else if !isAuthenticatedForUi}
													Not connected to SyftBox
												{:else if isOnlineForUi}
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
									<span class="truncate font-semibold inline-flex items-center gap-1.5">
										{#if !profileRequired}
											<CircleIcon
												class="size-2.5 shrink-0 fill-current {isAuthenticatedForUi && isOnlineForUi
													? 'text-emerald-500'
													: 'text-slate-400'}"
											/>
										{/if}
										<span>{userLoading ? 'Loading...' : userName}</span>
									</span>
									<span class="truncate text-xs"
										>{userLoading ? '' : userSubline}</span
									>
									{#if devstackHealthWarning}
										<span class="mt-0.5 inline-flex items-center gap-1 text-[11px] text-amber-700">
											<TriangleAlertIcon class="size-3" />
											Refresh 429 ({devstackRefresh429Count})
										</span>
									{/if}
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
									<Avatar.Fallback class={`rounded-lg ${userAvatarTone}`}>
										{userInitials}
									</Avatar.Fallback>
								</Avatar.Root>
								<div class="grid flex-1 text-left text-sm leading-tight">
									<span class="truncate font-semibold inline-flex items-center gap-1.5">
										{#if !profileRequired}
											<CircleIcon
												class="size-2.5 shrink-0 fill-current {isAuthenticatedForUi && isOnlineForUi
													? 'text-emerald-500'
													: 'text-slate-400'}"
											/>
										{/if}
										<span>{userName}</span>
									</span>
									<span class="truncate text-xs">{userSubline}</span>
									{#if devstackHealthWarning}
										<span class="mt-0.5 inline-flex items-center gap-1 text-[11px] text-amber-700">
											<TriangleAlertIcon class="size-3" />
											Refresh 429 ({devstackRefresh429Count})
										</span>
									{/if}
								</div>
								<button
									type="button"
									class="inline-flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
									onclick={() => (profileSwitcherOpen = true)}
									title="Switch profile"
									aria-label="Switch profile"
								>
									<ArrowRightLeftIcon class="size-4" />
								</button>
							</div>
						</DropdownMenu.Label>
						<DropdownMenu.Separator />
							{#if isAuthenticatedForUi}
								<DropdownMenu.Group>
									<DropdownMenu.Label class="text-xs text-muted-foreground font-normal">
										SyftBox Network
									</DropdownMenu.Label>
									<div class="flex items-center justify-between gap-2 px-2 py-1.5">
										<div class="flex items-center gap-2 text-sm">
											<Switch
												checked={isOnlineForUi}
												onCheckedChange={handleToggleOnline}
												disabled={isTogglingOnline || profileRequired}
											/>
											{#if isTogglingOnline}
												<Loader2Icon class="size-4 animate-spin" />
											{:else if isOnlineForUi}
												<WifiIcon class="size-4 text-emerald-500" />
											{:else}
												<WifiOffIcon class="size-4 text-muted-foreground" />
											{/if}
											<span>{isOnlineForUi ? 'Online' : 'Offline'}</span>
										</div>
										<button
											type="button"
											class="inline-flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-50"
											onclick={() => (disconnectDialogOpen = true)}
											disabled={disconnecting}
											title="Disconnect from SyftBox"
											aria-label="Disconnect from SyftBox"
										>
											<LogOutIcon class="size-4" />
										</button>
									</div>
								</DropdownMenu.Group>
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
				You will be disconnected from the SyftBox network. You can reconnect at any time by
				connecting again.
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
