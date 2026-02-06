const ANSI_SGR_PATTERN = new RegExp('\\u001B\\[(\\d+(?:;\\d+)*)m', 'g') // eslint-disable-line no-control-regex
const ANSI_CONTROL_PATTERN = new RegExp('\\u001B\\[[0-9;?]*[A-HJKSTfhlpsu]', 'gi') // eslint-disable-line no-control-regex
const ANSI_OSC_PATTERN = new RegExp('\\u001B\\][^\\u0007]*(?:\\u0007|\\u001B\\\\)', 'g') // eslint-disable-line no-control-regex
const ANSI_SPECIAL_PATTERN = new RegExp('\\u001B[\\(\\)][0-9A-Za-z]|\\u001B[=<>]', 'g') // eslint-disable-line no-control-regex
const ANSI_BELL_PATTERN = new RegExp('\\u0007', 'g') // eslint-disable-line no-control-regex

const BASE_COLORS = {
	30: '#000000',
	31: '#c91414',
	32: '#4caf50',
	33: '#d7ba7d',
	34: '#1976d2',
	35: '#c586c0',
	36: '#00acc1',
	37: '#d4d4d4',
	90: '#808080',
	91: '#ff6f6f',
	92: '#6fcf97',
	93: '#fdd835',
	94: '#82aaff',
	95: '#d670d6',
	96: '#4ec9b0',
	97: '#ffffff',
}

const BASE_BG_COLORS = {
	40: '#000000',
	41: '#550000',
	42: '#003300',
	43: '#332b00',
	44: '#000033',
	45: '#330033',
	46: '#003333',
	47: '#222222',
	100: '#444444',
	101: '#6f2c2c',
	102: '#2d682d',
	103: '#665c1e',
	104: '#1f2d5c',
	105: '#5c1f5b',
	106: '#1f5c5b',
	107: '#666666',
}

const DEFAULT_FG = '#d4d4d4'
const DEFAULT_BG = '#1e1e1e'

function escapeHtml(text) {
	return text
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&#39;')
}

function resetAnsiState(state) {
	state.bold = false
	state.dim = false
	state.italic = false
	state.underline = false
	state.strike = false
	state.inverse = false
	state.color = null
	state.background = null
	state.hidden = false
}

function createAnsiState() {
	const state = {}
	resetAnsiState(state)
	return state
}

function xtermToHex(code) {
	if (typeof code !== 'number' || Number.isNaN(code)) return null
	if (code >= 0 && code <= 15) {
		const basic = [
			'#000000',
			'#800000',
			'#008000',
			'#808000',
			'#000080',
			'#800080',
			'#008080',
			'#c0c0c0',
			'#808080',
			'#ff0000',
			'#00ff00',
			'#ffff00',
			'#0000ff',
			'#ff00ff',
			'#00ffff',
			'#ffffff',
		]
		return basic[code]
	}
	if (code >= 16 && code <= 231) {
		const idx = code - 16
		const r = Math.floor(idx / 36)
		const g = Math.floor((idx % 36) / 6)
		const b = idx % 6
		const palette = [0, 95, 135, 175, 215, 255]
		return rgbToHex(palette[r], palette[g], palette[b])
	}
	if (code >= 232 && code <= 255) {
		const shade = 8 + (code - 232) * 10
		return rgbToHex(shade, shade, shade)
	}
	return null
}

function rgbToHex(r, g, b) {
	const clamped = (v) => {
		if (typeof v !== 'number' || Number.isNaN(v)) return 0
		return Math.min(255, Math.max(0, v))
	}
	const toHex = (v) => clamped(v).toString(16).padStart(2, '0')
	return `#${toHex(r)}${toHex(g)}${toHex(b)}`
}

function applyAnsiCodes(state, codes) {
	for (let i = 0; i < codes.length; i += 1) {
		const code = codes[i]
		switch (code) {
			case 0:
				resetAnsiState(state)
				break
			case 1:
				state.bold = true
				state.dim = false
				break
			case 2:
				state.dim = true
				break
			case 3:
				state.italic = true
				break
			case 4:
				state.underline = true
				break
			case 7:
				state.inverse = true
				break
			case 8:
				state.hidden = true
				break
			case 9:
				state.strike = true
				break
			case 22:
				state.bold = false
				state.dim = false
				break
			case 23:
				state.italic = false
				break
			case 24:
				state.underline = false
				break
			case 27:
				state.inverse = false
				break
			case 28:
				state.hidden = false
				break
			case 29:
				state.strike = false
				break
			case 39:
				state.color = null
				break
			case 49:
				state.background = null
				break
			default:
				if ((code >= 30 && code <= 37) || (code >= 90 && code <= 97)) {
					state.color = BASE_COLORS[code] || state.color
				} else if ((code >= 40 && code <= 47) || (code >= 100 && code <= 107)) {
					state.background = BASE_BG_COLORS[code] || state.background
				} else if (code === 38 || code === 48) {
					const isBackground = code === 48
					const mode = codes[i + 1]
					if (mode === 5 && typeof codes[i + 2] !== 'undefined') {
						const hex = xtermToHex(Number(codes[i + 2]))
						if (hex) {
							if (isBackground) state.background = hex
							else state.color = hex
						}
						i += 2
					} else if (mode === 2 && typeof codes[i + 4] !== 'undefined') {
						const r = Number(codes[i + 2])
						const g = Number(codes[i + 3])
						const b = Number(codes[i + 4])
						const hex = rgbToHex(r, g, b)
						if (isBackground) state.background = hex
						else state.color = hex
						i += 4
					}
				}
		}
	}
}

function stateToCss(state) {
	if (state.hidden) return 'opacity: 0'
	const parts = []
	let fg = state.color
	let bg = state.background
	if (state.inverse) {
		const effectiveFg = bg || DEFAULT_BG
		const effectiveBg = fg || DEFAULT_FG
		fg = effectiveFg
		bg = effectiveBg
	}
	if (state.bold) {
		parts.push('font-weight: 600')
	}
	if (state.dim && !state.bold) {
		parts.push('opacity: 0.75')
	}
	if (state.italic) {
		parts.push('font-style: italic')
	}
	if (state.underline || state.strike) {
		const decorations = []
		if (state.underline) decorations.push('underline')
		if (state.strike) decorations.push('line-through')
		parts.push(`text-decoration: ${decorations.join(' ')}`)
	}
	if (fg) {
		parts.push(`color: ${fg}`)
	}
	if (bg) {
		parts.push(`background-color: ${bg}`)
	}
	return parts.join('; ')
}

function stripUnsupportedAnsiSequences(value) {
	const str = typeof value === 'string' ? value : String(value ?? '')
	return str
		.replace(/\r\n/g, '\n')
		.replace(/\r/g, '\n')
		.replace(ANSI_BELL_PATTERN, '')
		.replace(ANSI_OSC_PATTERN, '')
		.replace(ANSI_CONTROL_PATTERN, '')
		.replace(ANSI_SPECIAL_PATTERN, '')
}

function ansiToHtml(value) {
	if (value === undefined || value === null) return ''
	const input = stripUnsupportedAnsiSequences(value)
	let result = ''
	let lastIndex = 0
	let currentStyle = ''
	let spanOpen = false
	const state = createAnsiState()

	let match
	while ((match = ANSI_SGR_PATTERN.exec(input)) !== null) {
		const chunk = input.slice(lastIndex, match.index)
		if (chunk) {
			result += escapeHtml(chunk)
		}
		const codes = match[1].split(';').map((code) => Number(code))
		applyAnsiCodes(state, codes)
		const style = stateToCss(state)
		if (style !== currentStyle) {
			if (spanOpen) {
				result += '</span>'
				spanOpen = false
			}
			if (style) {
				result += `<span style="${style}">`
				spanOpen = true
			}
			currentStyle = style
		}
		lastIndex = match.index + match[0].length
	}
	const tail = input.slice(lastIndex)
	if (tail) {
		result += escapeHtml(tail)
	}
	if (spanOpen) {
		result += '</span>'
	}
	return result
}

export function createLogsModule({ invoke }) {
	let desktopLogText = ''
	const MAX_BYTES = 0 // 0 = full file from backend
	let lastLoadedAt = 0
	let autoRefreshTimer = null
	const AUTO_REFRESH_INTERVAL_MS = 1000
	let hideVerbose = true

	const VERBOSE_PATTERNS = [
		'Found contact:',
		'Peer scan complete:',
		'[Network Dataset Debug]',
		'Dataset scan complete:',
		'sync actions: uploads=0 downloads=0 remote_deletes=0 local_deletes=0 conflicts=0',
		'scan_remote: server returned',
		'sync reconcile start:',
		'SyftBox queue poll',
		'SyftBoxStorage initialized:',
		'read_with_shadow:',
		'bundle resolution error:',
		'bundle not cached:',
		'updateThreadActivity:',
		'GET http://127.0.0.1:7938/v1/sync/status',
	]

	function filterVerboseLines(text) {
		if (!hideVerbose) return text
		return text
			.split('\n')
			.filter((line) => !VERBOSE_PATTERNS.some((pat) => line.includes(pat)))
			.join('\n')
	}

	async function refreshLogs({ force = false } = {}) {
		const now = Date.now()
		if (!force && now - lastLoadedAt < 1000) {
			displayLogs()
			return
		}

		try {
			const logs = await invoke('get_desktop_log_text', { max_bytes: MAX_BYTES })
			desktopLogText = logs
			lastLoadedAt = now
			displayLogs()
		} catch (error) {
			console.error('Error loading logs:', error)
		}
	}

	function setLogsAutoRefreshEnabled(enabled) {
		if (enabled) {
			if (autoRefreshTimer !== null) return
			refreshLogs({ force: true })
			autoRefreshTimer = setInterval(() => {
				refreshLogs({ force: true })
			}, AUTO_REFRESH_INTERVAL_MS)
		} else if (autoRefreshTimer !== null) {
			clearInterval(autoRefreshTimer)
			autoRefreshTimer = null
		}
	}

	function displayLogs() {
		const logsContent = document.getElementById('logs-content')
		if (!logsContent) return
		const filtered = filterVerboseLines(desktopLogText)
		if (!filtered || filtered.trim().length === 0) {
			logsContent.textContent = hideVerbose
				? 'No logs captured yet (verbose logs hidden).'
				: 'No logs captured yet.'
			logsContent.scrollTop = 0
			return
		}

		logsContent.innerHTML = ansiToHtml(filtered)
		logsContent.scrollTop = logsContent.scrollHeight
	}

	function toggleVerbose() {
		hideVerbose = !hideVerbose
		const btn = document.getElementById('toggle-verbose-btn')
		if (btn) {
			btn.textContent = hideVerbose ? 'Hide Verbose' : 'Show All'
			btn.classList.toggle('active', hideVerbose)
		}
		displayLogs()
	}

	async function clearLogs() {
		if (!confirm('Are you sure you want to clear all logs?')) {
			return
		}

		try {
			await invoke('clear_desktop_log')
			desktopLogText = ''
			lastLoadedAt = 0
			displayLogs()
		} catch (error) {
			alert(`Error clearing logs: ${error}`)
		}
	}

	function copyLogs() {
		const logsContent = document.getElementById('logs-content')
		const text = logsContent.textContent || ''

		navigator.clipboard
			.writeText(text)
			.then(() => {
				const btn = document.getElementById('copy-logs-btn')
				const originalText = btn.innerHTML
				btn.innerHTML = '✅ Copied!'
				setTimeout(() => {
					btn.innerHTML = originalText
				}, 2000)
			})
			.catch((err) => {
				alert(`Failed to copy logs: ${err}`)
			})
	}

	return {
		refreshLogs,
		displayLogs,
		setLogsAutoRefreshEnabled,
		clearLogs,
		copyLogs,
		toggleVerbose,
		openLogsFolder: async () => {
			try {
				const dir =
					(await invoke('get_desktop_log_dir', { __wsTimeoutMs: 5000 }).catch(() => null)) ||
					(await invoke('get_env_var', { key: 'BIOVAULT_HOME' })
						.then((home) => (home ? `${home}/logs` : null))
						.catch(() => null)) ||
					(await invoke('get_dev_mode_info')
						.then((info) => (info?.biovault_home ? `${info.biovault_home}/logs` : null))
						.catch(() => null)) ||
					(await invoke('get_env_var', { key: 'HOME' })
						.then((home) => (home ? `${home}/Desktop/BioVault/logs` : null))
						.catch(() => null))
				if (!dir) {
					throw new Error('Unable to resolve logs directory')
				}
				await invoke('open_folder', { path: dir })
			} catch (error) {
				alert(`Failed to open logs folder: ${error}`)
			}
		},
	}
}
