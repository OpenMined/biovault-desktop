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
	await new Promise<void>((resolve) => {
		let settled = false
		const done = () => {
			if (settled) return
			settled = true
			resolve()
		}
		socket.once('open', done)
		socket.once('error', done)
		setTimeout(done, 1500)
	})
	if (socket.readyState !== WebSocket.OPEN) {
		try {
			socket.terminate()
		} catch {}
		return null
	}
	return socket
}

export function log(socket: WebSocket | null, payload: Record<string, unknown>): void {
	if (!socket || socket.readyState !== WebSocket.OPEN) return
	socket.send(JSON.stringify({ timestamp: new Date().toISOString(), ...payload }))
}

export async function setWsPort(page: Page, port: number): Promise<void> {
	const ciFlag = process.env.CI || process.env.GITHUB_ACTIONS || ''
	await page.addInitScript(
		(portNum: number, ci: string) => {
			const w = window as any
			w.__DEV_WS_BRIDGE_PORT__ = portNum
			w.__DISABLE_UPDATER__ = true
			w.process = w.process || {}
			w.process.env = w.process.env || {}
			w.process.env.USE_REAL_INVOKE = 'true'
			w.process.env.DISABLE_UPDATER = '1'
			if (ci) {
				w.process.env.CI = w.process.env.CI || ci
				w.process.env.GITHUB_ACTIONS = w.process.env.GITHUB_ACTIONS || ci
				w.__IS_CI__ = true
			}
		},
		port,
		ciFlag,
	)
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

	const isVisible = async (selector: string, timeout = 1000): Promise<boolean> =>
		page
			.locator(selector)
			.isVisible({ timeout })
			.catch(() => false)
	const waitVisible = async (selector: string, timeout = 1000): Promise<boolean> =>
		page
			.locator(selector)
			.waitFor({ state: 'visible', timeout })
			.then(() => true)
			.catch(() => false)

	for (let pass = 1; pass <= 2; pass += 1) {
		try {
			await waitForAppReady(page, { timeout: 30_000 })
			if (await ensureProfileSelected(page, { timeout: 30_000 })) {
				await waitForAppReady(page, { timeout: 30_000 })
			}

			// The initial HTML ships with the main app layout visible (Run tab active) before the onboarding
			// check completes. Only treat onboarding as "already complete" once the onboarding view is not active.
			const onboardingView = page.locator('#onboarding-view')
			const onboardingActive = await onboardingView.isVisible({ timeout: 1000 }).catch(() => false)
			if (!onboardingActive) {
				log(logSocket, { event: 'onboarding-already-complete', email })
				console.log(`${email}: Already onboarded, skipping`)
				return false
			}

			console.log(`${email}: Starting onboarding... (pass ${pass}/2)`)

			// Step 1: Welcome
			if (await waitVisible('#onboarding-step-1', 8000)) {
				await page.locator('#onboarding-next-1').click()
				await expect(page.locator('#onboarding-step-1')).toBeHidden({ timeout: 8000 })
			}

			// Step 2: Dependencies - skip
			if (await waitVisible('#onboarding-step-2', 5000)) {
				console.log(`${email}: [onboarding] Clicking skip-dependencies-btn...`)
				const step2StartTime = Date.now()
				const skipBtn = page.locator('#skip-dependencies-btn')
				const dialogHandler = async (dialog: any) => {
					console.log(
						`[onboarding] Accepting dialog: ${dialog.type()} - ${dialog.message().slice(0, 50)}`,
					)
					await dialog.accept().catch(() => {})
				}
				page.on('dialog', dialogHandler)
				try {
					for (let attempt = 1; attempt <= 3; attempt++) {
						const clickErr = await skipBtn
							.click({ force: true, timeout: 8_000 })
							.then(() => null)
							.catch((err) => err)
						if (clickErr) {
							console.log(
								`${email}: [onboarding] Step 2 click attempt ${attempt} failed, trying JS fallback`,
							)
							await page
								.evaluate(() => {
									const btn = document.querySelector(
										'#skip-dependencies-btn',
									) as HTMLButtonElement | null
									btn?.click()
								})
								.catch(() => {})
						}

						const step2Hidden = await page
							.locator('#onboarding-step-2')
							.isHidden({ timeout: 12_000 })
							.catch(() => false)
						const step4Visible = await isVisible('#onboarding-step-4', 500)
						const runViewVisible = await isVisible('#run-view', 500)
						if (step2Hidden || step4Visible || runViewVisible) {
							console.log(
								`${email}: [onboarding] Step 2 complete after ${Date.now() - step2StartTime}ms (attempt ${attempt})`,
							)
							break
						}
						console.log(
							`${email}: [onboarding] Step 2 still visible after attempt ${attempt}, retrying...`,
						)
						if (attempt === 3) {
							const step2Html = await page
								.locator('#onboarding-step-2')
								.innerHTML()
								.catch(() => '')
							const onboardingState = await page
								.evaluate(() => ({
									checkComplete: (window as any).__ONBOARDING_CHECK_COMPLETE__ ?? null,
									navReady: (window as any).__NAV_HANDLERS_READY__ ?? null,
									eventReady: (window as any).__EVENT_HANDLERS_READY__ ?? null,
								}))
								.catch(() => null)
							throw new Error(
								`${email}: onboarding step 2 did not advance after 3 attempts (${Date.now() - step2StartTime}ms). ` +
									`state=${JSON.stringify(onboardingState)} step2HtmlPrefix=${step2Html.slice(0, 240)}`,
							)
						}
					}
				} finally {
					page.off('dialog', dialogHandler)
				}
			}

			// Wait for the next onboarding stage to become visible before probing specific sub-steps.
			await page
				.waitForFunction(
					() => {
						const visible = (id: string) => {
							const el = document.querySelector(id) as HTMLElement | null
							if (!el) return false
							return (
								el.offsetParent !== null &&
								window.getComputedStyle(el).display !== 'none' &&
								window.getComputedStyle(el).visibility !== 'hidden'
							)
						}
						return (
							visible('#onboarding-step-3') ||
							visible('#onboarding-step-3-email') ||
							visible('#onboarding-step-3-key') ||
							visible('#onboarding-step-4') ||
							visible('#run-view')
						)
					},
					{ timeout: 20_000 },
				)
				.catch(() => {})

			// Step 3: Choose BioVault Home
			if (await waitVisible('#onboarding-step-3', 5000)) {
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
			}

			// Step 3a: Email
			if (await waitVisible('#onboarding-step-3-email', 20_000)) {
				await page.fill('#onboarding-email', email)
				await expect(page.locator('#onboarding-next-3-email')).toBeEnabled()
				await page.locator('#onboarding-next-3-email').click()
			}

			// Step 3-key: Key setup
			if (await waitVisible('#onboarding-step-3-key', 10_000)) {
				await expect(page.locator('#onboarding-next-3-key')).toBeEnabled({ timeout: 30_000 })
				const recoveryBlock = page.locator('#onboarding-recovery-block')
				if (await recoveryBlock.isVisible().catch(() => false)) {
					await page.locator('#onboarding-recovery-ack').check()
				}
				await page.locator('#onboarding-next-3-key').click()
				await expect(page.locator('#onboarding-step-3-key')).toBeHidden({ timeout: 8000 })
			}

			// Step 4: SyftBox - skip
			const step4StartTime = Date.now()
			if (await waitVisible('#onboarding-step-4', 30_000)) {
				console.log(`${email}: [onboarding] Step 4 visible, clicking skip-syftbox-btn...`)
				await Promise.all([
					page.waitForNavigation({ waitUntil: 'networkidle' }).catch(() => {}),
					page.locator('#skip-syftbox-btn').click(),
				])
				console.log(
					`${email}: [onboarding] Navigation complete after ${Date.now() - step4StartTime}ms, waiting for app ready...`,
				)
			}

			console.log(`${email}: [onboarding] Waiting for onboarding check to complete...`)
			await page.waitForFunction(
				() =>
					(window as any).__ONBOARDING_CHECK_COMPLETE__ === true &&
					(window as any).__NAV_HANDLERS_READY__ === true &&
					(window as any).__EVENT_HANDLERS_READY__ === true,
				{ timeout: 45_000 },
			)
			console.log(
				`${email}: [onboarding] Onboarding check complete after ${Date.now() - step4StartTime}ms`,
			)

			const onboardingStillVisible = await page
				.locator('#onboarding-view')
				.evaluate((el) => {
					return el.classList.contains('active') && window.getComputedStyle(el).display !== 'none'
				})
				.catch(() => false)

			if (onboardingStillVisible) {
				const ciFlag = !!process.env.CI || process.env.GITHUB_ACTIONS === 'true'
				const maxRetries = 12
				for (let attempt = 1; attempt <= maxRetries; attempt += 1) {
					const retryCheck = await page
						.evaluate(async (useLongTimeout) => {
							const invoke = (window as any).__TAURI__?.invoke
							if (!invoke) {
								return { available: false }
							}
							const start = Date.now()
							try {
								const result = await invoke('check_is_onboarded', {
									__wsTimeoutMs: useLongTimeout ? 15000 : 5000,
								})
								return { available: true, result, durationMs: Date.now() - start }
							} catch (err) {
								return { available: true, error: String(err), durationMs: Date.now() - start }
							}
						}, ciFlag)
						.catch(() => null)
					console.log(
						`${email}: [onboarding] check_is_onboarded retry ${attempt}/${maxRetries}:`,
						JSON.stringify(retryCheck),
					)
					if (retryCheck?.available && retryCheck?.result === true) {
						await page.reload({ waitUntil: 'networkidle' }).catch(() => {})
						await waitForAppReady(page, { timeout: 30_000 })
						await expect(page.locator('#run-view')).toBeVisible({ timeout: 30_000 })
						log(logSocket, { event: 'onboarding-complete', email, recovery: 'retry-check' })
						console.log(`${email}: Onboarding complete after retry!`)
						return true
					}
					await page.waitForTimeout(5000)
				}

				const diag = await page
					.evaluate(() => ({
						onboardingCheckComplete: (window as any).__ONBOARDING_CHECK_COMPLETE__,
						navReady: (window as any).__NAV_HANDLERS_READY__,
						eventReady: (window as any).__EVENT_HANDLERS_READY__,
						lastOnboardingCheck: (window as any).__LAST_ONBOARDING_CHECK__,
						ci: (window as any).__IS_CI__ || null,
						envCI: (window as any).process?.env?.CI || null,
						envGithubActions: (window as any).process?.env?.GITHUB_ACTIONS || null,
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
			return true
		} catch (err) {
			if (pass === 2) throw err
			console.log(
				`${email}: [onboarding] pass ${pass} failed; reloading and retrying once. error=${String(err)}`,
			)
			await page.reload({ waitUntil: 'networkidle' }).catch(() => {})
			await waitForAppReady(page, { timeout: 30_000 }).catch(() => {})
		}
	}

	throw new Error(`${email}: onboarding exhausted retries`)
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
