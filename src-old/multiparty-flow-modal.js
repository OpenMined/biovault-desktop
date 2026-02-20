export function createMultipartyFlowModal({ invoke, dialog }) {
	let currentSessionId = null
	// eslint-disable-next-line no-unused-vars
	let currentFlowState = null
	let pollInterval = null
	let refreshInFlight = false
	const MODAL_POLL_INTERVAL_MS = 8000

	function escapeHtml(text) {
		const div = document.createElement('div')
		div.textContent = text
		return div.innerHTML
	}

	function escapeJsSingleQuoted(value) {
		return String(value || '')
			.replace(/\\/g, '\\\\')
			.replace(/'/g, "\\'")
			.replace(/\r/g, '\\r')
			.replace(/\n/g, '\\n')
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
		const escapedSessionId = escapeJsSingleQuoted(currentSessionId)

		container.innerHTML = participants
			.map(
				(p) => `
			<div class="multiparty-participant">
				<span class="participant-icon">👤</span>
				<span class="participant-email">${escapeHtml(p.email)}</span>
				<span class="participant-role">(${escapeHtml(p.role)})</span>
				<button class="participant-folder-btn" onclick="window.multipartyFlowModal.openParticipantSharedFolder('${escapedSessionId}', '${encodeURIComponent(String(p.email || ''))}')" title="Open your local copy of this participant's shared folder">📁</button>
			</div>
		`,
			)
			.join('')
	}

	function renderSteps(modal, steps, _myRole) {
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
		const isSecureAggregate = String(step?.id || '').toLowerCase() === 'secure_aggregate'
		const canRunFromStatus = isSecureAggregate
			? step.status === 'Ready'
			: step.status === 'Ready' || step.status === 'Pending'

		if (canRunFromStatus) {
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
		if (step.status === 'Completed' || step.status === 'Shared') {
			const stepIdEscaped = escapeJsSingleQuoted(step.id)
			actions.push(
				`<button class="step-btn force-rerun-btn" onclick="window.multipartyFlowModal.forceRerunStep('${stepIdEscaped}')">⟲ FORCE re-run</button>`,
			)
		}

		if (step.status === 'WaitingForInputs') {
			actions.push(
				'<span class="waiting-text">Waiting for inputs from other participants...</span>',
			)
		}
		if (
			step.status === 'Pending' ||
			step.status === 'WaitingForInputs' ||
			step.status === 'Failed'
		) {
			const forceLabel = step.shares_output ? '⏭ Force Share' : '⏭ Force Complete'
			actions.push(
				`<button class="step-btn run-btn" onclick="window.multipartyFlowModal.forceCompleteStep('${step.id}')">${forceLabel}</button>`,
			)
		}

		return `<div class="step-actions">${actions.join('')}</div>`
	}

	async function refreshFlowState() {
		if (!currentSessionId) return
		if (refreshInFlight) return

		try {
			refreshInFlight = true
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
		} finally {
			refreshInFlight = false
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

	async function runStep(stepId, { force = false } = {}) {
		if (!currentSessionId) return

		try {
			await invoke('run_flow_step', {
				sessionId: currentSessionId,
				stepId,
				force,
			})
			await refreshFlowState()
		} catch (error) {
			const actionText = force ? 'force re-run step' : 'run step'
			console.error(`Failed to ${actionText}:`, error)
			if (dialog?.message) {
				await dialog.message(`Failed to ${actionText}: ${error}`, {
					title: 'Error',
					kind: 'error',
				})
			}
		}
	}

	async function forceRerunStep(stepId) {
		if (!currentSessionId) return
		const confirmed = await dialog?.ask(
			`FORCE re-run "${stepId}"? This resets your local status for this step and runs it again, even if it is already completed/shared.`,
			{
				title: 'FORCE Re-run Step',
				kind: 'warning',
				okLabel: 'Force Re-run',
				cancelLabel: 'Cancel',
			},
		)
		if (!confirmed) return
		await runStep(stepId, { force: true })
	}

	async function forceCompleteStep(stepId) {
		if (!currentSessionId) return

		const confirmed = await dialog?.ask(
			'Force this step as complete/shared for your participant? This bypasses normal readiness checks and is intended for debugging recovery.',
			{
				title: 'Force Step Status',
				kind: 'warning',
				okLabel: 'Force',
				cancelLabel: 'Cancel',
			},
		)
		if (!confirmed) return

		try {
			await invoke('force_complete_flow_step', {
				sessionId: currentSessionId,
				stepId,
			})
			await refreshFlowState()
		} catch (error) {
			console.error('Failed to force-complete step:', error)
			if (dialog?.message) {
				await dialog.message(`Failed to force-complete step: ${error}`, {
					title: 'Error',
					kind: 'error',
				})
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

	async function openParticipantSharedFolder(sessionId, encodedEmail) {
		try {
			const participantEmail = decodeURIComponent(String(encodedEmail || ''))
			if (!participantEmail) return
			const sharedPath = await invoke('get_multiparty_participant_datasite_path', {
				sessionId,
				participantEmail,
			})
			if (!sharedPath) throw new Error(`Shared folder path unavailable for ${participantEmail}`)
			await invoke('open_folder', { path: sharedPath })
		} catch (error) {
			console.error('Failed to open participant shared folder:', error)
			if (dialog?.message) {
				await dialog.message(`Failed to open shared folder: ${error}`, {
					title: 'Error',
					kind: 'error',
				})
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
		pollInterval = setInterval(() => {
			refreshFlowState().catch(() => {})
		}, MODAL_POLL_INTERVAL_MS)
	}

	function stopPolling() {
		if (pollInterval) {
			clearInterval(pollInterval)
			pollInterval = null
		}
		refreshInFlight = false
	}

	window.multipartyFlowModal = {
		openModal,
		closeModal,
		toggleAutoRun,
		runStep,
		forceRerunStep,
		forceCompleteStep,
		previewOutputs,
		shareOutputs,
		openParticipantSharedFolder,
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
	let flowRoleDefaults = {}

	function escapeHtml(text) {
		const div = document.createElement('div')
		div.textContent = text
		return div.innerHTML
	}

	function isMultipartyFlow(flow) {
		const spec = flow?.spec || flow || {}
		if (spec.multiparty === true || flow?.multiparty === true) return true
		if (Array.isArray(spec.roles) && spec.roles.length > 1) return true
		if (Array.isArray(flow?.roles) && flow.roles.length > 1) return true
		if (spec?.inputs?.datasites) return true
		if (Array.isArray(spec?.datasites?.all) && spec.datasites.all.length > 1) return true
		if (Array.isArray(spec?.datasites) && spec.datasites.length > 1) return true
		return false
	}

	function getDefaultDatasitesFromFlow(flow) {
		const spec = flow?.spec || flow || {}
		if (Array.isArray(spec?.inputs?.datasites?.default)) {
			return spec.inputs.datasites.default.filter(Boolean)
		}
		if (Array.isArray(spec?.datasites?.all)) {
			return spec.datasites.all.filter(Boolean)
		}
		if (Array.isArray(spec?.datasites)) {
			return spec.datasites.filter(Boolean)
		}
		return []
	}

	function resolveDefaultFromIncludeToken(token, defaultDatasites) {
		const trimmed = String(token || '').trim()
		if (!trimmed) return ''
		if (trimmed.includes('@')) return trimmed
		if (trimmed.startsWith('{datasites[') && trimmed.endsWith(']}')) {
			const idxStr = trimmed.slice('{datasites['.length, -2)
			const idx = Number.parseInt(idxStr, 10)
			if (Number.isFinite(idx) && idx >= 0 && idx < defaultDatasites.length) {
				return defaultDatasites[idx] || ''
			}
		}
		return ''
	}

	function collectStepTargetTokens(spec) {
		const steps = Array.isArray(spec?.steps) ? spec.steps : []
		const tokens = []
		for (const step of steps) {
			const runTargets = step?.run?.targets ?? step?.runs_on
			if (Array.isArray(runTargets)) {
				runTargets.forEach((t) => tokens.push(String(t || '').trim()))
			} else if (typeof runTargets === 'string') {
				tokens.push(runTargets.trim())
			}
			const barrierTargets = step?.barrier?.targets
			if (Array.isArray(barrierTargets)) {
				barrierTargets.forEach((t) => tokens.push(String(t || '').trim()))
			} else if (typeof barrierTargets === 'string') {
				tokens.push(barrierTargets.trim())
			}
		}
		return tokens.filter(Boolean)
	}

	function normalizeRoleFromTargetToken(token) {
		const t = String(token || '')
			.trim()
			.toLowerCase()
		if (!t) return null
		if (t === 'all' || t === '*' || t === '{datasites[*]}' || t === '{datasite.current}')
			return null
		if (t.startsWith('{groups.') && t.endsWith('}')) {
			const name = t.slice('{groups.'.length, -1).trim()
			if (!name) return null
			if (name === 'contributor' || name === 'contributors') return 'clients'
			return name
		}
		if (t.includes('@')) {
			const local = t.split('@')[0] || ''
			if (/^aggregator\d*$/.test(local)) return 'aggregator'
			if (/^(client|contributor)\d+$/.test(local)) return 'clients'
			if (
				local === 'client' ||
				local === 'clients' ||
				local === 'contributor' ||
				local === 'contributors'
			)
				return 'clients'
			return local || null
		}
		if (t === 'contributor' || t === 'contributors') return 'clients'
		return t
	}

	function inferRolesFromStepTargets(spec, defaultDatasites) {
		const tokens = collectStepTargetTokens(spec)
		if (tokens.length === 0) return null

		const order = []
		const counts = {}
		const explicitRoleTargets = {}
		for (const token of tokens) {
			const role = normalizeRoleFromTargetToken(token)
			if (!role) continue
			if (!order.includes(role)) order.push(role)
			if (counts[role] == null) counts[role] = 0
			if (!explicitRoleTargets[role]) explicitRoleTargets[role] = new Set()

			if (token.includes('@')) {
				const local = token.split('@')[0].toLowerCase()
				if (/^(client|contributor)\d+$/.test(local)) {
					// Count explicit numbered targets only once per unique label.
					explicitRoleTargets[role].add(local)
					counts[role] = explicitRoleTargets[role].size
				} else if (counts[role] === 0) {
					counts[role] = 1
				}
			} else if (counts[role] === 0) {
				counts[role] = 1
			}
		}

		if (order.length === 0) return null

		let totalSlots = Object.values(counts).reduce((sum, n) => sum + (n || 0), 0)
		if (defaultDatasites.length > totalSlots) {
			const remainder = defaultDatasites.length - totalSlots
			const expandable =
				order.find((r) => r === 'clients') || order.find((r) => r.endsWith('s')) || order[0]
			counts[expandable] = (counts[expandable] || 0) + remainder
			totalSlots += remainder
		}

		// Preserve aggregator visibility when present.
		if (order.includes('aggregator')) {
			const withoutAggregator = order.filter((r) => r !== 'aggregator')
			order.splice(0, order.length, 'aggregator', ...withoutAggregator)
		}

		// Never infer more slots than default datasites when defaults are available.
		// This prevents repeated step targets from inflating role rows (e.g. clients 1..6).
		const maxSlots = defaultDatasites.length > 0 ? defaultDatasites.length : Number.MAX_SAFE_INTEGER

		const roles = []
		for (const role of order) {
			const count = Math.max(1, counts[role] || 0)
			for (let i = 0; i < count; i += 1) {
				if (roles.length >= maxSlots) break
				const roleId = count > 1 ? `${role}_${i + 1}` : role
				roles.push({
					id: roleId,
					role,
					label: count > 1 ? `${role} ${i + 1}` : role,
				})
			}
			if (roles.length >= maxSlots) break
		}
		return roles.length > 0 ? roles : null
	}

	function inferFlowRoles(flow) {
		const spec = flow?.spec || flow || {}
		const roles = Array.isArray(spec?.roles) ? spec.roles : []
		if (roles.length > 0) {
			return { roles, defaults: {} }
		}

		const defaultDatasites = getDefaultDatasitesFromFlow(flow)
		const groups = spec?.datasites?.groups
		if (defaultDatasites.length > 0) {
			// If groups are not preserved in the loaded flow spec, infer semantic roles
			// from step targets (e.g. clients/aggregator) before falling back to generic
			// participant slots.
			const hasGroups = !!groups && typeof groups === 'object' && Object.keys(groups).length > 0
			if (!hasGroups) {
				const rolesFromTargets = inferRolesFromStepTargets(spec, defaultDatasites)
				if (rolesFromTargets && rolesFromTargets.length > 0) {
					const selectedRoles = rolesFromTargets.slice(0, defaultDatasites.length)
					const defaults = {}
					for (let i = 0; i < Math.min(defaultDatasites.length, selectedRoles.length); i += 1) {
						defaults[selectedRoles[i].id] = defaultDatasites[i]
					}
					return { roles: selectedRoles, defaults }
				}
			}

			const inferredRoles = []
			const defaults = {}
			const roleCounts = {}

			for (let i = 0; i < defaultDatasites.length; i += 1) {
				const email = defaultDatasites[i]
				let roleName = 'participant'

				if (groups && typeof groups === 'object') {
					for (const [groupName, groupDef] of Object.entries(groups)) {
						const include = Array.isArray(groupDef?.include) ? groupDef.include : []
						for (const token of include) {
							const resolved = resolveDefaultFromIncludeToken(token, defaultDatasites)
							if (resolved && resolved.toLowerCase() === String(email).toLowerCase()) {
								roleName = groupName
								break
							}
						}
						if (roleName !== 'participant') break
					}
				}

				roleCounts[roleName] = (roleCounts[roleName] || 0) + 1
				const countForRole = roleCounts[roleName]
				const roleId = countForRole > 1 ? `${roleName}_${countForRole}` : roleName
				defaults[roleId] = email
				inferredRoles.push({
					id: roleId,
					role: roleName,
					label: countForRole > 1 ? `${roleName} ${countForRole}` : roleName,
					description: `Default: ${email}`,
				})
			}

			return { roles: inferredRoles, defaults }
		}
		if (groups && typeof groups === 'object') {
			const inferredRoles = []
			const defaults = {}

			for (const [groupName, groupDef] of Object.entries(groups)) {
				const include = Array.isArray(groupDef?.include) ? groupDef.include : []
				const slotCount = Math.max(include.length, 1)

				for (let i = 0; i < slotCount; i += 1) {
					const roleId = slotCount > 1 ? `${groupName}_${i + 1}` : groupName
					const defaultEmail = resolveDefaultFromIncludeToken(include[i], defaultDatasites)
					if (defaultEmail) defaults[roleId] = defaultEmail
					inferredRoles.push({
						id: roleId,
						role: groupName,
						label: slotCount > 1 ? `${groupName} ${i + 1}` : groupName,
						description: defaultEmail ? `Default: ${defaultEmail}` : '',
					})
				}
			}

			if (inferredRoles.length > 0) {
				return { roles: inferredRoles, defaults }
			}
		}

		const rolesFromTargets = inferRolesFromStepTargets(spec, defaultDatasites)
		if (rolesFromTargets && rolesFromTargets.length > 0) {
			const defaults = {}
			for (let i = 0; i < Math.min(defaultDatasites.length, rolesFromTargets.length); i += 1) {
				defaults[rolesFromTargets[i].id] = defaultDatasites[i]
			}
			return { roles: rolesFromTargets, defaults }
		}

		const defaults = {}
		const datasites = defaultDatasites
		const participantCount = Math.max(datasites.length, 2)
		const inferredRoles = Array.from({ length: participantCount }, (_, index) => {
			const roleId = `participant${index + 1}`
			if (datasites[index]) defaults[roleId] = datasites[index]
			return {
				id: roleId,
				description: datasites[index] ? `Default: ${datasites[index]}` : '',
			}
		})
		return { roles: inferredRoles, defaults }
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
		flowRoleDefaults = {}

		// Reset section visibility
		const rolesSection = document.getElementById('propose-flow-roles-section')
		const messageSection = document.getElementById('propose-flow-message-section')
		const sendBtn = document.getElementById('propose-flow-send-btn')
		if (rolesSection) rolesSection.style.display = 'none'
		if (messageSection) messageSection.style.display = 'none'
		if (sendBtn) sendBtn.disabled = true

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
		flowRoleDefaults = {}
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
			const multipartyFlows = (flows || []).filter((f) => isMultipartyFlow(f))

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
			flowRoleDefaults = {}
			roleAssignments = {}
			if (rolesSection) rolesSection.style.display = 'none'
			if (messageSection) messageSection.style.display = 'none'
			if (sendBtn) sendBtn.disabled = true
			return
		}

		try {
			selectedFlow = JSON.parse(selectedOption.dataset.flowSpec)
			const inferred = inferFlowRoles(selectedFlow)
			flowRoles = inferred.roles
			flowRoleDefaults = inferred.defaults
			roleAssignments = {}
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
		// Build list of available contacts with stable de-duplication.
		// Use live identities only (current user + thread participants).
		// Do not filter role-like sandbox emails here because they are valid identities
		// in local/dev scenarios (e.g., client1@sandbox.local, aggregator@sandbox.local).
		const contacts = []
		const seenEmails = new Set()
		const addContact = (email, isMe = false) => {
			const normalized = String(email || '').trim()
			if (!normalized) return
			const key = normalized.toLowerCase()
			if (seenEmails.has(key)) {
				if (isMe) {
					const existing = contacts.find((c) => c.email.toLowerCase() === key)
					if (existing) existing.isMe = true
				}
				return
			}
			seenEmails.add(key)
			contacts.push({ email: normalized, isMe })
		}

		addContact(currentUser, true)
		for (const p of participants) addContact(p, String(p || '').trim() === currentUser)

		const usedAutoAssignments = new Set()

		container.innerHTML = flowRoles
			.map((role, _idx) => {
				const roleId = role.id || role
				const roleLabel = role.label || roleId

				// Auto-assign if possible
				let defaultValue = ''
				const preferred = flowRoleDefaults[roleId] || ''
				const preferredInContacts = preferred
					? contacts.find((c) => c.email.toLowerCase() === preferred.toLowerCase())
					: null
				if (
					preferredInContacts &&
					!usedAutoAssignments.has(preferredInContacts.email.toLowerCase())
				) {
					defaultValue = preferredInContacts.email
				} else {
					const fallback = contacts.find((c) => !usedAutoAssignments.has(c.email.toLowerCase()))
					if (fallback) defaultValue = fallback.email
				}
				if (defaultValue) {
					roleAssignments[roleId] = defaultValue
					usedAutoAssignments.add(defaultValue.toLowerCase())
				}

				const optionsHtml = contacts
					.map(
						(c) =>
							`<option value="${escapeHtml(c.email)}" ${c.email === defaultValue ? 'selected' : ''}>${escapeHtml(c.email)}${c.isMe ? ' (me)' : ''}</option>`,
					)
					.join('')

				return `
						<div class="propose-flow-role-row">
							<div class="propose-flow-role-label">${escapeHtml(roleLabel)}</div>
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

	function syncRoleAssignmentsFromDom() {
		const container = document.getElementById('propose-flow-roles-list')
		if (!container) return
		const selects = container.querySelectorAll('.propose-flow-role-select')
		for (const select of selects) {
			const roleId = select.getAttribute('data-role')
			if (!roleId) continue
			const value = String(select.value || '').trim()
			if (value) {
				roleAssignments[roleId] = value
			} else {
				delete roleAssignments[roleId]
			}
		}
	}

	function updateSendButton() {
		const sendBtn = document.getElementById('propose-flow-send-btn')
		if (!sendBtn) return
		syncRoleAssignmentsFromDom()
		if (!selectedFlow) {
			const flowSelect = document.getElementById('propose-flow-select')
			const selectedIndex =
				typeof flowSelect?.selectedIndex === 'number' ? flowSelect.selectedIndex : -1
			const selectedOption =
				selectedIndex >= 0 && flowSelect?.options ? flowSelect.options[selectedIndex] : null
			const serialized = selectedOption?.dataset?.flowSpec
			if (serialized) {
				try {
					selectedFlow = JSON.parse(serialized)
				} catch (error) {
					console.warn('Failed to rehydrate selected flow from dropdown:', error)
				}
			}
		}

		// Enable if all roles are assigned
		const allRolesAssigned = flowRoles.every((role) => {
			const roleId = role.id || role
			return roleAssignments[roleId]
		})

		sendBtn.disabled = !selectedFlow || !allRolesAssigned
	}

	function collectParticipantsFromDom() {
		const container = document.getElementById('propose-flow-roles-list')
		const participants = []
		for (const role of flowRoles) {
			const roleId = role.id || role
			const roleName = role.role || roleId
			let email = String(roleAssignments[roleId] || '').trim()
			if (!email && container) {
				const selects = container.querySelectorAll('.propose-flow-role-select')
				const select = Array.from(selects).find(
					(el) => String(el.getAttribute('data-role') || '') === String(roleId),
				)
				email = String(select?.value || '').trim()
			}
			participants.push({
				email,
				role: roleName,
				role_id: roleId,
			})
		}
		return participants
	}

	function remapFlowSpecForParticipants(flow, participants) {
		// Clone so the original flow object in the modal state remains untouched.
		const flowCopy = JSON.parse(JSON.stringify(flow))
		const specRoot = flowCopy?.spec || flowCopy
		if (!specRoot || typeof specRoot !== 'object') return flowCopy

		const roleToEmail = new Map()
		const roleIdToEmail = new Map()
		const orderedEmails = []
		for (const p of participants) {
			const email = String(p?.email || '').trim()
			if (!email) continue
			if (!orderedEmails.includes(email)) orderedEmails.push(email)
			if (p?.role) {
				const key = String(p.role).trim().toLowerCase()
				if (key && !roleToEmail.has(key)) roleToEmail.set(key, email)
			}
			if (p?.role_id) {
				const key = String(p.role_id).trim().toLowerCase()
				if (key && !roleIdToEmail.has(key)) roleIdToEmail.set(key, email)
			}
		}

		const resolveToken = (token) => {
			const trimmed = String(token || '').trim()
			if (!trimmed) return ''
			if (trimmed.startsWith('{datasites[') && trimmed.endsWith(']}')) {
				const idxStr = trimmed.slice('{datasites['.length, -2)
				const idx = Number.parseInt(idxStr, 10)
				if (Number.isFinite(idx) && idx >= 0 && idx < orderedEmails.length) {
					return orderedEmails[idx]
				}
			}
			if (trimmed.includes('@')) return trimmed
			const lookup = trimmed.toLowerCase()
			if (roleIdToEmail.has(lookup)) return roleIdToEmail.get(lookup) || ''
			if (roleToEmail.has(lookup)) return roleToEmail.get(lookup) || ''
			if ((lookup === 'client' || lookup === 'contributor') && roleToEmail.has('clients')) {
				return roleToEmail.get('clients') || ''
			}
			return ''
		}

		if (specRoot.datasites && typeof specRoot.datasites === 'object') {
			specRoot.datasites.all = [...orderedEmails]
			if (specRoot.datasites.groups && typeof specRoot.datasites.groups === 'object') {
				for (const [_groupName, groupDef] of Object.entries(specRoot.datasites.groups)) {
					const include = Array.isArray(groupDef?.include) ? groupDef.include : []
					const remapped = []
					for (const item of include) {
						const token = String(item || '').trim()
						if (!token) continue
						if (token === '{datasites[*]}' || token.toLowerCase() === 'all') {
							remapped.push(...orderedEmails)
							continue
						}
						const mapped = resolveToken(token)
						if (mapped) remapped.push(mapped)
					}
					if (remapped.length > 0) {
						groupDef.include = [...new Set(remapped)]
					}
				}
			}
		}

		if (specRoot.inputs?.datasites && typeof specRoot.inputs.datasites === 'object') {
			specRoot.inputs.datasites.default = [...orderedEmails]
		}

		return flowCopy
	}

	async function sendInvitation() {
		if (!selectedFlow) {
			console.error('No flow selected')
			return
		}
		syncRoleAssignmentsFromDom()

		const participants = collectParticipantsFromDom()
		const remappedFlowSpec = remapFlowSpecForParticipants(selectedFlow, participants)
		const flowName = remappedFlowSpec?.metadata?.name || remappedFlowSpec?.name || 'multiparty'

		const missingRoles = participants.filter((p) => !p.email)
		if (missingRoles.length > 0) {
			if (dialog?.message) {
				await dialog.message('Please assign an email for every role before sending.', {
					title: 'Missing Role Assignments',
					kind: 'warning',
				})
			}
			return
		}

		const roleIdsByEmail = new Map()
		for (const p of participants) {
			const list = roleIdsByEmail.get(p.email) || []
			list.push(p.role_id)
			roleIdsByEmail.set(p.email, list)
		}
		const duplicateAssignments = Array.from(roleIdsByEmail.entries()).filter(
			([, roles]) => roles.length > 1,
		)
		if (duplicateAssignments.length > 0) {
			const details = duplicateAssignments
				.map(([email, roles]) => `${email} (${roles.join(', ')})`)
				.join('\n')
			if (dialog?.message) {
				await dialog.message(
					`Each role must be assigned to a different participant.\n\nDuplicate assignments:\n${details}`,
					{
						title: 'Duplicate Role Assignments',
						kind: 'warning',
					},
				)
			}
			return
		}

		// Get message text
		const messageInput = document.getElementById('propose-flow-message')
		const customMessage = messageInput?.value?.trim() || ''
		const body = customMessage || `Let's run the "${flowName}" multiparty flow together!`

		// Get recipients (all participants except current user)
		const currentUser = getCurrentUserEmail ? getCurrentUserEmail() : ''
		const recipients = Array.from(
			new Set(participants.filter((p) => p.email !== currentUser).map((p) => p.email)),
		)

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
			// Get thread ID from messages module
			const threadId = window.messagesModule?.activeThreadId || `thread-${Date.now()}`

			// First, set up the proposer's session on the backend - this returns the session ID
			const sessionId = await invoke('send_flow_invitation', {
				threadId,
				flowName,
				flowSpec: remappedFlowSpec,
				participantRoles: participants,
			})

			// Send message with flow invitation metadata using the backend's session ID
			await sendMessage({
				recipients,
				body,
				subject: `Multiparty Flow: ${flowName}`,
				metadata: {
					flow_invitation: {
						flow_name: flowName,
						session_id: sessionId,
						proposed_by: currentUser || null,
						flow_location:
							currentUser && sessionId
								? `syft://${currentUser}/shared/flows/${flowName}/${sessionId}/_flow_source`
								: null,
						participants,
						flow_spec: remappedFlowSpec,
					},
				},
			})

			// Close modal
			close()

			// Show success and navigate to Runs
			if (dialog?.message) {
				await dialog.message(
					`Flow invitation sent to ${recipients.join(', ')}. Navigate to Runs to manage the flow.`,
					{
						title: 'Invitation Sent',
						kind: 'info',
					},
				)
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
