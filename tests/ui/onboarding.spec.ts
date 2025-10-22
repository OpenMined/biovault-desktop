import { expect, test } from '@playwright/test'
import WebSocket from 'ws'

const STORAGE_KEY = 'playwright:onboarded'

let logSocket = null

async function ensureLogSocket() {
	if (logSocket || !process.env.UNIFIED_LOG_WS) return
	logSocket = new WebSocket(process.env.UNIFIED_LOG_WS)
	await new Promise((resolve, reject) => {
		logSocket.once('open', resolve)
		logSocket.once('error', reject)
	})
}

function sendUnifiedLog(payload) {
	if (!logSocket || logSocket.readyState !== WebSocket.OPEN) return
	try {
		logSocket.send(JSON.stringify({ timestamp: new Date().toISOString(), ...payload }))
	} catch (error) {
		// ignore logging errors
	}
}

/**
 * @param {import('@playwright/test').Page} page
 */
async function advanceToEmailStep(page) {
	sendUnifiedLog({ event: 'onboarding-advance-start' })
	await expect(page.locator('#onboarding-step-1')).toBeVisible()
	await page.locator('#onboarding-next-1').click()
	await expect(page.locator('#onboarding-step-2')).toBeVisible()
	page.once('dialog', (dialog) => dialog.accept())
	await page.locator('#skip-dependencies-btn').click()
	await expect(page.locator('#onboarding-step-3')).toBeVisible()
	sendUnifiedLog({ event: 'onboarding-advance-complete' })
}

/**
 * @param {import('@playwright/test').Page} page
 * @param {string} code
 */
async function fillOtp(page, code) {
	const inputs = page.locator('.syftbox-code-input')
	for (const [index, digit] of [...code].entries()) {
		await inputs.nth(index).fill(digit)
	}
}

test.describe('Onboarding flow', () => {
	test.beforeAll(async () => {
		await ensureLogSocket()
	})

	test.afterAll(async () => {
		if (logSocket) {
			await new Promise((resolve) => {
				logSocket.once('close', resolve)
				logSocket.close()
			})
			logSocket = null
		}
	})

	test.beforeEach(async ({ page }) => {
		await ensureLogSocket()
		page.on('console', (msg) => {
			sendUnifiedLog({ source: 'browser', type: msg.type(), text: msg.text() })
		})
		await page.addInitScript(
			({ storageKey }) => {
				const w = /** @type {any} */ window

				/**
				 * @param {{ resetSession?: boolean }} [options]
				 */
				const initState = (options = {}) => {
					if (options.resetSession) {
						window.sessionStorage.removeItem(storageKey)
					}

					w.__TEST_STATE__ = {
						onboarded: window.sessionStorage.getItem(storageKey) === 'true',
						requestCount: 0,
						otp: '12345678',
					}
				}

				w.__INIT_TEST_STATE__ = initState
				initState()

				w.__TEST_INVOKE_OVERRIDE__ = async (cmd, args = {}) => {
					const state =
						/** @type {{ onboarded: boolean; requestCount: number; otp: string }} */ w.__TEST_STATE__
					switch (cmd) {
						case 'check_is_onboarded':
							return state.onboarded
						case 'complete_onboarding':
							state.onboarded = true
							window.sessionStorage.setItem(storageKey, 'true')
							return null
						case 'check_dependencies':
							return {
								dependencies: [
									{
										name: 'Python',
										version: '3.11.0',
										path: '/usr/bin/python3',
										description: 'Python runtime',
										found: true,
										running: true,
									},
								],
							}
						case 'get_saved_dependency_states':
							return { dependencies: [] }
						case 'update_saved_dependency_states':
						case 'open_url':
						case 'install_dependencies':
						case 'check_single_dependency':
						case 'save_custom_path':
						case 'reset_all_data':
						case 'get_participants':
						case 'get_files':
						case 'get_projects':
						case 'get_runs':
						case 'get_command_logs':
						case 'get_settings':
							return null
						case 'syftbox_request_otp':
							state.requestCount += 1
							state.otp = state.requestCount === 1 ? '12345678' : '87654321'
							return { sent: true }
						case 'syftbox_submit_otp': {
							const submitted = args?.code ?? ''
							if (submitted === state.otp) {
								return { success: true }
							}
							throw new Error('Invalid verification code')
						}
						default:
							console.warn('[Playwright] Unhandled invoke command', cmd, args)
							return null
					}
				}
			},
			{ storageKey: STORAGE_KEY },
		)

		sendUnifiedLog({ event: 'test-start', name: 'onboarding' })
		await page.goto('/')
		await page.evaluate(() => {
			const w = /** @type {any} */ window
			w.__INIT_TEST_STATE__?.({ resetSession: true })
		})
	})

	test('skipping SyftBox reaches the home screen', async ({ page }) => {
		await advanceToEmailStep(page)
		await page.fill('#onboarding-email', 'tester@example.com')
		await expect(page.locator('#onboarding-next-3')).toBeEnabled()
		await page.locator('#onboarding-next-3').click()
		await expect(page.locator('#onboarding-step-4')).toBeVisible()

		await Promise.all([
			page.waitForNavigation({ waitUntil: 'networkidle' }),
			page.locator('#skip-syftbox-btn').click(),
		])

		await expect(page.locator('#home-view')).toBeVisible()
		await expect(page.locator('#onboarding-view')).toBeHidden()
		await expect(page.getByRole('heading', { name: 'BioVault' })).toBeVisible()
		const sessionFlag = await page.evaluate(
			(key) => window.sessionStorage.getItem(key),
			STORAGE_KEY,
		)
		expect(sessionFlag).toBe('true')
	})

	test('OTP retry rejects invalid code then accepts the resend', async ({ page }) => {
		await advanceToEmailStep(page)
		await page.fill('#onboarding-email', 'tester@example.com')
		await page.locator('#onboarding-next-3').click()
		await expect(page.locator('#onboarding-step-4')).toBeVisible()

		await page.locator('#syftbox-info-continue-btn').click()
		await expect(page.locator('#syftbox-email-info')).toBeVisible()
		await page.locator('#send-login-code-btn').click()
		await expect(page.locator('#syftbox-otp-state')).toBeVisible()

		await fillOtp(page, '00000000')
		await page.locator('#verify-code-btn').click()
		const errorMessage = page.locator('#syftbox-error-message')
		await expect(errorMessage).toHaveText('Invalid verification code. Please try again.')

		// Set up dialog handler BEFORE clicking resend button
		page.once('dialog', (dialog) => dialog.accept())
		await page.locator('#resend-code-btn').click()

		// Wait for inputs to be cleared (confirmation that resend worked)
		const inputs = page.locator('.syftbox-code-input')
		await expect(inputs.first()).toHaveValue('')
		await expect(page.locator('#verify-code-btn')).toBeDisabled()

		const nextOtp = await page.evaluate(() => {
			const w = /** @type {any} */ window
			return w.__TEST_STATE__?.otp ?? ''
		})
		expect(nextOtp).toHaveLength(8)
		await fillOtp(page, nextOtp)
		await expect(page.locator('#verify-code-btn')).toBeEnabled()

		await Promise.all([
			page.waitForNavigation({ waitUntil: 'networkidle' }),
			page.locator('#verify-code-btn').click(),
		])

		await expect(page.locator('#home-view')).toBeVisible()
		await expect(page.locator('#onboarding-view')).toBeHidden()
		const sessionFlag = await page.evaluate(
			(key) => window.sessionStorage.getItem(key),
			STORAGE_KEY,
		)
		expect(sessionFlag).toBe('true')
	})
})
