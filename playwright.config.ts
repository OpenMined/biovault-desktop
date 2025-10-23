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
	timeout: 60_000,
	expect: {
		timeout: 10_000,
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
	webServer: {
		command: 'cd src && python3 -m http.server ' + PORT,
		port: Number(PORT),
		reuseExistingServer: !process.env.CI,
		timeout: 120_000,
	},
})
