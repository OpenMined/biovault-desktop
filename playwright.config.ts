import { defineConfig } from '@playwright/test'

const PORT = process.env.UI_PORT ?? '8080'

const isHeadless = (() => {
	const value = process.env.PLAYWRIGHT_HEADLESS
	if (value === undefined) return true
	return !['false', '0'].includes(value.toLowerCase())
})()

const slowMo = Number.parseInt(process.env.PLAYWRIGHT_SLOWMO ?? '0', 10)

export default defineConfig({
	testDir: './tests/ui',
	timeout: 10_000, // Reduced to 10s - tests should fail much faster
	expect: {
		timeout: 2_000, // Reduced to 2s for element expectations
	},
	use: {
		headless: isHeadless,
		slowMo,
		viewport: { width: 1280, height: 800 },
		baseURL: process.env.UI_BASE_URL ?? `http://localhost:${PORT}`,
		trace: 'on-first-retry',
		video: 'retain-on-failure',
		screenshot: 'only-on-failure',
	},
	reporter: [['list'], ['html', { outputFolder: 'artifacts/playwright-report', open: 'never' }]],
})
