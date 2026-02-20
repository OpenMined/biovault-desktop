export function createCltManager({ invoke, windowApi }) {
	const cltWaitState = {
		overlay: null,
		intervalId: null,
		active: false,
		onComplete: null,
		onCancel: null,
		windowState: null,
		statusText: null,
		feedbackText: null,
		checkBtn: null,
	}

	function getAppWindow() {
		if (!windowApi) return null
		if (typeof windowApi.getCurrent === 'function') {
			return windowApi.getCurrent()
		}
		return windowApi.appWindow || null
	}

	async function adjustWindowForCltPrompt() {
		const appWindow = getAppWindow()
		if (!appWindow) return
		if (cltWaitState.windowState) return

		try {
			const [size, position] = await Promise.all([appWindow.innerSize(), appWindow.outerPosition()])

			cltWaitState.windowState = { size, position }

			const logicalSizeCtor = windowApi?.LogicalSize
			const logicalPositionCtor = windowApi?.LogicalPosition

			const targetSize = logicalSizeCtor
				? new logicalSizeCtor(780, 560)
				: { width: 780, height: 560 }
			const targetPosition = logicalPositionCtor
				? new logicalPositionCtor(40, 60)
				: { x: 40, y: 60 }

			await appWindow.setSize(targetSize)
			await appWindow.setPosition(targetPosition)
			await appWindow.unminimize()
			await appWindow.show()
		} catch (error) {
			console.warn('Unable to reposition BioVault window for CLT prompt:', error)
		}
	}

	async function restoreWindowAfterCltPrompt() {
		const appWindow = getAppWindow()
		if (!appWindow) return
		const state = cltWaitState.windowState
		cltWaitState.windowState = null
		if (!state) return

		try {
			const logicalSizeCtor = windowApi?.LogicalSize
			const logicalPositionCtor = windowApi?.LogicalPosition

			if (state.size) {
				const originalSize = logicalSizeCtor
					? new logicalSizeCtor(state.size.width, state.size.height)
					: { width: state.size.width, height: state.size.height }
				await appWindow.setSize(originalSize)
			}
			if (state.position) {
				const originalPosition = logicalPositionCtor
					? new logicalPositionCtor(state.position.x, state.position.y)
					: { x: state.position.x, y: state.position.y }
				await appWindow.setPosition(originalPosition)
			}
			await appWindow.show()
			await appWindow.setFocus()
		} catch (error) {
			console.warn('Unable to restore BioVault window after CLT prompt:', error)
		}
	}

	function ensureCltOverlay() {
		if (cltWaitState.overlay) return cltWaitState.overlay

		const existingStyles = document.getElementById('clt-wait-styles')
		if (!existingStyles) {
			const styleEl = document.createElement('style')
			styleEl.id = 'clt-wait-styles'
			styleEl.textContent = `
		@keyframes clt-spin {
			0% { transform: rotate(0deg); }
			100% { transform: rotate(360deg); }
		}
		#clt-wait-overlay {
			position: fixed;
			top: 0;
			left: 0;
			right: 0;
			bottom: 0;
			background: rgba(255, 255, 255, 0.92);
			z-index: 9999;
			display: none;
			align-items: center;
			justify-content: center;
			padding: 24px;
		}
		#clt-wait-overlay[data-visible="true"] {
			display: flex;
		}
		#clt-wait-overlay .clt-card {
			width: 420px;
			max-width: 95vw;
			background: #ffffff;
			border-radius: 16px;
			box-shadow: 0 20px 60px rgba(0, 0, 0, 0.12);
			padding: 28px;
			font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
			color: #222;
		}
		#clt-wait-overlay .clt-header {
			display: flex;
			align-items: center;
			gap: 12px;
			margin-bottom: 16px;
		}
		#clt-wait-overlay .clt-header h2 {
			margin: 0;
			font-size: 20px;
			font-weight: 600;
		}
		#clt-wait-overlay .clt-body {
			font-size: 14px;
			line-height: 1.5;
			color: #444;
			margin-bottom: 18px;
		}
		#clt-wait-overlay .clt-status {
			display: flex;
			gap: 14px;
			align-items: center;
			background: #f6f7fb;
			border-radius: 10px;
			padding: 14px;
			margin-bottom: 18px;
		}
		#clt-wait-overlay .clt-spinner {
			width: 36px;
			height: 36px;
			border-radius: 50%;
			border: 3px solid rgba(70, 95, 255, 0.2);
			border-top-color: #465fff;
			animation: clt-spin 1s linear infinite;
		}
		#clt-wait-overlay .clt-status-text {
			font-size: 14px;
			font-weight: 600;
			color: #1f2933;
			margin: 0 0 4px 0;
		}
		#clt-wait-overlay .clt-feedback {
			margin: 0;
			font-size: 12px;
			color: #6b7280;
		}
		#clt-wait-overlay .clt-actions {
			display: flex;
			justify-content: flex-end;
			gap: 10px;
		}
		#clt-wait-overlay button {
			border-radius: 6px;
			padding: 8px 16px;
			font-weight: 600;
			font-size: 13px;
			cursor: pointer;
			border: none;
		}
		#clt-wait-overlay .clt-cancel-btn {
			background: #f3f4f6;
			color: #4b5563;
		}
		#clt-wait-overlay .clt-cancel-btn:hover {
			background: #e5e7eb;
		}
		#clt-wait-overlay .clt-check-btn {
			background: #465fff;
			color: #ffffff;
		}
		#clt-wait-overlay .clt-check-btn[disabled] {
			opacity: 0.6;
			cursor: not-allowed;
		}
		`
			document.head.appendChild(styleEl)
		}

		const overlay = document.createElement('div')
		overlay.id = 'clt-wait-overlay'
		overlay.innerHTML = `
		<div class="clt-card">
			<div class="clt-header">
				<span style="font-size: 26px;">🛠️</span>
				<h2>Install Command Line Tools</h2>
			</div>
			<p class="clt-body">
				BioVault needs the macOS Command Line Tools before it can install Homebrew. We just opened Apple's installer. Follow the prompts in the Apple dialog shown below.
			</p>
			<div style="display: flex; justify-content: center; margin-bottom: 16px;">
				<img src="assets/xcode-cli-tools.png" alt="Command Line Tools Installer" style="max-width: 100%; border-radius: 8px; box-shadow: 0 12px 28px rgba(31, 41, 55, 0.18);">
			</div>
			<div class="clt-status">
				<div class="clt-spinner"></div>
				<div>
					<p class="clt-status-text">Waiting for installation to finish…</p>
					<p class="clt-feedback">This can take a few minutes. Keep the installer window visible.</p>
				</div>
			</div>
			<div style="font-size: 12px; color: #4b5563; margin-bottom: 18px;">
				<ul style="padding-left: 18px; margin: 0; list-style: disc;">
					<li>Look for the "Install Command Line Developer Tools" window (screenshot above).</li>
					<li>A download progress bar may appear after you click "Install".</li>
					<li>When it finishes, choose "Done" in the Apple dialog.</li>
				</ul>
			</div>
			<div class="clt-actions">
				<button type="button" class="clt-cancel-btn">Cancel</button>
				<button type="button" class="clt-check-btn">I've Finished</button>
			</div>
		</div>
	`

		document.body.appendChild(overlay)

		const cancelBtn = overlay.querySelector('.clt-cancel-btn')
		const checkBtn = overlay.querySelector('.clt-check-btn')
		const statusText = overlay.querySelector('.clt-status-text')
		const feedbackText = overlay.querySelector('.clt-feedback')

		cancelBtn.addEventListener('click', () => {
			cancelCltMonitor('User cancelled Command Line Tools install prompt')
		})

		checkBtn.addEventListener('click', async () => {
			checkBtn.disabled = true
			await checkCltReady(true)
			checkBtn.disabled = false
		})

		cltWaitState.overlay = overlay
		cltWaitState.statusText = statusText
		cltWaitState.feedbackText = feedbackText
		cltWaitState.checkBtn = checkBtn

		return overlay
	}

	async function checkCltReady(fromManual = false) {
		try {
			const ready = await invoke('check_command_line_tools_installed')
			if (ready) {
				handleCltReady()
				return
			}
			if (fromManual && cltWaitState.feedbackText) {
				cltWaitState.feedbackText.textContent =
					"Still waiting for Command Line Tools. Keep the Apple installer running, then click 'I've Finished' once it completes."
			}
		} catch (error) {
			console.error('Failed to check Command Line Tools status:', error)
			if (fromManual && cltWaitState.feedbackText) {
				cltWaitState.feedbackText.textContent =
					'Could not verify yet. Please try again in a moment.'
			}
		}
	}

	async function startCltMonitor(onComplete, options = {}) {
		const overlay = ensureCltOverlay()
		if (cltWaitState.active) {
			cltWaitState.onComplete = onComplete
			cltWaitState.onCancel = options.onCancel || null
			return
		}

		cltWaitState.onComplete = onComplete
		cltWaitState.onCancel = options.onCancel || null
		cltWaitState.active = true
		await adjustWindowForCltPrompt()
		if (cltWaitState.statusText) {
			cltWaitState.statusText.textContent = 'Waiting for installation to finish…'
		}
		if (cltWaitState.feedbackText) {
			cltWaitState.feedbackText.textContent =
				'This can take a few minutes. Keep the installer window visible.'
		}
		overlay.setAttribute('data-visible', 'true')

		if (cltWaitState.intervalId) {
			clearInterval(cltWaitState.intervalId)
		}
		cltWaitState.intervalId = setInterval(() => {
			checkCltReady(false)
		}, 5000)

		checkCltReady(false)
	}

	function cancelCltMonitor(reason) {
		if (cltWaitState.intervalId) {
			clearInterval(cltWaitState.intervalId)
			cltWaitState.intervalId = null
		}
		cltWaitState.active = false
		cltWaitState.onComplete = null
		const cancelCallback = cltWaitState.onCancel
		cltWaitState.onCancel = null
		if (cltWaitState.overlay) {
			cltWaitState.overlay.removeAttribute('data-visible')
		}
		if (reason) {
			console.log(reason)
		}
		if (typeof cancelCallback === 'function') {
			try {
				cancelCallback()
			} catch (error) {
				console.error('CLT cancel callback error:', error)
			}
		}
		restoreWindowAfterCltPrompt()
	}

	async function handleCltReady() {
		if (!cltWaitState.active) return
		if (cltWaitState.intervalId) {
			clearInterval(cltWaitState.intervalId)
			cltWaitState.intervalId = null
		}
		if (cltWaitState.statusText) {
			cltWaitState.statusText.textContent = 'Command Line Tools detected!'
		}
		if (cltWaitState.feedbackText) {
			cltWaitState.feedbackText.textContent = 'Continuing with Homebrew installation…'
		}

		const callback = cltWaitState.onComplete
		cltWaitState.onComplete = null
		cltWaitState.onCancel = null
		cltWaitState.active = false
		await restoreWindowAfterCltPrompt()

		setTimeout(async () => {
			if (cltWaitState.overlay) {
				cltWaitState.overlay.removeAttribute('data-visible')
			}
			if (typeof callback === 'function') {
				try {
					await callback()
				} catch (error) {
					console.error('Error running post-CLT callback:', error)
				}
			}
		}, 600)
	}

	return {
		startCltMonitor,
		cancelCltMonitor,
	}
}
