export function setupEventHandlers({
	// Navigation
	navigateTo,
	setLastImportView,
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
	document.querySelectorAll('.file-list-header div[data-sort]').forEach((header) => {
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
		settingsCheckBtn.addEventListener('click', () => {
			checkDependenciesForPanel('settings-deps-list', 'settings-dep-details-panel', true)
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
					installLog.innerHTML += `\n[${new Date().toLocaleTimeString()}] Installing ${dep.name}...\n`

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

	// Import - Pick folder & Import button
	document.getElementById('pick-folder').addEventListener('click', pickFolder)
	document.getElementById('import-btn').addEventListener('click', goToReviewStep)

	// Import - Reset button
	const resetBtn = document.getElementById('reset-import-btn')
	if (resetBtn) {
		resetBtn.addEventListener('click', () => {
			console.log('Reset button clicked')
			resetImportState()
		})
	} else {
		console.error('reset-import-btn not found')
	}

	// Import - Review view buttons
	const detectBtn = document.getElementById('detect-types-btn')
	const backBtn = document.getElementById('review-back-btn')
	const reviewImportBtn = document.getElementById('review-import-btn')

	if (detectBtn) {
		detectBtn.addEventListener('click', detectFileTypes)
	} else {
		console.error('detect-types-btn not found')
	}

	if (backBtn) {
		backBtn.addEventListener('click', () => {
			console.log('Back button clicked')
			setLastImportView('import')
			navigateTo('import')
		})
	} else {
		console.error('review-back-btn not found')
	}

	if (reviewImportBtn) {
		reviewImportBtn.addEventListener('click', finalizeImport)
	} else {
		console.error('review-import-btn not found')
	}

	// Import - Bulk actions
	document.getElementById('set-all-datatype').addEventListener('change', (e) => {
		handleBulkDataTypeChange(e.target.value)
		e.target.value = ''
	})

	document.getElementById('set-all-source').addEventListener('change', (e) => {
		handleBulkSourceChange(e.target.value)
		e.target.value = ''
	})

	document.getElementById('set-all-grch').addEventListener('change', (e) => {
		handleBulkGrchVersionChange(e.target.value)
		e.target.value = ''
	})

	document.getElementById('select-all-review').addEventListener('change', (e) => {
		handleSelectAllReview(e.target.checked)
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
	const fileTypeSelect = document.getElementById('file-type-select')
	const customExtension = document.getElementById('custom-extension')
	const customExtInput = document.getElementById('custom-ext-input')
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

	fileTypeSelect.addEventListener('change', (e) => {
		if (e.target.value === 'custom') {
			customExtension.style.display = 'block'
		} else {
			customExtension.style.display = 'none'
			searchFiles()
		}
	})

	customExtInput.addEventListener('input', () => {
		searchFiles()
	})

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
