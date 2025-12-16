import { expect } from '@playwright/test'

export async function waitForAppReady(page, options) {
	const timeout = options?.timeout ?? 2000 // Reduced to 2s default

	// Wait for either the app layout OR onboarding view to be visible
	// Check both separately to handle when one exists but is hidden
	const appLayout = page.locator('.app-layout')
	const onboardingView = page.locator('#onboarding-view')

	// Wait for either one to become visible
	await Promise.race([
		appLayout.waitFor({ state: 'visible', timeout }).catch(() => null),
		onboardingView.waitFor({ state: 'visible', timeout }).catch(() => null),
	])

	// Verify at least one is visible
	const appVisible = await appLayout.isVisible().catch(() => false)
	const onboardingVisible = await onboardingView.isVisible().catch(() => false)

	if (!appVisible && !onboardingVisible) {
		throw new Error('Neither app layout nor onboarding view became visible')
	}

	// Try to wait for handlers, but don't fail if they're not set
	// (e.g., during onboarding they might not be needed)
	try {
		await page.waitForFunction(
			() => {
				const nav = window.__NAV_HANDLERS_READY__
				const event = window.__EVENT_HANDLERS_READY__
				const onboarding = document.getElementById('onboarding-view')
				const onboardingVisible =
					!!onboarding &&
					onboarding.classList.contains('active') &&
					typeof window.getComputedStyle === 'function' &&
					window.getComputedStyle(onboarding).display !== 'none'

				// In onboarding, allow the app to proceed even if the handler readiness flags
				// haven't been initialized yet. In the main app, require them to be true so
				// navigation clicks work reliably after reloads.
				if (onboardingVisible) {
					return true
				}

				return nav === true && event === true
			},
			{ timeout: timeout / 2 },
		)
	} catch {
		// If wait times out, check if we're in onboarding
		const onboardingVisible = await page.locator('#onboarding-view').isVisible()
		if (!onboardingVisible) {
			console.warn('Handler readiness check failed, but not in onboarding')
		}
	}
}

export async function navigateToTab(page, tabName) {
	// Try different selectors for navigation
	const selectors = [
		`.nav-item[data-tab="${tabName}"]`,
		`.nav-tab[data-tab="${tabName}"]`,
		`button[data-tab="${tabName}"]`,
		`a[data-tab="${tabName}"]`,
	]

	for (const selector of selectors) {
		const element = page.locator(selector)
		if ((await element.count()) > 0) {
			await element.click()
			return
		}
	}

	throw new Error(`Could not find navigation element for tab: ${tabName}`)
}

export async function waitForViewActive(page, viewId, options) {
	const timeout = options?.timeout ?? 2000 // Reduced to 2s

	// Wait for the view to be visible and have active class
	await expect(page.locator(`#${viewId}-view.active, #${viewId}-view:visible`)).toBeVisible({
		timeout,
	})
}

export async function skipOnboardingIfPresent(page) {
	// Check if onboarding is visible
	const onboarding = page.locator('#onboarding-view, #onboarding-step-1')

	if (await onboarding.isVisible({ timeout: 1000 }).catch(() => false)) {
		console.log('Onboarding detected, attempting to skip...')

		// Try to find skip button
		const skipButton = page.locator('button:has-text("Skip"), a:has-text("Skip")')
		if ((await skipButton.count()) > 0) {
			await skipButton.click()
			await page.waitForTimeout(500)
		}
	}
}

export async function ensureNotInOnboarding(page) {
	// If we're in onboarding, complete it or skip it
	const onboardingStep = page.locator('[id^="onboarding-step"]')

	if (await onboardingStep.isVisible({ timeout: 1000 }).catch(() => false)) {
		// Look for a skip option first
		const skipButton = page.locator('text=/skip/i, button:has-text("Skip setup")')
		if ((await skipButton.count()) > 0) {
			await skipButton.click()
			await page.waitForTimeout(1000)
		} else {
			// Try to complete onboarding quickly
			// This is a simplified version - you may need to adjust based on your onboarding flow
			const maxSteps = 10
			for (let i = 0; i < maxSteps; i++) {
				const nextButton = page.locator(
					'[id^="onboarding-next"], button:has-text("Next"), button:has-text("Continue")',
				)
				if ((await nextButton.count()) > 0) {
					await nextButton.click()
					await page.waitForTimeout(500)
				} else {
					break
				}
			}
		}
	}
}
