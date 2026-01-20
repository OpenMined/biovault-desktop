<script lang="ts">
	import { invoke } from '@tauri-apps/api/core'
	import { onMount } from 'svelte'
	import { goto } from '$app/navigation'
	import { page } from '$app/stores'
	import ChevronDownIcon from '@lucide/svelte/icons/chevron-down'
	import ChevronUpIcon from '@lucide/svelte/icons/chevron-up'
	import CompassIcon from '@lucide/svelte/icons/compass'
	import InboxIcon from '@lucide/svelte/icons/inbox'
	import LogOutIcon from '@lucide/svelte/icons/log-out'
	import SettingsIcon from '@lucide/svelte/icons/settings'
	import UserIcon from '@lucide/svelte/icons/user'
	import WorkflowIcon from '@lucide/svelte/icons/workflow'
	import * as Avatar from '$lib/components/ui/avatar/index.js'
	import * as Collapsible from '$lib/components/ui/collapsible/index.js'
	import * as DropdownMenu from '$lib/components/ui/dropdown-menu/index.js'
	import * as Sidebar from '$lib/components/ui/sidebar/index.js'

	// Navigation items with subroutes
	const navItems = [
		{
			title: 'Flows',
			url: '/flows',
			icon: WorkflowIcon,
			subroutes: [
				{ title: 'All Flows', url: '/flows' },
				{ title: 'My Flows', url: '/flows/my' },
				{ title: 'Shared', url: '/flows/shared' },
			],
		},
		{
			title: 'Explore',
			url: '/explore',
			icon: CompassIcon,
			subroutes: [
				{ title: 'Browse', url: '/explore' },
				{ title: 'Featured', url: '/explore/featured' },
				{ title: 'Categories', url: '/explore/categories' },
			],
		},
		{
			title: 'Inbox',
			url: '/inbox',
			icon: InboxIcon,
			subroutes: [
				{ title: 'All Messages', url: '/inbox' },
				{ title: 'Unread', url: '/inbox/unread' },
				{ title: 'Archived', url: '/inbox/archived' },
			],
		},
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

	// Check if any subroute is active
	function isNavItemActive(item: (typeof navItems)[0], pathname: string): boolean {
		return item.subroutes.some((sub) => pathname === sub.url || pathname.startsWith(sub.url + '/'))
	}
</script>

<Sidebar.Root>
	<Sidebar.Content class="pt-2">
		<Sidebar.Group>
			<Sidebar.GroupLabel>Navigation</Sidebar.GroupLabel>
			<Sidebar.GroupContent>
				<Sidebar.Menu>
					{#each navItems as item (item.title)}
						<Collapsible.Root open={isNavItemActive(item, $page.url.pathname)} class="group/collapsible">
							<Sidebar.MenuItem>
								<Collapsible.Trigger>
									{#snippet child({ props })}
										<Sidebar.MenuButton {...props}>
											<item.icon />
											<span>{item.title}</span>
											<ChevronDownIcon class="ml-auto transition-transform group-data-[state=open]/collapsible:rotate-180" />
										</Sidebar.MenuButton>
									{/snippet}
								</Collapsible.Trigger>
								<Collapsible.Content>
									<Sidebar.MenuSub>
										{#each item.subroutes as subroute (subroute.url)}
											<Sidebar.MenuSubItem>
												<Sidebar.MenuSubButton isActive={$page.url.pathname === subroute.url}>
													{#snippet child({ props })}
														<a href={subroute.url} {...props}>
															{subroute.title}
														</a>
													{/snippet}
												</Sidebar.MenuSubButton>
											</Sidebar.MenuSubItem>
										{/each}
									</Sidebar.MenuSub>
								</Collapsible.Content>
							</Sidebar.MenuItem>
						</Collapsible.Root>
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
								class="data-[state=open]:bg-sidebar-accent data-[state=open]:text-sidebar-accent-foreground"
							>
								<Avatar.Root class="h-8 w-8 rounded-lg">
									<Avatar.Fallback class="rounded-lg">
										{userLoading ? '...' : userInitials}
									</Avatar.Fallback>
								</Avatar.Root>
								<div class="grid flex-1 text-left text-sm leading-tight">
									<span class="truncate font-semibold">{userLoading ? 'Loading...' : userName}</span
									>
									<span class="truncate text-xs"
										>{userLoading ? '' : userEmail || 'Not configured'}</span
									>
								</div>
								<ChevronUpIcon class="ml-auto size-4" />
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
</Sidebar.Root>
