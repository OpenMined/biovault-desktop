/**
 * Syqure Multiparty Flow Test (Three Clients)
 * Uses the same invitation system as --pipelines-multiparty-flow, but executes
 * the real syqure flow from biovault/flows/multiparty-allele-freq/flow.yaml.
 *
 * Usage:
 *   ./test-scenario.sh --syqure-multiparty-allele-freq --interactive
 *
 * @tag syqure-multiparty-allele-freq
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
const ALLELE_FREQ_EXPECTED_FILES = Number.parseInt(process.env.ALLELE_FREQ_COUNT || '1', 10)

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
			const isDbLock = /database is locked/i.test(message)
			if (!isDbLock || attempt === maxAttempts) break
			await backend.invoke('trigger_syftbox_sync').catch(() => {})
			await new Promise((r) => setTimeout(r, 400 * attempt))
		}
	}
	throw lastError instanceof Error
		? lastError
		: new Error(String(lastError || 'send_message failed'))
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

async function importGeneratedAlleleFreqFiles(
	backend: Backend,
	label: string,
	expectedCount: number,
): Promise<void> {
	if (expectedCount <= 0) return
	const dataDir = await getSyftboxDataDir(backend)
	const datasitesRoot = resolveDatasitesRoot(dataDir)
	const homeDir = path.dirname(datasitesRoot)
	const genotypeDir = path.join(homeDir, 'private', 'app_data', 'biovault', 'allele-freq-data')
	const samplesheetPath = path.join(genotypeDir, 'samplesheet.csv')
	let files: string[] = []
	if (fs.existsSync(samplesheetPath)) {
		const rows = fs.readFileSync(samplesheetPath, 'utf8').split(/\r?\n/).filter(Boolean)
		files = rows
			.slice(1)
			.map((row) => row.split(',')[1]?.trim())
			.filter((filePath): filePath is string => Boolean(filePath))
	}
	if (files.length === 0) {
		const genotypesDir = path.join(genotypeDir, 'genotypes')
		if (fs.existsSync(genotypesDir)) {
			files = fs
				.readdirSync(genotypesDir, { withFileTypes: true })
				.filter((entry) => entry.isFile() && entry.name.endsWith('.txt'))
				.map((entry) => path.join(genotypesDir, entry.name))
		}
	}
	files.sort()
	const selected = files.slice(0, expectedCount)
	if (selected.length < expectedCount) {
		throw new Error(
			`${label}: expected ${expectedCount} genotype files in ${genotypeDir}, found ${selected.length}`,
		)
	}
	const fileMetadata = Object.fromEntries(
		selected.map((filePath, idx) => [
			filePath,
			{
				data_type: 'Genotype',
				source: '23andMe',
				grch_version: 'GRCh38',
				participant_id: `${label.replace(/[^a-z0-9]/gi, '_')}_${idx + 1}`,
			},
		]),
	)
	await backend.invoke('import_files_pending', { fileMetadata }, 120_000)
	console.log(`${label}: imported ${selected.length} generated genotype files`)
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

async function runStepViaBackendAndWait(
	backend: Backend,
	sessionId: string,
	stepId: string,
	label: string,
	expectedStatuses: string[],
	timeoutMs = RUN_TIMEOUT_MS,
): Promise<void> {
	const rpcTimeoutMs = Math.max(120_000, Math.min(timeoutMs, 600_000))
	try {
		await backend.invoke('run_flow_step', { sessionId, stepId }, rpcTimeoutMs)
		console.log(`${label}: backend started ${stepId}`)
	} catch (error) {
		const message = String(error || '')
		if (
			/WS invoke timeout: run_flow_step/i.test(message) ||
			/step is not ready to run \(status:\s*(completed|shared|running)\)/i.test(message)
		) {
			console.log(`${label}: backend run_flow_step transient for ${stepId}: ${message}`)
		} else {
			throw error
		}
	}
	await waitForLocalStepStatus(backend, sessionId, stepId, expectedStatuses, label, timeoutMs)
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
		/dependency .* not satisfied yet/i.test(message) ||
		/step is not ready to run \(status:\s*waitingforinputs\)/i.test(message) ||
		/step is not ready to run \(status:\s*waitingfordependencies\)/i.test(message) ||
		/step is not ready to run \(status:\s*failed\)/i.test(message) ||
		/Shell workflow exited with code/i.test(message) ||
		/WS invoke timeout: run_flow_step/i.test(message)
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
			// Common transients: dependency/input readiness lags while participants sync.
			if (!transientStartError(lastError)) {
				throw error
			}
		}
		await backend.invoke('trigger_syftbox_sync').catch(() => {})
		await new Promise((r) => setTimeout(r, 1500))
	}
	throw new Error(
		`${label}: timed out waiting to start ${stepId} after dependency checks` +
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
			console.log(`${label}: backend share_step_outputs transient for ${stepId}: ${lastError}`)
			await backend.invoke('trigger_syftbox_sync').catch(() => {})
			await new Promise((r) => setTimeout(r, 1500))
			continue
		}
	}
	if (lastError && Date.now() - startedAt >= timeoutMs) {
		throw new Error(`${label}: timed out waiting to share ${stepId}` + `\nLast error: ${lastError}`)
	}
	await waitForLocalStepStatus(backend, sessionId, stepId, ['Shared'], label, timeoutMs)
}

async function importAndJoinInvitation(
	page: Page,
	backend: Backend,
	label: string,
	flowName: string,
	genotypeFileCount = 0,
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
				const inputPicker = page.locator('.flow-input-picker-modal').first()
				let pickerVisible = false
				let alreadyJoined = false
				const waitStart = Date.now()
				while (Date.now() - waitStart < 20_000) {
					if (await inputPicker.isVisible().catch(() => false)) {
						pickerVisible = true
						break
					}
					const refreshedJoinText = (await joinBtn.textContent().catch(() => '')) || ''
					if (refreshedJoinText.includes('View Flow')) {
						alreadyJoined = true
						break
					}
					await page.waitForTimeout(300)
				}
				if (pickerVisible) {
					const genotypeRow = inputPicker
						.locator('.flow-input-picker-row')
						.filter({
							has: page.locator('.flow-input-picker-label', { hasText: 'genotype_files' }),
						})
						.first()
					const checkboxes = genotypeRow.locator('input.flow-input-picker-checkbox')
					const checkboxCount = await checkboxes.count()
					if (genotypeFileCount > 0 && checkboxCount > 0) {
						if (checkboxCount < genotypeFileCount) {
							throw new Error(
								`${label}: expected at least ${genotypeFileCount} genotype files in picker, found ${checkboxCount}`,
							)
						}
						// Fast-path: use row-level "Select all visible" when present.
						const selectAllVisible = genotypeRow
							.locator('input.flow-input-picker-select-all')
							.first()
						if (await selectAllVisible.isVisible().catch(() => false)) {
							await selectAllVisible.check()
						}
						let checkedCount = await checkboxes
							.evaluateAll(
								(nodes) => nodes.filter((node) => (node as HTMLInputElement).checked).length,
							)
							.catch(() => 0)
						for (
							let idx = checkedCount;
							idx < genotypeFileCount;
							idx += 1 // fallback for cases where not all were visible
						) {
							await checkboxes.nth(idx).check()
						}
						checkedCount = await checkboxes
							.evaluateAll(
								(nodes) => nodes.filter((node) => (node as HTMLInputElement).checked).length,
							)
							.catch(() => 0)
						if (checkedCount < genotypeFileCount) {
							throw new Error(
								`${label}: selected ${checkedCount}/${genotypeFileCount} genotype files before Continue`,
							)
						}
					} else {
						const select = genotypeRow.locator('select.flow-input-picker-select').first()
						if (genotypeFileCount > 0 && (await select.isVisible().catch(() => false))) {
							const allValues = await select.evaluate((node) => {
								const options = Array.from((node as HTMLSelectElement).options)
								return options.map((option) => option.value).filter(Boolean)
							})
							if (allValues.length < genotypeFileCount) {
								throw new Error(
									`${label}: expected at least ${genotypeFileCount} genotype files in picker, found ${allValues.length}`,
								)
							}
							const picked = allValues.slice(0, genotypeFileCount)
							await select.evaluate((node, values) => {
								const wanted = new Set(values)
								const input = node as HTMLSelectElement
								for (const option of Array.from(input.options)) {
									option.selected = wanted.has(option.value)
								}
								input.dispatchEvent(new Event('change', { bubbles: true }))
							}, picked)
						}
					}
					const continueBtn = inputPicker.locator('button.flow-input-picker-confirm').first()
					await expect(continueBtn).toBeVisible({ timeout: 15_000 })
					await expect(continueBtn).toBeEnabled({ timeout: 15_000 })
					let submitted = false
					for (let attempt = 0; attempt < 4; attempt += 1) {
						await continueBtn.click({ force: true })
						const closed = await inputPicker.isHidden({ timeout: 5_000 }).catch(() => false)
						if (closed) {
							submitted = true
							break
						}
						await page.waitForTimeout(500)
					}
					if (!submitted) {
						throw new Error(
							`${label}: configure-flow input modal did not close after pressing Continue`,
						)
					}
				} else {
					if (genotypeFileCount > 0) {
						throw new Error(
							`${label}: Configure flow inputs modal did not appear for genotype participant`,
						)
					}
					if (!alreadyJoined) {
						throw new Error(
							`${label}: Configure flow inputs modal did not appear after clicking Join Flow`,
						)
					}
				}
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
			console.log(`${label}: run ${runId} status -> ${lastStatus}`)
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

function assertSharedRunDirExists(
	dataDir: string,
	ownerEmail: string,
	flowName: string,
	runId: string,
) {
	const datasitesRoot = resolveDatasitesRoot(dataDir)
	const runDir = path.join(datasitesRoot, ownerEmail, 'shared', 'flows', flowName, runId)
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

async function assertBuildMasterOutputsNonEmpty(
	participantDataDirs: Map<string, string>,
	aggregatorEmail: string,
	flowName: string,
	runId: string,
	timeoutMs = 90_000,
): Promise<void> {
	const aggregatorDataDir = participantDataDirs.get(aggregatorEmail)
	if (!aggregatorDataDir) {
		throw new Error(`Missing data dir for aggregator ${aggregatorEmail}`)
	}
	const runDir = getSharedRunDir(aggregatorDataDir, aggregatorEmail, flowName, runId)
	const stepId = 'build_master'
	const stepNumber = 3

	await waitForCondition(
		() => {
			const stepDir = findExistingSharedStepDir(runDir, stepNumber, stepId)
			if (!stepDir) return false
			const unionPath = path.join(stepDir, 'union_locus_index.json')
			const countPath = path.join(stepDir, 'count.txt')
			if (!fs.existsSync(unionPath) || !fs.existsSync(countPath)) return false
			try {
				const union = JSON.parse(fs.readFileSync(unionPath, 'utf8'))
				const loci = Array.isArray(union?.loci) ? union.loci.length : 0
				const nLoci = Number(union?.n_loci || 0)
				const countRaw = fs.readFileSync(countPath, 'utf8').trim()
				const count = Number.parseInt(countRaw || '0', 10)
				return (
					Number.isFinite(nLoci) && nLoci > 0 && loci > 0 && Number.isFinite(count) && count > 0
				)
			} catch {
				return false
			}
		},
		`build_master produced non-empty union index and count for ${aggregatorEmail}`,
		timeoutMs,
		1200,
	)

	const stepDir = findExistingSharedStepDir(runDir, stepNumber, stepId)
	if (!stepDir) {
		throw new Error(`Missing build_master step directory in ${runDir}`)
	}
	const unionPath = path.join(stepDir, 'union_locus_index.json')
	const countPath = path.join(stepDir, 'count.txt')
	const unionRaw = fs.existsSync(unionPath) ? fs.readFileSync(unionPath, 'utf8') : '<missing>'
	const countRaw = fs.existsSync(countPath) ? fs.readFileSync(countPath, 'utf8') : '<missing>'
	const union = JSON.parse(unionRaw)
	const loci = Array.isArray(union?.loci) ? union.loci.length : 0
	const nLoci = Number(union?.n_loci || 0)
	const count = Number.parseInt(String(countRaw).trim() || '0', 10)
	expect(nLoci).toBeGreaterThan(0)
	expect(loci).toBeGreaterThan(0)
	expect(count).toBeGreaterThan(0)
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

test.describe('Syqure flow via multiparty invitation system @syqure-multiparty-allele-freq', () => {
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

		const flowName = 'multiparty-allele-freq'
		const sourceFlowPath = path.join(
			process.cwd(),
			'biovault',
			'flows',
			'multiparty-allele-freq',
			'flow.yaml',
		)
		expect(fs.existsSync(sourceFlowPath)).toBe(true)

		const alleleFreqPipelinePath = path.join(
			process.cwd(),
			'biovault',
			'flows',
			'allele-freq',
			'flow.yaml',
		)
		expect(fs.existsSync(alleleFreqPipelinePath)).toBe(true)

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
				event: 'syqure-multiparty-allele-freq-start',
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
			await importGeneratedAlleleFreqFiles(backend1, email1, ALLELE_FREQ_EXPECTED_FILES)
			await importGeneratedAlleleFreqFiles(backend2, email2, ALLELE_FREQ_EXPECTED_FILES)

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

			// Import both the syqure multiparty flow and the standalone allele-freq
			// pipeline (used by gen_allele_freq module's run.sh via `bv run`).
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
				backend1.invoke('import_flow', {
					flowFile: alleleFreqPipelinePath,
					overwrite: true,
				}),
				backend2.invoke('import_flow', {
					flowFile: alleleFreqPipelinePath,
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

			await importAndJoinInvitation(page1, backend1, email1, flowName, ALLELE_FREQ_EXPECTED_FILES)
			await importAndJoinInvitation(page2, backend2, email2, flowName, ALLELE_FREQ_EXPECTED_FILES)
			await importAndJoinInvitation(page3, backend3, email3, flowName, 0)

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

			// Stage 1: clients run gen_allele_freq (local-only output).
			// Use backend invocation to avoid flaky UI click timing around step enablement.
			await Promise.all([
				runStepViaBackendWhenReadyAndWait(backend1, sessionId, 'gen_allele_freq', email1, [
					'Completed',
					'Shared',
				]),
				runStepViaBackendWhenReadyAndWait(backend2, sessionId, 'gen_allele_freq', email2, [
					'Completed',
					'Shared',
				]),
			])

			// Stage 1b: clients share only locus_index derived artifact.
			await Promise.all([
				runStepViaBackendWhenReadyAndWait(backend1, sessionId, 'share_locus_index', email1, [
					'Completed',
					'Shared',
				]),
				runStepViaBackendWhenReadyAndWait(backend2, sessionId, 'share_locus_index', email2, [
					'Completed',
					'Shared',
				]),
			])
			await Promise.all([
				shareStepViaBackendAndWait(backend1, sessionId, 'share_locus_index', email1, 180_000),
				shareStepViaBackendAndWait(backend2, sessionId, 'share_locus_index', email2, 180_000),
			])
			// Ensure aggregator can actually see both shared locus-index artifacts before build_master.
			await waitForSharedFileOnViewers(
				participantDataDirs,
				email1,
				flowName,
				runId,
				2,
				'share_locus_index',
				'locus_index.tsv',
				[email3],
			)
			await waitForSharedFileOnViewers(
				participantDataDirs,
				email2,
				flowName,
				runId,
				2,
				'share_locus_index',
				'locus_index.tsv',
				[email3],
			)

			// Stage 2: aggregator run + share build_master.
			// Use backend invocation to avoid flaky UI click timing around step enablement.
			await runStepViaBackendWhenReadyAndWait(backend3, sessionId, 'build_master', email3, [
				'Completed',
				'Shared',
			])
			await shareStepViaBackendAndWait(backend3, sessionId, 'build_master', email3, 180_000)
			await assertBuildMasterOutputsNonEmpty(participantDataDirs, email3, flowName, runId)

			// Stage 3: clients run align_counts.
			await Promise.all([
				runStepViaBackendWhenReadyAndWait(backend1, sessionId, 'align_counts', email1, [
					'Completed',
					'Shared',
				]),
				runStepViaBackendWhenReadyAndWait(backend2, sessionId, 'align_counts', email2, [
					'Completed',
					'Shared',
				]),
			])

			// Stage 3b: run explicit barrier after align_counts so downstream deps converge.
			await Promise.all([
				runStepViaBackendWhenReadyAndWait(backend1, sessionId, 'mpc_barrier', email1, [
					'Completed',
					'Shared',
				]),
				runStepViaBackendWhenReadyAndWait(backend2, sessionId, 'mpc_barrier', email2, [
					'Completed',
					'Shared',
				]),
			])

			// Stage 4: run secure_aggregate via backend commands.
			// This avoids flaky UI actions when get_multiparty_flow_state polling is slow.
			await Promise.all([
				runStepViaBackendWhenReadyAndWait(
					backend1,
					sessionId,
					'secure_aggregate',
					email1,
					['Running', 'Completed', 'Shared'],
					RUN_TIMEOUT_MS,
				),
				runStepViaBackendWhenReadyAndWait(
					backend2,
					sessionId,
					'secure_aggregate',
					email2,
					['Running', 'Completed', 'Shared'],
					RUN_TIMEOUT_MS,
				),
				runStepViaBackendWhenReadyAndWait(
					backend3,
					sessionId,
					'secure_aggregate',
					email3,
					['Running', 'Completed', 'Shared'],
					RUN_TIMEOUT_MS,
				),
			])

			// Stage 4b: all parties share secure_aggregate outputs via backend commands.
			await Promise.all([
				shareStepViaBackendAndWait(backend1, sessionId, 'secure_aggregate', email1, RUN_TIMEOUT_MS),
				shareStepViaBackendAndWait(backend2, sessionId, 'secure_aggregate', email2, RUN_TIMEOUT_MS),
				shareStepViaBackendAndWait(backend3, sessionId, 'secure_aggregate', email3, RUN_TIMEOUT_MS),
			])

			// Stage 5: clients run report_aggregate.
			// Use retrying backend start since this step can race after secure_aggregate share.
			await Promise.all([
				runStepViaBackendWhenReadyAndWait(backend1, sessionId, 'report_aggregate', email1, [
					'Completed',
					'Shared',
				]),
				runStepViaBackendWhenReadyAndWait(backend2, sessionId, 'report_aggregate', email2, [
					'Completed',
					'Shared',
				]),
			])

			assertSharedRunDirExists(dataDir1, email1, flowName, runId)
			assertSharedRunDirExists(dataDir2, email2, flowName, runId)
			assertSharedRunDirExists(dataDir3, email3, flowName, runId)

			// Verify each participant can observe converged step statuses from all parties.
			const viewers = [
				{ label: email1, backend: backend1 },
				{ label: email2, backend: backend2 },
				{ label: email3, backend: backend3 },
			]
			await waitForProgressConvergence(viewers, sessionId, [
				{ email: email1, stepId: 'gen_allele_freq', statuses: ['Completed'] },
				{ email: email2, stepId: 'gen_allele_freq', statuses: ['Completed'] },
				{ email: email1, stepId: 'share_locus_index', statuses: ['Shared', 'Completed'] },
				{ email: email2, stepId: 'share_locus_index', statuses: ['Shared', 'Completed'] },
				{ email: email3, stepId: 'build_master', statuses: ['Shared', 'Completed'] },
				{ email: email1, stepId: 'align_counts', statuses: ['Completed', 'Shared'] },
				{ email: email2, stepId: 'align_counts', statuses: ['Completed', 'Shared'] },
				{ email: email1, stepId: 'secure_aggregate', statuses: ['Shared', 'Completed'] },
				{ email: email2, stepId: 'secure_aggregate', statuses: ['Shared', 'Completed'] },
				{ email: email1, stepId: 'report_aggregate', statuses: ['Completed', 'Shared'] },
				{ email: email2, stepId: 'report_aggregate', statuses: ['Completed', 'Shared'] },
			])

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
				['success', 'running', 'failed', 'error'],
				RUN_TIMEOUT_MS,
				email3,
			)
			console.log(
				`Final run statuses: client1=${finalRun1.status}, client2=${finalRun2.status}, aggregator=${finalRun3.status}`,
			)
			expect(finalRun1.status).toBe('success')
			expect(finalRun2.status).toBe('success')
			// In this flow topology the aggregator may remain "running" after secure_aggregate
			// has been shared while client-only report steps complete.
			expect(['success', 'running']).toContain(finalRun3.status)

			const runRoot1 = finalRun1.results_dir || finalRun1.work_dir
			const runRoot2 = finalRun2.results_dir || finalRun2.work_dir
			expect(runRoot1 && fs.existsSync(runRoot1)).toBe(true)
			expect(runRoot2 && fs.existsSync(runRoot2)).toBe(true)
			expect(collectMatchingFiles(runRoot1, 'report.json').length).toBeGreaterThan(0)
			expect(collectMatchingFiles(runRoot1, 'report.tsv').length).toBeGreaterThan(0)
			expect(collectMatchingFiles(runRoot1, 'aggregated_allele_freq.tsv').length).toBeGreaterThan(0)
			expect(collectMatchingFiles(runRoot2, 'report.json').length).toBeGreaterThan(0)
			expect(collectMatchingFiles(runRoot2, 'report.tsv').length).toBeGreaterThan(0)
			expect(collectMatchingFiles(runRoot2, 'aggregated_allele_freq.tsv').length).toBeGreaterThan(0)

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

			// Stage 1 share: clients share locus index with aggregator (no raw allele_freq sharing).
			await waitForSharedFileOnViewers(
				participantDataDirs,
				email1,
				flowName,
				runId,
				2,
				'share_locus_index',
				'locus_index.tsv',
				[email1, email3],
			)
			await waitForSharedFileOnViewers(
				participantDataDirs,
				email2,
				flowName,
				runId,
				2,
				'share_locus_index',
				'locus_index.tsv',
				[email2, email3],
			)

			// Stage 2 share: aggregator shares master list with all.
			await waitForSharedFileOnViewers(
				participantDataDirs,
				email3,
				flowName,
				runId,
				3,
				'build_master',
				'union_locus_index.json',
				[email1, email2, email3],
			)

			// Final secure share: clients share secure_aggregate output back to all.
			for (const ownerEmail of [email1, email2]) {
				await waitForSharedFileOnViewers(
					participantDataDirs,
					ownerEmail,
					flowName,
					runId,
					6,
					'secure_aggregate',
					'aggregated_counts.json',
					[email1, email2, email3],
				)
			}

			// Verify secure share permissions include all participants on each client output.
			for (const ownerEmail of [email1, email2]) {
				const ownerRunDir = getSharedRunDir(
					participantDataDirs.get(ownerEmail)!,
					ownerEmail,
					flowName,
					runId,
				)
				const secureDir = findExistingSharedStepDir(ownerRunDir, 6, 'secure_aggregate')
				expect(secureDir).toBeTruthy()
				const syftPubPath = path.join(secureDir!, 'syft.pub.yaml')
				expect(fs.existsSync(syftPubPath)).toBe(true)
				const syftPub = fs.readFileSync(syftPubPath, 'utf8')
				expect(syftPub).toContain(`- ${email1}`)
				expect(syftPub).toContain(`- ${email2}`)
				expect(syftPub).toContain(`- ${email3}`)
			}

			for (const ownerEmail of [email1, email2]) {
				for (const viewerEmail of [email1, email2, email3]) {
					const viewerDataDir = participantDataDirs.get(viewerEmail)!
					const ownerRunDir = getSharedRunDir(viewerDataDir, ownerEmail, flowName, runId)
					const secureDir = findExistingSharedStepDir(ownerRunDir, 6, 'secure_aggregate')
					expect(secureDir).toBeTruthy()
					const aggregatedPath = path.join(secureDir!, 'aggregated_counts.json')
					expect(fs.existsSync(aggregatedPath)).toBe(true)
				}
			}

			log(logSocket, {
				event: 'syqure-multiparty-allele-freq-complete',
				runId,
			})
		} finally {
			if (process.env.WAIT_MODE === '1') {
				const waitSec = 60
				console.log(`\n--- Wait mode: keeping apps open for ${waitSec}s before closing ---`)
				await new Promise((r) => setTimeout(r, waitSec * 1000))
			}

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
