// Type registry - will be populated from CLI
let cachedInputTypeInfo = null
let cachedOutputTypeInfo = null
let cachedParameterTypes = null
let cachedCommonFormats = null

let entryCounter = 0

async function getInputTypeInfo(invoke) {
	if (!cachedInputTypeInfo && invoke) {
		try {
			cachedInputTypeInfo = await invoke('get_supported_input_types')
		} catch (error) {
			console.warn('Failed to load input types from CLI, using defaults:', error)
			cachedInputTypeInfo = {
				base_types: [
					'String',
					'Bool',
					'File',
					'Directory',
					'ParticipantSheet',
					'GenotypeRecord',
					'BiovaultContext',
				],
				common_types: ['File', 'Directory', 'String', 'List[File]'],
			}
		}
	}
	return cachedInputTypeInfo || { base_types: [], common_types: [] }
}

async function getOutputTypeInfo(invoke) {
	if (!cachedOutputTypeInfo && invoke) {
		try {
			cachedOutputTypeInfo = await invoke('get_supported_output_types')
		} catch (error) {
			console.warn('Failed to load output types from CLI, using defaults:', error)
			cachedOutputTypeInfo = {
				base_types: ['String', 'Bool', 'File', 'Directory', 'ParticipantSheet', 'GenotypeRecord'],
				common_types: ['File', 'Directory'],
			}
		}
	}
	return cachedOutputTypeInfo || { base_types: [], common_types: [] }
}

async function getParameterTypes(invoke) {
	if (!cachedParameterTypes && invoke) {
		try {
			cachedParameterTypes = await invoke('get_supported_parameter_types')
		} catch (error) {
			console.warn('Failed to load parameter types from CLI, using defaults:', error)
			cachedParameterTypes = ['String', 'Bool', 'Enum[...]']
		}
	}
	return cachedParameterTypes || []
}

async function getCommonFormats(invoke) {
	if (!cachedCommonFormats && invoke) {
		try {
			cachedCommonFormats = await invoke('get_common_formats')
		} catch (error) {
			console.warn('Failed to load formats from CLI, using defaults:', error)
			cachedCommonFormats = ['csv', 'tsv', 'txt', 'json', 'vcf', 'fasta']
		}
	}
	return cachedCommonFormats || []
}

// Get icon for type
function getTypeIcon(type) {
	if (type.includes('File') || type === 'File') return '📄'
	if (type.includes('Directory') || type === 'Directory') return '📁'
	if (type.includes('String') || type === 'String') return '📝'
	if (type.includes('List')) return '📋'
	return '•'
}

// Parse a type string into components
function parseTypeString(typeStr) {
	if (!typeStr) return { base: '', isList: false, isMap: false, isOptional: false }

	let working = typeStr.trim()
	const isOptional = working.endsWith('?')
	if (isOptional) working = working.slice(0, -1).trim()

	let isList = false
	let isMap = false
	let base = working

	if (working.startsWith('List[') && working.endsWith(']')) {
		isList = true
		base = working.slice(5, -1).trim()
	}

	if (base.startsWith('Map[String,') && base.endsWith(']')) {
		isMap = true
		// Extract value type from Map[String, Type]
		const inner = base.slice(11, -1).trim()
		base = inner.startsWith(',') ? inner.slice(1).trim() : inner
	}

	return { base, isList, isMap, isOptional }
}

// Build a type string from components
function buildTypeString(base, isList, isMap, isOptional) {
	if (!base) return ''

	let result = base
	if (isMap) result = `Map[String, ${result}]`
	if (isList) result = `List[${result}]`
	if (isOptional) result = `${result}?`

	return result
}

// Get base primitives (no List/Map/Optional)
function getBasePrimitives(types) {
	if (!types || types.length === 0) return []

	// Filter to only base primitives (no List, Map, or ?)
	return types.filter((t) => {
		return !t.includes('List[') && !t.includes('Map[') && !t.includes('?')
	})
}

// Type builder component with compositional UI
function createTypeBuilder(types, selectedValue, onChange) {
	const wrapper = document.createElement('div')
	wrapper.className = 'type-builder'

	const parsed = parseTypeString(selectedValue)
	const basePrimitives = getBasePrimitives(types)

	// Base type selector
	const baseSelect = document.createElement('select')
	baseSelect.className = 'type-builder-base'
	baseSelect.innerHTML = '<option value="">Select base type...</option>'
	basePrimitives.forEach((type) => {
		const option = document.createElement('option')
		option.value = type
		option.textContent = type
		if (type === parsed.base) option.selected = true
		baseSelect.appendChild(option)
	})

	// Collection type radios
	const collectionGroup = document.createElement('div')
	collectionGroup.className = 'type-builder-collection'
	collectionGroup.innerHTML = `
		<span class="modifier-label">Collection:</span>
		<label class="modifier-radio">
			<input type="radio" name="collection-${Date.now()}" value="single" ${
				!parsed.isList && !parsed.isMap ? 'checked' : ''
			} />
			Single value
		</label>
		<label class="modifier-radio">
			<input type="radio" name="collection-${Date.now()}" value="list" ${
				parsed.isList ? 'checked' : ''
			} />
			List (array)
		</label>
		<label class="modifier-radio">
			<input type="radio" name="collection-${Date.now()}" value="map" ${parsed.isMap ? 'checked' : ''} />
			Map (key-value)
		</label>
	`

	// Optional checkbox
	const optionalLabel = document.createElement('label')
	optionalLabel.className = 'modifier-checkbox'
	optionalLabel.innerHTML = `
		<input type="checkbox" class="mod-optional" ${parsed.isOptional ? 'checked' : ''} />
		Optional (can be null)
	`

	// Preview
	const preview = document.createElement('div')
	preview.className = 'type-builder-preview'

	const updatePreview = () => {
		const base = baseSelect.value
		const collectionRadio = wrapper.querySelector('input[type="radio"]:checked')
		const collection = collectionRadio ? collectionRadio.value : 'single'
		const optional = wrapper.querySelector('.mod-optional')?.checked || false

		const isList = collection === 'list'
		const isMap = collection === 'map'

		const result = buildTypeString(base, isList, isMap, optional)

		preview.innerHTML = result
			? `<span class="preview-label">Type:</span> <code class="type-preview-code">${result}</code>`
			: '<span class="preview-label">Select a base type</span>'

		if (result) onChange(result)
	}

	baseSelect.addEventListener('change', updatePreview)
	collectionGroup.addEventListener('change', updatePreview)
	optionalLabel.addEventListener('change', updatePreview)

	const baseLabel = document.createElement('label')
	baseLabel.innerHTML = '<span>Base Type</span>'
	baseLabel.appendChild(baseSelect)

	wrapper.appendChild(baseLabel)
	wrapper.appendChild(collectionGroup)
	wrapper.appendChild(optionalLabel)
	wrapper.appendChild(preview)

	updatePreview()

	return {
		wrapper,
		setValue: (val) => {
			const p = parseTypeString(val)
			baseSelect.value = p.base

			const radios = wrapper.querySelectorAll('input[type="radio"]')
			radios.forEach((r) => {
				if (r.value === 'list' && p.isList) r.checked = true
				else if (r.value === 'map' && p.isMap) r.checked = true
				else if (r.value === 'single' && !p.isList && !p.isMap) r.checked = true
			})

			const optCheck = wrapper.querySelector('.mod-optional')
			if (optCheck) optCheck.checked = p.isOptional

			updatePreview()
		},
	}
}

function createId(prefix) {
	entryCounter += 1
	return `${prefix}-${Date.now()}-${entryCounter}`
}

function coerceToString(value) {
	if (value === null || value === undefined) return ''
	if (typeof value === 'string') return value
	if (typeof value === 'number' || typeof value === 'boolean') {
		return String(value)
	}
	try {
		return JSON.stringify(value, null, 2)
	} catch (error) {
		console.warn('Failed to stringify default value', error)
		return ''
	}
}

function normaliseList(value) {
	if (!value) return []
	if (Array.isArray(value)) {
		return value.map((item) => String(item).trim()).filter((item) => item.length)
	}
	return String(value)
		.split(',')
		.map((item) => item.trim())
		.filter((item) => item.length)
}

// Removed normaliseMapping - mapping field is unused in practice

// No longer needed - using dropdowns instead of datalist

function buildParameterEntry(entry, update, parameterTypes = null) {
	const wrapper = document.createElement('div')
	wrapper.className = 'spec-entry spec-entry-compact'
	wrapper.dataset.entryId = entry.id

	wrapper.innerHTML = `
		<div class="spec-entry-header">
			<strong>Parameter</strong>
			<span class="entry-hint">Configuration setting</span>
			<div class="spec-entry-actions">
				<button type="button" class="link-button" data-action="duplicate">Duplicate</button>
				<button type="button" class="link-button danger" data-action="remove">Remove</button>
			</div>
		</div>
		<div class="spec-entry-grid">
			<label>
				<span>Name</span>
				<input type="text" data-field="name" placeholder="quality_threshold" spellcheck="false" />
			</label>
			<label>
				<span>Type</span>
				<select data-field="raw_type" class="parameter-type-select">
					<option value="">Select...</option>
					${parameterTypes ? parameterTypes.map((t) => `<option value="${t}">${t}</option>`).join('') : ''}
				</select>
			</label>
			<label>
				<span>Default Value</span>
				<input type="text" data-field="default" placeholder="30" spellcheck="false" />
			</label>
			<label class="card-span2 choices-field" style="display: none;">
				<span>Choices (for Enum - comma separated)</span>
				<input type="text" data-field="choices" placeholder="fast, normal, thorough" spellcheck="false" />
			</label>
			<label class="card-span2">
				<span>Description (optional)</span>
				<textarea data-field="description" rows="2" placeholder="Minimum quality score threshold"></textarea>
			</label>
		</div>
	`

	const setField = (selector, value) => {
		const el = wrapper.querySelector(selector)
		if (!el) return
		if (el.type === 'checkbox') {
			el.checked = Boolean(value)
		} else {
			el.value = value ?? ''
		}
	}

	setField('input[data-field="name"]', entry.name)
	setField('select[data-field="raw_type"]', entry.raw_type)
	setField('textarea[data-field="description"]', entry.description)
	setField('input[data-field="default"]', entry.default)
	setField('input[data-field="choices"]', entry.choices?.join(', ') ?? '')

	// Show/hide choices field based on type
	const typeSelect = wrapper.querySelector('select[data-field="raw_type"]')
	const choicesField = wrapper.querySelector('.choices-field')
	const updateChoicesVisibility = () => {
		if (typeSelect.value.startsWith('Enum')) {
			choicesField.style.display = 'block'
		} else {
			choicesField.style.display = 'none'
		}
	}
	typeSelect.addEventListener('change', updateChoicesVisibility)
	updateChoicesVisibility()

	const handleFieldChange = (event) => {
		const target = event.target
		const field = target.dataset.field
		if (!field) return
		if (field === 'advanced' && target.type === 'checkbox') {
			update(entry.id, { [field]: target.checked })
			return
		}
		update(entry.id, { [field]: target.value })
	}

	wrapper.addEventListener('input', handleFieldChange)
	wrapper.addEventListener('change', handleFieldChange)

	wrapper.querySelector('[data-action="remove"]').addEventListener('click', () => {
		update(entry.id, null)
	})

	wrapper.querySelector('[data-action="duplicate"]').addEventListener('click', () => {
		update(entry.id, { __duplicate: true })
	})

	return wrapper
}

function buildInputEntry(entry, update, typeInfo = null, formats = null) {
	const wrapper = document.createElement('div')
	wrapper.className = 'spec-entry'
	wrapper.dataset.entryId = entry.id

	const commonTypes = typeInfo?.common_types || []
	const formatOptions = formats
		? formats.map((f) => `<option value="${f}">${f}</option>`).join('')
		: ''

	wrapper.innerHTML = `
		<div class="spec-entry-header">
			<strong>Input</strong>
			<span class="entry-hint">Data file or directory to analyze</span>
			<div class="spec-entry-actions">
				<button type="button" class="link-button" data-action="duplicate">Duplicate</button>
				<button type="button" class="link-button danger" data-action="remove">Remove</button>
			</div>
		</div>
		<div class="spec-entry-grid">
			<label class="card-span2">
				<span>Name</span>
				<input type="text" data-field="name" placeholder="samplesheet" spellcheck="false" />
			</label>
			<label class="card-span2">
				<span>Type</span>
				<div class="type-quick-select">
					${commonTypes
						.map(
							(t) =>
								`<button type="button" class="type-quick-btn" data-type="${t}">${getTypeIcon(
									t,
								)} ${t}</button>`,
						)
						.join('')}
				</div>
				<input type="hidden" data-field="raw_type" value="${entry.raw_type || ''}" />
				<details class="type-advanced">
					<summary>Build Custom Type</summary>
					<div class="type-field-wrapper"></div>
				</details>
			</label>
			<label>
				<span>Format (optional)</span>
				<select data-field="format">
					<option value="">Auto-detect</option>
					${formatOptions}
				</select>
			</label>
			<label>
				<span>Path / Pattern (optional)</span>
				<input type="text" data-field="path" placeholder="data/*.csv" spellcheck="false" />
			</label>
			<label class="card-span2">
				<span>Description (optional)</span>
				<textarea data-field="description" rows="2" placeholder="CSV file with sample metadata"></textarea>
			</label>
		</div>
	`

	const setField = (selector, value) => {
		const el = wrapper.querySelector(selector)
		if (!el) return
		el.value = value ?? ''
	}

	setField('input[data-field="name"]', entry.name)
	setField('select[data-field="format"]', entry.format)
	setField('input[data-field="path"]', entry.path)
	setField('textarea[data-field="description"]', entry.description)
	setField('input[data-field="raw_type"]', entry.raw_type)

	// Quick-pick buttons
	const quickBtns = wrapper.querySelectorAll('.type-quick-btn')
	const typeHiddenInput = wrapper.querySelector('input[data-field="raw_type"]')
	const updateQuickBtnStates = () => {
		quickBtns.forEach((btn) => {
			if (btn.dataset.type === typeHiddenInput.value) {
				btn.classList.add('active')
			} else {
				btn.classList.remove('active')
			}
		})
	}

	quickBtns.forEach((btn) => {
		btn.addEventListener('click', () => {
			const selectedType = btn.dataset.type
			typeHiddenInput.value = selectedType
			update(entry.id, { raw_type: selectedType })
			updateQuickBtnStates()
		})
	})
	updateQuickBtnStates()

	// Advanced type builder
	const typeFieldWrapper = wrapper.querySelector('.type-field-wrapper')
	if (typeFieldWrapper && typeInfo) {
		const builder = createTypeBuilder(typeInfo.base_types, entry.raw_type, (value) => {
			typeHiddenInput.value = value
			update(entry.id, { raw_type: value })
			updateQuickBtnStates()
		})
		typeFieldWrapper.appendChild(builder.wrapper)
	}

	const handleFieldChange = (event) => {
		const target = event.target
		const field = target.dataset.field
		if (!field) return
		update(entry.id, { [field]: target.value })
	}

	wrapper.addEventListener('input', handleFieldChange)
	wrapper.addEventListener('change', handleFieldChange)

	wrapper.querySelector('[data-action="remove"]').addEventListener('click', () => {
		update(entry.id, null)
	})

	wrapper.querySelector('[data-action="duplicate"]').addEventListener('click', () => {
		update(entry.id, { __duplicate: true })
	})

	return wrapper
}

function buildOutputEntry(entry, update, typeInfo = null, formats = null) {
	const wrapper = document.createElement('div')
	wrapper.className = 'spec-entry'
	wrapper.dataset.entryId = entry.id

	const commonTypes = typeInfo?.common_types || []
	const formatOptions = formats
		? formats.map((f) => `<option value="${f}">${f}</option>`).join('')
		: ''

	wrapper.innerHTML = `
		<div class="spec-entry-header">
			<strong>Output</strong>
			<span class="entry-hint">File or directory this module creates</span>
			<div class="spec-entry-actions">
				<button type="button" class="link-button" data-action="duplicate">Duplicate</button>
				<button type="button" class="link-button danger" data-action="remove">Remove</button>
			</div>
		</div>
		<div class="spec-entry-grid">
			<label class="card-span2">
				<span>Name</span>
				<input type="text" data-field="name" placeholder="results" spellcheck="false" />
			</label>
			<label class="card-span2">
				<span>Type</span>
				<div class="type-quick-select">
					${commonTypes
						.map(
							(t) =>
								`<button type="button" class="type-quick-btn" data-type="${t}">${getTypeIcon(
									t,
								)} ${t}</button>`,
						)
						.join('')}
				</div>
				<input type="hidden" data-field="raw_type" value="${entry.raw_type || ''}" />
				<details class="type-advanced">
					<summary>Build Custom Type</summary>
					<div class="type-field-wrapper"></div>
				</details>
			</label>
			<label>
				<span>Format (optional)</span>
				<select data-field="format">
					<option value="">Auto-detect</option>
					${formatOptions}
				</select>
			</label>
			<label>
				<span>Path</span>
				<input type="text" data-field="path" placeholder="results.csv" spellcheck="false" />
			</label>
			<label class="card-span2">
				<span>Description (optional)</span>
				<textarea data-field="description" rows="2" placeholder="Analysis results with quality metrics"></textarea>
			</label>
		</div>
	`

	const setField = (selector, value) => {
		const el = wrapper.querySelector(selector)
		if (!el) return
		el.value = value ?? ''
	}

	setField('input[data-field="name"]', entry.name)
	setField('select[data-field="format"]', entry.format)
	setField('input[data-field="path"]', entry.path)
	setField('textarea[data-field="description"]', entry.description)
	setField('input[data-field="raw_type"]', entry.raw_type)

	// Quick-pick buttons
	const quickBtns = wrapper.querySelectorAll('.type-quick-btn')
	const typeHiddenInput = wrapper.querySelector('input[data-field="raw_type"]')
	const updateQuickBtnStates = () => {
		quickBtns.forEach((btn) => {
			if (btn.dataset.type === typeHiddenInput.value) {
				btn.classList.add('active')
			} else {
				btn.classList.remove('active')
			}
		})
	}

	quickBtns.forEach((btn) => {
		btn.addEventListener('click', () => {
			const selectedType = btn.dataset.type
			typeHiddenInput.value = selectedType
			update(entry.id, { raw_type: selectedType })
			updateQuickBtnStates()
		})
	})
	updateQuickBtnStates()

	// Advanced type builder
	const typeFieldWrapper = wrapper.querySelector('.type-field-wrapper')
	if (typeFieldWrapper && typeInfo) {
		const builder = createTypeBuilder(typeInfo.base_types, entry.raw_type, (value) => {
			typeHiddenInput.value = value
			update(entry.id, { raw_type: value })
			updateQuickBtnStates()
		})
		typeFieldWrapper.appendChild(builder.wrapper)
	}

	const handleFieldChange = (event) => {
		const target = event.target
		const field = target.dataset.field
		if (!field) return
		update(entry.id, { [field]: target.value })
	}

	wrapper.addEventListener('input', handleFieldChange)
	wrapper.addEventListener('change', handleFieldChange)

	wrapper.querySelector('[data-action="remove"]').addEventListener('click', () => {
		update(entry.id, null)
	})

	wrapper.querySelector('[data-action="duplicate"]').addEventListener('click', () => {
		update(entry.id, { __duplicate: true })
	})

	return wrapper
}

function serialiseParameters(entries) {
	return entries
		.map((entry) => ({
			name: entry.name.trim(),
			raw_type: entry.raw_type.trim(),
			description: entry.description?.trim() || null,
			default: entry.default?.trim() || null,
			choices: normaliseList(entry.choices),
			advanced: Boolean(entry.advanced),
		}))
		.filter((entry) => entry.name.length)
}

function serialiseInputs(entries) {
	return entries
		.map((entry) => ({
			name: entry.name.trim(),
			raw_type: entry.raw_type.trim(),
			description: entry.description?.trim() || null,
			format: entry.format?.trim() || null,
			path: entry.path?.trim() || null,
		}))
		.filter((entry) => entry.name.length)
}

function serialiseOutputs(entries) {
	return entries
		.map((entry) => ({
			name: entry.name.trim(),
			raw_type: entry.raw_type.trim(),
			description: entry.description?.trim() || null,
			format: entry.format?.trim() || null,
			path: entry.path?.trim() || null,
		}))
		.filter((entry) => entry.name.length)
}

function duplicateEntry(entry) {
	return {
		...entry,
		id: createId('entry'),
		choices: Array.isArray(entry.choices) ? [...entry.choices] : entry.choices,
	}
}

function createEmptyEntry(kind) {
	switch (kind) {
		case 'parameters':
			return {
				id: createId('parameter'),
				name: '',
				raw_type: '',
				description: '',
				default: '',
				choices: [],
				advanced: false,
			}
		case 'inputs':
			return {
				id: createId('input'),
				name: '',
				raw_type: '',
				description: '',
				format: '',
				path: '',
			}
		case 'outputs':
			return {
				id: createId('output'),
				name: '',
				raw_type: '',
				description: '',
				format: '',
				path: '',
			}
		default:
			return null
	}
}

export function createModuleSpecForm({ container, onChange, invoke }) {
	if (!container) {
		throw new Error('Missing container for module spec form')
	}

	const state = {
		parameters: [],
		inputs: [],
		outputs: [],
		activeTab: 'parameters',
		visibleSections: ['parameters', 'inputs', 'outputs'],
		inputTypeInfo: null,
		outputTypeInfo: null,
		parameterTypes: null,
		formats: null,
		typesLoaded: false,
	}

	// Load types and formats from CLI on initialization
	if (invoke) {
		Promise.all([
			getInputTypeInfo(invoke),
			getOutputTypeInfo(invoke),
			getParameterTypes(invoke),
			getCommonFormats(invoke),
		])
			.then(([inputTypeInfo, outputTypeInfo, parameterTypes, formats]) => {
				state.inputTypeInfo = inputTypeInfo
				state.outputTypeInfo = outputTypeInfo
				state.parameterTypes = parameterTypes
				state.formats = formats
				state.typesLoaded = true
				// Re-render to update UI with actual types
				render()
			})
			.catch((error) => {
				console.error('Failed to load types from CLI:', error)
				state.typesLoaded = true
			})
	}

	// No longer need datalist since we're using dropdowns

	container.innerHTML = ''
	const layout = document.createElement('div')
	layout.className = 'spec-editor'

	const tabs = [
		{ key: 'parameters', label: 'Parameters', action: 'add-parameter' },
		{ key: 'inputs', label: 'Inputs', action: 'add-input' },
		{ key: 'outputs', label: 'Outputs', action: 'add-output' },
	]

	const nav = document.createElement('aside')
	nav.className = 'spec-editor-nav'
	const navList = document.createElement('ul')
	navList.className = 'spec-editor-tabs'
	const navButtons = new Map()
	const navCounts = new Map()
	const navItems = new Map()

	tabs.forEach(({ key, label }) => {
		const li = document.createElement('li')
		const button = document.createElement('button')
		button.type = 'button'
		button.dataset.tab = key
		button.className = 'spec-editor-tab'
		button.innerHTML = `
			<span class="spec-tab-label">${label}</span>
			<span class="spec-tab-count">0</span>
		`
		navButtons.set(key, button)
		navCounts.set(key, button.querySelector('.spec-tab-count'))
		navItems.set(key, li)
		li.appendChild(button)
		navList.appendChild(li)
	})

	const navActions = document.createElement('div')
	navActions.className = 'spec-editor-nav-actions'
	const addButtons = new Map()
	tabs.forEach(({ key, action }) => {
		const addBtn = document.createElement('button')
		addBtn.type = 'button'
		addBtn.dataset.action = action
		addBtn.dataset.tab = key
		addBtn.className = 'secondary-btn spec-add-btn'
		addBtn.textContent = `Add ${
			key === 'inputs' ? 'Input' : key === 'outputs' ? 'Output' : 'Parameter'
		}`
		navActions.appendChild(addBtn)
		addButtons.set(key, addBtn)
	})

	nav.appendChild(navList)

	const navFooter = document.createElement('div')
	navFooter.className = 'spec-editor-nav-footer'
	navFooter.appendChild(navActions)
	nav.appendChild(navFooter)

	const content = document.createElement('div')
	content.className = 'spec-editor-content'

	const sectionElements = {
		parameters: document.createElement('section'),
		inputs: document.createElement('section'),
		outputs: document.createElement('section'),
	}

	const sectionDescriptions = {
		parameters: 'Configuration settings like thresholds, toggles, and options',
		inputs: 'Data files and directories to analyze',
		outputs: 'Files and directories this module creates',
	}

	Object.entries(sectionElements).forEach(([key, section]) => {
		section.className = 'spec-section'
		section.dataset.section = key
		section.innerHTML = `
			<div class="spec-section-header">
				<h4>${key.charAt(0).toUpperCase() + key.slice(1)}</h4>
				<p class="section-description">${sectionDescriptions[key]}</p>
			</div>
			<div class="spec-section-body" data-target="${key}"></div>
		`
		content.appendChild(section)
	})

	layout.appendChild(nav)
	layout.appendChild(content)
	container.appendChild(layout)

	const notify = () => {
		if (typeof onChange === 'function') {
			onChange(
				serialiseParameters(state.parameters),
				serialiseInputs(state.inputs),
				serialiseOutputs(state.outputs),
			)
		}
	}

	const mutate = (kind, id, changes) => {
		const list = state[kind]
		const index = list.findIndex((entry) => entry.id === id)
		if (index === -1) return

		let requiresRender = false
		if (changes === null) {
			list.splice(index, 1)
			requiresRender = true
		} else if (changes.__duplicate) {
			const duplicate = duplicateEntry(list[index])
			duplicate.id = createId(kind.slice(0, -1))
			list.splice(index + 1, 0, duplicate)
			requiresRender = true
		} else {
			list[index] = {
				...list[index],
				...changes,
			}
		}
		if (requiresRender) render()
		notify()
	}

	const updateNavCounts = () => {
		navCounts.get('parameters').textContent = state.parameters.length.toString()
		navCounts.get('inputs').textContent = state.inputs.length.toString()
		navCounts.get('outputs').textContent = state.outputs.length.toString()
	}

	const applyActiveTab = () => {
		const visible = new Set(state.visibleSections)
		Object.entries(sectionElements).forEach(([key, section]) => {
			const isVisible = visible.has(key)
			const isActive = isVisible && key === state.activeTab
			section.classList.toggle('active', isActive)
			if (!isVisible) {
				section.classList.remove('active')
			}
		})
		navButtons.forEach((button, key) => {
			const isVisible = state.visibleSections.includes(key)
			button.classList.toggle('active', isVisible && key === state.activeTab)
			navItems.get(key).style.display = isVisible ? '' : 'none'
		})
		addButtons.forEach((button, key) => {
			const isVisible = state.visibleSections.includes(key)
			button.style.display = isVisible && key === state.activeTab ? 'inline-flex' : 'none'
		})
	}

	const setActiveTab = (tab) => {
		const nextTab = state.visibleSections.includes(tab)
			? tab
			: state.visibleSections[0] || 'parameters'
		state.activeTab = nextTab
		applyActiveTab()
	}

	const configureSections = (
		sections = ['parameters', 'inputs', 'outputs'],
		defaultTab = sections[0] || 'parameters',
	) => {
		const desired = sections.length ? sections : ['parameters', 'inputs', 'outputs']
		state.visibleSections = desired
		state.activeTab = desired.includes(defaultTab) ? defaultTab : desired[0] || 'parameters'
		layout.classList.toggle('spec-editor-single', desired.length <= 1)
		applyActiveTab()
	}

	const mount = (target) => {
		if (!target) return
		if (layout.parentElement !== target) {
			target.innerHTML = ''
			target.appendChild(layout)
		}
	}

	const render = () => {
		const paramBody = sectionElements.parameters.querySelector('[data-target="parameters"]')
		const inputBody = sectionElements.inputs.querySelector('[data-target="inputs"]')
		const outputBody = sectionElements.outputs.querySelector('[data-target="outputs"]')

		paramBody.innerHTML = ''
		inputBody.innerHTML = ''
		outputBody.innerHTML = ''

		state.parameters.forEach((entry) => {
			paramBody.appendChild(
				buildParameterEntry(
					entry,
					(id, changes) => mutate('parameters', id, changes),
					state.parameterTypes,
				),
			)
		})

		state.inputs.forEach((entry) => {
			inputBody.appendChild(
				buildInputEntry(
					entry,
					(id, changes) => mutate('inputs', id, changes),
					state.inputTypeInfo,
					state.formats,
				),
			)
		})

		state.outputs.forEach((entry) => {
			outputBody.appendChild(
				buildOutputEntry(
					entry,
					(id, changes) => mutate('outputs', id, changes),
					state.outputTypeInfo,
					state.formats,
				),
			)
		})

		updateNavCounts()
		applyActiveTab()
	}

	const addEntry = (kind) => {
		const entry = createEmptyEntry(kind)
		if (!entry) return
		state[kind].push(entry)
		setActiveTab(kind)
		render()
		notify()
	}

	layout.addEventListener('click', (event) => {
		const action = event.target.closest('button')?.dataset?.action
		if (!action) return
		switch (action) {
			case 'add-parameter':
				addEntry('parameters')
				break
			case 'add-input':
				addEntry('inputs')
				break
			case 'add-output':
				addEntry('outputs')
				break
			default:
				return
		}
	})

	const api = {
		setSpec(spec) {
			const safeSpec = spec || {}
			state.parameters = (safeSpec.parameters || []).map((param) => ({
				id: createId('parameter'),
				name: param.name || '',
				raw_type: param.raw_type || '',
				description: param.description || '',
				default: coerceToString(param.default),
				choices: Array.isArray(param.choices) ? param.choices : [],
				advanced: Boolean(param.advanced),
			}))

			state.inputs = (safeSpec.inputs || []).map((input) => ({
				id: createId('input'),
				name: input.name || '',
				raw_type: input.raw_type || '',
				description: input.description || '',
				format: input.format || '',
				path: input.path || '',
				mappingText: input.mapping
					? Object.entries(input.mapping)
							.map(([key, value]) => `${key}=${value}`)
							.join('\n')
					: '',
			}))

			state.outputs = (safeSpec.outputs || []).map((output) => ({
				id: createId('output'),
				name: output.name || '',
				raw_type: output.raw_type || '',
				description: output.description || '',
				format: output.format || '',
				path: output.path || '',
			}))

			render()
			notify()
			setActiveTab(state.activeTab || 'parameters')
		},
		getSpec() {
			return {
				parameters: serialiseParameters(state.parameters),
				inputs: serialiseInputs(state.inputs),
				outputs: serialiseOutputs(state.outputs),
			}
		},
		destroy() {
			container.innerHTML = ''
		},
		configureSections,
		mount,
		addEntry,
	}

	navButtons.forEach((button, key) => {
		button.addEventListener('click', () => setActiveTab(key))
	})

	configureSections(['parameters', 'inputs', 'outputs'], 'parameters')
	render()

	return api
}

export function generateContractAscii({ name, parameters, inputs, outputs }) {
	const width = 60
	const safeName = name || 'Module'

	const visualWidth = (text) => {
		if (!text) return 0
		return [...text].reduce((sum, char) => {
			const code = char.codePointAt(0) ?? 0
			return sum + (code > 0x1f300 ? 2 : 1)
		}, 0)
	}

	const lines = []
	const addLine = (content = '') => {
		const trimmed = content ?? ''
		const pad = width - 2 - visualWidth(trimmed)
		lines.push(`│${trimmed}${' '.repeat(Math.max(0, pad))}│`)
	}

	lines.push(`┌${'─'.repeat(width - 2)}┐`)
	const nameWidth = visualWidth(safeName)
	const namePad = width - 2 - nameWidth
	const leftPad = Math.floor(namePad / 2)
	const rightPad = namePad - leftPad
	lines.push(`│${' '.repeat(Math.max(0, leftPad))}${safeName}${' '.repeat(Math.max(0, rightPad))}│`)
	lines.push(`├${'─'.repeat(width - 2)}┤`)

	if (inputs && inputs.length) {
		addLine(` 📥 Inputs (${inputs.length})`)
		inputs.forEach((input) => {
			const label = `   • ${input.name}: ${input.raw_type}`
			addLine(label)
		})
	} else {
		addLine(' 📥 Inputs: none')
	}

	addLine()

	if (outputs && outputs.length) {
		addLine(` 📤 Outputs (${outputs.length})`)
		outputs.forEach((output) => {
			const label = `   • ${output.name}: ${output.raw_type}`
			addLine(label)
		})
	} else {
		addLine(' 📤 Outputs: none')
	}

	if (parameters && parameters.length) {
		addLine()
		addLine(` ⚙️  Parameters (${parameters.length})`)
		parameters.forEach((param) => {
			const label = `   • ${param.name}: ${param.raw_type}`
			addLine(label)
		})
	}

	lines.push(`└${'─'.repeat(width - 2)}┘`)

	return lines.join('\n')
}
