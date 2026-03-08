<script lang="ts">
	import { invoke } from '@tauri-apps/api/core'
	import { listen } from '@tauri-apps/api/event'
	import { getVersion } from '@tauri-apps/api/app'
	import { confirm, message } from '@tauri-apps/plugin-dialog'
	import { onMount } from 'svelte'
	import { mode, setMode } from 'mode-watcher'
	import PageHeader from '$lib/components/page-header.svelte'
	import * as Card from '$lib/components/ui/card/index.js'
	import * as Dialog from '$lib/components/ui/dialog/index.js'
	import * as AlertDialog from '$lib/components/ui/alert-dialog/index.js'
	import { Button } from '$lib/components/ui/button/index.js'
	import { Input } from '$lib/components/ui/input/index.js'
	import { Label } from '$lib/components/ui/label/index.js'
	import { Switch } from '$lib/components/ui/switch/index.js'
	import UserIcon from '@lucide/svelte/icons/user'
	import MailIcon from '@lucide/svelte/icons/mail'
	import FolderIcon from '@lucide/svelte/icons/folder'
	import ServerIcon from '@lucide/svelte/icons/server'
	import ShieldIcon from '@lucide/svelte/icons/shield'
	import KeyIcon from '@lucide/svelte/icons/key'
	import CopyIcon from '@lucide/svelte/icons/copy'
	import CheckIcon from '@lucide/svelte/icons/check'
	import RefreshCwIcon from '@lucide/svelte/icons/refresh-cw'
	import DownloadIcon from '@lucide/svelte/icons/download'
	import Loader2Icon from '@lucide/svelte/icons/loader-2'
	import EyeIcon from '@lucide/svelte/icons/eye'
	import EyeOffIcon from '@lucide/svelte/icons/eye-off'
	import ShuffleIcon from '@lucide/svelte/icons/shuffle'
	import ChevronLeftIcon from '@lucide/svelte/icons/chevron-left'
	import ChevronRightIcon from '@lucide/svelte/icons/chevron-right'
	import MoonIcon from '@lucide/svelte/icons/moon'
	import SunIcon from '@lucide/svelte/icons/sun'
	import { toast } from 'svelte-sonner'
	import { profilesStore } from '$lib/stores/profiles.svelte'

	interface Settings {
		email: string
		biovault_path: string
		syftbox_server_url: string
		docker_path: string
		java_path: string
		syftbox_path: string
		agent_bridge_enabled: boolean
		agent_bridge_port: number
		agent_bridge_http_port: number
		agent_bridge_token?: string | null
		agent_bridge_blocklist: string[]
	}

	interface KeyStatus {
		identity: string
		exists: boolean
		vault_fingerprint?: string
		bundle_path?: string
	}

	interface KeyOperationResult {
		identity: string
		fingerprint: string
		vault_path: string
		bundle_path: string
		export_path: string
		mnemonic?: string
	}

	interface RepublishResult {
		identity: string
		fingerprint: string
		export_path: string
		vault_matches_export: boolean
	}

	let settings: Settings | null = $state(null)
	let keyStatus: KeyStatus | null = $state(null)
	let loading = $state(true)
	let error: string | null = $state(null)
	let appVersion = $state('')
	let updaterDisabled = $state(false)
	let checkingUpdates = $state(false)
	let autostartEnabled = $state(false)
	let autostartLoading = $state(true)
	let autostartSaving = $state(false)
	let resetting = $state(false)
	let agentBridgeEnabled = $state(true)
	let agentBridgePort = $state(3333)
	let agentBridgeHttpPort = $state(3334)
	let agentBridgeToken = $state('')
	let showAgentBridgeToken = $state(false)
	let agentBridgeCommands = $state<string[]>([])
	let selectedAllowedCommands = $state(new Set<string>())
	let selectedBlockedCommands = $state(new Set<string>())
	let allowedCommandFilter = $state('')
	let blockedCommandFilter = $state('')
	let savingAgentBridge = $state(false)
	let restartingAgentBridge = $state(false)
	let copiedAgentBridgeCommand = $state(false)
	let agentBridgeSaveStatus = $state<{ message: string; tone: 'success' | 'error' } | null>(null)

	// Key management state
	let showRestoreDialog = $state(false)
	let showRegenerateConfirm = $state(false)
	let restoreMnemonic = $state('')
	let restoring = $state(false)
	let regenerating = $state(false)
	let republishing = $state(false)
	let newRecoveryPhrase = $state<string | null>(null)
	let showNewRecoveryDialog = $state(false)
	let copied = $state(false)

	async function loadKeyStatus() {
		if (!settings?.email) return
		try {
			keyStatus = await invoke<KeyStatus>('key_get_status', { email: settings.email })
		} catch (e) {
			console.error('Failed to load key status:', e)
		}
	}

	async function loadAutostartStatus() {
		try {
			autostartEnabled = await invoke<boolean>('get_autostart_enabled')
		} catch (e) {
			console.error('Failed to load autostart status:', e)
		} finally {
			autostartLoading = false
		}
	}

	async function loadAgentBridgeCommands() {
		try {
			const commands = await invoke<string[]>('get_agent_api_commands')
			agentBridgeCommands = Array.isArray(commands) ? [...commands].sort() : []
		} catch (e) {
			console.error('Failed to load agent bridge commands:', e)
			agentBridgeCommands = []
		}
	}

	function syncAgentBridgeSettings(loadedSettings: Settings) {
		agentBridgeEnabled = loadedSettings.agent_bridge_enabled ?? true
		agentBridgePort = loadedSettings.agent_bridge_port || 3333
		agentBridgeHttpPort = loadedSettings.agent_bridge_http_port || 3334
		agentBridgeToken = loadedSettings.agent_bridge_token || ''
		selectedAllowedCommands = new Set()
		selectedBlockedCommands = new Set()
	}

	function handleThemeToggle(next: boolean) {
		setMode(next ? 'dark' : 'light')
	}

	onMount(() => {
		let unlistenAutostart: null | (() => void) = null

		void (async () => {
			try {
				unlistenAutostart = await listen('autostart-changed', async () => {
					await loadAutostartStatus()
				})

				const [loadedSettings, _profilesLoaded, version, isUpdaterDisabled] = await Promise.all([
					invoke<Settings>('get_settings'),
					profilesStore.load(),
					getVersion().catch(() => ''),
					invoke<boolean>('is_updater_disabled').catch(() => false)
				])
				settings = loadedSettings
				appVersion = version
				updaterDisabled = isUpdaterDisabled
				syncAgentBridgeSettings(loadedSettings)
				await loadKeyStatus()
				await loadAutostartStatus()
				await loadAgentBridgeCommands()
			} catch (e) {
				error = e instanceof Error ? e.message : String(e)
			} finally {
				loading = false
			}
		})()

		return () => {
			unlistenAutostart?.()
		}
	})

	async function handleRestore() {
		if (!restoreMnemonic.trim() || !settings?.email) return

		restoring = true
		try {
			await invoke<KeyOperationResult>('key_restore', {
				email: settings.email,
				mnemonic: restoreMnemonic.trim()
			})
			toast.success('Key restored successfully')
			showRestoreDialog = false
			restoreMnemonic = ''
			await loadKeyStatus()
		} catch (e) {
			toast.error('Failed to restore key', {
				description: e instanceof Error ? e.message : String(e)
			})
		} finally {
			restoring = false
		}
	}

	async function handleRegenerate() {
		if (!settings?.email) return

		regenerating = true
		try {
			const result = await invoke<KeyOperationResult>('key_generate', {
				email: settings.email,
				force: true
			})
			showRegenerateConfirm = false
			await loadKeyStatus()

			if (result.mnemonic) {
				newRecoveryPhrase = result.mnemonic
				showNewRecoveryDialog = true
			} else {
				toast.success('Key regenerated successfully')
			}
		} catch (e) {
			toast.error('Failed to regenerate key', {
				description: e instanceof Error ? e.message : String(e)
			})
		} finally {
			regenerating = false
		}
	}

	async function copyFingerprint() {
		if (keyStatus?.vault_fingerprint) {
			await navigator.clipboard.writeText(keyStatus.vault_fingerprint)
			copied = true
			toast.success('Fingerprint copied to clipboard')
			setTimeout(() => {
				copied = false
			}, 2000)
		}
	}

	async function copyRecoveryPhrase() {
		if (newRecoveryPhrase) {
			await navigator.clipboard.writeText(newRecoveryPhrase)
			toast.success('Recovery phrase copied to clipboard')
		}
	}

	async function handleRepublishDid() {
		if (!settings?.email) return
		republishing = true
		try {
			const result = await invoke<RepublishResult>('key_republish', {
				email: settings.email
			})
			toast.success('DID republished successfully', {
				description: `Fingerprint: ${result.fingerprint}`
			})
			await loadKeyStatus()
		} catch (e) {
			toast.error('Failed to republish DID', {
				description: e instanceof Error ? e.message : String(e)
			})
		} finally {
			republishing = false
		}
	}

	async function handleAutostartToggle(enabled: boolean) {
		const previous = autostartEnabled
		autostartEnabled = enabled
		autostartSaving = true
		try {
			await invoke('set_autostart_enabled', { enabled })
		} catch (e) {
			autostartEnabled = previous
			toast.error('Failed to update startup setting', {
				description: e instanceof Error ? e.message : String(e)
			})
		} finally {
			autostartSaving = false
		}
	}

	async function handleCheckForUpdates() {
		if (checkingUpdates) return

		checkingUpdates = true
		try {
			if (updaterDisabled) {
				await message('Updates are disabled in this build.', {
					title: 'Updates'
				})
				return
			}

			const tauriWindow = window as Window & {
				__TAURI__?: {
					updater?: {
						check: () => Promise<{
							version: string
							body?: string | null
							downloadAndInstall: (cb?: (event: unknown) => void) => Promise<void>
						} | null>
					}
					process?: {
						relaunch: () => Promise<void>
					}
				}
			}

			const updater = tauriWindow.__TAURI__?.updater
			const process = tauriWindow.__TAURI__?.process
			if (!updater?.check || !process?.relaunch) {
				await message('Update checks are only available in the installed app.', {
					title: 'Updates'
				})
				return
			}

			const update = await updater.check()
			if (!update) {
				await message('You are running the latest version!', {
					title: 'No Updates'
				})
				return
			}

			const shouldInstall = await confirm(
				`Update to version ${update.version} is available.${update.body ? `\n\nRelease notes:\n${update.body}` : ''}\n\nWould you like to install it now?`,
				{
					title: 'Update Available',
					kind: 'info'
				}
			)
			if (!shouldInstall) return

			await message('Downloading update...', {
				title: 'Updating'
			})
			await update.downloadAndInstall()
			await message('Update installed! The app will restart now.', {
				title: 'Update Complete'
			})
			await process.relaunch()
		} catch (e) {
			await message(e instanceof Error ? e.message : String(e), {
				title: 'Update Error',
				kind: 'error'
			})
		} finally {
			checkingUpdates = false
		}
	}

	async function handleResetAllData() {
		if (resetting) return

		const confirmed = await confirm(
			'This will DELETE ALL DATA including participants, files, modules, and runs. It will also stop any running Jupyter sessions and the SyftBox background process.\n\nThis cannot be undone.\n\nAre you sure?',
			{
				title: 'Reset BioVault Data',
				kind: 'warning'
			}
		)
		if (!confirmed) return

		const wipeKeys = await confirm(
			'Do you also want to delete your identity keys (.sbc)?\n\nChoose Yes to fully reset everything.\nChoose No to reset data but keep your keys.',
			{
				title: 'Reset Everything?',
				kind: 'warning'
			}
		)

		resetting = true
		try {
			if (wipeKeys) {
				await invoke('reset_everything')
			} else {
				await invoke('reset_all_data')
			}

			await message(
				wipeKeys
					? 'All data and keys have been reset. The app will now reload.'
					: 'All data has been reset and your keys were preserved. The app will now reload.',
				{
					title: 'Reset Complete'
				}
			)
			window.location.reload()
		} catch (e) {
			await message(`Error resetting data: ${e instanceof Error ? e.message : String(e)}`, {
				title: 'Error',
				kind: 'error'
			})
		} finally {
			resetting = false
		}
	}

	function randomAgentBridgePort(min = 20000, max = 60000) {
		return min + Math.floor(Math.random() * (max - min))
	}

	function randomizeAgentBridgePorts() {
		agentBridgePort = randomAgentBridgePort()
		agentBridgeHttpPort = randomAgentBridgePort()
		while (agentBridgeHttpPort === agentBridgePort) {
			agentBridgeHttpPort = randomAgentBridgePort()
		}
	}

	function currentAgentBridgeBlocklist() {
		return settings?.agent_bridge_blocklist || []
	}

	function filteredAllowedCommands() {
		const blocked = new Set(currentAgentBridgeBlocklist())
		const filter = allowedCommandFilter.trim().toLowerCase()
		return agentBridgeCommands.filter((cmd) => {
			if (blocked.has(cmd)) return false
			return !filter || cmd.toLowerCase().includes(filter)
		})
	}

	function filteredBlockedCommands() {
		const filter = blockedCommandFilter.trim().toLowerCase()
		return currentAgentBridgeBlocklist().filter(
			(cmd) => !filter || cmd.toLowerCase().includes(filter)
		)
	}

	function toggleAllowedCommandSelection(cmd: string) {
		if (selectedAllowedCommands.has(cmd)) {
			selectedAllowedCommands.delete(cmd)
		} else {
			selectedAllowedCommands.add(cmd)
		}
		selectedAllowedCommands = new Set(selectedAllowedCommands)
	}

	function toggleBlockedCommandSelection(cmd: string) {
		if (selectedBlockedCommands.has(cmd)) {
			selectedBlockedCommands.delete(cmd)
		} else {
			selectedBlockedCommands.add(cmd)
		}
		selectedBlockedCommands = new Set(selectedBlockedCommands)
	}

	function blockSelectedCommands() {
		if (!settings) return
		const next = new Set(settings.agent_bridge_blocklist || [])
		selectedAllowedCommands.forEach((cmd) => next.add(cmd))
		settings = { ...settings, agent_bridge_blocklist: Array.from(next).sort() }
		selectedAllowedCommands = new Set()
	}

	function allowSelectedCommands() {
		if (!settings) return
		const next = new Set(settings.agent_bridge_blocklist || [])
		selectedBlockedCommands.forEach((cmd) => next.delete(cmd))
		settings = { ...settings, agent_bridge_blocklist: Array.from(next).sort() }
		selectedBlockedCommands = new Set()
	}

	function agentBridgeCommandPreview() {
		const token = showAgentBridgeToken && agentBridgeToken.trim() ? agentBridgeToken.trim() : 'TOKEN'
		return `curl -s -H "Authorization: Bearer ${token}" http://127.0.0.1:${agentBridgeHttpPort}/schema`
	}

	async function copyAgentBridgeCommand() {
		try {
			await navigator.clipboard.writeText(agentBridgeCommandPreview())
			copiedAgentBridgeCommand = true
			setTimeout(() => {
				copiedAgentBridgeCommand = false
			}, 1500)
		} catch (e) {
			toast.error('Failed to copy command', {
				description: e instanceof Error ? e.message : String(e)
			})
		}
	}

	async function restartAgentBridge() {
		restartingAgentBridge = true
		agentBridgeSaveStatus = null
		try {
			await invoke('restart_agent_bridge')
			agentBridgeSaveStatus = { message: 'Agent bridge restarted.', tone: 'success' }
		} catch (e) {
			agentBridgeSaveStatus = {
				message: e instanceof Error ? e.message : String(e),
				tone: 'error'
			}
		} finally {
			restartingAgentBridge = false
		}
	}

	async function saveAgentBridgeSettings() {
		if (!settings) return

		if (!Number.isInteger(agentBridgePort) || agentBridgePort < 1 || agentBridgePort > 65535) {
			agentBridgeSaveStatus = {
				message: 'Agent bridge port must be between 1 and 65535.',
				tone: 'error'
			}
			return
		}

		if (
			!Number.isInteger(agentBridgeHttpPort) ||
			agentBridgeHttpPort < 1 ||
			agentBridgeHttpPort > 65535
		) {
			agentBridgeSaveStatus = {
				message: 'Agent bridge HTTP port must be between 1 and 65535.',
				tone: 'error'
			}
			return
		}

		const nextBlocklist = [...(settings.agent_bridge_blocklist || [])].sort()
		const shouldRestart =
			settings.agent_bridge_enabled !== agentBridgeEnabled ||
			settings.agent_bridge_port !== agentBridgePort ||
			settings.agent_bridge_http_port !== agentBridgeHttpPort

		savingAgentBridge = true
		agentBridgeSaveStatus = null
		try {
			const currentSettings = await invoke<Record<string, unknown>>('get_settings')
			const nextSettings = {
				...currentSettings,
				agent_bridge_enabled: agentBridgeEnabled,
				agent_bridge_port: agentBridgePort,
				agent_bridge_http_port: agentBridgeHttpPort,
				agent_bridge_token: agentBridgeToken.trim() || null,
				agent_bridge_blocklist: nextBlocklist
			}
			await invoke('save_settings', { settings: nextSettings })
			settings = {
				...settings,
				agent_bridge_enabled: agentBridgeEnabled,
				agent_bridge_port: agentBridgePort,
				agent_bridge_http_port: agentBridgeHttpPort,
				agent_bridge_token: agentBridgeToken.trim() || null,
				agent_bridge_blocklist: nextBlocklist
			}
			agentBridgeSaveStatus = { message: 'Agent bridge settings saved.', tone: 'success' }
			if (shouldRestart) {
				await restartAgentBridge()
			}
		} catch (e) {
			agentBridgeSaveStatus = {
				message: e instanceof Error ? e.message : String(e),
				tone: 'error'
			}
		} finally {
			savingAgentBridge = false
		}
	}
</script>

<div class="flex h-full flex-col">
	<PageHeader title="Settings" description="Configure your BioVault preferences" />

	<div class="flex-1 overflow-auto p-6">
		<div class="mx-auto max-w-2xl space-y-6">

	{#if loading}
		<div class="text-muted-foreground">Loading settings...</div>
	{:else if error}
		<Card.Root class="border-destructive">
			<Card.Header>
				<Card.Title class="text-destructive">Error</Card.Title>
			</Card.Header>
			<Card.Content>
				<p>{error}</p>
			</Card.Content>
		</Card.Root>
	{:else if settings}
			<Card.Root>
				<Card.Header>
					<Card.Title>Updates</Card.Title>
					<Card.Description>Keep BioVault up to date</Card.Description>
				</Card.Header>
				<Card.Content class="flex items-start justify-between gap-4">
					<div class="space-y-1">
						<div class="text-sm font-medium">Version: {appVersion ? `v${appVersion}` : 'Unknown'}</div>
						<p class="text-muted-foreground text-sm">
							Check for new updates to get the latest features and fixes
						</p>
						<a
							href="https://github.com/OpenMined/biovault-desktop/releases"
							target="_blank"
							rel="noreferrer"
							class="text-primary inline-flex items-center gap-1 text-sm hover:underline"
						>
							<span aria-hidden="true">🔗</span>
							<span>View all releases</span>
						</a>
					</div>
					<Button onclick={handleCheckForUpdates} disabled={checkingUpdates}>
						{#if checkingUpdates}
							<Loader2Icon class="size-4 animate-spin" />
							Checking...
						{:else}
							Check for Updates
					{/if}
					</Button>
				</Card.Content>
			</Card.Root>

			<Card.Root>
				<Card.Header>
					<Card.Title>Application Settings</Card.Title>
					<Card.Description>Desktop app startup preferences</Card.Description>
				</Card.Header>
				<Card.Content class="space-y-4">
					<div class="flex items-center justify-between gap-4 rounded-lg border p-4">
						<div class="space-y-1">
							<div class="font-medium">Theme</div>
							<p class="text-muted-foreground text-sm">
								Switch between the light and dark app themes
							</p>
						</div>
						<div class="flex items-center gap-3">
							<div class="text-muted-foreground text-sm">
								{mode.current === 'dark' ? 'Dark' : 'Light'}
							</div>
							<div class="flex items-center gap-2">
								<SunIcon class="text-muted-foreground size-4" />
								<Switch
									checked={mode.current === 'dark'}
									onCheckedChange={handleThemeToggle}
								/>
								<MoonIcon class="text-muted-foreground size-4" />
							</div>
						</div>
					</div>

					<div class="flex items-center justify-between gap-4 rounded-lg border p-4">
						<div class="space-y-1">
							<div class="font-medium">Start on Startup</div>
							<p class="text-muted-foreground text-sm">
								Automatically launch BioVault when you log in
							</p>
						</div>
						<Switch
							checked={autostartEnabled}
							onCheckedChange={handleAutostartToggle}
							disabled={autostartLoading || autostartSaving}
						/>
					</div>
				</Card.Content>
			</Card.Root>

			<Card.Root>
				<Card.Header>
					<Card.Title>Agent WebSocket Bridge</Card.Title>
					<Card.Description>
						Control local agent access, configure ports, and manage command blocklists.
					</Card.Description>
				</Card.Header>
				<Card.Content class="space-y-4">
					<div class="flex items-center justify-between gap-4 rounded-lg border p-4">
						<div class="space-y-1">
							<div class="font-medium">Enable Agent Bridge</div>
							<p class="text-muted-foreground text-sm">
								Allow external agents to connect to the local bridge
							</p>
						</div>
						<Switch bind:checked={agentBridgeEnabled} />
					</div>

					<div class="grid gap-4 md:grid-cols-2">
						<div class="space-y-2">
							<Label for="agent-bridge-port">WebSocket Port</Label>
							<Input id="agent-bridge-port" type="number" bind:value={agentBridgePort} />
						</div>
						<div class="space-y-2">
							<Label for="agent-bridge-http-port">HTTP Port</Label>
							<Input id="agent-bridge-http-port" type="number" bind:value={agentBridgeHttpPort} />
						</div>
					</div>

					<div class="space-y-2">
						<Label for="agent-bridge-token">Token (optional)</Label>
						<div class="relative">
							<Input
								id="agent-bridge-token"
								type={showAgentBridgeToken ? 'text' : 'password'}
								placeholder="Leave blank for no auth"
								bind:value={agentBridgeToken}
								class="pr-10"
							/>
							<Button
								variant="ghost"
								size="icon"
								class="absolute right-0 top-0 size-9"
								onclick={() => (showAgentBridgeToken = !showAgentBridgeToken)}
								aria-label={showAgentBridgeToken ? 'Hide token' : 'Show token'}
							>
								{#if showAgentBridgeToken}
									<EyeOffIcon class="size-4" />
								{:else}
									<EyeIcon class="size-4" />
								{/if}
							</Button>
						</div>
					</div>

					<div class="flex flex-wrap gap-2">
						<Button variant="outline" size="sm" onclick={randomizeAgentBridgePorts}>
							<ShuffleIcon class="size-4" />
							Randomize Ports
						</Button>
						<Button
							variant="outline"
							size="sm"
							onclick={restartAgentBridge}
							disabled={restartingAgentBridge}
						>
							{#if restartingAgentBridge}
								<Loader2Icon class="size-4 animate-spin" />
								Restarting...
							{:else}
								<RefreshCwIcon class="size-4" />
								Restart Bridge
							{/if}
						</Button>
					</div>

					<div class="space-y-2">
						<Label>LLM-friendly API command</Label>
						<div class="relative">
							<code
								class="bg-muted block overflow-x-auto rounded-md border p-3 pr-12 font-mono text-xs whitespace-nowrap"
							>
								{agentBridgeCommandPreview()}
							</code>
							<Button
								variant="ghost"
								size="icon-sm"
								class="absolute right-2 top-2"
								onclick={copyAgentBridgeCommand}
								aria-label="Copy agent bridge command"
							>
								{#if copiedAgentBridgeCommand}
									<CheckIcon class="size-4 text-emerald-500" />
								{:else}
									<CopyIcon class="size-4" />
								{/if}
							</Button>
						</div>
					</div>

					<div class="space-y-2">
						<Label>Command Access Control</Label>
						<div class="grid gap-3 md:grid-cols-[1fr_auto_1fr]">
							<div class="space-y-2">
								<div class="flex items-center justify-between">
									<div class="text-muted-foreground text-sm font-medium">Allowed commands</div>
									<div class="text-muted-foreground text-xs">{filteredAllowedCommands().length}</div>
								</div>
								<Input
									type="text"
									placeholder="Filter commands"
									bind:value={allowedCommandFilter}
								/>
								<div class="h-40 space-y-1 overflow-y-auto rounded-md border p-2">
									{#each filteredAllowedCommands() as cmd (cmd)}
										<button
											type="button"
											class="hover:bg-muted w-full rounded px-2 py-1 text-left font-mono text-xs {selectedAllowedCommands.has(
												cmd,
											)
												? 'bg-primary/10 text-primary'
												: ''}"
											onclick={() => toggleAllowedCommandSelection(cmd)}
										>
											{cmd}
										</button>
									{/each}
									{#if filteredAllowedCommands().length === 0}
										<div class="text-muted-foreground py-4 text-center text-sm">No commands</div>
									{/if}
								</div>
							</div>

							<div class="flex items-center justify-center gap-2 md:flex-col">
								<Button
									variant="outline"
									size="icon-sm"
									onclick={blockSelectedCommands}
									disabled={selectedAllowedCommands.size === 0}
									title="Block selected"
								>
									<ChevronRightIcon class="size-4" />
								</Button>
								<Button
									variant="outline"
									size="icon-sm"
									onclick={allowSelectedCommands}
									disabled={selectedBlockedCommands.size === 0}
									title="Allow selected"
								>
									<ChevronLeftIcon class="size-4" />
								</Button>
							</div>

							<div class="space-y-2">
								<div class="flex items-center justify-between">
									<div class="text-muted-foreground text-sm font-medium">Blocked commands</div>
									<div class="text-muted-foreground text-xs">{filteredBlockedCommands().length}</div>
								</div>
								<Input
									type="text"
									placeholder="Filter commands"
									bind:value={blockedCommandFilter}
								/>
								<div class="h-40 space-y-1 overflow-y-auto rounded-md border p-2">
									{#each filteredBlockedCommands() as cmd (cmd)}
										<button
											type="button"
											class="hover:bg-muted text-destructive w-full rounded px-2 py-1 text-left font-mono text-xs {selectedBlockedCommands.has(
												cmd,
											)
												? 'bg-destructive/10'
												: ''}"
											onclick={() => toggleBlockedCommandSelection(cmd)}
										>
											{cmd}
										</button>
									{/each}
									{#if filteredBlockedCommands().length === 0}
										<div class="text-muted-foreground py-4 text-center text-sm">No commands</div>
									{/if}
								</div>
							</div>
						</div>
					</div>

					<div class="flex items-center justify-between gap-4 border-t pt-4">
						{#if agentBridgeSaveStatus}
							<p
								class="text-sm {agentBridgeSaveStatus.tone === 'success'
									? 'text-emerald-600'
									: 'text-destructive'}"
							>
								{agentBridgeSaveStatus.message}
							</p>
						{:else}
							<div></div>
						{/if}
						<Button onclick={saveAgentBridgeSettings} disabled={savingAgentBridge}>
							{#if savingAgentBridge}
								<Loader2Icon class="size-4 animate-spin" />
								Saving...
							{:else}
								Save Agent Bridge
							{/if}
						</Button>
					</div>
				</Card.Content>
			</Card.Root>

			<Card.Root>
				<Card.Header>
					<Card.Title class="flex items-center gap-2">
						<UserIcon class="size-5" />
						Identity
					</Card.Title>
					<Card.Description>Your BioVault identity and account information</Card.Description>
				</Card.Header>
				<Card.Content class="space-y-4">
					<div class="flex items-center gap-3">
						<MailIcon class="text-muted-foreground size-4" />
						<div>
							<div class="text-muted-foreground text-sm">Email</div>
							<div class="font-medium">{settings.email || 'Not configured'}</div>
						</div>
					</div>
				</Card.Content>
			</Card.Root>

			<Card.Root>
				<Card.Header>
					<Card.Title class="flex items-center gap-2">
						<UserIcon class="size-5" />
						Active Profile
					</Card.Title>
					<Card.Description>The profile currently loaded by this app window</Card.Description>
				</Card.Header>
				<Card.Content class="space-y-4">
					<div>
						<div class="text-muted-foreground text-sm">Profile Email</div>
						<div class="font-medium">{profilesStore.currentProfile?.email || 'Not selected'}</div>
					</div>
					<div>
						<div class="text-muted-foreground text-sm">Profile Home</div>
						<div class="font-mono text-sm">
							{profilesStore.currentProfile?.biovault_home || 'Not selected'}
						</div>
					</div>
				</Card.Content>
			</Card.Root>

		<Card.Root>
			<Card.Header>
				<Card.Title class="flex items-center gap-2">
					<FolderIcon class="size-5" />
					Paths
				</Card.Title>
				<Card.Description>File system paths and locations</Card.Description>
			</Card.Header>
			<Card.Content class="space-y-4">
				<div>
					<div class="text-muted-foreground text-sm">BioVault Home</div>
					<div class="font-mono text-sm">{settings.biovault_path || 'Not set'}</div>
				</div>
			</Card.Content>
		</Card.Root>

		<Card.Root>
			<Card.Header>
				<Card.Title class="flex items-center gap-2">
					<ServerIcon class="size-5" />
					Server
				</Card.Title>
				<Card.Description>SyftBox server configuration</Card.Description>
			</Card.Header>
			<Card.Content class="space-y-4">
				<div>
					<div class="text-muted-foreground text-sm">SyftBox Server URL</div>
					<div class="font-mono text-sm">{settings.syftbox_server_url || 'Default'}</div>
				</div>
			</Card.Content>
		</Card.Root>

		<Card.Root>
			<Card.Header>
				<Card.Title class="flex items-center gap-2">
					<ShieldIcon class="size-5" />
					Security
				</Card.Title>
				<Card.Description>Encryption keys and recovery options</Card.Description>
			</Card.Header>
			<Card.Content class="space-y-4">
				{#if keyStatus?.exists}
					<div class="flex items-start justify-between gap-4">
						<div class="flex-1 min-w-0">
							<div class="text-muted-foreground text-sm">Key Fingerprint</div>
							<div class="font-mono text-sm truncate" title={keyStatus.vault_fingerprint}>
								{keyStatus.vault_fingerprint || 'Unknown'}
							</div>
						</div>
						<Button variant="ghost" size="icon" onclick={copyFingerprint}>
							{#if copied}
								<CheckIcon class="size-4 text-emerald-500" />
							{:else}
								<CopyIcon class="size-4" />
							{/if}
						</Button>
					</div>

					<div class="flex gap-2 pt-2">
						<Button variant="outline" size="sm" onclick={() => (showRestoreDialog = true)}>
							<DownloadIcon class="size-4" />
							Restore from Backup
						</Button>
						<Button variant="outline" size="sm" onclick={() => (showRegenerateConfirm = true)}>
							<RefreshCwIcon class="size-4" />
							Regenerate Key
						</Button>
						<Button variant="outline" size="sm" onclick={handleRepublishDid} disabled={republishing}>
							{#if republishing}
								<Loader2Icon class="size-4 animate-spin" />
								Republishing...
							{:else}
								<RefreshCwIcon class="size-4" />
								Republish DID
							{/if}
						</Button>
					</div>
				{:else}
					<div class="text-muted-foreground text-sm">
						No encryption key found. Sign in to SyftBox to generate one.
					</div>
				{/if}
			</Card.Content>
		</Card.Root>

		<Card.Root class="border-destructive/50">
			<Card.Header>
				<Card.Title class="text-destructive">Danger Zone</Card.Title>
				<Card.Description>
					This will delete ALL BioVault data including participants, files, modules, and runs.
					This cannot be undone!
				</Card.Description>
			</Card.Header>
			<Card.Content>
				<Button variant="destructive" onclick={handleResetAllData} disabled={resetting}>
					{#if resetting}
						<Loader2Icon class="size-4 animate-spin" />
						Resetting...
					{:else}
						Reset All Data
					{/if}
				</Button>
			</Card.Content>
		</Card.Root>
	{/if}
		</div>
	</div>
</div>

<!-- Restore Key Dialog -->
<Dialog.Root bind:open={showRestoreDialog}>
	<Dialog.Content class="sm:max-w-md">
		<Dialog.Header>
			<Dialog.Title class="flex items-center gap-2">
				<KeyIcon class="size-5" />
				Restore Key from Backup
			</Dialog.Title>
			<Dialog.Description>
				Enter your recovery phrase to restore your encryption key.
			</Dialog.Description>
		</Dialog.Header>

		<div class="space-y-4 py-4">
			<div class="space-y-2">
				<Label for="mnemonic">Recovery Phrase</Label>
				<Input
					id="mnemonic"
					type="text"
					placeholder="Enter your recovery phrase..."
					bind:value={restoreMnemonic}
					disabled={restoring}
				/>
			</div>
		</div>

		<Dialog.Footer>
			<Button variant="outline" onclick={() => (showRestoreDialog = false)} disabled={restoring}>
				Cancel
			</Button>
			<Button onclick={handleRestore} disabled={restoring || !restoreMnemonic.trim()}>
				{#if restoring}
					<Loader2Icon class="size-4 animate-spin" />
					Restoring...
				{:else}
					Restore Key
				{/if}
			</Button>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>

<!-- Regenerate Confirmation -->
<AlertDialog.Root bind:open={showRegenerateConfirm}>
	<AlertDialog.Content>
		<AlertDialog.Header>
			<AlertDialog.Title>Regenerate Encryption Key?</AlertDialog.Title>
			<AlertDialog.Description>
				This will create a new encryption key and invalidate your old one. Make sure you have backed
				up any data encrypted with your current key. This action cannot be undone.
			</AlertDialog.Description>
		</AlertDialog.Header>
		<AlertDialog.Footer>
			<AlertDialog.Cancel disabled={regenerating}>Cancel</AlertDialog.Cancel>
			<AlertDialog.Action
				onclick={handleRegenerate}
				disabled={regenerating}
				class="bg-destructive text-destructive-foreground hover:bg-destructive/90"
			>
				{#if regenerating}
					Regenerating...
				{:else}
					Regenerate Key
				{/if}
			</AlertDialog.Action>
		</AlertDialog.Footer>
	</AlertDialog.Content>
</AlertDialog.Root>

<!-- New Recovery Phrase Dialog -->
<Dialog.Root bind:open={showNewRecoveryDialog}>
	<Dialog.Content class="sm:max-w-md">
		<Dialog.Header>
			<Dialog.Title class="flex items-center gap-2">
				<ShieldIcon class="size-5" />
				New Recovery Phrase
			</Dialog.Title>
			<Dialog.Description>
				Your new encryption key has been generated. Save this recovery phrase - you won't see it
				again.
			</Dialog.Description>
		</Dialog.Header>

		<div class="space-y-4 py-4">
			<div class="relative">
				<div
					class="bg-muted rounded-lg p-4 font-mono text-sm break-all select-all border-2 border-amber-500/50"
				>
					{newRecoveryPhrase}
				</div>
				<Button variant="outline" size="sm" class="absolute top-2 right-2" onclick={copyRecoveryPhrase}>
					<CopyIcon class="size-4" />
				</Button>
			</div>

			<div
				class="bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800 rounded-lg p-3"
			>
				<p class="text-sm text-amber-800 dark:text-amber-200">
					<strong>Important:</strong> Write this down or save it in a password manager. This is the
					only way to recover your encryption key.
				</p>
			</div>
		</div>

		<Dialog.Footer>
			<Button onclick={() => (showNewRecoveryDialog = false)}>I've Saved It</Button>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>
