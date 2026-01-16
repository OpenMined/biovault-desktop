/**
 * Shared onboarding helper for UI tests
 * Can be used by both standalone onboarding tests and tests that need onboarding as a prerequisite
 */
import { expect, type Page } from '@playwright/test'
import WebSocket from 'ws'
import { ensureProfileSelected, waitForAppReady } from './test-helpers.js'

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

	// Set up a persistent dialog handler that accepts all dialogs during onboarding.
	// This is more robust than page.once() which can miss dialogs due to timing.
	const dialogHandler = (dialog: import('@playwright/test').Dialog) => {
		console.log(
			`[onboarding] Accepting dialog: ${dialog.type()} - ${dialog.message().slice(0, 50)}`,
		)
		dialog.accept().catch(() => {})
	}
	page.on('dialog', dialogHandler)

	try {
		await waitForAppReady(page, { timeout: 30_000 })
		if (await ensureProfileSelected(page, { timeout: 30_000 })) {
			await waitForAppReady(page, { timeout: 30_000 })
		}

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
		console.log(`${email}: [onboarding] Clicking skip-dependencies-btn...`)
		const step2StartTime = Date.now()
		await page.locator('#skip-dependencies-btn').click()
		// Wait for step 2 to be hidden before checking step 3
		// Increased timeout: dialog acceptance + invoke('update_saved_dependency_states') can take time in CI
		await expect(page.locator('#onboarding-step-2')).toBeHidden({ timeout: 30000 })
		console.log(`${email}: [onboarding] Step 2 hidden after ${Date.now() - step2StartTime}ms`)

		// Step 3: Choose BioVault Home
		await expect(page.locator('#onboarding-step-3')).toBeVisible({ timeout: 5000 })
		const homeInput = page.locator('#onboarding-home')
		await expect(homeInput).toBeVisible({ timeout: 10_000 })
		if (!(await homeInput.inputValue()).trim()) {
			// Home defaults are populated asynchronously; try to pull them directly if still empty.
			const fallbackHome = await page.evaluate(async () => {
				try {
					const invoke = (window as any)?.__TAURI__?.invoke
					if (!invoke) return ''
					const value = await invoke('profiles_get_default_home')
					return typeof value === 'string' ? value : ''
				} catch (_err) {
					return ''
				}
			})
			if (fallbackHome) {
				await homeInput.fill(fallbackHome)
			}
		}
		await expect(homeInput).toHaveValue(/.+/, { timeout: 20_000 })
		await page.locator('#onboarding-next-3').click()
		// Wait for step 3-email to be visible (home check can take time in CI).
		await expect(page.locator('#onboarding-step-3-email')).toBeVisible({ timeout: 20_000 })

		// Step 3a: Email
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
		await page.locator('#onboarding-next-3-key').click()
		// Wait for step 3-key to be hidden before checking step 4
		await expect(page.locator('#onboarding-step-3-key')).toBeHidden({ timeout: 5000 })

		// Step 4: SyftBox - skip
		await expect(page.locator('#onboarding-step-4')).toBeVisible({ timeout: 30_000 })
		console.log(`${email}: [onboarding] Step 4 visible, clicking skip-syftbox-btn...`)
		const step4StartTime = Date.now()
		await Promise.all([
			page.waitForNavigation({ waitUntil: 'networkidle' }).catch(() => {}),
			page.locator('#skip-syftbox-btn').click(),
		])
		console.log(
			`${email}: [onboarding] Navigation complete after ${Date.now() - step4StartTime}ms, waiting for app ready...`,
		)

		// On a fresh install, completing onboarding triggers a full page reload.
		// Wait for the onboarding check to complete (not just for onboarding to be visible).
		// After successful complete_onboarding, check_is_onboarded should return true and
		// the app should show run-view instead of onboarding-view.
		console.log(`${email}: [onboarding] Waiting for onboarding check to complete...`)
		await page.waitForFunction(
			() =>
				(window as any).__ONBOARDING_CHECK_COMPLETE__ === true &&
				(window as any).__NAV_HANDLERS_READY__ === true &&
				(window as any).__EVENT_HANDLERS_READY__ === true,
			{ timeout: 30_000 },
		)
		console.log(
			`${email}: [onboarding] Onboarding check complete after ${Date.now() - step4StartTime}ms`,
		)

		// Now check if the app transitioned to the main view or stayed on onboarding
		const onboardingStillVisible = await page
			.locator('#onboarding-view')
			.evaluate((el) => {
				return el.classList.contains('active') && window.getComputedStyle(el).display !== 'none'
			})
			.catch(() => false)

		if (onboardingStillVisible) {
			// Get diagnostic info from the page's console output
			const diag = await page
				.evaluate(() => ({
					onboardingCheckComplete: (window as any).__ONBOARDING_CHECK_COMPLETE__,
					navReady: (window as any).__NAV_HANDLERS_READY__,
					eventReady: (window as any).__EVENT_HANDLERS_READY__,
					url: window.location.href,
				}))
				.catch(() => null)
			console.log(`${email}: [onboarding] Page state:`, JSON.stringify(diag))
			throw new Error(
				`Onboarding still visible after complete_onboarding and page reload. ` +
					`This usually means check_is_onboarded returned false. ` +
					`Page state: ${JSON.stringify(diag)}`,
			)
		}

		await expect(page.locator('#run-view')).toBeVisible({ timeout: 30_000 })
		console.log(
			`${email}: [onboarding] run-view visible after ${Date.now() - step4StartTime}ms total`,
		)
		log(logSocket, { event: 'onboarding-complete', email })
		console.log(`${email}: Onboarding complete!`)
		return true // Onboarding was performed
	} finally {
		// Clean up the dialog handler
		page.off('dialog', dialogHandler)
	}
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
