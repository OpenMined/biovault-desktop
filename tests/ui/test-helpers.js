import { expect } from '@playwright/test'

export async function waitForAppReady(page, options) {
	const timeout = options?.timeout ?? 2000 // Reduced to 2s default
	const start = Date.now()

	const remaining = () => Math.max(0, timeout - (Date.now() - start))

	// Wait for either the app layout OR onboarding view to exist in the DOM.
	const appLayout = page.locator('.app-layout')
	const onboardingView = page.locator('#onboarding-view')

	await Promise.race([
		appLayout.waitFor({ state: 'attached', timeout }).catch(() => null),
		onboardingView.waitFor({ state: 'attached', timeout }).catch(() => null),
	])

	try {
		await page.waitForFunction(
			() => {
				const onboarding = document.getElementById('onboarding-view')
				const onboardingActive =
					!!onboarding &&
					onboarding.classList.contains('active') &&
					typeof window.getComputedStyle === 'function' &&
					window.getComputedStyle(onboarding).display !== 'none'

				if (onboardingActive) return true

				const onboardingCheckComplete =
					// Older builds won't define this; treat as "complete" to preserve behavior.
					window.__ONBOARDING_CHECK_COMPLETE__ === undefined || window.__ONBOARDING_CHECK_COMPLETE__ === true

				return (
					onboardingCheckComplete &&
					window.__NAV_HANDLERS_READY__ === true &&
					window.__EVENT_HANDLERS_READY__ === true
				)
			},
			{ timeout: remaining() },
		)
	} catch {
		const details = await page
			.evaluate(() => {
				const onboarding = document.getElementById('onboarding-view')
				const appLayout = document.querySelector('.app-layout')
				const onboardingDisplay =
					onboarding && typeof window.getComputedStyle === 'function'
						? window.getComputedStyle(onboarding).display
						: null
				const appLayoutDisplay =
					appLayout && typeof window.getComputedStyle === 'function'
						? window.getComputedStyle(appLayout).display
						: null
				return {
					url: window.location.href,
					navReady: window.__NAV_HANDLERS_READY__ === true,
					eventReady: window.__EVENT_HANDLERS_READY__ === true,
					onboardingCheckComplete:
						window.__ONBOARDING_CHECK_COMPLETE__ === undefined
							? null
							: window.__ONBOARDING_CHECK_COMPLETE__ === true,
					onboardingActive: onboarding ? onboarding.classList.contains('active') : false,
					onboardingDisplay,
					appLayoutDisplay,
				}
			})
			.catch(() => null)

		throw new Error(`App did not become ready within ${timeout}ms: ${JSON.stringify(details)}`)
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
