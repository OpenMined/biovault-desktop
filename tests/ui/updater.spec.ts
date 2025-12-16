import { expect, test } from '@playwright/test'

test.describe('Updater', () => {
	test.beforeEach(async ({ page }) => {
		// Mark as onboarded to skip onboarding
		await page.addInitScript(() => {
			window.__TEST_INVOKE_OVERRIDE__ = (cmd) => {
				if (cmd === 'check_is_onboarded') return true
				if (cmd === 'get_app_version') return '0.1.4'
				return undefined
			}
		})

		await page.goto('/', { timeout: 15_000 })
		await page.waitForLoadState('domcontentloaded')
	})

	test('should show version in Settings', async ({ page }) => {
		// Navigate to Settings
		await page.click('[data-tab="settings"]')
		await expect(page.locator('#settings-view')).toBeVisible()

		// Check version is displayed
		const versionEl = page.locator('#app-version')
		await expect(versionEl).toBeVisible()
		await expect(versionEl).toHaveText('v0.1.4')
	})

	test('should show "View all releases" link', async ({ page }) => {
		// Navigate to Settings
		await page.click('[data-tab="settings"]')
		await expect(page.locator('#settings-view')).toBeVisible()

		// Check link is present
		const link = page.locator('a[href*="github.com"][href*="/releases"]')
		await expect(link).toBeVisible()
		await expect(link).toContainText('View all releases')
	})

	test('should show "no updates" when running latest version', async ({ page }) => {
		// Mock the Tauri updater API to return null (no update available)
		await page.evaluate(() => {
			if (!window.__TAURI__) {
				window.__TAURI__ = {
					updater: {},
					dialog: {},
					process: {},
				}
			}

			window.__TAURI__.updater.check = async () => {
				console.log('[Mock] updater.check returning null (no update)')
				return null
			}

			window.__TAURI__.dialog.message = async (msg, options) => {
				console.log('[Mock] dialog.message:', msg, options)
				// Store the message for assertion
				window.__lastDialogMessage = { msg, options }
			}
		})

		// Navigate to Settings
		await page.click('[data-tab="settings"]')
		await expect(page.locator('#settings-view')).toBeVisible()

		// Click "Check for Updates" button
		await page.click('#check-updates-btn')

		// Wait for the dialog message to be called
		await page.waitForFunction(() => window.__lastDialogMessage !== undefined, { timeout: 5000 })

		// Verify the message
		const dialogMessage = await page.evaluate(() => window.__lastDialogMessage)
		expect(dialogMessage.msg).toContain('latest version')
	})

	test('should show update dialog when update is available', async ({ page }) => {
		// Mock the Tauri updater API to return an update
		await page.evaluate(() => {
			if (!window.__TAURI__) {
				window.__TAURI__ = {
					updater: {},
					dialog: {},
					process: {},
				}
			}

			window.__TAURI__.updater.check = async () => {
				console.log('[Mock] updater.check returning update')
				return {
					version: '0.1.5',
					body: 'Test release notes',
					downloadAndInstall: async (callback) => {
						console.log('[Mock] downloadAndInstall called')
						// Simulate download events
						callback({ event: 'Started', data: { contentLength: 1000 } })
						callback({ event: 'Progress', data: { chunkLength: 500 } })
						callback({ event: 'Progress', data: { chunkLength: 500 } })
						callback({ event: 'Finished' })
					},
				}
			}

			window.__TAURI__.dialog.ask = async (msg, options) => {
				console.log('[Mock] dialog.ask:', msg, options)
				window.__lastAskDialog = { msg, options }
				// Simulate user clicking "No"
				return false
			}

			window.__TAURI__.dialog.message = async (msg, options) => {
				console.log('[Mock] dialog.message:', msg, options)
				window.__lastDialogMessage = { msg, options }
			}
		})

		// Navigate to Settings
		await page.click('[data-tab="settings"]')
		await expect(page.locator('#settings-view')).toBeVisible()

		// Click "Check for Updates" button
		await page.click('#check-updates-btn')

		// Wait for the ask dialog to be called
		await page.waitForFunction(() => window.__lastAskDialog !== undefined, { timeout: 5000 })

		// Verify the ask dialog
		const askDialog = await page.evaluate(() => window.__lastAskDialog)
		expect(askDialog.msg).toContain('0.1.5')
		expect(askDialog.msg).toContain('Test release notes')
	})

	test('should handle update check errors gracefully', async ({ page }) => {
		// Listen for console errors
		const consoleErrors = []
		page.on('console', (msg) => {
			if (msg.type() === 'error') {
				consoleErrors.push(msg.text())
			}
		})

		// Mock the Tauri updater API to throw an error
		await page.evaluate(() => {
			if (!window.__TAURI__) {
				window.__TAURI__ = {
					updater: {},
					dialog: {},
					process: {},
				}
			}

			window.__TAURI__.updater.check = async () => {
				console.log('[Mock] updater.check throwing error')
				throw new Error('Could not fetch a valid release JSON from the remote')
			}
		})

		// Navigate to Settings
		await page.click('[data-tab="settings"]')
		await expect(page.locator('#settings-view')).toBeVisible()

		// Click "Check for Updates" button
		await page.click('#check-updates-btn')

		// Wait a bit for the error to be logged
		await page.waitForTimeout(1000)

		// Verify error was logged
		const hasUpdaterError = consoleErrors.some((err) =>
			err.includes('[Updater] Failed to check for updates'),
		)
		expect(hasUpdaterError).toBe(true)
	})
})
