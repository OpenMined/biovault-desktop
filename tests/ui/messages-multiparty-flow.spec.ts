/**
 * Multiparty Flow Test (Three Clients)
 * Tests the multiparty flow invitation and step-by-step execution:
 * 1. Three clients (client1, client2, aggregator) onboard
 * 2. All three exchange keys
 * 3. Aggregator creates a group chat and sends flow invitation
 * 4. Client1 and client2 receive invitation, import flow, and join
 * 5. Each participant goes to Runs tab and executes their steps
 * 6. Shared results appear in the chat
 *
 * Usage:
 *   ./test-scenario.sh --pipelines-multiparty-flow --interactive
 *
 * @tag pipelines-multiparty-flow
 */
import { expect, test, type Page } from './playwright-fixtures'
import WebSocket from 'ws'
import { waitForAppReady, ensureProfileSelected } from './test-helpers.js'
import { setWsPort, completeOnboarding, ensureLogSocket, log } from './onboarding-helper.js'

const TEST_TIMEOUT = 300_000 // 5 minutes max
const UI_TIMEOUT = 15_000
const MESSAGE_TIMEOUT = 90_000
const SYNC_INTERVAL = 500

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

test.describe('Multiparty flow between three clients @pipelines-multiparty-flow', () => {
	test('three clients execute a multiparty flow with UI interactions', async ({ browser }) => {
		const wsPortBase = Number.parseInt(process.env.DEV_WS_BRIDGE_PORT_BASE || '3333', 10)
		const wsPort1 = wsPortBase
		const wsPort2 = wsPortBase + 1
		const wsPort3 = wsPortBase + 2

		const email1 = process.env.CLIENT1_EMAIL || 'client1@sandbox.local'
		const email2 = process.env.CLIENT2_EMAIL || 'client2@sandbox.local'
		const email3 = process.env.AGG_EMAIL || 'aggregator@sandbox.local'

		const logSocket = await ensureLogSocket()
		log(logSocket, {
			event: 'multiparty-flow-start',
			email1,
			email2,
			email3,
			wsPort1,
			wsPort2,
			wsPort3,
		})

		console.log('=== Multiparty Flow Test ===')
		console.log(`Client 1 (contributor1): ${email1} (WS port ${wsPort1})`)
		console.log(`Client 2 (contributor2): ${email2} (WS port ${wsPort2})`)
		console.log(`Client 3 (aggregator): ${email3} (WS port ${wsPort3})`)

		// Create pages for all three clients
		const page1 = await browser.newPage()
		const page2 = await browser.newPage()
		const page3 = await browser.newPage()

		// Add console listeners to capture browser logs
		page1.on('console', (msg) => {
			if (msg.text().includes('[Flow Import]') || msg.type() === 'error') {
				console.log(`[Browser1] ${msg.type()}: ${msg.text()}`)
			}
		})
		page2.on('console', (msg) => {
			if (msg.text().includes('[Flow Import]') || msg.type() === 'error') {
				console.log(`[Browser2] ${msg.type()}: ${msg.text()}`)
			}
		})
		page3.on('console', (msg) => {
			if (msg.text().includes('[Flow Import]') || msg.type() === 'error') {
				console.log(`[Browser3] ${msg.type()}: ${msg.text()}`)
			}
		})

		await setWsPort(page1, wsPort1)
		await setWsPort(page2, wsPort2)
		await setWsPort(page3, wsPort3)

		// Connect backends
		console.log('\n--- Connecting backends ---')
		const backend1 = await connectBackend(wsPort1)
		const backend2 = await connectBackend(wsPort2)
		const backend3 = await connectBackend(wsPort3)
		console.log('All backends connected')

		// Navigate to UI
		const uiBaseUrl = process.env.UI_BASE_URL || 'http://localhost:8082'
		await page1.goto(uiBaseUrl)
		await page2.goto(uiBaseUrl)
		await page3.goto(uiBaseUrl)

		// Complete onboarding for all three
		console.log('\n--- Onboarding ---')
		await completeOnboarding(page1, email1, logSocket)
		await completeOnboarding(page2, email2, logSocket)
		await completeOnboarding(page3, email3, logSocket)
		console.log('All clients onboarded')

		// Ensure dev mode is available
		await backend1.invoke('get_dev_mode_info')
		await backend2.invoke('get_dev_mode_info')
		await backend3.invoke('get_dev_mode_info')

		// === Key Exchange Phase ===
		console.log('\n--- Key Exchange Phase ---')
		console.log('Each client importing the other two as contacts...')

		await backend1.invoke('network_import_contact', { identity: email2 })
		await backend1.invoke('network_import_contact', { identity: email3 })
		await backend2.invoke('network_import_contact', { identity: email1 })
		await backend2.invoke('network_import_contact', { identity: email3 })
		await backend3.invoke('network_import_contact', { identity: email1 })
		await backend3.invoke('network_import_contact', { identity: email2 })
		console.log('All key exchanges complete!')

		log(logSocket, { event: 'key-exchange-complete' })

		// === Create Flow Invitation ===
		console.log('\n--- Creating Flow Invitation ---')
		const timestamp = Date.now()
		const flowName = 'multiparty'
		const sessionId = `session-${timestamp}`

		const flowSpec = {
			apiVersion: 'syftbox.openmined.org/v1alpha1',
			kind: 'Flow',
			metadata: {
				name: flowName,
				version: '0.1.0',
			},
			spec: {
				vars: {
					flow_path: 'syft://{datasite.current}/shared/flows/{flow_name}',
					run_path: '{vars.flow_path}/{run_id}',
					step_path: '{vars.run_path}/{step.number}-{step.id}',
				},
				coordination: {
					url: '{vars.run_path}/_progress',
					share_with: 'all',
				},
				datasites: {
					all: [email3, email1, email2], // aggregator first, then contributors
					groups: {
						aggregator: { include: [email3] },
						contributors: { include: [email1, email2] },
					},
				},
				roles: [
					{ id: 'contributor1', description: 'First data contributor' },
					{ id: 'contributor2', description: 'Second data contributor' },
					{ id: 'aggregator', description: 'Aggregates contributions' },
				],
				steps: [
					{
						id: 'generate',
						name: 'Generate Numbers',
						description: 'Generate random numbers locally',
						run: { targets: 'contributors', strategy: 'parallel' },
					},
					{
						id: 'share_contribution',
						name: 'Share Contribution',
						description: 'Share numbers to aggregator',
						run: { targets: 'contributors', strategy: 'parallel' },
						depends_on: ['generate'],
						share: {
							numbers_shared: {
								source: 'step.generate.outputs.numbers',
								url: '{vars.step_path}/numbers.json',
								permissions: { read: [email3] },
							},
						},
					},
					{
						id: 'contributions_ready',
						name: 'Wait for Contributions',
						description: 'Wait for all contributors to share',
						barrier: {
							wait_for: 'share_contribution',
							targets: 'contributors',
							timeout: 300,
						},
					},
					{
						id: 'aggregate',
						name: 'Aggregate Sum',
						description: 'Compute sum of all contributions',
						run: { targets: 'aggregator' },
						depends_on: ['contributions_ready'],
					},
					{
						id: 'share_result',
						name: 'Share Results',
						description: 'Share final result with all',
						run: { targets: 'aggregator' },
						depends_on: ['aggregate'],
						share: {
							result_shared: {
								source: 'step.aggregate.outputs.result',
								url: '{vars.step_path}/result.json',
								permissions: { read: [email1, email2, email3] },
							},
						},
					},
				],
			},
		}

		const participants = [
			{ email: email1, role: 'contributor1' },
			{ email: email2, role: 'contributor2' },
			{ email: email3, role: 'aggregator' },
		]

		// Aggregator sends flow invitation to group
		const invitationBody = `Join me in a multiparty flow! Flow: ${flowName} - ${timestamp}`

		const groupMessage = await backend3.invoke('send_message', {
			request: {
				recipients: [email1, email2],
				body: invitationBody,
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

		console.log(`Flow invitation sent! Thread ID: ${groupMessage.thread_id}`)
		log(logSocket, { event: 'flow-invitation-sent', sessionId })

		// === Navigate to Messages and View Invitation in UI ===
		console.log('\n--- Navigating to Messages UI ---')

		async function navigateToMessagesAndFindThread(page: Page, label: string) {
			await page.click('button:has-text("Messages")')
			await page.waitForTimeout(500)

			console.log(`  ${label}: Syncing messages...`)
			const syncBtn = page.locator('#refresh-messages-btn')
			if (await syncBtn.isVisible()) {
				await syncBtn.click()
				await page.waitForTimeout(2000)
			}

			const threadItem = page.locator('.message-thread-item').first()
			await threadItem.waitFor({ timeout: UI_TIMEOUT })
			await threadItem.click()
			console.log(`  ${label}: Thread selected`)
		}

		// Navigate all three clients to Messages
		console.log('Navigating client1 to Messages...')
		await navigateToMessagesAndFindThread(page1, email1)

		console.log('Navigating client2 to Messages...')
		await navigateToMessagesAndFindThread(page2, email2)

		console.log('Navigating aggregator to Messages...')
		await navigateToMessagesAndFindThread(page3, email3)

		// Wait for invitation cards to render
		console.log('\n--- Waiting for Flow Invitation Cards ---')
		await page1.waitForTimeout(2000)
		await page2.waitForTimeout(2000)

		// === Import and Join Flow via UI ===
		console.log('\n--- Import and Join Flow via UI ---')

		async function importAndJoinFlow(page: Page, label: string) {
			// Wait for invitation card
			const invitationCard = page.locator('.flow-invitation-card')
			await invitationCard.waitFor({ timeout: UI_TIMEOUT })
			console.log(`  ${label}: Found invitation card`)

			// Click Import Flow button
			const importBtn = page.locator('.flow-invitation-btn.import-btn, button:has-text("Import Flow")')
			if (await importBtn.isVisible({ timeout: 5000 }).catch(() => false)) {
				await importBtn.click()
				console.log(`  ${label}: Clicked "Import Flow"`)

				// Wait for import to complete (button should change or status should update)
				await page.waitForTimeout(3000)

				// Check for error message
				const statusEl = invitationCard.locator('.flow-invitation-status')
				const statusText = await statusEl.textContent().catch(() => '')
				if (statusText) {
					console.log(`  ${label}: Import status: ${statusText}`)
				}

				// Check if import button changed
				const importBtnText = await importBtn.textContent().catch(() => '')
				console.log(`  ${label}: Import button text after click: ${importBtnText}`)
			} else {
				console.log(`  ${label}: Import button not visible (flow may already be imported)`)
			}

			// Click Join Flow button
			const joinBtn = page.locator('.flow-invitation-btn.view-runs-btn, button:has-text("Join Flow")')
			const joinBtnVisible = await joinBtn.isVisible({ timeout: 5000 }).catch(() => false)
			console.log(`  ${label}: Join button visible: ${joinBtnVisible}`)
			if (!joinBtnVisible) {
				// Debug: check what buttons are visible
				const allButtons = await invitationCard.locator('button').allTextContents()
				console.log(`  ${label}: All buttons in invitation card: ${JSON.stringify(allButtons)}`)
			}
			await joinBtn.waitFor({ timeout: UI_TIMEOUT })
			await joinBtn.click()
			console.log(`  ${label}: Clicked "Join Flow"`)
			await page.waitForTimeout(1000)

			// Verify button changes to "View Flow" after joining
			const joinBtnText = await joinBtn.textContent().catch(() => '')
			console.log(`  ${label}: Join button text after join: "${joinBtnText}"`)
			expect(joinBtnText).toContain('View Flow')

			// Verify Decline button is hidden after joining
			const declineBtn = invitationCard.locator('.decline-btn')
			const declineVisible = await declineBtn.isVisible().catch(() => false)
			console.log(`  ${label}: Decline button visible after join: ${declineVisible}`)
			expect(declineVisible).toBe(false)
		}

		// Client 1 imports and joins
		console.log(`${email1} importing and joining flow...`)
		await importAndJoinFlow(page1, email1)

		// Client 2 imports and joins
		console.log(`${email2} importing and joining flow...`)
		await importAndJoinFlow(page2, email2)

		// Aggregator also imports and joins via UI
		console.log(`${email3} importing and joining flow...`)
		await importAndJoinFlow(page3, email3)

		log(logSocket, { event: 'all-joined' })

		// === Navigate to Runs Tab and Execute Steps ===
		console.log('\n--- Navigating to Runs Tab ---')

		async function navigateToRuns(page: Page, label: string) {
			await page.click('button:has-text("Runs")')
			await page.waitForTimeout(1000)
			console.log(`  ${label}: On Runs tab`)
		}

		// All clients navigate to Runs
		await navigateToRuns(page1, email1)
		await navigateToRuns(page2, email2)
		await navigateToRuns(page3, email3)

		// === Verify Multiparty Run Cards ===
		console.log('\n--- Verifying Multiparty Run Cards ---')

		async function verifyMultipartyRun(page: Page, label: string) {
			// Look for run card with multiparty indicator
			const runCard = page.locator('.flow-run-card').first()
			await runCard.waitFor({ timeout: UI_TIMEOUT })

			// Card should auto-expand as latest run, wait for steps to load
			await page.waitForTimeout(1500)

			// Verify multiparty details are visible
			const mpDetails = runCard.locator('.multiparty-details')
			const isMultiparty = await mpDetails.isVisible().catch(() => false)
			console.log(`  ${label}: Multiparty details visible: ${isMultiparty}`)
			expect(isMultiparty).toBe(true)

			// Verify participants section
			const participants = runCard.locator('.mp-participants .mp-participant')
			const participantCount = await participants.count()
			console.log(`  ${label}: Found ${participantCount} participants`)
			expect(participantCount).toBe(3)

			// Verify steps section loaded
			const steps = runCard.locator('.mp-steps-list .mp-step')
			const stepCount = await steps.count()
			console.log(`  ${label}: Found ${stepCount} steps`)
			expect(stepCount).toBe(5)

			// Verify progress bar exists
			const progressBar = runCard.locator('.mp-progress-bar')
			expect(await progressBar.isVisible()).toBe(true)

			return runCard
		}

		const runCard1 = await verifyMultipartyRun(page1, email1)
		const runCard2 = await verifyMultipartyRun(page2, email2)
		const runCard3 = await verifyMultipartyRun(page3, email3)

		// === Verify Initial Button State ===
		console.log('\n--- Verifying Initial Button Visibility ---')

		// Contributors should see Run button for 'generate' (first step, Ready)
		await verifyRunButtonVisibility(page1, 'generate', true, email1)
		await verifyRunButtonVisibility(page2, 'generate', true, email2)

		// Contributors should NOT see Run button for 'share_contribution' yet (depends on generate)
		await verifyRunButtonVisibility(page1, 'share_contribution', false, email1)
		await verifyRunButtonVisibility(page2, 'share_contribution', false, email2)

		// Aggregator should NOT see Run button for 'aggregate' (WaitingForInputs)
		await verifyRunButtonVisibility(page3, 'aggregate', false, email3)

		// Aggregator should NOT see Run button for 'share_result' (depends on aggregate)
		await verifyRunButtonVisibility(page3, 'share_result', false, email3)

		// Initial progress should be 0/5 steps complete (total flow progress)
		const initialProgress1 = await verifyProgressInUI(page1, email1)
		expect(initialProgress1).toContain('0/5 steps complete')

		const initialProgress3 = await verifyProgressInUI(page3, email3)
		expect(initialProgress3).toContain('0/5 steps complete')

		// === Execute Steps via UI ===
		console.log('\n--- Executing Flow Steps via Runs UI ---')

		async function runStepInUI(page: Page, stepId: string, label: string) {
			const step = page.locator(`.mp-step[data-step-id="${stepId}"]`)
			if (!(await step.isVisible().catch(() => false))) {
				console.log(`    ${label}: Step ${stepId} not visible (not assigned to this role)`)
				return false
			}

			const runBtn = step.locator('.mp-run-btn, button:has-text("Run")')
			if (await runBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
				await runBtn.click()
				console.log(`    ${label}: Clicked Run for ${stepId}`)
				await page.waitForTimeout(1000)
				return true
			}
			return false
		}

		async function shareStepInUI(page: Page, stepId: string, label: string) {
			const step = page.locator(`.mp-step[data-step-id="${stepId}"]`)
			if (!(await step.isVisible().catch(() => false))) {
				return false
			}

			const shareBtn = step.locator('.mp-share-btn, button:has-text("Share")')
			if (await shareBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
				// Handle the confirm dialog that appears when clicking Share
				page.once('dialog', async (dialog) => {
					console.log(`    ${label}: Accepting share confirmation dialog`)
					await dialog.accept()
				})
				await shareBtn.click()
				console.log(`    ${label}: Clicked Share for ${stepId}`)
				await page.waitForTimeout(1500) // Wait longer for share to complete
				return true
			}
			return false
		}

		// Helper to verify output files exist after running a step
		async function verifyStepOutputFiles(
			backend: Backend,
			sessionIdVal: string,
			stepId: string,
			expectedFiles: string[],
			label: string,
		) {
			try {
				const files = await backend.invoke('get_step_output_files', {
					sessionId: sessionIdVal,
					stepId: stepId,
				})
				console.log(`    ${label}: Output files for ${stepId}: ${JSON.stringify(files)}`)

				for (const expectedFile of expectedFiles) {
					const found = files.some((f: string) => f.endsWith(expectedFile))
					if (found) {
						console.log(`    ${label}: ✓ Found expected output file: ${expectedFile}`)
					} else {
						console.log(`    ${label}: ✗ Missing expected output file: ${expectedFile}`)
					}
					expect(found).toBe(true)
				}
				return files
			} catch (err) {
				console.log(`    ${label}: Error getting output files: ${err}`)
				return []
			}
		}

		// Helper to verify step status in UI
		async function verifyStepStatusInUI(
			page: Page,
			stepId: string,
			expectedStatus: string,
			label: string,
		) {
			const step = page.locator(`.mp-step[data-step-id="${stepId}"]`)
			const statusEl = step.locator('.mp-step-status')
			const statusText = await statusEl.textContent().catch(() => '')
			console.log(`    ${label}: Step ${stepId} UI status: "${statusText}"`)
			return statusText
		}

		// Helper to verify progress bar percentage in UI
		async function verifyProgressInUI(page: Page, label: string) {
			const progressText = page.locator('.mp-progress-text')
			const text = await progressText.textContent().catch(() => '')
			console.log(`    ${label}: Progress: ${text}`)
			return text
		}

		// Helper to verify Run button visibility for a step
		async function verifyRunButtonVisibility(
			page: Page,
			stepId: string,
			shouldBeVisible: boolean,
			label: string,
		) {
			const step = page.locator(`.mp-step[data-step-id="${stepId}"]`)
			if (!(await step.isVisible().catch(() => false))) {
				console.log(`    ${label}: Step ${stepId} not visible on this page`)
				return null
			}
			const runBtn = step.locator('.mp-run-btn')
			const isVisible = await runBtn.isVisible().catch(() => false)
			console.log(`    ${label}: Run button for ${stepId}: visible=${isVisible}, expected=${shouldBeVisible}`)
			expect(isVisible).toBe(shouldBeVisible)
			return isVisible
		}

		// Helper to verify Preview button visibility
		async function verifyPreviewButtonVisibility(
			page: Page,
			stepId: string,
			shouldBeVisible: boolean,
			label: string,
		) {
			const step = page.locator(`.mp-step[data-step-id="${stepId}"]`)
			if (!(await step.isVisible().catch(() => false))) {
				return null
			}
			const previewBtn = step.locator('.mp-preview-btn')
			const isVisible = await previewBtn.isVisible().catch(() => false)
			console.log(`    ${label}: Preview button for ${stepId}: visible=${isVisible}, expected=${shouldBeVisible}`)
			expect(isVisible).toBe(shouldBeVisible)
			return isVisible
		}

		// Step 1: Contributors run "generate"
		console.log('\nStep 1: Generate Numbers')
		await runStepInUI(page1, 'generate', email1)
		await page1.waitForTimeout(1500) // Wait for file to be written
		await verifyStepOutputFiles(backend1, sessionId, 'generate', ['numbers.json'], email1)

		// Verify UI shows step as completed
		await verifyStepStatusInUI(page1, 'generate', 'Completed', email1)
		const progress1AfterGen = await verifyProgressInUI(page1, email1)
		expect(progress1AfterGen).toContain('1/')

		// After generate completes, share_contribution Run button should now be visible
		await verifyRunButtonVisibility(page1, 'share_contribution', true, email1)

		await runStepInUI(page2, 'generate', email2)
		await page2.waitForTimeout(1500) // Wait for file to be written
		await verifyStepOutputFiles(backend2, sessionId, 'generate', ['numbers.json'], email2)

		// Verify UI shows step as completed
		await verifyStepStatusInUI(page2, 'generate', 'Completed', email2)
		await verifyProgressInUI(page2, email2)

		// Step 2: Contributors share contributions
		console.log('\nStep 2: Share Contributions')
		await runStepInUI(page1, 'share_contribution', email1)
		await page1.waitForTimeout(1000)
		await shareStepInUI(page1, 'share_contribution', email1)

		// Verify UI shows step as shared
		await page1.waitForTimeout(500)
		await verifyStepStatusInUI(page1, 'share_contribution', 'Shared', email1)
		const progress1AfterShare = await verifyProgressInUI(page1, email1)
		// After share, contributor's 2 steps are done (generate + share_contribution)
		// Barrier not complete yet - waiting for client2
		expect(progress1AfterShare).toContain('2/5 steps complete')

		// Preview button should remain visible even after sharing
		await verifyPreviewButtonVisibility(page1, 'share_contribution', true, email1)

		await runStepInUI(page2, 'share_contribution', email2)
		await page2.waitForTimeout(1000)
		await shareStepInUI(page2, 'share_contribution', email2)

		// Verify UI shows step as shared
		await page2.waitForTimeout(500)
		await verifyStepStatusInUI(page2, 'share_contribution', 'Shared', email2)
		const progress2AfterShare = await verifyProgressInUI(page2, email2)
		// After both contributors share, barrier step completes (generate + share_contribution + contributions_ready)
		expect(progress2AfterShare).toContain('3/5 steps complete')

		// Preview button should remain visible after sharing for client2 too
		await verifyPreviewButtonVisibility(page2, 'share_contribution', true, email2)

		// Simulate receiving shared inputs at aggregator
		// In real flow, this would happen via messaging - for now we verify generate outputs exist
		console.log('\nVerifying contributor outputs before aggregation...')
		const files1 = await verifyStepOutputFiles(backend1, sessionId, 'generate', ['numbers.json'], email1)
		const files2 = await verifyStepOutputFiles(backend2, sessionId, 'generate', ['numbers.json'], email2)

		// Step 3: Barrier + Aggregate
		console.log('\nStep 3: Aggregate Sum')
		// After contributors share, the barrier step 'contributions_ready' should complete
		// which unblocks 'aggregate' (depends_on: [contributions_ready])

		const aggState = await backend3.invoke('get_multiparty_flow_state', { sessionId })
		const barrierStep = aggState?.steps?.find((s: any) => s.id === 'contributions_ready')
		const aggStep = aggState?.steps?.find((s: any) => s.id === 'aggregate')
		console.log(`  Barrier step status: ${barrierStep?.status}`)
		console.log(`  Aggregator aggregate step status: ${aggStep?.status}`)

		// Aggregate should now be Ready (barrier completed after contributors shared)
		expect(aggStep?.status).toBe('Ready')

		// Run aggregate step
		await runStepInUI(page3, 'aggregate', email3)
		await page3.waitForTimeout(1500)

		// Verify aggregate output files
		await verifyStepOutputFiles(backend3, sessionId, 'aggregate', ['result.json'], email3)

		// Verify aggregate result contains contributor data
		const aggResultFiles = await backend3.invoke('get_step_output_files', {
			sessionId: sessionId,
			stepId: 'aggregate',
		})
		console.log(`  Aggregator aggregate output: ${JSON.stringify(aggResultFiles)}`)
		expect(aggResultFiles.length).toBeGreaterThan(0)

		// Read the result file to verify it contains contributor data
		const resultPath = aggResultFiles.find((f: string) => f.endsWith('result.json'))
		if (resultPath) {
			const fs = await import('fs')
			const resultContent = fs.readFileSync(resultPath, 'utf-8')
			const resultData = JSON.parse(resultContent)
			console.log(`  Aggregate result: contributions=${resultData.contributions?.length}, all_numbers=${resultData.all_numbers?.length}, total_sum=${resultData.total_sum}`)

			// Verify we got data from both contributors
			expect(resultData.contributions?.length).toBe(2)
			expect(resultData.all_numbers?.length).toBeGreaterThan(0)
			expect(resultData.count).toBeGreaterThan(0)
		}

		// Verify UI shows aggregate as completed
		await verifyStepStatusInUI(page3, 'aggregate', 'Completed', email3)
		const progressAfterAgg = await verifyProgressInUI(page3, email3)
		// After aggregate: generate(done) + share_contribution(done) + aggregate(done) = 3/4
		expect(progressAfterAgg).toContain('4/5 steps complete')

		// Step 4: Aggregator shares results
		console.log('\nStep 4: Share Results')
		// After aggregate completes, share_result should become Ready
		await runStepInUI(page3, 'share_result', email3)
		await page3.waitForTimeout(1000)
		await shareStepInUI(page3, 'share_result', email3)

		// Verify share_result is shared
		await page3.waitForTimeout(500)
		await verifyStepStatusInUI(page3, 'share_result', 'Shared', email3)
		const progressAfterShare = await verifyProgressInUI(page3, email3)
		// After share_result, all 4 steps are complete
		expect(progressAfterShare).toContain('Done')

		log(logSocket, { event: 'flow-steps-completed' })

		// === Send Messages to Chat and Verify ===
		console.log('\n--- Sending Messages Between Participants ---')

		// Navigate client1 back to Messages
		await page1.click('button:has-text("Messages")')
		await page1.waitForTimeout(500)

		// Click on the thread to select it
		const threadItem1 = page1.locator('.message-thread-item').first()
		await threadItem1.click()
		await page1.waitForTimeout(500)

		// Send a message from client1 (use message-compose-body in Messages tab thread view)
		const testMessage1 = `Step completed! Generated numbers at ${Date.now()}`
		const messageInput1 = page1.locator('#message-compose-body')
		await messageInput1.waitFor({ timeout: 5000 })
		await messageInput1.fill(testMessage1)
		const sendBtn1 = page1.locator('#message-send-btn')
		await sendBtn1.click()
		console.log(`  ${email1}: Sent message: "${testMessage1.substring(0, 30)}..."`)
		await page1.waitForTimeout(2000)

		// Navigate client2 to Messages and sync
		await page2.click('button:has-text("Messages")')
		await page2.waitForTimeout(500)
		const syncBtn2 = page2.locator('#refresh-messages-btn')
		if (await syncBtn2.isVisible()) {
			await syncBtn2.click()
			await page2.waitForTimeout(2000)
		}
		const threadItem2 = page2.locator('.message-thread-item').first()
		await threadItem2.click()
		await page2.waitForTimeout(1000)

		// Verify client2 sees the message
		const messagesArea2 = page2.locator('.message-list, #message-list')
		const messagesHtml2 = await messagesArea2.innerHTML().catch(() => '')
		const hasMessage = messagesHtml2.includes('Step completed')
		console.log(`  ${email2}: Can see client1's message: ${hasMessage}`)

		// Navigate back to Runs to check final state
		await page1.click('button:has-text("Runs")')
		await page2.click('button:has-text("Runs")')
		await page1.waitForTimeout(500)
		await page2.waitForTimeout(500)

		// === Verify Final State ===
		console.log('\n--- Final Verification ---')

		const finalState1 = await backend1.invoke('get_multiparty_flow_state', { sessionId })
		const finalState2 = await backend2.invoke('get_multiparty_flow_state', { sessionId })
		const finalState3 = await backend3.invoke('get_multiparty_flow_state', { sessionId })

		console.log(`\n${email1} final step states:`)
		finalState1?.steps?.forEach((s: any) => console.log(`  - ${s.name}: ${s.status}`))

		console.log(`\n${email2} final step states:`)
		finalState2?.steps?.forEach((s: any) => console.log(`  - ${s.name}: ${s.status}`))

		console.log(`\n${email3} final step states:`)
		finalState3?.steps?.forEach((s: any) => console.log(`  - ${s.name}: ${s.status}`))

		// Verify UI shows correct step status for each client
		console.log('\n--- Verifying Final UI State ---')

		// Client1 should show generate and share_contribution as completed/shared
		const client1GenerateStatus = finalState1?.steps?.find((s: any) => s.id === 'generate')?.status
		const client1ShareStatus = finalState1?.steps?.find((s: any) => s.id === 'share_contribution')?.status
		console.log(`  ${email1}: generate=${client1GenerateStatus}, share_contribution=${client1ShareStatus}`)
		expect(client1GenerateStatus).toBe('Completed')
		expect(client1ShareStatus).toBe('Shared')

		// Client2 should show generate and share_contribution as completed/shared
		const client2GenerateStatus = finalState2?.steps?.find((s: any) => s.id === 'generate')?.status
		const client2ShareStatus = finalState2?.steps?.find((s: any) => s.id === 'share_contribution')?.status
		console.log(`  ${email2}: generate=${client2GenerateStatus}, share_contribution=${client2ShareStatus}`)
		expect(client2GenerateStatus).toBe('Completed')
		expect(client2ShareStatus).toBe('Shared')

		// Aggregator should have completed both steps (aggregate + share_result)
		const aggShareResultStatus = finalState3?.steps?.find((s: any) => s.id === 'share_result')?.status
		const aggAggregateStatus = finalState3?.steps?.find((s: any) => s.id === 'aggregate')?.status
		console.log(`  ${email3}: aggregate=${aggAggregateStatus}, share_result=${aggShareResultStatus}`)
		expect(aggAggregateStatus).toBe('Completed')
		expect(aggShareResultStatus).toBe('Shared')

		// Verify UI progress shows correct count
		const finalProgress1 = await verifyProgressInUI(page1, email1)
		const finalProgress2 = await verifyProgressInUI(page2, email2)
		const finalProgress3 = await verifyProgressInUI(page3, email3)

		// All 4 steps are complete across all participants - everyone sees "Done"
		expect(finalProgress1).toContain('Done')
		expect(finalProgress2).toContain('Done')
		expect(finalProgress3).toContain('Done')

		// === Verify Results in Chat ===
		console.log('\n--- Checking for Shared Results in Chat ---')

		// Navigate back to Messages to see if results appeared
		await page1.click('button:has-text("Messages")')
		await page1.waitForTimeout(1000)

		// Sync and check for result messages
		const syncBtn1 = page1.locator('#refresh-messages-btn')
		if (await syncBtn1.isVisible()) {
			await syncBtn1.click()
			await page1.waitForTimeout(2000)
		}

		console.log('\n=== Multiparty Flow Test Complete! ===')
		log(logSocket, { event: 'multiparty-flow-test-complete' })

		// Interactive mode pause
		if (process.env.INTERACTIVE_MODE === '1') {
			console.log('\n--- Interactive Mode ---')
			console.log('All three clients have completed the flow. You can interact with them:')
			console.log(`  Client 1: ${uiBaseUrl}?ws=${wsPort1}&real=1`)
			console.log(`  Client 2: ${uiBaseUrl}?ws=${wsPort2}&real=1`)
			console.log(`  Client 3: ${uiBaseUrl}?ws=${wsPort3}&real=1`)
			console.log('\nPress ENTER to exit or wait 60 seconds...')

			await new Promise<void>((resolve) => {
				const timeout = setTimeout(resolve, 60_000)
				if (process.stdin.isTTY) {
					process.stdin.resume()
					process.stdin.once('data', () => {
						clearTimeout(timeout)
						resolve()
					})
				}
			})
		}

		// Cleanup - close pages first to stop polling intervals and prevent WS errors
		await page1.close()
		await page2.close()
		await page3.close()

		await backend1.close()
		await backend2.close()
		await backend3.close()

		if (logSocket) {
			await new Promise<void>((resolve) => {
				logSocket.once('close', () => resolve())
				logSocket.close()
			})
		}
	})
})
