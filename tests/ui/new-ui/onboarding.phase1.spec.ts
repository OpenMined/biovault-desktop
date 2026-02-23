import { expect, test } from '../playwright-fixtures'
import { waitForAppReady } from '../test-helpers.js'

test.describe('New UI onboarding phase 1', () => {
	test('app shows onboarding or already-onboarded home', async ({ page }) => {
		await page.goto('/', { timeout: 15_000, waitUntil: 'commit' })
		await waitForAppReady(page, { timeout: 30_000 })

		const onboardingVisible = await page
			.locator('#onboarding-view, #onboarding-step-1')
			.first()
			.isVisible()
			.catch(() => false)
		const homeVisible = await page.locator('#run-view').isVisible().catch(() => false)

		expect(onboardingVisible || homeVisible).toBeTruthy()
	})
})
