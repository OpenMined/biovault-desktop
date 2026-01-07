import { expect, test } from '@playwright/test'
import { promises as fs } from 'fs'
import path from 'path'
import WebSocket from 'ws'
import { navigateToTab, waitForAppReady } from './test-helpers.js'

test.describe.configure({ timeout: 180_000 })

function normalizePath(value) {
	return path.resolve(String(value || ''))
}

function samePath(a, b) {
	if (!a || !b) return false
	return normalizePath(a) === normalizePath(b)
}

async function setWsPort(page, port) {
	await page.addInitScript((portNum) => {
		const w = /** @type {any} */ window
		w.__DEV_WS_BRIDGE_PORT__ = portNum
		w.__DISABLE_UPDATER__ = true
		w.process = w.process || {}
		w.process.env = w.process.env || {}
		w.process.env.USE_REAL_INVOKE = 'true'
		w.process.env.DISABLE_UPDATER = '1'
	}, port)
}

async function waitForWsBridge(port, timeoutMs = 60_000) {
	const deadline = Date.now() + timeoutMs
	let lastError = null
	while (Date.now() < deadline) {
		try {
			const socket = new WebSocket(`ws://127.0.0.1:${port}`)
			await new Promise((resolve, reject) => {
				socket.once('open', resolve)
				socket.once('error', reject)
			})
			socket.close()
			return
		} catch (err) {
			lastError = err
			await new Promise((r) => setTimeout(r, 200))
		}
	}
	throw new Error(`Timed out waiting for WS bridge on :${port} (${String(lastError || '')})`)
}

async function wsInvoke(port, cmd, args = {}, timeoutMs = 30_000) {
	const socket = new WebSocket(`ws://127.0.0.1:${port}`)
	await new Promise((resolve, reject) => {
		socket.once('open', resolve)
		socket.once('error', reject)
	})
	const id = Math.floor(Math.random() * 1e9)
	const payload = JSON.stringify({ id, cmd, args })
	const result = await new Promise((resolve, reject) => {
		const timeout = setTimeout(() => {
			reject(new Error(`WS invoke timeout: ${cmd}`))
		}, timeoutMs)
		socket.on('message', (raw) => {
			try {
				const msg = JSON.parse(String(raw))
				if (msg?.id !== id) return
				clearTimeout(timeout)
				if (msg?.error) reject(new Error(String(msg.error)))
				else resolve(msg?.result)
			} catch (err) {
				clearTimeout(timeout)
				reject(err)
			} finally {
				socket.close()
			}
		})
		socket.send(payload)
	})
	return result
}

async function waitForConfigHome(port, expectedHome, timeoutMs = 60_000) {
	const deadline = Date.now() + timeoutMs
	let last = ''
	const expectedConfigPath = normalizePath(path.join(expectedHome, 'config.yaml'))
	while (Date.now() < deadline) {
		try {
			const configPath = await wsInvoke(port, 'get_config_path', {}, 5_000)
			last = String(configPath || '')
			if (last && samePath(last, expectedConfigPath)) {
				return last
			}
		} catch (_err) {
			// backend may be restarting
		}
		await new Promise((r) => setTimeout(r, 250))
	}
	throw new Error(`Timed out waiting for config under ${expectedHome}. Last=${last}`)
}

async function waitForProfilesPickerState(port, timeoutMs = 60_000) {
	const deadline = Date.now() + timeoutMs
	let last = null
	while (Date.now() < deadline) {
		try {
			last = await wsInvoke(port, 'profiles_get_boot_state', {}, 5_000)
			if (last?.enabled && last?.should_show_picker) {
				return last
			}
		} catch (_err) {
			// backend may be restarting
		}
		await new Promise((r) => setTimeout(r, 250))
	}
	throw new Error(`Timed out waiting for profiles picker state. Last=${JSON.stringify(last)}`)
}

async function waitForSpawnProbe(probePath, timeoutMs = 20_000) {
	const deadline = Date.now() + timeoutMs
	let lastError = null
	while (Date.now() < deadline) {
		try {
			const contents = await fs.readFile(probePath, 'utf8')
			if (contents && contents.trim()) {
				return JSON.parse(contents)
			}
		} catch (err) {
			lastError = err
		}
		await new Promise((r) => setTimeout(r, 200))
	}
	throw new Error(`Timed out waiting for spawn probe at ${probePath}: ${String(lastError || '')}`)
}

async function resetOnboardingState(homeA, homeB) {
	const targets = [
		path.join(homeA, 'config.yaml'),
		path.join(homeA, 'biovault.db'),
		path.join(homeB, 'config.yaml'),
		path.join(homeB, 'biovault.db'),
	]
	await Promise.all(targets.map((p) => fs.unlink(p).catch(() => {})))
	// Also clean the profiles directory to ensure a fresh state
	const profilesDir = process.env.BIOVAULT_PROFILES_DIR || path.join(homeA, '.bvprofiles')
	await fs.rm(profilesDir, { recursive: true, force: true }).catch(() => {})
}

async function ensureCurrentHome(wsPort, homePath) {
	const current = await wsInvoke(wsPort, 'get_env_var', { key: 'BIOVAULT_HOME' }, 5_000).catch(
		() => '',
	)
	if (samePath(current, homePath)) {
		return
	}

	const state = await wsInvoke(wsPort, 'profiles_get_boot_state', {}, 5_000).catch(() => null)
	const match = state?.profiles?.find((p) => p?.biovault_home === homePath)
	if (match?.id) {
		await wsInvoke(wsPort, 'profiles_switch_in_place', { profileId: match.id }, 10_000)
	} else {
		await wsInvoke(wsPort, 'profiles_create_and_switch_in_place', { homePath }, 10_000)
	}
	await waitForConfigHome(wsPort, homePath, 60_000)
}

function escapeRegex(value) {
	return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function rowByHome(page, homePath) {
	const exact = new RegExp(`^${escapeRegex(homePath)}$`)
	return page
		.locator('.profile-row')
		.filter({ has: page.locator('.profile-path', { hasText: exact }) })
}

async function openPickerFromSettings(page) {
	await navigateToTab(page, 'settings')
	await expect(page.locator('#settings-view')).toBeVisible({ timeout: 10_000 })
	await page.locator('#profiles-open-picker-btn').click()
	await expect(page.locator('#profiles-view')).toBeVisible({ timeout: 30_000 })
}

async function onboardingGoToHomeStep(page) {
	try {
		await waitForAppReady(page, { timeout: 30_000 })
	} catch (error) {
		const profilesView = page.locator('#profiles-view')
		if (!(await profilesView.isVisible({ timeout: 1_000 }).catch(() => false))) {
			throw error
		}
		const openBtn = page.locator('.profile-open-btn:not([disabled])').first()
		if ((await openBtn.count()) > 0) {
			await openBtn.click()
		} else {
			const fallbackRow = page.locator('.profile-row').first()
			await fallbackRow.click()
		}
		await waitForAppReady(page, { timeout: 30_000 })
	}

	const runView = page.locator('#run-view')
	if (await runView.isVisible({ timeout: 500 }).catch(() => false)) {
		return false
	}

	const step3 = page.locator('#onboarding-step-3')
	if (await step3.isVisible({ timeout: 500 }).catch(() => false)) {
		return true
	}

	await expect(page.locator('#onboarding-step-1')).toBeVisible({ timeout: 10_000 })
	await page.locator('#onboarding-next-1').click()

	await expect(page.locator('#onboarding-step-2')).toBeVisible({ timeout: 10_000 })
	page.once('dialog', (dialog) => dialog.accept().catch(() => {}))
	await page.locator('#skip-dependencies-btn').click()

	await expect(step3).toBeVisible({ timeout: 10_000 })
	return true
}

async function goHomeToEmailStep(page) {
	await page.locator('#onboarding-next-3').click()
	await expect(page.locator('#onboarding-step-3-email')).toBeVisible({ timeout: 10_000 })
}

async function completeOnboardingFromEmailStep(page, { email }) {
	await page.fill('#onboarding-email', email)
	await expect(page.locator('#onboarding-next-3-email')).toBeEnabled({ timeout: 10_000 })
	await page.locator('#onboarding-next-3-email').click()

	await expect(page.locator('#onboarding-step-3-key')).toBeVisible({ timeout: 30_000 })
	const recoveryBlock = page.locator('#onboarding-recovery-block')
	if (await recoveryBlock.isVisible({ timeout: 500 }).catch(() => false)) {
		await page.locator('#onboarding-recovery-ack').check()
	}
	await expect(page.locator('#onboarding-next-3-key')).toBeEnabled({ timeout: 30_000 })
	page.once('dialog', (dialog) => dialog.accept().catch(() => {}))
	await page.locator('#onboarding-next-3-key').click()

	await expect(page.locator('#onboarding-step-4')).toBeVisible({ timeout: 30_000 })
	await Promise.all([
		page.waitForNavigation({ waitUntil: 'networkidle' }).catch(() => {}),
		page.locator('#skip-syftbox-btn').click(),
	])

	await expect(page.locator('#run-view')).toBeVisible({ timeout: 30_000 })
}

async function assertHomePrefilled(page, expectedHomeContains) {
	if (expectedHomeContains) {
		const homeInput = page.locator('#onboarding-home')
		await expect(homeInput).toBeVisible({ timeout: 10_000 })
		await expect(homeInput).toHaveValue(
			new RegExp(expectedHomeContains.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
		)
	}
}

test.describe('Profiles flow (real backend) @profiles-real', () => {
	test('create profile via onboarding home switch, open picker, switch, delete', async ({
		page,
	}) => {
		const wsPort = Number.parseInt(process.env.DEV_WS_BRIDGE_PORT_BASE || '3333', 10)
		const homeA = process.env.PROFILES_HOME_A || '/tmp/biovault-profiles-test/homeA'
		const homeB = process.env.PROFILES_HOME_B || '/tmp/biovault-profiles-test/homeB'

		page.on('dialog', (dialog) => {
			dialog.accept().catch(() => {})
		})

		await setWsPort(page, wsPort)
		await ensureCurrentHome(wsPort, homeA)
		await resetOnboardingState(homeA, homeB)
		await page.goto(process.env.UI_BASE_URL || 'http://localhost:8082')

		// Step through onboarding until home step, then switch home to create profile B (this restarts the backend).
		const needsHomeAOnboarding = await onboardingGoToHomeStep(page)
		if (needsHomeAOnboarding) {
			await assertHomePrefilled(page, homeA)
			await page.fill('#onboarding-home', homeB)
			await goHomeToEmailStep(page)
			await page.fill('#onboarding-email', 'profileB@example.com')
			await page.locator('#onboarding-next-3-email').click()
		} else {
			await wsInvoke(wsPort, 'profiles_create_and_switch_in_place', { homePath: homeB }, 10_000)
		}

		// Wait for the backend to restart onto homeB, then reload to re-init the UI.
		await waitForWsBridge(wsPort, 60_000)
		await waitForConfigHome(wsPort, homeB, 60_000)
		await page.reload()

		// Complete onboarding for profile B (home should be the one we selected).
		const needsHomeBOnboarding = await onboardingGoToHomeStep(page)
		if (needsHomeBOnboarding) {
			await assertHomePrefilled(page, homeB)
			await goHomeToEmailStep(page)
			await completeOnboardingFromEmailStep(page, { email: 'profileB@example.com' })
		}

		// Open the picker and switch back to the original profile home.
		await openPickerFromSettings(page)
		const rows = page.locator('.profile-row')
		await expect(rows).toHaveCount(2)
		await expect(rowByHome(page, homeB).locator('.profile-new-instance-btn')).toHaveCount(0)

		const spawnProbePath = process.env.BIOVAULT_SPAWN_PROBE_PATH
		if (!spawnProbePath) {
			throw new Error('BIOVAULT_SPAWN_PROBE_PATH not set for profiles-new-instance test')
		}
		await fs.unlink(spawnProbePath).catch(() => {})
		const bootState = await wsInvoke(wsPort, 'profiles_get_boot_state', {}, 5_000)
		const profileA = bootState?.profiles?.find((p) => p?.biovault_home === homeA)
		if (!profileA) {
			throw new Error(`Failed to resolve profile for ${homeA}`)
		}
		await rowByHome(page, homeA).locator('.profile-new-instance-btn').click()
		const probe = await waitForSpawnProbe(spawnProbePath, 20_000)
		expect(probe.profile_id).toBe(profileA.id)
		expect(probe.home).toBe(profileA.biovault_home)

		await rowByHome(page, homeA).locator('.profile-open-btn').click()
		await waitForWsBridge(wsPort, 60_000)
		await waitForConfigHome(wsPort, homeA, 60_000)
		await page.reload()

		// Profile A should be un-onboarded; complete onboarding.
		const needsHomeACompletion = await onboardingGoToHomeStep(page)
		if (needsHomeACompletion) {
			await assertHomePrefilled(page, homeA)
			await goHomeToEmailStep(page)
			await completeOnboardingFromEmailStep(page, { email: 'profileA@example.com' })
		}

		// Open picker again and delete profile B (cannot delete current).
		await openPickerFromSettings(page)
		await expect(page.locator('.profile-row')).toHaveCount(2)
		await rowByHome(page, homeB).locator('.profile-delete-btn').click()

		await expect(page.locator('.profile-row')).toHaveCount(1)
		await expect(page.locator('.profile-row')).toContainText(homeA)
	})
})
