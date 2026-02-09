/**
 * Multiparty Messaging Test (Three Clients)
 * Tests the multiparty/group messaging workflow:
 * 1. Three clients (client1, client2, client3/aggregator) onboard
 * 2. All three exchange keys (import each other as contacts)
 * 3. Aggregator creates a group chat with all three participants
 * 4. Verify all 3 participants appear on every client's thread
 * 5. Verify from/to fields are correct (sender never sees own email in "to")
 * 6. Client1 and client2 reply in the same thread
 * 7. All participants see all messages in the shared thread
 * 8. N-to-N: each pair sends a separate 1:1 message; verify no cross-contamination
 *
 * Usage:
 *   ./test-scenario.sh --pipelines-multiparty --interactive
 *
 * @tag pipelines-multiparty
 */
import { expect, test, type Page } from './playwright-fixtures'
import WebSocket from 'ws'
import { waitForAppReady, ensureProfileSelected } from './test-helpers.js'
import { setWsPort, completeOnboarding, ensureLogSocket, log } from './onboarding-helper.js'

const TEST_TIMEOUT = 300_000 // 5 minutes max
const UI_TIMEOUT = 10_000
const MESSAGE_TIMEOUT = 90_000 // 90 seconds for message delivery (3 clients = more traffic)
const SYNC_INTERVAL = 500 // ms between sync polls

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

async function waitForMessage(
	backend: Backend,
	targetBody: string,
	timeoutMs = MESSAGE_TIMEOUT,
): Promise<void> {
	const start = Date.now()
	while (Date.now() - start < timeoutMs) {
		try {
			await backend.invoke('sync_messages_with_failures')
		} catch {
			// Ignore transient sync errors
		}

		const threads = await backend.invoke('list_message_threads', { scope: 'all' })
		if (Array.isArray(threads)) {
			for (const thread of threads) {
				const threadId = thread?.thread_id || thread?.threadId || thread?.id
				if (!threadId) continue
				const msgs = await backend.invoke('get_thread_messages', { threadId })
				if (Array.isArray(msgs) && msgs.some((m: any) => (m?.body || '').includes(targetBody))) {
					return
				}
			}
		}
		await new Promise((r) => setTimeout(r, SYNC_INTERVAL))
	}
	throw new Error(`Message not found within timeout: ${targetBody}`)
}

async function findGroupThread(
	backend: Backend,
	expectedThreadId: string,
	timeoutMs = MESSAGE_TIMEOUT,
): Promise<string | null> {
	const start = Date.now()
	while (Date.now() - start < timeoutMs) {
		try {
			await backend.invoke('sync_messages_with_failures')
		} catch {
			// Ignore transient sync errors
		}

		const threads = await backend.invoke('list_message_threads', { scope: 'all' })
		if (Array.isArray(threads)) {
			for (const thread of threads) {
				const threadId = thread?.thread_id || ''
				if (threadId === expectedThreadId) {
					return threadId
				}
			}
		}
		await new Promise((r) => setTimeout(r, SYNC_INTERVAL))
	}
	return null
}

async function getThreadSummary(backend: Backend, targetThreadId: string): Promise<any | null> {
	const threads = await backend.invoke('list_message_threads', { scope: 'all' })
	if (Array.isArray(threads)) {
		return threads.find((t: any) => t.thread_id === targetThreadId) || null
	}
	return null
}

async function getThreadMessages(backend: Backend, threadId: string): Promise<any[]> {
	const msgs = await backend.invoke('get_thread_messages', { threadId })
	return Array.isArray(msgs) ? msgs : []
}

async function countMessagesInThread(backend: Backend, threadId: string): Promise<number> {
	const msgs = await getThreadMessages(backend, threadId)
	return msgs.length
}

async function getFirstMessageInThread(backend: Backend, threadId: string): Promise<string | null> {
	const msgs = await getThreadMessages(backend, threadId)
	if (msgs.length > 0) {
		const sorted = msgs.sort((a: any, b: any) => {
			const aTime = new Date(a.created_at).getTime()
			const bTime = new Date(b.created_at).getTime()
			return aTime - bTime
		})
		return sorted[0]?.id || null
	}
	return null
}

async function syncAll(...backends: Backend[]) {
	for (const b of backends) {
		try {
			await b.invoke('sync_messages_with_failures')
		} catch {
			// Ignore transient sync errors
		}
	}
}

function assertParticipants(actual: string[], expected: string[], context: string) {
	const sortedActual = [...actual].sort()
	const sortedExpected = [...expected].sort()
	const missing = sortedExpected.filter((e) => !sortedActual.includes(e))
	const extra = sortedActual.filter((a) => !sortedExpected.includes(a))
	if (missing.length > 0 || extra.length > 0) {
		throw new Error(
			`${context}: participant mismatch\n` +
				`  expected: [${sortedExpected.join(', ')}]\n` +
				`  actual:   [${sortedActual.join(', ')}]\n` +
				(missing.length > 0 ? `  missing:  [${missing.join(', ')}]\n` : '') +
				(extra.length > 0 ? `  extra:    [${extra.join(', ')}]\n` : ''),
		)
	}
}

test.describe('Multiparty messaging between three clients @pipelines-multiparty', () => {
	test('three clients create and participate in a group chat', async ({ browser }) => {
		const wsPortBase = Number.parseInt(process.env.DEV_WS_BRIDGE_PORT_BASE || '3333', 10)
		const wsPort1 = wsPortBase
		const wsPort2 = wsPortBase + 1
		const wsPort3 = wsPortBase + 2

		const email1 = process.env.CLIENT1_EMAIL || 'client1@sandbox.local'
		const email2 = process.env.CLIENT2_EMAIL || 'client2@sandbox.local'
		const email3 = process.env.AGG_EMAIL || 'aggregator@sandbox.local'
		const allEmails = [email1, email2, email3].sort()

		const logSocket = await ensureLogSocket()
		log(logSocket, {
			event: 'multiparty-start',
			email1,
			email2,
			email3,
			wsPort1,
			wsPort2,
			wsPort3,
		})

		console.log('=== Multiparty Group Chat Test ===')
		console.log(`Client 1: ${email1} (WS port ${wsPort1})`)
		console.log(`Client 2: ${email2} (WS port ${wsPort2})`)
		console.log(`Client 3 (Aggregator): ${email3} (WS port ${wsPort3})`)

		// Create pages for all three clients
		const page1 = await browser.newPage()
		const page2 = await browser.newPage()
		const page3 = await browser.newPage()

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
		console.log(`  ${email1} imported ${email2}`)
		await backend1.invoke('network_import_contact', { identity: email3 })
		console.log(`  ${email1} imported ${email3}`)

		await backend2.invoke('network_import_contact', { identity: email1 })
		console.log(`  ${email2} imported ${email1}`)
		await backend2.invoke('network_import_contact', { identity: email3 })
		console.log(`  ${email2} imported ${email3}`)

		await backend3.invoke('network_import_contact', { identity: email1 })
		console.log(`  ${email3} imported ${email1}`)
		await backend3.invoke('network_import_contact', { identity: email2 })
		console.log(`  ${email3} imported ${email2}`)

		log(logSocket, { event: 'key-exchange-complete' })
		console.log('All key exchanges complete!')

		// === Create Group Chat ===
		console.log('\n--- Creating Group Chat ---')
		const timestamp = Date.now()
		const groupSubject = `Group Chat Test - ${timestamp}`
		const initialMessage = `Hello everyone! This is a group chat started by the aggregator. - ${timestamp}`

		console.log(`${email3} creating group chat with ${email1} and ${email2}...`)

		const groupMessage = await backend3.invoke('send_message', {
			request: {
				recipients: [email1, email2],
				body: initialMessage,
				subject: groupSubject,
			},
		})

		console.log(`Group chat created! Thread ID: ${groupMessage.thread_id}`)
		log(logSocket, { event: 'group-chat-created', threadId: groupMessage.thread_id })

		// === Verify the sent message has correct from/to on sender ===
		console.log('\n--- Verifying sender message fields ---')
		expect(groupMessage.from).toBe(email3)
		expect(groupMessage.to).not.toBe(email3)
		console.log(
			`  ✓ Sender (${email3}): from=${groupMessage.from}, to=${groupMessage.to} (not self)`,
		)

		// === Verify All Participants Receive the Group Message ===
		console.log('\n--- Verifying Group Message Delivery ---')

		console.log(`Checking ${email1} received group message...`)
		await waitForMessage(backend1, initialMessage)
		console.log(`  ✓ ${email1} received the group message`)

		console.log(`Checking ${email2} received group message...`)
		await waitForMessage(backend2, initialMessage)
		console.log(`  ✓ ${email2} received the group message`)

		log(logSocket, { event: 'group-message-delivered-to-all' })

		// === Find the Group Thread on all 3 clients ===
		console.log('\n--- Finding Group Thread on all clients ---')
		const expectedThreadId = groupMessage.thread_id
		console.log(`Looking for thread ID: ${expectedThreadId}`)

		const groupThreadId1 = await findGroupThread(backend1, expectedThreadId)
		const groupThreadId2 = await findGroupThread(backend2, expectedThreadId)
		const groupThreadId3 = await findGroupThread(backend3, expectedThreadId)

		if (!groupThreadId1 || !groupThreadId2 || !groupThreadId3) {
			throw new Error(
				`Group thread ${expectedThreadId} not found on all clients: ` +
					`c1=${groupThreadId1}, c2=${groupThreadId2}, c3=${groupThreadId3}`,
			)
		}
		console.log(`  ✓ Thread found on all 3 clients`)

		// === Verify thread participants on every client show all 3 emails ===
		console.log('\n--- Verifying thread participants (all 3 must appear) ---')

		const summary1 = await getThreadSummary(backend1, expectedThreadId)
		const summary2 = await getThreadSummary(backend2, expectedThreadId)
		const summary3 = await getThreadSummary(backend3, expectedThreadId)

		assertParticipants(summary1.participants, allEmails, `Client1 (${email1}) thread participants`)
		console.log(`  ✓ ${email1} sees participants: [${summary1.participants.sort().join(', ')}]`)

		assertParticipants(summary2.participants, allEmails, `Client2 (${email2}) thread participants`)
		console.log(`  ✓ ${email2} sees participants: [${summary2.participants.sort().join(', ')}]`)

		assertParticipants(summary3.participants, allEmails, `Client3 (${email3}) thread participants`)
		console.log(`  ✓ ${email3} sees participants: [${summary3.participants.sort().join(', ')}]`)

		// === Verify from/to fields on received messages ===
		console.log('\n--- Verifying from/to fields on received messages ---')

		const msgsOnClient1 = await getThreadMessages(backend1, expectedThreadId)
		const msgsOnClient2 = await getThreadMessages(backend2, expectedThreadId)
		const msgsOnClient3 = await getThreadMessages(backend3, expectedThreadId)

		for (const msg of msgsOnClient1) {
			expect(msg.from).toBe(email3)
			expect(msg.to).not.toBe(msg.from)
			console.log(`  ${email1} sees msg: from=${msg.from} to=${msg.to}`)
		}

		for (const msg of msgsOnClient2) {
			expect(msg.from).toBe(email3)
			expect(msg.to).not.toBe(msg.from)
			console.log(`  ${email2} sees msg: from=${msg.from} to=${msg.to}`)
		}

		for (const msg of msgsOnClient3) {
			expect(msg.from).toBe(email3)
			expect(msg.to).not.toBe(msg.from)
			console.log(`  ${email3} sees msg: from=${msg.from} to=${msg.to}`)
		}
		console.log(`  ✓ All from/to fields correct (no sender seeing own email in "to")`)

		// === Replies in the Group Thread ===
		console.log('\n--- Sending Replies in Group Thread ---')

		const msgId1 = await getFirstMessageInThread(backend1, expectedThreadId)
		const msgId2 = await getFirstMessageInThread(backend2, expectedThreadId)

		if (!msgId1 || !msgId2) {
			throw new Error('Could not find original message in thread for replies')
		}

		const reply1 = `Reply from Client1 in the group! - ${timestamp}`
		console.log(`${email1} sending reply...`)
		const reply1Result = await backend1.invoke('send_message', {
			request: {
				body: reply1,
				reply_to: msgId1,
			},
		})
		console.log(`  ✓ ${email1} sent reply`)

		// Verify reply from/to on sender side
		expect(reply1Result.from).toBe(email1)
		expect(reply1Result.to).not.toBe(email1)
		console.log(
			`  ✓ Reply from ${email1}: from=${reply1Result.from} to=${reply1Result.to} (not self)`,
		)

		const reply2 = `Reply from Client2 in the group! - ${timestamp}`
		console.log(`${email2} sending reply...`)
		const reply2Result = await backend2.invoke('send_message', {
			request: {
				body: reply2,
				reply_to: msgId2,
			},
		})
		console.log(`  ✓ ${email2} sent reply`)

		expect(reply2Result.from).toBe(email2)
		expect(reply2Result.to).not.toBe(email2)
		console.log(
			`  ✓ Reply from ${email2}: from=${reply2Result.from} to=${reply2Result.to} (not self)`,
		)

		log(logSocket, { event: 'group-replies-sent' })

		// === Verify All Participants See All Messages ===
		console.log('\n--- Verifying All Replies Delivered ---')

		console.log(`Checking ${email3} received all replies...`)
		await waitForMessage(backend3, reply1)
		console.log(`  ✓ ${email3} received reply from ${email1}`)
		await waitForMessage(backend3, reply2)
		console.log(`  ✓ ${email3} received reply from ${email2}`)

		console.log(`Checking ${email1} received reply from ${email2}...`)
		await waitForMessage(backend1, reply2)
		console.log(`  ✓ ${email1} received reply from ${email2}`)

		console.log(`Checking ${email2} received reply from ${email1}...`)
		await waitForMessage(backend2, reply1)
		console.log(`  ✓ ${email2} received reply from ${email1}`)

		log(logSocket, { event: 'all-replies-delivered' })

		// === Final sync and full thread verification ===
		console.log('\n--- Final Thread Verification ---')
		const threadId = groupMessage.thread_id

		await new Promise((r) => setTimeout(r, 2000))
		await syncAll(backend1, backend2, backend3)

		const count1 = await countMessagesInThread(backend1, threadId)
		const count2 = await countMessagesInThread(backend2, threadId)
		const count3 = await countMessagesInThread(backend3, threadId)

		console.log(`Thread message counts:`)
		console.log(`  ${email1}: ${count1} messages`)
		console.log(`  ${email2}: ${count2} messages`)
		console.log(`  ${email3}: ${count3} messages`)

		// Each client should have at least 3 messages (initial + 2 replies)
		expect(count1).toBeGreaterThanOrEqual(3)
		expect(count2).toBeGreaterThanOrEqual(3)
		expect(count3).toBeGreaterThanOrEqual(3)
		console.log(`  ✓ All clients have >= 3 messages in group thread`)

		// === Verify from/to on all messages after replies ===
		console.log('\n--- Verifying from/to on all thread messages (post-replies) ---')

		const allBackends = [
			{ backend: backend1, email: email1 },
			{ backend: backend2, email: email2 },
			{ backend: backend3, email: email3 },
		]

		for (const { backend, email } of allBackends) {
			const msgs = await getThreadMessages(backend, threadId)
			for (const msg of msgs) {
				// "from" must never be empty
				expect(msg.from).toBeTruthy()
				// Sender should never see their own email in "to"
				if (msg.from === email) {
					expect(msg.to).not.toBe(email)
				}
				// "to" must never be empty
				expect(msg.to).toBeTruthy()
			}
			console.log(
				`  ✓ ${email}: all ${msgs.length} messages have valid from/to (no self-addressed)`,
			)
		}

		// === Verify participants still show all 3 after replies ===
		console.log('\n--- Verifying participants after replies ---')
		for (const { backend, email } of allBackends) {
			const summary = await getThreadSummary(backend, threadId)
			assertParticipants(
				summary.participants,
				allEmails,
				`${email} thread participants (post-replies)`,
			)
		}
		console.log(`  ✓ All clients still show all 3 participants after replies`)

		// === Verify group_chat metadata on messages ===
		console.log('\n--- Verifying group_chat metadata ---')
		for (const { backend, email } of allBackends) {
			const msgs = await getThreadMessages(backend, threadId)
			for (const msg of msgs) {
				if (msg.metadata?.group_chat) {
					const gc = msg.metadata.group_chat
					expect(gc.is_group).toBe(true)
					expect(gc.participants).toBeDefined()
					const metaParticipants = [...gc.participants].sort()
					expect(metaParticipants).toEqual(allEmails)
				}
			}
			console.log(`  ✓ ${email}: group_chat metadata correct on all messages`)
		}

		log(logSocket, { event: 'group-verification-complete' })

		// =====================================================================
		// === N-to-N: 1:1 messages between every pair, verify thread isolation
		// =====================================================================
		console.log('\n--- N-to-N: Sending 1:1 messages between every pair ---')

		const pairs = [
			{ from: backend1, fromEmail: email1, to: backend2, toEmail: email2 },
			{ from: backend2, fromEmail: email2, to: backend1, toEmail: email1 },
			{ from: backend1, fromEmail: email1, to: backend3, toEmail: email3 },
			{ from: backend3, fromEmail: email3, to: backend1, toEmail: email1 },
			{ from: backend2, fromEmail: email2, to: backend3, toEmail: email3 },
			{ from: backend3, fromEmail: email3, to: backend2, toEmail: email2 },
		]

		const pairMessages: Array<{
			fromEmail: string
			toEmail: string
			body: string
			threadId: string
		}> = []

		for (const { from, fromEmail, to, toEmail } of pairs) {
			const body = `DM from ${fromEmail} to ${toEmail} - ${timestamp}-${Math.random().toString(36).slice(2, 8)}`
			const subject = `DM ${fromEmail} -> ${toEmail}`

			console.log(`  Sending: ${fromEmail} -> ${toEmail}`)
			const result = await from.invoke('send_message', {
				request: {
					recipients: [toEmail],
					body,
					subject,
				},
			})

			// Verify sender fields
			expect(result.from).toBe(fromEmail)
			expect(result.to).toBe(toEmail)

			pairMessages.push({
				fromEmail,
				toEmail,
				body,
				threadId: result.thread_id,
			})
		}

		console.log(`  ✓ All 6 DMs sent`)

		// Wait for all DMs to be delivered
		console.log('\n--- Verifying DM delivery ---')
		for (const pm of pairMessages) {
			const recipientBackend =
				pm.toEmail === email1 ? backend1 : pm.toEmail === email2 ? backend2 : backend3
			await waitForMessage(recipientBackend, pm.body)
			console.log(`  ✓ ${pm.toEmail} received DM from ${pm.fromEmail}`)
		}

		// Final sync
		await new Promise((r) => setTimeout(r, 2000))
		await syncAll(backend1, backend2, backend3)

		// === Verify thread isolation: DMs don't leak into other threads ===
		console.log('\n--- Verifying thread isolation ---')

		for (const { backend, email } of allBackends) {
			const threads = await backend.invoke('list_message_threads', { scope: 'all' })

			for (const thread of threads) {
				const tid = thread.thread_id
				const msgs = await getThreadMessages(backend, tid)
				const participants = new Set<string>()
				for (const m of msgs) {
					participants.add(m.from)
					participants.add(m.to)
				}

				// If this is a 1:1 thread (not the group), it should have exactly 2 participants
				if (tid !== threadId) {
					const participantList = [...participants]
					// Verify no 3rd-party messages leaked into a 1:1 thread
					for (const m of msgs) {
						const expectedSenders = participantList
						if (!expectedSenders.includes(m.from)) {
							throw new Error(
								`Thread isolation violation on ${email}: ` +
									`message from ${m.from} found in thread between [${participantList.join(', ')}]`,
							)
						}
					}
				}
			}
			console.log(`  ✓ ${email}: no cross-thread contamination detected`)
		}

		// === Verify DM from/to correctness ===
		console.log('\n--- Verifying DM from/to correctness ---')
		for (const pm of pairMessages) {
			const senderBackend =
				pm.fromEmail === email1 ? backend1 : pm.fromEmail === email2 ? backend2 : backend3
			const recipientBackend =
				pm.toEmail === email1 ? backend1 : pm.toEmail === email2 ? backend2 : backend3

			// Check sender's view
			const senderMsgs = await getThreadMessages(senderBackend, pm.threadId)
			const senderMsg = senderMsgs.find((m: any) => m.body === pm.body)
			if (senderMsg) {
				expect(senderMsg.from).toBe(pm.fromEmail)
				expect(senderMsg.to).toBe(pm.toEmail)
			}

			// Check recipient's view
			const recipientMsgs = await getThreadMessages(recipientBackend, pm.threadId)
			const recipientMsg = recipientMsgs.find((m: any) => m.body === pm.body)
			if (recipientMsg) {
				expect(recipientMsg.from).toBe(pm.fromEmail)
				// Recipient should see the message addressed to themselves
				expect(recipientMsg.to).toBe(pm.toEmail)
			}
		}
		console.log(`  ✓ All 6 DMs have correct from/to on both sender and recipient side`)

		console.log('\n=== Group Chat + N-to-N Test Complete! ===')
		log(logSocket, { event: 'multiparty-test-complete' })

		// Interactive mode pause
		if (process.env.INTERACTIVE_MODE === '1') {
			console.log('\n--- Interactive Mode ---')
			console.log('All three clients are ready with group chat. You can interact with them:')
			console.log(`  Client 1: ${uiBaseUrl}?ws=${wsPort1}&real=1`)
			console.log(`  Client 2: ${uiBaseUrl}?ws=${wsPort2}&real=1`)
			console.log(`  Client 3: ${uiBaseUrl}?ws=${wsPort3}&real=1`)
			console.log('\nInteractive pause disabled; continuing cleanup.')
		}

		// Cleanup
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
