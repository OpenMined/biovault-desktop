import { expect, test } from './playwright-fixtures'
import WebSocket from 'ws'
import { waitForAppReady } from './test-helpers.js'

test.describe.configure({ timeout: 240_000 })

async function setWsPort(page, port: number) {
	await page.addInitScript((portNum) => {
		const w = /** @type {any} */ window
		w.__DEV_WS_BRIDGE_PORT__ = portNum
		w.process = w.process || {}
		w.process.env = w.process.env || {}
		w.process.env.USE_REAL_INVOKE = 'true'
	}, port)
}

async function connectBackend(port: number) {
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

	function invoke(cmd: string, args: Record<string, unknown> = {}) {
		const id = ++nextId
		socket.send(JSON.stringify({ id, cmd, args }))
		return new Promise<any>((resolve, reject) => {
			pending.set(id, { resolve, reject })
			setTimeout(() => {
				if (!pending.has(id)) return
				pending.delete(id)
				reject(new Error(`WS invoke timeout: ${cmd}`))
			}, 30_000)
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

async function collectAllMessages(backend: { invoke: any }) {
	const threads = await backend.invoke('list_message_threads', { scope: 'all' })
	const out: any[] = []
	if (!Array.isArray(threads)) return out
	for (const thread of threads) {
		const threadId = thread?.thread_id || thread?.threadId || thread?.id
		if (!threadId) continue
		const msgs = await backend.invoke('get_thread_messages', { threadId })
		if (Array.isArray(msgs)) out.push(...msgs)
	}
	return out
}

async function waitFor(predicate: () => Promise<boolean>, timeoutMs = 60_000) {
	const start = Date.now()
	while (Date.now() - start < timeoutMs) {
		if (await predicate()) return
		await new Promise((r) => setTimeout(r, 500))
	}
	throw new Error('Timed out waiting for condition')
}

test('Messaging core scenario shows up in UI @messaging-core-ui', async ({ browser }) => {
	const wsPort1 = Number.parseInt(process.env.DEV_WS_BRIDGE_PORT_BASE || '3333', 10)
	const wsPort2 = wsPort1 + 1
	const email1 = process.env.CLIENT1_EMAIL || 'client1@sandbox.local'
	const email2 = process.env.CLIENT2_EMAIL || 'client2@sandbox.local'

	const page1 = await browser.newPage()
	const page2 = await browser.newPage()
	await setWsPort(page1, wsPort1)
	await setWsPort(page2, wsPort2)

	const backend1 = await connectBackend(wsPort1)
	const backend2 = await connectBackend(wsPort2)

	await page1.goto(process.env.UI_BASE_URL || 'http://localhost:8082')
	await page2.goto(process.env.UI_BASE_URL || 'http://localhost:8082')

	await waitForAppReady(page1, { timeout: 30_000 })
	await waitForAppReady(page2, { timeout: 30_000 })

	await page1.locator('.nav-item[data-tab="messages"]').click()
	await page2.locator('.nav-item[data-tab="messages"]').click()
	await expect(page1.locator('#messages-view')).toBeVisible({ timeout: 10_000 })
	await expect(page2.locator('#messages-view')).toBeVisible({ timeout: 10_000 })

	// Dev mode should bypass auth gating.
	await expect(page1.locator('#messages-syftbox-warning')).toBeHidden({ timeout: 30_000 })
	await expect(page2.locator('#messages-syftbox-warning')).toBeHidden({ timeout: 30_000 })

	// Ensure the expected “thread test” messages exist on both sides.
	await waitFor(async () => {
		await backend1.invoke('sync_messages_with_failures').catch(() => {})
		await backend2.invoke('sync_messages_with_failures').catch(() => {})
		const msgs1 = await collectAllMessages(backend1)
		const msgs2 = await collectAllMessages(backend2)
		const hasThreadSubject1 = msgs1.some((m) => m?.subject === 'Thread Test')
		const hasThreadSubject2 = msgs2.some((m) => m?.subject === 'Thread Test')
		const hasHello1 = msgs1.some((m) =>
			(m?.body || '').includes('Hello from client1 (thread test)'),
		)
		const hasReply1 = msgs1.some((m) =>
			(m?.body || '').includes('Reply from client2 (thread test)'),
		)
		return hasThreadSubject1 && hasThreadSubject2 && hasHello1 && hasReply1
	})

	// Sanity: ensure session-related messages exist (invite response + chat).
	await waitFor(async () => {
		await backend1.invoke('sync_messages_with_failures').catch(() => {})
		await backend2.invoke('sync_messages_with_failures').catch(() => {})
		const msgs1 = await collectAllMessages(backend1)
		const msgs2 = await collectAllMessages(backend2)

		const acceptInvite = msgs2.find(
			(m) => m?.metadata?.session_invite?.session_name === 'Scenario Session Accept',
		)
		const acceptId = acceptInvite?.metadata?.session_invite?.session_id
		if (!acceptId) return false

		const accepted = msgs1.some(
			(m) =>
				m?.metadata?.session_invite_response?.session_id === acceptId &&
				m?.metadata?.session_invite_response?.status === 'accepted',
		)
		const ownerChat = msgs2.some(
			(m) =>
				m?.metadata?.session_chat?.session_id === acceptId &&
				(m?.body || '').includes('hello from owner'),
		)
		const peerChat = msgs1.some(
			(m) =>
				m?.metadata?.session_chat?.session_id === acceptId &&
				(m?.body || '').includes('hello from peer'),
		)

		return accepted && ownerChat && peerChat
	})

	// Key rotation message should be present at client1.
	await waitFor(async () => {
		await backend1.invoke('sync_messages_with_failures').catch(() => {})
		const msgs1 = await collectAllMessages(backend1)
		return msgs1.some((m) => m?.from === email2 && m?.subject === 'Key Rotation')
	})

	await backend1.close()
	await backend2.close()
})
