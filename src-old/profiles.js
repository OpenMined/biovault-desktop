import { dialog, windowApi, invoke as shimInvoke } from './tauri-shim.js'

function escapeHtml(str) {
	return String(str || '')
		.replaceAll('&', '&amp;')
		.replaceAll('<', '&lt;')
		.replaceAll('>', '&gt;')
		.replaceAll('"', '&quot;')
		.replaceAll("'", '&#039;')
}

function buildIdenticon(seed) {
	const s = String(seed || 'seed')
	let hash = 0
	for (let i = 0; i < s.length; i += 1) {
		hash = (hash * 31 + s.charCodeAt(i)) >>> 0
	}
	const hue = hash % 360
	const fg = `hsl(${hue}, 65%, 45%)`
	const bg = '#f3f4f6'
	const cells = 5
	const size = 15
	const padding = 6
	let bits = hash || 1
	let rects = ''
	for (let y = 0; y < cells; y += 1) {
		for (let x = 0; x < Math.ceil(cells / 2); x += 1) {
			const on = bits & 1
			bits = (bits >> 1) | ((bits & 1) << 31)
			if (on) {
				const rx = padding + x * size
				const ry = padding + y * size
				const mirrorX = padding + (cells - x - 1) * size
				rects += `<rect x="${rx}" y="${ry}" width="${size}" height="${size}" fill="${fg}" rx="3" ry="3"/>`
				if (mirrorX !== rx) {
					rects += `<rect x="${mirrorX}" y="${ry}" width="${size}" height="${size}" fill="${fg}" rx="3" ry="3"/>`
				}
			}
		}
	}
	const dim = padding * 2 + cells * size
	return `<svg width="${dim}" height="${dim}" viewBox="0 0 ${dim} ${dim}" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Identity fingerprint"><rect width="${dim}" height="${dim}" fill="${bg}" rx="12" ry="12"/>${rects}</svg>`
}

function getProfilesRootEl() {
	return document.getElementById('profiles-view')
}

let profilesRefreshTimer = null
let profilesRefreshInFlight = false
let lastProfilesSignature = ''
let profilesOpenedFromApp = false

function isElementVisible(el) {
	if (!el) return false
	const style = window.getComputedStyle(el)
	return style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0'
}

function getProfilesSignature(state) {
	const profiles = Array.isArray(state?.profiles) ? state.profiles : []
	return JSON.stringify({
		current: state?.current_profile_id || '',
		profiles: profiles.map((p) => ({
			id: p.id,
			email: p.email || '',
			home: p.biovault_home,
			running: !!p.running,
			onboarded: !!p.onboarded,
			is_current: !!p.is_current,
			last_used_at: p.last_used_at || '',
		})),
	})
}

function applyProfilesState(state) {
	if (!state) return
	if (profilesOpenedFromApp) {
		state = { ...state, opened_from_app: true }
	}
	lastProfilesSignature = getProfilesSignature(state)
	renderProfilesList(state)
}

function hideAppLayout() {
	const appLayout = document.querySelector('.app-layout')
	if (appLayout) appLayout.style.display = 'none'
}

function showProfilesView() {
	const el = getProfilesRootEl()
	if (!el) return
	el.style.display = 'flex'
	hideAppLayout()
	const onboarding = document.getElementById('onboarding-view')
	if (onboarding) onboarding.style.display = 'none'
}

function hideProfilesView() {
	const el = getProfilesRootEl()
	if (el) el.style.display = 'none'
	const appLayout = document.querySelector('.app-layout')
	if (appLayout) appLayout.style.display = ''
	stopProfilesAutoRefresh()
}

function renderProfilesList(state) {
	const listEl = document.getElementById('profiles-list')
	if (!listEl) return
	const profiles = Array.isArray(state?.profiles) ? state.profiles : []
	const allowCurrentOpen = !!state?.opened_from_app

	if (profiles.length === 0) {
		listEl.innerHTML =
			'<div class="profiles-loading"><p>No profiles found. Add one to continue.</p></div>'
		return
	}

	listEl.innerHTML = profiles
		.map((p) => {
			const email = p.email || '(Not set up yet)'
			const seed = p.fingerprint || p.email || p.id
			const statusText = p.running ? 'Already running' : p.onboarded ? 'Ready' : 'Needs setup'
			const statusClass = p.running ? 'running' : ''
			const openDisabled = p.running && !(allowCurrentOpen && p.is_current) ? 'disabled' : ''
			const newInstanceDisabled = p.running ? 'disabled' : ''
			const showNewInstance = !p.is_current
			const deleteDisabled = p.running || p.is_current ? 'disabled' : ''
			return `
				<div class="profile-row ${p.is_current ? 'current' : ''}" data-profile-id="${escapeHtml(p.id)}">
					<div class="profile-avatar">${buildIdenticon(seed)}</div>
					<div class="profile-meta">
						<div class="profile-email">${escapeHtml(email)}</div>
						<div class="profile-path" title="${escapeHtml(p.biovault_home)}">${escapeHtml(p.biovault_home)}</div>
						<div class="profile-status ${statusClass}">
							<span class="dot"></span><span>${escapeHtml(statusText)}</span>
						</div>
					</div>
					<div class="profile-actions">
						<button class="btn-primary profile-open-btn" ${openDisabled}>Open</button>
						${showNewInstance ? `<button class="btn-secondary profile-new-instance-btn" ${newInstanceDisabled}>New Instance</button>` : ''}
						<button class="btn-secondary profile-move-btn" ${openDisabled}>Move…</button>
						<button class="btn-secondary profile-delete-btn" ${deleteDisabled}>Delete</button>
					</div>
				</div>
			`
		})
		.join('')
}

async function refreshProfilesList({ invoke, force = false } = {}) {
	const viewEl = getProfilesRootEl()
	if (!isElementVisible(viewEl) || document.hidden) return
	if (profilesRefreshInFlight) return
	profilesRefreshInFlight = true
	try {
		const state = await invoke('profiles_get_boot_state')
		if (!state?.enabled) return
		if (profilesOpenedFromApp) {
			state.opened_from_app = true
		}
		const signature = getProfilesSignature(state)
		if (!force && signature === lastProfilesSignature) return
		applyProfilesState(state)
	} catch (err) {
		console.warn('Failed to refresh profiles list:', err)
	} finally {
		profilesRefreshInFlight = false
	}
}

function startProfilesAutoRefresh({ invoke }) {
	if (profilesRefreshTimer) return
	profilesRefreshTimer = setInterval(() => {
		refreshProfilesList({ invoke }).catch(() => {})
	}, 2000)
}

function stopProfilesAutoRefresh() {
	if (profilesRefreshTimer) {
		clearInterval(profilesRefreshTimer)
		profilesRefreshTimer = null
	}
	profilesRefreshInFlight = false
}

function wireProfilesActions({ invoke, state }) {
	const listEl = document.getElementById('profiles-list')
	if (!listEl) return
	const openedFromApp = !!state?.opened_from_app

	const openProfile = async (profileId) => {
		try {
			// Switch profile in-place (no app restart needed)
			await invoke('profiles_switch_in_place', { profileId })
			// Reload the page to initialize with the selected profile
			location.reload()
		} catch (err) {
			console.warn('Failed to switch profile:', err)
			await dialog.message(String(err?.message || err || 'Failed to switch profile'), {
				title: 'Profiles',
				type: 'error',
			})
		}
	}

	const quitBtn = document.getElementById('profiles-quit-btn')
	if (quitBtn) {
		quitBtn.textContent = openedFromApp ? 'Back' : 'Quit'
		quitBtn.style.display = openedFromApp ? '' : 'none'
	}

	listEl.addEventListener('click', async (event) => {
		const target = event.target
		if (!(target instanceof HTMLElement)) return
		const row = target.closest('.profile-row')
		if (!row) return
		const profileId = row.getAttribute('data-profile-id')
		if (!profileId) return
		const actionButton = target.closest('button')
		const openBtn = row.querySelector('.profile-open-btn')

		if (!actionButton) {
			if (openBtn && openBtn.hasAttribute('disabled')) return
			await openProfile(profileId)
			return
		}

		if (actionButton.classList.contains('profile-open-btn')) {
			await openProfile(profileId)
			return
		}

		if (actionButton.classList.contains('profile-new-instance-btn')) {
			try {
				await invoke('profiles_open_new_instance', { profileId })
			} catch (err) {
				console.warn('Failed to open new instance:', err)
				await dialog.message(String(err?.message || err || 'Failed to open new instance'), {
					title: 'Profiles',
					type: 'error',
				})
			}
			return
		}

		if (actionButton.classList.contains('profile-move-btn')) {
			try {
				const ok = await dialog.confirm(
					'Move this profile home folder to a new location? BioVault must not be running in this profile.',
					{ title: 'Move Profile', type: 'warning' },
				)
				if (!ok) return
				const selection = await dialog.open({ directory: true, multiple: false })
				if (!selection) return
				const chosen = Array.isArray(selection) ? selection[0] : selection
				if (!chosen) return
				await invoke('profiles_move_home', { profileId, newHomePath: chosen })
				const state = await invoke('profiles_get_boot_state')
				applyProfilesState(state)
			} catch (error) {
				await dialog.message(String(error?.message || error || 'Failed to move profile'), {
					title: 'Move Profile',
					type: 'error',
				})
			}
			return
		}

		if (actionButton.classList.contains('profile-delete-btn')) {
			try {
				const ok = await dialog.confirm(
					'Delete this profile? This removes it from the list and deletes its home folder.',
					{ title: 'Delete Profile', type: 'warning' },
				)
				if (!ok) return
				await invoke('profiles_delete_profile', { profileId, deleteHome: true })
				const state = await invoke('profiles_get_boot_state')
				applyProfilesState(state)
			} catch (error) {
				await dialog.message(String(error?.message || error || 'Failed to delete profile'), {
					title: 'Delete Profile',
					type: 'error',
				})
			}
			return
		}
	})

	const addBtn = document.getElementById('profiles-add-btn')
	if (addBtn) {
		addBtn.addEventListener('click', async () => {
			try {
				await dialog.message(
					'Choose a folder to use as this profile’s BioVault Home (BIOVAULT_HOME).\n\nTip: use “New Folder” in the picker to name it.',
					{ title: 'Add Profile', type: 'info' },
				)
				const selection = await dialog.open({ directory: true, multiple: false })
				if (!selection) return
				const chosen = Array.isArray(selection) ? selection[0] : selection
				if (!chosen) return
				const ok = await dialog.confirm(`Create and switch to profile home?\n\n${chosen}`, {
					title: 'Add Profile',
					type: 'warning',
				})
				if (!ok) return
				try {
					// Create profile and switch in-place (no app restart needed)
					await invoke('profiles_create_and_switch_in_place', { homePath: chosen })
					// Reload to initialize with the new profile
					location.reload()
				} catch (err) {
					console.warn('Failed to add profile:', err)
					await dialog.message(String(err?.message || err || 'Failed to add profile'), {
						title: 'Profiles',
						type: 'error',
					})
				}
			} catch (error) {
				console.warn('Failed to open folder picker:', error)
			}
		})
	}

	const quitBtnAction = document.getElementById('profiles-quit-btn')
	if (quitBtnAction) {
		quitBtnAction.addEventListener('click', async () => {
			try {
				if (openedFromApp) {
					hideProfilesView()
					return
				}
				const win = windowApi?.getCurrent?.()
				if (win?.close) {
					await win.close()
				} else {
					await shimInvoke('profiles_quit_picker')
				}
			} catch (_err) {
				// ignore
			}
		})
	}
}

async function showProfilesPicker({ invoke, templateLoader, state }) {
	await templateLoader.loadAndInject('profiles', 'profiles-view')
	showProfilesView()
	profilesOpenedFromApp = !!state?.opened_from_app

	const msgEl = document.getElementById('profiles-startup-message')
	if (msgEl && state?.startup_message) {
		msgEl.textContent = state.startup_message
		msgEl.style.display = 'block'
	} else if (msgEl) {
		msgEl.style.display = 'none'
	}

	applyProfilesState(state)
	wireProfilesActions({ invoke, state })
	startProfilesAutoRefresh({ invoke })
	return { shown: true, state }
}

export async function maybeShowProfilesOnStartup({ invoke, templateLoader }) {
	const state = await invoke('profiles_get_boot_state')
	if (!state?.enabled || !state?.should_show_picker) {
		return { shown: false, state }
	}

	return showProfilesPicker({ invoke, templateLoader, state })
}

export async function showProfilesPickerInApp({ invoke, templateLoader }) {
	const state = (await invoke('profiles_get_boot_state')) || {}
	return showProfilesPicker({
		invoke,
		templateLoader,
		state: { ...state, opened_from_app: true },
	})
}
