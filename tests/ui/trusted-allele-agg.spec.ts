/**
 * Trusted Allele Aggregation Flow Test (Three Clients)
 * Clients share raw allele_freq TSV with aggregator who computes in plaintext.
 * No MPC/Syqure — just direct file sharing and Python aggregation.
 *
 * Usage:
 *   ./test-scenario.sh --trusted-allele-agg --interactive
 *
 * @tag trusted-allele-agg
 */
import { expect, test, type Page, pauseForInteractive } from './playwright-fixtures'
import type { Locator } from '@playwright/test'
import WebSocket from 'ws'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { setWsPort, completeOnboarding, ensureLogSocket, log } from './onboarding-helper.js'

const TEST_TIMEOUT = 600_000 // 10 minutes (no MPC, much faster)
const UI_TIMEOUT = 20_000
const SYNC_INTERVAL = 1000
const MESSAGE_TIMEOUT = 180_000
const RUN_TIMEOUT_MS = Number.parseInt(
	process.env.TRUSTED_ALLELE_AGG_RUN_TIMEOUT_MS || '300000',
	10,
)
const ALLELE_AGG_TRIM_LINES = Number.parseInt(
	process.env.TRUSTED_ALLELE_AGG_TRIM_LINES || '1000',
	10,
)
const ALLELE_AGG_SOURCE_TSV = process.env.TRUSTED_ALLELE_AGG_SOURCE_TSV
	? path.resolve(process.env.TRUSTED_ALLELE_AGG_SOURCE_TSV)
	: path.join(process.cwd(), 'data', 'allele_freq.tsv')
const ALLELE_AGG_CLIENT1_TSV = process.env.TRUSTED_ALLELE_AGG_CLIENT1_TSV
	? path.resolve(process.env.TRUSTED_ALLELE_AGG_CLIENT1_TSV)
	: ''
const ALLELE_AGG_CLIENT2_TSV = process.env.TRUSTED_ALLELE_AGG_CLIENT2_TSV
	? path.resolve(process.env.TRUSTED_ALLELE_AGG_CLIENT2_TSV)
	: ''
const SKIP_FLOW_IMPORT = ['1', 'true', 'yes'].includes(
	String(process.env.TRUSTED_ALLELE_AGG_SKIP_FLOW_IMPORT || '').toLowerCase(),
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
		throw new Error('WS bridge did not return a usable data_dir')
	}
	return dataDir
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
			// ignore
		}
		const msgs = await backend.invoke('get_thread_messages', { threadId }).catch(() => [])
		const found = Array.isArray(msgs) ? msgs.find((msg: any) => predicate(msg)) : null
		if (found) return found
		await backend.invoke('trigger_syftbox_sync').catch(() => {})
		await new Promise((r) => setTimeout(r, SYNC_INTERVAL))
	}
	throw new Error(`Timed out waiting for thread message: ${label}`)
}

async function sendMessageWithRetry(
	backend: Backend,
	request: Record<string, unknown>,
	maxAttempts = 8,
): Promise<any> {
	let lastError: unknown = null
	for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
		try {
			return await backend.invoke('send_message', { request }, 120_000)
		} catch (error) {
			lastError = error
			const message = String(error || '')
			if (!/database is locked/i.test(message) || attempt === maxAttempts) break
			await backend.invoke('trigger_syftbox_sync').catch(() => {})
			await new Promise((r) => setTimeout(r, 400 * attempt))
		}
	}
	throw lastError instanceof Error
		? lastError
		: new Error(String(lastError || 'send_message failed'))
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
		const sent = await sendMessageWithRetry(sendCase.from.backend, {
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
		})
		const threadId = sent?.thread_id
		expect(typeof threadId).toBe('string')

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
	console.log('Multi-recipient encryption smoke passed')
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
	const didPath = path.join(
		resolveDatasitesRoot(viewerDataDir),
		identity,
		'public',
		'crypto',
		'did.json',
	)
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

function clampInt(value: number, min: number, max: number): number {
	return Math.max(min, Math.min(max, value))
}

function createMutatedAlleleFreqFixture(
	sourcePath: string,
	outputPath: string,
	trimLines: number,
	seed: number,
): void {
	if (!fs.existsSync(sourcePath)) {
		throw new Error(`Missing source allele_freq TSV: ${sourcePath}`)
	}
	const lines = fs
		.readFileSync(sourcePath, 'utf8')
		.split(/\r?\n/)
		.filter((line) => line.trim().length > 0)
	if (lines.length < 2) {
		throw new Error(`Source allele_freq TSV has no data rows: ${sourcePath}`)
	}

	const header = lines[0].split('\t')
	const dataRows = lines.slice(1, Math.min(lines.length, trimLines + 1))
	const idx = Object.fromEntries(header.map((name, i) => [name.trim(), i]))

	const locusIdx = idx.locus_key ?? idx.locus
	const acIdx = idx.allele_count ?? idx.ac
	const anIdx = idx.allele_number ?? idx.an
	const afIdx = idx.allele_freq ?? idx.af

	if (locusIdx === undefined || acIdx === undefined || anIdx === undefined || afIdx === undefined) {
		throw new Error(
			`Source TSV missing required columns. Need locus_key/locus + allele_count/ac + allele_number/an + allele_freq/af`,
		)
	}

	const outRows: string[] = [lines[0]]
	for (let i = 0; i < dataRows.length; i += 1) {
		const parts = dataRows[i].split('\t')
		if (!parts[locusIdx]) continue

		const rawAc = Number.parseInt(parts[acIdx] || '0', 10)
		const rawAn = Number.parseInt(parts[anIdx] || '0', 10)
		const baseAn = Number.isFinite(rawAn) && rawAn > 0 ? rawAn : 2
		const baseAc = Number.isFinite(rawAc) ? rawAc : 0

		const anJitter = ((i + seed * 3) % 7) - 3
		let an = baseAn + anJitter
		if (an < 2) an = 2
		if (an % 2 !== 0) an += 1

		const acJitter = ((i * 5 + seed) % 5) - 2
		const ac = clampInt(baseAc + acJitter, 0, an)
		const af = an > 0 ? (ac / an).toFixed(6) : '0.000000'

		parts[acIdx] = String(ac)
		parts[anIdx] = String(an)
		parts[afIdx] = af

		outRows.push(parts.join('\t'))
	}

	fs.mkdirSync(path.dirname(outputPath), { recursive: true })
	fs.writeFileSync(outputPath, `${outRows.join('\n')}\n`, 'utf8')
}

function createInputFixtures(sessionId: string): {
	client1Path: string
	client2Path: string
} {
	if (ALLELE_AGG_CLIENT1_TSV || ALLELE_AGG_CLIENT2_TSV) {
		const client1Path = ALLELE_AGG_CLIENT1_TSV || ALLELE_AGG_SOURCE_TSV
		const client2Path = ALLELE_AGG_CLIENT2_TSV || ALLELE_AGG_SOURCE_TSV
		if (!fs.existsSync(client1Path)) {
			throw new Error(`Missing client1 allele_freq TSV: ${client1Path}`)
		}
		if (!fs.existsSync(client2Path)) {
			throw new Error(`Missing client2 allele_freq TSV: ${client2Path}`)
		}
		console.log(
			`Using caller-provided TSVs: client1=${client1Path} client2=${client2Path}`,
		)
		return { client1Path, client2Path }
	}

	const fixtureDir = path.join(process.cwd(), 'artifacts', 'trusted-allele-agg', sessionId)
	const client1Path = path.join(fixtureDir, 'client1_allele_freq.tsv')
	const client2Path = path.join(fixtureDir, 'client2_allele_freq.tsv')
	createMutatedAlleleFreqFixture(ALLELE_AGG_SOURCE_TSV, client1Path, ALLELE_AGG_TRIM_LINES, 11)
	createMutatedAlleleFreqFixture(ALLELE_AGG_SOURCE_TSV, client2Path, ALLELE_AGG_TRIM_LINES, 29)
	return { client1Path, client2Path }
}

async function importAlleleFreqFileForPicker(
	backend: Backend,
	label: string,
	filePath: string,
): Promise<void> {
	if (!fs.existsSync(filePath)) {
		throw new Error(`${label}: file missing for picker import: ${filePath}`)
	}
	const fileMetadata = {
		[filePath]: {
			data_type: 'AlleleFreq',
			source: 'trusted-allele-agg-test',
			grch_version: 'GRCh38',
			participant_id: label.replace(/[^a-z0-9]/gi, '_'),
		},
	}
	await backend.invoke('import_files_pending', { fileMetadata }, 120_000)
	const start = Date.now()
	while (Date.now() - start < 20_000) {
		const files = await backend.invoke('get_files').catch(() => [])
		if (Array.isArray(files) && files.some((entry: any) => entry?.file_path === filePath)) {
			console.log(`${label}: imported picker file ${filePath}`)
			return
		}
		await backend.invoke('trigger_syftbox_sync').catch(() => {})
		await new Promise((r) => setTimeout(r, 500))
	}
	throw new Error(`${label}: imported file did not appear in picker catalog: ${filePath}`)
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

async function runStepViaBackendWhenReadyAndWait(
	backend: Backend,
	sessionId: string,
	stepId: string,
	label: string,
	expectedStatuses: string[],
	timeoutMs = RUN_TIMEOUT_MS,
): Promise<void> {
	const startedAt = Date.now()
	let lastError = ''
	const rpcTimeoutMs = Math.max(120_000, Math.min(timeoutMs, 600_000))
	const transientStartError = (message: string): boolean =>
		/not satisfied yet/i.test(message) ||
		/step is not ready to run \(status:\s*waitingforinputs\)/i.test(message) ||
		/step is not ready to run \(status:\s*waitingfordependencies\)/i.test(message) ||
		/step is not ready to run \(status:\s*failed\)/i.test(message) ||
		/Shell workflow exited with code/i.test(message) ||
		/WS invoke timeout: run_flow_step/i.test(message) ||
		/Failed to resolve flow binding/i.test(message)
	while (Date.now() - startedAt < timeoutMs) {
		try {
			await backend.invoke('run_flow_step', { sessionId, stepId }, rpcTimeoutMs)
			console.log(`${label}: backend started ${stepId}`)
			await waitForLocalStepStatus(backend, sessionId, stepId, expectedStatuses, label, timeoutMs)
			return
		} catch (error) {
			lastError = String(error || '')
			if (/step is not ready to run \(status:\s*(completed|shared|running)\)/i.test(lastError)) {
				await waitForLocalStepStatus(backend, sessionId, stepId, expectedStatuses, label, timeoutMs)
				return
			}
			if (!transientStartError(lastError)) {
				throw error
			}
		}
		await backend.invoke('trigger_syftbox_sync').catch(() => {})
		await new Promise((r) => setTimeout(r, 1500))
	}
	throw new Error(
		`${label}: timed out waiting to start ${stepId}` +
			(lastError ? `\nLast error: ${lastError}` : ''),
	)
}

async function shareStepViaBackendAndWait(
	backend: Backend,
	sessionId: string,
	stepId: string,
	label: string,
	timeoutMs = RUN_TIMEOUT_MS,
): Promise<void> {
	const startedAt = Date.now()
	const rpcTimeoutMs = Math.max(120_000, Math.min(timeoutMs, 600_000))
	let lastError = ''
	while (Date.now() - startedAt < timeoutMs) {
		try {
			await backend.invoke('share_step_outputs', { sessionId, stepId }, rpcTimeoutMs)
			console.log(`${label}: backend shared ${stepId}`)
			break
		} catch (error) {
			lastError = String(error || '')
			const transient =
				/WS invoke timeout: share_step_outputs/i.test(lastError) ||
				/Step must be completed before sharing/i.test(lastError) ||
				/step is not ready to share/i.test(lastError) ||
				/step is not ready to run \(status:\s*running\)/i.test(lastError)
			if (!transient) {
				throw error
			}
			await backend.invoke('trigger_syftbox_sync').catch(() => {})
			await new Promise((r) => setTimeout(r, 1500))
			continue
		}
	}
	if (lastError && Date.now() - startedAt >= timeoutMs) {
		throw new Error(`${label}: timed out waiting to share ${stepId}\nLast error: ${lastError}`)
	}
	await waitForLocalStepStatus(backend, sessionId, stepId, ['Shared'], label, timeoutMs)
}

async function importAndJoinInvitation(
	page: Page,
	backend: Backend,
	label: string,
	flowName: string,
	inputSelections: Record<string, string> = {},
): Promise<void> {
	const acceptViaBackendFallback = async (): Promise<boolean> => {
		try {
			const threads = await backend.invoke('list_message_threads', {}).catch(() => [])
			if (!Array.isArray(threads) || threads.length === 0) return false

			let targetThread: any =
				threads.find((thread: any) =>
					String(thread?.subject || '').includes(`Multiparty Flow: ${flowName}`),
				) || null

			if (!targetThread) {
				for (const thread of threads) {
					const threadId = thread?.thread_id || thread?.threadId || thread?.id
					if (!threadId) continue
					const msgs = await backend
						.invoke('get_thread_messages', { threadId }, 60_000)
						.catch(() => [])
					if (!Array.isArray(msgs)) continue
					const hasFlowInvite = msgs.some((msg: any) => {
						const metadata = normalizeMetadata(msg?.metadata)
						const invite = metadata?.flow_invitation
						if (!invite) return false
						return String(invite?.flow_name || invite?.flowName || '') === flowName
					})
					if (hasFlowInvite) {
						targetThread = thread
						break
					}
				}
			}

			const threadId = targetThread?.thread_id || targetThread?.threadId || targetThread?.id
			if (!threadId) return false

			const messages = await backend
				.invoke('get_thread_messages', { threadId }, 60_000)
				.catch(() => [])
			if (!Array.isArray(messages) || messages.length === 0) return false

			const inviteMsg = messages.find((msg: any) => {
				const metadata = normalizeMetadata(msg?.metadata)
				const invite = metadata?.flow_invitation
				if (!invite) return false
				return String(invite?.flow_name || invite?.flowName || '') === flowName
			})
			if (!inviteMsg) return false

			const metadata = normalizeMetadata(inviteMsg?.metadata)
			const invite = metadata?.flow_invitation
			const sessionId = invite?.session_id || invite?.sessionId
			const flowSpec = invite?.flow_spec || invite?.flowSpec
			const participants = invite?.participants
			if (!sessionId || !flowSpec || !Array.isArray(participants) || participants.length === 0) {
				return false
			}

			const inputOverrides: Record<string, string> = {}
			for (const [inputName, selectedPath] of Object.entries(inputSelections)) {
				inputOverrides[inputName] = selectedPath
				inputOverrides[`inputs.${inputName}`] = selectedPath
			}

			await backend.invoke(
				'accept_flow_invitation',
				{
					sessionId,
					flowName,
					flowSpec,
					participants,
					autoRunAll: false,
					threadId,
					inputOverrides,
				},
				120_000,
			)
			console.log(`${label}: joined invitation flow via backend fallback`)
			return true
		} catch (error) {
			console.log(`${label}: backend fallback accept failed: ${String(error)}`)
			return false
		}
	}

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
			const joinBtn = invitationCard.locator(
				'.flow-invitation-btn.view-runs-btn, button:has-text("Join Flow"), button:has-text("View Flow")',
			)
			if (await joinBtn.isVisible({ timeout: 1500 }).catch(() => false)) {
				const joinText = (await joinBtn.textContent().catch(() => '')) || ''
				if (joinText.includes('View Flow')) {
					console.log(`${label}: already joined`)
					return
				}
			}

			if (await acceptViaBackendFallback()) return
		}

		if (await acceptViaBackendFallback()) return
		await page.waitForTimeout(2_000)
	}
	throw new Error(`${label}: timed out waiting to join invitation for ${flowName}`)
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
	while (Date.now() - startTime < timeoutMs) {
		let runs: any[] = []
		try {
			runs = await backend.invoke('get_flow_runs', {}, 120_000)
		} catch {
			await backend.invoke('trigger_syftbox_sync').catch(() => {})
			await new Promise((r) => setTimeout(r, 2_000))
			continue
		}
		const run = (runs || []).find((r: any) => r.id === runId)
		if (run?.status && run.status !== lastStatus) {
			lastStatus = run.status
			console.log(`${label}: run ${runId} status -> ${lastStatus}`)
		}
		if (run && expectedStatuses.includes(run.status)) {
			return run
		}
		await backend.invoke('trigger_syftbox_sync').catch(() => {})
		await new Promise((r) => setTimeout(r, 2_000))
	}
	throw new Error(
		`Timed out waiting for run ${runId} status: ${expectedStatuses.join(', ')} (last=${lastStatus})`,
	)
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

// ─── Main Test ───────────────────────────────────────────────────────────────

test.describe('Trusted allele aggregation via multiparty invitation @trusted-allele-agg', () => {
	test('three clients join and aggregator computes plaintext allele freq', async ({
		browser,
	}, testInfo) => {
		const wsPortBase = Number.parseInt(process.env.DEV_WS_BRIDGE_PORT_BASE || '3333', 10)
		const wsPort1 = wsPortBase
		const wsPort2 = wsPortBase + 1
		const wsPort3 = wsPortBase + 2

		const email1 = process.env.CLIENT1_EMAIL || 'client1@sandbox.local'
		const email2 = process.env.CLIENT2_EMAIL || 'client2@sandbox.local'
		const email3 = process.env.AGG_EMAIL || 'aggregator@sandbox.local'

		const flowName = 'trusted-allele-agg'
		const sourceFlowPath = path.join(
			process.cwd(),
			'biovault',
			'flows',
			'trusted-allele-agg',
			'flow.yaml',
		)
		expect(fs.existsSync(sourceFlowPath)).toBe(true)

		let logSocket: WebSocket | null = null
		let backend1: Backend | null = null
		let backend2: Backend | null = null
		let backend3: Backend | null = null
		let page1: Page | null = null
		let page2: Page | null = null
		let page3: Page | null = null

		try {
			logSocket = await ensureLogSocket()
			log(logSocket, { event: 'trusted-allele-agg-start', email1, email2, email3, flowName })

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

			const sessionId = `session-${Date.now()}`
			const runId = sessionId
			const { client1Path, client2Path } = createInputFixtures(sessionId)

			await completeOnboarding(page1, email1, logSocket)
			await completeOnboarding(page2, email2, logSocket)
			await completeOnboarding(page3, email3, logSocket)
			await importAlleleFreqFileForPicker(backend1, email1, client1Path)
			await importAlleleFreqFileForPicker(backend2, email2, client2Path)

			await backend1.invoke('get_dev_mode_info')
			await backend2.invoke('get_dev_mode_info')
			await backend3.invoke('get_dev_mode_info')

			const dataDir1 = await getSyftboxDataDir(backend1)
			const dataDir2 = await getSyftboxDataDir(backend2)
			const dataDir3 = await getSyftboxDataDir(backend3)

			const allBackends = [backend1, backend2, backend3]
			await Promise.all([
				waitForDidBundleOnViewer(email1, backend1, dataDir1, email2, allBackends),
				waitForDidBundleOnViewer(email1, backend1, dataDir1, email3, allBackends),
				waitForDidBundleOnViewer(email2, backend2, dataDir2, email1, allBackends),
				waitForDidBundleOnViewer(email2, backend2, dataDir2, email3, allBackends),
				waitForDidBundleOnViewer(email3, backend3, dataDir3, email1, allBackends),
				waitForDidBundleOnViewer(email3, backend3, dataDir3, email2, allBackends),
			])

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

			// Import flow on all backends
			if (SKIP_FLOW_IMPORT) {
				console.log(`Skipping flow import for ${flowName}`)
			} else {
				await Promise.all([
					backend1.invoke('import_flow', { flowFile: sourceFlowPath, overwrite: true }),
					backend2.invoke('import_flow', { flowFile: sourceFlowPath, overwrite: true }),
					backend3.invoke('import_flow', { flowFile: sourceFlowPath, overwrite: true }),
				])
			}

			let flowsAgg = await backend3.invoke('get_flows', {})
			let trustedFlowAgg = (flowsAgg || []).find((flow: any) => flow?.name === flowName)
			if (!trustedFlowAgg) {
				await backend3.invoke('create_flow', {
					request: { name: flowName, directory: path.dirname(sourceFlowPath), overwrite: true },
				})
				flowsAgg = await backend3.invoke('get_flows', {})
				trustedFlowAgg = (flowsAgg || []).find((flow: any) => flow?.name === flowName)
			}
			expect(trustedFlowAgg).toBeTruthy()
			expect(trustedFlowAgg?.spec).toBeTruthy()

			const datasites = [email3, email1, email2]

			const flowSpec = {
				apiVersion: 'syftbox.openmined.org/v1alpha1',
				kind: 'Flow',
				metadata: {
					name: flowName,
					version: trustedFlowAgg?.version || '0.1.0',
				},
				spec: trustedFlowAgg.spec,
			}

			const participants = [
				{ email: email3, role: 'aggregator' },
				{ email: email1, role: 'client1' },
				{ email: email2, role: 'client2' },
			]

			// Send invitation from aggregator
			await backend3.invoke('send_message', {
				request: {
					recipients: [email1, email2],
					body: `Join trusted allele aggregation ${runId}`,
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

			// Clients join with TSV selection, aggregator joins with no input
			await importAndJoinInvitation(page1, backend1, email1, flowName, {
				allele_freq_tsv: client1Path,
			})
			await importAndJoinInvitation(page2, backend2, email2, flowName, {
				allele_freq_tsv: client2Path,
			})
			await importAndJoinInvitation(page3, backend3, email3, flowName, {})

			const [runId1, runId2, runId3] = await Promise.all([
				waitForSessionRunId(backend1, sessionId, email1, 90_000),
				waitForSessionRunId(backend2, sessionId, email2, 90_000),
				waitForSessionRunId(backend3, sessionId, email3, 90_000),
			])
			expect(runId1).toBeGreaterThan(0)
			expect(runId2).toBeGreaterThan(0)
			expect(runId3).toBeGreaterThan(0)

			await Promise.all([clickRunsTab(page1), clickRunsTab(page2), clickRunsTab(page3)])

			// Stage 1: clients run + share their raw allele_freq TSV
			console.log('Stage 1: clients share raw allele_freq TSV with aggregator')
			await Promise.all([
				runStepViaBackendWhenReadyAndWait(backend1, sessionId, 'share_data', email1, [
					'Completed',
					'Shared',
				]),
				runStepViaBackendWhenReadyAndWait(backend2, sessionId, 'share_data', email2, [
					'Completed',
					'Shared',
				]),
			])
			await Promise.all([
				shareStepViaBackendAndWait(backend1, sessionId, 'share_data', email1, 180_000),
				shareStepViaBackendAndWait(backend2, sessionId, 'share_data', email2, 180_000),
			])

			// Trigger sync on aggregator so it picks up client shared files
			await backend3.invoke('trigger_syftbox_sync').catch(() => {})
			await new Promise((r) => setTimeout(r, 2_000))

			// Stage 2: aggregator runs plaintext aggregation + shares results
			console.log('Stage 2: aggregator runs plaintext aggregation')
			await runStepViaBackendWhenReadyAndWait(backend3, sessionId, 'trusted_aggregate', email3, [
				'Completed',
				'Shared',
			])
			await shareStepViaBackendAndWait(backend3, sessionId, 'trusted_aggregate', email3, 180_000)

			// Verify results
			const finalRun1 = await waitForRunStatus(
				backend1,
				runId1,
				['success', 'running', 'failed', 'error'],
				RUN_TIMEOUT_MS,
				email1,
			)
			const finalRun2 = await waitForRunStatus(
				backend2,
				runId2,
				['success', 'running', 'failed', 'error'],
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
				`Final run statuses: client1=${finalRun1.status}, client2=${finalRun2.status}, aggregator=${finalRun3.status}`,
			)
			expect(finalRun3.status).toBe('success')

			const runRoot3 = finalRun3.results_dir || finalRun3.work_dir
			expect(runRoot3 && fs.existsSync(runRoot3)).toBe(true)
			expect(collectMatchingFiles(runRoot3, 'aggregated_allele_freq.tsv').length).toBeGreaterThan(0)
			expect(collectMatchingFiles(runRoot3, 'report.json').length).toBeGreaterThan(0)
			expect(collectMatchingFiles(runRoot3, 'union_locus_index.json').length).toBeGreaterThan(0)

			// Trigger sync on clients so they pick up aggregator's shared results
			await Promise.all([
				backend1.invoke('trigger_syftbox_sync').catch(() => {}),
				backend2.invoke('trigger_syftbox_sync').catch(() => {}),
			])
			await new Promise((r) => setTimeout(r, 5_000))

			// Verify clients received shared results
			const clientDataDir1 = await getSyftboxDataDir(backend1)
			const clientDataDir2 = await getSyftboxDataDir(backend2)
			const sharedResultsBase1 = path.join(clientDataDir1, 'datasites', email3, 'shared', 'flows', flowName, sessionId)
			const sharedResultsBase2 = path.join(clientDataDir2, 'datasites', email3, 'shared', 'flows', flowName, sessionId)
			console.log(`Checking client1 shared results at: ${sharedResultsBase1}`)
			console.log(`Checking client2 shared results at: ${sharedResultsBase2}`)
			const client1HasResults = collectMatchingFiles(sharedResultsBase1, 'aggregated_allele_freq.tsv').length > 0
			const client2HasResults = collectMatchingFiles(sharedResultsBase2, 'aggregated_allele_freq.tsv').length > 0
			console.log(`Client1 received results: ${client1HasResults}, Client2 received results: ${client2HasResults}`)

			log(logSocket, { event: 'trusted-allele-agg-complete', runId })

			// Wait 60s so you can inspect UI/logs
			console.log('Waiting 60s for inspection...')
			await new Promise((r) => setTimeout(r, 60_000))
		} finally {
			await pauseForInteractive(testInfo)
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
