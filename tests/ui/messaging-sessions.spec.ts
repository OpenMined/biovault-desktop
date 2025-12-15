/**
 * Comprehensive Messaging and Sessions UI Test
 * @tag messaging-sessions
 */
import { expect, test } from '@playwright/test'
import WebSocket from 'ws'
import { waitForAppReady } from './test-helpers.js'

// Fast timeouts for dev - things should happen quickly
const TEST_TIMEOUT = 60_000
const SYNC_TIMEOUT = 15_000
const UI_TIMEOUT = 5_000

test.describe.configure({ timeout: TEST_TIMEOUT })

interface Backend {
	invoke: (cmd: string, args?: Record<string, unknown>) => Promise<any>
	close: () => Promise<void>
}

async function ensureLogSocket(): Promise<WebSocket | null> {
	if (!process.env.UNIFIED_LOG_WS) return null
	const socket = new WebSocket(process.env.UNIFIED_LOG_WS)
	await new Promise((resolve, reject) => {
		socket.once('open', resolve)
		socket.once('error', reject)
	})
	return socket
}

function log(socket: WebSocket | null, payload: Record<string, unknown>) {
	if (!socket || socket.readyState !== WebSocket.OPEN) return
	socket.send(JSON.stringify({ timestamp: new Date().toISOString(), ...payload }))
}

async function setWsPort(page: any, port: number) {
	await page.addInitScript((portNum: number) => {
		const w = window as any
		w.__DEV_WS_BRIDGE_PORT__ = portNum
		w.process = w.process || {}
		w.process.env = w.process.env || {}
		w.process.env.USE_REAL_INVOKE = 'true'
	}, port)
}

async function connectBackend(port: number): Promise<Backend> {
	const socket = new WebSocket(`ws://localhost:${port}`)
	await new Promise<void>((resolve, reject) => {
		const timeout = setTimeout(() => reject(new Error(`WS connect timeout on port ${port}`)), 5_000)
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

	function invoke(cmd: string, args: Record<string, unknown> = {}) {
		const id = ++nextId
		socket.send(JSON.stringify({ id, cmd, args }))
		return new Promise<any>((resolve, reject) => {
			pending.set(id, { resolve, reject })
			setTimeout(() => {
				if (!pending.has(id)) return
				pending.delete(id)
				reject(new Error(`WS invoke timeout: ${cmd}`))
			}, 10_000)
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

async function syncAndWaitForMessage(
	backend: Backend,
	target: string,
	timeoutMs = SYNC_TIMEOUT,
): Promise<any> {
	const start = Date.now()
	while (Date.now() - start < timeoutMs) {
		try {
			await backend.invoke('sync_messages_with_failures')
		} catch {
			/* ignore */
		}
		const threads = await backend.invoke('list_message_threads', { scope: 'all' })
		if (Array.isArray(threads)) {
			for (const thread of threads) {
				const threadId = thread?.thread_id || thread?.threadId || thread?.id
				if (!threadId) continue
				const msgs = await backend.invoke('get_thread_messages', { threadId })
				if (Array.isArray(msgs)) {
					const found = msgs.find((m: any) => (m?.body || '').includes(target))
					if (found) return found
				}
			}
		}
		await new Promise((r) => setTimeout(r, 300))
	}
	throw new Error(`Message not found within timeout: ${target}`)
}

async function waitForSessionInvite(backend: Backend, timeoutMs = SYNC_TIMEOUT): Promise<any> {
	const start = Date.now()
	while (Date.now() - start < timeoutMs) {
		try {
			await backend.invoke('sync_messages_with_failures')
		} catch {
			/* ignore */
		}
		const invitations = await backend.invoke('get_session_invitations')
		if (Array.isArray(invitations) && invitations.length > 0) return invitations[0]
		await new Promise((r) => setTimeout(r, 300))
	}
	throw new Error('Session invitation not found within timeout')
}

test.describe('Comprehensive Messaging & Sessions @messaging-sessions', () => {
	test('messaging and session workflow', async ({ browser }) => {
		const wsPort1 = Number.parseInt(process.env.DEV_WS_BRIDGE_PORT_BASE || '3333', 10)
		const wsPort2 = wsPort1 + 1
		const email1 = process.env.CLIENT1_EMAIL || 'client1@sandbox.local'
		const email2 = process.env.CLIENT2_EMAIL || 'client2@sandbox.local'

		const logSocket = await ensureLogSocket()
		log(logSocket, { event: 'start', email1, email2 })

		const page1 = await browser.newPage()
		const page2 = await browser.newPage()

		await setWsPort(page1, wsPort1)
		await setWsPort(page2, wsPort2)

		const backend1 = await connectBackend(wsPort1)
		const backend2 = await connectBackend(wsPort2)

		await page1.goto(process.env.UI_BASE_URL || 'http://localhost:8082')
		await page2.goto(process.env.UI_BASE_URL || 'http://localhost:8082')

		await waitForAppReady(page1, { timeout: 10_000 })
		await waitForAppReady(page2, { timeout: 10_000 })

		await backend1.invoke('get_dev_mode_info')
		await backend2.invoke('get_dev_mode_info')

		// Import contacts
		await backend1.invoke('network_import_contact', { identity: email2 })
		await backend2.invoke('network_import_contact', { identity: email1 })
		log(logSocket, { event: 'contacts-imported' })

		// Verify contacts have keys before proceeding
		const contact1Check = await backend1.invoke('key_check_contact', { email: email2 })
		const contact2Check = await backend2.invoke('key_check_contact', { email: email1 })
		expect(contact1Check.has_key).toBe(true)
		expect(contact2Check.has_key).toBe(true)
		log(logSocket, {
			event: 'contacts-verified',
			c1HasKey: contact1Check.has_key,
			c2HasKey: contact2Check.has_key,
		})

		// ============================================================
		// PHASE 1: Send message and verify threading
		// ============================================================
		log(logSocket, { event: 'phase1-start' })

		await page1.locator('.nav-item[data-tab="messages"]').click()
		await page2.locator('.nav-item[data-tab="messages"]').click()
		await expect(page1.locator('#messages-view')).toBeVisible({ timeout: UI_TIMEOUT })
		await expect(page2.locator('#messages-view')).toBeVisible({ timeout: UI_TIMEOUT })

		await expect(page1.locator('#messages-syftbox-warning')).toBeHidden({ timeout: 10_000 })
		await expect(page2.locator('#messages-syftbox-warning')).toBeHidden({ timeout: 10_000 })

		// Client1 sends message
		const msg1 = `Hello from client1! This is a test message about genomics research collaboration. Timestamp: ${Date.now()}`
		await page1.locator('#new-message-btn').click()
		await expect(page1.locator('#message-recipient-input')).toBeVisible({ timeout: UI_TIMEOUT })
		await page1.locator('#message-recipient-input').fill(email2)
		await page1.locator('#message-compose-body').fill(msg1)
		await page1.locator('#message-send-btn').click()

		// Wait for the message to appear in client1's conversation (confirming send succeeded)
		await expect(
			page1.locator('.message-bubble-body').filter({ hasText: 'Hello from client1' }),
		).toBeVisible({ timeout: 10_000 })

		// Sync at client1 to push the message out
		await backend1.invoke('sync_messages_with_failures')

		// Wait for message at client2
		const receivedMsg = await syncAndWaitForMessage(backend2, msg1)
		expect(receivedMsg.thread_id).toBeTruthy()
		const threadId = receivedMsg.thread_id
		log(logSocket, { event: 'message-received', threadId })

		// Client2 clicks refresh to load the new thread in UI
		await page2.locator('#refresh-messages-btn').click()
		await page2.waitForTimeout(500)

		// Client2 clicks thread and replies
		await expect(page2.locator('.message-thread-item').first()).toBeVisible({ timeout: 10_000 })
		await page2.locator('.message-thread-item').first().click()
		await expect(page2.locator('#message-compose-body')).toBeVisible({ timeout: UI_TIMEOUT })

		// Wait a bit for the thread to fully load
		await page2.waitForTimeout(500)

		const msg2 = `Reply from client2! Great to hear about your genomics work. Let's set up a collaborative session. Timestamp: ${Date.now()}`
		await page2.locator('#message-compose-body').click()
		await page2.locator('#message-compose-body').fill(msg2)

		// Verify the message was filled
		await expect(page2.locator('#message-compose-body')).toHaveValue(msg2)

		await page2.locator('#message-send-btn').click()

		// Wait for the reply to appear in client2's conversation (confirming send succeeded)
		await expect(
			page2.locator('.message-bubble-body').filter({ hasText: 'Reply from client2' }),
		).toBeVisible({ timeout: 10_000 })

		// Sync at client2 to push the message out
		await backend2.invoke('sync_messages_with_failures')
		await page2.waitForTimeout(500)

		// Verify reply at client1
		const receivedReply = await syncAndWaitForMessage(backend1, msg2)
		expect(receivedReply.thread_id).toBe(threadId)
		log(logSocket, { event: 'phase1-complete' })

		// ============================================================
		// PHASE 2: Create session and accept invitation
		// ============================================================
		log(logSocket, { event: 'phase2-start' })

		await page1.locator('.nav-item[data-tab="sessions"]').click()
		await expect(page1.locator('.sessions-container')).toBeVisible({ timeout: UI_TIMEOUT })

		// Create session
		await page1.locator('#new-session-btn').click()
		await expect(page1.locator('#create-session-modal')).toBeVisible({ timeout: UI_TIMEOUT })

		const sessionName = `Genomics-Collab-${Date.now()}`
		await page1.locator('#session-name-input').fill(sessionName)
		await page1.locator('#session-peer-input').fill(email2)
		await page1.locator('#confirm-create-session-btn').click()
		await expect(page1.locator('#create-session-modal')).toBeHidden({ timeout: UI_TIMEOUT })
		log(logSocket, { event: 'session-created', name: sessionName })

		// Client2 waits for invitation
		await page2.locator('.nav-item[data-tab="sessions"]').click()
		await expect(page2.locator('.sessions-container')).toBeVisible({ timeout: UI_TIMEOUT })

		const invitation = await waitForSessionInvite(backend2)
		log(logSocket, { event: 'invitation-received', sessionId: invitation.session_id })

		// Refresh and accept
		await page2.locator('#refresh-sessions-btn').click()
		await page2.waitForTimeout(1000)

		await expect(page2.locator('[data-action="accept-invite"]').first()).toBeVisible({
			timeout: 10_000,
		})
		await page2.locator('[data-action="accept-invite"]').first().click()
		await page2.waitForTimeout(2000)

		// Verify session exists
		const sessions2 = await backend2.invoke('get_sessions')
		const acceptedSession = sessions2.find((s: any) => s.session_id === invitation.session_id)
		expect(acceptedSession).toBeTruthy()
		log(logSocket, { event: 'phase2-complete' })

		// ============================================================
		// PHASE 3: Verify all messages in Messages tab
		// ============================================================
		log(logSocket, { event: 'phase3-start' })

		await page1.locator('.nav-item[data-tab="messages"]').click()
		await expect(page1.locator('#messages-view')).toBeVisible({ timeout: UI_TIMEOUT })

		await backend1.invoke('sync_messages_with_failures')
		const allThreads = await backend1.invoke('list_message_threads', { scope: 'all' })
		expect(allThreads.length).toBeGreaterThanOrEqual(1)
		log(logSocket, { event: 'phase3-complete', threadCount: allThreads.length })

		// Cleanup
		await backend1.close()
		await backend2.close()
		if (logSocket) {
			await new Promise<void>((resolve) => {
				logSocket.once('close', () => resolve())
				logSocket.close()
			})
		}

		log(logSocket, { event: 'test-complete' })
	})
})
