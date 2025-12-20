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
		w.__DISABLE_UPDATER__ = true
		w.process = w.process || {}
		w.process.env = w.process.env || {}
		w.process.env.USE_REAL_INVOKE = 'true'
		w.process.env.DISABLE_UPDATER = '1'
	}, port)
}

async function completeOnboarding(page, email: string, logSocket: WebSocket | null) {
	log(logSocket, { event: 'onboarding-start', email })

	await waitForAppReady(page, { timeout: 30_000 })

	// Check if already onboarded
	const runView = page.locator('#run-view')
	if (await runView.isVisible({ timeout: 1000 }).catch(() => false)) {
		log(logSocket, { event: 'onboarding-already-complete', email })
		return
	}

	// Step 1: Welcome
	await expect(page.locator('#onboarding-step-1')).toBeVisible({ timeout: 5000 })
	await page.locator('#onboarding-next-1').click()

	// Step 2: Dependencies - skip
	await expect(page.locator('#onboarding-step-2')).toBeVisible({ timeout: 5000 })
	page.once('dialog', (dialog) => dialog.accept())
	await page.locator('#skip-dependencies-btn').click()

	// Step 3: Email
	await expect(page.locator('#onboarding-step-3')).toBeVisible({ timeout: 5000 })
	await page.fill('#onboarding-email', email)
	await expect(page.locator('#onboarding-next-3')).toBeEnabled()
	await page.locator('#onboarding-next-3').click()

	// Step 3-key: Key setup
	await expect(page.locator('#onboarding-step-3-key')).toBeVisible({ timeout: 5000 })
	// If the app generated a recovery code, the UI requires an explicit acknowledgement before proceeding.
	const recoveryBlock = page.locator('#onboarding-recovery-block')
	if (await recoveryBlock.isVisible({ timeout: 500 }).catch(() => false)) {
		await page.locator('#onboarding-recovery-ack').check()
	}
	await expect(page.locator('#onboarding-next-3-key')).toBeEnabled({ timeout: 30_000 })
	page.once('dialog', (dialog) => dialog.accept())
	await page.locator('#onboarding-next-3-key').click()

	// Step 4: SyftBox - skip
	await expect(page.locator('#onboarding-step-4')).toBeVisible({ timeout: 30_000 })
	await Promise.all([
		page.waitForNavigation({ waitUntil: 'networkidle' }).catch(() => {}),
		page.locator('#skip-syftbox-btn').click(),
	])

	await expect(page.locator('#run-view')).toBeVisible({ timeout: 10_000 })
	log(logSocket, { event: 'onboarding-complete', email })
}

test.describe('Onboarding two clients @onboarding-two', () => {
	test('complete onboarding for both clients', async ({ browser }) => {
		const wsPort1 = Number.parseInt(process.env.DEV_WS_BRIDGE_PORT_BASE || '3333', 10)
		const wsPort2 = wsPort1 + 1
		const email1 = process.env.CLIENT1_EMAIL || 'client1@sandbox.local'
		const email2 = process.env.CLIENT2_EMAIL || 'client2@sandbox.local'

		const logSocket = await ensureLogSocket()
		log(logSocket, { event: 'onboarding-two-start', email1, email2, wsPort1, wsPort2 })

		const page1 = await browser.newPage()
		const page2 = await browser.newPage()

		await setWsPort(page1, wsPort1)
		await setWsPort(page2, wsPort2)

		await page1.goto(process.env.UI_BASE_URL || 'http://localhost:8082')
		await page2.goto(process.env.UI_BASE_URL || 'http://localhost:8082')

		await completeOnboarding(page1, email1, logSocket)
		await completeOnboarding(page2, email2, logSocket)

		log(logSocket, { event: 'onboarding-two-complete' })

		if (logSocket) {
			await new Promise((resolve) => {
				logSocket.once('close', resolve)
				logSocket.close()
			})
		}
	})
})
