import { test, expect } from '../playwright-fixtures'

// Base URL for the new SvelteKit UI (runs on different port)
const NEW_UI_BASE_URL = process.env.NEW_UI_URL ?? 'http://localhost:5173'

/**
 * Mock responses for Tauri invoke commands.
 * Add more as needed when porting tests.
 */
const mockInvokeResponses: Record<string, unknown> = {
	get_settings: { email: 'test@example.com' },
	check_is_onboarded: true,
	get_participants: [],
	get_files: [],
	get_projects: [],
	get_runs: [],
	get_pipelines: [],
	list_datasets_with_assets: [],
	get_sessions: [],
	list_sessions: [],
	check_syftbox_auth: { authenticated: false },
	get_syftbox_state: { running: false, email: null },
	check_dependencies: { dependencies: [] },
	get_saved_dependency_states: { dependencies: [] },
	get_desktop_log_text: '',
	get_desktop_log_dir: '/tmp',
	profiles_get_boot_state: { mode: 'normal', profiles: [] },
	key_get_status: { exists: false },
}

test.describe('New UI - Smoke Tests', () => {
	test.beforeEach(async ({ page }) => {
		// Inject Tauri mock BEFORE the page loads
		await page.addInitScript((mockResponses) => {
			// Mock the Tauri internals that @tauri-apps/api/core uses
			;(window as any).__TAURI_INTERNALS__ = {
				invoke: async (cmd: string, args?: unknown) => {
					console.log('[Test Mock] invoke:', cmd, args)

					if (cmd in mockResponses) {
						return mockResponses[cmd]
					}

					// Default fallback for unhandled commands
					console.warn('[Test Mock] Unhandled invoke command:', cmd, args)
					return null
				},
				transformCallback: (callback: Function) => {
					const id = Math.random()
					;(window as any)[`_${id}`] = callback
					return id
				},
			}

			// Also mock the event listener API
			;(window as any).__TAURI_INTERNALS__.metadata = {
				currentWebview: { label: 'main' },
				currentWindow: { label: 'main' },
			}
		}, mockInvokeResponses)

		await page.goto(NEW_UI_BASE_URL, { waitUntil: 'networkidle' })
	})

	test('app loads and shows sidebar navigation', async ({ page }) => {
		// Check that the sidebar is visible with navigation items
		const sidebar = page.locator('[data-sidebar="root"]')
		await expect(sidebar).toBeVisible()

		// Check navigation links exist
		await expect(page.locator('a[href="/explore"]')).toBeVisible()
		await expect(page.locator('a[href="/flows"]')).toBeVisible()
		await expect(page.locator('a[href="/datasets"]')).toBeVisible()
		await expect(page.locator('a[href="/collaborate"]')).toBeVisible()
		await expect(page.locator('a[href="/runs"]')).toBeVisible()
	})

	test('can navigate to Flows page', async ({ page }) => {
		await page.click('a[href="/flows"]')
		await expect(page).toHaveURL(/\/flows/)

		// Check page header or content exists
		const heading = page.locator('h1, [data-testid="page-title"]').first()
		await expect(heading).toBeVisible()
	})

	test('can navigate to Datasets page', async ({ page }) => {
		await page.click('a[href="/datasets"]')
		await expect(page).toHaveURL(/\/datasets/)
	})

	test('can navigate to Collaborate page', async ({ page }) => {
		await page.click('a[href="/collaborate"]')
		await expect(page).toHaveURL(/\/collaborate/)
	})

	test('can navigate to Results page', async ({ page }) => {
		await page.click('a[href="/runs"]')
		await expect(page).toHaveURL(/\/runs/)
	})

	test('can navigate to Settings via user menu', async ({ page }) => {
		// Open the user dropdown in sidebar footer
		const userMenuTrigger = page.locator('[data-sidebar="footer"] button').first()
		await userMenuTrigger.click()

		// Click Settings in dropdown
		await page.click('text=Settings')
		await expect(page).toHaveURL(/\/settings/)
	})

	test('header shows app title', async ({ page }) => {
		const header = page.locator('header')
		await expect(header).toContainText('BioVault Desktop')
	})

	test('can open SQL drawer', async ({ page }) => {
		// Find and click the SQL/Database icon in header
		const sqlButton = page.locator('header button, header [role="button"]').filter({
			has: page.locator('svg'),
		})

		// The database icon button (second icon typically)
		await page.locator('header').getByRole('button').nth(1).click()

		// Check drawer opened
		const drawer = page.locator('[data-vaul-drawer]')
		await expect(drawer).toBeVisible()
	})
})

test.describe('New UI - Navigation State', () => {
	test.beforeEach(async ({ page }) => {
		await page.addInitScript((mockResponses) => {
			;(window as any).__TAURI_INTERNALS__ = {
				invoke: async (cmd: string) => {
					if (cmd in mockResponses) return mockResponses[cmd]
					return null
				},
				transformCallback: (callback: Function) => {
					const id = Math.random()
					;(window as any)[`_${id}`] = callback
					return id
				},
				metadata: {
					currentWebview: { label: 'main' },
					currentWindow: { label: 'main' },
				},
			}
		}, mockInvokeResponses)

		await page.goto(NEW_UI_BASE_URL, { waitUntil: 'networkidle' })
	})

	test('active nav item is highlighted', async ({ page }) => {
		await page.click('a[href="/flows"]')
		await expect(page).toHaveURL(/\/flows/)

		// The active nav item should have active styling (data-active or aria-current)
		const flowsLink = page.locator('a[href="/flows"]')
		// SvelteKit/bits-ui typically uses data-active or the parent has active state
		const menuButton = flowsLink.locator('..')
		await expect(menuButton).toHaveAttribute('data-active', 'true')
	})

	test('direct URL navigation works', async ({ page }) => {
		await page.goto(`${NEW_UI_BASE_URL}/datasets`, { waitUntil: 'networkidle' })
		await expect(page).toHaveURL(/\/datasets/)

		// Datasets nav should be active
		const datasetsLink = page.locator('a[href="/datasets"]')
		await expect(datasetsLink).toBeVisible()
	})
})
