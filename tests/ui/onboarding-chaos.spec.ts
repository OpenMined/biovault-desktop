import { expect, test } from '@playwright/test'

test.describe('Onboarding chaos smoke @chaos @onboarding', () => {
	test('shows onboarding and skips dependencies', async ({ page }) => {
		// Force onboarding and keep dialog confirms non-blocking
		await page.addInitScript(() => {
			const w = /** @type {any} */ window
			w.__TEST_INVOKE_OVERRIDE__ = async (cmd) => {
				if (cmd === 'check_is_onboarded') return false
				if (cmd === 'update_saved_dependency_states') return null
				return undefined
			}
			// Clear any cached onboarding state
			window.sessionStorage.removeItem('playwright:onboarded')
		})

		page.on('dialog', (dlg) => dlg.accept().catch(() => {}))

		await page.goto('/', { timeout: 15_000 })

		const step1 = page.locator('#onboarding-step-1')
		await expect(step1).toBeVisible({ timeout: 10_000 })
		await page.locator('#onboarding-next-1').click()

		const step2 = page.locator('#onboarding-step-2')
		await expect(step2).toBeVisible()

		const skipBtn = page.locator('#skip-dependencies-btn')
		await expect(skipBtn).toBeEnabled({ timeout: 10_000 })
		await skipBtn.click()

		const step3 = page.locator('#onboarding-step-3')
		await expect(step3).toBeVisible({ timeout: 10_000 })
	})
})
