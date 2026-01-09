/**
 * BioVault Desktop Agent Client (TypeScript/Node.js)
 *
 * A TypeScript client library for interacting with the BioVault Desktop
 * via the WebSocket Agent API.
 *
 * Example usage:
 *   import { BioVaultAgent } from './biovault-agent';
 *
 *   const agent = new BioVaultAgent();
 *   await agent.connect();
 *
 *   const version = await agent.getAppVersion();
 *   console.log(`Version: ${version}`);
 *
 *   await agent.disconnect();
 */

import WebSocket from 'ws'

/** Configuration for the BioVault agent client */
export interface AgentConfig {
	host: string
	port: number
	token?: string
	timeout: number
	longTimeout: number
}

/** Default configuration */
export const defaultConfig: AgentConfig = {
	host: process.env.BIOVAULT_AGENT_HOST || '127.0.0.1',
	port: parseInt(process.env.DEV_WS_BRIDGE_PORT || '3333', 10),
	token: process.env.AGENT_BRIDGE_TOKEN,
	timeout: 30000, // 30 seconds
	longTimeout: 180000, // 3 minutes
}

/** Error from the BioVault agent API */
export class BioVaultAgentError extends Error {
	constructor(message: string) {
		super(message)
		this.name = 'BioVaultAgentError'
	}
}

/** WebSocket request format */
interface WsRequest {
	id: number
	cmd: string
	args?: Record<string, unknown>
	token?: string
}

/** WebSocket response format */
interface WsResponse {
	id: number
	result?: unknown
	error?: string
}

/** Commands that need longer timeout */
const LONG_RUNNING_COMMANDS = new Set([
	'launch_jupyter',
	'stop_jupyter',
	'reset_jupyter',
	'launch_session_jupyter',
	'stop_session_jupyter',
	'reset_session_jupyter',
	'sync_messages',
	'sync_messages_with_failures',
	'refresh_messages_batched',
	'install_dependencies',
	'install_dependency',
	'install_brew',
	'install_command_line_tools',
	'import_pipeline_with_deps',
	'run_pipeline',
	'syftbox_upload_action',
])

/**
 * Async client for the BioVault Desktop Agent API.
 */
export class BioVaultAgent {
	private config: AgentConfig
	private ws: WebSocket | null = null
	private requestId = 0
	private pending: Map<
		number,
		{
			resolve: (value: unknown) => void
			reject: (reason: Error) => void
			timeout: NodeJS.Timeout
		}
	> = new Map()

	constructor(config: Partial<AgentConfig> = {}) {
		this.config = { ...defaultConfig, ...config }
	}

	/** Get the WebSocket URL */
	get url(): string {
		return `ws://${this.config.host}:${this.config.port}`
	}

	/** Check if connected */
	get connected(): boolean {
		return this.ws?.readyState === WebSocket.OPEN
	}

	/** Connect to the WebSocket bridge */
	async connect(): Promise<void> {
		if (this.connected) return

		return new Promise((resolve, reject) => {
			this.ws = new WebSocket(this.url)

			this.ws.on('open', () => {
				resolve()
			})

			this.ws.on('error', (err) => {
				reject(new BioVaultAgentError(`Connection error: ${err.message}`))
			})

			this.ws.on('message', (data: WebSocket.Data) => {
				try {
					const response: WsResponse = JSON.parse(data.toString())
					const pending = this.pending.get(response.id)
					if (pending) {
						clearTimeout(pending.timeout)
						this.pending.delete(response.id)

						if (response.error) {
							pending.reject(new BioVaultAgentError(response.error))
						} else {
							pending.resolve(response.result)
						}
					}
				} catch (err) {
					console.error('Failed to parse response:', err)
				}
			})

			this.ws.on('close', () => {
				// Cancel all pending requests
				for (const [id, pending] of this.pending) {
					clearTimeout(pending.timeout)
					pending.reject(new BioVaultAgentError('Connection closed'))
					this.pending.delete(id)
				}
				this.ws = null
			})
		})
	}

	/** Disconnect from the WebSocket bridge */
	async disconnect(): Promise<void> {
		if (this.ws) {
			this.ws.close()
			this.ws = null
		}
	}

	/**
	 * Invoke a command on the BioVault agent.
	 *
	 * @param cmd - Command name
	 * @param args - Command arguments
	 * @param timeout - Override timeout for this request
	 * @returns Command result
	 */
	async invoke<T = unknown>(
		cmd: string,
		args: Record<string, unknown> = {},
		timeout?: number,
	): Promise<T> {
		if (!this.connected) {
			throw new BioVaultAgentError('Not connected')
		}

		this.requestId += 1
		const id = this.requestId

		const request: WsRequest = { id, cmd, args }
		if (this.config.token) {
			request.token = this.config.token
		}

		// Determine timeout
		const timeoutMs =
			timeout ?? (LONG_RUNNING_COMMANDS.has(cmd) ? this.config.longTimeout : this.config.timeout)

		return new Promise<T>((resolve, reject) => {
			const timeoutHandle = setTimeout(() => {
				this.pending.delete(id)
				reject(new BioVaultAgentError(`Timeout waiting for response to ${cmd}`))
			}, timeoutMs)

			this.pending.set(id, {
				resolve: resolve as (value: unknown) => void,
				reject,
				timeout: timeoutHandle,
			})

			this.ws!.send(JSON.stringify(request))
		})
	}

	// -------------------------------------------------------------------------
	// Agent API Discovery
	// -------------------------------------------------------------------------

	/** Get API metadata and capabilities */
	async discover(): Promise<{
		version: string
		name: string
		description: string
		protocol: { transport: string; address: string; defaultPort: number }
		auth: { required: boolean; method: string }
		docs: string
		schema: string
	}> {
		return this.invoke('agent_api_discover')
	}

	/** Get recent audit log entries */
	async getAuditLog(maxEntries = 100): Promise<unknown[]> {
		return this.invoke('agent_api_get_audit_log', { maxEntries })
	}

	/** Clear the audit log */
	async clearAuditLog(): Promise<void> {
		return this.invoke('agent_api_clear_audit_log')
	}

	/** Get the full JSON schema at runtime */
	async getSchema(): Promise<unknown> {
		return this.invoke('agent_api_get_schema')
	}

	/** Get a lightweight list of available commands */
	async listCommands(): Promise<{
		version: string
		commands: Array<{
			name: string
			category: string
			readOnly: boolean
			async?: boolean
			longRunning?: boolean
			dangerous?: boolean
		}>
	}> {
		return this.invoke('agent_api_list_commands')
	}

	// -------------------------------------------------------------------------
	// App Status
	// -------------------------------------------------------------------------

	/** Get the application version */
	async getAppVersion(): Promise<string> {
		return this.invoke('get_app_version')
	}

	/** Check if app is in development mode */
	async isDevMode(): Promise<boolean> {
		return this.invoke('is_dev_mode')
	}

	/** Get development mode information */
	async getDevModeInfo(): Promise<Record<string, unknown>> {
		return this.invoke('get_dev_mode_info')
	}

	/** Get an environment variable value */
	async getEnvVar(key: string): Promise<string | null> {
		return this.invoke('get_env_var', { key })
	}

	/** Get path to config.yaml */
	async getConfigPath(): Promise<string> {
		return this.invoke('get_config_path')
	}

	/** Get path to the SQLite database */
	async getDatabasePath(): Promise<string> {
		return this.invoke('get_database_path')
	}

	// -------------------------------------------------------------------------
	// Onboarding
	// -------------------------------------------------------------------------

	/** Check if onboarding is complete */
	async checkIsOnboarded(): Promise<boolean> {
		return this.invoke('check_is_onboarded')
	}

	/** Complete onboarding with an email */
	async completeOnboarding(email: string): Promise<void> {
		return this.invoke('complete_onboarding', { email })
	}

	// -------------------------------------------------------------------------
	// Profiles
	// -------------------------------------------------------------------------

	/** Get current profiles boot state */
	async profilesGetBootState(): Promise<Record<string, unknown>> {
		return this.invoke('profiles_get_boot_state')
	}

	/** Get default BioVault home path */
	async profilesGetDefaultHome(): Promise<string> {
		return this.invoke('profiles_get_default_home')
	}

	/** Switch to a different profile in place */
	async profilesSwitchInPlace(profileId: string): Promise<void> {
		return this.invoke('profiles_switch_in_place', { profileId })
	}

	// -------------------------------------------------------------------------
	// Dependencies
	// -------------------------------------------------------------------------

	/** Check all required dependencies */
	async checkDependencies(): Promise<
		Array<{
			name: string
			installed: boolean
			version?: string
			path?: string
		}>
	> {
		return this.invoke('check_dependencies')
	}

	/** Check a single dependency */
	async checkSingleDependency(
		name: string,
		path?: string,
	): Promise<{
		name: string
		installed: boolean
		version?: string
	}> {
		return this.invoke('check_single_dependency', { name, path })
	}

	/** Check if Docker daemon is running */
	async checkDockerRunning(): Promise<boolean> {
		return this.invoke('check_docker_running')
	}

	/** Install missing dependencies by name */
	async installDependencies(names: string[]): Promise<boolean> {
		return this.invoke('install_dependencies', { names })
	}

	/** Install a single dependency by name */
	async installDependency(name: string): Promise<string> {
		return this.invoke('install_dependency', { name })
	}

	/** Install Homebrew (macOS only) */
	async installBrew(): Promise<string> {
		return this.invoke('install_brew')
	}

	/** Check if Homebrew is installed */
	async checkBrewInstalled(): Promise<boolean> {
		return this.invoke('check_brew_installed')
	}

	/** Check if Xcode Command Line Tools are installed */
	async checkCommandLineToolsInstalled(): Promise<boolean> {
		return this.invoke('check_command_line_tools_installed')
	}

	// -------------------------------------------------------------------------
	// SyftBox Control Plane
	// -------------------------------------------------------------------------

	/** Check SyftBox authentication status */
	async checkSyftboxAuth(): Promise<boolean> {
		return this.invoke('check_syftbox_auth')
	}

	/** Get current SyftBox daemon state */
	async getSyftboxState(): Promise<{
		running: boolean
		mode: string
		backend: string
		error?: string
	}> {
		return this.invoke('get_syftbox_state')
	}

	/** Start the SyftBox daemon */
	async startSyftboxClient(): Promise<Record<string, unknown>> {
		return this.invoke('start_syftbox_client')
	}

	/** Stop the SyftBox daemon */
	async stopSyftboxClient(): Promise<Record<string, unknown>> {
		return this.invoke('stop_syftbox_client')
	}

	/** Get SyftBox configuration information */
	async getSyftboxConfigInfo(): Promise<Record<string, unknown>> {
		return this.invoke('get_syftbox_config_info')
	}

	/** Trigger an immediate SyftBox sync */
	async triggerSyftboxSync(): Promise<void> {
		return this.invoke('trigger_syftbox_sync')
	}

	/** Perform an action on a queued upload */
	async syftboxUploadAction(id: string, action: string): Promise<void> {
		return this.invoke('syftbox_upload_action', { id, action })
	}

	/** Request an OTP code for SyftBox authentication */
	async syftboxRequestOtp(email: string, serverUrl?: string): Promise<void> {
		const args: Record<string, unknown> = { email }
		if (serverUrl) args.serverUrl = serverUrl
		return this.invoke('syftbox_request_otp', args)
	}

	/** Submit OTP code to complete SyftBox authentication */
	async syftboxSubmitOtp(email: string, otp: string, serverUrl?: string): Promise<void> {
		const args: Record<string, unknown> = { email, otp }
		if (serverUrl) args.serverUrl = serverUrl
		return this.invoke('syftbox_submit_otp', args)
	}

	/** Get SyftBox diagnostic information */
	async getSyftboxDiagnostics(): Promise<Record<string, unknown>> {
		return this.invoke('get_syftbox_diagnostics')
	}

	// -------------------------------------------------------------------------
	// Keys & Crypto
	// -------------------------------------------------------------------------

	/** Get cryptographic key status */
	async keyGetStatus(email?: string): Promise<Record<string, unknown>> {
		return this.invoke('key_get_status', email ? { email } : {})
	}

	/** Generate a new cryptographic identity */
	async keyGenerate(
		email?: string,
		force = false,
	): Promise<{
		success: boolean
		mnemonic?: string
	}> {
		return this.invoke('key_generate', { email, force })
	}

	/** Restore identity from mnemonic */
	async keyRestore(email: string, mnemonic: string): Promise<Record<string, unknown>> {
		return this.invoke('key_restore', { email, mnemonic })
	}

	/** List saved contacts */
	async keyListContacts(currentEmail?: string): Promise<unknown[]> {
		return this.invoke('key_list_contacts', currentEmail ? { currentEmail } : {})
	}

	// -------------------------------------------------------------------------
	// Messages
	// -------------------------------------------------------------------------

	/** Sync all messages */
	async syncMessages(): Promise<Record<string, unknown>> {
		return this.invoke('sync_messages')
	}

	/** List message threads */
	async listMessageThreads(scope?: string, limit?: number): Promise<unknown[]> {
		const args: Record<string, unknown> = {}
		if (scope) args.scope = scope
		if (limit) args.limit = limit
		return this.invoke('list_message_threads', args)
	}

	/** Get messages in a thread */
	async getThreadMessages(threadId: string): Promise<unknown[]> {
		return this.invoke('get_thread_messages', { threadId })
	}

	/** Send a new message */
	async sendMessage(to: string, body: string, subject?: string): Promise<Record<string, unknown>> {
		const request: Record<string, unknown> = { to, body }
		if (subject) request.subject = subject
		return this.invoke('send_message', { request })
	}

	// -------------------------------------------------------------------------
	// Projects
	// -------------------------------------------------------------------------

	/** List all projects */
	async getProjects(): Promise<unknown[]> {
		return this.invoke('get_projects')
	}

	/** Create a new project */
	async createProject(
		name: string,
		options: {
			example?: string
			directory?: string
			createPythonScript?: boolean
			scriptName?: string
		} = {},
	): Promise<Record<string, unknown>> {
		return this.invoke('create_project', { name, ...options })
	}

	// -------------------------------------------------------------------------
	// Pipelines
	// -------------------------------------------------------------------------

	/** List all pipelines */
	async getPipelines(): Promise<unknown[]> {
		return this.invoke('get_pipelines')
	}

	/** Execute a pipeline */
	async runPipeline(
		pipelineId: number,
		inputOverrides: Record<string, string> = {},
		resultsDir?: string,
	): Promise<Record<string, unknown>> {
		const args: Record<string, unknown> = { pipelineId, inputOverrides }
		if (resultsDir) args.resultsDir = resultsDir
		return this.invoke('run_pipeline', args)
	}

	/** List pipeline runs */
	async getPipelineRuns(): Promise<unknown[]> {
		return this.invoke('get_pipeline_runs')
	}

	// -------------------------------------------------------------------------
	// Datasets
	// -------------------------------------------------------------------------

	/** List datasets with their assets */
	async getDatasets(): Promise<unknown[]> {
		return this.invoke('get_datasets')
	}

	/** Publish a dataset to the network */
	async publishDataset(name: string, copyMock = false): Promise<void> {
		return this.invoke('publish_dataset', { name, copyMock })
	}

	/** Remove a dataset from public access */
	async unpublishDataset(name: string): Promise<void> {
		return this.invoke('unpublish_dataset', { name })
	}

	/** Delete a dataset */
	async deleteDataset(name: string): Promise<Record<string, unknown>> {
		return this.invoke('delete_dataset', { name })
	}

	// -------------------------------------------------------------------------
	// Runs
	// -------------------------------------------------------------------------

	/** List all analysis runs */
	async getRuns(): Promise<unknown[]> {
		return this.invoke('get_runs')
	}

	/** Delete an analysis run */
	async deleteRun(runId: number): Promise<void> {
		return this.invoke('delete_run', { runId })
	}

	/** Get logs for a run */
	async getRunLogs(runId: number): Promise<string> {
		return this.invoke('get_run_logs', { runId })
	}

	/** Get the last N lines of run logs */
	async getRunLogsTail(runId: number, lines = 100): Promise<string> {
		return this.invoke('get_run_logs_tail', { runId, lines })
	}

	/** Get full run logs without truncation */
	async getRunLogsFull(runId: number): Promise<string> {
		return this.invoke('get_run_logs_full', { runId })
	}

	// -------------------------------------------------------------------------
	// Sessions
	// -------------------------------------------------------------------------

	/** List all sessions */
	async getSessions(): Promise<unknown[]> {
		return this.invoke('get_sessions')
	}

	/** Create a new collaborative session */
	async createSession(
		name: string,
		peer?: string,
		description?: string,
	): Promise<Record<string, unknown>> {
		const request: Record<string, unknown> = { name }
		if (peer) request.peer = peer
		if (description) request.description = description
		return this.invoke('create_session', { request })
	}

	/** Accept a session invitation */
	async acceptSessionInvitation(sessionId: string): Promise<Record<string, unknown>> {
		return this.invoke('accept_session_invitation', { sessionId })
	}

	/** Reject a session invitation */
	async rejectSessionInvitation(sessionId: string, reason?: string): Promise<void> {
		return this.invoke('reject_session_invitation', { sessionId, reason })
	}

	/** Get details of a specific session */
	async getSession(sessionId: string): Promise<Record<string, unknown>> {
		return this.invoke('get_session', { sessionId })
	}

	/** Delete a session */
	async deleteSession(sessionId: string): Promise<void> {
		return this.invoke('delete_session', { sessionId })
	}

	/** Add a dataset to a session */
	async addDatasetToSession(
		sessionId: string,
		datasetName: string,
		role?: string,
	): Promise<Record<string, unknown>> {
		const args: Record<string, unknown> = { sessionId, datasetName }
		if (role) args.role = role
		return this.invoke('add_dataset_to_session', args)
	}

	/** Remove a dataset from a session */
	async removeDatasetFromSession(sessionId: string, datasetName: string): Promise<void> {
		return this.invoke('remove_dataset_from_session', { sessionId, datasetName })
	}

	// -------------------------------------------------------------------------
	// Jupyter
	// -------------------------------------------------------------------------

	/** Get Jupyter status for a project */
	async getJupyterStatus(projectPath: string): Promise<{
		running: boolean
		port?: number
		url?: string
		token?: string
	}> {
		return this.invoke('get_jupyter_status', { projectPath })
	}

	/** Launch Jupyter for a project */
	async launchJupyter(
		projectPath: string,
		pythonVersion?: string,
	): Promise<{
		running: boolean
		port?: number
		url?: string
		token?: string
	}> {
		return this.invoke('launch_jupyter', { projectPath, pythonVersion })
	}

	/** Stop Jupyter for a project */
	async stopJupyter(projectPath: string): Promise<Record<string, unknown>> {
		return this.invoke('stop_jupyter', { projectPath })
	}

	// -------------------------------------------------------------------------
	// Logs & Diagnostics
	// -------------------------------------------------------------------------

	/** Get command execution logs */
	async getCommandLogs(): Promise<unknown[]> {
		return this.invoke('get_command_logs')
	}

	/** Get desktop log contents */
	async getDesktopLogText(maxBytes?: number): Promise<string> {
		return this.invoke('get_desktop_log_text', maxBytes ? { maxBytes } : {})
	}

	/** Get desktop log directory path */
	async getDesktopLogDir(): Promise<string> {
		return this.invoke('get_desktop_log_dir')
	}

	/** Clear the desktop log file */
	async clearDesktopLog(): Promise<void> {
		return this.invoke('clear_desktop_log')
	}

	/** Clear command execution logs */
	async clearCommandLogs(): Promise<void> {
		return this.invoke('clear_command_logs')
	}

	// -------------------------------------------------------------------------
	// Settings
	// -------------------------------------------------------------------------

	/** Get all application settings */
	async getSettings(): Promise<Record<string, unknown>> {
		return this.invoke('get_settings')
	}

	/** Save application settings */
	async saveSettings(settings: Record<string, unknown>): Promise<void> {
		return this.invoke('save_settings', { settings })
	}

	/** Enable or disable app autostart on login */
	async setAutostartEnabled(enabled: boolean): Promise<void> {
		return this.invoke('set_autostart_enabled', { enabled })
	}

	/** Check if app autostarts on login */
	async getAutostartEnabled(): Promise<boolean> {
		return this.invoke('get_autostart_enabled')
	}

	// -------------------------------------------------------------------------
	// SQL
	// -------------------------------------------------------------------------

	/** List database tables */
	async sqlListTables(): Promise<unknown[]> {
		return this.invoke('sql_list_tables')
	}

	/** Get schema for a table */
	async sqlGetTableSchema(table: string): Promise<unknown[]> {
		return this.invoke('sql_get_table_schema', { table })
	}

	/** Execute a SQL query */
	async sqlRunQuery(
		query: string,
		limit?: number,
	): Promise<{
		columns: string[]
		rows: unknown[][]
	}> {
		const args: Record<string, unknown> = { query }
		if (limit) args.options = { limit }
		return this.invoke('sql_run_query', args)
	}

	// -------------------------------------------------------------------------
	// Data Reset (Destructive)
	// -------------------------------------------------------------------------

	/** Reset all application data (preserves SyftBox) */
	async resetAllData(): Promise<void> {
		return this.invoke('reset_all_data')
	}

	/** Reset all data including SyftBox */
	async resetEverything(): Promise<void> {
		return this.invoke('reset_everything')
	}
}

// -------------------------------------------------------------------------
// Demo / Example
// -------------------------------------------------------------------------

async function demo() {
	console.log('BioVault Agent Demo (Node.js)')
	console.log('='.repeat(50))

	const agent = new BioVaultAgent()

	try {
		await agent.connect()
		console.log(`\nConnected to ${agent.url}`)

		// Discover API
		console.log('\n1. Discovering API...')
		const apiInfo = await agent.discover()
		console.log(`   API Version: ${apiInfo.version}`)
		console.log(`   Auth Required: ${apiInfo.auth.required}`)

		// List commands
		console.log('\n2. Listing commands...')
		const commands = await agent.listCommands()
		console.log(`   Available commands: ${commands.commands.length}`)

		// Get app version
		console.log('\n3. Getting app version...')
		const version = await agent.getAppVersion()
		console.log(`   Version: ${version}`)

		// Check onboarding status
		console.log('\n4. Checking onboarding status...')
		const isOnboarded = await agent.checkIsOnboarded()
		console.log(`   Onboarded: ${isOnboarded}`)

		// Check SyftBox status
		console.log('\n5. Checking SyftBox status...')
		const syftboxState = await agent.getSyftboxState()
		console.log(`   Running: ${syftboxState.running}`)
		console.log(`   Mode: ${syftboxState.mode}`)

		// List projects
		console.log('\n6. Listing projects...')
		const projects = await agent.getProjects()
		if (projects.length > 0) {
			for (const p of projects.slice(0, 5)) {
				console.log(`   - ${(p as { name: string }).name}`)
			}
		} else {
			console.log('   No projects found')
		}

		// Get audit log
		console.log('\n7. Getting recent audit log...')
		const auditLog = await agent.getAuditLog(5)
		console.log(`   Recent entries: ${auditLog.length}`)
	} catch (err) {
		console.error(`Error: ${err}`)
	} finally {
		await agent.disconnect()
	}

	console.log('\n' + '='.repeat(50))
	console.log('Demo complete!')
}

// Run demo if executed directly
if (require.main === module) {
	demo().catch(console.error)
}
