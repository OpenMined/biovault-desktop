export function createLogsModule({ invoke }) {
	let commandLogs = []

	async function loadCommandLogs() {
		try {
			const logs = await invoke('get_command_logs')
			commandLogs = logs
			displayLogs()
		} catch (error) {
			console.error('Error loading logs:', error)
		}
	}

	function displayLogs() {
		const logsContent = document.getElementById('logs-content')
		if (commandLogs.length === 0) {
			logsContent.textContent = 'No command logs yet.'
			return
		}

		const MAX_OUTPUT_CHARS = 5000
		let logText = ''

		commandLogs.forEach((log) => {
			logText += `\n${'='.repeat(80)}\n`
			logText += `[${log.timestamp}]\n`
			logText += `Command: ${log.command}\n`
			logText += `${'-'.repeat(80)}\n`

			if (log.output) {
				let output = log.output
				if (output.length > MAX_OUTPUT_CHARS) {
					output =
						output.substring(0, MAX_OUTPUT_CHARS) +
						`\n\n... (output truncated, ${output.length - MAX_OUTPUT_CHARS} chars hidden)`
				}
				logText += output
			}

			if (log.error) {
				logText += `\nERROR: ${log.error}`
			}

			logText += '\n'
		})

		logsContent.textContent = logText
	}

	async function clearLogs() {
		if (!confirm('Are you sure you want to clear all logs?')) {
			return
		}

		try {
			await invoke('clear_command_logs')
			commandLogs = []
			displayLogs()
		} catch (error) {
			alert(`Error clearing logs: ${error}`)
		}
	}

	function copyLogs() {
		const logsContent = document.getElementById('logs-content')
		const text = logsContent.textContent

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
		loadCommandLogs,
		displayLogs,
		clearLogs,
		copyLogs,
	}
}
