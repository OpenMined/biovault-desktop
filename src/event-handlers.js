export function setupEventHandlers({
	// Navigation
	navigateTo,
	setLastImportView,
	// Import Modal
	openImportModal,
	closeImportModal,
	backToSelection,
	// Files & Import
	pickFolder,
	searchFiles,
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
	// Messages
	loadMessageThreads,
	sendCurrentMessage,
	setActiveMessageFilterButton,
	resetActiveThread,
	ensureMessagesAuthorizationAndStartNew,
	handleDeleteThread,
	setSyftboxTarget,
	getMessageFilter,
	getSyftboxStatus,
	// Projects
	showCreateProjectModal,
	hideCreateProjectModal,
	createProjectFromModal,
	handleProjectNameInputChange,
	chooseProjectDirectory,
	resetProjectDirectory,
	importProject,
	handleSaveProjectEditor,
	handleLaunchJupyter,
	handleResetJupyter,
	// Runs
	runAnalysis,
	shareCurrentRunLogs,
	toggleSelectAllParticipants,
	// Logs
	copyLogs,
	clearLogs,
	// Settings
	handleSyftBoxAuthentication,
	checkDependenciesForPanel,
	getDependencyResults,
	invoke,
	dialog,
	// Participants
	getSelectedParticipants,
	handleParticipantsSelectAll,
	loadParticipantsView,
	setParticipantsSearchTerm,
	loadFiles,
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
			setActiveMessageFilterButton(btn.dataset.filter)
			resetActiveThread()
			loadMessageThreads(false)
		})
	})

	// Messages - Refresh
	const refreshMessagesBtn = document.getElementById('refresh-messages-btn')
	if (refreshMessagesBtn) {
		refreshMessagesBtn.addEventListener('click', () => loadMessageThreads(true))
	}

	// Messages - New message
	const newMessageBtn = document.getElementById('new-message-btn')
	if (newMessageBtn) {
		newMessageBtn.addEventListener('click', () => {
			ensureMessagesAuthorizationAndStartNew()
		})
	}

	// Messages - Send
	const sendMessageBtn = document.getElementById('message-send-btn')
	if (sendMessageBtn) {
		sendMessageBtn.addEventListener('click', sendCurrentMessage)
	}

	// Messages - SyftBox dropdown
	const syftboxDropdown = document.getElementById('message-syftbox-dropdown')
	if (syftboxDropdown) {
		syftboxDropdown.addEventListener('change', (event) => {
			const target = event.target.value
			const status = getSyftboxStatus()
			if ((target === 'online' && status.running) || (target === 'offline' && !status.running)) {
				return
			}
			setSyftboxTarget(target)
		})
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
		projectBtn.addEventListener('click', () => navigateTo('projects'))
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

	setActiveMessageFilterButton(getMessageFilter())

	// Done button
	document.getElementById('done-btn').addEventListener('click', () => {
		navigateTo('home')
	})

	updateComposeVisibilityPublic(false)

	// Logs - Close
	document.getElementById('close-logs-btn').addEventListener('click', () => {
		document.getElementById('log-viewer').style.display = 'none'
	})

	// Logs - Share
	document.getElementById('share-logs-btn').addEventListener('click', shareCurrentRunLogs)

	// Settings - SyftBox auth
	const syftboxAuthBtn = document.getElementById('syftbox-auth-btn')
	if (syftboxAuthBtn) {
		syftboxAuthBtn.addEventListener('click', async () => {
			await handleSyftBoxAuthentication()
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

	// Settings - Reset all data
	const resetAllBtn = document.getElementById('reset-all-btn')
	if (resetAllBtn) {
		resetAllBtn.addEventListener('click', async () => {
			const confirmed = await dialog.confirm(
				'This will DELETE ALL DATA including participants, files, projects, and runs. This cannot be undone!\n\nAre you sure?',
				{ title: 'Reset All Data', type: 'warning' },
			)

			if (!confirmed) {
				return
			}

			try {
				await invoke('reset_all_data')
				await dialog.message('All data has been reset. The app will now reload.', {
					title: 'Reset Complete',
				})

				// Reload the window to restart fresh
				window.location.reload()
			} catch (error) {
				await dialog.message(`Error resetting data: ${error}`, {
					title: 'Error',
					type: 'error',
				})
			}
		})
	}

	// Logs - Copy & Clear
	document.getElementById('copy-logs-btn').addEventListener('click', copyLogs)
	document.getElementById('clear-logs-btn').addEventListener('click', clearLogs)

	// Participants - Select all
	const selectAllParticipantsTable = document.getElementById('select-all-participants-table')
	if (selectAllParticipantsTable) {
		selectAllParticipantsTable.addEventListener('change', (e) => {
			handleParticipantsSelectAll(e.target.checked)
		})
	}

	// Participants - Delete
	const deleteParticipantsBtn = document.getElementById('delete-selected-participants-btn')
	if (deleteParticipantsBtn) {
		deleteParticipantsBtn.addEventListener('click', async () => {
			const selected = getSelectedParticipants()
			if (selected.length === 0) return

			const confirmed = await dialog.confirm(
				`Are you sure you want to delete ${selected.length} participant(s)? This will also delete all associated files.`,
				{ title: 'Delete Participants', type: 'warning' },
			)

			if (confirmed) {
				try {
					const deleted = await invoke('delete_participants_bulk', {
						participantIds: selected,
					})
					console.log(`Deleted ${deleted} participant(s)`)
					await loadParticipantsView()
					await loadFiles()
				} catch (error) {
					await dialog.message(`Error deleting participants: ${error}`, {
						title: 'Error',
						type: 'error',
					})
				}
			}
		})
	}

	// Participants - Search
	const participantsSearchInput = document.getElementById('participants-search')
	if (participantsSearchInput) {
		participantsSearchInput.addEventListener('input', (e) => {
			setParticipantsSearchTerm(e.target.value)
		})
	}

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

		// Toggle pattern section
		if (e.target.closest('#autofill-ids-btn')) {
			const patternSection = document.getElementById('pattern-section')
			if (patternSection) {
				if (patternSection.style.display === 'none') {
					patternSection.style.display = 'block'
					// Auto-detect patterns when opening
					updatePatternSuggestions()
				} else {
					patternSection.style.display = 'none'
				}
			}
		}

		// Close pattern section
		if (e.target.closest('#pattern-close-btn')) {
			const patternSection = document.getElementById('pattern-section')
			if (patternSection) {
				patternSection.style.display = 'none'
			}
		}

		// Detect file types
		if (e.target.closest('#detect-types-btn')) {
			detectFileTypes()
		}

		// Back to selection
		if (e.target.closest('#review-back-btn')) {
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
			e.target.value = '' // Reset to placeholder
		}
		if (e.target.id === 'set-all-source') {
			handleBulkSourceChange(e.target.value)
			e.target.value = '' // Reset to placeholder
		}
		if (e.target.id === 'set-all-grch-version') {
			handleBulkGrchVersionChange(e.target.value)
			e.target.value = '' // Reset to placeholder
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

	document.getElementById('select-all-files').addEventListener('change', (e) => {
		handleSelectAllFiles(e.target.checked)
	})

	// Projects - Create project modal
	document.getElementById('create-project-btn').addEventListener('click', () => {
		showCreateProjectModal()
	})
	document.getElementById('create-project-cancel').addEventListener('click', () => {
		hideCreateProjectModal()
	})
	document.getElementById('create-project-confirm').addEventListener('click', () => {
		createProjectFromModal()
	})
	document.getElementById('new-project-name').addEventListener('input', () => {
		handleProjectNameInputChange()
	})
	document.getElementById('new-project-name').addEventListener('keypress', (e) => {
		if (e.key === 'Enter') {
			createProjectFromModal()
		}
	})
	document.getElementById('project-path-browse-btn').addEventListener('click', async () => {
		await chooseProjectDirectory()
	})
	document.getElementById('project-path-reset-btn').addEventListener('click', async () => {
		await resetProjectDirectory()
	})
	document.getElementById('import-project-btn').addEventListener('click', () => {
		console.log('Import project button clicked')
		importProject()
	})

	// Runs - Run analysis button
	document.getElementById('run-btn').addEventListener('click', runAnalysis)

	// Projects - Edit buttons
	const projectEditSaveBtn = document.getElementById('project-edit-save-btn')
	if (projectEditSaveBtn) {
		projectEditSaveBtn.addEventListener('click', handleSaveProjectEditor)
	}

	const projectEditCancelBtn = document.getElementById('project-edit-cancel-btn')
	if (projectEditCancelBtn) {
		projectEditCancelBtn.addEventListener('click', () => {
			navigateTo('projects')
		})
	}

	const projectEditBackBtn = document.getElementById('project-edit-back-btn')
	if (projectEditBackBtn) {
		projectEditBackBtn.addEventListener('click', () => {
			navigateTo('projects')
		})
	}
	document
		.getElementById('project-edit-launch-jupyter-btn')
		.addEventListener('click', handleLaunchJupyter)
	document
		.getElementById('project-edit-reset-jupyter-btn')
		.addEventListener('click', handleResetJupyter)

	// Runs - Select all participants
	document.getElementById('select-all-participants').addEventListener('change', (e) => {
		toggleSelectAllParticipants(e.target.checked)
	})

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

	customPattern.addEventListener('input', (e) => {
		handleCustomPatternInput(e.target.value)
	})

	customPattern.addEventListener('blur', (e) => {
		handleCustomPatternBlur(e.target.value)
	})

	customPattern.addEventListener('keydown', (e) => {
		if (e.key === 'Enter') {
			handleCustomPatternKeydown(e.key, e.target.value)
		}
	})
}
