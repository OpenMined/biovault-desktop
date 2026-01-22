<script lang="ts">
	import './layout.css'
	import * as Sidebar from '$lib/components/ui/sidebar/index.js'
	import * as Tooltip from '$lib/components/ui/tooltip/index.js'
	import * as Drawer from '$lib/components/ui/drawer/index.js'
	import { Toaster } from '$lib/components/ui/sonner/index.js'
	import AppSidebar from '$lib/components/app-sidebar.svelte'
	import SqlPanel from '$lib/components/sql-panel.svelte'
	import LogsPanel from '$lib/components/logs-panel.svelte'
	import SquareTerminalIcon from '@lucide/svelte/icons/square-terminal'
	import DatabaseIcon from '@lucide/svelte/icons/database'
	import GraduationCapIcon from '@lucide/svelte/icons/graduation-cap'
	import SparklesIcon from '@lucide/svelte/icons/sparkles'
	import BellIcon from '@lucide/svelte/icons/bell'
	import CircleHelpIcon from '@lucide/svelte/icons/circle-help'

	let { children } = $props()
	let sqlOpen = $state(false)
	let logsOpen = $state(false)
</script>

<Sidebar.Provider class="!min-h-0">
	<div class="flex h-screen w-screen flex-col">
		<!-- Full-width header/titlebar at top -->
		<header
			data-tauri-drag-region
			class="bg-background fixed top-0 left-0 right-0 z-20 flex h-12 shrink-0 items-center justify-between border-b px-4"
		>
			<div class="ps-16"></div>
			<Tooltip.Provider delayDuration={0}>
				<div class="flex items-center gap-1">
					<Drawer.Root bind:open={logsOpen}>
						<Tooltip.Root>
							<Drawer.Trigger>
								{#snippet child({ props })}
									<Tooltip.Trigger
										{...props}
										class="text-muted-foreground hover:text-foreground rounded-md p-2 transition-colors"
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
										class="text-muted-foreground hover:text-foreground rounded-md p-2 transition-colors"
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

					<Tooltip.Root>
						<Tooltip.Trigger
							class="text-muted-foreground hover:text-foreground rounded-md p-2 transition-colors"
						>
							<GraduationCapIcon class="size-5" />
						</Tooltip.Trigger>
						<Tooltip.Content>
							<p>Learn</p>
						</Tooltip.Content>
					</Tooltip.Root>

					<Tooltip.Root>
						<Tooltip.Trigger
							class="text-muted-foreground hover:text-foreground rounded-md p-2 transition-colors"
						>
							<SparklesIcon class="size-5" />
						</Tooltip.Trigger>
						<Tooltip.Content>
							<p>AI Assistant</p>
						</Tooltip.Content>
					</Tooltip.Root>

					<Tooltip.Root>
						<Tooltip.Trigger
							class="text-muted-foreground hover:text-foreground rounded-md p-2 transition-colors"
						>
							<BellIcon class="size-5" />
						</Tooltip.Trigger>
						<Tooltip.Content>
							<p>Notifications</p>
						</Tooltip.Content>
					</Tooltip.Root>

					<Tooltip.Root>
						<Tooltip.Trigger
							class="text-muted-foreground hover:text-foreground rounded-md p-2 transition-colors"
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

<Toaster />
