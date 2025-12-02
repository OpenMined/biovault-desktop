import { invoke } from './tauri-shim.js'

async function isDebugBannerEnabled() {
	const flag = await invoke('get_env_var', { key: 'BIOVAULT_DEBUG_BANNER' }).catch(() => '')
	return ['1', 'true', 'yes'].includes((flag || '').toLowerCase())
}

export async function mountDebugBanner() {
	const enabled = await isDebugBannerEnabled()
	if (!enabled) return

	let biovaultHome = ''
	try {
		const configPath = await invoke('get_config_path')
		biovaultHome = configPath?.replace(/config\.yaml$/, '') || ''
	} catch (err) {
		biovaultHome = ''
	}

	let syftboxConfigPath = ''
	try {
		const info = await invoke('get_syftbox_config_info')
		syftboxConfigPath = info?.config_path || ''
	} catch (err) {
		syftboxConfigPath = ''
	}

	const banner = document.createElement('div')
	banner.className = 'debug-banner'

	const parts = []
	parts.push(
		`<span class="debug-pill">BIOVAULT</span><span class="debug-label">${
			biovaultHome || 'n/a'
		}</span>`,
	)
	if (syftboxConfigPath) {
		parts.push(
			`<span class="debug-pill">SYFTBOX CFG</span><span class="debug-label">${syftboxConfigPath}</span>`,
		)
	}

	banner.innerHTML = parts.join('<span style="opacity:0.4">•</span> ')
	document.body.classList.add('with-debug-banner')
	const mountTarget = document.body
	mountTarget.prepend(banner)
}
