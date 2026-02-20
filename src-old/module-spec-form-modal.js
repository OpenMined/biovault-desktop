/**
 * Module Spec Form with Modal + Clean List
 * Much better UX - matches CLI flow
 */

let entryCounter = 0
let cachedTypeInfo = null
let invokeFunction = null

function createId(prefix) {
	entryCounter += 1
	return `${prefix}-${Date.now()}-${entryCounter}`
}

// Fetch type info from CLI
async function getTypeInfo() {
	if (cachedTypeInfo) return cachedTypeInfo

	try {
		const [inputTypes, outputTypes, parameterTypes, formats] = await Promise.all([
			invokeFunction('get_supported_input_types'),
			invokeFunction('get_supported_output_types'),
			invokeFunction('get_supported_parameter_types'),
			invokeFunction('get_common_formats'),
		])

		cachedTypeInfo = {
			inputTypes: inputTypes?.base_types || ['File', 'Directory', 'String'],
			inputCommonTypes: inputTypes?.common_types || ['File', 'Directory', 'String', 'List[File]'],
			outputTypes: outputTypes?.base_types || ['File', 'Directory'],
			outputCommonTypes: outputTypes?.common_types || ['File', 'Directory'],
			parameterTypes: parameterTypes || ['String', 'Bool', 'Enum[...]'],
			formats: formats || ['csv', 'tsv', 'txt', 'json', 'vcf', 'fasta', 'fastq'],
		}
	} catch (error) {
		console.warn('Failed to load types from CLI, using defaults:', error)
		cachedTypeInfo = {
			inputTypes: [
				'File',
				'Directory',
				'String',
				'List[File]',
				'List[Directory]',
				'ParticipantSheet',
				'GenotypeRecord',
			],
			inputCommonTypes: ['File', 'Directory', 'String', 'List[File]'],
			outputTypes: ['File', 'Directory', 'ParticipantSheet', 'GenotypeRecord'],
			outputCommonTypes: ['File', 'Directory'],
			parameterTypes: ['String', 'Bool', 'Enum[...]'],
			formats: ['csv', 'tsv', 'txt', 'json', 'vcf', 'fasta', 'fastq'],
		}
	}

	return cachedTypeInfo
}

// Generate ASCII art contract preview
export function generateContractAscii({ name, parameters, inputs, outputs }) {
	const lines = []
	lines.push(`╔═══════════════════════════════════════╗`)
	lines.push(`║  ${name.toUpperCase().padEnd(37)}║`)
	lines.push(`╠═══════════════════════════════════════╣`)

	if (inputs.length > 0) {
		lines.push(`║ INPUTS (${inputs.length})${' '.repeat(29)}║`)
		inputs.forEach((input) => {
			const label = `  📥 ${input.name}: ${input.raw_type}`
			lines.push(`║ ${label.padEnd(37)}║`)
		})
	}

	if (parameters.length > 0) {
		lines.push(`║${' '.repeat(39)}║`)
		lines.push(`║ PARAMETERS (${parameters.length})${' '.repeat(24)}║`)
		parameters.forEach((param) => {
			const label = `  ⚙️  ${param.name}: ${param.raw_type}`
			lines.push(`║ ${label.padEnd(37)}║`)
		})
	}

	if (outputs.length > 0) {
		lines.push(`║${' '.repeat(39)}║`)
		lines.push(`║ OUTPUTS (${outputs.length})${' '.repeat(27)}║`)
		outputs.forEach((output) => {
			const label = `  📤 ${output.name}: ${output.raw_type}`
			lines.push(`║ ${label.padEnd(37)}║`)
		})
	}

	lines.push(`╚═══════════════════════════════════════╝`)
	return lines.join('\n')
}

// Modal state
let modalState = {
	isOpen: false,
	mode: 'add', // 'add' or 'edit'
	type: 'input', // 'input', 'parameter', 'output'
	editingId: null,
	data: {},
}

// Show modal
async function showSpecModal(type, mode = 'add', existingData = null) {
	modalState = {
		isOpen: true,
		mode,
		type,
		editingId: existingData?.id || null,
		data: existingData || {},
	}

	const overlay = document.getElementById('spec-item-modal')
	const title = document.getElementById('spec-item-modal-title')
	const body = document.getElementById('spec-item-modal-body')
	const submit = document.getElementById('spec-item-modal-submit')

	// Set title
	const typeLabels = { input: 'Input', parameter: 'Parameter', output: 'Output' }
	title.textContent = mode === 'add' ? `Add ${typeLabels[type]}` : `Edit ${typeLabels[type]}`
	submit.textContent = mode === 'add' ? 'Add' : 'Save'

	// Load type info from CLI
	const typeInfo = await getTypeInfo()

	// Generate form based on type
	if (type === 'parameter') {
		const paramTypeOptions = typeInfo.parameterTypes
			.map(
				(t) =>
					`<option value="${t}" ${
						existingData?.raw_type === t ||
						(t.startsWith('Enum') && existingData?.raw_type?.startsWith('Enum'))
							? 'selected'
							: ''
					}>${t}</option>`,
			)
			.join('')

		body.innerHTML = `
			<div class="modal-form-field">
				<label class="modal-field-label">Name<span class="required">*</span></label>
				<input type="text" class="modal-field-input" id="modal-field-name" placeholder="e.g., quality_threshold" value="${
					existingData?.name || ''
				}" spellcheck="false" />
				<span class="modal-field-hint">Unique identifier for this parameter</span>
			</div>
			<div class="modal-form-field">
				<label class="modal-field-label">Type<span class="required">*</span></label>
				<select class="modal-field-input" id="modal-field-type">
					<option value="">Select type...</option>
					${paramTypeOptions}
				</select>
			</div>
			<div class="modal-form-field">
				<label class="modal-field-label">Description</label>
				<input type="text" class="modal-field-input" id="modal-field-description" placeholder="What this parameter controls" value="${
					existingData?.description || ''
				}" />
			</div>
			<details class="modal-advanced-section" ${
				existingData?.default || existingData?.choices ? 'open' : ''
			}>
				<summary>Advanced Options</summary>
				<div class="modal-advanced-content">
					<div class="modal-form-field">
						<label class="modal-field-label">Default Value</label>
						<input type="text" class="modal-field-input" id="modal-field-default" placeholder="e.g., 30" value="${
							existingData?.default || ''
						}" spellcheck="false" />
					</div>
					<div class="modal-form-field" id="modal-choices-field" style="display: none;">
						<label class="modal-field-label">Choices</label>
						<input type="text" class="modal-field-input" id="modal-field-choices" placeholder="low, medium, high" value="${
							existingData?.choices?.join(', ') || ''
						}" spellcheck="false" />
						<span class="modal-field-hint">Comma-separated values for Enum dropdown</span>
					</div>
				</div>
			</details>
		`
		// Show/hide choices field
		const typeSelect = body.querySelector('#modal-field-type')
		const choicesField = body.querySelector('#modal-choices-field')
		typeSelect.addEventListener('change', () => {
			choicesField.style.display = typeSelect.value.startsWith('Enum') ? 'block' : 'none'
		})
		if (typeSelect.value.startsWith('Enum')) {
			choicesField.style.display = 'block'
		}
	} else if (type === 'input') {
		body.innerHTML = `
			<div class="modal-form-field">
				<label class="modal-field-label">Name<span class="required">*</span></label>
				<input type="text" class="modal-field-input" id="modal-field-name" placeholder="e.g., samplesheet" value="${
					existingData?.name || ''
				}" spellcheck="false" />
				<span class="modal-field-hint">Unique identifier for this input</span>
			</div>
			<div class="modal-form-field">
				<label class="modal-field-label">Type<span class="required">*</span></label>
				<select class="modal-field-input" id="modal-field-type">
					<option value="">Select type...</option>
					<option value="File" ${existingData?.raw_type === 'File' ? 'selected' : ''}>File</option>
					<option value="Directory" ${
						existingData?.raw_type === 'Directory' ? 'selected' : ''
					}>Directory</option>
					<option value="String" ${existingData?.raw_type === 'String' ? 'selected' : ''}>String</option>
					<option value="List[File]" ${
						existingData?.raw_type === 'List[File]' ? 'selected' : ''
					}>List[File]</option>
					<option value="List[Directory]" ${
						existingData?.raw_type === 'List[Directory]' ? 'selected' : ''
					}>List[Directory]</option>
					<option value="ParticipantSheet" ${
						existingData?.raw_type === 'ParticipantSheet' ? 'selected' : ''
					}>ParticipantSheet</option>
					<option value="GenotypeRecord" ${
						existingData?.raw_type === 'GenotypeRecord' ? 'selected' : ''
					}>GenotypeRecord</option>
				</select>
				<span class="modal-field-hint">Data type for this input</span>
			</div>
			<div class="modal-form-field">
				<label class="modal-field-label">Description</label>
				<input type="text" class="modal-field-input" id="modal-field-description" placeholder="What this input contains" value="${
					existingData?.description || ''
				}" />
			</div>
			<details class="modal-advanced-section" ${existingData?.format || existingData?.path ? 'open' : ''}>
				<summary>Advanced Options</summary>
				<div class="modal-advanced-content">
					<div class="modal-form-field">
						<label class="modal-field-label">Format</label>
						<input type="text" class="modal-field-input" id="modal-field-format" placeholder="e.g., csv, json, vcf" value="${
							existingData?.format || ''
						}" spellcheck="false" />
						<span class="modal-field-hint">File format (optional)</span>
					</div>
					<div class="modal-form-field">
						<label class="modal-field-label">Path Pattern</label>
						<input type="text" class="modal-field-input" id="modal-field-path" placeholder="e.g., data/*.csv" value="${
							existingData?.path || ''
						}" spellcheck="false" />
						<span class="modal-field-hint">Default file path or pattern (optional)</span>
					</div>
				</div>
			</details>
		`
	} else if (type === 'output') {
		const defaultPath =
			existingData?.path || (existingData?.name ? `results/${existingData.name}` : '')
		const outputTypeOptions = typeInfo.outputTypes
			.map(
				(t) =>
					`<option value="${t}" ${existingData?.raw_type === t ? 'selected' : ''}>${t}</option>`,
			)
			.join('')
		const formatOptions = typeInfo.formats
			.map(
				(f) => `<option value="${f}" ${existingData?.format === f ? 'selected' : ''}>${f}</option>`,
			)
			.join('')

		body.innerHTML = `
			<div class="modal-form-field">
				<label class="modal-field-label">Name<span class="required">*</span></label>
				<input type="text" class="modal-field-input" id="modal-field-name" placeholder="e.g., results" value="${
					existingData?.name || ''
				}" spellcheck="false" />
				<span class="modal-field-hint">Unique identifier for this output</span>
			</div>
			<div class="modal-form-field">
				<label class="modal-field-label">Type<span class="required">*</span></label>
				<select class="modal-field-input" id="modal-field-type">
					<option value="">Select type...</option>
					${outputTypeOptions}
				</select>
				<span class="modal-field-hint">Data type for this output</span>
			</div>
			<div class="modal-form-field">
				<label class="modal-field-label">Path<span class="required">*</span></label>
				<input type="text" class="modal-field-input" id="modal-field-path" placeholder="e.g., results/output.csv" value="${defaultPath}" spellcheck="false" />
				<span class="modal-field-hint">Output file or directory path</span>
			</div>
			<div class="modal-form-field">
				<label class="modal-field-label">Description</label>
				<input type="text" class="modal-field-input" id="modal-field-description" placeholder="What this output contains" value="${
					existingData?.description || ''
				}" />
			</div>
			<details class="modal-advanced-section" ${existingData?.format ? 'open' : ''}>
				<summary>Advanced Options</summary>
				<div class="modal-advanced-content">
					<div class="modal-form-field">
						<label class="modal-field-label">Format</label>
						<select class="modal-field-input" id="modal-field-format">
							<option value="">Auto-detect</option>
							${formatOptions}
						</select>
						<span class="modal-field-hint">File format (optional)</span>
					</div>
				</div>
			</details>
		`
		// Auto-update path when name changes
		const nameInput = body.querySelector('#modal-field-name')
		const pathInput = body.querySelector('#modal-field-path')
		nameInput.addEventListener('input', () => {
			if (!existingData?.path || existingData.path === `results/${existingData.name}`) {
				pathInput.value = `results/${nameInput.value.trim()}`
			}
		})
	}

	overlay.style.display = 'flex'
	// Focus first input
	setTimeout(() => {
		const firstInput = body.querySelector('input')
		if (firstInput) firstInput.focus()
	}, 100)
}

function hideSpecModal() {
	const overlay = document.getElementById('spec-item-modal')
	overlay.style.display = 'none'
	modalState.isOpen = false
}

function getModalData() {
	const body = document.getElementById('spec-item-modal-body')
	const data = {
		name: body.querySelector('#modal-field-name')?.value.trim() || '',
		raw_type: body.querySelector('#modal-field-type')?.value.trim() || '',
		description: body.querySelector('#modal-field-description')?.value.trim() || '',
	}

	if (modalState.type === 'parameter') {
		data.default = body.querySelector('#modal-field-default')?.value.trim() || ''
		const choices = body.querySelector('#modal-field-choices')?.value.trim() || ''
		data.choices = choices
			? choices
					.split(',')
					.map((c) => c.trim())
					.filter(Boolean)
			: []
	} else if (modalState.type === 'input') {
		data.format = body.querySelector('#modal-field-format')?.value.trim() || ''
		data.path = body.querySelector('#modal-field-path')?.value.trim() || ''
	} else if (modalState.type === 'output') {
		data.format = body.querySelector('#modal-field-format')?.value.trim() || ''
		data.path = body.querySelector('#modal-field-path')?.value.trim() || ''
	}

	return data
}

// Create list item
function createListItem(entry, type, onEdit, onRemove) {
	const item = document.createElement('div')
	item.className = 'spec-list-item'
	item.dataset.entryId = entry.id

	const icons = { input: '📥', parameter: '⚙️', output: '📤' }
	const icon = icons[type] || '•'

	let detailsHTML = `<span class="spec-item-type">${entry.raw_type || '—'}</span>`

	if (entry.description) {
		detailsHTML += ` - ${entry.description}`
	}

	let metaHTML = ''
	const metaItems = []

	if (type === 'parameter') {
		if (entry.default)
			metaItems.push(
				`<span class="spec-item-meta-item"><strong>Default:</strong> ${entry.default}</span>`,
			)
		if (entry.choices && entry.choices.length > 0) {
			metaItems.push(
				`<span class="spec-item-meta-item"><strong>Choices:</strong> ${entry.choices.join(
					', ',
				)}</span>`,
			)
		}
	} else if (type === 'input') {
		if (entry.format)
			metaItems.push(
				`<span class="spec-item-meta-item"><strong>Format:</strong> ${entry.format}</span>`,
			)
		if (entry.path)
			metaItems.push(
				`<span class="spec-item-meta-item"><strong>Path:</strong> ${entry.path}</span>`,
			)
	} else if (type === 'output') {
		if (entry.path)
			metaItems.push(
				`<span class="spec-item-meta-item"><strong>Path:</strong> ${entry.path}</span>`,
			)
		if (entry.format)
			metaItems.push(
				`<span class="spec-item-meta-item"><strong>Format:</strong> ${entry.format}</span>`,
			)
	}

	if (metaItems.length > 0) {
		metaHTML = `<div class="spec-item-meta">${metaItems.join('')}</div>`
	}

	item.innerHTML = `
		<div class="spec-item-header">
			<div class="spec-item-title">
				<span class="spec-item-icon">${icon}</span>
				<span>${entry.name || '(unnamed)'}</span>
			</div>
			<div class="spec-item-actions">
				<button type="button" class="spec-item-edit" data-action="edit">Edit</button>
				<button type="button" class="spec-item-remove" data-action="remove">Remove</button>
			</div>
		</div>
		<div class="spec-item-details">${detailsHTML}</div>
		${metaHTML}
	`

	item.querySelector('[data-action="edit"]').addEventListener('click', () => onEdit(entry))
	item.querySelector('[data-action="remove"]').addEventListener('click', () => onRemove(entry.id))

	return item
}

// Main form creator
export function createModuleSpecForm({ container, invoke, onChange }) {
	invokeFunction = invoke // Store for type loading

	let state = {
		parameters: [],
		inputs: [],
		outputs: [],
	}

	let activeSection = 'parameters'
	let containerElement = container

	function notifyChange() {
		if (onChange) {
			const params = state.parameters.map((p) => ({
				name: p.name || '',
				raw_type: p.raw_type || '',
				description: p.description || null,
				default: p.default || null,
				choices: p.choices && p.choices.length > 0 ? p.choices : null,
				advanced: p.advanced || null,
			}))

			const inputs = state.inputs.map((i) => ({
				name: i.name || '',
				raw_type: i.raw_type || '',
				description: i.description || null,
				format: i.format || null,
				path: i.path || null,
				mapping: null,
			}))

			const outputs = state.outputs.map((o) => ({
				name: o.name || '',
				raw_type: o.raw_type || '',
				description: o.description || null,
				format: o.format || null,
				path: o.path || null,
			}))

			onChange(params, inputs, outputs)
		}
	}

	function addOrUpdateEntry(section, data, editingId = null) {
		if (editingId) {
			// Update existing
			const entry = state[section].find((e) => e.id === editingId)
			if (entry) {
				Object.assign(entry, data)
			}
		} else {
			// Add new
			const entry = {
				id: createId(section),
				...data,
			}
			state[section].push(entry)
		}
		render()
		notifyChange()
	}

	function removeEntry(section, id) {
		state[section] = state[section].filter((entry) => entry.id !== id)
		render()
		notifyChange()
	}

	function handleModalSubmit() {
		const data = getModalData()

		// Validate
		if (!data.name) {
			alert('Name is required')
			return
		}
		if (!data.raw_type) {
			alert('Type is required')
			return
		}

		const section =
			modalState.type === 'input'
				? 'inputs'
				: modalState.type === 'parameter'
					? 'parameters'
					: 'outputs'
		addOrUpdateEntry(section, data, modalState.editingId)
		hideSpecModal()
	}

	// Setup modal buttons (once)
	const setupModal = () => {
		const closeBtn = document.getElementById('spec-item-modal-close')
		const cancelBtn = document.getElementById('spec-item-modal-cancel')
		const submitBtn = document.getElementById('spec-item-modal-submit')

		if (closeBtn) closeBtn.onclick = hideSpecModal
		if (cancelBtn) cancelBtn.onclick = hideSpecModal
		if (submitBtn) submitBtn.onclick = handleModalSubmit

		// ESC to close
		document.addEventListener('keydown', (e) => {
			if (e.key === 'Escape' && modalState.isOpen) {
				hideSpecModal()
			}
		})
	}
	setupModal()

	function render() {
		if (!containerElement) return

		containerElement.innerHTML = ''

		const section = document.createElement('div')
		section.className = 'simple-spec-section'

		if (activeSection === 'parameters') {
			// List
			if (state.parameters.length > 0) {
				const list = document.createElement('div')
				list.className = 'simple-spec-list'
				state.parameters.forEach((entry) => {
					const item = createListItem(
						entry,
						'parameter',
						(e) => showSpecModal('parameter', 'edit', e),
						(id) => removeEntry('parameters', id),
					)
					list.appendChild(item)
				})
				section.appendChild(list)
			}

			// Add zone - always visible
			const addZone = document.createElement('div')
			addZone.className = 'spec-add-zone'
			addZone.innerHTML = `
				<div class="add-zone-icon">⚙️</div>
				<div class="add-zone-text">
					<strong>Add Parameter</strong>
					<p>Configuration settings like thresholds and toggles</p>
				</div>
			`
			addZone.addEventListener('click', () => showSpecModal('parameter', 'add'))
			section.appendChild(addZone)
		} else if (activeSection === 'inputs') {
			// List
			if (state.inputs.length > 0) {
				const list = document.createElement('div')
				list.className = 'simple-spec-list'
				state.inputs.forEach((entry) => {
					const item = createListItem(
						entry,
						'input',
						(e) => showSpecModal('input', 'edit', e),
						(id) => removeEntry('inputs', id),
					)
					list.appendChild(item)
				})
				section.appendChild(list)
			}

			// Add zone - always visible
			const addZone = document.createElement('div')
			addZone.className = 'spec-add-zone'
			addZone.innerHTML = `
				<div class="add-zone-icon">📥</div>
				<div class="add-zone-text">
					<strong>Add Input</strong>
					<p>Data files and directories to analyze</p>
				</div>
			`
			addZone.addEventListener('click', () => showSpecModal('input', 'add'))
			section.appendChild(addZone)
		} else if (activeSection === 'outputs') {
			// List
			if (state.outputs.length > 0) {
				const list = document.createElement('div')
				list.className = 'simple-spec-list'
				state.outputs.forEach((entry) => {
					const item = createListItem(
						entry,
						'output',
						(e) => showSpecModal('output', 'edit', e),
						(id) => removeEntry('outputs', id),
					)
					list.appendChild(item)
				})
				section.appendChild(list)
			}

			// Add zone - always visible
			const addZone = document.createElement('div')
			addZone.className = 'spec-add-zone'
			addZone.innerHTML = `
				<div class="add-zone-icon">📤</div>
				<div class="add-zone-text">
					<strong>Add Output</strong>
					<p>Files and directories this module creates</p>
				</div>
			`
			addZone.addEventListener('click', () => showSpecModal('output', 'add'))
			section.appendChild(addZone)
		}

		containerElement.appendChild(section)
	}

	return {
		mount: (newContainer) => {
			containerElement = newContainer
			render()
		},
		configureSections: (sections, defaultSection) => {
			if (sections && sections.length > 0) {
				activeSection = defaultSection || sections[0]
			}
			render()
		},
		setSpec: (spec) => {
			state = {
				parameters: (spec.parameters || []).map((p) => ({
					...p,
					id: createId('parameter'),
					choices: p.choices || [],
				})),
				inputs: (spec.inputs || []).map((i) => ({
					...i,
					id: createId('input'),
				})),
				outputs: (spec.outputs || []).map((o) => ({
					...o,
					id: createId('output'),
				})),
			}
			render()
		},
	}
}
