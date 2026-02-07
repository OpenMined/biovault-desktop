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

async function clickMessagesTab(page: Page): Promise<void> {
	const navTab = page.locator('.nav-item[data-tab="messages"]').first()
	if (await navTab.isVisible().catch(() => false)) {
		await navTab.click()
		return
	}
	await page.locator('button:has-text("Messages")').first().click()
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
	while (Date.now() - startTime < timeoutMs) {
		const runs = await backend.invoke('get_flow_runs', {})
		const run = (runs || []).find((r: any) => r.id === runId)
		if (run?.status && run.status !== lastStatus) {
			lastStatus = run.status
			console.log(`${label}: run ${runId} status -> ${lastStatus}`)
		}
		if (run && expectedStatuses.includes(run.status)) {
			return run
		}
		await new Promise((r) => setTimeout(r, 2_000))
	}
	let logTail = ''
	try {
		logTail = String(
			(await backend.invoke('get_flow_run_logs_tail', { runId, lines: 200 })) || '',
		)
	} catch {
		// Ignore diagnostic failures and surface the timeout.
	}
	throw new Error(
		`Timed out waiting for run ${runId} status: ${expectedStatuses.join(', ')} (last=${lastStatus})` +
			(logTail ? `\nLast log tail:\n${logTail}` : ''),
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

function assertSharedRunDirExists(dataDir: string, ownerEmail: string, runId: string) {
	const datasitesRoot = resolveDatasitesRoot(dataDir)
	const runDir = path.join(datasitesRoot, ownerEmail, 'shared', 'flows', 'syqure-flow', runId)
	expect(fs.existsSync(runDir)).toBe(true)

	const hasProgressDir =
		fs.existsSync(path.join(runDir, '_progress')) || fs.existsSync(path.join(runDir, 'progress'))
	expect(hasProgressDir).toBe(true)
}

test.describe('Syqure flow via multiparty invitation system @syqure-multiparty-flow', () => {
	test('three clients join via invitation card and execute real syqure flow', async ({ browser }) => {
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

			// Pairwise contacts for encrypted invitation delivery.
				await backend1.invoke('network_import_contact', { identity: email2 })
				await backend1.invoke('network_import_contact', { identity: email3 })
				await backend2.invoke('network_import_contact', { identity: email1 })
				await backend2.invoke('network_import_contact', { identity: email3 })
				await backend3.invoke('network_import_contact', { identity: email1 })
				await backend3.invoke('network_import_contact', { identity: email2 })

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

			const runId = `syqure-ui-${Date.now()}`
			const datasites = [email3, email1, email2]
			const sessionId = `session-${Date.now()}`

			const flowSpec = {
				apiVersion: 'syftbox.openmined.org/v1alpha1',
				kind: 'Flow',
				metadata: {
					name: flowName,
					version: syqureFlowAgg?.version || '0.1.0',
				},
				spec: syqureFlowAgg.spec,
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

			const flows1 = await backend1.invoke('get_flows', {})
			const flows2 = await backend2.invoke('get_flows', {})
			const flows3 = await backend3.invoke('get_flows', {})
			const syqureFlow1 = (flows1 || []).find((flow: any) => flow?.name === flowName)
			const syqureFlow2 = (flows2 || []).find((flow: any) => flow?.name === flowName)
			const syqureFlow3 = (flows3 || []).find((flow: any) => flow?.name === flowName)
			expect(syqureFlow1).toBeTruthy()
			expect(syqureFlow2).toBeTruthy()
			expect(syqureFlow3).toBeTruthy()

			const [run1, run2, run3] = await Promise.all([
				backend1.invoke('run_flow', {
					flowId: syqureFlow1.id,
					inputOverrides: { 'inputs.datasites': datasites.join(',') },
					runId,
				}),
				backend2.invoke('run_flow', {
					flowId: syqureFlow2.id,
					inputOverrides: { 'inputs.datasites': datasites.join(',') },
					runId,
				}),
				backend3.invoke('run_flow', {
					flowId: syqureFlow3.id,
					inputOverrides: { 'inputs.datasites': datasites.join(',') },
					runId,
				}),
			])

			const runId1 = run1?.id
			const runId2 = run2?.id
			const runId3 = run3?.id
			expect(typeof runId1).toBe('number')
			expect(typeof runId2).toBe('number')
			expect(typeof runId3).toBe('number')

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
					`Final run statuses: client1=${finalRun1.status}, client2=${finalRun2.status}, aggregator=${finalRun3.status}`,
				)
				if (finalRun1.status !== 'success') {
					const failLogs1 = await backend1.invoke('get_flow_run_logs_tail', { runId: runId1, lines: 1200 })
					console.log(`client1 failed logs:\n${String(failLogs1 || '')}`)
				}
				if (finalRun2.status !== 'success') {
					const failLogs2 = await backend2.invoke('get_flow_run_logs_tail', { runId: runId2, lines: 1200 })
					console.log(`client2 failed logs:\n${String(failLogs2 || '')}`)
				}
				if (finalRun3.status !== 'success') {
					const failLogs3 = await backend3.invoke('get_flow_run_logs_tail', { runId: runId3, lines: 1200 })
					console.log(`aggregator failed logs:\n${String(failLogs3 || '')}`)
				}

				expect(finalRun1.status).toBe('success')
				expect(finalRun2.status).toBe('success')
				expect(finalRun3.status).toBe('success')

			const logs1 = await backend1.invoke('get_flow_run_logs_tail', { runId: runId1, lines: 400 })
			const logs2 = await backend2.invoke('get_flow_run_logs_tail', { runId: runId2, lines: 400 })
			const logs3 = await backend3.invoke('get_flow_run_logs_tail', { runId: runId3, lines: 400 })
			expect(String(logs1 || '')).toContain('secure_aggregate')
			expect(String(logs2 || '')).toContain('secure_aggregate')
			expect(String(logs3 || '')).toContain('secure_aggregate')

			const dataDir1 = await getSyftboxDataDir(backend1)
			const dataDir2 = await getSyftboxDataDir(backend2)
			const dataDir3 = await getSyftboxDataDir(backend3)
			assertSharedRunDirExists(dataDir1, email1, runId)
			assertSharedRunDirExists(dataDir2, email2, runId)
			assertSharedRunDirExists(dataDir3, email3, runId)

			const runRoot1 = finalRun1.results_dir || finalRun1.work_dir
			const runRoot2 = finalRun2.results_dir || finalRun2.work_dir
			const runRoot3 = finalRun3.results_dir || finalRun3.work_dir
			expect(collectMatchingFiles(runRoot1, 'aggregated_counts.json').length).toBeGreaterThan(0)
			expect(collectMatchingFiles(runRoot2, 'aggregated_counts.json').length).toBeGreaterThan(0)
			expect(collectMatchingFiles(runRoot3, 'aggregated_counts.json').length).toBeGreaterThan(0)

			log(logSocket, {
				event: 'syqure-multiparty-flow-complete',
				runId,
				runIds: [runId1, runId2, runId3],
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
