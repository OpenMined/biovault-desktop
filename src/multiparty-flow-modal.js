export function createMultipartyFlowModal({ invoke, dialog }) {
	let currentSessionId = null
	let currentFlowState = null
	let pollInterval = null

	function escapeHtml(text) {
		const div = document.createElement('div')
		div.textContent = text
		return div.innerHTML
	}

	function getStatusIcon(status) {
		switch (status) {
			case 'Pending':
				return '⏳'
			case 'WaitingForInputs':
				return '📥'
			case 'Ready':
				return '✅'
			case 'Running':
				return '🔄'
			case 'Completed':
				return '✓'
			case 'Sharing':
				return '📤'
			case 'Shared':
				return '📨'
			case 'Failed':
				return '❌'
			default:
				return '❓'
		}
	}

	function getStatusClass(status) {
		switch (status) {
			case 'Pending':
				return 'status-pending'
			case 'WaitingForInputs':
				return 'status-waiting'
			case 'Ready':
				return 'status-ready'
			case 'Running':
				return 'status-running'
			case 'Completed':
				return 'status-completed'
			case 'Sharing':
				return 'status-sharing'
			case 'Shared':
				return 'status-shared'
			case 'Failed':
				return 'status-failed'
			default:
				return ''
		}
	}

	async function openModal(sessionId, flowName, flowSpec, participants) {
		currentSessionId = sessionId

		const modal = document.getElementById('multiparty-flow-modal')
		if (!modal) {
			console.error('Multiparty flow modal not found')
			return
		}

		const titleEl = modal.querySelector('.multiparty-modal-title')
		if (titleEl) {
			titleEl.textContent = `🔄 Multiparty Flow: "${flowName}"`
		}

		renderParticipants(modal, participants)
		await refreshFlowState()
		modal.style.display = 'flex'
		startPolling()
	}

	function closeModal() {
		const modal = document.getElementById('multiparty-flow-modal')
		if (modal) {
			modal.style.display = 'none'
		}
		stopPolling()
		currentSessionId = null
		currentFlowState = null
	}

	function renderParticipants(modal, participants) {
		const container = modal.querySelector('.multiparty-participants-list')
		if (!container) return

		container.innerHTML = participants
			.map(
				(p) => `
			<div class="multiparty-participant">
				<span class="participant-icon">👤</span>
				<span class="participant-email">${escapeHtml(p.email)}</span>
				<span class="participant-role">(${escapeHtml(p.role)})</span>
			</div>
		`,
			)
			.join('')
	}

	function renderSteps(modal, steps, myRole) {
		const container = modal.querySelector('.multiparty-steps-list')
		if (!container) return

		container.innerHTML = steps
			.map(
				(step) => `
			<div class="multiparty-step ${step.my_action ? 'my-step' : 'other-step'} ${getStatusClass(step.status)}">
				<div class="step-header">
					<label class="step-auto-run">
						<input type="checkbox"
							data-step-id="${step.id}"
							${step.auto_run ? 'checked' : ''}
							${!step.my_action ? 'disabled' : ''}
							onchange="window.multipartyFlowModal.toggleAutoRun('${step.id}', this.checked)"
						/>
						Auto
					</label>
					<div class="step-info">
						<span class="step-name">${escapeHtml(step.name)}</span>
						<span class="step-status ${getStatusClass(step.status)}">
							${getStatusIcon(step.status)} ${step.status}
						</span>
					</div>
				</div>
				<div class="step-description">${escapeHtml(step.description)}</div>
				${renderStepActions(step)}
			</div>
		`,
			)
			.join('')
	}

	function renderStepActions(step) {
		if (!step.my_action) {
			return '<div class="step-actions"><span class="waiting-text">Waiting for other participant</span></div>'
		}

		const actions = []

		if (step.status === 'Ready' || step.status === 'Pending') {
			actions.push(
				`<button class="step-btn run-btn" onclick="window.multipartyFlowModal.runStep('${step.id}')">▶ Run Step</button>`,
			)
		}

		if (step.status === 'Running') {
			actions.push('<span class="running-indicator">Running...</span>')
		}

		if (step.status === 'Completed' && step.shares_output && !step.outputs_shared) {
			actions.push(
				`<button class="step-btn preview-btn" onclick="window.multipartyFlowModal.previewOutputs('${step.id}')">📁 Preview</button>`,
			)
			actions.push(
				`<button class="step-btn share-btn" onclick="window.multipartyFlowModal.shareOutputs('${step.id}')">📤 Share Outputs</button>`,
			)
		}

		if (step.status === 'Completed' && !step.shares_output) {
			actions.push('<span class="completed-text">✓ Complete</span>')
		}

		if (step.status === 'Shared') {
			actions.push('<span class="shared-text">📨 Outputs Shared</span>')
		}

		if (step.status === 'WaitingForInputs') {
			actions.push(
				'<span class="waiting-text">Waiting for inputs from other participants...</span>',
			)
		}

		return `<div class="step-actions">${actions.join('')}</div>`
	}

	async function refreshFlowState() {
		if (!currentSessionId) return

		try {
			const state = await invoke('get_multiparty_flow_state', { sessionId: currentSessionId })
			if (state) {
				currentFlowState = state
				const modal = document.getElementById('multiparty-flow-modal')
				if (modal) {
					renderSteps(modal, state.steps, state.my_role)
				}
			}
		} catch (error) {
			console.error('Failed to refresh flow state:', error)
		}
	}

	async function toggleAutoRun(stepId, autoRun) {
		if (!currentSessionId) return

		try {
			await invoke('set_step_auto_run', {
				sessionId: currentSessionId,
				stepId,
				autoRun,
			})
			await refreshFlowState()
		} catch (error) {
			console.error('Failed to toggle auto-run:', error)
		}
	}

	async function runStep(stepId) {
		if (!currentSessionId) return

		try {
			await invoke('run_flow_step', {
				sessionId: currentSessionId,
				stepId,
			})
			await refreshFlowState()
		} catch (error) {
			console.error('Failed to run step:', error)
			if (dialog?.message) {
				await dialog.message(`Failed to run step: ${error}`, { title: 'Error', kind: 'error' })
			}
		}
	}

	async function previewOutputs(stepId) {
		if (!currentSessionId) return

		try {
			const files = await invoke('get_step_output_files', {
				sessionId: currentSessionId,
				stepId,
			})

			if (files && files.length > 0) {
				const fileList = files.map((f) => `• ${f}`).join('\n')
				if (dialog?.message) {
					await dialog.message(`Files to be shared:\n\n${fileList}`, {
						title: 'Output Files',
						kind: 'info',
					})
				}
			} else {
				if (dialog?.message) {
					await dialog.message('No output files found', { title: 'Preview', kind: 'info' })
				}
			}
		} catch (error) {
			console.error('Failed to preview outputs:', error)
		}
	}

	async function shareOutputs(stepId) {
		if (!currentSessionId) return

		const confirmed = await dialog?.ask(
			'Are you sure you want to share these outputs with other participants?',
			{
				title: 'Share Outputs',
				kind: 'warning',
				okLabel: 'Share',
				cancelLabel: 'Cancel',
			},
		)

		if (!confirmed) return

		try {
			await invoke('share_step_outputs', {
				sessionId: currentSessionId,
				stepId,
			})
			await refreshFlowState()
		} catch (error) {
			console.error('Failed to share outputs:', error)
			if (dialog?.message) {
				await dialog.message(`Failed to share outputs: ${error}`, { title: 'Error', kind: 'error' })
			}
		}
	}

	async function acceptInvitation(sessionId, flowName, flowSpec, participants, autoRunAll = false) {
		try {
			const state = await invoke('accept_flow_invitation', {
				sessionId,
				flowName,
				flowSpec,
				participants,
				autoRunAll,
			})
			openModal(sessionId, flowName, flowSpec, participants)
			return state
		} catch (error) {
			console.error('Failed to accept invitation:', error)
			throw error
		}
	}

	function startPolling() {
		stopPolling()
		pollInterval = setInterval(refreshFlowState, 2000)
	}

	function stopPolling() {
		if (pollInterval) {
			clearInterval(pollInterval)
			pollInterval = null
		}
	}

	window.multipartyFlowModal = {
		openModal,
		closeModal,
		toggleAutoRun,
		runStep,
		previewOutputs,
		shareOutputs,
		acceptInvitation,
		refreshFlowState,
	}

	return {
		openModal,
		closeModal,
		acceptInvitation,
		refreshFlowState,
	}
}

export function createProposeFlowModal({
	invoke,
	dialog,
	getCurrentUserEmail,
	getThreadParticipants,
	sendMessage,
}) {
	let selectedFlow = null
	let flowRoles = []
	let roleAssignments = {}

	function escapeHtml(text) {
		const div = document.createElement('div')
		div.textContent = text
		return div.innerHTML
	}

	async function open() {
		const modal = document.getElementById('propose-flow-modal')
		if (!modal) {
			console.error('Propose flow modal not found')
			return
		}

		// Reset state
		selectedFlow = null
		flowRoles = []
		roleAssignments = {}

		// Load multiparty flows
		await loadMultipartyFlows()

		// Show modal
		modal.style.display = 'flex'
	}

	function close() {
		const modal = document.getElementById('propose-flow-modal')
		if (modal) {
			modal.style.display = 'none'
		}
		selectedFlow = null
		flowRoles = []
		roleAssignments = {}
	}

	async function loadMultipartyFlows() {
		const select = document.getElementById('propose-flow-select')
		if (!select) return

		try {
			// Get local flows (use get_flows command, not list_flows)
			const flows = await invoke('get_flows')
			console.log('[ProposeFlow] Loaded flows:', flows)
			console.log('[ProposeFlow] Flow count:', flows?.length || 0)

			// Debug: log each flow's structure
			;(flows || []).forEach((f, i) => {
				console.log(`[ProposeFlow] Flow ${i}:`, {
					name: f.metadata?.name || f.name,
					hasSpec: !!f.spec,
					specKeys: f.spec ? Object.keys(f.spec) : [],
					specFull: f.spec,
					multiparty: f.spec?.multiparty,
					roles: f.spec?.roles,
					topLevelKeys: Object.keys(f),
				})
			})

			// Filter for multiparty flows - check various possible structures
			const multipartyFlows = (flows || []).filter((f) => {
				// Check spec.multiparty
				if (f.spec?.multiparty === true) return true
				// Check if it has roles defined (another indicator of multiparty)
				if (Array.isArray(f.spec?.roles) && f.spec.roles.length > 1) return true
				// Also check top-level in case spec is unwrapped
				if (f.multiparty === true) return true
				if (Array.isArray(f.roles) && f.roles.length > 1) return true
				return false
			})

			console.log('[ProposeFlow] Multiparty flows:', multipartyFlows)

			select.innerHTML = '<option value="">-- Select a multiparty flow --</option>'

			if (multipartyFlows.length === 0) {
				// No multiparty flows found - show helpful option
				const noFlowsOption = document.createElement('option')
				noFlowsOption.value = '__no_flows__'
				noFlowsOption.textContent = 'No multiparty flows found - click to import'
				select.appendChild(noFlowsOption)
			} else {
				for (const flow of multipartyFlows) {
					const name = flow.metadata?.name || flow.name || 'Unknown'
					const option = document.createElement('option')
					option.value = name
					option.textContent = name
					option.dataset.flowSpec = JSON.stringify(flow)
					select.appendChild(option)
				}
			}

			// Add event listener for flow selection
			select.onchange = () => handleFlowSelection(select)
		} catch (error) {
			console.error('Failed to load flows:', error)
			// Show option to go to Flows page
			select.innerHTML = '<option value="">-- Select a multiparty flow --</option>'
			const errorOption = document.createElement('option')
			errorOption.value = '__go_to_flows__'
			errorOption.textContent = 'Go to Flows to import one →'
			select.appendChild(errorOption)
		}
	}

	function handleFlowSelection(select) {
		const selectedOption = select.options[select.selectedIndex]
		const rolesSection = document.getElementById('propose-flow-roles-section')
		const messageSection = document.getElementById('propose-flow-message-section')
		const sendBtn = document.getElementById('propose-flow-send-btn')

		// Handle special navigation options
		if (selectedOption?.value === '__no_flows__' || selectedOption?.value === '__go_to_flows__') {
			close()
			// Navigate to Flows tab
			const event = new CustomEvent('navigate-to-tab', { detail: { tab: 'flows' } })
			window.dispatchEvent(event)
			return
		}

		if (!selectedOption?.value || !selectedOption.dataset.flowSpec) {
			selectedFlow = null
			flowRoles = []
			if (rolesSection) rolesSection.style.display = 'none'
			if (messageSection) messageSection.style.display = 'none'
			if (sendBtn) sendBtn.disabled = true
			return
		}

		try {
			selectedFlow = JSON.parse(selectedOption.dataset.flowSpec)
			flowRoles = selectedFlow.spec?.roles || []
			renderRoleAssignments()
			if (rolesSection) rolesSection.style.display = 'block'
			if (messageSection) messageSection.style.display = 'block'
			updateSendButton()
		} catch (error) {
			console.error('Failed to parse flow spec:', error)
		}
	}

	function renderRoleAssignments() {
		const container = document.getElementById('propose-flow-roles-list')
		if (!container) return

		// Get current user and thread participants
		const currentUser = getCurrentUserEmail ? getCurrentUserEmail() : ''
		const participants = getThreadParticipants ? getThreadParticipants() : []

		// Build list of available contacts (current user + thread participants)
		const contacts = []
		if (currentUser) {
			contacts.push({ email: currentUser, isMe: true })
		}
		for (const p of participants) {
			if (p && p !== currentUser) {
				contacts.push({ email: p, isMe: false })
			}
		}

		container.innerHTML = flowRoles
			.map((role, idx) => {
				const roleId = role.id || role
				const roleDesc = role.description || ''

				// Auto-assign if possible
				let defaultValue = ''
				if (idx < contacts.length) {
					defaultValue = contacts[idx].email
					roleAssignments[roleId] = defaultValue
				}

				const optionsHtml = contacts
					.map(
						(c) =>
							`<option value="${escapeHtml(c.email)}" ${c.email === defaultValue ? 'selected' : ''}>${escapeHtml(c.email)}${c.isMe ? ' (me)' : ''}</option>`,
					)
					.join('')

				return `
				<div class="propose-flow-role-row">
					<div class="propose-flow-role-label">${escapeHtml(roleId)}</div>
					<span class="propose-flow-role-arrow">→</span>
					<select class="propose-flow-role-select" data-role="${escapeHtml(roleId)}" onchange="window.proposeFlowModal.updateRoleAssignment('${escapeHtml(roleId)}', this.value)">
						<option value="">-- Select --</option>
						${optionsHtml}
					</select>
				</div>
			`
			})
			.join('')
	}

	function updateRoleAssignment(roleId, email) {
		if (email) {
			roleAssignments[roleId] = email
		} else {
			delete roleAssignments[roleId]
		}
		updateSendButton()
	}

	function updateSendButton() {
		const sendBtn = document.getElementById('propose-flow-send-btn')
		if (!sendBtn) return

		// Enable if all roles are assigned
		const allRolesAssigned = flowRoles.every((role) => {
			const roleId = role.id || role
			return roleAssignments[roleId]
		})

		sendBtn.disabled = !selectedFlow || !allRolesAssigned
	}

	async function sendInvitation() {
		if (!selectedFlow) {
			console.error('No flow selected')
			return
		}

		const flowName = selectedFlow.metadata?.name || selectedFlow.name || 'multiparty'
		const sessionId = `session-${Date.now()}`

		// Build participants list from role assignments
		const participants = flowRoles.map((role) => {
			const roleId = role.id || role
			return {
				email: roleAssignments[roleId],
				role: roleId,
			}
		})

		// Get message text
		const messageInput = document.getElementById('propose-flow-message')
		const customMessage = messageInput?.value?.trim() || ''
		const body = customMessage || `Let's run the "${flowName}" multiparty flow together!`

		// Get recipients (all participants except current user)
		const currentUser = getCurrentUserEmail ? getCurrentUserEmail() : ''
		const recipients = participants.filter((p) => p.email !== currentUser).map((p) => p.email)

		if (recipients.length === 0) {
			if (dialog?.message) {
				await dialog.message('Please assign at least one other participant to a role.', {
					title: 'No Recipients',
					kind: 'warning',
				})
			}
			return
		}

		try {
			// Send message with flow invitation metadata
			await sendMessage({
				recipients,
				body,
				subject: `Multiparty Flow: ${flowName}`,
				metadata: {
					flow_invitation: {
						flow_name: flowName,
						session_id: sessionId,
						participants,
						flow_spec: selectedFlow,
					},
				},
			})

			// Close modal
			close()

			// Optionally show success
			if (dialog?.message) {
				await dialog.message(`Flow invitation sent to ${recipients.join(', ')}`, {
					title: 'Invitation Sent',
					kind: 'info',
				})
			}
		} catch (error) {
			console.error('Failed to send invitation:', error)
			if (dialog?.message) {
				await dialog.message(`Failed to send invitation: ${error}`, {
					title: 'Error',
					kind: 'error',
				})
			}
		}
	}

	window.proposeFlowModal = {
		open,
		close,
		updateRoleAssignment,
		sendInvitation,
	}

	return {
		open,
		close,
	}
}
