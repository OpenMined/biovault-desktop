export function setupEventHandlers({
	// Navigation
	navigateTo,
	_setLastImportView,
	// Import Modal
	openImportModal,
	closeImportModal,
	backToSelection,
	// Files & Import
	pickFolder,
	_searchFiles,
	resetImportState,
	goToReviewStep,
	detectFileTypes,
	finalizeImport,
	setSortField,
	setReviewSortField,
	handleSelectAllFiles,
	handleSelectAllReview,
	handleBulkDataTypeChange,
	handleBulkSourceChange,
	handleBulkGrchVersionChange,
	handleCustomPatternInput,
	handleCustomPatternBlur,
	handleCustomPatternKeydown,
	handleCustomPatternFocus,
	updatePatternSuggestions: _updatePatternSuggestions, // eslint-disable-line no-unused-vars
	assignRandomIds,
	toggleMissingIdsFilter,
	jumpToNextMissingId,
	toggleIncompleteReviewFilter,
	jumpToNextIncompleteReview,
	// Messages
	loadMessageThreads,
	sendCurrentMessage,
	resetActiveThread,
	setActiveMessageFilterButton,
	ensureMessagesAuthorizationAndStartNew,
	handleDeleteThread,
	setSyftboxTarget,
	getSyftboxStatus,
	showMessagesInviteOptions,
	// Projects
	showCreateProjectModal,
	hideCreateProjectModal,
	handleProjectNameInputChange,
	chooseProjectDirectory,
	resetProjectDirectory,
	importProject,
	importProjectFromFolder,
	handleSaveProjectEditor,
	handleLaunchJupyter,
	handleResetJupyter,
	handleOpenProjectFolder,
	handleLeaveProjectEditor,
	handleReloadProjectSpec,
	// Runs
	runAnalysis,
	shareCurrentRunLogs,
	toggleSelectAllParticipants,
	// Logs
	copyLogs,
	clearLogs,
	openLogsFolder,
	// Settings
	handleSyftBoxAuthentication,
	saveSettings,
	checkDependenciesForPanel,
	getDependencyResults,
	checkUpdates,
	invoke,
	dialog,
	checkSyftBoxStatus,
	// Data (unified participants + files)
	_getSelectedParticipants,
	_loadData,
	// Messages module state
	initializeMessagesTab,
	updateComposeVisibilityPublic,
}) {
	// Sort headers for import
	document.querySelectorAll('.file-table th[data-sort]').forEach((header) => {
		header.addEventListener('click', () => {
			setSortField(header.dataset.sort)
		})
	})

	// Messages filter buttons
	const messageFilterButtons = document.querySelectorAll('.message-filter')
	messageFilterButtons.forEach((btn) => {
		btn.addEventListener('click', () => {
			if (btn.classList.contains('active')) return
			const filter = btn.dataset.filter
			setActiveMessageFilterButton(filter)
			resetActiveThread()
			// setActiveMessageFilterButton handles loading for 'failed' filter
			// Only call loadMessageThreads for normal filters
			if (filter !== 'failed') {
				loadMessageThreads(false, { emitToasts: false })
			}
		})
	})

	// Messages - Empty state compose button
	const msgEmptyCompose = document.getElementById('msg-empty-compose')
	if (msgEmptyCompose) {
		msgEmptyCompose.addEventListener('click', () => {
			ensureMessagesAuthorizationAndStartNew()
		})
	}

	// Messages - Refresh (header button)
	const refreshMessagesBtn = document.getElementById('refresh-messages-btn')
	if (refreshMessagesBtn) {
		refreshMessagesBtn.addEventListener('click', () => loadMessageThreads(true))
	}

	// Messages - Refresh (sidebar icon button)
	const sidebarRefreshBtn = document.getElementById('sidebar-refresh-btn')
	if (sidebarRefreshBtn) {
		sidebarRefreshBtn.addEventListener('click', () => loadMessageThreads(true))
	}

	// Messages - New message
	const newMessageBtn = document.getElementById('new-message-btn')
	if (newMessageBtn) {
		newMessageBtn.addEventListener('click', () => {
			ensureMessagesAuthorizationAndStartNew()
		})
	}

	// Messages - Invite via email (header button)
	const inviteViaMsgBtn = document.getElementById('invite-via-email-msg-btn')
	if (inviteViaMsgBtn) {
		inviteViaMsgBtn.addEventListener('click', () => {
			showMessagesInviteOptions()
		})
	}

	// Messages - Invite (empty state button)
	const msgEmptyInvite = document.getElementById('msg-empty-invite')
	if (msgEmptyInvite) {
		msgEmptyInvite.addEventListener('click', () => {
			showMessagesInviteOptions()
		})
	}

	const testNotificationBtn = document.getElementById('message-test-notification-btn')
	if (testNotificationBtn) {
		testNotificationBtn.addEventListener('click', () => {
			// triggerTestNotification is exported from messages.js and attached to module scope
			if (typeof window.__messagesTriggerTest__ === 'function') {
				window.__messagesTriggerTest__()
			} else {
				console.warn('Test notification handler not available')
			}
		})
	}

	const nativeTestBtn = document.getElementById('message-native-test-btn')
	if (nativeTestBtn) {
		nativeTestBtn.addEventListener('click', async () => {
			console.log('[Messages] Native notification test clicked')
			try {
				// Check if Tauri is available
				if (typeof window !== 'undefined' && window.__TAURI__?.notification) {
					const { isPermissionGranted, requestPermission, sendNotification } =
						window.__TAURI__.notification

					// Request permission if not granted
					let permissionGranted = await isPermissionGranted()
					console.log('[Messages] Notification permission granted:', permissionGranted)

					if (!permissionGranted) {
						console.log('[Messages] Requesting notification permission...')
						const permission = await requestPermission()
						permissionGranted = permission === 'granted'
						console.log('[Messages] Permission result:', permission)
					}

					if (permissionGranted) {
						await sendNotification({
							title: 'BioVault Notification Test',
							body: 'If you see this, native notifications are working! 🎉',
						})
						console.log('[Messages] Native notification sent')
					} else {
						console.warn('[Messages] Notification permission denied')
					}
				} else {
					console.warn('[Messages] Tauri notification API not available')
				}
			} catch (err) {
				console.warn('[Messages] Native notification failed', err)
			}

			// Also trigger the Rust-side test for more logging
			try {
				await invoke('test_notification')
				console.log('[Messages] Invoked Rust test_notification command')
			} catch (err) {
				console.warn('[Messages] Rust notification command failed', err)
			}
		})
	}

	const applescriptTestBtn = document.getElementById('message-applescript-test-btn')
	if (applescriptTestBtn) {
		applescriptTestBtn.addEventListener('click', async () => {
			console.log('[Messages] AppleScript notification test clicked')
			try {
				await invoke('test_notification_applescript')
				console.log('[Messages] AppleScript notification command invoked')
			} catch (err) {
				console.warn('[Messages] AppleScript notification failed', err)
			}
		})
	}

	// Messages - Send
	const sendMessageBtn = document.getElementById('message-send-btn')
	if (sendMessageBtn) {
		sendMessageBtn.addEventListener('click', sendCurrentMessage)
	}

	// Messages - SyftBox toggle
	const syftboxToggle = document.getElementById('message-syftbox-toggle')
	if (syftboxToggle) {
		syftboxToggle.addEventListener('change', (event) => {
			const wantOnline = event.target.checked
			const status = getSyftboxStatus()
			// Skip if already in desired state
			if ((wantOnline && status.running) || (!wantOnline && !status.running)) {
				return
			}
			setSyftboxTarget(wantOnline ? 'online' : 'offline')
		})

		// Allow clicking on the track to toggle
		const toggleTrack = document.querySelector('.msg-toggle-track')
		if (toggleTrack) {
			toggleTrack.addEventListener('click', () => {
				if (syftboxToggle.disabled) return
				syftboxToggle.checked = !syftboxToggle.checked
				syftboxToggle.dispatchEvent(new Event('change'))
			})
		}
	}

	// Messages - Auth button
	const messagesAuthBtn = document.getElementById('messages-auth-btn')
	if (messagesAuthBtn) {
		messagesAuthBtn.addEventListener('click', async () => {
			await handleSyftBoxAuthentication()
			await initializeMessagesTab(true)
		})
	}

	// Messages - View project
	const projectBtn = document.getElementById('message-view-project-btn')
	if (projectBtn) {
		projectBtn.addEventListener('click', () => navigateTo('run'))
	}

	// Messages - Compose keyboard shortcut
	const composeBody = document.getElementById('message-compose-body')
	if (composeBody) {
		composeBody.addEventListener('keydown', (event) => {
			if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
				event.preventDefault()
				sendCurrentMessage()
			}
		})
	}

	// Messages - Empty state start button
	const emptyStartBtn = document.getElementById('empty-start-message-btn')
	if (emptyStartBtn) {
		emptyStartBtn.addEventListener('click', () => {
			ensureMessagesAuthorizationAndStartNew()
		})
	}

	// Messages - Delete thread
	const deleteThreadBtn = document.getElementById('delete-thread-btn')
	if (deleteThreadBtn) {
		deleteThreadBtn.addEventListener('click', handleDeleteThread)
	}

	// Done button (import results view)
	const doneBtn = document.getElementById('done-btn')
	if (doneBtn) {
		doneBtn.addEventListener('click', () => {
			navigateTo('data')
		})
	}

	updateComposeVisibilityPublic(false)

	// Logs - Close (runs view)
	const closeLogsBtn = document.getElementById('close-logs-btn')
	if (closeLogsBtn) {
		closeLogsBtn.addEventListener('click', () => {
			document.getElementById('log-viewer').classList.remove('active')
		})
	}

	// Logs - Share (runs view)
	const shareLogsBtn = document.getElementById('share-logs-btn')
	if (shareLogsBtn) {
		shareLogsBtn.addEventListener('click', shareCurrentRunLogs)
	}

	// Settings - SyftBox auth
	const syftboxAuthBtn = document.getElementById('syftbox-auth-btn')
	if (syftboxAuthBtn) {
		syftboxAuthBtn.addEventListener('click', async () => {
			await handleSyftBoxAuthentication()
		})
	}

	// Settings - Set Dev Server (skip auth)
	const syftboxSetDevBtn = document.getElementById('syftbox-set-dev-btn')
	if (syftboxSetDevBtn) {
		syftboxSetDevBtn.addEventListener('click', async () => {
			const server = document.getElementById('setting-syftbox-server')?.value.trim()
			if (!server) {
				await dialog.message('Please enter a server URL first.', {
					title: 'Server URL required',
					type: 'warning',
				})
				return
			}

			syftboxSetDevBtn.disabled = true
			const originalText = syftboxSetDevBtn.textContent
			syftboxSetDevBtn.textContent = 'Setting...'

			try {
				await invoke('set_syftbox_dev_server', { serverUrl: server })
				await dialog.message(
					'Server updated. Auth will be skipped for this host. SyftBox client restarted with the new URL.',
					{
						title: 'Dev Server Set',
						type: 'info',
					},
				)
				if (typeof checkSyftBoxStatus === 'function') {
					await checkSyftBoxStatus()
				}
			} catch (error) {
				console.error('Error setting dev server:', error)
				await dialog.message(error?.message || 'Failed to set dev server.', {
					title: 'Error',
					type: 'error',
				})
			} finally {
				syftboxSetDevBtn.disabled = false
				syftboxSetDevBtn.textContent = originalText
			}
		})
	}

	// Settings - Save changes
	const settingsSaveBtn = document.getElementById('settings-save-btn')
	if (settingsSaveBtn) {
		settingsSaveBtn.addEventListener('click', async () => {
			const originalText = settingsSaveBtn.textContent
			settingsSaveBtn.disabled = true
			settingsSaveBtn.textContent = 'Saving…'

			try {
				await saveSettings()
			} finally {
				settingsSaveBtn.disabled = false
				settingsSaveBtn.textContent = originalText
			}
		})
	}

	// Settings - Check dependencies
	const settingsCheckBtn = document.getElementById('settings-check-again-btn')
	if (settingsCheckBtn) {
		settingsCheckBtn.addEventListener('click', async () => {
			// Disable button during check to prevent multiple simultaneous checks
			const originalText = settingsCheckBtn.textContent
			settingsCheckBtn.disabled = true
			settingsCheckBtn.innerHTML =
				'<span class="spinner" style="width: 14px; height: 14px;"></span> Checking...'

			try {
				await checkDependenciesForPanel('settings-deps-list', 'settings-dep-details-panel', true)
			} finally {
				// Re-enable button after check completes
				settingsCheckBtn.disabled = false
				settingsCheckBtn.textContent = originalText
			}
		})
	}

	// Settings - Install dependencies (with modal)
	const settingsInstallBtn = document.getElementById('settings-install-missing-deps-btn')
	if (settingsInstallBtn) {
		settingsInstallBtn.addEventListener('click', async () => {
			const depResults = getDependencyResults()
			if (!depResults) return

			const missingDeps = depResults.dependencies.filter(
				(dep) => !dep.found || (dep.running !== null && dep.running === false),
			)

			if (missingDeps.length === 0) {
				alert('All dependencies are already installed!')
				return
			}

			const modal = document.getElementById('install-modal')
			const progressBar = document.getElementById('install-progress-bar')
			const statusText = document.getElementById('install-status-text')
			const installLog = document.getElementById('install-log')
			const closeBtn = document.getElementById('install-close-btn')

			modal.style.display = 'flex'
			closeBtn.disabled = true
			installLog.innerHTML = ''
			progressBar.style.width = '0%'

			try {
				for (let i = 0; i < missingDeps.length; i++) {
					const dep = missingDeps[i]
					const progress = ((i / missingDeps.length) * 100).toFixed(0)
					progressBar.style.width = `${progress}%`
					statusText.textContent = `Installing ${dep.name}...`
					installLog.innerHTML += `\n[${new Date().toLocaleTimeString()}] Installing ${
						dep.name
					}...\n`

					try {
						const result = await invoke('install_dependency', { name: dep.name })
						if (result) {
							installLog.innerHTML += `✓ ${dep.name} installed successfully at: ${result}\n`
						} else {
							installLog.innerHTML += `✓ ${dep.name} installed successfully\n`
						}
					} catch (error) {
						installLog.innerHTML += `✗ Failed to install ${dep.name}: ${error}\n`
					}
				}

				progressBar.style.width = '100%'
				statusText.textContent = 'Installation complete! Checking dependencies...'
				installLog.innerHTML += `\n[${new Date().toLocaleTimeString()}] Installation complete!\n`

				await checkDependenciesForPanel('settings-deps-list', 'settings-dep-details-panel', true)
			} finally {
				closeBtn.disabled = false
			}
		})
	}

	// Settings - Display app version
	const appVersionEl = document.getElementById('app-version')
	if (appVersionEl) {
		invoke('get_app_version')
			.then((version) => {
				appVersionEl.textContent = `v${version}`
			})
			.catch((err) => {
				console.error('Failed to get app version:', err)
				appVersionEl.textContent = 'Unknown'
			})
	}

	// Settings - Check for updates
	const checkUpdatesBtn = document.getElementById('check-updates-btn')
	if (checkUpdatesBtn) {
		checkUpdatesBtn.addEventListener('click', async () => {
			checkUpdatesBtn.disabled = true
			checkUpdatesBtn.textContent = 'Checking...'
			try {
				await checkUpdates(false) // Not silent - show dialog
			} finally {
				checkUpdatesBtn.disabled = false
				checkUpdatesBtn.textContent = 'Check for Updates'
			}
		})
	}

	// Settings - Reset all data
	const resetAllBtn = document.getElementById('reset-all-btn')
	if (resetAllBtn) {
		resetAllBtn.addEventListener('click', async () => {
			const confirmed = await dialog.confirm(
				'This will DELETE ALL DATA including participants, files, projects, and runs. It will also stop any running Jupyter sessions and the SyftBox background process.\n\nThis cannot be undone.\n\nAre you sure?',
				{ title: 'Reset BioVault Data', type: 'warning' },
			)

			if (!confirmed) {
				return
			}

			const wipeKeys = await dialog.confirm(
				'Do you also want to delete your identity keys (.syc)?\n\nIf you delete keys you will need to onboard/sign in again, and any encrypted session registry files may no longer be readable.\n\nChoose YES to fully reset everything.\nChoose NO to reset data but keep your keys.',
				{ title: 'Reset Everything?', type: 'warning' },
			)

			const originalText = resetAllBtn.textContent

			try {
				resetAllBtn.disabled = true
				resetAllBtn.textContent = 'Resetting...'
				console.log('🗑️ Resetting all data...')
				if (wipeKeys) {
					await invoke('reset_everything')
				} else {
					await invoke('reset_all_data')
				}
				console.log('✅ Data reset complete')

				await dialog.message(
					wipeKeys
						? 'All data and keys have been reset. The app will now reload.'
						: 'All data has been reset (keys preserved). The app will now reload.',
					{ title: 'Reset Complete' },
				)

				console.log('🔄 Reloading window...')
				// Reload the window to restart fresh
				window.location.reload()
			} catch (error) {
				await dialog.message(`Error resetting data: ${error}`, {
					title: 'Error',
					type: 'error',
				})
			} finally {
				resetAllBtn.disabled = false
				if (originalText != null) {
					resetAllBtn.textContent = originalText
				}
			}
		})
	}

	// Logs - Copy & Clear (workbench)
	const copyLogsBtn = document.getElementById('copy-logs-btn')
	if (copyLogsBtn) {
		copyLogsBtn.addEventListener('click', copyLogs)
	}
	const clearLogsBtn = document.getElementById('clear-logs-btn')
	if (clearLogsBtn) {
		clearLogsBtn.addEventListener('click', clearLogs)
	}
	const openLogsFolderBtn = document.getElementById('open-logs-folder-btn')
	if (openLogsFolderBtn) {
		openLogsFolderBtn.addEventListener('click', openLogsFolder)
	}

	// Data view event handlers are now initialized in data.js via initializeDataTab()

	// Import Modal - Open/Close
	document.addEventListener('click', (e) => {
		// Open modal from import button (will be on participants page)
		if (e.target.closest('#open-import-modal-btn')) {
			console.log('📥 Import button clicked')
			openImportModal()
		}

		// Close modal
		if (e.target.closest('[data-modal-close="import"]')) {
			console.log('❌ Close import modal clicked')
			closeImportModal()
		}
	})

	// Import Modal - Delegated event handlers for dynamically loaded content
	document.addEventListener('click', (e) => {
		// Clear folder selection (check this FIRST before folder picker)
		if (e.target.closest('#dropzone-clear-btn')) {
			e.preventDefault()
			e.stopPropagation()
			resetImportState()
			return // Stop processing other handlers
		}

		// Pick folder
		if (e.target.closest('#folder-dropzone')) {
			pickFolder()
		}

		// Continue to review
		if (e.target.closest('#import-continue-btn')) {
			goToReviewStep()
		}

		// Assign random IDs
		if (e.target.closest('#random-ids-btn')) {
			assignRandomIds()
		}

		// Filter missing IDs
		if (e.target.closest('#filter-missing-ids-btn')) {
			e.preventDefault()
			e.stopPropagation()
			toggleMissingIdsFilter()
		}

		// Jump to missing ID
		if (e.target.closest('#jump-to-missing-btn')) {
			e.preventDefault()
			e.stopPropagation()
			jumpToNextMissingId()
		}

		// Filter incomplete review
		if (e.target.closest('#filter-incomplete-review-btn')) {
			e.preventDefault()
			e.stopPropagation()
			toggleIncompleteReviewFilter()
		}

		// Jump to incomplete review
		if (e.target.closest('#jump-to-incomplete-review-btn')) {
			e.preventDefault()
			e.stopPropagation()
			jumpToNextIncompleteReview()
		}

		// Detect file types
		if (e.target.closest('#detect-types-btn')) {
			detectFileTypes()
		}

		// Back to selection (supports both old and new button IDs)
		if (e.target.closest('#review-back-btn') || e.target.closest('#import-back-btn')) {
			console.log('Back button clicked - returning to file selection')
			backToSelection()
		}

		// Final import
		if (e.target.closest('#review-import-btn')) {
			finalizeImport()
		}
	})

	// Bulk actions and checkboxes (using 'change' event)
	document.addEventListener('change', (e) => {
		// Bulk actions in review step
		if (e.target.id === 'set-all-datatype') {
			handleBulkDataTypeChange(e.target.value)
			// Keep the selected value visible so user can see what was applied
		}
		if (e.target.id === 'set-all-source') {
			handleBulkSourceChange(e.target.value)
			// Keep the selected value visible so user can see what was applied
		}
		if (e.target.id === 'set-all-grch-version') {
			handleBulkGrchVersionChange(e.target.value)
			// Keep the selected value visible so user can see what was applied
		}

		// Select all checkboxes
		if (e.target.id === 'select-all-review') {
			handleSelectAllReview(e.target.checked)
		}
	})

	// Import - Sort headers in review view
	document.querySelectorAll('#import-review-view .sortable-header').forEach((header) => {
		header.addEventListener('click', () => {
			const field = header.dataset.sortField
			setReviewSortField(field)
		})
	})

	const selectAllFilesCheckbox = document.getElementById('select-all-files')
	if (selectAllFilesCheckbox) {
		selectAllFilesCheckbox.addEventListener('change', (e) => {
			handleSelectAllFiles(e.target.checked)
		})
	}

	// Projects - Create project modal (also used for "Create Step")
	const createProjectBtn = document.getElementById('create-project-btn')
	if (createProjectBtn) {
		createProjectBtn.addEventListener('click', () => {
			showCreateProjectModal()
		})
	}

	// Note: All create project modal buttons (Cancel, Back, Next, Confirm)
	// are set up when modal opens (see setupCreateTabHandlers in projects.js)

	// Preview tab switching
	document.querySelectorAll('.preview-tab').forEach((tab) => {
		tab.addEventListener('click', () => {
			const targetTab = tab.dataset.previewTab

			// Update tab buttons
			document.querySelectorAll('.preview-tab').forEach((t) => t.classList.remove('active'))
			tab.classList.add('active')

			// Update content
			document.querySelectorAll('.preview-tab-content').forEach((c) => c.classList.remove('active'))
			const targetContent = document.querySelector(`[data-preview-content="${targetTab}"]`)
			if (targetContent) targetContent.classList.add('active')
		})
	})

	// Top close button
	const topCloseBtn = document.getElementById('create-project-cancel-top')
	if (topCloseBtn) {
		topCloseBtn.addEventListener('click', hideCreateProjectModal)
	}
	// Preview expand/collapse controls removed - now using split view
	const newProjectNameInput = document.getElementById('new-project-name')
	if (newProjectNameInput) {
		newProjectNameInput.addEventListener('input', () => {
			handleProjectNameInputChange()
		})
	}

	const projectPathBrowseBtn = document.getElementById('project-path-browse-btn')
	if (projectPathBrowseBtn) {
		projectPathBrowseBtn.addEventListener('click', async () => {
			await chooseProjectDirectory()
		})
	}

	const projectPathResetBtn = document.getElementById('project-path-reset-btn')
	if (projectPathResetBtn) {
		projectPathResetBtn.addEventListener('click', async () => {
			await resetProjectDirectory()
		})
	}

	const importProjectBtn = document.getElementById('import-project-btn')
	if (importProjectBtn) {
		importProjectBtn.addEventListener('click', () => {
			console.log('Import project button clicked')
			importProject()
		})
	}

	const importFolderBtn = document.getElementById('import-folder-btn')
	if (importFolderBtn) {
		importFolderBtn.addEventListener('click', () => {
			console.log('Import from folder button clicked')
			importProjectFromFolder()
		})
	}

	// Wire up import step button to import project
	const importStepBtn = document.getElementById('import-step-btn')
	if (importStepBtn) {
		importStepBtn.addEventListener('click', () => {
			// Copy value from step input to project input
			const stepUrlInput = document.getElementById('step-url-input')
			const projectUrlInput = document.getElementById('project-url-input')
			if (stepUrlInput && projectUrlInput) {
				projectUrlInput.value = stepUrlInput.value
				importProject()
			}
		})
	}

	// Runs - Run analysis button (only exists if run analysis view is loaded)
	const runBtn = document.getElementById('run-btn')
	if (runBtn) {
		runBtn.addEventListener('click', runAnalysis)
	}

	// Projects - Edit buttons
	const projectEditSaveBtn = document.getElementById('project-edit-save-btn')
	if (projectEditSaveBtn) {
		projectEditSaveBtn.addEventListener('click', handleSaveProjectEditor)
	}

	const projectEditCancelBtn = document.getElementById('project-edit-cancel-btn')
	if (projectEditCancelBtn) {
		projectEditCancelBtn.addEventListener('click', () => {
			handleLeaveProjectEditor()
			navigateTo('run')
		})
	}

	const projectEditBackBtn = document.getElementById('project-edit-back-btn')
	if (projectEditBackBtn) {
		projectEditBackBtn.addEventListener('click', () => {
			handleLeaveProjectEditor()
			navigateTo('run')
		})
	}
	// Add event listeners only if elements exist (they won't during onboarding)
	const openFolderBtn = document.getElementById('project-edit-open-folder-btn')
	if (openFolderBtn) {
		openFolderBtn.addEventListener('click', handleOpenProjectFolder)
	}

	const launchJupyterBtn = document.getElementById('project-edit-launch-jupyter-btn')
	if (launchJupyterBtn) {
		launchJupyterBtn.addEventListener('click', handleLaunchJupyter)
	}

	const resetJupyterBtn = document.getElementById('project-edit-reset-jupyter-btn')
	if (resetJupyterBtn) {
		resetJupyterBtn.addEventListener('click', handleResetJupyter)
	}

	const projectSpecReloadBtn = document.getElementById('project-spec-reload-btn')
	if (projectSpecReloadBtn) {
		projectSpecReloadBtn.addEventListener('click', handleReloadProjectSpec)
	}

	// Runs - Select all participants (only exists if run analysis view is loaded)
	const selectAllParticipantsCheckbox = document.getElementById('select-all-participants')
	if (selectAllParticipantsCheckbox) {
		selectAllParticipantsCheckbox.addEventListener('change', (e) => {
			toggleSelectAllParticipants(e.target.checked)
		})
	}

	// Import - File type & pattern controls
	const customPattern = document.getElementById('custom-pattern')
	const patternInfoBtn = document.getElementById('pattern-info-btn')
	const patternInfoModal = document.getElementById('pattern-info-modal')

	if (patternInfoBtn && patternInfoModal) {
		const openModal = () => {
			patternInfoModal.removeAttribute('hidden')
			patternInfoModal.classList.remove('hidden')
			patternInfoModal.classList.add('visible')
			document.body.classList.add('modal-open')
			patternInfoBtn.setAttribute('aria-expanded', 'true')
			const focusable = patternInfoModal.querySelector('button:not([disabled])')
			focusable?.focus()
		}

		const closeModal = ({ skipFocus = false } = {}) => {
			patternInfoModal.classList.remove('visible')
			patternInfoModal.classList.add('hidden')
			patternInfoModal.setAttribute('hidden', '')
			document.body.classList.remove('modal-open')
			patternInfoBtn.setAttribute('aria-expanded', 'false')
			if (!skipFocus) {
				patternInfoBtn.focus()
			}
		}

		closeModal({ skipFocus: true })

		patternInfoBtn.addEventListener('click', () => {
			const importView = document.getElementById('import-view')
			if (importView && !importView.classList.contains('active')) {
				return
			}
			openModal()
		})

		patternInfoModal.querySelectorAll('[data-modal-close]').forEach((element) => {
			element.addEventListener('click', () => closeModal())
		})

		patternInfoModal.addEventListener('click', (event) => {
			if (event.target === patternInfoModal) {
				closeModal()
			}
		})

		document.addEventListener('keydown', (event) => {
			if (event.key === 'Escape' && patternInfoModal.classList.contains('visible')) {
				closeModal()
			}
		})
	}

	// File type checkboxes are handled in import.js updateFileTypeDropdown()

	if (customPattern) {
		customPattern.addEventListener('input', (e) => {
			handleCustomPatternInput(e.target.value)
		})

		if (handleCustomPatternFocus) {
			customPattern.addEventListener('focus', (e) => {
				handleCustomPatternFocus(e.target.value)
			})
		}

		customPattern.addEventListener('blur', (e) => {
			handleCustomPatternBlur(e.target.value)
		})

		customPattern.addEventListener('keydown', (e) => {
			if (e.key === 'Enter') {
				handleCustomPatternKeydown(e.key, e.target.value)
			}
		})
	}
}
