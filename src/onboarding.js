import { dialog, event } from './tauri-shim.js'

export function initOnboarding({
	invoke,
	checkDependenciesForPanel,
	runHomebrewInstall,
	showProgressTask,
	finishProgressTask,
	setButtonLoading,
	updateButtonLoadingLabel,
	clearButtonLoading,
	copyToClipboard,
	getDependencyResults,
	checkSyftBoxStatus,
}) {
	const LOCKED_BUTTON_ATTR = 'data-locked-original-disabled'
	let dependencyPanelsLocked = false
	let activeDependencyName = null
	let dockerSudoOverlayShown = false
	const dockerSudoOverlayState = {
		element: null,
		continueBtn: null,
		cancelBtn: null,
	}
	const homebrewSudoOverlayState = {
		element: null,
		continueBtn: null,
		cancelBtn: null,
	}
	const dependencyLogs = new Map()
	const dependencyLogStates = new Map()
	let dependencyLogListenersRegistered = false
	let homebrewSudoOverlayShown = false

	function normalizeDependencyName(name) {
		return typeof name === 'string' ? name.trim().toLowerCase() : ''
	}

	function getDependencyLogLines(name) {
		const key = normalizeDependencyName(name)
		if (!dependencyLogs.has(key)) {
			dependencyLogs.set(key, [])
		}
		return dependencyLogs.get(key)
	}

	function getDependencyLogState(name) {
		const key = normalizeDependencyName(name)
		return dependencyLogStates.get(key) || 'idle'
	}

	function setDependencyLogState(name, state) {
		const key = normalizeDependencyName(name)
		dependencyLogStates.set(key, state)

		const detailsPanel = document.getElementById('dep-details-panel')
		if (!detailsPanel) return

		const section = detailsPanel.querySelector(`.dependency-log-section[data-dep-key="${key}"]`)
		if (!section) return

		section.dataset.state = state
		const indicator = section.querySelector('.log-indicator')
		if (indicator) {
			indicator.dataset.state = state
		}
	}

	function updateDependencyLogUI(depName) {
		const key = normalizeDependencyName(depName)
		const detailsPanel = document.getElementById('dep-details-panel')
		if (!detailsPanel) return

		const section = detailsPanel.querySelector(`.dependency-log-section[data-dep-key="${key}"]`)
		if (!section) return

		const state = getDependencyLogState(depName)
		section.dataset.state = state
		const indicator = section.querySelector('.log-indicator')
		if (indicator) {
			indicator.dataset.state = state
		}

		const output = section.querySelector('.dependency-log-output')
		if (!output) return

		const lines = getDependencyLogLines(depName)
		if (!lines.length) {
			section.dataset.visible = 'false'
			output.textContent = ''
			return
		}

		section.dataset.visible = 'true'
		output.textContent = lines.join('\n')
		output.scrollTop = output.scrollHeight
	}

	function beginDependencyInstall(depName) {
		const lines = getDependencyLogLines(depName)
		lines.length = 0
		lines.push('Starting installation…')
		setDependencyLogState(depName, 'running')
		updateDependencyLogUI(depName)
	}

	function appendDependencyLog(depName, line) {
		if (!line) return
		const lines = getDependencyLogLines(depName)
		lines.push(line)
		// Trim very long logs to avoid unbounded growth
		const MAX_LINES = 500
		if (lines.length > MAX_LINES) {
			lines.splice(0, lines.length - MAX_LINES)
		}
		updateDependencyLogUI(depName)
	}

	function ensureDependencyLogListeners() {
		if (dependencyLogListenersRegistered) return
		dependencyLogListenersRegistered = true

		// Stream live log lines from backend
		event
			.listen('dependency-install-log', ({ payload }) => {
				const dep = payload?.dependency
				const line = payload?.line
				if (!dep || typeof line !== 'string') return
				appendDependencyLog(dep, line)

				if (
					detectPlatform() === 'macos' &&
					dep.toLowerCase() === 'docker' &&
					(line.includes('macOS will prompt for your password') ||
						line.includes('Copying Docker.app to /Applications'))
				) {
					showDockerSudoOverlay()
				}

				if (dep.toLowerCase() === 'homebrew') {
					const normalizedLine = line.toLowerCase()
					if (
						normalizedLine.includes('invoking osascript') ||
						normalizedLine.includes('administrator privileges')
					) {
						showHomebrewSudoOverlay()
					}
				}
			})
			.catch((error) => {
				console.error('Failed to attach dependency install log listener:', error)
			})

		// Installation lifecycle notifications
		event
			.listen('dependency-install-start', ({ payload }) => {
				const dep = payload?.dependency
				if (!dep) return
				const lines = getDependencyLogLines(dep)
				if (!lines.length) {
					lines.push('Starting installation…')
				}
				setDependencyLogState(dep, 'running')
				updateDependencyLogUI(dep)
				activeDependencyName = dep.toLowerCase()
				focusDependencyByName(dep)

				if (dep.toLowerCase() === 'docker') {
					dockerSudoOverlayShown = false
					if (detectPlatform() === 'macos') {
						showDockerSudoOverlay()
					}
				}

				if (dep.toLowerCase() === 'homebrew') {
					homebrewSudoOverlayShown = false
					showHomebrewSudoOverlay()
				}
			})
			.catch((error) => {
				console.error('Failed to attach dependency install start listener:', error)
			})

		event
			.listen('dependency-install-finished', ({ payload }) => {
				const dep = payload?.dependency
				if (!dep) return
				const status = payload?.status
				const error = payload?.error
				if (status === 'success') {
					appendDependencyLog(dep, 'Installation complete.')
					setDependencyLogState(dep, 'success')
				} else if (status === 'error') {
					appendDependencyLog(dep, `Installation failed: ${error || 'Unknown error'}`)
					setDependencyLogState(dep, 'error')
				}

				if (dep.toLowerCase() === 'docker') {
					hideDockerSudoOverlay()
				}

				if (dep.toLowerCase() === 'homebrew') {
					hideHomebrewSudoOverlay()
				}
			})
			.catch((error) => {
				console.error('Failed to attach dependency install finished listener:', error)
			})
	}

	function injectDependencyLogSection(container, depName, safeDepNameAttr) {
		if (!container) return
		const existing = container.querySelector('.dependency-log-section')
		if (existing) {
			existing.remove()
		}

		const section = document.createElement('div')
		section.className = 'dependency-log-section'
		section.dataset.depName = safeDepNameAttr
		section.dataset.depKey = normalizeDependencyName(depName)
		section.dataset.visible = 'false'
		section.dataset.state = getDependencyLogState(depName)
		section.innerHTML = `
			<div class="dependency-log-title">
				<span class="log-indicator" data-state="${getDependencyLogState(depName)}"></span>
				<span>Install Output</span>
			</div>
			<pre class="dependency-log-output" aria-live="polite"></pre>
		`
		container.appendChild(section)
		updateDependencyLogUI(depName)
	}

	ensureDependencyLogListeners()

	function findDependencyListItemByName(depName) {
		const normalized = depName?.toLowerCase?.() || ''
		return Array.from(document.querySelectorAll('#deps-list .dep-item')).find((item) => {
			const itemName = (item.dataset.depName || '').toLowerCase()
			return itemName === normalized
		})
	}

	function focusDependencyByName(depName) {
		const normalized = depName?.toLowerCase?.()
		if (!normalized) return

		const results = getDependencyResults()
		const deps = results?.dependencies
		if (!Array.isArray(deps) || !deps.length) return

		const matchIndex = deps.findIndex((dep) => dep.name?.toLowerCase?.() === normalized)
		if (matchIndex === -1) return

		const depItem = document.querySelector(`#deps-list .dep-item[data-dep-index="${matchIndex}"]`)
		if (depItem) {
			depItem.click()
		} else {
			window.showDependencyDetails?.(deps[matchIndex], matchIndex, 'dep-details-panel')
		}
	}

	function disableDetailsPanelButtons() {
		const detailsPanel = document.getElementById('dep-details-panel')
		if (!detailsPanel) return

		detailsPanel.querySelectorAll('button').forEach((btn) => {
			if (!btn.hasAttribute(LOCKED_BUTTON_ATTR)) {
				btn.setAttribute(LOCKED_BUTTON_ATTR, btn.disabled ? 'true' : 'false')
			}
			btn.disabled = true
		})
	}

	function restoreDetailsPanelButtons() {
		const detailsPanel = document.getElementById('dep-details-panel')
		if (!detailsPanel) return

		detailsPanel.querySelectorAll('button').forEach((btn) => {
			const wasDisabled = btn.getAttribute(LOCKED_BUTTON_ATTR)
			if (wasDisabled !== null) {
				btn.disabled = wasDisabled === 'true'
				btn.removeAttribute(LOCKED_BUTTON_ATTR)
			}
		})
	}

	function ensureDockerSudoOverlay() {
		if (dockerSudoOverlayState.element) return dockerSudoOverlayState

		const overlay = document.createElement('div')
		overlay.className = 'docker-sudo-overlay'
		overlay.dataset.visible = 'false'
		overlay.innerHTML = `
			<div class="docker-sudo-card">
				<div class="docker-sudo-icon">🐳</div>
				<h2>Administrator Access Needed</h2>
				<p>
					BioVault needs to copy <strong>Docker.app</strong> into your <strong>/Applications</strong> folder.
					macOS will ask for your administrator password so we can complete the copy.
				</p>
				<div class="docker-sudo-note">
					After the copy finishes, open Docker Desktop manually. The whale icon in your menu bar will turn solid once Docker is fully running.
				</div>
				<p>
					When the macOS password prompt appears, enter your credentials to allow the installation to continue.
				</p>
				<div class="docker-sudo-actions">
					<button type="button" class="docker-sudo-cancel-btn">Cancel</button>
					<button type="button" class="docker-sudo-continue-btn">Continue</button>
				</div>
			</div>
		`

		const cancelBtn = overlay.querySelector('.docker-sudo-cancel-btn')
		const continueBtn = overlay.querySelector('.docker-sudo-continue-btn')

		document.body.appendChild(overlay)
		dockerSudoOverlayState.element = overlay
		dockerSudoOverlayState.cancelBtn = cancelBtn
		dockerSudoOverlayState.continueBtn = continueBtn

		return dockerSudoOverlayState
	}

	function hideDockerSudoOverlay() {
		const { element } = dockerSudoOverlayState
		if (!element) return
		element.dataset.visible = 'false'
		document.body.style.removeProperty('overflow')
		dockerSudoOverlayShown = false
	}

	function showDockerSudoOverlay() {
		const { element, cancelBtn, continueBtn } = ensureDockerSudoOverlay()
		if (dockerSudoOverlayShown) return

		const dismiss = () => {
			cancelBtn?.removeEventListener('click', dismiss)
			continueBtn?.removeEventListener('click', dismiss)
			hideDockerSudoOverlay()
		}

		element.dataset.visible = 'true'
		document.body.style.overflow = 'hidden'
		dockerSudoOverlayShown = true

		cancelBtn?.addEventListener('click', dismiss, { once: true })
		continueBtn?.addEventListener('click', dismiss, { once: true })
	}

	function ensureHomebrewSudoOverlay() {
		if (homebrewSudoOverlayState.element) return homebrewSudoOverlayState

		const overlay = document.createElement('div')
		overlay.className = 'brew-sudo-overlay'
		overlay.dataset.visible = 'false'
		overlay.innerHTML = `
			<div class="brew-sudo-card">
				<div class="brew-sudo-icon">🍺</div>
				<h2>Homebrew Needs Administrator Access</h2>
				<p>
					BioVault is about to install <strong>Homebrew</strong> so it can manage the rest of your dependencies.
					macOS will prompt for an administrator password to allow the installer to finish.
				</p>
				<div class="brew-sudo-note">
					When the password dialog appears, enter the credentials for an administrator account. Once the installer finishes, Homebrew will be ready to use.
				</div>
				<p>
					Keep this window open—BioVault will continue automatically once Homebrew is installed.
				</p>
				<div class="brew-sudo-actions">
					<button type="button" class="brew-sudo-cancel-btn">Dismiss</button>
					<button type="button" class="brew-sudo-continue-btn">Got it</button>
				</div>
			</div>
		`

		const cancelBtn = overlay.querySelector('.brew-sudo-cancel-btn')
		const continueBtn = overlay.querySelector('.brew-sudo-continue-btn')

		document.body.appendChild(overlay)
		homebrewSudoOverlayState.element = overlay
		homebrewSudoOverlayState.cancelBtn = cancelBtn
		homebrewSudoOverlayState.continueBtn = continueBtn

		return homebrewSudoOverlayState
	}

	function hideHomebrewSudoOverlay() {
		const { element } = homebrewSudoOverlayState
		if (!element) return
		element.dataset.visible = 'false'
		document.body.style.removeProperty('overflow')
		homebrewSudoOverlayShown = false
	}

	function showHomebrewSudoOverlay() {
		const { element, cancelBtn, continueBtn } = ensureHomebrewSudoOverlay()
		if (homebrewSudoOverlayShown) return

		const dismiss = () => {
			cancelBtn?.removeEventListener('click', dismiss)
			continueBtn?.removeEventListener('click', dismiss)
			hideHomebrewSudoOverlay()
		}

		element.dataset.visible = 'true'
		document.body.style.overflow = 'hidden'
		homebrewSudoOverlayShown = true

		cancelBtn?.addEventListener('click', dismiss, { once: true })
		continueBtn?.addEventListener('click', dismiss, { once: true })
	}

	function setDependencyPanelsLocked(shouldLock) {
		const depsList = document.getElementById('deps-list')

		dependencyPanelsLocked = shouldLock

		let overlay = depsList?.querySelector('.deps-list-overlay')
		if (shouldLock) {
			if (depsList) {
				if (!overlay) {
					overlay = document.createElement('div')
					overlay.className = 'deps-list-overlay'
					const spinner = document.createElement('span')
					spinner.className = 'spinner'
					overlay.appendChild(spinner)
					depsList.appendChild(overlay)
				}
				depsList.classList.add('deps-list-locked')
				depsList.setAttribute('aria-disabled', 'true')
			}
			disableDetailsPanelButtons()
		} else {
			if (overlay) {
				overlay.remove()
			}
			if (depsList) {
				depsList.classList.remove('deps-list-locked')
				depsList.removeAttribute('aria-disabled')
			}
			restoreDetailsPanelButtons()
		}
	}

	// Wrapper for onboarding
	async function checkDependencies() {
		await checkDependenciesForPanel('deps-list', 'dep-details-panel', false)
		if (dependencyPanelsLocked) {
			setDependencyPanelsLocked(true)
			disableDetailsPanelButtons()
		}
	}

	// Function to show dependency details in right panel (expose globally)
	window.showDependencyDetails = function showDependencyDetails(
		dep,
		depIndex,
		detailsPanelId = 'dep-details-panel',
	) {
		activeDependencyName = dep.name?.toLowerCase?.() || null
		const detailsPanel = document.getElementById(detailsPanelId)
		const safeDepNameAttr = dep.name.replace(/"/g, '&quot;')
		// Docker Desktop can be installed but not running, so treat found=true as installed
		const isInstalled = dep.found

		if (isInstalled) {
			// Show installed dependency details
			let description = dep.description || 'This dependency is installed and ready to use.'

			// Add warning if Docker is installed but not running
			if (dep.name === 'Docker' && dep.running === false) {
				description =
					'Docker Desktop is installed but not currently running. Please start Docker Desktop to use it.'
			}

			detailsPanel.innerHTML = `
				<div style="margin-bottom: 20px;">
					<div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px; gap: 10px;">
						<h3 data-dep-name="${safeDepNameAttr}" style="margin: 0; color: #28a745; font-size: 20px; white-space: nowrap;">✓ ${dep.name}</h3>
						${
							dep.website
								? `
						<button id="open-website-btn-${depIndex}" style="padding: 4px; width: auto; min-width: 0; background: transparent; border: none; cursor: pointer; font-size: 18px; line-height: 1; opacity: 0.7; transition: opacity 0.2s; flex-shrink: 0; margin-left: auto;" title="Open ${dep.name} website" onmouseover="this.style.opacity='1'" onmouseout="this.style.opacity='0.7'">🔗</button>
						`
								: ''
						}
					</div>
					<p style="color: #666; font-size: 13px; margin: 0 0 15px 0;">${description}</p>
				</div>

				<div style="background: #f8f9fa; padding: 15px; border-radius: 6px; margin-bottom: 15px;">
					${
						dep.version
							? `
					<div style="margin-bottom: 12px;">
						<strong style="font-size: 13px; color: #333;">Version:</strong>
						<div style="font-family: monospace; font-size: 12px; color: #666; margin-top: 5px;">${dep.version}</div>
					</div>
					`
							: ''
					}

					${
						dep.running !== null
							? `
					<div style="margin-bottom: 12px;">
						<strong style="font-size: 13px; color: #333;">Status:</strong>
						<div style="font-size: 12px; color: ${dep.running ? '#28a745' : '#dc3545'}; margin-top: 5px;">
							${dep.running ? '🟢 Running' : '🔴 Not Running'}
						</div>
					</div>
					`
							: ''
					}

					<div style="margin-bottom: 12px;">
						<strong style="font-size: 13px; color: #333;">Path:</strong>
						<div style="margin-top: 8px; display: flex; gap: 8px; align-items: center;">
							<input
								type="text"
								id="path-input-${depIndex}"
								value="${dep.path || ''}"
								placeholder="Enter path to ${dep.name} executable"
								autocapitalize="off"
								style="flex: 1; padding: 8px; border: 1px solid #ddd; border-radius: 4px; font-family: monospace; font-size: 12px;"
							/>
						</div>
					</div>

					<div style="display: flex; gap: 8px;">
						<button id="reset-path-btn-${depIndex}" style="padding: 8px 16px; background: #6c757d; color: white; border: none; border-radius: 4px; cursor: pointer; font-size: 12px;">Reset</button>
						<button id="check-path-btn-${depIndex}" style="padding: 8px 16px; background: #17a2b8; color: white; border: none; border-radius: 4px; cursor: pointer; font-size: 12px;">Check Again</button>
					</div>
					<p style="font-size: 10px; color: #666; margin-top: 8px;">Reset auto-detects, Check Again verifies your path</p>
				</div>

			`

			// Add open website handler
			const openWebsiteBtn = document.getElementById(`open-website-btn-${depIndex}`)
			if (openWebsiteBtn) {
				openWebsiteBtn.addEventListener('click', async () => {
					if (dep.website) {
						try {
							// Use custom Tauri command to open URL in default browser
							await invoke('open_url', { url: dep.website })
						} catch (error) {
							console.error('Failed to open URL:', error)
						}
					}
				})
			}

			// Add reset path handler - auto-detect
			const resetPathBtn = document.getElementById(`reset-path-btn-${depIndex}`)
			if (resetPathBtn) {
				resetPathBtn.addEventListener('click', async () => {
					try {
						// Clear custom path by saving empty string, which triggers auto-detect
						await invoke('save_custom_path', { name: dep.name, path: '' })

						// Check the dependency without custom path (auto-detect)
						const result = await invoke('check_single_dependency', { name: dep.name, path: null })

						// Update the dependency data
						dep.found = result.found
						dep.path = result.path
						dep.version = result.version
						dep.running = result.running

						// Update the dependency list item
						const depItem = document.querySelector(`.dep-item[data-dep-index="${depIndex}"]`)
						if (depItem) {
							// Docker Desktop can be installed but not running, so treat found=true as installed
							const isInstalled = dep.found
							let statusIcon = isInstalled ? '✓' : '✗'
							let statusColor = isInstalled ? '#28a745' : '#dc3545'

							// Show warning color if Docker is installed but not running
							if (dep.name === 'Docker' && dep.found && dep.running === false) {
								statusColor = '#ffc107' // Warning yellow
								statusIcon = '⚠️' // Warning icon
							}

							const statusEl = depItem.querySelector('.dep-status')
							if (statusEl) {
								statusEl.textContent = statusIcon
								statusEl.style.color = statusColor
							}
						}

						// Re-render this specific dependency details
						showDependencyDetails(dep, depIndex)

						// Update the UI with the result
						if (result.found) {
							await dialog.message(
								`✓ ${dep.name} auto-detected!\n\nPath: ${result.path}\nVersion: ${
									result.version || 'Unknown'
								}`,
								{ title: 'Success', type: 'info' },
							)
						} else {
							await dialog.message(
								`✗ ${dep.name} not found automatically.\n\nPlease install it or enter a custom path.`,
								{ title: 'Not Found', type: 'warning' },
							)
						}
					} catch (error) {
						await dialog.message(`Error resetting path: ${error}`, {
							title: 'Error',
							type: 'error',
						})
					}
				})
			}

			// Add check path handler - verify custom path
			const checkPathBtn = document.getElementById(`check-path-btn-${depIndex}`)
			if (checkPathBtn) {
				checkPathBtn.addEventListener('click', async () => {
					const pathInput = document.getElementById(`path-input-${depIndex}`)
					const customPath = pathInput.value.trim()

					if (!customPath) {
						await dialog.message('Please enter a path to check', {
							title: 'Empty Path',
							type: 'warning',
						})
						return
					}

					try {
						// Check this single dependency with the custom path (WITHOUT saving first)
						const result = await invoke('check_single_dependency', {
							name: dep.name,
							path: customPath,
						})

						// Update the UI with the result
						if (result.found) {
							// Path is valid - save it and update just this dependency
							await invoke('save_custom_path', { name: dep.name, path: customPath })

							// Update the dependency data
							dep.found = result.found
							dep.path = result.path || customPath
							dep.version = result.version
							dep.running = result.running

							// Update the dependency list item to show as installed
							const depItem = document.querySelector(`.dep-item[data-dep-index="${depIndex}"]`)
							if (depItem) {
								const statusEl = depItem.querySelector('.dep-status')
								if (statusEl) {
									statusEl.textContent = '✓'
									statusEl.style.color = '#28a745'
								}
							}

							// Re-render this specific dependency details
							showDependencyDetails(dep, depIndex)

							await dialog.message(
								`✓ ${dep.name} found!\n\nPath: ${result.path || customPath}\nVersion: ${
									result.version || 'Unknown'
								}`,
								{ title: 'Success', type: 'info' },
							)
						} else {
							// Path is invalid - mark as missing but keep the invalid path in the input
							dep.found = false
							dep.path = null
							dep.version = null
							dep.running = null

							// Update the dependency list item to show as missing
							const depItem = document.querySelector(`.dep-item[data-dep-index="${depIndex}"]`)
							if (depItem) {
								const statusEl = depItem.querySelector('.dep-status')
								if (statusEl) {
									statusEl.textContent = '✗'
									statusEl.style.color = '#dc3545'
								}
							}

							// Re-render as missing dependency (but keep the path in the input)
							showDependencyDetails(dep, depIndex)

							// Keep the invalid path in the input box
							setTimeout(() => {
								const pathInput = document.getElementById(`path-input-${depIndex}`)
								if (pathInput) {
									pathInput.value = customPath
								}
							}, 100)

							await dialog.message(
								`✗ ${dep.name} not found at the specified path.\n\nPlease check the path and try again.`,
								{ title: 'Not Found', type: 'warning' },
							)
						}
					} catch (error) {
						await dialog.message(`Error: ${error}`, {
							title: 'Error',
							type: 'error',
						})
					}
				})
			}
		} else {
			// Show missing dependency details with install button
			const description = dep.description || 'This dependency is not installed.'
			const rawInstructions = dep.install_instructions || 'No installation instructions available'
			const installInstructions = filterInstructionsByOS(rawInstructions)
			const commands = extractCommands(rawInstructions)

			detailsPanel.innerHTML = `
				<div style="margin-bottom: 20px;">
					<div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px; gap: 10px;">
						<h3 data-dep-name="${safeDepNameAttr}" style="margin: 0; color: #dc3545; font-size: 20px; white-space: nowrap;">✗ ${dep.name}</h3>
						${
							dep.website
								? `
						<button id="open-website-btn-${depIndex}" style="padding: 4px; width: auto; min-width: 0; background: transparent; border: none; cursor: pointer; font-size: 18px; line-height: 1; opacity: 0.7; transition: opacity 0.2s; flex-shrink: 0; margin-left: auto;" title="Open ${dep.name} website" onmouseover="this.style.opacity='1'" onmouseout="this.style.opacity='0.7'">🔗</button>
						`
								: ''
						}
					</div>
					<p style="color: #666; font-size: 13px; margin: 0 0 15px 0;">${description}</p>
				</div>

				<div style="background: #f8f9fa; padding: 15px; border-radius: 6px; margin-bottom: 15px;">
					<div style="margin-bottom: 12px;">
						<strong style="font-size: 13px; color: #333;">Path:</strong>
						<div style="margin-top: 8px; display: flex; gap: 8px; align-items: center;">
							<input
								type="text"
								id="path-input-${depIndex}"
								value="${dep.path || ''}"
								placeholder="Enter path to ${dep.name} executable (or install)"
								autocapitalize="off"
								style="flex: 1; padding: 8px; border: 1px solid #ddd; border-radius: 4px; font-family: monospace; font-size: 12px;"
							/>
						</div>
					</div>

					<div style="display: flex; gap: 8px; margin-bottom: 8px;">
						<button id="install-single-btn-${depIndex}" style="padding: 8px 16px; background: #28a745; color: white; border: none; border-radius: 4px; cursor: pointer; font-size: 12px; font-weight: 600;">Install</button>
						<button id="check-path-btn-${depIndex}" style="padding: 8px 16px; background: #17a2b8; color: white; border: none; border-radius: 4px; cursor: pointer; font-size: 12px;">Check Again</button>
					</div>
					<p style="font-size: 10px; color: #666; margin-top: 4px;">Install auto-detects, Check Again verifies your manual path</p>
				</div>

				<div style="background: #fff8e1; padding: 15px; border-left: 4px solid #ffc107; border-radius: 4px; margin-bottom: 20px; position: relative;">
					<div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px;">
						<h4 style="margin: 0; color: #856404; font-size: 14px;">📖 Manual Installation</h4>
						${
							commands.length > 0
								? `
							<button class="copy-cmd-btn" data-command="${encodeURIComponent(
								commands[0],
							)}" style="padding: 2px; min-width: 0; width: auto; background: transparent; border: none; cursor: pointer; font-size: 14px; line-height: 1; opacity: 0.7; transition: opacity 0.2s;" title="Copy command" onmouseover="this.style.opacity='1'" onmouseout="this.style.opacity='0.7'">📋</button>
						`
								: ''
						}
					</div>
					<p style="font-size: 12px; color: #856404; margin-bottom: 10px;">You can also install this dependency manually:</p>

					${
						commands.length > 0
							? commands
									.map(
										(cmd) => `
						<div style="background: #1e1e1e; padding: 10px; border-radius: 4px; margin-bottom: 8px;">
							<pre style="color: #d4d4d4; font-family: 'Courier New', monospace; font-size: 11px; margin: 0; white-space: pre-wrap; word-break: break-all;">${cmd}</pre>
						</div>
					`,
									)
									.join('')
							: `
						<div style="background: #f8f9fa; padding: 10px; border-radius: 4px; font-size: 11px; color: #333; white-space: pre-wrap; font-family: monospace;">${installInstructions}</div>
					`
					}
				</div>
			`

			// Add open website handler
			const openWebsiteBtn = document.getElementById(`open-website-btn-${depIndex}`)
			if (openWebsiteBtn) {
				openWebsiteBtn.addEventListener('click', async () => {
					if (dep.website) {
						try {
							// Use custom Tauri command to open URL in default browser
							await invoke('open_url', { url: dep.website })
						} catch (error) {
							console.error('Failed to open URL:', error)
						}
					}
				})
			}

			// Add install single button handler
			const installSingleBtn = document.getElementById(`install-single-btn-${depIndex}`)
			if (installSingleBtn) {
				installSingleBtn.addEventListener('click', async () => {
					const proceedWithInstall = async () => {
						markDependencyAsInstalling(dep.name)

						const normalizedName =
							dep.name
								.toLowerCase()
								.replace(/[^a-z0-9]+/g, '-')
								.replace(/^-+|-+$/g, '') || 'dependency'
						const taskId = `install-${normalizedName}`

						if (!installSingleBtn.classList.contains('btn-loading')) {
							setButtonLoading(installSingleBtn, `Installing ${dep.name}...`)
						} else {
							updateButtonLoadingLabel(installSingleBtn, `Installing ${dep.name}...`)
						}

						showProgressTask(taskId, `Installing ${dep.name}...`)

						try {
							const installedPath = await invoke('install_dependency', { name: dep.name })
							finishProgressTask(taskId, { status: 'success', message: `${dep.name} installed` })
							clearButtonLoading(installSingleBtn)

							if (installedPath) {
								const pathInput = document.getElementById(`path-input-${depIndex}`)
								if (pathInput) {
									pathInput.value = installedPath
								}

								await dialog.message(
									`✓ ${dep.name} installed successfully!\n\nPath: ${installedPath}`,
									{ title: 'Success', type: 'info' },
								)
							} else {
								await dialog.message(
									`✓ ${dep.name} installed successfully!\n\nPlease check the path detection using 'Check Again'.`,
									{ title: 'Success', type: 'info' },
								)
							}

							await checkDependencies()
						} catch (error) {
							const errorMessage = typeof error === 'string' ? error : error?.message || `${error}`

							finishProgressTask(taskId, {
								status: 'error',
								message: `Failed to install ${dep.name}`,
							})
							clearButtonLoading(installSingleBtn)

							await dialog.message(`Failed to install ${dep.name}: ${errorMessage}`, {
								title: 'Installation Failed',
								type: 'error',
							})
						}

						injectDependencyLogSection(detailsPanel, dep.name, safeDepNameAttr)
					}

					const confirmed = await dialog.confirm(
						`Install ${dep.name}?\n\nBioVault will attempt to install this dependency for you.`,
						{ title: 'Confirm Installation', type: 'warning' },
					)
					if (!confirmed) {
						return
					}

					const currentPlatform = detectPlatform()
					if (currentPlatform === 'macos') {
						try {
							const brewInstalled = await invoke('check_brew_installed')
							if (!brewInstalled) {
								const installBrew = await dialog.confirm(
									'Homebrew is required to install this dependency.\n\nWould you like to install Homebrew first?',
									{ title: 'Homebrew Required', type: 'warning' },
								)

								if (!installBrew) {
									return
								}

								await runHomebrewInstall({
									button: installSingleBtn,
									onSuccess: async () => {
										updateButtonLoadingLabel(installSingleBtn, `Installing ${dep.name}...`)
										await proceedWithInstall()
									},
								})
								return
							}
						} catch (error) {
							console.error('Failed to check brew installation:', error)
							await dialog.message(`Unable to verify Homebrew installation: ${error}`, {
								title: 'Error',
								type: 'error',
							})
							return
						}
					}

					await proceedWithInstall()
				})
			}

			// Add check path handler - verify manual path for missing dependency
			const checkPathBtn = document.getElementById(`check-path-btn-${depIndex}`)
			if (checkPathBtn) {
				checkPathBtn.addEventListener('click', async () => {
					const pathInput = document.getElementById(`path-input-${depIndex}`)
					const customPath = pathInput.value.trim()

					if (!customPath) {
						await dialog.message('Please enter a path to check, or use the Install button', {
							title: 'Empty Path',
							type: 'warning',
						})
						return
					}

					try {
						// Check this single dependency with the custom path (WITHOUT saving first)
						const result = await invoke('check_single_dependency', {
							name: dep.name,
							path: customPath,
						})

						// Update the UI with the result
						if (result.found) {
							// Path is valid - save it and update just this dependency
							await invoke('save_custom_path', { name: dep.name, path: customPath })

							// Update the dependency data
							dep.found = result.found
							dep.path = result.path || customPath
							dep.version = result.version
							dep.running = result.running

							// Update the dependency list item
							const depItem = document.querySelector(`.dep-item[data-dep-index="${depIndex}"]`)
							if (depItem) {
								const statusEl = depItem.querySelector('.dep-status')
								if (statusEl) {
									statusEl.textContent = '✓'
									statusEl.style.color = '#28a745'
								}
							}

							// Re-render this specific dependency details
							showDependencyDetails(dep, depIndex)

							await dialog.message(
								`✓ ${dep.name} found!\n\nPath: ${result.path || customPath}\nVersion: ${
									result.version || 'Unknown'
								}`,
								{ title: 'Success', type: 'info' },
							)
						} else {
							// Path is invalid - don't save it
							await dialog.message(
								`✗ ${dep.name} not found at the specified path.\n\nPlease check the path and try again.`,
								{ title: 'Not Found', type: 'warning' },
							)
						}
					} catch (error) {
						await dialog.message(`Error: ${error}`, {
							title: 'Error',
							type: 'error',
						})
					}
				})
			}

			// Add copy button handlers
			document.querySelectorAll('.copy-cmd-btn').forEach((btn) => {
				btn.addEventListener('click', async (e) => {
					e.stopPropagation()
					const command = decodeURIComponent(btn.dataset.command)
					await copyToClipboard(command)
					// Just copy silently, no visual change
				})
			})
		}

		if (dependencyPanelsLocked) {
			disableDetailsPanelButtons()
		}
	}

	// Helper function to detect current platform
	function detectPlatform() {
		const userAgent = navigator.userAgent.toLowerCase()
		const platform = navigator.platform.toLowerCase()

		if (platform.indexOf('mac') !== -1 || userAgent.indexOf('macintosh') !== -1) {
			return 'macos'
		} else if (platform.indexOf('win') !== -1 || userAgent.indexOf('windows') !== -1) {
			return 'windows'
		} else if (platform.indexOf('linux') !== -1 || userAgent.indexOf('linux') !== -1) {
			return 'linux'
		}
		return 'unknown'
	}

	// Helper function to filter install instructions by current OS
	function filterInstructionsByOS(instructions) {
		const currentPlatform = detectPlatform()
		const lines = instructions.split('\n')
		const filteredLines = []

		const isLinuxLabel = (label) =>
			['ubuntu', 'debian', 'rhel', 'centos', 'linux', 'arch', 'fedora'].includes(label)

		for (const line of lines) {
			const trimmed = line.trim()

			if (!trimmed) continue

			const parts = trimmed.split(/:\s*/, 2)
			if (parts.length === 2) {
				const [rawLabel, instruction] = parts
				const labels = rawLabel
					.split(/[/,]|\band\b/i)
					.map((label) => label.trim().toLowerCase())
					.filter(Boolean)

				const hasKnownLabel = labels.some((label) => {
					if (label === 'macos' || label === 'windows') return true
					return isLinuxLabel(label)
				})

				if (!hasKnownLabel) {
					filteredLines.push(trimmed)
					continue
				}

				const matchesPlatform = labels.some((label) => {
					if (currentPlatform === 'macos') return label === 'macos'
					if (currentPlatform === 'windows') return label === 'windows'
					if (currentPlatform === 'linux') return isLinuxLabel(label)
					return false
				})

				if (matchesPlatform) {
					filteredLines.push(instruction)
				}
				// Skip non-matching labelled lines entirely
			} else {
				filteredLines.push(trimmed)
			}
		}

		return filteredLines.length > 0 ? filteredLines.join('\n') : instructions
	}

	// Helper function to extract CLI commands from install instructions
	function extractCommands(instructions) {
		// First filter by OS
		const filteredInstructions = filterInstructionsByOS(instructions)

		const commands = []
		const lines = filteredInstructions.split('\n')
		for (const line of lines) {
			const trimmed = line.trim()

			// Skip empty lines
			if (!trimmed) continue

			// Match lines that contain shell commands
			// Pattern: optional text followed by command
			const commandPattern =
				/(?:.*?:\s*)?((?:brew|apt-get|apt|yum|dnf|pacman|pip|npm|cargo|curl|wget|sudo)\s+.+)/i
			const match = trimmed.match(commandPattern)

			if (match) {
				// Extract just the command part (group 1)
				commands.push(match[1].trim())
			} else if (
				trimmed.match(/^(brew|apt-get|apt|yum|dnf|pacman|pip|npm|cargo|curl|wget|sudo)/i)
			) {
				// Fallback: if line starts with a command, use the whole line
				commands.push(trimmed)
			}
		}
		return commands
	}

	// Function to display dependencies (expose globally for settings page)
	window.displayDependencies = function displayDependencies(
		result,
		listPanelId = 'deps-list',
		detailsPanelId = 'dep-details-panel',
		isSettings = false,
	) {
		const depsList = document.getElementById(listPanelId)
		const nextBtn = isSettings ? null : document.getElementById('onboarding-next-2')
		const installBtn = isSettings
			? document.getElementById('settings-install-missing-deps-btn')
			: document.getElementById('install-missing-deps-btn')

		let html = ''

		result.dependencies.forEach((dep, index) => {
			// Docker Desktop can be installed but not running, so treat found=true as installed
			const isInstalled = dep.found

			let statusIcon = isInstalled ? '✓' : '✗'
			let statusColor = isInstalled ? '#28a745' : '#dc3545'
			const safeNameAttr = dep.name.replace(/"/g, '&quot;')

			// Show warning color if Docker is installed but not running
			if (dep.name === 'Docker' && dep.found && dep.running === false) {
				statusColor = '#ffc107' // Warning yellow
				statusIcon = '⚠️' // Warning icon
			}

			html += `
				<div class="dep-item" data-dep-index="${index}" data-dep-name="${safeNameAttr}" style="display: flex; align-items: center; gap: 8px; padding: 10px; background: white; border-radius: 6px; margin-bottom: 8px; cursor: pointer; border: 2px solid transparent; transition: all 0.2s;">
					<span class="dep-status" style="color: ${statusColor};">${statusIcon}</span>
					<strong style="font-size: 13px; color: #333; flex: 1;">${dep.name}</strong>
				</div>
			`
		})

		depsList.innerHTML = html

		// Add click handlers for ALL dependencies
		document.querySelectorAll(`#${listPanelId} .dep-item`).forEach((item) => {
			item.addEventListener('click', () => {
				const depIndex = parseInt(item.dataset.depIndex)
				const dep = result.dependencies[depIndex]
				activeDependencyName = dep.name?.toLowerCase?.() || null

				// Show details in right panel
				window.showDependencyDetails?.(dep, depIndex, detailsPanelId)

				// Highlight selected item
				document.querySelectorAll(`#${listPanelId} .dep-item`).forEach((i) => {
					i.style.borderColor = 'transparent'
					i.style.background = 'white'
				})
				item.style.borderColor = '#0066cc'
				item.style.background = '#f0f8ff'
			})

			// Add hover effect
			item.addEventListener('mouseenter', () => {
				if (item.style.borderColor !== 'rgb(0, 102, 204)') {
					item.style.background = '#f8f9fa'
				}
			})
			item.addEventListener('mouseleave', () => {
				if (item.style.borderColor !== 'rgb(0, 102, 204)') {
					item.style.background = 'white'
				}
			})
		})

		// Enable/disable buttons based on dependencies
		// Check if there are actually missing dependencies (not just not running)
		const actuallyMissing = result.dependencies.some((dep) => !dep.found)

		// For onboarding, we allow proceeding if all deps are FOUND (installed)
		// even if some services like Docker aren't running
		const allDepsFound = result.dependencies.every((dep) => dep.found)

		if (allDepsFound) {
			if (nextBtn) nextBtn.disabled = false
			// Disable Install Missing if nothing is actually missing
			if (installBtn) installBtn.disabled = !actuallyMissing
		} else {
			if (nextBtn) nextBtn.disabled = true
			// Only enable Install Missing if there are dependencies that need installation
			if (installBtn) installBtn.disabled = !actuallyMissing
		}

		// Auto-select first missing dependency, or first one if all installed
		const items = document.querySelectorAll(`#${listPanelId} .dep-item`)
		if (items.length > 0) {
			let indexToSelect = null

			if (activeDependencyName) {
				const matchIndex = result.dependencies.findIndex(
					(dep) => dep.name?.toLowerCase?.() === activeDependencyName,
				)
				if (matchIndex !== -1) {
					indexToSelect = matchIndex
				}
			}

			if (indexToSelect === null) {
				// Find first missing dependency
				let firstMissing = null
				result.dependencies.forEach((dep, index) => {
					// Docker Desktop can be installed but not running, so treat found=true as installed
					const isInstalled = dep.found
					if (!isInstalled && firstMissing === null) {
						firstMissing = index
					}
				})
				indexToSelect = firstMissing !== null ? firstMissing : 0
			}

			const itemToSelect = items[indexToSelect]

			if (itemToSelect) {
				itemToSelect.click()
			}
		}
	}

	// Step 1: Welcome -> Step 2
	const nextBtn1 = document.getElementById('onboarding-next-1')
	if (nextBtn1) {
		nextBtn1.addEventListener('click', () => {
			document.getElementById('onboarding-step-1').style.display = 'none'
			document.getElementById('onboarding-step-2').style.display = 'block'
			// Check dependencies when entering step 2
			checkDependencies()
		})
	}

	// Check Again button
	const checkAgainBtn = document.getElementById('check-again-btn')
	if (checkAgainBtn) {
		checkAgainBtn.addEventListener('click', async () => {
			// Disable button during check to prevent multiple simultaneous checks
			const originalText = checkAgainBtn.textContent
			checkAgainBtn.disabled = true
			checkAgainBtn.innerHTML =
				'<span class="spinner" style="width: 14px; height: 14px;"></span> Checking...'

			try {
				await checkDependencies()
			} finally {
				// Re-enable button after check completes
				checkAgainBtn.disabled = false
				checkAgainBtn.textContent = originalText
			}
		})
	}

	// Helper function to show installing state for a specific dependency
	function markDependencyAsInstalling(depName) {
		activeDependencyName = depName?.toLowerCase?.() || null

		const depItem = findDependencyListItemByName(depName)
		if (!depItem) return

		const statusEl = depItem.querySelector('.dep-status')
		if (!statusEl) return

		statusEl.innerHTML =
			'<span class="spinner" style="width: 16px; height: 16px; border-width: 2px; border-color: rgba(0, 0, 0, 0.2); border-top-color: #0066cc;"></span>'
		statusEl.style.color = '#0066cc'

		beginDependencyInstall(depName)
		focusDependencyByName(depName)

		const currentResults = getDependencyResults()
		if (currentResults?.dependencies?.length) {
			const matchIndex = currentResults.dependencies.findIndex(
				(item) => item.name?.toLowerCase() === depName.toLowerCase(),
			)
			if (matchIndex !== -1) {
				const depInfo = currentResults.dependencies[matchIndex]
				window.showDependencyDetails?.(depInfo, matchIndex, 'dep-details-panel')
			}
		}

		const heading = Array.from(
			document.querySelectorAll('#dep-details-panel h3[data-dep-name]'),
		).find((el) => (el.dataset.depName || '').toLowerCase() === depName.toLowerCase())

		if (heading) {
			const displayName = heading.dataset.depName || depName
			heading.innerHTML = `<span class="spinner" style="width: 18px; height: 18px; border-width: 2px; border-color: rgba(0, 0, 0, 0.2); border-top-color: #0066cc; margin-right: 8px;"></span>${displayName}`
			heading.style.color = '#0066cc'
		}

		if (depName.toLowerCase() === 'docker' && detectPlatform() === 'macos') {
			showDockerSudoOverlay()
			dockerSudoOverlayShown = true
		}
	}

	// Install Missing button - installs all missing dependencies
	const installMissingBtn = document.getElementById('install-missing-deps-btn')
	if (installMissingBtn) {
		let installCancelled = false

		installMissingBtn.addEventListener('click', async () => {
			const dependencyResults = getDependencyResults()
			if (!dependencyResults) return

			// Find all missing dependencies (only check if found, not if running)
			// Docker Desktop can be installed but not running - that's OK for onboarding
			const missingDeps = dependencyResults.dependencies.filter((dep) => {
				return !dep.found
			})

			if (missingDeps.length === 0) return

			const depNames = missingDeps.map((d) => d.name).join(', ')
			const confirmed = await dialog.confirm(
				`Install the following missing dependencies?\n\n${depNames}\n\nBioVault will attempt to install these automatically. This may take several minutes.`,
				{ title: 'Confirm Installation', type: 'warning' },
			)

			if (confirmed) {
				installCancelled = false

				// Check if any missing dependencies require Homebrew (on macOS)
				const currentPlatform = detectPlatform()
				const homebrewDeps = ['java', 'nextflow'] // Dependencies that need Homebrew on macOS
				const needsHomebrew = missingDeps.some((dep) =>
					homebrewDeps.includes(dep.name.toLowerCase()),
				)

				if (currentPlatform === 'macos' && needsHomebrew) {
					try {
						const brewInstalled = await invoke('check_brew_installed')
						if (!brewInstalled) {
							const installBrew = await dialog.confirm(
								'Homebrew is required to install some dependencies (Java, Nextflow).\n\nWould you like to install Homebrew first?',
								{ title: 'Homebrew Required', type: 'warning' },
							)

							if (!installBrew) {
								return
							}

							// Install Homebrew before proceeding
							installMissingBtn.disabled = true
							installMissingBtn.innerHTML = '<span class="spinner"></span> Installing Homebrew...'

							try {
								await runHomebrewInstall({
									button: installMissingBtn,
									onSuccess: null, // Will continue below
								})
								// Reset button after Homebrew install
								installMissingBtn.textContent = 'Install Missing'
								installMissingBtn.disabled = false
							} catch (error) {
								console.error('Homebrew installation failed:', error)
								installMissingBtn.disabled = false
								installMissingBtn.textContent = 'Install Missing'
								// Don't continue with dependency installation if Homebrew failed
								return
							}
						}
					} catch (error) {
						console.error('Failed to check brew installation:', error)
						await dialog.message(`Unable to verify Homebrew installation: ${error}`, {
							title: 'Error',
							type: 'error',
						})
						return
					}
				}

				// Get all buttons to disable during installation
				const checkAgainBtn = document.getElementById('check-again-btn')
				const skipBtn = document.getElementById('skip-dependencies-btn')
				const nextBtn = document.getElementById('onboarding-next-2')

				// Store original button states
				const originalInstallContent = installMissingBtn.innerHTML
				const originalCheckText = checkAgainBtn?.textContent
				const originalCheckDisabled = checkAgainBtn?.disabled

				// Disable all action buttons and change Check Again to Cancel
				installMissingBtn.disabled = true
				if (skipBtn) skipBtn.disabled = true
				if (nextBtn) nextBtn.disabled = true
				if (checkAgainBtn) {
					checkAgainBtn.textContent = 'Cancel'
					checkAgainBtn.disabled = false
					checkAgainBtn.onclick = () => {
						installCancelled = true
						checkAgainBtn.textContent = 'Cancelling...'
						checkAgainBtn.disabled = true
					}
				}

				setDependencyPanelsLocked(true)

				console.log(
					'🔧 Starting installation of dependencies:',
					missingDeps.map((d) => d.name),
				)

				let successCount = 0
				let errorCount = 0
				const errors = []

				try {
					// Install dependencies one at a time and refresh UI after each
					for (let i = 0; i < missingDeps.length; i++) {
						if (installCancelled) {
							console.log('⚠️  Installation cancelled by user')
							break
						}

						const dep = missingDeps[i]
						const progress = `(${i + 1}/${missingDeps.length})`

						// Update button text
						installMissingBtn.innerHTML = `<span class="spinner"></span> Installing ${dep.name} ${progress}...`
						console.log(`🔧 Installing ${dep.name} ${progress}`)

						// Show spinner on the specific dependency in the left panel
						markDependencyAsInstalling(dep.name)

						try {
							await invoke('install_dependency', { name: dep.name })
							console.log(`✅ ${dep.name} installed successfully`)
							successCount++
						} catch (error) {
							console.error(`❌ Failed to install ${dep.name}:`, error)
							errors.push({ name: dep.name, error: error.toString() })
							errorCount++
						}

						// Refresh dependencies panel after each install to show live progress
						await checkDependencies()
					}
				} finally {
					setDependencyPanelsLocked(false)
				}

				// Re-enable buttons and restore original states
				installMissingBtn.innerHTML = originalInstallContent
				installMissingBtn.disabled = true
				if (skipBtn) skipBtn.disabled = false
				if (nextBtn) {
					// Re-check if we should enable Next button
					const results = getDependencyResults()
					if (results) {
						const allFound = results.dependencies.every((dep) => dep.found)
						nextBtn.disabled = !allFound
					}
				}
				if (checkAgainBtn) {
					checkAgainBtn.textContent = originalCheckText
					checkAgainBtn.disabled = originalCheckDisabled
					checkAgainBtn.onclick = null
				}

				// Show summary of results
				if (installCancelled) {
					await dialog.message(
						`Installation cancelled.\n\n${successCount} dependencies installed successfully before cancellation.`,
						{
							title: 'Installation Cancelled',
							type: 'info',
						},
					)
				} else if (errorCount > 0) {
					const errorDetails = errors.map((e) => `${e.name}: ${e.error}`).join('\n\n')
					await dialog.message(
						`Installation completed with ${successCount} successful and ${errorCount} failed.\n\nErrors:\n${errorDetails}`,
						{
							title: 'Installation Complete',
							type: 'warning',
						},
					)
				} else {
					console.log(`✅ All ${successCount} dependencies installed successfully`)
				}
			}
		})
	}

	// Skip dependencies button on onboarding step 1
	const skipDepsBtn = document.getElementById('skip-dependencies-btn')
	if (skipDepsBtn) {
		skipDepsBtn.addEventListener('click', async () => {
			skipDepsBtn.disabled = true
			try {
				const confirmed = await dialog.confirm(
					'Warning: Skipping dependency checks may cause BioVault to not function properly.\n\n' +
						'Some features may not work without the required dependencies installed.\n\n' +
						'Are you sure you want to skip?',
					{ title: 'Skip Dependency Checks?', type: 'warning' },
				)

				if (!confirmed) {
					return
				}

				try {
					await invoke('update_saved_dependency_states')
				} catch (error) {
					console.error('Failed to save skipped state:', error)
				}

				document.getElementById('onboarding-step-2').style.display = 'none'
				document.getElementById('onboarding-step-3').style.display = 'block'
			} finally {
				skipDepsBtn.disabled = false
			}
			// If not confirmed, stay on the current page
		})
	}

	// Step 2: Dependencies -> Step 3
	const nextBtn2 = document.getElementById('onboarding-next-2')
	if (nextBtn2) {
		nextBtn2.addEventListener('click', () => {
			document.getElementById('onboarding-step-2').style.display = 'none'
			document.getElementById('onboarding-step-3').style.display = 'block'
		})
	}

	// Step 3: Back to Step 2
	const backBtn3 = document.getElementById('onboarding-back-3')
	if (backBtn3) {
		backBtn3.addEventListener('click', () => {
			document.getElementById('onboarding-step-3').style.display = 'none'
			document.getElementById('onboarding-step-2').style.display = 'block'
		})
	}

	// Email validation function
	function isValidEmail(email) {
		// More thorough email validation
		if (!email || email.length < 3) return false

		// Split on @ to check parts
		const parts = email.split('@')
		if (parts.length !== 2) return false

		const [localPart, domain] = parts

		// Check local part (before @)
		if (!localPart || localPart.length === 0 || localPart.length > 64) return false
		if (localPart.startsWith('.') || localPart.endsWith('.')) return false
		if (localPart.includes('..')) return false

		// Check domain part (after @)
		if (!domain || domain.length < 3) return false

		// Domain must have at least one dot and a TLD
		const domainParts = domain.split('.')
		if (domainParts.length < 2) return false

		// Check each domain part
		for (const part of domainParts) {
			if (!part || part.length === 0) return false
			if (part.length > 63) return false
			if (part.startsWith('-') || part.endsWith('-')) return false
			// Only allow alphanumeric and hyphens
			if (!/^[a-zA-Z0-9-]+$/.test(part)) return false
		}

		// TLD should be at least 2 characters
		const tld = domainParts[domainParts.length - 1]
		if (tld.length < 2) return false

		// TLD should not be all numbers
		if (/^\d+$/.test(tld)) return false

		return true
	}

	// Email input validation
	const emailInput = document.getElementById('onboarding-email')
	const emailValidationMsg = document.getElementById('email-validation-message')

	if (emailInput) {
		// Disable Next button initially
		const nextBtn3 = document.getElementById('onboarding-next-3')
		if (nextBtn3) {
			nextBtn3.disabled = true
			nextBtn3.style.opacity = '0.5'
			nextBtn3.style.cursor = 'not-allowed'
		}

		// Real-time email validation
		emailInput.addEventListener('input', () => {
			const email = emailInput.value.trim()
			const isValid = isValidEmail(email)

			if (nextBtn3 && emailValidationMsg) {
				if (isValid) {
					nextBtn3.disabled = false
					nextBtn3.style.opacity = '1'
					nextBtn3.style.cursor = 'pointer'
					emailInput.style.borderColor = '#28a745'
					emailValidationMsg.textContent = '✓ Valid email address'
					emailValidationMsg.style.color = '#28a745'
				} else {
					nextBtn3.disabled = true
					nextBtn3.style.opacity = '0.5'
					nextBtn3.style.cursor = 'not-allowed'
					if (email.length > 0) {
						emailInput.style.borderColor = '#dc3545'
						// Provide specific error messages
						if (!email.includes('@')) {
							emailValidationMsg.textContent = '✗ Email must contain @'
						} else if (email.endsWith('@')) {
							emailValidationMsg.textContent = '✗ Please enter domain after @'
						} else if (!email.includes('.', email.indexOf('@'))) {
							emailValidationMsg.textContent = '✗ Domain must contain a dot'
						} else {
							emailValidationMsg.textContent = '✗ Please enter a valid email'
						}
						emailValidationMsg.style.color = '#dc3545'
					} else {
						emailInput.style.borderColor = '#ddd'
						emailValidationMsg.textContent = ''
					}
				}
			}
		})

		// Allow pressing Enter to proceed when email is valid
		emailInput.addEventListener('keydown', (event) => {
			if (event.key === 'Enter') {
				event.preventDefault()
				if (nextBtn3 && !nextBtn3.disabled) {
					nextBtn3.click()
				}
			}
		})
	}

	// Step 3: Email -> Step 4 (SyftBox OTP) or Step 5 (if dev mode)
	const nextBtn3 = document.getElementById('onboarding-next-3')
	if (nextBtn3) {
		nextBtn3.addEventListener('click', async () => {
			const email = document.getElementById('onboarding-email').value.trim()
			if (!isValidEmail(email)) {
				await dialog.message('Please enter a valid email address', {
					title: 'Invalid Email',
					type: 'error',
				})
				return
			}

			// Check if we're in dev mode with syftbox enabled
			try {
				const isDevMode = await invoke('is_dev_mode')
				const isDevSyftbox = await invoke('is_dev_syftbox_enabled')

				if (isDevMode && isDevSyftbox) {
					console.log('🧪 Dev mode detected - checking syftbox server...')

					// Check if syftbox server is reachable
					const serverReachable = await invoke('check_dev_syftbox_server')

					if (serverReachable) {
						console.log('✅ Dev syftbox server reachable - skipping auth, going directly to init')

						// Skip step 4 (auth) and go directly to step 5 (init)
						document.getElementById('onboarding-step-3').style.display = 'none'
						document.getElementById('onboarding-step-5').style.display = 'block'

						// Initialize BioVault directly
						initializeBioVault(email)
						return
					} else {
						console.log('⚠️ Dev syftbox server not reachable - falling back to normal flow')
					}
				}
			} catch (error) {
				console.error('Failed to check dev mode:', error)
				// Continue with normal flow on error
			}

			// Normal flow: Move to step 4 (SyftBox OTP)
			document.getElementById('onboarding-step-3').style.display = 'none'
			document.getElementById('onboarding-step-4').style.display = 'block'
			document.getElementById('syftbox-send-state').style.display = 'block'
			document.getElementById('syftbox-email-info').style.display = 'none'
			document.getElementById('syftbox-otp-state').style.display = 'none'
			document.getElementById('syftbox-error-message').style.display = 'none'
			const sendBtn = document.getElementById('send-login-code-btn')
			if (sendBtn) {
				sendBtn.disabled = false
				sendBtn.textContent = 'Send Code'
			}
			document.querySelectorAll('.syftbox-code-input').forEach((input) => {
				input.value = ''
				input.classList.remove('error', 'success')
			})
			const verifyBtn = document.getElementById('verify-code-btn')
			if (verifyBtn) {
				verifyBtn.disabled = true
				verifyBtn.textContent = 'Verify Code'
			}
		})
	}

	// Step 4: SyftBox helpers
	document.querySelectorAll('.syftbox-link').forEach((link) => {
		link.addEventListener('click', async (event) => {
			event.preventDefault()
			const url = link.dataset.url
			if (!url) return
			try {
				await invoke('open_url', { url })
			} catch (error) {
				console.error('Failed to open SyftBox link:', error)
			}
		})
	})

	const syftboxInfoContinueBtn = document.getElementById('syftbox-info-continue-btn')
	if (syftboxInfoContinueBtn) {
		syftboxInfoContinueBtn.addEventListener('click', () => {
			document.getElementById('syftbox-send-state').style.display = 'none'
			const emailInfo = document.getElementById('syftbox-email-info')
			emailInfo.style.display = 'block'
			emailInfo.scrollTop = 0
			const emailScroll = document.getElementById('syftbox-email-scroll')
			if (emailScroll) {
				emailScroll.scrollTop = 0
			}
			const email = document.getElementById('onboarding-email').value.trim()
			const previewLabel = document.getElementById('syftbox-email-preview-address')
			if (previewLabel) {
				previewLabel.textContent = email || 'your email'
			}
		})
	}

	const syftboxEmailBackBtn = document.getElementById('syftbox-email-back-btn')
	if (syftboxEmailBackBtn) {
		syftboxEmailBackBtn.addEventListener('click', () => {
			const emailInfo = document.getElementById('syftbox-email-info')
			emailInfo.style.display = 'none'
			emailInfo.scrollTop = 0
			const emailScroll = document.getElementById('syftbox-email-scroll')
			if (emailScroll) {
				emailScroll.scrollTop = 0
			}
			document.getElementById('syftbox-send-state').style.display = 'block'
			const sendBtn = document.getElementById('send-login-code-btn')
			if (sendBtn) {
				sendBtn.disabled = false
				sendBtn.textContent = 'Send Code'
			}
		})
	}

	// Step 4: SyftBox OTP - Send Code button
	const sendLoginCodeBtn = document.getElementById('send-login-code-btn')
	if (sendLoginCodeBtn) {
		sendLoginCodeBtn.addEventListener('click', async () => {
			const email = document.getElementById('onboarding-email').value.trim()

			sendLoginCodeBtn.disabled = true
			sendLoginCodeBtn.innerHTML = '<span class="spinner"></span> Sending...'

			try {
				await invoke('syftbox_request_otp', { email })

				// Switch to OTP input state
				document.getElementById('syftbox-email-info').style.display = 'none'
				document.getElementById('syftbox-send-state').style.display = 'none'
				document.getElementById('syftbox-otp-state').style.display = 'block'
				document.getElementById('syftbox-user-email').textContent = email

				// Focus first input
				const firstInput = document.querySelector('.syftbox-code-input[data-index="0"]')
				if (firstInput) firstInput.focus()
			} catch (error) {
				await dialog.message(`Failed to send OTP: ${error}`, {
					title: 'Error',
					type: 'error',
				})
				sendLoginCodeBtn.disabled = false
				sendLoginCodeBtn.textContent = 'Send Code'
			}
		})
	}

	// Step 4: SyftBox OTP - Digit input handling
	const codeInputs = document.querySelectorAll('.syftbox-code-input')
	codeInputs.forEach((input, index) => {
		input.addEventListener('input', (e) => {
			const value = e.target.value

			// Only allow numbers
			if (value && !/^\d$/.test(value)) {
				e.target.value = ''
				return
			}

			// Clear error state
			codeInputs.forEach((inp) => {
				inp.classList.remove('error')
			})
			document.getElementById('syftbox-error-message').style.display = 'none'

			// Move to next input if value entered
			if (value && index < codeInputs.length - 1) {
				codeInputs[index + 1].focus()
			}

			// Check if all inputs filled
			const allFilled = Array.from(codeInputs).every((inp) => inp.value)
			document.getElementById('verify-code-btn').disabled = !allFilled
		})

		// Handle backspace and Enter
		input.addEventListener('keydown', (e) => {
			if (e.key === 'Backspace' && !e.target.value && index > 0) {
				codeInputs[index - 1].focus()
			} else if (e.key === 'Enter') {
				// Trigger verify button if all fields are filled
				const allFilled = Array.from(codeInputs).every((inp) => inp.value)
				if (allFilled) {
					document.getElementById('verify-code-btn').click()
				}
			}
		})

		// Handle paste
		input.addEventListener('paste', (e) => {
			e.preventDefault()
			const pastedData = e.clipboardData.getData('text').replace(/\D/g, '')

			for (let i = 0; i < Math.min(pastedData.length, codeInputs.length); i++) {
				codeInputs[i].value = pastedData[i]
			}

			// Focus last filled or first empty
			const lastIndex = Math.min(pastedData.length, codeInputs.length - 1)
			codeInputs[lastIndex].focus()

			// Enable verify button if all filled
			const allFilled = Array.from(codeInputs).every((inp) => inp.value)
			document.getElementById('verify-code-btn').disabled = !allFilled
		})
	})

	// Step 4: SyftBox OTP - Verify Code button
	const verifyCodeBtn = document.getElementById('verify-code-btn')
	if (verifyCodeBtn) {
		verifyCodeBtn.addEventListener('click', async () => {
			const code = Array.from(codeInputs)
				.map((inp) => inp.value)
				.join('')
			const email = document.getElementById('onboarding-email').value.trim()
			const step4 = document.getElementById('onboarding-step-4')
			const fromSettings = step4.dataset.fromSettings === 'true'

			verifyCodeBtn.disabled = true
			verifyCodeBtn.innerHTML = '<span class="spinner"></span> Verifying...'

			try {
				await invoke('syftbox_submit_otp', { code, email })

				// Success - mark inputs as success
				codeInputs.forEach((inp) => inp.classList.add('success'))

				// Wait a moment then proceed
				setTimeout(async () => {
					if (fromSettings) {
						// Coming from settings - reset state, show success, and return to settings
						step4.dataset.fromSettings = 'false'
						document.getElementById('skip-syftbox-btn').textContent = 'Skip' // Reset button text

						// Reset the OTP state to initial state
						document.getElementById('syftbox-send-state').style.display = 'block'
						document.getElementById('syftbox-email-info').style.display = 'none'
						document.getElementById('syftbox-otp-state').style.display = 'none'
						document.getElementById('syftbox-error-message').style.display = 'none'

						// Clear OTP inputs
						document.querySelectorAll('.syftbox-code-input').forEach((input) => {
							input.value = ''
							input.classList.remove('error', 'success')
						})

						// Reset verify button
						const verifyBtn = document.getElementById('verify-code-btn')
						verifyBtn.disabled = true
						verifyBtn.textContent = 'Verify Code'

						// Reset send login code button
						const sendLoginCodeBtn = document.getElementById('send-login-code-btn')
						if (sendLoginCodeBtn) {
							sendLoginCodeBtn.disabled = false
							sendLoginCodeBtn.textContent = 'Send Code'
						}

						await dialog.message('Successfully authenticated with SyftBox!', {
							title: 'Success',
							type: 'info',
						})

						// Show app layout (sidebar and main content)
						const appLayout = document.querySelector('.app-layout')
						if (appLayout) {
							appLayout.style.display = 'flex'
						}

						// Hide onboarding and show settings
						document.getElementById('onboarding-view').classList.remove('active')
						document.getElementById('onboarding-view').style.display = 'none'

						const settingsView = document.getElementById('settings-view')
						settingsView.classList.add('active')
						settingsView.style.display = 'flex'

						// Activate settings nav item (new layout uses .nav-item instead of .tab)
						document.querySelectorAll('.nav-item').forEach((tab) => tab.classList.remove('active'))
						const settingsNavItem = document.querySelector('.nav-item[data-tab="settings"]')
						if (settingsNavItem) {
							settingsNavItem.classList.add('active')
						}

						// Refresh status
						checkSyftBoxStatus()
					} else {
						// Normal onboarding flow - proceed to step 5 (initializing)
						document.getElementById('syftbox-email-info').style.display = 'none'
						document.getElementById('onboarding-step-4').style.display = 'none'
						document.getElementById('onboarding-step-5').style.display = 'block'
						// Initialize BioVault
						initializeBioVault(email)
					}
				}, 500)
			} catch (error) {
				// Error - show error state
				codeInputs.forEach((inp) => inp.classList.add('error'))
				document.getElementById('syftbox-error-message').style.display = 'block'
				document.getElementById('syftbox-error-message').textContent = error
					.toString()
					.includes('Invalid')
					? 'Invalid verification code. Please try again.'
					: `Error: ${error}`

				verifyCodeBtn.disabled = false
				verifyCodeBtn.textContent = 'Verify Code'
			}
		})
	}

	// Step 4: SyftBox OTP - Resend Code button
	const resendCodeBtn = document.getElementById('resend-code-btn')
	if (resendCodeBtn) {
		resendCodeBtn.addEventListener('click', async () => {
			const email = document.getElementById('onboarding-email').value.trim()

			resendCodeBtn.disabled = true
			resendCodeBtn.textContent = 'Sending...'

			try {
				await invoke('syftbox_request_otp', { email })

				// Clear inputs
				codeInputs.forEach((inp) => {
					inp.value = ''
					inp.classList.remove('error', 'success')
				})
				document.getElementById('syftbox-error-message').style.display = 'none'
				document.getElementById('verify-code-btn').disabled = true

				// Focus first input
				codeInputs[0].focus()

				await dialog.message('A new code has been sent to your email.', {
					title: 'Code Sent',
				})
			} catch (error) {
				await dialog.message(`Failed to send OTP: ${error}`, {
					title: 'Error',
					type: 'error',
				})
			} finally {
				resendCodeBtn.disabled = false
				resendCodeBtn.textContent = 'Send Again'
			}
		})
	}

	// Step 4: SyftBox OTP - Skip/Cancel button
	const skipSyftboxBtn = document.getElementById('skip-syftbox-btn')
	if (skipSyftboxBtn) {
		skipSyftboxBtn.addEventListener('click', () => {
			const step4 = document.getElementById('onboarding-step-4')
			const fromSettings = step4.dataset.fromSettings === 'true'

			if (fromSettings) {
				// Coming from settings - reset state and return to settings page
				step4.dataset.fromSettings = 'false'
				skipSyftboxBtn.textContent = 'Skip' // Reset button text

				// Reset the OTP state to initial state
				document.getElementById('syftbox-send-state').style.display = 'block'
				document.getElementById('syftbox-email-info').style.display = 'none'
				document.getElementById('syftbox-otp-state').style.display = 'none'
				document.getElementById('syftbox-error-message').style.display = 'none'

				// Clear OTP inputs
				document.querySelectorAll('.syftbox-code-input').forEach((input) => {
					input.value = ''
					input.classList.remove('error', 'success')
				})

				// Reset verify button
				const verifyBtn = document.getElementById('verify-code-btn')
				if (verifyBtn) {
					verifyBtn.disabled = true
					verifyBtn.textContent = 'Verify Code'
				}

				// Reset send login code button
				const sendLoginCodeBtn = document.getElementById('send-login-code-btn')
				if (sendLoginCodeBtn) {
					sendLoginCodeBtn.disabled = false
					sendLoginCodeBtn.textContent = 'Send Code'
				}

				// Show app layout (sidebar and main content)
				const appLayout = document.querySelector('.app-layout')
				if (appLayout) {
					appLayout.style.display = 'flex'
				}

				// Hide onboarding and show settings
				document.getElementById('onboarding-view').classList.remove('active')
				document.getElementById('onboarding-view').style.display = 'none'

				const settingsView = document.getElementById('settings-view')
				settingsView.classList.add('active')
				settingsView.style.display = 'flex'

				// Activate settings nav item (new layout uses .nav-item instead of .tab)
				document.querySelectorAll('.nav-item').forEach((tab) => tab.classList.remove('active'))
				const settingsNavItem = document.querySelector('.nav-item[data-tab="settings"]')
				if (settingsNavItem) {
					settingsNavItem.classList.add('active')
				}

				// Refresh status
				checkSyftBoxStatus()
			} else {
				// Normal onboarding flow - skip to step 5
				const email = document.getElementById('onboarding-email').value.trim()

				document.getElementById('onboarding-step-4').style.display = 'none'
				document.getElementById('onboarding-step-5').style.display = 'block'
				// Initialize BioVault
				initializeBioVault(email)
			}
		})
	}

	// Helper function to initialize BioVault
	async function initializeBioVault(email) {
		try {
			await invoke('complete_onboarding', { email })
			// Reload to show main app with updated config
			location.reload()
		} catch (error) {
			await dialog.message(`Error initializing BioVault: ${error}`, {
				title: 'Error',
				type: 'error',
			})
		}
	}

	// Check if onboarded on app start
	async function checkOnboarding() {
		try {
			const isOnboarded = await invoke('check_is_onboarded')
			console.log('🔍 Onboarding check - isOnboarded:', isOnboarded, 'type:', typeof isOnboarded)

			// Check dev mode and log info
			try {
				const devModeInfo = await invoke('get_dev_mode_info')
				if (devModeInfo.dev_mode) {
					console.log('🧪 DEV MODE ACTIVE:', devModeInfo)

					// Add a dev mode banner to the document body
					let devBanner = document.getElementById('dev-mode-banner')
					if (!devBanner) {
						devBanner = document.createElement('div')
						devBanner.id = 'dev-mode-banner'
						devBanner.style.cssText = `
							position: fixed;
							top: 0;
							left: 0;
							right: 0;
							background: linear-gradient(90deg, #ff6b6b, #feca57);
							color: #333;
							padding: 4px 10px;
							font-size: 11px;
							font-weight: bold;
							text-align: center;
							z-index: 99999;
							font-family: monospace;
						`
						devBanner.innerHTML = `🧪 DEV MODE | BIOVAULT_HOME: ${devModeInfo.biovault_home || 'default'} | Server: ${devModeInfo.server_url || 'none'}`
						document.body.insertBefore(devBanner, document.body.firstChild)

						// Adjust body padding to account for banner
						document.body.style.paddingTop = '24px'
					}

					// Auto-populate email from BIOVAULT_HOME path if it contains an email
					if (devModeInfo.biovault_home) {
						const emailMatch = devModeInfo.biovault_home.match(/([^/\\]+@[^/\\]+)/)
						if (emailMatch) {
							const emailInput = document.getElementById('onboarding-email')
							if (emailInput && !emailInput.value) {
								emailInput.value = emailMatch[1]
								// Trigger input event to enable next button
								emailInput.dispatchEvent(new Event('input', { bubbles: true }))
								console.log('📧 Auto-populated email from path:', emailMatch[1])
							}
						}
					}
				}
			} catch (devError) {
				console.log('Dev mode check failed (normal in production):', devError)
			}

			// Show onboarding if user is NOT onboarded (isOnboarded === false)
			if (isOnboarded === false || isOnboarded === 'false' || !isOnboarded) {
				console.log('📋 User not onboarded (value:', isOnboarded, '), showing onboarding view')

				// Show onboarding view
				const onboardingView = document.getElementById('onboarding-view')
				if (!onboardingView) {
					console.error('❌ Onboarding view element not found!')
					return
				}
				onboardingView.classList.add('active')
				onboardingView.style.display = 'flex'

				// Hide sidebar (new layout uses .app-layout instead of .tabs)
				const appLayout = document.querySelector('.app-layout')
				if (appLayout) {
					appLayout.style.display = 'none'
					console.log('✅ App layout hidden')
				} else {
					console.warn('⚠️ App layout not found')
				}

				// Hide all other tab-content views
				document.querySelectorAll('.tab-content:not(#onboarding-view)').forEach((view) => {
					view.classList.remove('active')
					view.style.display = 'none'
				})

				// Make sure first onboarding step is visible
				const firstStep = document.getElementById('onboarding-step-1')
				if (firstStep) {
					firstStep.style.display = 'block'
					console.log('✅ First onboarding step shown')
				} else {
					console.error('❌ First onboarding step not found!')
				}

				// Update title
				document.title = 'BioVault - Setup'
				console.log('✅ Onboarding setup complete')
			} else {
				console.log('✅ User is already onboarded')
			}
		} catch (error) {
			console.error('❌ Error checking onboarding status:', error)
		}
	}

	// Caller triggers initial onboarding check as needed
	return { checkOnboarding }
}
