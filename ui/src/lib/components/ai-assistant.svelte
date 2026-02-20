<script lang="ts">
	import { invoke } from '@tauri-apps/api/core'
	import { onMount, onDestroy } from 'svelte'
	import * as Popover from '$lib/components/ui/popover/index.js'
	import { Button } from '$lib/components/ui/button/index.js'
	import { Textarea } from '$lib/components/ui/textarea/index.js'
	import { Input } from '$lib/components/ui/input/index.js'
	import { Label } from '$lib/components/ui/label/index.js'
	import { Switch } from '$lib/components/ui/switch/index.js'
	import SparklesIcon from '@lucide/svelte/icons/sparkles'
	import SendIcon from '@lucide/svelte/icons/send'
	import XIcon from '@lucide/svelte/icons/x'
	import BotIcon from '@lucide/svelte/icons/bot'
	import UserIcon from '@lucide/svelte/icons/user'
	import SlidersHorizontalIcon from '@lucide/svelte/icons/sliders-horizontal'
	import ArrowLeftIcon from '@lucide/svelte/icons/arrow-left'
	import EyeIcon from '@lucide/svelte/icons/eye'
	import EyeOffIcon from '@lucide/svelte/icons/eye-off'
	import ChevronRightIcon from '@lucide/svelte/icons/chevron-right'
	import ChevronLeftIcon from '@lucide/svelte/icons/chevron-left'
	import RefreshCwIcon from '@lucide/svelte/icons/refresh-cw'
	import ShuffleIcon from '@lucide/svelte/icons/shuffle'
	import CopyIcon from '@lucide/svelte/icons/copy'

	// =========================================================================
	// BioVault Agent Client (Browser WebSocket version)
	// =========================================================================
	class BioVaultAgent {
		private ws: WebSocket | null = null
		private requestId = 0
		private pending: Map<
			number,
			{
				resolve: (value: unknown) => void
				reject: (reason: Error) => void
				timeout: ReturnType<typeof setTimeout>
			}
		> = new Map()
		private config: { host: string; port: number; token?: string; timeout: number }

		constructor(config: { host?: string; port?: number; token?: string; timeout?: number } = {}) {
			this.config = {
				host: config.host || '127.0.0.1',
				port: config.port || 3333,
				token: config.token,
				timeout: config.timeout || 30000,
			}
		}

		get url(): string {
			return `ws://${this.config.host}:${this.config.port}`
		}

		get connected(): boolean {
			return this.ws?.readyState === WebSocket.OPEN
		}

		async connect(): Promise<void> {
			if (this.connected) return

			return new Promise((resolve, reject) => {
				this.ws = new WebSocket(this.url)

				this.ws.onopen = () => resolve()
				this.ws.onerror = (err) => reject(new Error(`Connection error: ${err}`))

				this.ws.onmessage = (event) => {
					try {
						const response = JSON.parse(event.data)
						const pending = this.pending.get(response.id)
						if (pending) {
							clearTimeout(pending.timeout)
							this.pending.delete(response.id)
							if (response.error) {
								pending.reject(new Error(response.error))
							} else {
								pending.resolve(response.result)
							}
						}
					} catch (err) {
						console.error('[BioVaultAgent] Failed to parse response:', err)
					}
				}

				this.ws.onclose = () => {
					for (const [id, pending] of this.pending) {
						clearTimeout(pending.timeout)
						pending.reject(new Error('Connection closed'))
						this.pending.delete(id)
					}
					this.ws = null
				}
			})
		}

		disconnect(): void {
			if (this.ws) {
				this.ws.close()
				this.ws = null
			}
		}

		async invoke<T = unknown>(cmd: string, args: Record<string, unknown> = {}): Promise<T> {
			if (!this.connected) {
				throw new Error('Not connected')
			}

			this.requestId += 1
			const id = this.requestId

			const request: Record<string, unknown> = { id, cmd, args }
			if (this.config.token) {
				request.token = this.config.token
			}

			return new Promise<T>((resolve, reject) => {
				const timeoutHandle = setTimeout(() => {
					this.pending.delete(id)
					reject(new Error(`Timeout waiting for response to ${cmd}`))
				}, this.config.timeout)

				this.pending.set(id, {
					resolve: resolve as (value: unknown) => void,
					reject,
					timeout: timeoutHandle,
				})

				this.ws!.send(JSON.stringify(request))
			})
		}

		// Convenience methods matching the Node.js client
		async getSchema(): Promise<unknown> {
			return this.invoke('agent_api_get_schema')
		}

		async listCommands(): Promise<{
			version: string
			commands: Array<{ name: string; category: string }>
		}> {
			return this.invoke('agent_api_list_commands')
		}

		async discover(): Promise<{ version: string; name: string }> {
			return this.invoke('agent_api_discover')
		}
	}

	// =========================================================================
	// Component State
	// =========================================================================
	let open = $state(false)
	let message = $state('')
	let showSettings = $state(false)
	let settingsTab = $state('llm')

	// Agent instance
	let agent: BioVaultAgent | null = null
	let agentConnected = $state(false)
	let agentSchema = $state<unknown>(null)

	// LLM Config state
	let aiApiUrl = $state('')
	let aiApiToken = $state('')
	let aiModel = $state('')
	let showLlmToken = $state(false)

	// Agent Bridge state
	let bridgeEnabled = $state(true)
	let bridgeWsPort = $state(3333)
	let bridgeHttpPort = $state(3334)
	let bridgeToken = $state('')
	let showBridgeToken = $state(false)

	// Commands state
	let allCommands = $state<string[]>([])
	let blockedCommands = $state<Set<string>>(new Set())
	let selectedAllowed = $state<Set<string>>(new Set())
	let selectedBlocked = $state<Set<string>>(new Set())
	let allowedFilter = $state('')
	let blockedFilter = $state('')

	// UI state
	let saving = $state(false)
	let saveStatus = $state<{ message: string; type: 'success' | 'error' } | null>(null)
	let restarting = $state(false)
	let copied = $state(false)

	interface Message {
		id: string
		role: 'user' | 'assistant'
		content: string
	}

	let messages = $state<Message[]>([
		{
			id: '1',
			role: 'assistant',
			content: "Hi! I'm your BioVault assistant. How can I help you today?",
		},
	])

	// Derived: allowed commands (all minus blocked)
	const allowedCommands = $derived(allCommands.filter((cmd) => !blockedCommands.has(cmd)))

	// Derived: filtered lists
	const filteredAllowed = $derived(
		allowedFilter
			? allowedCommands.filter((cmd) => cmd.toLowerCase().includes(allowedFilter.toLowerCase()))
			: allowedCommands,
	)
	const filteredBlocked = $derived(
		blockedFilter
			? Array.from(blockedCommands).filter((cmd) =>
					cmd.toLowerCase().includes(blockedFilter.toLowerCase()),
				)
			: Array.from(blockedCommands),
	)

	// Derived: curl command
	const curlCommand = $derived(
		`curl -s -H "Authorization: Bearer ${showBridgeToken && bridgeToken ? bridgeToken : 'TOKEN'}" http://127.0.0.1:${bridgeHttpPort}/schema`,
	)

	onMount(async () => {
		await loadSettings()
		await loadCommands()
		await connectAgent()
	})

	onDestroy(() => {
		if (agent) {
			agent.disconnect()
			agent = null
		}
	})

	let agentError = $state('')

	async function connectAgent() {
		agentError = ''
		try {
			console.log(`[AI Assistant] Connecting to agent bridge on port ${bridgeWsPort}...`)
			console.log(
				`[AI Assistant] Bridge enabled: ${bridgeEnabled}, Token: ${bridgeToken ? 'set' : 'not set'}`,
			)

			agent = new BioVaultAgent({
				port: bridgeWsPort,
				token: bridgeToken || undefined,
			})
			await agent.connect()
			agentConnected = true
			console.log('[AI Assistant] Connected to BioVault agent bridge')

			// Load full schema for LLM tools
			agentSchema = await agent.getSchema()
			console.log(
				'[AI Assistant] Loaded agent schema with',
				buildToolsFromSchema(agentSchema).length,
				'tools',
			)
		} catch (e) {
			const errorMsg = e instanceof Error ? e.message : String(e)
			console.error('[AI Assistant] Failed to connect to agent bridge:', errorMsg)
			agentError = `Port ${bridgeWsPort}: ${errorMsg}`
			agentConnected = false
		}
	}

	async function reconnectAgent() {
		if (agent) {
			agent.disconnect()
		}
		// Reload settings to get current port
		await loadSettings()
		await connectAgent()
	}

	// Check bridge status via Tauri (more reliable than WebSocket)
	async function checkBridgeStatus() {
		try {
			const settings = await invoke<{
				agent_bridge_enabled?: boolean
				agent_bridge_port?: number
			}>('get_settings')
			console.log('[AI Assistant] Bridge settings:', {
				enabled: settings.agent_bridge_enabled,
				port: settings.agent_bridge_port,
			})
			return settings
		} catch (e) {
			console.error('[AI Assistant] Failed to check bridge status:', e)
			return null
		}
	}

	async function loadSettings() {
		try {
			const settings = await invoke<{
				ai_api_url?: string
				ai_api_token?: string
				ai_model?: string
				agent_bridge_enabled?: boolean
				agent_bridge_port?: number
				agent_bridge_http_port?: number
				agent_bridge_token?: string
				agent_bridge_blocklist?: string[]
			}>('get_settings')
			aiApiUrl = settings.ai_api_url || ''
			aiApiToken = settings.ai_api_token || ''
			aiModel = settings.ai_model || ''
			bridgeEnabled = settings.agent_bridge_enabled ?? true
			bridgeWsPort = settings.agent_bridge_port || 3333
			bridgeHttpPort = settings.agent_bridge_http_port || 3334
			bridgeToken = settings.agent_bridge_token || ''
			blockedCommands = new Set(settings.agent_bridge_blocklist || [])
		} catch (e) {
			console.error('Failed to load settings:', e)
		}
	}

	async function loadCommands() {
		try {
			const commands = await invoke<string[]>('get_agent_api_commands')
			allCommands = Array.isArray(commands) ? commands.sort() : []
		} catch (e) {
			console.error('Failed to load agent commands:', e)
			allCommands = []
		}
	}

	async function saveAllSettings() {
		saving = true
		saveStatus = null
		try {
			const currentSettings = await invoke<Record<string, unknown>>('get_settings')
			const settings = {
				...currentSettings,
				ai_api_url: aiApiUrl.trim(),
				ai_api_token: aiApiToken.trim(),
				ai_model: aiModel.trim(),
				agent_bridge_enabled: bridgeEnabled,
				agent_bridge_port: bridgeWsPort,
				agent_bridge_http_port: bridgeHttpPort,
				agent_bridge_token: bridgeToken.trim() || null,
				agent_bridge_blocklist: Array.from(blockedCommands).sort(),
			}
			await invoke('save_settings', { settings })
			saveStatus = { message: 'Settings saved!', type: 'success' }
			setTimeout(() => (saveStatus = null), 2000)

			// Reconnect agent with new settings
			await reconnectAgent()
		} catch (e) {
			console.error('Failed to save settings:', e)
			saveStatus = { message: 'Failed to save settings', type: 'error' }
		} finally {
			saving = false
		}
	}

	async function restartBridge() {
		restarting = true
		try {
			await invoke('restart_agent_bridge')
			saveStatus = { message: 'Bridge restarted!', type: 'success' }
			setTimeout(() => (saveStatus = null), 2000)
		} catch (e) {
			console.error('Failed to restart bridge:', e)
			saveStatus = { message: 'Failed to restart bridge', type: 'error' }
		} finally {
			restarting = false
		}
	}

	function randomizePorts() {
		const randomPort = (min = 20000, max = 60000) => min + Math.floor(Math.random() * (max - min))
		bridgeWsPort = randomPort()
		bridgeHttpPort = randomPort()
		// Ensure they're different
		while (bridgeHttpPort === bridgeWsPort) {
			bridgeHttpPort = randomPort()
		}
	}

	function blockSelected() {
		selectedAllowed.forEach((cmd) => blockedCommands.add(cmd))
		blockedCommands = new Set(blockedCommands)
		selectedAllowed.clear()
		selectedAllowed = new Set(selectedAllowed)
	}

	function allowSelected() {
		selectedBlocked.forEach((cmd) => blockedCommands.delete(cmd))
		blockedCommands = new Set(blockedCommands)
		selectedBlocked.clear()
		selectedBlocked = new Set(selectedBlocked)
	}

	function toggleAllowedSelection(cmd: string) {
		if (selectedAllowed.has(cmd)) {
			selectedAllowed.delete(cmd)
		} else {
			selectedAllowed.add(cmd)
		}
		selectedAllowed = new Set(selectedAllowed)
	}

	function toggleBlockedSelection(cmd: string) {
		if (selectedBlocked.has(cmd)) {
			selectedBlocked.delete(cmd)
		} else {
			selectedBlocked.add(cmd)
		}
		selectedBlocked = new Set(selectedBlocked)
	}

	async function copyCommand() {
		try {
			await navigator.clipboard.writeText(curlCommand)
			copied = true
			setTimeout(() => (copied = false), 1500)
		} catch {
			// Fallback
		}
	}

	let isLoading = $state(false)

	async function handleSubmit() {
		if (!message.trim() || isLoading) return

		const userMessage: Message = {
			id: `${Date.now()}-user`,
			role: 'user',
			content: message.trim(),
		}
		messages = [...messages, userMessage]
		const userInput = message.trim()
		message = ''

		// Check if LLM is configured
		if (!aiApiUrl || !aiModel) {
			const configMessage: Message = {
				id: `${Date.now()}-assistant`,
				role: 'assistant',
				content:
					"I'm not configured yet. Please click the settings icon (⚙️) and set up your LLM API URL and model in the 'LLM Settings' tab.",
			}
			messages = [...messages, configMessage]
			return
		}

		isLoading = true

		try {
			const response = await callLLM(userInput)
			const assistantMessage: Message = {
				id: `${Date.now()}-assistant`,
				role: 'assistant',
				content: response,
			}
			messages = [...messages, assistantMessage]
		} catch (err) {
			console.error('LLM call failed:', err)
			const errorMessage: Message = {
				id: `${Date.now()}-assistant`,
				role: 'assistant',
				content: `Sorry, I encountered an error: ${err instanceof Error ? err.message : 'Unknown error'}. Please check your LLM settings.`,
			}
			messages = [...messages, errorMessage]
		} finally {
			isLoading = false
		}
	}

	// Build tools dynamically from agent schema
	function buildToolsFromSchema(
		schema: unknown,
	): Array<{ type: string; function: { name: string; description: string; parameters: unknown } }> {
		if (!schema || typeof schema !== 'object') return []

		const s = schema as {
			commands?: Record<string, { description?: string; parameters?: unknown }>
		}
		if (!s.commands) return []

		const tools: Array<{
			type: string
			function: { name: string; description: string; parameters: unknown }
		}> = []

		for (const [name, cmd] of Object.entries(s.commands)) {
			// Skip dangerous/internal commands
			if (name.startsWith('reset_') || name === 'reset_everything' || name === 'reset_all_data')
				continue

			tools.push({
				type: 'function',
				function: {
					name,
					description: cmd.description || `Execute ${name} command`,
					parameters: cmd.parameters || { type: 'object', properties: {} },
				},
			})
		}

		return tools
	}

	// Execute any command via the agent bridge
	async function executeTool(name: string, args: Record<string, unknown>): Promise<unknown> {
		console.log(`[AI Assistant] Executing tool via agent: ${name}`, args)

		if (!agent || !agentConnected) {
			return { error: 'Agent not connected. Please check Agent Bridge settings.' }
		}

		try {
			// Redact sensitive data in responses
			const result = await agent.invoke(name, args)

			if (name === 'get_settings' && result && typeof result === 'object') {
				const safe = { ...(result as Record<string, unknown>) }
				delete safe.ai_api_token
				delete safe.agent_bridge_token
				return safe
			}

			return result
		} catch (err) {
			console.error(`[AI Assistant] Tool error:`, err)
			return { error: err instanceof Error ? err.message : String(err) }
		}
	}

	async function callLLM(userInput: string): Promise<string> {
		// Build conversation history for context
		const chatMessages = messages
			.filter((m) => m.id !== '1') // Exclude initial greeting
			.map((m) => ({
				role: m.role,
				content: m.content,
			}))

		// Add the new user message
		chatMessages.push({ role: 'user', content: userInput })

		// Build tools from schema
		const tools = buildToolsFromSchema(agentSchema)
		const hasTools = tools.length > 0 && agentConnected

		// Add system message for context
		const systemMessage = {
			role: 'system',
			content: `You are a helpful AI assistant integrated into BioVault Desktop, a privacy-preserving data analysis application.${
				hasTools
					? ` You can directly execute actions in BioVault using the available tools (${tools.length} commands available).

When users ask you to do something (create a pipeline, list datasets, etc.), USE THE TOOLS to actually do it - don't just explain how.`
					: ' The agent bridge is not connected, so you can only provide guidance.'
			}

Available features:
- Pipelines/Flows: Data analysis workflows
- Datasets: Data collections for analysis  
- Sessions: Collaboration spaces with other users
- Messages: Secure communication
- Results/Runs: Pipeline execution history

Be concise and action-oriented.${hasTools ? ' Execute commands when asked.' : ''}`,
		}

		// Build the endpoint URL
		let endpoint = aiApiUrl.trim().replace(/\/+$/, '')
		if (endpoint.endsWith('/chat/completions')) {
			// Already complete
		} else if (endpoint.endsWith('/v1')) {
			endpoint = `${endpoint}/chat/completions`
		} else if (endpoint.includes('/v1/') && !endpoint.includes('chat/completions')) {
			endpoint = `${endpoint}/chat/completions`
		} else if (!endpoint.includes('/v1')) {
			endpoint = `${endpoint}/v1/chat/completions`
		}

		console.log('[AI Assistant] Calling endpoint:', endpoint)
		console.log('[AI Assistant] Tools available:', tools.length, 'Agent connected:', agentConnected)

		const requestBody: Record<string, unknown> = {
			model: aiModel,
			messages: [systemMessage, ...chatMessages],
			max_tokens: 1024,
			temperature: 0.7,
		}

		// Only include tools if agent is connected and we have tools
		if (hasTools) {
			requestBody.tools = tools
			requestBody.tool_choice = 'auto'
		}

		const response = await fetch(endpoint, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				...(aiApiToken ? { Authorization: `Bearer ${aiApiToken}` } : {}),
			},
			body: JSON.stringify(requestBody),
		})

		if (!response.ok) {
			const errorText = await response.text()
			throw new Error(`API error ${response.status}: ${errorText}\n\nEndpoint: ${endpoint}`)
		}

		const data = await response.json()
		const choice = data.choices?.[0]

		// Check if the model wants to call tools
		if (choice?.message?.tool_calls && choice.message.tool_calls.length > 0) {
			const toolResults: Array<{ role: string; tool_call_id: string; content: string }> = []

			for (const toolCall of choice.message.tool_calls) {
				const funcName = toolCall.function.name
				const funcArgs = JSON.parse(toolCall.function.arguments || '{}')
				const result = await executeTool(funcName, funcArgs)
				toolResults.push({
					role: 'tool',
					tool_call_id: toolCall.id,
					content: JSON.stringify(result, null, 2),
				})
			}

			// Send tool results back to LLM for final response
			const followupMessages = [systemMessage, ...chatMessages, choice.message, ...toolResults]

			const followupResponse = await fetch(endpoint, {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					...(aiApiToken ? { Authorization: `Bearer ${aiApiToken}` } : {}),
				},
				body: JSON.stringify({
					model: aiModel,
					messages: followupMessages,
					max_tokens: 1024,
					temperature: 0.7,
				}),
			})

			if (!followupResponse.ok) {
				const errorText = await followupResponse.text()
				throw new Error(`API error ${followupResponse.status}: ${errorText}`)
			}

			const followupData = await followupResponse.json()
			return followupData.choices?.[0]?.message?.content || 'Action completed.'
		}

		return choice?.message?.content || 'No response received'
	}

	function handleKeydown(e: KeyboardEvent) {
		if (e.key === 'Enter' && !e.shiftKey) {
			e.preventDefault()
			handleSubmit()
		}
	}
</script>

<div class="fixed bottom-6 right-6 z-50">
	<Popover.Root bind:open>
		<Popover.Trigger>
		<button
			type="button"
			class="flex size-14 items-center justify-center rounded-full bg-primary text-primary-foreground shadow-lg"
		>
			<SparklesIcon class="size-6" />
				<span class="sr-only">AI Assistant</span>
			</button>
		</Popover.Trigger>

		<Popover.Content
			side="top"
			align="end"
			sideOffset={12}
			class="{showSettings ? 'w-[480px]' : 'w-[380px]'} p-0 overflow-hidden"
		>
			<!-- Header -->
			<div class="flex items-center justify-between border-b bg-muted/30 px-4 py-3">
				<div class="flex items-center gap-2">
					{#if showSettings}
						<Button
							variant="ghost"
							size="icon"
							class="size-8"
							onclick={() => (showSettings = false)}
						>
							<ArrowLeftIcon class="size-4" />
						</Button>
						<div>
							<h3 class="font-semibold text-sm">AI Configuration</h3>
							<p class="text-xs text-muted-foreground">LLM & Agent Bridge settings</p>
						</div>
					{:else}
						<div class="flex size-8 items-center justify-center rounded-full bg-primary/10">
							<SparklesIcon class="size-4 text-primary" />
						</div>
						<div>
							<h3 class="font-semibold text-sm">AI Assistant</h3>
							<p class="text-xs text-muted-foreground">Ask me anything</p>
						</div>
					{/if}
				</div>
				<div class="flex items-center gap-1">
					{#if !showSettings}
						<Button
							variant="ghost"
							size="icon"
							class="size-8"
							onclick={() => (showSettings = true)}
							title="Configure AI"
						>
							<SlidersHorizontalIcon class="size-4" />
						</Button>
					{/if}
					<Button variant="ghost" size="icon" class="size-8" onclick={() => (open = false)}>
						<XIcon class="size-4" />
					</Button>
				</div>
			</div>

			{#if showSettings}
				<!-- Settings Panel with Tabs -->
				<div class="w-full">
					<div class="flex border-b">
						<button
							type="button"
							class="relative px-4 pb-3 pt-2 font-medium text-sm transition-colors {settingsTab ===
							'llm'
								? 'text-foreground border-b-2 border-primary'
								: 'text-muted-foreground hover:text-foreground'}"
							onclick={() => (settingsTab = 'llm')}
						>
							LLM Settings
						</button>
						<button
							type="button"
							class="relative px-4 pb-3 pt-2 font-medium text-sm transition-colors {settingsTab ===
							'bridge'
								? 'text-foreground border-b-2 border-primary'
								: 'text-muted-foreground hover:text-foreground'}"
							onclick={() => (settingsTab = 'bridge')}
						>
							Agent Bridge
						</button>
					</div>

					<div class="h-[400px] overflow-y-auto">
						{#if settingsTab === 'llm'}
							<div class="p-4 space-y-4">
								<div class="space-y-2">
									<Label for="ai-api-url">API URL</Label>
									<Input
										id="ai-api-url"
										type="url"
										placeholder="https://api.openai.com/v1"
										bind:value={aiApiUrl}
									/>
									<p class="text-xs text-muted-foreground">
										Examples:<br />
										• OpenAI:
										<code class="text-[10px] bg-muted px-1 rounded">https://api.openai.com/v1</code
										><br />
										• Ollama:
										<code class="text-[10px] bg-muted px-1 rounded">http://localhost:11434/v1</code
										><br />
										• OpenRouter:
										<code class="text-[10px] bg-muted px-1 rounded"
											>https://openrouter.ai/api/v1</code
										>
									</p>
								</div>

								<div class="space-y-2">
									<Label for="ai-api-token">API Token</Label>
									<div class="relative">
										<Input
											id="ai-api-token"
											type={showLlmToken ? 'text' : 'password'}
											placeholder="sk-..."
											bind:value={aiApiToken}
											class="pr-10"
										/>
										<Button
											variant="ghost"
											size="icon"
											class="absolute right-0 top-0 size-9"
											onclick={() => (showLlmToken = !showLlmToken)}
										>
											{#if showLlmToken}
												<EyeOffIcon class="size-4" />
											{:else}
												<EyeIcon class="size-4" />
											{/if}
										</Button>
									</div>
								</div>

								<div class="space-y-2">
									<Label for="ai-model">Model</Label>
									<Input id="ai-model" type="text" placeholder="gpt-4o-mini" bind:value={aiModel} />
								</div>
							</div>
						{:else if settingsTab === 'bridge'}
							<div class="p-4 space-y-4">
								<p class="text-xs text-muted-foreground">
									Control local agent access, configure ports, and manage command blocklists.
								</p>

								<!-- Enable Toggle -->
								<div class="flex items-center justify-between">
									<div>
										<Label>Enable Agent Bridge</Label>
										<p class="text-xs text-muted-foreground">Allow external agents to connect</p>
									</div>
									<Switch bind:checked={bridgeEnabled} />
								</div>

								<!-- Ports -->
								<div class="grid grid-cols-2 gap-3">
									<div class="space-y-1">
										<Label for="ws-port" class="text-xs">WebSocket Port</Label>
										<Input id="ws-port" type="number" bind:value={bridgeWsPort} />
									</div>
									<div class="space-y-1">
										<Label for="http-port" class="text-xs">HTTP Port</Label>
										<Input id="http-port" type="number" bind:value={bridgeHttpPort} />
									</div>
								</div>

								<!-- Token -->
								<div class="space-y-1">
									<Label for="bridge-token" class="text-xs">Token (optional)</Label>
									<div class="relative">
										<Input
											id="bridge-token"
											type={showBridgeToken ? 'text' : 'password'}
											placeholder="Bearer token..."
											bind:value={bridgeToken}
											class="pr-10"
										/>
										<Button
											variant="ghost"
											size="icon"
											class="absolute right-0 top-0 size-9"
											onclick={() => (showBridgeToken = !showBridgeToken)}
										>
											{#if showBridgeToken}
												<EyeOffIcon class="size-4" />
											{:else}
												<EyeIcon class="size-4" />
											{/if}
										</Button>
									</div>
								</div>

								<!-- Action Buttons -->
								<div class="flex gap-2">
									<Button variant="outline" size="sm" class="flex-1" onclick={randomizePorts}>
										<ShuffleIcon class="size-3 mr-1" />
										Randomize Ports
									</Button>
									<Button
										variant="outline"
										size="sm"
										class="flex-1"
										onclick={restartBridge}
										disabled={restarting}
									>
										<RefreshCwIcon class="size-3 mr-1 {restarting ? 'animate-spin' : ''}" />
										{restarting ? 'Restarting...' : 'Restart Bridge'}
									</Button>
								</div>

								<!-- Curl Command -->
								<div class="space-y-1">
									<Label class="text-xs">LLM-friendly API command</Label>
									<div class="relative">
										<code
											class="block text-[10px] bg-muted p-2 rounded border overflow-x-auto whitespace-nowrap pr-8"
										>
											{curlCommand}
										</code>
										<Button
											variant="ghost"
											size="icon"
											class="absolute right-1 top-1 size-6"
											onclick={copyCommand}
										>
											<CopyIcon class="size-3 {copied ? 'text-emerald-500' : ''}" />
										</Button>
									</div>
								</div>

								<!-- Commands Lists -->
								<div class="space-y-2">
									<Label class="text-xs">Command Access Control</Label>
									<div class="grid grid-cols-[1fr_auto_1fr] gap-2">
										<!-- Allowed Column -->
										<div class="space-y-1">
											<div class="flex items-center justify-between">
												<span class="text-xs font-medium text-muted-foreground">Allowed</span>
												<span class="text-[10px] text-muted-foreground"
													>{filteredAllowed.length}</span
												>
											</div>
											<Input
												type="text"
												placeholder="Filter..."
												bind:value={allowedFilter}
												class="h-7 text-xs"
											/>
											<div
												class="h-32 overflow-y-auto border rounded bg-background text-[10px] space-y-px p-1"
											>
												{#each filteredAllowed as cmd (cmd)}
													<button
														type="button"
														class="w-full text-left px-1.5 py-0.5 rounded hover:bg-muted truncate {selectedAllowed.has(
															cmd,
														)
															? 'bg-primary/10 text-primary'
															: ''}"
														onclick={() => toggleAllowedSelection(cmd)}
													>
														{cmd}
													</button>
												{/each}
												{#if filteredAllowed.length === 0}
													<div class="text-muted-foreground text-center py-2">No commands</div>
												{/if}
											</div>
										</div>

										<!-- Transfer Buttons -->
										<div class="flex flex-col justify-center gap-1">
											<Button
												variant="outline"
												size="icon"
												class="size-7"
												onclick={blockSelected}
												disabled={selectedAllowed.size === 0}
												title="Block selected"
											>
												<ChevronRightIcon class="size-4" />
											</Button>
											<Button
												variant="outline"
												size="icon"
												class="size-7"
												onclick={allowSelected}
												disabled={selectedBlocked.size === 0}
												title="Allow selected"
											>
												<ChevronLeftIcon class="size-4" />
											</Button>
										</div>

										<!-- Blocked Column -->
										<div class="space-y-1">
											<div class="flex items-center justify-between">
												<span class="text-xs font-medium text-muted-foreground">Blocked</span>
												<span class="text-[10px] text-muted-foreground"
													>{filteredBlocked.length}</span
												>
											</div>
											<Input
												type="text"
												placeholder="Filter..."
												bind:value={blockedFilter}
												class="h-7 text-xs"
											/>
											<div
												class="h-32 overflow-y-auto border rounded bg-background text-[10px] space-y-px p-1"
											>
												{#each filteredBlocked as cmd (cmd)}
													<button
														type="button"
														class="w-full text-left px-1.5 py-0.5 rounded hover:bg-muted truncate text-destructive {selectedBlocked.has(
															cmd,
														)
															? 'bg-destructive/10'
															: ''}"
														onclick={() => toggleBlockedSelection(cmd)}
													>
														{cmd}
													</button>
												{/each}
												{#if filteredBlocked.length === 0}
													<div class="text-muted-foreground text-center py-2">No commands</div>
												{/if}
											</div>
										</div>
									</div>
								</div>
							</div>
						{/if}
					</div>
				</div>

				<!-- Save Button -->
				<div class="border-t p-3 space-y-2">
					{#if saveStatus}
						<p
							class="text-xs text-center {saveStatus.type === 'success'
								? 'text-emerald-600'
								: 'text-destructive'}"
						>
							{saveStatus.message}
						</p>
					{/if}
					<Button class="w-full" onclick={saveAllSettings} disabled={saving}>
						{saving ? 'Saving...' : 'Save All Settings'}
					</Button>
				</div>
			{:else}
				<!-- Messages -->
				<div class="h-[300px] overflow-y-auto p-4 space-y-4">
					{#each messages as msg (msg.id)}
						<div class="flex gap-3 {msg.role === 'user' ? 'flex-row-reverse' : ''}">
							<div
								class="flex size-8 shrink-0 items-center justify-center rounded-full {msg.role ===
								'user'
									? 'bg-primary text-primary-foreground'
									: 'bg-muted'}"
							>
								{#if msg.role === 'user'}
									<UserIcon class="size-4" />
								{:else}
									<BotIcon class="size-4" />
								{/if}
							</div>
							<div
								class="max-w-[80%] rounded-lg px-3 py-2 text-sm {msg.role === 'user'
									? 'bg-primary text-primary-foreground'
									: 'bg-muted'}"
							>
								{msg.content}
							</div>
						</div>
					{/each}
					{#if isLoading}
						<div class="flex gap-3">
							<div class="flex size-8 shrink-0 items-center justify-center rounded-full bg-muted">
								<BotIcon class="size-4" />
							</div>
							<div class="max-w-[80%] rounded-lg px-3 py-2 text-sm bg-muted">
								<div class="flex items-center gap-2">
									<RefreshCwIcon class="size-3 animate-spin" />
									<span class="text-muted-foreground">Thinking...</span>
								</div>
							</div>
						</div>
					{/if}
				</div>

				<!-- Input -->
				<div class="border-t p-3">
					<div class="flex gap-2">
						<Textarea
							bind:value={message}
							placeholder={isLoading ? 'Waiting for response...' : 'Ask a question...'}
							rows={1}
							class="min-h-[40px] max-h-[120px] resize-none"
							onkeydown={handleKeydown}
							disabled={isLoading}
						/>
						<Button
							size="icon"
							class="shrink-0 size-10"
							onclick={handleSubmit}
							disabled={!message.trim() || isLoading}
						>
							{#if isLoading}
								<RefreshCwIcon class="size-4 animate-spin" />
							{:else}
								<SendIcon class="size-4" />
							{/if}
						</Button>
					</div>
					<div class="text-xs text-muted-foreground mt-2 text-center space-y-1">
						{#if !aiApiUrl || !aiModel}
							<p class="text-amber-600">Configure LLM in settings to chat</p>
						{:else}
							<p>Press Enter to send, Shift+Enter for new line</p>
						{/if}
						<button
							type="button"
							onclick={reconnectAgent}
							class="flex items-center justify-center gap-1.5 mx-auto hover:opacity-80"
							title={agentConnected
								? 'Click to reconnect'
								: agentError || 'Click to retry connection'}
						>
							<span class="size-1.5 rounded-full {agentConnected ? 'bg-emerald-500' : 'bg-red-500'}"
							></span>
							<span class={agentConnected ? 'text-emerald-600' : 'text-red-500'}>
								{#if agentConnected}
									Agent connected ({buildToolsFromSchema(agentSchema).length} tools)
								{:else}
									Agent disconnected (port {bridgeWsPort}) - click to retry
								{/if}
							</span>
						</button>
					</div>
				</div>
			{/if}
		</Popover.Content>
	</Popover.Root>
</div>
