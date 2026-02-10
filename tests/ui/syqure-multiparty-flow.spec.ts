/**
 * Syqure Multiparty Flow Test (Three Clients)
 * Uses the same invitation system as --pipelines-multiparty-flow, but executes
 * the real syqure flow from biovault/tests/scenarios/syqure-flow/flow.yaml.
 *
 * Usage:
 *   ./test-scenario.sh --syqure-multiparty-flow --interactive
 *
 * @tag syqure-multiparty-flow
 */
import { expect, test, type Page } from './playwright-fixtures'
import WebSocket from 'ws'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { setWsPort, completeOnboarding, ensureLogSocket, log } from './onboarding-helper.js'

const TEST_TIMEOUT = 1_800_000 // 30 minutes (syqure runtime can take time)
const UI_TIMEOUT = 20_000
const SYNC_INTERVAL = 1000
const MESSAGE_TIMEOUT = 180_000
const RUN_TIMEOUT_MS = Number.parseInt(
	process.env.SYQURE_MULTIPARTY_RUN_TIMEOUT_MS || '1200000',
	10,
)
const SECURE_ONLY_MODE = ['1', 'true', 'yes'].includes(
	String(process.env.SYQURE_MULTIPARTY_SECURE_ONLY || '').toLowerCase(),
)
const CLI_PARITY_MODE = ['1', 'true', 'yes'].includes(
	String(process.env.SYQURE_MULTIPARTY_CLI_PARITY || '').toLowerCase(),
)

test.describe.configure({ timeout: TEST_TIMEOUT })

interface Backend {
	invoke: (cmd: string, args?: Record<string, unknown>, timeoutMs?: number) => Promise<any>
	close: () => Promise<void>
}

async function connectBackend(port: number): Promise<Backend> {
	const socket = new WebSocket(`ws://localhost:${port}`)
	await new Promise<void>((resolve, reject) => {
		const timeout = setTimeout(
			() => reject(new Error(`WS connect timeout on port ${port}`)),
			10_000,
		)
		socket.once('open', () => {
			clearTimeout(timeout)
			resolve()
		})
		socket.once('error', (err) => {
			clearTimeout(timeout)
			reject(err)
		})
	})

	let nextId = 0
	const pending = new Map<number, { resolve: (v: any) => void; reject: (e: any) => void }>()

	socket.on('message', (data) => {
		let parsed: any
		try {
			parsed = JSON.parse(data.toString())
		} catch {
			return
		}
		const entry = pending.get(parsed?.id)
		if (!entry) return
		pending.delete(parsed.id)
		if (parsed.error) entry.reject(new Error(parsed.error))
		else entry.resolve(parsed.result)
	})

	function invoke(cmd: string, args: Record<string, unknown> = {}, timeoutMs = 30_000) {
		const id = ++nextId
		socket.send(JSON.stringify({ id, cmd, args }))
		return new Promise<any>((resolve, reject) => {
			pending.set(id, { resolve, reject })
			setTimeout(() => {
				if (!pending.has(id)) return
				pending.delete(id)
				reject(new Error(`WS invoke timeout: ${cmd}`))
			}, timeoutMs)
		})
	}

	async function close() {
		if (socket.readyState !== WebSocket.OPEN) return
		await new Promise<void>((resolve) => {
			socket.once('close', () => resolve())
			socket.close()
		})
	}

	return { invoke, close }
}

function resolveDatasitesRoot(dataDir: string): string {
	return path.basename(dataDir) === 'datasites' ? dataDir : path.join(dataDir, 'datasites')
}

async function getSyftboxDataDir(backend: Backend): Promise<string> {
	const info = await backend.invoke('get_syftbox_config_info')
	const dataDir = info?.data_dir
	if (!dataDir || typeof dataDir !== 'string') {
		throw new Error('WS bridge did not return a usable data_dir (get_syftbox_config_info)')
	}
	return dataDir
}

function prepareSecureOnlyFixtures(sessionId: string): { countsPath: string; countPath: string } {
	const fixturesDir = path.join(process.cwd(), 'artifacts', 'syqure-secure-only', sessionId)
	fs.mkdirSync(fixturesDir, { recursive: true })

	const counts = [3, 1, 0]
	const countsPath = path.join(fixturesDir, 'counts_array.json')
	const countPath = path.join(fixturesDir, 'count.txt')
	fs.writeFileSync(countsPath, `${JSON.stringify(counts)}\n`, 'utf8')
	fs.writeFileSync(countPath, `${counts.length}\n`, 'utf8')

	return { countsPath, countPath }
}

function buildSecureOnlyFlowSpec(
	datasites: [string, string, string],
	countsPath: string,
	countPath: string,
	secureAggregateModulePath: string,
): Record<string, any> {
	return {
		vars: {
			flow_path: 'syft://{datasite.current}/shared/flows/{flow_name}',
			run_path: '{vars.flow_path}/{run_id}',
			step_path: '{vars.run_path}/{step.number}-{step.id}',
		},
		coordination: {
			url: '{vars.run_path}/_progress',
			share_with: 'all',
		},
		mpc: {
			url: '{vars.run_path}/_mpc',
			topology: 'mesh',
		},
		inputs: {
			datasites: {
				default: datasites,
			},
		},
		datasites: {
			all: 'inputs.datasites',
			groups: {
				aggregator: {
					include: ['{datasites[0]}'],
				},
				clients: {
					include: ['{datasites[1]}', '{datasites[2]}'],
				},
			},
		},
		modules: {
			secure_aggregate: {
				source: {
					kind: 'local',
					path: secureAggregateModulePath,
				},
				allow_dirty: true,
				interface: {
					inputs: [
						{ name: 'counts', type: 'File' },
						{ name: 'array_length', type: 'String' },
					],
					outputs: [{ name: 'aggregated_counts', type: 'File' }],
				},
				assets: [{ path: 'smpc_aggregate.codon' }, { path: 'he_aggregate.codon' }],
			},
		},
		steps: [
			{
				id: 'secure_aggregate',
				uses: 'secure_aggregate',
				run: {
					targets: 'all',
					strategy: 'parallel',
				},
				with: {
					counts: {
						value: countsPath,
						only: 'clients',
					},
					array_length: {
						value: countPath,
					},
				},
				share: {
					result_shared: {
						source: 'self.outputs.aggregated_counts',
						url: '{vars.step_path}/aggregated.json',
						permissions: {
							read: ['{datasites[*]}'],
							write: ['{datasite.current}'],
						},
					},
				},
			},
		],
	}
}

function applyCliParityModulePaths(
	spec: Record<string, any>,
	sourceFlowPath: string,
): Record<string, any> {
	const cloned = JSON.parse(JSON.stringify(spec || {}))
	const modulesRoot = path.join(path.dirname(sourceFlowPath), 'modules')
	const modules = cloned?.modules
	if (!modules || typeof modules !== 'object') return cloned

	for (const moduleDef of Object.values(modules as Record<string, any>)) {
		const source = moduleDef?.source
		if (!source || source.kind !== 'local' || typeof source.path !== 'string') continue

		const modulePath = source.path.trim()
		if (!modulePath) continue
		if (path.isAbsolute(modulePath)) continue

		let relativePath = modulePath.replace(/^[.][\\/]/, '')
		if (relativePath.startsWith('modules/')) {
			relativePath = relativePath.slice('modules/'.length)
		}
		source.path = path.join(modulesRoot, relativePath)
	}

	return cloned
}

function didBundlePath(viewerDataDir: string, identity: string): string {
	return path.join(resolveDatasitesRoot(viewerDataDir), identity, 'public', 'crypto', 'did.json')
}

function normalizeMetadata(metadata: any): any {
	if (!metadata) return null
	if (typeof metadata === 'string') {
		try {
			return JSON.parse(metadata)
		} catch {
			return null
		}
	}
	return metadata
}

async function waitForThreadMessageMatching(
	backend: Backend,
	threadId: string,
	predicate: (msg: any) => boolean,
	label: string,
	timeoutMs = MESSAGE_TIMEOUT,
): Promise<any> {
	const start = Date.now()
	while (Date.now() - start < timeoutMs) {
		try {
			await backend.invoke('sync_messages_with_failures')
		} catch {
			// Ignore transient sync failures while polling.
		}
		const msgs = await backend.invoke('get_thread_messages', { threadId }).catch(() => [])
		const found = Array.isArray(msgs) ? msgs.find((msg: any) => predicate(msg)) : null
		if (found) return found
		await backend.invoke('trigger_syftbox_sync').catch(() => {})
		await new Promise((r) => setTimeout(r, SYNC_INTERVAL))
	}
	throw new Error(`Timed out waiting for thread message: ${label}`)
}

async function runMultiRecipientCryptoSmoke(
	participants: Array<{ email: string; backend: Backend }>,
): Promise<void> {
	const smokeTag = `crypto-smoke-${Date.now()}`
	console.log(`--- Multi-recipient encryption smoke: ${smokeTag} ---`)

	const sendCases = [
		{ from: participants[0], to: [participants[1], participants[2]] },
		{ from: participants[1], to: [participants[0], participants[2]] },
		{ from: participants[2], to: [participants[0], participants[1]] },
	]

	for (const sendCase of sendCases) {
		const recipientEmails = sendCase.to.map((entry) => entry.email)
		const body = `[${smokeTag}] ${sendCase.from.email} -> ${recipientEmails.join(', ')}`
		const sent = await sendCase.from.backend.invoke('send_message', {
			request: {
				recipients: recipientEmails,
				subject: `Crypto smoke ${smokeTag}`,
				body,
				metadata: {
					crypto_smoke: {
						tag: smokeTag,
						sender: sendCase.from.email,
						recipients: recipientEmails,
					},
				},
			},
		})
		const threadId = sent?.thread_id
		expect(typeof threadId).toBe('string')
		console.log(
			`  Sent smoke message: ${sendCase.from.email} -> ${recipientEmails.join(', ')} (thread ${threadId})`,
		)

		await waitForThreadMessageMatching(
			sendCase.from.backend,
			threadId,
			(msg) => String(msg?.body || '').includes(body),
			`sender sees smoke message (${sendCase.from.email})`,
		)

		for (const recipient of sendCase.to) {
			const received = await waitForThreadMessageMatching(
				recipient.backend,
				threadId,
				(msg) => String(msg?.body || '').includes(body),
				`${recipient.email} receives/decrypts smoke message`,
			)
			const metadata = normalizeMetadata(received?.metadata)
			expect(metadata?.crypto_smoke?.tag).toBe(smokeTag)
		}
	}

	console.log('Multi-recipient encryption smoke passed for all sender/recipient pairs')
}

async function waitForContactImport(
	backend: Backend,
	identity: string,
	timeoutMs = 120_000,
): Promise<void> {
	const start = Date.now()
	let lastError = ''
	while (Date.now() - start < timeoutMs) {
		try {
			await backend.invoke('network_import_contact', { identity })
			return
		} catch (error) {
			lastError = String(error)
		}
		await backend.invoke('trigger_syftbox_sync').catch(() => {})
		await new Promise((r) => setTimeout(r, SYNC_INTERVAL))
	}
	throw new Error(`Timed out waiting for DID/contact import for ${identity}: ${lastError}`)
}

async function waitForDidBundleOnViewer(
	label: string,
	viewerBackend: Backend,
	viewerDataDir: string,
	identity: string,
	allBackends: Backend[],
	timeoutMs = 120_000,
): Promise<void> {
	const start = Date.now()
	const didPath = didBundlePath(viewerDataDir, identity)
	while (Date.now() - start < timeoutMs) {
		await Promise.all(
			allBackends.map((backend) => backend.invoke('trigger_syftbox_sync').catch(() => {})),
		)
		if (fs.existsSync(didPath)) return
		await viewerBackend.invoke('trigger_syftbox_sync').catch(() => {})
		await new Promise((r) => setTimeout(r, SYNC_INTERVAL))
	}
	throw new Error(`Timed out waiting for DID bundle (${label}): ${didPath}`)
}

async function clickMessagesTab(page: Page): Promise<void> {
	const navTab = page.locator('.nav-item[data-tab="messages"]').first()
	if (await navTab.isVisible().catch(() => false)) {
		await navTab.click()
		return
	}
	await page.locator('button:has-text("Messages")').first().click()
}

async function clickRunsTab(page: Page): Promise<void> {
	const navTab = page.locator('.nav-item[data-tab="runs"]').first()
	if (await navTab.isVisible().catch(() => false)) {
		await navTab.click()
		return
	}
	await page.locator('button:has-text("Runs")').first().click()
}

async function clickStepActionButton(
	page: Page,
	stepId: string,
	buttonClass: string,
	label: string,
	timeoutMs = UI_TIMEOUT,
): Promise<void> {
	const startedAt = Date.now()
	let lastError = ''
	while (Date.now() - startedAt < timeoutMs) {
		try {
			await clickRunsTab(page)
			const openAllBtn = page
				.locator('.mp-progress-actions .mp-collapse-btn:has-text("Open All")')
				.first()
			if (await openAllBtn.isVisible().catch(() => false)) {
				await openAllBtn.click().catch(() => {})
			}

			const step = page.locator(`.mp-step[data-step-id="${stepId}"]`).first()
			await expect(step).toBeVisible({ timeout: 3_000 })
			const actionBtn = step.locator(`button.${buttonClass}`).first()
			await expect(actionBtn).toBeVisible({ timeout: 3_000 })
			await expect(actionBtn).toBeEnabled({ timeout: 3_000 })
			await actionBtn.click()
			console.log(`${label}: clicked ${buttonClass} for ${stepId}`)
			return
		} catch (error) {
			lastError = String(error)
			await page.waitForTimeout(1_000)
		}
	}

	throw new Error(`Timed out clicking ${buttonClass} for ${stepId} (${label}): ${lastError}`)
}

async function waitForLocalStepStatus(
	backend: Backend,
	sessionId: string,
	stepId: string,
	expectedStatuses: string[],
	label: string,
	timeoutMs = RUN_TIMEOUT_MS,
): Promise<void> {
	const startedAt = Date.now()
	let lastStatus = 'unknown'
	let lastError = ''
	while (Date.now() - startedAt < timeoutMs) {
		try {
			const state = await backend.invoke('get_multiparty_flow_state', { sessionId }, 120_000)
			const step = (state?.steps || []).find((entry: any) => entry?.id === stepId)
			const status = step?.status ? String(step.status) : ''
			if (status) {
				lastStatus = status
				if (expectedStatuses.includes(status)) return
				if (status === 'Failed') {
					const stepLogs = await backend
						.invoke('get_multiparty_step_logs', { sessionId, stepId, lines: 240 })
						.catch(() => '')
					throw new Error(
						`${label}: step "${stepId}" entered Failed state.\n${String(stepLogs || '')}`,
					)
				}
			}
		} catch (error) {
			lastError = String(error)
		}
		await backend.invoke('trigger_syftbox_sync').catch(() => {})
		await new Promise((r) => setTimeout(r, 1200))
	}
	throw new Error(
		`${label}: timed out waiting for step "${stepId}" statuses [${expectedStatuses.join(', ')}] (last=${lastStatus})` +
			(lastError ? `\nLast error: ${lastError}` : ''),
	)
}

async function waitForSessionRunId(
	backend: Backend,
	sessionId: string,
	label: string,
	timeoutMs = RUN_TIMEOUT_MS,
): Promise<number> {
	const startedAt = Date.now()
	let lastRunId = 0
	let lastError = ''
	while (Date.now() - startedAt < timeoutMs) {
		try {
			const state = await backend.invoke('get_multiparty_flow_state', { sessionId }, 120_000)
			const runId = Number(state?.run_id || 0)
			if (runId > 0) return runId
			lastRunId = runId
		} catch (error) {
			lastError = String(error)
		}
		await backend.invoke('trigger_syftbox_sync').catch(() => {})
		await new Promise((r) => setTimeout(r, 1200))
	}
	throw new Error(
		`${label}: timed out waiting for multiparty run_id > 0 (last=${lastRunId})` +
			(lastError ? `\nLast error: ${lastError}` : ''),
	)
}

async function clickStepActionAndWait(
	page: Page,
	backend: Backend,
	sessionId: string,
	stepId: string,
	buttonClass: string,
	label: string,
	expectedStatuses: string[],
	timeoutMs = RUN_TIMEOUT_MS,
): Promise<void> {
	await clickStepActionButton(page, stepId, buttonClass, label, timeoutMs)
	await waitForLocalStepStatus(backend, sessionId, stepId, expectedStatuses, label, timeoutMs)
}

async function importAndJoinInvitation(
	page: Page,
	backend: Backend,
	label: string,
	flowName: string,
): Promise<void> {
	const start = Date.now()
	while (Date.now() - start < MESSAGE_TIMEOUT) {
		await clickMessagesTab(page)
		await backend.invoke('sync_messages_with_failures').catch(() => {})
		await backend.invoke('trigger_syftbox_sync').catch(() => {})

		const refreshBtn = page.locator('#refresh-messages-btn').first()
		if (await refreshBtn.isVisible().catch(() => false)) {
			await refreshBtn.click().catch(() => {})
			await page.waitForTimeout(500)
		}

		const threadBySubject = page
			.locator(`.message-thread-item:has-text("Multiparty Flow: ${flowName}")`)
			.first()
		if (await threadBySubject.isVisible().catch(() => false)) {
			await threadBySubject.click()
		} else {
			const firstThread = page.locator('.message-thread-item').first()
			if (await firstThread.isVisible().catch(() => false)) {
				await firstThread.click()
			}
		}

		const invitationCard = page.locator('.flow-invitation-card').first()
		if (await invitationCard.isVisible().catch(() => false)) {
			const importBtn = invitationCard.locator(
				'.flow-invitation-btn.import-btn, button:has-text("Import Flow")',
			)
			const joinBtn = invitationCard.locator(
				'.flow-invitation-btn.view-runs-btn, button:has-text("Join Flow"), button:has-text("View Flow")',
			)

			if (await importBtn.isVisible({ timeout: 1500 }).catch(() => false)) {
				await importBtn.click()
				await page.waitForTimeout(1200)
			}

			if (await joinBtn.isVisible({ timeout: 1500 }).catch(() => false)) {
				const joinText = (await joinBtn.textContent().catch(() => '')) || ''
				if (joinText.includes('View Flow')) {
					console.log(`${label}: already joined`)
					return
				}
				await expect(joinBtn).toBeEnabled({ timeout: UI_TIMEOUT })
				await joinBtn.click()
				console.log(`${label}: joined invitation flow`)
				return
			}
		}

		await page.waitForTimeout(SYNC_INTERVAL)
	}

	throw new Error(`${label}: timed out waiting for flow invitation card`)
}

async function waitForRunStatus(
	backend: Backend,
	runId: number,
	expectedStatuses: string[],
	timeoutMs = RUN_TIMEOUT_MS,
	label = 'run',
): Promise<any> {
	const startTime = Date.now()
	let lastStatus = 'unknown'
	let lastPollError = ''
	let consecutivePollErrors = 0
	while (Date.now() - startTime < timeoutMs) {
		let runs: any[] = []
		try {
			// get_flow_runs can be slow while Syqure compute is active; allow a longer WS timeout.
			runs = await backend.invoke('get_flow_runs', {}, 120_000)
			consecutivePollErrors = 0
		} catch (error) {
			lastPollError = String(error)
			consecutivePollErrors += 1
			if (consecutivePollErrors === 1 || consecutivePollErrors % 10 === 0) {
				console.warn(
					`${label}: get_flow_runs poll error (${consecutivePollErrors}): ${lastPollError}`,
				)
			}
			await backend.invoke('trigger_syftbox_sync').catch(() => {})
			await new Promise((r) => setTimeout(r, 2_000))
			continue
		}
		const run = (runs || []).find((r: any) => r.id === runId)
		if (run?.status && run.status !== lastStatus) {
			lastStatus = run.status
			console.log(`${label}: run ${runId} status -> ${formatRunStatusBadge(lastStatus)}`)
		}
		if (run && expectedStatuses.includes(run.status)) {
			return run
		}
		await backend.invoke('trigger_syftbox_sync').catch(() => {})
		await new Promise((r) => setTimeout(r, 2_000))
	}
	let logTail = ''
	try {
		logTail = String((await backend.invoke('get_flow_run_logs_tail', { runId, lines: 200 })) || '')
	} catch {
		// Ignore diagnostic failures and surface the timeout.
	}
	throw new Error(
		`Timed out waiting for run ${runId} status: ${expectedStatuses.join(', ')} (last=${lastStatus})` +
			(lastPollError ? `\nLast poll error: ${lastPollError}` : '') +
			(logTail ? `\nLast log tail:\n${logTail}` : ''),
	)
}

function formatRunStatusBadge(rawStatus: string | null | undefined): string {
	const status = String(rawStatus || 'unknown').toLowerCase()
	if (status === 'success') return '✅ SUCCESS'
	if (status === 'failed') return '❌ FAILED'
	if (status === 'error') return '❌ ERROR'
	if (status === 'running') return '⏳ RUNNING'
	return status.toUpperCase()
}

function collectMatchingFiles(rootDir: string, filename: string): string[] {
	if (!rootDir || !fs.existsSync(rootDir)) return []
	const matches: string[] = []
	const stack = [rootDir]
	while (stack.length > 0) {
		const current = stack.pop()!
		for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
			const fullPath = path.join(current, entry.name)
			if (entry.isDirectory()) {
				stack.push(fullPath)
			} else if (entry.isFile() && entry.name === filename) {
				matches.push(fullPath)
			}
		}
	}
	return matches
}

function assertSharedRunDirExists(dataDir: string, ownerEmail: string, runId: string) {
	const datasitesRoot = resolveDatasitesRoot(dataDir)
	const runDir = path.join(datasitesRoot, ownerEmail, 'shared', 'flows', 'syqure-flow', runId)
	expect(fs.existsSync(runDir)).toBe(true)

	const hasProgressDir =
		fs.existsSync(path.join(runDir, '_progress')) || fs.existsSync(path.join(runDir, 'progress'))
	expect(hasProgressDir).toBe(true)
}

function getSharedRunDir(
	dataDir: string,
	ownerEmail: string,
	flowName: string,
	runId: string,
): string {
	return path.join(resolveDatasitesRoot(dataDir), ownerEmail, 'shared', 'flows', flowName, runId)
}

type MpcTcpMarker = {
	from: string
	to: string
	port: number
	ports: Record<string, number>
}

function readMpcTcpMarker(markerPath: string): MpcTcpMarker {
	const raw = fs.readFileSync(markerPath, 'utf8').trim()
	const parsed = JSON.parse(raw)
	return {
		from: String(parsed?.from || ''),
		to: String(parsed?.to || ''),
		port: Number(parsed?.port || 0),
		ports: Object.fromEntries(
			Object.entries(parsed?.ports || {}).map(([email, port]) => [String(email), Number(port)]),
		),
	}
}

function normalizePortMap(portMap: Record<string, number>): string {
	return Object.entries(portMap)
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([email, port]) => `${email}:${port}`)
		.join('|')
}

function getExpectedMpcChannels(datasites: string[]) {
	const channels: Array<{
		from: string
		to: string
		fromIndex: number
		toIndex: number
		channelId: string
	}> = []
	for (let fromIndex = 0; fromIndex < datasites.length; fromIndex += 1) {
		for (let toIndex = 0; toIndex < datasites.length; toIndex += 1) {
			if (fromIndex === toIndex) continue
			channels.push({
				from: datasites[fromIndex],
				to: datasites[toIndex],
				fromIndex,
				toIndex,
				channelId: `${fromIndex}_to_${toIndex}`,
			})
		}
	}
	return channels
}

function assertMpcTopology(
	participantDataDirs: Map<string, string>,
	datasites: string[],
	flowName: string,
	runId: string,
): void {
	const channels = getExpectedMpcChannels(datasites)
	const pairMarkers = new Map<string, MpcTcpMarker>()

	for (const ownerEmail of datasites) {
		const ownerDataDir = participantDataDirs.get(ownerEmail)
		expect(ownerDataDir, `missing data dir for owner ${ownerEmail}`).toBeTruthy()
		const ownerMpcDir = path.join(
			getSharedRunDir(ownerDataDir!, ownerEmail, flowName, runId),
			'_mpc',
		)
		expect(fs.existsSync(ownerMpcDir), `owner _mpc missing: ${ownerMpcDir}`).toBe(true)
		expect(
			fs.existsSync(path.join(ownerMpcDir, 'syft.pub.yaml')),
			`owner _mpc/syft.pub.yaml missing: ${ownerMpcDir}`,
		).toBe(true)
	}

	for (const channel of channels) {
		const ownerDataDir = participantDataDirs.get(channel.from)
		expect(ownerDataDir, `missing data dir for owner ${channel.from}`).toBeTruthy()

		const ownerMpcDir = path.join(
			getSharedRunDir(ownerDataDir!, channel.from, flowName, runId),
			'_mpc',
		)
		const ownerChannelDir = path.join(ownerMpcDir, channel.channelId)
		const ownerTcpPath = path.join(ownerChannelDir, 'stream.tcp')
		const ownerAcceptPath = path.join(ownerChannelDir, 'stream.accept')
		const ownerAclPath = path.join(ownerChannelDir, 'syft.pub.yaml')

		expect(fs.existsSync(ownerChannelDir), `owner channel dir missing: ${ownerChannelDir}`).toBe(
			true,
		)
		expect(fs.existsSync(ownerTcpPath), `owner stream.tcp missing: ${ownerTcpPath}`).toBe(true)
		expect(fs.existsSync(ownerAcceptPath), `owner stream.accept missing: ${ownerAcceptPath}`).toBe(
			true,
		)
		expect(
			fs.existsSync(ownerAclPath),
			`owner channel syft.pub.yaml missing: ${ownerAclPath}`,
		).toBe(true)

		const acceptValue = fs.readFileSync(ownerAcceptPath, 'utf8').trim()
		expect(
			acceptValue === '1' || acceptValue === 'true',
			`owner stream.accept invalid (${ownerAcceptPath}): ${acceptValue}`,
		).toBe(true)

		const marker = readMpcTcpMarker(ownerTcpPath)
		expect(marker.from, `stream.tcp from mismatch for ${ownerTcpPath}`).toBe(channel.from)
		expect(marker.to, `stream.tcp to mismatch for ${ownerTcpPath}`).toBe(channel.to)
		expect(marker.port > 0, `stream.tcp port invalid for ${ownerTcpPath}: ${marker.port}`).toBe(
			true,
		)
		expect(
			Number(marker.ports[channel.from]) > 0,
			`stream.tcp ports missing sender (${channel.from}) for ${ownerTcpPath}`,
		).toBe(true)
		expect(
			Number(marker.ports[channel.to]) > 0,
			`stream.tcp ports missing recipient (${channel.to}) for ${ownerTcpPath}`,
		).toBe(true)

		const pairKey = [channel.from, channel.to].sort().join('<->')
		const existing = pairMarkers.get(pairKey)
		if (existing) {
			expect(marker.port, `pair port mismatch for ${pairKey}`).toBe(existing.port)
			expect(normalizePortMap(marker.ports), `pair port-map mismatch for ${pairKey}`).toBe(
				normalizePortMap(existing.ports),
			)
		} else {
			pairMarkers.set(pairKey, marker)
		}

		for (const viewerEmail of datasites) {
			const viewerDataDir = participantDataDirs.get(viewerEmail)
			expect(viewerDataDir, `missing data dir for viewer ${viewerEmail}`).toBeTruthy()
			const viewerMpcDir = path.join(
				getSharedRunDir(viewerDataDir!, channel.from, flowName, runId),
				'_mpc',
			)
			const viewerChannelDir = path.join(viewerMpcDir, channel.channelId)
			const viewerAclPath = path.join(viewerChannelDir, 'syft.pub.yaml')

			expect(
				fs.existsSync(viewerChannelDir),
				`viewer channel dir missing (${viewerEmail}): ${viewerChannelDir}`,
			).toBe(true)
			expect(
				fs.existsSync(viewerAclPath),
				`viewer channel syft.pub.yaml missing (${viewerEmail}): ${viewerAclPath}`,
			).toBe(true)
		}
	}
}

async function waitForMpcTopologyReady(
	participantDataDirs: Map<string, string>,
	datasites: string[],
	flowName: string,
	runId: string,
	timeoutMs = MESSAGE_TIMEOUT,
): Promise<void> {
	const startedAt = Date.now()
	let lastError = ''
	while (Date.now() - startedAt < timeoutMs) {
		try {
			assertMpcTopology(participantDataDirs, datasites, flowName, runId)
			return
		} catch (error) {
			lastError = String(error)
		}
		await new Promise((resolve) => setTimeout(resolve, 1200))
	}
	throw new Error(
		`Timed out waiting for _mpc topology/port markers to be ready for run ${runId}` +
			(lastError ? `\nLast topology error: ${lastError}` : ''),
	)
}

function getSharedStepDirCandidates(runDir: string, stepNumber: number, stepId: string): string[] {
	return [
		path.join(runDir, `${stepNumber}-${stepId}`),
		path.join(runDir, `${String(stepNumber).padStart(2, '0')}-${stepId}`),
	]
}

function findExistingSharedStepDir(
	runDir: string,
	stepNumber: number,
	stepId: string,
): string | null {
	for (const candidate of getSharedStepDirCandidates(runDir, stepNumber, stepId)) {
		if (fs.existsSync(candidate)) return candidate
	}
	return null
}

async function waitForCondition(
	check: () => boolean,
	label: string,
	timeoutMs = MESSAGE_TIMEOUT,
	pollMs = 1000,
): Promise<void> {
	const startedAt = Date.now()
	while (Date.now() - startedAt < timeoutMs) {
		if (check()) return
		await new Promise((resolve) => setTimeout(resolve, pollMs))
	}
	throw new Error(`Timed out waiting for condition: ${label}`)
}

async function waitForSharedFileOnViewers(
	participantDataDirs: Map<string, string>,
	ownerEmail: string,
	flowName: string,
	runId: string,
	stepNumber: number,
	stepId: string,
	fileName: string,
	requiredViewerEmails: string[],
	timeoutMs = MESSAGE_TIMEOUT,
): Promise<void> {
	await waitForCondition(
		() =>
			requiredViewerEmails.every((viewerEmail) => {
				const viewerDataDir = participantDataDirs.get(viewerEmail)
				if (!viewerDataDir) return false
				const runDir = getSharedRunDir(viewerDataDir, ownerEmail, flowName, runId)
				const stepDir = findExistingSharedStepDir(runDir, stepNumber, stepId)
				if (!stepDir) return false
				return fs.existsSync(path.join(stepDir, fileName))
			}),
		`${ownerEmail}/${stepId}/${fileName} visible on ${requiredViewerEmails.join(', ')}`,
		timeoutMs,
	)
}

function findParticipantStepStatus(
	allProgress: any[],
	participantEmail: string,
	stepId: string,
): string | null {
	const participant = (allProgress || []).find((entry) => entry?.email === participantEmail)
	if (!participant) return null
	const step = (participant.steps || []).find((entry: any) => entry?.step_id === stepId)
	return step?.status || null
}

async function waitForProgressConvergence(
	viewers: Array<{ label: string; backend: Backend }>,
	sessionId: string,
	expectedStatuses: Array<{ email: string; stepId: string; statuses: string[] }>,
	timeoutMs = MESSAGE_TIMEOUT,
): Promise<void> {
	const startedAt = Date.now()
	while (Date.now() - startedAt < timeoutMs) {
		let allSatisfied = true

		for (const viewer of viewers) {
			await viewer.backend.invoke('trigger_syftbox_sync').catch(() => {})
			const allProgress = await viewer.backend
				.invoke('get_all_participant_progress', { sessionId })
				.catch(() => [])
			for (const expected of expectedStatuses) {
				const status = findParticipantStepStatus(allProgress, expected.email, expected.stepId)
				if (!status || !expected.statuses.includes(status)) {
					allSatisfied = false
					break
				}
			}
			if (!allSatisfied) break
		}

		if (allSatisfied) return
		await new Promise((resolve) => setTimeout(resolve, 1200))
	}

	throw new Error('Timed out waiting for cross-participant progress convergence')
}

test.describe('Syqure flow via multiparty invitation system @syqure-multiparty-flow', () => {
	test('three clients join via invitation card and execute real syqure flow', async ({
		browser,
	}) => {
		const wsPortBase = Number.parseInt(process.env.DEV_WS_BRIDGE_PORT_BASE || '3333', 10)
		const wsPort1 = wsPortBase
		const wsPort2 = wsPortBase + 1
		const wsPort3 = wsPortBase + 2

		const email1 = process.env.CLIENT1_EMAIL || 'client1@sandbox.local'
		const email2 = process.env.CLIENT2_EMAIL || 'client2@sandbox.local'
		const email3 = process.env.AGG_EMAIL || 'aggregator@sandbox.local'

		const flowName = 'syqure-flow'
		const sourceFlowPath = path.join(
			process.cwd(),
			'biovault',
			'tests',
			'scenarios',
			'syqure-flow',
			'flow.yaml',
		)
		expect(fs.existsSync(sourceFlowPath)).toBe(true)
		const secureAggregateModulePath = CLI_PARITY_MODE
			? path.join(path.dirname(sourceFlowPath), 'modules', 'secure-aggregate')
			: './modules/secure-aggregate'
		if (CLI_PARITY_MODE) {
			expect(fs.existsSync(secureAggregateModulePath)).toBe(true)
		}

		let logSocket: WebSocket | null = null
		let backend1: Backend | null = null
		let backend2: Backend | null = null
		let backend3: Backend | null = null
		let page1: Page | null = null
		let page2: Page | null = null
		let page3: Page | null = null

		try {
			logSocket = await ensureLogSocket()
			log(logSocket, {
				event: 'syqure-multiparty-flow-start',
				email1,
				email2,
				email3,
				flowName,
			})

			page1 = await browser.newPage()
			page2 = await browser.newPage()
			page3 = await browser.newPage()

			await setWsPort(page1, wsPort1)
			await setWsPort(page2, wsPort2)
			await setWsPort(page3, wsPort3)

			backend1 = await connectBackend(wsPort1)
			backend2 = await connectBackend(wsPort2)
			backend3 = await connectBackend(wsPort3)

			const uiBaseUrl = process.env.UI_BASE_URL || 'http://localhost:8082'
			await page1.goto(uiBaseUrl)
			await page2.goto(uiBaseUrl)
			await page3.goto(uiBaseUrl)

			await completeOnboarding(page1, email1, logSocket)
			await completeOnboarding(page2, email2, logSocket)
			await completeOnboarding(page3, email3, logSocket)

			await backend1.invoke('get_dev_mode_info')
			await backend2.invoke('get_dev_mode_info')
			await backend3.invoke('get_dev_mode_info')

			const dataDir1 = await getSyftboxDataDir(backend1)
			const dataDir2 = await getSyftboxDataDir(backend2)
			const dataDir3 = await getSyftboxDataDir(backend3)
			const participantDataDirs = new Map<string, string>([
				[email1, dataDir1],
				[email2, dataDir2],
				[email3, dataDir3],
			])

			const allBackends = [backend1, backend2, backend3]
			await Promise.all([
				waitForDidBundleOnViewer(email1, backend1, dataDir1, email2, allBackends),
				waitForDidBundleOnViewer(email1, backend1, dataDir1, email3, allBackends),
				waitForDidBundleOnViewer(email2, backend2, dataDir2, email1, allBackends),
				waitForDidBundleOnViewer(email2, backend2, dataDir2, email3, allBackends),
				waitForDidBundleOnViewer(email3, backend3, dataDir3, email1, allBackends),
				waitForDidBundleOnViewer(email3, backend3, dataDir3, email2, allBackends),
			])

			// Pairwise contacts for encrypted invitation delivery.
			// Wait/retry until DID bundles are visible across all three clients.
			await Promise.all([
				waitForContactImport(backend1, email2),
				waitForContactImport(backend1, email3),
				waitForContactImport(backend2, email1),
				waitForContactImport(backend2, email3),
				waitForContactImport(backend3, email1),
				waitForContactImport(backend3, email2),
			])

			await runMultiRecipientCryptoSmoke([
				{ email: email1, backend: backend1 },
				{ email: email2, backend: backend2 },
				{ email: email3, backend: backend3 },
			])

			// Match biovault/tests/scenarios/syqure-distributed.yaml behavior:
			// each participant runs the same source flow folder with local modules.
			await Promise.all([
				backend1.invoke('import_flow', {
					flowFile: sourceFlowPath,
					overwrite: true,
				}),
				backend2.invoke('import_flow', {
					flowFile: sourceFlowPath,
					overwrite: true,
				}),
				backend3.invoke('import_flow', {
					flowFile: sourceFlowPath,
					overwrite: true,
				}),
			])

			const flowsAgg = await backend3.invoke('get_flows', {})
			const syqureFlowAgg = (flowsAgg || []).find((flow: any) => flow?.name === flowName)
			expect(syqureFlowAgg).toBeTruthy()
			expect(syqureFlowAgg?.spec).toBeTruthy()

			const sessionId = `session-${Date.now()}`
			// Keep runId aligned with multiparty session_id so the shared _progress and step paths
			// are observed consistently by collaborative UI/state readers.
			const runId = sessionId
			const datasites = [email3, email1, email2]
			const secureStepNumber = SECURE_ONLY_MODE ? 1 : 5

			const secureOnlyFixtures = SECURE_ONLY_MODE ? prepareSecureOnlyFixtures(sessionId) : null
			const resolvedSpec = SECURE_ONLY_MODE
				? buildSecureOnlyFlowSpec(
						[email3, email1, email2],
						secureOnlyFixtures!.countsPath,
						secureOnlyFixtures!.countPath,
						secureAggregateModulePath,
					)
				: CLI_PARITY_MODE
					? applyCliParityModulePaths(syqureFlowAgg.spec, sourceFlowPath)
					: syqureFlowAgg.spec

			const flowSpec = {
				apiVersion: 'syftbox.openmined.org/v1alpha1',
				kind: 'Flow',
				metadata: {
					name: flowName,
					version: syqureFlowAgg?.version || '0.1.0',
				},
				spec: resolvedSpec,
			}
			if (SECURE_ONLY_MODE) {
				console.log(
					`secure-only mode enabled: counts=${secureOnlyFixtures!.countsPath} count=${secureOnlyFixtures!.countPath}`,
				)
			}
			if (CLI_PARITY_MODE) {
				console.log(
					`cli-parity mode enabled: module paths resolved from ${path.dirname(sourceFlowPath)}`,
				)
			}

			const participants = [
				{ email: email3, role: 'aggregator' },
				{ email: email1, role: 'client1' },
				{ email: email2, role: 'client2' },
			]

			await backend3.invoke('send_message', {
				request: {
					recipients: [email1, email2],
					body: `Join collaborative Syqure flow run ${runId}`,
					subject: `Multiparty Flow: ${flowName}`,
					metadata: {
						flow_invitation: {
							flow_name: flowName,
							session_id: sessionId,
							participants,
							flow_spec: flowSpec,
						},
					},
				},
			})

			await importAndJoinInvitation(page1, backend1, email1, flowName)
			await importAndJoinInvitation(page2, backend2, email2, flowName)
			await importAndJoinInvitation(page3, backend3, email3, flowName)

			const [runId1, runId2, runId3] = await Promise.all([
				waitForSessionRunId(backend1, sessionId, email1, 90_000),
				waitForSessionRunId(backend2, sessionId, email2, 90_000),
				waitForSessionRunId(backend3, sessionId, email3, 90_000),
			])
			expect(runId1).toBeGreaterThan(0)
			expect(runId2).toBeGreaterThan(0)
			expect(runId3).toBeGreaterThan(0)

			const flows1 = await backend1.invoke('get_flows', {})
			const flows2 = await backend2.invoke('get_flows', {})
			const flows3 = await backend3.invoke('get_flows', {})
			const syqureFlow1 = (flows1 || []).find((flow: any) => flow?.name === flowName)
			const syqureFlow2 = (flows2 || []).find((flow: any) => flow?.name === flowName)
			const syqureFlow3 = (flows3 || []).find((flow: any) => flow?.name === flowName)
			expect(syqureFlow1).toBeTruthy()
			expect(syqureFlow2).toBeTruthy()
			expect(syqureFlow3).toBeTruthy()

			// Drive execution through the same UI controls users use (Run/Share per participant window).
			await Promise.all([clickRunsTab(page1), clickRunsTab(page2), clickRunsTab(page3)])

			if (!SECURE_ONLY_MODE) {
				// Stage 1: clients run + share gen_variants.
				await Promise.all([
					clickStepActionAndWait(
						page1,
						backend1,
						sessionId,
						'gen_variants',
						'mp-run-btn',
						email1,
						['Completed', 'Shared'],
						180_000,
					),
					clickStepActionAndWait(
						page2,
						backend2,
						sessionId,
						'gen_variants',
						'mp-run-btn',
						email2,
						['Completed', 'Shared'],
						180_000,
					),
				])
				await Promise.all([
					clickStepActionAndWait(
						page1,
						backend1,
						sessionId,
						'gen_variants',
						'mp-share-btn',
						email1,
						['Shared'],
						180_000,
					),
					clickStepActionAndWait(
						page2,
						backend2,
						sessionId,
						'gen_variants',
						'mp-share-btn',
						email2,
						['Shared'],
						180_000,
					),
				])

				// Stage 2: aggregator run + share build_master.
				await clickStepActionAndWait(
					page3,
					backend3,
					sessionId,
					'build_master',
					'mp-run-btn',
					email3,
					['Completed', 'Shared'],
					180_000,
				)
				await clickStepActionAndWait(
					page3,
					backend3,
					sessionId,
					'build_master',
					'mp-share-btn',
					email3,
					['Shared'],
					180_000,
				)

				// Stage 3: clients run align_counts.
				await Promise.all([
					clickStepActionAndWait(
						page1,
						backend1,
						sessionId,
						'align_counts',
						'mp-run-btn',
						email1,
						['Completed', 'Shared'],
						180_000,
					),
					clickStepActionAndWait(
						page2,
						backend2,
						sessionId,
						'align_counts',
						'mp-run-btn',
						email2,
						['Completed', 'Shared'],
						180_000,
					),
				])

				// Assert MPC channel directories/markers before secure_aggregate starts.
				await waitForMpcTopologyReady(participantDataDirs, datasites, flowName, runId, 180_000)
			}

			// Final stage: all parties run + share secure_aggregate.
			await Promise.all([
				clickStepActionAndWait(
					page1,
					backend1,
					sessionId,
					'secure_aggregate',
					'mp-run-btn',
					email1,
					['Completed', 'Shared'],
					RUN_TIMEOUT_MS,
				),
				clickStepActionAndWait(
					page2,
					backend2,
					sessionId,
					'secure_aggregate',
					'mp-run-btn',
					email2,
					['Completed', 'Shared'],
					RUN_TIMEOUT_MS,
				),
				clickStepActionAndWait(
					page3,
					backend3,
					sessionId,
					'secure_aggregate',
					'mp-run-btn',
					email3,
					['Completed', 'Shared'],
					RUN_TIMEOUT_MS,
				),
			])
			await Promise.all([
				clickStepActionAndWait(
					page1,
					backend1,
					sessionId,
					'secure_aggregate',
					'mp-share-btn',
					email1,
					['Shared'],
					RUN_TIMEOUT_MS,
				),
				clickStepActionAndWait(
					page2,
					backend2,
					sessionId,
					'secure_aggregate',
					'mp-share-btn',
					email2,
					['Shared'],
					RUN_TIMEOUT_MS,
				),
				clickStepActionAndWait(
					page3,
					backend3,
					sessionId,
					'secure_aggregate',
					'mp-share-btn',
					email3,
					['Shared'],
					RUN_TIMEOUT_MS,
				),
			])

			assertSharedRunDirExists(dataDir1, email1, runId)
			assertSharedRunDirExists(dataDir2, email2, runId)
			assertSharedRunDirExists(dataDir3, email3, runId)

			// Verify each participant can observe converged step statuses from all parties.
			const viewers = [
				{ label: email1, backend: backend1 },
				{ label: email2, backend: backend2 },
				{ label: email3, backend: backend3 },
			]
			const expectedConvergence = SECURE_ONLY_MODE
				? [
						{ email: email1, stepId: 'secure_aggregate', statuses: ['Shared', 'Completed'] },
						{ email: email2, stepId: 'secure_aggregate', statuses: ['Shared', 'Completed'] },
						{ email: email3, stepId: 'secure_aggregate', statuses: ['Shared', 'Completed'] },
					]
				: [
						{ email: email1, stepId: 'gen_variants', statuses: ['Shared', 'Completed'] },
						{ email: email2, stepId: 'gen_variants', statuses: ['Shared', 'Completed'] },
						{ email: email3, stepId: 'build_master', statuses: ['Shared', 'Completed'] },
						{ email: email1, stepId: 'align_counts', statuses: ['Completed', 'Shared'] },
						{ email: email2, stepId: 'align_counts', statuses: ['Completed', 'Shared'] },
						{ email: email1, stepId: 'secure_aggregate', statuses: ['Shared', 'Completed'] },
						{ email: email2, stepId: 'secure_aggregate', statuses: ['Shared', 'Completed'] },
						{ email: email3, stepId: 'secure_aggregate', statuses: ['Shared', 'Completed'] },
					]
			await waitForProgressConvergence(viewers, sessionId, expectedConvergence)

			const finalRun1 = await waitForRunStatus(
				backend1,
				runId1,
				['success', 'failed', 'error'],
				RUN_TIMEOUT_MS,
				email1,
			)
			const finalRun2 = await waitForRunStatus(
				backend2,
				runId2,
				['success', 'failed', 'error'],
				RUN_TIMEOUT_MS,
				email2,
			)
			const finalRun3 = await waitForRunStatus(
				backend3,
				runId3,
				['success', 'failed', 'error'],
				RUN_TIMEOUT_MS,
				email3,
			)
			console.log(
				`Final run statuses: ${email1}=${formatRunStatusBadge(finalRun1.status)}, ${email2}=${formatRunStatusBadge(finalRun2.status)}, ${email3}=${formatRunStatusBadge(finalRun3.status)}`,
			)
			if (
				finalRun1.status === 'success' &&
				finalRun2.status === 'success' &&
				finalRun3.status === 'success'
			) {
				console.log(
					`✅ SUCCESS: multiparty syqure flow completed (${email1}, ${email2}, ${email3})`,
				)
			}
			expect(finalRun1.status).toBe('success')
			expect(finalRun2.status).toBe('success')
			expect(finalRun3.status).toBe('success')

			// Verify _progress state/log files are synced and visible cross-datasite.
			for (const ownerEmail of [email1, email2, email3]) {
				for (const viewerEmail of [email1, email2, email3]) {
					const viewerDataDir = participantDataDirs.get(viewerEmail)!
					const runDir = getSharedRunDir(viewerDataDir, ownerEmail, flowName, runId)
					await waitForCondition(
						() => fs.existsSync(path.join(runDir, '_progress', 'state.json')),
						`${viewerEmail} sees ${ownerEmail} _progress/state.json`,
					)
					await waitForCondition(
						() =>
							fs.existsSync(path.join(runDir, '_progress', 'log.jsonl')) ||
							fs.existsSync(path.join(runDir, '_progress', 'progress.json')),
						`${viewerEmail} sees ${ownerEmail} _progress log`,
					)
				}
			}

			if (!SECURE_ONLY_MODE) {
				// Stage 1 share: clients share rsids with aggregator.
				await waitForSharedFileOnViewers(
					participantDataDirs,
					email1,
					flowName,
					runId,
					1,
					'gen_variants',
					'rsids.txt',
					[email1, email3],
				)
				await waitForSharedFileOnViewers(
					participantDataDirs,
					email2,
					flowName,
					runId,
					1,
					'gen_variants',
					'rsids.txt',
					[email2, email3],
				)

				// Stage 2 share: aggregator shares master list with all.
				await waitForSharedFileOnViewers(
					participantDataDirs,
					email3,
					flowName,
					runId,
					2,
					'build_master',
					'master_list.txt',
					[email1, email2, email3],
				)
			}

			// Final secure share: every participant shares secure_aggregate output back to all.
			for (const ownerEmail of [email1, email2, email3]) {
				await waitForSharedFileOnViewers(
					participantDataDirs,
					ownerEmail,
					flowName,
					runId,
					secureStepNumber,
					'secure_aggregate',
					'aggregated_counts.json',
					[email1, email2, email3],
				)
			}

			// Verify secure share permissions include all participants on each owner's final output.
			for (const ownerEmail of [email1, email2, email3]) {
				const ownerRunDir = getSharedRunDir(
					participantDataDirs.get(ownerEmail)!,
					ownerEmail,
					flowName,
					runId,
				)
				const secureDir = findExistingSharedStepDir(
					ownerRunDir,
					secureStepNumber,
					'secure_aggregate',
				)
				expect(secureDir).toBeTruthy()
				const syftPubPath = path.join(secureDir!, 'syft.pub.yaml')
				expect(fs.existsSync(syftPubPath)).toBe(true)
				const syftPub = fs.readFileSync(syftPubPath, 'utf8')
				expect(syftPub).toContain(`- ${email1}`)
				expect(syftPub).toContain(`- ${email2}`)
				expect(syftPub).toContain(`- ${email3}`)
			}

			for (const ownerEmail of [email1, email2, email3]) {
				for (const viewerEmail of [email1, email2, email3]) {
					const viewerDataDir = participantDataDirs.get(viewerEmail)!
					const ownerRunDir = getSharedRunDir(viewerDataDir, ownerEmail, flowName, runId)
					const secureDir = findExistingSharedStepDir(
						ownerRunDir,
						secureStepNumber,
						'secure_aggregate',
					)
					expect(secureDir).toBeTruthy()
					const aggregatedPath = path.join(secureDir!, 'aggregated_counts.json')
					expect(fs.existsSync(aggregatedPath)).toBe(true)
				}
			}

			log(logSocket, {
				event: 'syqure-multiparty-flow-complete',
				runId,
			})
		} finally {
			if (page1) await page1.close().catch(() => {})
			if (page2) await page2.close().catch(() => {})
			if (page3) await page3.close().catch(() => {})

			if (backend1) await backend1.close().catch(() => {})
			if (backend2) await backend2.close().catch(() => {})
			if (backend3) await backend3.close().catch(() => {})

			if (logSocket && logSocket.readyState === WebSocket.OPEN) {
				await new Promise<void>((resolve) => {
					logSocket!.once('close', () => resolve())
					logSocket!.close()
				})
			}
		}
	})
})
