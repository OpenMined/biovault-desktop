import { expect, test } from '@playwright/test'
import { promises as fs } from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import WebSocket from 'ws'
import { ensureNotInOnboarding, waitForAppReady } from './test-helpers.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const chaosEnabled =
	['true', '1', 'yes'].includes(
		(process.env.CHAOS_MODE ?? process.env.CHAOS ?? '').toLowerCase(),
	) || process.env.USE_REAL_INVOKE === 'true'
const chaosScenario = (process.env.CHAOS_SCENARIO ?? 'default').toLowerCase()
const actionTimeout = Number.parseInt(process.env.CHAOS_TIMEOUT ?? '1200', 10)
const actionDelayMs = Number.parseInt(process.env.CHAOS_DELAY ?? '50', 10)

/** Simple deterministic PRNG for reproducibility */
function mulberry32(seed: number) {
	return () => {
		let t = (seed += 0x6d2b79f5)
		t = Math.imul(t ^ (t >>> 15), t | 1)
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296
	}
}

/** @param {WebSocket | null} socket */
function logToSocket(socket: WebSocket | null, payload: Record<string, unknown>) {
	if (!socket || socket.readyState !== WebSocket.OPEN) return
	socket.send(JSON.stringify({ timestamp: new Date().toISOString(), ...payload }))
}

async function collectSampleFiles() {
	const sampleDir =
		process.env.CHAOS_SAMPLE_DIR ??
		path.resolve(__dirname, '../../biovault/cli/tests/data/genotype_files')
	try {
		const entries = await fs.readdir(sampleDir, { withFileTypes: true })
		return entries.filter((e) => e.isFile()).map((e) => path.join(sampleDir, e.name))
	} catch {
		return []
	}
}

test.describe('Chaos fuzzing @chaos @fuzz', () => {
	test.skip(!chaosEnabled, 'Set CHAOS_MODE=true (and USE_REAL_INVOKE=true) to run chaos fuzzing')

	test('randomized UI + real backend fuzzing @chaos', async ({ page }, testInfo) => {
		// Give the chaos run enough time to explore
		testInfo.setTimeout(240_000)

		const seed = Number.parseInt(process.env.CHAOS_SEED ?? `${Date.now()}`, 10)
		const iterations = Number.parseInt(process.env.CHAOS_ACTIONS ?? '120', 10)
		const rng = mulberry32(Number.isNaN(seed) ? Date.now() : seed)
		const sampleFiles = await collectSampleFiles()
		await fs.mkdir(path.resolve(process.cwd(), 'artifacts'), { recursive: true })

		/** @type {WebSocket | null} */
		let logSocket: WebSocket | null = null
		if (process.env.UNIFIED_LOG_WS) {
			logSocket = new WebSocket(process.env.UNIFIED_LOG_WS)
			await new Promise((resolve, reject) => {
				logSocket?.once('open', resolve)
				logSocket?.once('error', reject)
			}).catch(() => null)
		}

		const log = (payload: Record<string, unknown>) => logToSocket(logSocket, payload)
		log({ event: 'chaos-start', seed, iterations, scenario: chaosScenario })

		await page.goto('/', { timeout: 15_000, waitUntil: 'commit' })
		await waitForAppReady(page, { timeout: 10_000 })
		await ensureNotInOnboarding(page)

		/** Choose a random item from an array */
		const pick = <T>(items: T[]): T | null => {
			if (!items.length) return null
			const idx = Math.floor(rng() * items.length)
			return items[idx] ?? null
		}

		async function dismissBlockers() {
			const backdrop = page.locator('.modal-backdrop:visible')
			const closeButtons = page.locator(
				'[data-modal-close]:visible, .modal button:has-text("Close"), .modal button:has-text("Cancel"), .modal button[aria-label="Close"]',
			)

			if ((await closeButtons.count()) > 0) {
				await closeButtons
					.first()
					.click({ timeout: 1000 })
					.catch(() => null)
			} else if ((await backdrop.count()) > 0) {
				await backdrop
					.first()
					.click({ timeout: 1000 })
					.catch(() => null)
			}

			await page.keyboard.press('Escape').catch(() => null)
		}

		async function clickRandomNav() {
			await dismissBlockers()
			const navItems = await page.locator('.nav-item').all()
			if (!navItems.length) return 'no-nav'
			const choice = pick(navItems)
			if (!choice) return 'no-nav-choice'
			await choice.scrollIntoViewIfNeeded()
			try {
				await choice.click({ timeout: actionTimeout })
				return 'nav'
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error)
				if (/intercepts pointer events/i.test(message) || /not enabled/i.test(message)) {
					await dismissBlockers()
					return 'nav-blocked'
				}
				throw error
			}
		}

		async function clickRandomButton() {
			await dismissBlockers()
			const buttons = await page.locator('button:visible, [role="button"]:visible').all()
			const safe = []
			for (const btn of buttons) {
				const text = (await btn.innerText()).trim().toLowerCase()
				if (!text || /delete|remove|reset|clear|logout/.test(text)) continue
				safe.push(btn)
			}
			const choice = pick(safe)
			if (!choice) return 'no-button'
			await choice.scrollIntoViewIfNeeded()
			try {
				await choice.click({ timeout: actionTimeout })
				return 'button'
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error)
				if (/intercepts pointer events/i.test(message) || /not enabled/i.test(message)) {
					await dismissBlockers()
					return 'button-blocked'
				}
				throw error
			}
		}

		async function toggleRandomCheckbox() {
			await dismissBlockers()
			const checks = await page.locator('input[type="checkbox"]:visible').all()
			const choice = pick(checks)
			if (!choice) return 'no-checkbox'
			await choice.scrollIntoViewIfNeeded()
			try {
				await choice.click({ timeout: actionTimeout })
				return 'checkbox'
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error)
				if (/intercepts pointer events/i.test(message) || /not enabled/i.test(message)) {
					await dismissBlockers()
					return 'checkbox-blocked'
				}
				throw error
			}
		}

		async function typeIntoRandomField() {
			await dismissBlockers()
			const inputs = await page
				.locator('input[type="text"]:visible, textarea:visible, input[type="search"]:visible')
				.all()
			const choice = pick(inputs)
			if (!choice) return 'no-input'
			await choice.scrollIntoViewIfNeeded()
			const text = `chaos-${Math.floor(rng() * 10_000)}`
			await choice.fill(text, { timeout: 3000 })
			return 'typed'
		}

		async function selectRandomOption() {
			await dismissBlockers()
			const selects = await page.locator('select:visible').all()
			const choice = pick(selects)
			if (!choice) return 'no-select'
			const options = await choice.locator('option').all()
			const opt = pick(options)
			if (!opt) return 'no-option'
			const value = await opt.getAttribute('value')
			if (!value) return 'no-value'
			await choice.selectOption(value, { timeout: actionTimeout })
			return 'select'
		}

		async function uploadRandomFile() {
			await dismissBlockers()
			if (!sampleFiles.length) return 'no-sample-files'
			const fileInput = page.locator('input[type="file"]')
			if ((await fileInput.count()) === 0) return 'no-file-input'
			const target = fileInput.nth(0)
			const filePath = pick(sampleFiles)
			if (!filePath) return 'no-file'
			await target.setInputFiles(filePath, { timeout: actionTimeout })
			return 'file-upload'
		}

		async function scrollRandomArea() {
			await dismissBlockers()
			const scrollable = await page
				.locator('[style*="overflow"], .tab-content, .app-content, main')
				.all()
			const target = pick(scrollable)
			if (!target) {
				await page.mouse.wheel(0, 400)
				return 'page-scroll'
			}
			const box = await target.boundingBox()
			if (box) {
				await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
				await page.mouse.wheel(0, (rng() > 0.5 ? 1 : -1) * 600)
			} else {
				await page.mouse.wheel(0, 400)
			}
			return 'scroll'
		}

		async function invokeBackendProbe() {
			const result = await page.evaluate(async () => {
				try {
					// Prefer the global Tauri bridge
					if (window.__TAURI__?.core?.invoke) {
						return await window.__TAURI__.core.invoke('get_settings')
					}
					// Fall back to the browser shim
					const mod = await import('/tauri-shim.js')
					if (mod?.invoke) {
						return await mod.invoke('get_settings')
					}
				} catch (error) {
					return { error: String(error) }
				}
				return { error: 'invoke-unavailable' }
			})
			if (result?.error) throw new Error(String(result.error))
			return 'invoke'
		}

		async function onboardingButton() {
			await dismissBlockers()
			const buttons = await page.locator('#onboarding-view button:visible').all()
			const choice = pick(buttons)
			if (!choice) return 'no-onboarding-button'
			await choice.scrollIntoViewIfNeeded()
			await choice.click({ timeout: actionTimeout })
			return 'onboarding-button'
		}

		async function onboardingInput() {
			await dismissBlockers()
			const inputs = await page
				.locator('#onboarding-view input:visible, #onboarding-view textarea:visible')
				.all()
			const choice = pick(inputs)
			if (!choice) return 'no-onboarding-input'
			await choice.fill(`onboard-${Math.floor(rng() * 9999)}`, { timeout: actionTimeout })
			return 'onboarding-input'
		}

		async function onboardingCheckbox() {
			await dismissBlockers()
			const checks = await page.locator('#onboarding-view input[type="checkbox"]:visible').all()
			const choice = pick(checks)
			if (!choice) return 'no-onboarding-checkbox'
			await choice.click({ timeout: actionTimeout })
			return 'onboarding-checkbox'
		}

		const actions =
			chaosScenario === 'onboarding'
				? [
						{ name: 'onboarding-button', run: onboardingButton },
						{ name: 'onboarding-input', run: onboardingInput },
						{ name: 'onboarding-checkbox', run: onboardingCheckbox },
						{ name: 'scroll', run: scrollRandomArea },
					]
				: [
						{ name: 'nav', run: clickRandomNav },
						{ name: 'button', run: clickRandomButton },
						{ name: 'checkbox', run: toggleRandomCheckbox },
						{ name: 'input', run: typeIntoRandomField },
						{ name: 'select', run: selectRandomOption },
						{ name: 'upload', run: uploadRandomFile },
						{ name: 'scroll', run: scrollRandomArea },
						{ name: 'invoke', run: invokeBackendProbe },
					]

		const failures: { step: number; action: string; error: string }[] = []

		for (let i = 0; i < iterations; i += 1) {
			const action = pick(actions)
			if (!action) continue
			try {
				const outcome = await action.run()
				log({ event: 'chaos-step', step: i, action: action.name, outcome })
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error)
				failures.push({ step: i, action: action.name, error: message })
				log({ event: 'chaos-error', step: i, action: action.name, error: message })
				await page.screenshot({ path: `artifacts/chaos-step-${i}.png`, fullPage: true })
			}
			if (actionDelayMs > 0) {
				await page.waitForTimeout(actionDelayMs)
			}
		}

		log({ event: 'chaos-end', failures: failures.length })

		if (failures.length > 0) {
			console.error('Chaos failures', failures)
		}

		expect(failures, 'Chaos run recorded failures').toHaveLength(0)

		if (logSocket) {
			await new Promise((resolve) => {
				logSocket?.once('close', resolve)
				logSocket?.close()
			})
		}
	})
})
