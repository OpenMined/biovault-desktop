import { ensureTauriBridge } from '$lib/tauri-bridge'

export async function init() {
	await ensureTauriBridge()
}

init()
