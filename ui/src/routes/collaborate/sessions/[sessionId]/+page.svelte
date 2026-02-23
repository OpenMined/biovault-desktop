<script lang="ts">
	import { invoke } from '@tauri-apps/api/core'
	import { goto } from '$app/navigation'
	import { page } from '$app/state'
	import { onMount } from 'svelte'
	import PageHeader from '$lib/components/page-header.svelte'
	import ConversationPanel from '$lib/components/conversation-panel.svelte'
	import { buildSessionConversationAdapter, type ConversationAdapter } from '$lib/collab/conversation-adapters'
	import { Button } from '$lib/components/ui/button/index.js'
	import { Input } from '$lib/components/ui/input/index.js'
	import { Badge } from '$lib/components/ui/badge/index.js'
	import Loader2Icon from '@lucide/svelte/icons/loader-2'
	import PlayIcon from '@lucide/svelte/icons/play'
	import SquareIcon from '@lucide/svelte/icons/square'
	import RotateCcwIcon from '@lucide/svelte/icons/rotate-ccw'
	import ExternalLinkIcon from '@lucide/svelte/icons/external-link'
	import FolderOpenIcon from '@lucide/svelte/icons/folder-open'
	import TrashIcon from '@lucide/svelte/icons/trash-2'
	import ChevronLeftIcon from '@lucide/svelte/icons/chevron-left'
	import { toast } from 'svelte-sonner'

	interface Session {
		id: number
		session_id: string
		name: string
		description?: string | null
		session_path: string
		owner: string
		peer?: string | null
		role: string
		status: string
		created_at: string
	}

	interface SessionJupyterStatus {
		session_id: string
		running: boolean
		port?: number | null
		url?: string | null
		token?: string | null
	}

	interface SessionDataset {
		id: number
		session_id: string
		dataset_public_url: string
		dataset_owner: string
		dataset_name: string
		role: string
		created_at: string
	}

	interface VaultMessage {
		id: string
		from: string
		body: string
		created_at: string
	}

	let loading = $state(true)
	let session = $state<Session | null>(null)
	let currentUserEmail = $state('')

	let jupyter = $state<SessionJupyterStatus | null>(null)
	let jupyterLoading = $state(false)

	let datasets = $state<SessionDataset[]>([])
	let datasetsLoading = $state(false)
	let datasetUrl = $state('')
	let datasetAdding = $state(false)

	let chatReloadSignal = $state(0)

	const sessionId = $derived(page.params.sessionId || '')

	function formatFullTime(value: string): string {
		const date = new Date(value)
		return date.toLocaleString([], {
			month: 'short',
			day: 'numeric',
			hour: '2-digit',
			minute: '2-digit',
		})
	}

	async function getCurrentUserEmail(): Promise<string> {
		try {
			const settings = await invoke<{ email?: string }>('get_settings')
			return settings?.email || ''
		} catch {
			return ''
		}
	}

	async function openUrl(url: string) {
		try {
			await invoke('open_url', { url })
		} catch {
			window.open(url, '_blank')
		}
	}

	async function loadSession() {
		session = await invoke<Session>('get_session', { sessionId })
	}

	async function loadJupyter() {
		jupyterLoading = true
		try {
			jupyter = await invoke<SessionJupyterStatus>('get_session_jupyter_status', { sessionId })
		} finally {
			jupyterLoading = false
		}
	}

	async function loadDatasets() {
		datasetsLoading = true
		try {
			datasets = await invoke<SessionDataset[]>('list_session_datasets', { sessionId })
		} finally {
			datasetsLoading = false
		}
	}

	async function loadWorkspace() {
		if (!sessionId) return
		loading = true
		try {
			await loadSession()
			await Promise.all([loadJupyter(), loadDatasets()])
			chatReloadSignal += 1
		} finally {
			loading = false
		}
	}

	async function launchJupyter() {
		if (jupyterLoading) return
		jupyterLoading = true
		try {
			jupyter = await invoke<SessionJupyterStatus>('launch_session_jupyter', {
				sessionId,
				pythonVersion: null,
				copyExamples: true,
			})
			toast.success('Jupyter launched')
		} catch (e) {
			toast.error('Failed to launch Jupyter', { description: String(e) })
		} finally {
			jupyterLoading = false
		}
	}

	async function stopJupyter() {
		if (jupyterLoading) return
		jupyterLoading = true
		try {
			jupyter = await invoke<SessionJupyterStatus>('stop_session_jupyter', { sessionId })
			toast.success('Jupyter stopped')
		} catch (e) {
			toast.error('Failed to stop Jupyter', { description: String(e) })
		} finally {
			jupyterLoading = false
		}
	}

	async function resetJupyter() {
		if (jupyterLoading) return
		jupyterLoading = true
		try {
			jupyter = await invoke<SessionJupyterStatus>('reset_session_jupyter', {
				sessionId,
				pythonVersion: null,
			})
			toast.success('Jupyter reset complete')
		} catch (e) {
			toast.error('Failed to reset Jupyter', { description: String(e) })
		} finally {
			jupyterLoading = false
		}
	}

	async function addDataset() {
		const url = datasetUrl.trim()
		if (!url || datasetAdding) return
		datasetAdding = true
		try {
			await invoke('add_dataset_to_session', { sessionId, datasetUrl: url, role: 'shared' })
			datasetUrl = ''
			await loadDatasets()
			toast.success('Dataset linked')
		} catch (e) {
			toast.error('Failed to link dataset', { description: String(e) })
		} finally {
			datasetAdding = false
		}
	}

	async function removeDataset(url: string) {
		try {
			await invoke('remove_dataset_from_session', { sessionId, datasetUrl: url })
			await loadDatasets()
			toast.success('Dataset removed')
		} catch (e) {
			toast.error('Failed to remove dataset', { description: String(e) })
		}
	}

	async function attachPathsToSession(paths: string[]) {
		const clean = paths.map((p) => p.trim()).filter((p) => p.length > 0)
		if (clean.length === 0) return
		const copied = await invoke<string[]>('add_files_to_session', {
			sessionId,
			filePaths: clean,
		})
		const count = copied?.length || 0
		if (count > 0) {
			await invoke('send_session_chat_message', {
				sessionId,
				body: `Attached ${count} item${count === 1 ? '' : 's'} to this session.`,
			})
			toast.success(`Attached ${count} item${count === 1 ? '' : 's'}`)
		}
	}

	function sessionConversationAdapter(current: Session): ConversationAdapter<VaultMessage> {
		return buildSessionConversationAdapter<VaultMessage>({
			invoke,
			sessionId,
			currentUserEmail: currentUserEmail || current.owner,
			attachPaths: (paths: string[]) => attachPathsToSession(paths),
		})
	}

	onMount(async () => {
		currentUserEmail = await getCurrentUserEmail()
		await loadWorkspace()
	})
</script>

<div class="flex h-full flex-col bg-[radial-gradient(1000px_500px_at_0%_-10%,hsl(var(--muted))_0%,transparent_55%)]">
	<PageHeader title={session?.name || 'Session'} description="Collaborative session workspace">
		<Button size="sm" variant="outline" onclick={() => goto('/collaborate')}>
			<ChevronLeftIcon class="size-4" />
			Back to Spaces
		</Button>
	</PageHeader>

	<div class="min-h-0 flex-1 overflow-hidden p-4">
		<div class="flex h-full flex-col overflow-hidden rounded-2xl border bg-background/95 shadow-sm">
			{#if loading}
				<div class="flex h-full items-center justify-center text-sm text-muted-foreground">
					<Loader2Icon class="mr-2 size-5 animate-spin" />
					Loading session workspace...
				</div>
			{:else if session}
				<div class="border-b px-5 py-4">
					<div class="flex flex-wrap items-center justify-between gap-3">
						<div>
							<h2 class="text-base font-semibold">{session.name}</h2>
							<p class="text-sm text-muted-foreground">
								{session.status} • {session.owner}{session.peer ? ` • ${session.peer}` : ''}
							</p>
						</div>
					</div>
				</div>

				<div class="min-h-0 flex-1 overflow-hidden p-5">
					<div class="grid h-full gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.15fr)]">
						<div class="min-h-0 rounded-xl border">
							<ConversationPanel
								adapter={sessionConversationAdapter(session)}
								reloadSignal={chatReloadSignal}
							/>
						</div>

						<div class="min-h-0 space-y-4 overflow-auto pr-1">
							<div class="grid gap-3 rounded-xl border p-4 text-sm md:grid-cols-2">
								<div>
									<p class="text-xs text-muted-foreground">Created</p>
									<p>{formatFullTime(session.created_at)}</p>
								</div>
								<div>
									<p class="text-xs text-muted-foreground">Status</p>
									<p>{session.status}</p>
								</div>
								<div>
									<p class="text-xs text-muted-foreground">Owner</p>
									<p>{session.owner}</p>
								</div>
								<div>
									<p class="text-xs text-muted-foreground">Collaborator</p>
									<p>{session.peer || 'Not set'}</p>
								</div>
								<div class="md:col-span-2">
									<p class="text-xs text-muted-foreground">Path</p>
									<p class="truncate font-mono text-xs">{session.session_path}</p>
								</div>
								<div class="md:col-span-2 flex flex-wrap gap-2">
									<Button size="sm" variant="outline" onclick={() => invoke('open_session_folder', { sessionId })}>
										<FolderOpenIcon class="size-4" />
										Open Folder
									</Button>
									{#if jupyter?.url}
										<Button size="sm" variant="outline" onclick={() => openUrl(jupyter!.url || '')}>
											<ExternalLinkIcon class="size-4" />
											Open Notebook URL
										</Button>
									{/if}
								</div>
							</div>

							<div class="space-y-3 rounded-xl border p-4">
								<h3 class="text-sm font-semibold">Linked Datasets</h3>
								<div class="flex gap-2">
									<Input placeholder="syft://.../dataset.yaml" bind:value={datasetUrl} />
									<Button onclick={addDataset} disabled={datasetAdding || !datasetUrl.trim()}>
										{#if datasetAdding}<Loader2Icon class="size-4 animate-spin" />{:else}Add{/if}
									</Button>
								</div>
								{#if datasetsLoading}
									<p class="text-sm text-muted-foreground">Loading datasets...</p>
								{:else if datasets.length === 0}
									<p class="text-sm text-muted-foreground">No linked datasets.</p>
								{:else}
									<div class="space-y-2">
										{#each datasets as ds (ds.id)}
											<div class="flex items-center gap-2 rounded-md border p-2 text-sm">
												<div class="min-w-0 flex-1">
													<p class="truncate font-medium">{ds.dataset_name}</p>
													<p class="truncate text-xs text-muted-foreground">{ds.dataset_public_url}</p>
												</div>
												<Badge variant="outline">{ds.role}</Badge>
												<Button size="icon" variant="ghost" onclick={() => removeDataset(ds.dataset_public_url)}>
													<TrashIcon class="size-4" />
												</Button>
											</div>
										{/each}
									</div>
								{/if}
							</div>

							<div class="space-y-3 rounded-xl border p-4">
								<h3 class="text-sm font-semibold">Jupyter Environment</h3>
								<div class="flex items-center justify-between gap-3">
									<div class="text-sm">
										<p class="font-medium">Status</p>
										<p class="text-muted-foreground">
											{jupyter?.running ? 'Running' : 'Stopped'}{jupyter?.port ? ` • Port ${jupyter.port}` : ''}
										</p>
									</div>
									<div class="flex flex-wrap gap-2">
										<Button size="sm" onclick={launchJupyter} disabled={jupyterLoading || !!jupyter?.running}>
											<PlayIcon class="size-4" />
											Launch
										</Button>
										<Button size="sm" variant="outline" onclick={stopJupyter} disabled={jupyterLoading || !jupyter?.running}>
											<SquareIcon class="size-4" />
											Stop
										</Button>
										<Button size="sm" variant="outline" onclick={resetJupyter} disabled={jupyterLoading}>
											<RotateCcwIcon class="size-4" />
											Reset
										</Button>
									</div>
								</div>
								{#if jupyter?.url}
									<div class="rounded-md border bg-muted/30 p-3 text-xs">
										<p class="font-medium">Notebook URL</p>
										<p class="mt-1 break-all text-muted-foreground">{jupyter.url}</p>
									</div>
								{/if}
							</div>
						</div>
					</div>
				</div>
			{:else}
				<div class="flex h-full items-center justify-center text-sm text-muted-foreground">
					Session not found.
				</div>
			{/if}
		</div>
	</div>
</div>
