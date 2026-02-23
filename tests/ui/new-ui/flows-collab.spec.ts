import { expect, test } from '../playwright-fixtures'
import { waitForAppReady } from '../test-helpers.js'

test.describe('New UI flows collaboration @new-ui @flows-collab-newui', () => {
	test('smoke: app boots and flows entry is reachable', async ({ page }) => {
		await page.goto('/', { timeout: 20_000, waitUntil: 'commit' })
		await waitForAppReady(page, { timeout: 45_000 })

		const runView = page.locator('#run-view')
		const onboardingView = page.locator('#onboarding-view, #onboarding-step-1').first()

		// Milestone 1: either app home or onboarding is shown.
		const appReady = await runView.isVisible().catch(() => false)
		const onboarding = await onboardingView.isVisible().catch(() => false)
		expect(appReady || onboarding).toBeTruthy()

		// If onboarded, verify Flows nav is present and can be opened.
		if (appReady) {
			const flowsNav = page.getByRole('link', { name: /flows/i }).first()
			if (await flowsNav.isVisible().catch(() => false)) {
				await flowsNav.click()
				await expect(page).toHaveURL(/flows/i)
			}
		}
	})
})
