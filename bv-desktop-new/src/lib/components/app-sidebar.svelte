<script lang="ts">
	import { goto } from '$app/navigation'
	import { page } from '$app/stores'
	import ChevronUpIcon from '@lucide/svelte/icons/chevron-up'
	import LogOutIcon from '@lucide/svelte/icons/log-out'
	import SettingsIcon from '@lucide/svelte/icons/settings'
	import UserIcon from '@lucide/svelte/icons/user'
	import WorkflowIcon from '@lucide/svelte/icons/workflow'
	import * as Avatar from '$lib/components/ui/avatar/index.js'
	import * as DropdownMenu from '$lib/components/ui/dropdown-menu/index.js'
	import * as Sidebar from '$lib/components/ui/sidebar/index.js'

	// Menu items with actual routes
	const items = [
		{
			title: 'Flows',
			url: '/flows',
			icon: WorkflowIcon,
		},
	]

	// User data (you can make this dynamic later)
	const user = {
		name: 'John Doe',
		email: 'john@example.com',
		avatar: '',
	}
</script>

<Sidebar.Root>
	<Sidebar.Content>
		<Sidebar.Group>
			<Sidebar.GroupLabel>Application</Sidebar.GroupLabel>
			<Sidebar.GroupContent>
				<Sidebar.Menu>
					{#each items as item (item.title)}
						<Sidebar.MenuItem>
							<Sidebar.MenuButton isActive={$page.url.pathname === item.url}>
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
								class="data-[state=open]:bg-sidebar-accent data-[state=open]:text-sidebar-accent-foreground"
							>
								<Avatar.Root class="h-8 w-8 rounded-lg">
									<Avatar.Image src={user.avatar} alt={user.name} />
									<Avatar.Fallback class="rounded-lg">
										{user.name.split(' ').map(n => n[0]).join('')}
									</Avatar.Fallback>
								</Avatar.Root>
								<div class="grid flex-1 text-left text-sm leading-tight">
									<span class="truncate font-semibold">{user.name}</span>
									<span class="truncate text-xs">{user.email}</span>
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
									<Avatar.Image src={user.avatar} alt={user.name} />
									<Avatar.Fallback class="rounded-lg">
										{user.name.split(' ').map(n => n[0]).join('')}
									</Avatar.Fallback>
								</Avatar.Root>
								<div class="grid flex-1 text-left text-sm leading-tight">
									<span class="truncate font-semibold">{user.name}</span>
									<span class="truncate text-xs">{user.email}</span>
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
