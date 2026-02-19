import { expect, test } from '@playwright/test'
import { navigateToTab, waitForAppReady } from './test-helpers.js'

test.describe('Profiles flow', () => {
	test('@profiles-mock onboarding -> add profile -> move -> delete', async ({ page }) => {
		test.setTimeout(60_000)
		page.on('dialog', (dialog) => {
			dialog.accept().catch(() => {})
		})
		await page.addInitScript(() => {
			const w = window as any
			const STATE_KEY = 'playwright:profiles_state'

			const HOME_A = '/tmp/biovault-playwright/profileA'
			const HOME_B = '/tmp/biovault-playwright/profileB'
			const HOME_A_MOVED = '/tmp/biovault-playwright/profileA_moved'

			const loadState = () => {
				try {
					const raw = window.sessionStorage.getItem(STATE_KEY)
					if (!raw) return null
					return JSON.parse(raw)
				} catch (_err) {
					return null
				}
			}

			const saveState = (state: any) => {
				try {
					window.sessionStorage.setItem(STATE_KEY, JSON.stringify(state))
				} catch (_err) {
					// ignore
				}
			}

			const initialState = {
				picker: false,
				opened_from_app: false,
				currentHome: HOME_A,
				profiles: [
					{
						id: 'pA',
						email: null,
						biovault_home: HOME_A,
						fingerprint: 'fp-A',
						running: false,
						last_used_at: '2025-01-01T00:00:00Z',
					},
				],
				current_profile_id: 'pA',
				onboardedByHome: { [HOME_A]: false, [HOME_B]: false, [HOME_A_MOVED]: false },
				dialogOpenQueue: [HOME_B, HOME_A_MOVED],
				newInstances: [],
			}

			const state = loadState() || initialState
			saveState(state)
			w.__TEST_PROFILE_STATE__ = state

			w.__TEST_DIALOG_OPEN__ = async () => {
				return state.dialogOpenQueue.shift() ?? null
			}

			function configPathForHome(home: string) {
				return `${home}/config.yaml`
			}

			function getCurrentProfile(state: any) {
				return state.profiles.find((p: any) => p.id === state.current_profile_id)
			}

			w.__TEST_INVOKE_OVERRIDE__ = async (cmd: string, args: any = {}) => {
				switch (cmd) {
					case 'profiles_get_boot_state': {
						const profiles = state.profiles.map((p: any) => ({
							id: p.id,
							email: p.email,
							biovault_home: p.biovault_home,
							vault_path: `${p.biovault_home}/.sbc`,
							fingerprint: p.fingerprint,
							onboarded: !!state.onboardedByHome[p.biovault_home],
							running: p.running,
							is_current: p.id === state.current_profile_id,
							last_used_at: p.last_used_at,
						}))
						return {
							enabled: true,
							should_show_picker: state.picker && profiles.length > 0,
							current_profile_id: state.current_profile_id,
							profiles,
							startup_message: null,
							opened_from_app: state.opened_from_app,
						}
					}
					case 'profiles_get_default_home':
						return '/tmp/biovault-playwright/default'
					case 'get_config_path': {
						return configPathForHome(state.currentHome)
					}
					case 'get_database_path':
						return `${state.currentHome}/biovault.db`
					case 'get_app_version':
						return 'test'
					case 'check_is_onboarded': {
						return !!state.onboardedByHome[state.currentHome]
					}
					case 'complete_onboarding': {
						state.onboardedByHome[state.currentHome] = true
						const current = getCurrentProfile(state)
						if (current) current.email = args?.email ?? null
						saveState(state)
						return null
					}
					case 'key_get_status': {
						return {
							identity: args?.email ?? 'tester@example.com',
							vault_path: `${state.currentHome}/.sbc`,
							bundle_path: `${state.currentHome}/.sbc/bundles/tester_example_com.json`,
							export_path: `${state.currentHome}/datasites/tester@example.com/public/crypto/did.json`,
							vault_fingerprint: 'abc123def456',
							exists: true,
						}
					}
					case 'check_dependencies':
						return { dependencies: [] }
					case 'get_saved_dependency_states':
						return { dependencies: [] }
					case 'get_settings': {
						const current = getCurrentProfile(state)
						return {
							docker_path: '',
							java_path: '',
							syftbox_path: '',
							biovault_path: 'bv',
							email: current?.email ?? '',
							ai_api_url: '',
							ai_api_token: '',
							ai_model: '',
							syftbox_server_url: 'https://dev.syftbox.net',
						}
					}
					case 'profiles_create_with_home_and_switch': {
						const home = String(args?.homePath || '').trim()
						if (!home) throw new Error('homePath required')
						const id = home.includes('profileB') ? 'pB' : `p${state.profiles.length + 1}`
						if (!state.profiles.some((p: any) => p.biovault_home === home)) {
							state.profiles.push({
								id,
								email: null,
								biovault_home: home,
								fingerprint: `fp-${id}`,
								onboarded: false,
								running: false,
								last_used_at: new Date().toISOString(),
							})
						}
						state.current_profile_id = id
						state.currentHome = home
						state.picker = false
						state.opened_from_app = false
						saveState(state)
						setTimeout(() => window.location.reload(), 0)
						return null
					}
					case 'profiles_create_and_switch_in_place': {
						const home = String(args?.homePath || '').trim()
						if (!home) throw new Error('homePath required')
						const id = home.includes('profileB') ? 'pB' : `p${state.profiles.length + 1}`
						if (!state.profiles.some((p: any) => p.biovault_home === home)) {
							state.profiles.push({
								id,
								email: null,
								biovault_home: home,
								fingerprint: `fp-${id}`,
								onboarded: false,
								running: false,
								last_used_at: new Date().toISOString(),
							})
						}
						state.current_profile_id = id
						state.currentHome = home
						state.picker = false
						state.opened_from_app = false
						saveState(state)
						return null
					}
					case 'profiles_open_picker': {
						state.picker = true
						state.opened_from_app = true
						saveState(state)
						setTimeout(() => window.location.reload(), 0)
						return null
					}
					case 'profiles_move_home': {
						const profileId = args?.profileId
						const newHome = String(args?.newHomePath || '').trim()
						const p = state.profiles.find((pp: any) => pp.id === profileId)
						if (!p) throw new Error('Unknown profile')
						const oldHome = p.biovault_home
						p.biovault_home = newHome
						state.onboardedByHome[newHome] = state.onboardedByHome[oldHome] ?? false
						saveState(state)
						return null
					}
					case 'profiles_delete_profile': {
						const profileId = args?.profileId
						state.profiles = state.profiles.filter((pp: any) => pp.id !== profileId)
						saveState(state)
						return null
					}
					case 'profiles_switch': {
						const profileId = args?.profileId
						const p = state.profiles.find((pp: any) => pp.id === profileId)
						if (!p) throw new Error('Unknown profile')
						state.current_profile_id = p.id
						state.currentHome = p.biovault_home
						state.picker = false
						state.opened_from_app = false
						saveState(state)
						setTimeout(() => window.location.reload(), 0)
						return null
					}
					case 'profiles_switch_in_place': {
						const profileId = args?.profileId
						const p = state.profiles.find((pp: any) => pp.id === profileId)
						if (!p) throw new Error('Unknown profile')
						state.current_profile_id = p.id
						state.currentHome = p.biovault_home
						state.picker = false
						state.opened_from_app = false
						saveState(state)
						return null
					}
					case 'profiles_open_new_instance': {
						const profileId = args?.profileId
						if (!profileId) throw new Error('Missing profileId')
						state.newInstances.push(profileId)
						saveState(state)
						return null
					}
					default:
						// Fall through to tauri-shim mock defaults.
						return undefined
				}
			}
		})

		await page.goto('/', { timeout: 15_000 })
		await waitForAppReady(page, { timeout: 30_000 })

		// Onboard profile A
		await expect(page.locator('#onboarding-step-1')).toBeVisible()
		await page.locator('#onboarding-next-1').click()
		await expect(page.locator('#onboarding-step-2')).toBeVisible()
		await page.locator('#skip-dependencies-btn').click()
		await expect(page.locator('#onboarding-step-3')).toBeVisible()
		await page.locator('#onboarding-next-3').click()
		await expect(page.locator('#onboarding-step-3-email')).toBeVisible()
		await page.fill('#onboarding-email', 'profileA@example.com')
		await expect(page.locator('#onboarding-next-3-email')).toBeEnabled()
		await page.locator('#onboarding-next-3-email').click()
		await expect(page.locator('#onboarding-step-3-key')).toBeVisible()
		await page.locator('#onboarding-next-3-key').click()
		await expect(page.locator('#onboarding-step-4')).toBeVisible()
		await page.locator('#skip-syftbox-btn').click()
		await expect(page.locator('.app-layout')).toBeVisible({ timeout: 30_000 })
		await waitForAppReady(page, { timeout: 30_000 })

		// Add a new profile via Settings -> Add Profile (uses dialog.open override)
		await navigateToTab(page, 'settings')
		await expect(page.locator('#settings-view')).toBeVisible()
		await expect(page.locator('#profiles-open-picker-btn')).toBeHidden()
		await page.locator('#profiles-add-btn-settings').click()
		await expect(page.locator('#onboarding-step-1')).toBeVisible({ timeout: 30_000 })

		// Should be onboarding again (new profile)
		await expect(page.locator('#onboarding-step-1')).toBeVisible()
		await page.locator('#onboarding-next-1').click()
		await expect(page.locator('#onboarding-step-2')).toBeVisible()
		await page.locator('#skip-dependencies-btn').click()
		await expect(page.locator('#onboarding-step-3')).toBeVisible()
		await page.locator('#onboarding-next-3').click()
		await expect(page.locator('#onboarding-step-3-email')).toBeVisible()
		await page.fill('#onboarding-email', 'profileB@example.com')
		await page.locator('#onboarding-next-3-email').click()
		await expect(page.locator('#onboarding-step-3-key')).toBeVisible()
		await page.locator('#onboarding-next-3-key').click()
		await expect(page.locator('#onboarding-step-4')).toBeVisible()
		await page.locator('#skip-syftbox-btn').click()
		await expect(page.locator('.app-layout')).toBeVisible({ timeout: 30_000 })
		await waitForAppReady(page, { timeout: 30_000 })

		// Open profile picker and move/delete the other profile
		await navigateToTab(page, 'settings')
		await expect(page.locator('#profiles-open-picker-btn')).toBeVisible()
		const settingsRows = page.locator('.settings-profile-row')
		await expect(settingsRows).toHaveCount(2)
		await expect(
			settingsRows
				.filter({ hasText: 'profileB@example.com' })
				.locator('.settings-profile-new-instance-btn'),
		).toHaveCount(0)
		await page.locator('#profiles-open-picker-btn').click()
		await expect(page.locator('#profiles-view')).toBeVisible({ timeout: 30_000 })
		const rows = page.locator('.profile-row')
		await expect(rows).toHaveCount(2)
		await expect(
			rows.filter({ hasText: 'profileB@example.com' }).locator('.profile-new-instance-btn'),
		).toHaveCount(0)

		await rows
			.filter({ hasText: 'profileA@example.com' })
			.locator('.profile-new-instance-btn')
			.click()
		const newInstances = await page.evaluate(
			() => window.__TEST_PROFILE_STATE__?.newInstances || [],
		)
		expect(newInstances).toContain('pA')

		// Move profile A (confirm + dialog.open override)
		await rows.filter({ hasText: 'profileA@example.com' }).locator('.profile-move-btn').click()
		await expect(rows).toHaveCount(2)

		// Delete profile A (confirm)
		await rows.filter({ hasText: 'profileA@example.com' }).locator('.profile-delete-btn').click()

		// Only profile B remains
		await expect(page.locator('.profile-row')).toHaveCount(1)
		await expect(page.locator('.profile-row')).toContainText('profileB@example.com')
	})

	test('@profiles-mock picker row click opens profile', async ({ page }) => {
		test.setTimeout(30_000)
		page.on('dialog', (dialog) => {
			dialog.accept().catch(() => {})
		})
		await page.addInitScript(() => {
			const w = window as any
			const STATE_KEY = 'playwright:profiles_state'

			const HOME_A = '/tmp/biovault-playwright/profileA'
			const HOME_B = '/tmp/biovault-playwright/profileB'

			const loadState = () => {
				try {
					const raw = window.sessionStorage.getItem(STATE_KEY)
					if (!raw) return null
					return JSON.parse(raw)
				} catch (_err) {
					return null
				}
			}

			const saveState = (state: any) => {
				try {
					window.sessionStorage.setItem(STATE_KEY, JSON.stringify(state))
				} catch (_err) {
					// ignore
				}
			}

			const initialState = {
				picker: true,
				opened_from_app: false,
				currentHome: HOME_A,
				profiles: [
					{
						id: 'pA',
						email: 'profileA@example.com',
						biovault_home: HOME_A,
						fingerprint: 'fp-A',
						running: false,
						last_used_at: '2025-01-01T00:00:00Z',
					},
					{
						id: 'pB',
						email: 'profileB@example.com',
						biovault_home: HOME_B,
						fingerprint: 'fp-B',
						running: false,
						last_used_at: '2025-01-02T00:00:00Z',
					},
				],
				current_profile_id: 'pA',
				onboardedByHome: { [HOME_A]: true, [HOME_B]: true },
				dialogOpenQueue: [],
				newInstances: [],
			}

			const state = loadState() || initialState
			saveState(state)
			w.__TEST_PROFILE_STATE__ = state

			w.__TEST_DIALOG_OPEN__ = async () => {
				return state.dialogOpenQueue.shift() ?? null
			}

			function configPathForHome(home: string) {
				return `${home}/config.yaml`
			}

			function getCurrentProfile(state: any) {
				return state.profiles.find((p: any) => p.id === state.current_profile_id)
			}

			w.__TEST_INVOKE_OVERRIDE__ = async (cmd: string, args: any = {}) => {
				switch (cmd) {
					case 'profiles_get_boot_state': {
						const profiles = state.profiles.map((p: any) => ({
							id: p.id,
							email: p.email,
							biovault_home: p.biovault_home,
							vault_path: `${p.biovault_home}/.sbc`,
							fingerprint: p.fingerprint,
							onboarded: !!state.onboardedByHome[p.biovault_home],
							running: p.running,
							is_current: p.id === state.current_profile_id,
							last_used_at: p.last_used_at,
						}))
						return {
							enabled: true,
							should_show_picker: state.picker && profiles.length > 0,
							current_profile_id: state.current_profile_id,
							profiles,
							startup_message: null,
							opened_from_app: state.opened_from_app,
						}
					}
					case 'profiles_get_default_home':
						return '/tmp/biovault-playwright/default'
					case 'get_config_path': {
						return configPathForHome(state.currentHome)
					}
					case 'get_database_path':
						return `${state.currentHome}/biovault.db`
					case 'get_app_version':
						return 'test'
					case 'check_is_onboarded': {
						return !!state.onboardedByHome[state.currentHome]
					}
					case 'complete_onboarding': {
						state.onboardedByHome[state.currentHome] = true
						const current = getCurrentProfile(state)
						if (current) current.email = args?.email ?? null
						saveState(state)
						return null
					}
					case 'key_get_status': {
						return {
							identity: args?.email ?? 'tester@example.com',
							vault_path: `${state.currentHome}/.sbc`,
							bundle_path: `${state.currentHome}/.sbc/bundles/tester_example_com.json`,
							export_path: `${state.currentHome}/datasites/tester@example.com/public/crypto/did.json`,
							vault_fingerprint: 'abc123def456',
							exists: true,
						}
					}
					case 'check_dependencies':
						return { dependencies: [] }
					case 'get_saved_dependency_states':
						return { dependencies: [] }
					case 'get_settings': {
						const current = getCurrentProfile(state)
						return {
							docker_path: '',
							java_path: '',
							syftbox_path: '',
							biovault_path: 'bv',
							email: current?.email ?? '',
							ai_api_url: '',
							ai_api_token: '',
							ai_model: '',
							syftbox_server_url: 'https://dev.syftbox.net',
						}
					}
					case 'profiles_switch_in_place': {
						const profileId = args?.profileId
						const p = state.profiles.find((pp: any) => pp.id === profileId)
						if (!p) throw new Error('Unknown profile')
						state.current_profile_id = p.id
						state.currentHome = p.biovault_home
						state.picker = false
						state.opened_from_app = false
						saveState(state)
						return null
					}
					default:
						return undefined
				}
			}
		})

		await page.goto('/', { timeout: 15_000 })
		await expect(page.locator('#profiles-view')).toBeVisible({ timeout: 30_000 })

		await expect(
			page
				.locator('.profile-row')
				.filter({ hasText: 'profileA@example.com' })
				.locator('.profile-new-instance-btn'),
		).toHaveCount(0)

		const profileBRow = page.locator('.profile-row').filter({ hasText: 'profileB@example.com' })
		await profileBRow.click()

		await expect(page.locator('.app-layout')).toBeVisible({ timeout: 30_000 })
		const currentProfileId = await page.evaluate(
			() => window.__TEST_PROFILE_STATE__?.current_profile_id,
		)
		expect(currentProfileId).toBe('pB')
	})
})
