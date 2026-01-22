<script lang="ts">
	import { invoke } from '@tauri-apps/api/core'
	import { onMount } from 'svelte'
	import { goto } from '$app/navigation'
	import { page } from '$app/stores'
	import PlayCircleIcon from '@lucide/svelte/icons/play-circle'
	import ChevronUpIcon from '@lucide/svelte/icons/chevron-up'
	import CompassIcon from '@lucide/svelte/icons/compass'
	import DatabaseIcon from '@lucide/svelte/icons/database'
	import InboxIcon from '@lucide/svelte/icons/inbox'
	import LogOutIcon from '@lucide/svelte/icons/log-out'
	import SettingsIcon from '@lucide/svelte/icons/settings'
	import UserIcon from '@lucide/svelte/icons/user'
	import UsersIcon from '@lucide/svelte/icons/users'
	import WorkflowIcon from '@lucide/svelte/icons/workflow'
	import * as Avatar from '$lib/components/ui/avatar/index.js'
	import * as DropdownMenu from '$lib/components/ui/dropdown-menu/index.js'
	import * as Sidebar from '$lib/components/ui/sidebar/index.js'
	import { useSidebar } from '$lib/components/ui/sidebar/index.js'
	import { ChevronsLeft, ChevronsRight } from '@lucide/svelte'

	const sidebar = useSidebar()

	// Navigation items
	const navItems = [
		{ title: 'Flows', url: '/flows', icon: WorkflowIcon },
		{ title: 'Runs', url: '/runs', icon: PlayCircleIcon },
		{ title: 'Datasets', url: '/datasets', icon: DatabaseIcon },
		{ title: 'Explore', url: '/explore', icon: CompassIcon },
		{ title: 'Inbox', url: '/inbox', icon: InboxIcon },
		{ title: 'Collaborate', url: '/collaborate', icon: UsersIcon },
	]

	// User identity from BioVault settings
	let userEmail = $state('')
	let userLoading = $state(true)

	// Derive display name from email (part before @)
	const userName = $derived(userEmail ? userEmail.split('@')[0] : 'Not configured')

	// Derive initials from email
	const userInitials = $derived(userEmail ? userEmail.substring(0, 2).toUpperCase() : '?')

	onMount(async () => {
		try {
			const settings = await invoke<{ email: string }>('get_settings')
			userEmail = settings.email || ''
		} catch (e) {
			console.error('Failed to load settings:', e)
		} finally {
			userLoading = false
		}
	})
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
								<Avatar.Root class="h-8 w-8 rounded-lg">
									<Avatar.Fallback class="rounded-lg">
										{userLoading ? '...' : userInitials}
									</Avatar.Fallback>
								</Avatar.Root>
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
							<DropdownMenu.Item onclick={() => goto('/profile')}>
								<UserIcon />
								Profile
							</DropdownMenu.Item>
							<DropdownMenu.Item onclick={() => goto('/settings')}>
								<SettingsIcon />
								Settings
							</DropdownMenu.Item>
						</DropdownMenu.Group>
						<DropdownMenu.Separator />
						<DropdownMenu.Item>
							<LogOutIcon />
							Log out
						</DropdownMenu.Item>
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
