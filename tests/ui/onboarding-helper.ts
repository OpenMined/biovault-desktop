/**
 * Shared onboarding helper for UI tests
 * Can be used by both standalone onboarding tests and tests that need onboarding as a prerequisite
 */
import { expect, type Page } from '@playwright/test'
import WebSocket from 'ws'
import { waitForAppReady } from './test-helpers.js'

export async function ensureLogSocket(): Promise<WebSocket | null> {
	if (!process.env.UNIFIED_LOG_WS) return null
	const socket = new WebSocket(process.env.UNIFIED_LOG_WS)
	await new Promise<void>((resolve, reject) => {
		socket.once('open', resolve)
		socket.once('error', reject)
	})
	return socket
}

export function log(socket: WebSocket | null, payload: Record<string, unknown>): void {
	if (!socket || socket.readyState !== WebSocket.OPEN) return
	socket.send(JSON.stringify({ timestamp: new Date().toISOString(), ...payload }))
}

export async function setWsPort(page: Page, port: number): Promise<void> {
	await page.addInitScript((portNum: number) => {
		const w = window as any
		w.__DEV_WS_BRIDGE_PORT__ = portNum
		w.__DISABLE_UPDATER__ = true
		w.process = w.process || {}
		w.process.env = w.process.env || {}
		w.process.env.USE_REAL_INVOKE = 'true'
		w.process.env.DISABLE_UPDATER = '1'
	}, port)
}

/**
 * Complete onboarding for a single client
 * Skips if already onboarded (detects #run-view)
 */
export async function completeOnboarding(
	page: Page,
	email: string,
	logSocket: WebSocket | null = null,
): Promise<boolean> {
	log(logSocket, { event: 'onboarding-start', email })

	await waitForAppReady(page, { timeout: 30_000 })

	// The initial HTML ships with the main app layout visible (Run tab active) before the onboarding
	// check completes. Only treat onboarding as "already complete" once the onboarding view is not
	// active/visible.
	const onboardingView = page.locator('#onboarding-view')
	const onboardingActive = await onboardingView.isVisible({ timeout: 1000 }).catch(() => false)
	if (!onboardingActive) {
		log(logSocket, { event: 'onboarding-already-complete', email })
		console.log(`${email}: Already onboarded, skipping`)
		return false // Already onboarded
	}

	console.log(`${email}: Starting onboarding...`)

	// Step 1: Welcome
	await expect(page.locator('#onboarding-step-1')).toBeVisible({ timeout: 5000 })
	await page.locator('#onboarding-next-1').click()
	// Wait for step 1 to be hidden before checking step 2
	await expect(page.locator('#onboarding-step-1')).toBeHidden({ timeout: 5000 })

	// Step 2: Dependencies - skip
	await expect(page.locator('#onboarding-step-2')).toBeVisible({ timeout: 5000 })
	page.once('dialog', (dialog) => dialog.accept())
	await page.locator('#skip-dependencies-btn').click()
	// Wait for step 2 to be hidden before checking step 3
	await expect(page.locator('#onboarding-step-2')).toBeHidden({ timeout: 5000 })

	// Step 3: Choose BioVault Home
	await expect(page.locator('#onboarding-step-3')).toBeVisible({ timeout: 5000 })
	await page.locator('#onboarding-next-3').click()
	// Wait for step 3 to be hidden before checking step 3-key
	await expect(page.locator('#onboarding-step-3')).toBeHidden({ timeout: 5000 })

	// Step 3a: Email
	await expect(page.locator('#onboarding-step-3-email')).toBeVisible({ timeout: 5000 })
	await page.fill('#onboarding-email', email)
	await expect(page.locator('#onboarding-next-3-email')).toBeEnabled()
	await page.locator('#onboarding-next-3-email').click()

	// Step 3-key: Key setup
	await expect(page.locator('#onboarding-step-3-key')).toBeVisible({ timeout: 5000 })
	await expect(page.locator('#onboarding-next-3-key')).toBeEnabled({ timeout: 30_000 })
	// If the app generated a recovery code, the UI requires an explicit acknowledgement before proceeding.
	const recoveryBlock = page.locator('#onboarding-recovery-block')
	if (await recoveryBlock.isVisible().catch(() => false)) {
		await page.locator('#onboarding-recovery-ack').check()
	}
	page.once('dialog', (dialog) => dialog.accept())
	await page.locator('#onboarding-next-3-key').click()
	// Wait for step 3-key to be hidden before checking step 4
	await expect(page.locator('#onboarding-step-3-key')).toBeHidden({ timeout: 5000 })

	// Step 4: SyftBox - skip
	await expect(page.locator('#onboarding-step-4')).toBeVisible({ timeout: 30_000 })
	await Promise.all([
		page.waitForNavigation({ waitUntil: 'networkidle' }).catch(() => {}),
		page.locator('#skip-syftbox-btn').click(),
	])

	await expect(page.locator('#run-view')).toBeVisible({ timeout: 10_000 })
	// On a fresh install, completing onboarding triggers a full page reload. Ensure the app
	// finished re-initializing (nav/event handlers ready) before proceeding with tests.
	await waitForAppReady(page, { timeout: 30_000 })
	log(logSocket, { event: 'onboarding-complete', email })
	console.log(`${email}: Onboarding complete!`)
	return true // Onboarding was performed
}

/**
 * Ensure both clients are onboarded
 * Returns the pages for continued use
 */
export async function ensureBothClientsOnboarded(
	page1: Page,
	page2: Page,
	email1: string,
	email2: string,
	logSocket: WebSocket | null = null,
): Promise<{ onboarded1: boolean; onboarded2: boolean }> {
	log(logSocket, { event: 'ensure-onboarding-start', email1, email2 })

	const onboarded1 = await completeOnboarding(page1, email1, logSocket)
	const onboarded2 = await completeOnboarding(page2, email2, logSocket)

	log(logSocket, { event: 'ensure-onboarding-complete', onboarded1, onboarded2 })
	return { onboarded1, onboarded2 }
}
