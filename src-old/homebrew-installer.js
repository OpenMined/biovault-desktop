export function createHomebrewInstaller({
	invoke,
	dialog,
	showProgressTask,
	finishProgressTask,
	setButtonLoading,
	updateButtonLoadingLabel,
	clearButtonLoading,
	startCltMonitor,
}) {
	async function runHomebrewInstall({ button, onSuccess } = {}) {
		const taskId = 'install-brew'
		showProgressTask(taskId, 'Installing Homebrew...')
		if (button) {
			setButtonLoading(button, 'Installing Homebrew...')
		}

		try {
			await invoke('install_brew')
			finishProgressTask(taskId, { status: 'success', message: 'Homebrew installed' })

			if (typeof onSuccess === 'function') {
				try {
					await onSuccess()
				} catch (onSuccessError) {
					if (button) {
						clearButtonLoading(button)
					}
					throw onSuccessError
				}
			} else {
				if (button) {
					clearButtonLoading(button)
				}
				await dialog.message(
					'✓ Homebrew installed successfully!\n\nNow you can proceed with installing dependencies.',
					{ title: 'Success', type: 'info' },
				)
			}
		} catch (error) {
			const errorMessage = typeof error === 'string' ? error : error?.message || `${error}`

			if (errorMessage.includes('Command Line Tools must be installed')) {
				showProgressTask(taskId, 'Waiting for Command Line Tools…', { state: 'waiting' })
				if (button) {
					updateButtonLoadingLabel(button, 'Waiting for Command Line Tools...')
				}
				await startCltMonitor(
					async () => {
						await runHomebrewInstall({ button, onSuccess })
					},
					{
						onCancel: () => {
							finishProgressTask(taskId, {
								status: 'error',
								message: 'Command Line Tools installation cancelled',
							})
							if (button) {
								clearButtonLoading(button)
							}
						},
					},
				)
				return
			}

			finishProgressTask(taskId, {
				status: 'error',
				message: 'Homebrew installation failed',
			})
			if (button) {
				clearButtonLoading(button)
			}
			await dialog.message(
				`Failed to install Homebrew: ${errorMessage}\n\nPlease install Homebrew manually from brew.sh`,
				{ title: 'Installation Failed', type: 'error' },
			)
		}
	}

	return {
		runHomebrewInstall,
	}
}
