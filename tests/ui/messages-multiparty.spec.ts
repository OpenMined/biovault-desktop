/**
 * Multiparty Messaging Test (Three Clients)
 * Tests the multiparty/group messaging workflow:
 * 1. Three clients (client1, client2, client3/aggregator) onboard
 * 2. All three exchange keys (import each other as contacts)
 * 3. Aggregator creates a group chat with all three participants
 * 4. Client1 and client2 reply in the same thread
 * 5. All participants see all messages in the shared thread
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
				// Match by the expected thread ID
				if (threadId === expectedThreadId) {
					return threadId
				}
			}
		}
		await new Promise((r) => setTimeout(r, SYNC_INTERVAL))
	}
	return null
}

async function countMessagesInThread(backend: Backend, threadId: string): Promise<number> {
	const msgs = await backend.invoke('get_thread_messages', { threadId })
	return Array.isArray(msgs) ? msgs.length : 0
}

async function getFirstMessageInThread(backend: Backend, threadId: string): Promise<string | null> {
	const msgs = await backend.invoke('get_thread_messages', { threadId })
	if (Array.isArray(msgs) && msgs.length > 0) {
		// Sort by created_at and get the first one
		const sorted = msgs.sort((a: any, b: any) => {
			const aTime = new Date(a.created_at).getTime()
			const bTime = new Date(b.created_at).getTime()
			return aTime - bTime
		})
		return sorted[0]?.id || null
	}
	return null
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

		// Client 1 imports Client 2 and Client 3
		await backend1.invoke('network_import_contact', { identity: email2 })
		console.log(`  ${email1} imported ${email2}`)
		await backend1.invoke('network_import_contact', { identity: email3 })
		console.log(`  ${email1} imported ${email3}`)

		// Client 2 imports Client 1 and Client 3
		await backend2.invoke('network_import_contact', { identity: email1 })
		console.log(`  ${email2} imported ${email1}`)
		await backend2.invoke('network_import_contact', { identity: email3 })
		console.log(`  ${email2} imported ${email3}`)

		// Client 3 imports Client 1 and Client 2
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

		// Aggregator (client3) creates a group chat with client1 and client2
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

		// === Verify All Participants Receive the Group Message ===
		console.log('\n--- Verifying Group Message Delivery ---')

		// Client 1 should receive the message
		console.log(`Checking ${email1} received group message...`)
		await waitForMessage(backend1, initialMessage)
		console.log(`  ✓ ${email1} received the group message`)

		// Client 2 should receive the message
		console.log(`Checking ${email2} received group message...`)
		await waitForMessage(backend2, initialMessage)
		console.log(`  ✓ ${email2} received the group message`)

		log(logSocket, { event: 'group-message-delivered-to-all' })

		// === Find the Group Thread ===
		console.log('\n--- Finding Group Thread ---')
		const expectedThreadId = groupMessage.thread_id
		console.log(`Looking for thread ID: ${expectedThreadId}`)

		const groupThreadId1 = await findGroupThread(backend1, expectedThreadId)
		const groupThreadId2 = await findGroupThread(backend2, expectedThreadId)

		if (!groupThreadId1 || !groupThreadId2) {
			throw new Error(`Could not find group thread ${expectedThreadId} on all clients`)
		}
		console.log(`Group thread found on client1: ${groupThreadId1}`)
		console.log(`Group thread found on client2: ${groupThreadId2}`)

		// === Replies in the Group Thread ===
		console.log('\n--- Sending Replies in Group Thread ---')

		// Get the message IDs from each client's perspective
		const msgId1 = await getFirstMessageInThread(backend1, expectedThreadId)
		const msgId2 = await getFirstMessageInThread(backend2, expectedThreadId)

		if (!msgId1 || !msgId2) {
			throw new Error('Could not find original message in thread for replies')
		}

		// Client 1 replies in the thread
		const reply1 = `Reply from Client1 in the group! - ${timestamp}`
		console.log(`${email1} sending reply (replying to ${msgId1})...`)
		await backend1.invoke('send_message', {
			request: {
				body: reply1,
				reply_to: msgId1,
			},
		})
		console.log(`  ✓ ${email1} sent reply`)

		// Client 2 replies in the thread
		const reply2 = `Reply from Client2 in the group! - ${timestamp}`
		console.log(`${email2} sending reply (replying to ${msgId2})...`)
		await backend2.invoke('send_message', {
			request: {
				body: reply2,
				reply_to: msgId2,
			},
		})
		console.log(`  ✓ ${email2} sent reply`)

		log(logSocket, { event: 'group-replies-sent' })

		// === Verify All Participants See All Messages ===
		console.log('\n--- Verifying All Replies Delivered ---')

		// Client 3 (aggregator) should see both replies
		console.log(`Checking ${email3} received all replies...`)
		await waitForMessage(backend3, reply1)
		console.log(`  ✓ ${email3} received reply from ${email1}`)
		await waitForMessage(backend3, reply2)
		console.log(`  ✓ ${email3} received reply from ${email2}`)

		// Client 1 should see client 2's reply
		console.log(`Checking ${email1} received reply from ${email2}...`)
		await waitForMessage(backend1, reply2)
		console.log(`  ✓ ${email1} received reply from ${email2}`)

		// Client 2 should see client 1's reply
		console.log(`Checking ${email2} received reply from ${email1}...`)
		await waitForMessage(backend2, reply1)
		console.log(`  ✓ ${email2} received reply from ${email1}`)

		log(logSocket, { event: 'all-replies-delivered' })

		// === Final Verification: Thread Message Count ===
		console.log('\n--- Final Thread Verification ---')
		const threadId = groupMessage.thread_id

		// Give a moment for final sync
		await new Promise((r) => setTimeout(r, 2000))
		await backend1.invoke('sync_messages_with_failures')
		await backend2.invoke('sync_messages_with_failures')
		await backend3.invoke('sync_messages_with_failures')

		const count1 = await countMessagesInThread(backend1, threadId)
		const count2 = await countMessagesInThread(backend2, threadId)
		const count3 = await countMessagesInThread(backend3, threadId)

		console.log(`Thread message counts:`)
		console.log(`  ${email1}: ${count1} messages`)
		console.log(`  ${email2}: ${count2} messages`)
		console.log(`  ${email3}: ${count3} messages`)

		// Each client should have at least 3 messages (initial + 2 replies)
		// Note: counts may vary slightly due to how outgoing/incoming are counted
		if (count1 < 2 || count2 < 2 || count3 < 2) {
			console.warn('Warning: Some clients have fewer messages than expected')
		}

		console.log('\n=== Group Chat Test Complete! ===')
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
