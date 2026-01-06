import { expect, test } from './playwright-fixtures'
import WebSocket from 'ws'
import { waitForAppReady } from './test-helpers.js'

test.describe.configure({ timeout: 120_000 })

async function ensureLogSocket() {
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

async function setWsPort(page, port: number) {
	await page.addInitScript((portNum) => {
		const w = /** @type {any} */ window
		w.__DEV_WS_BRIDGE_PORT__ = portNum
		// Ensure real backend is preferred
		w.process = w.process || {}
		w.process.env = w.process.env || {}
		w.process.env.USE_REAL_INVOKE = 'true'
	}, port)
}

async function connectBackend(port: number) {
	const socket = new WebSocket(`ws://localhost:${port}`)
	await new Promise<void>((resolve, reject) => {
		const timeout = setTimeout(() => {
			reject(new Error(`WS connect timeout on port ${port}`))
		}, 10_000)
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
		} catch (e) {
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

async function waitForMessage(backend: { invoke: any }, target: string, timeoutMs = 60_000) {
	const start = Date.now()
	while (Date.now() - start < timeoutMs) {
		// Force a backend sync; relying on UI auto-refresh can be flaky in headed runs.
		try {
			await backend.invoke('sync_messages_with_failures')
		} catch (_err) {
			// ignore transient sync errors and keep polling
		}
		const threads = await backend.invoke('list_message_threads', { scope: 'all' })
		if (Array.isArray(threads)) {
			for (const thread of threads) {
				const threadId = thread?.thread_id || thread?.threadId || thread?.id
				if (!threadId) continue
				const msgs = await backend.invoke('get_thread_messages', { threadId })
				if (Array.isArray(msgs) && msgs.some((m: any) => (m?.body || '').includes(target))) return
			}
		}
		await new Promise((r) => setTimeout(r, 500))
	}
	throw new Error(`Message not found within timeout: ${target}`)
}

test.describe('Messaging between two clients @messages-two', () => {
	test('clients exchange messages via devstack', async ({ browser }) => {
		const wsPort1 = Number.parseInt(process.env.DEV_WS_BRIDGE_PORT_BASE || '3333', 10)
		const wsPort2 = wsPort1 + 1
		const email1 = process.env.CLIENT1_EMAIL || 'client1@sandbox.local'
		const email2 = process.env.CLIENT2_EMAIL || 'client2@sandbox.local'

		const logSocket = await ensureLogSocket()
		log(logSocket, { event: 'start', email1, email2, wsPort1, wsPort2 })

		const page1 = await browser.newPage()
		const page2 = await browser.newPage()

		await setWsPort(page1, wsPort1)
		await setWsPort(page2, wsPort2)

		const backend1 = await connectBackend(wsPort1)
		const backend2 = await connectBackend(wsPort2)

		await page1.goto(process.env.UI_BASE_URL || 'http://localhost:8082')
		await page2.goto(process.env.UI_BASE_URL || 'http://localhost:8082')

		// Wait for app to be ready (onboarding should be completed by @onboarding-two)
		await waitForAppReady(page1, { timeout: 30_000 })
		await waitForAppReady(page2, { timeout: 30_000 })

		// Ensure dev-mode info is reachable (browser mode relies on this to unlock messaging UI)
		await backend1.invoke('get_dev_mode_info')
		await backend2.invoke('get_dev_mode_info')

		// Import each other as contacts via backend command to skip UI discovery
		await backend1.invoke('network_import_contact', { identity: email2 })
		await backend2.invoke('network_import_contact', { identity: email1 })

		// Navigate to messages and compose
		await page1.locator('.nav-item[data-tab="messages"]').click()
		await page2.locator('.nav-item[data-tab="messages"]').click()
		await expect(page1.locator('#messages-view')).toBeVisible({ timeout: 10_000 })
		await expect(page2.locator('#messages-view')).toBeVisible({ timeout: 10_000 })

		// Wait for messages UI to be unlocked (no auth gate)
		await expect(page1.locator('#messages-syftbox-warning')).toBeHidden({ timeout: 30_000 })
		await expect(page2.locator('#messages-syftbox-warning')).toBeHidden({ timeout: 30_000 })

		const sendFromPage = async (page, recipient, body) => {
			await page.locator('#new-message-btn').click()
			await expect(page.locator('#message-recipient-input')).toBeVisible({ timeout: 10_000 })
			await page.locator('#message-recipient-input').fill(recipient)
			await page.locator('#message-compose-body').fill(body)
			await page.locator('#message-send-btn').click()
		}

		// Send messages both ways
		const msg1 = `hello-from-1-${Date.now()}`
		const msg2 = `hello-from-2-${Date.now()}`

		await sendFromPage(page1, email2, msg1)
		await sendFromPage(page2, email1, msg2)

		await waitForMessage(backend2, msg1, 60_000)
		await waitForMessage(backend1, msg2, 60_000)

		log(logSocket, { event: 'messages-delivered' })

		await backend1.close()
		await backend2.close()

		if (logSocket) {
			await new Promise((resolve) => {
				logSocket.once('close', resolve)
				logSocket.close()
			})
		}
	})
})
