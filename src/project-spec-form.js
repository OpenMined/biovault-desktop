const TYPE_SUGGESTIONS = [
	'Bool',
	'String',
	'Enum[...]',
	'File',
	'Directory',
	'ParticipantSheet',
	'GenotypeRecord',
	'BiovaultContext',
	'List[String]',
	'List[File]',
	'List[ParticipantSheet]',
	'Map[String]',
]

let entryCounter = 0

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

function normaliseMapping(mappingText) {
	if (!mappingText) return null
	const lines = mappingText
		.split('\n')
		.map((line) => line.trim())
		.filter((line) => line.length)
	if (!lines.length) return null
	const result = {}
	lines.forEach((line) => {
		const [key, ...rest] = line.split('=')
		if (!key) return
		const value = rest.join('=').trim()
		result[key.trim()] = value
	})
	return Object.keys(result).length ? result : null
}

function renderTypeDatalist() {
	const datalist = document.createElement('datalist')
	datalist.id = 'spec-type-suggestions'
	TYPE_SUGGESTIONS.forEach((item) => {
		const option = document.createElement('option')
		option.value = item.trim()
		datalist.appendChild(option)
	})
	return datalist
}

function buildParameterEntry(entry, update) {
	const wrapper = document.createElement('div')
	wrapper.className = 'spec-entry'
	wrapper.dataset.entryId = entry.id
	wrapper.innerHTML = `
		<div class="spec-entry-header">
			<strong>Parameter</strong>
			<div class="spec-entry-actions">
				<button type="button" class="link-button" data-action="duplicate">Duplicate</button>
				<button type="button" class="link-button danger" data-action="remove">Remove</button>
			</div>
		</div>
		<div class="spec-entry-grid">
			<label>
				<span>Name</span>
				<input type="text" data-field="name" spellcheck="false" />
			</label>
			<label>
				<span>Type</span>
				<input type="text" list="spec-type-suggestions" data-field="raw_type" spellcheck="false" />
			</label>
			<label>
				<span>Default</span>
				<input type="text" data-field="default" spellcheck="false" />
			</label>
			<label>
				<span>Choices (comma separated)</span>
				<input type="text" data-field="choices" spellcheck="false" />
			</label>
			<label class="card-span2">
				<span>Description</span>
				<textarea data-field="description" rows="2"></textarea>
			</label>
			<label class="spec-entry-checkbox">
				<input type="checkbox" data-field="advanced" /> Hide from UI
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
	setField('input[data-field="raw_type"]', entry.raw_type)
	setField('textarea[data-field="description"]', entry.description)
	setField('input[data-field="default"]', entry.default)
	setField('input[data-field="choices"]', entry.choices?.join(', ') ?? '')
	setField('input[data-field="advanced"]', entry.advanced)

	wrapper.addEventListener('input', (event) => {
		const target = event.target
		const field = target.dataset.field
		if (!field) return
		if (field === 'advanced' && target.type === 'checkbox') {
			update(entry.id, { [field]: target.checked })
			return
		}
		update(entry.id, { [field]: target.value })
	})

	wrapper.querySelector('[data-action="remove"]').addEventListener('click', () => {
		update(entry.id, null)
	})

	wrapper.querySelector('[data-action="duplicate"]').addEventListener('click', () => {
		update(entry.id, { __duplicate: true })
	})

	return wrapper
}

function buildInputEntry(entry, update) {
	const wrapper = document.createElement('div')
	wrapper.className = 'spec-entry'
	wrapper.dataset.entryId = entry.id
	wrapper.innerHTML = `
		<div class="spec-entry-header">
			<strong>Input</strong>
			<div class="spec-entry-actions">
				<button type="button" class="link-button" data-action="duplicate">Duplicate</button>
				<button type="button" class="link-button danger" data-action="remove">Remove</button>
			</div>
		</div>
		<div class="spec-entry-grid">
			<label>
				<span>Name</span>
				<input type="text" data-field="name" spellcheck="false" />
			</label>
			<label>
				<span>Type</span>
				<input type="text" list="spec-type-suggestions" data-field="raw_type" spellcheck="false" />
			</label>
			<label>
				<span>Format</span>
				<input type="text" data-field="format" spellcheck="false" />
			</label>
			<label>
				<span>Path / Pattern</span>
				<input type="text" data-field="path" spellcheck="false" />
			</label>
			<label class="card-span2">
				<span>Description</span>
				<textarea data-field="description" rows="2"></textarea>
			</label>
			<label class="card-span2">
				<span>Mapping (key=value per line)</span>
				<textarea data-field="mapping" rows="2" spellcheck="false"></textarea>
			</label>
		</div>
	`

	const setField = (selector, value) => {
		const el = wrapper.querySelector(selector)
		if (!el) return
		el.value = value ?? ''
	}

	setField('input[data-field="name"]', entry.name)
	setField('input[data-field="raw_type"]', entry.raw_type)
	setField('input[data-field="format"]', entry.format)
	setField('input[data-field="path"]', entry.path)
	setField('textarea[data-field="description"]', entry.description)
	setField('textarea[data-field="mapping"]', entry.mappingText)

	wrapper.addEventListener('input', (event) => {
		const target = event.target
		const field = target.dataset.field
		if (!field) return
		update(entry.id, { [field]: target.value })
	})

	wrapper.querySelector('[data-action="remove"]').addEventListener('click', () => {
		update(entry.id, null)
	})

	wrapper.querySelector('[data-action="duplicate"]').addEventListener('click', () => {
		update(entry.id, { __duplicate: true })
	})

	return wrapper
}

function buildOutputEntry(entry, update) {
	const wrapper = document.createElement('div')
	wrapper.className = 'spec-entry'
	wrapper.dataset.entryId = entry.id
	wrapper.innerHTML = `
		<div class="spec-entry-header">
			<strong>Output</strong>
			<div class="spec-entry-actions">
				<button type="button" class="link-button" data-action="duplicate">Duplicate</button>
				<button type="button" class="link-button danger" data-action="remove">Remove</button>
			</div>
		</div>
		<div class="spec-entry-grid">
			<label>
				<span>Name</span>
				<input type="text" data-field="name" spellcheck="false" />
			</label>
			<label>
				<span>Type</span>
				<input type="text" list="spec-type-suggestions" data-field="raw_type" spellcheck="false" />
			</label>
			<label>
				<span>Format</span>
				<input type="text" data-field="format" spellcheck="false" />
			</label>
			<label>
				<span>Path</span>
				<input type="text" data-field="path" spellcheck="false" />
			</label>
			<label class="card-span2">
				<span>Description</span>
				<textarea data-field="description" rows="2"></textarea>
			</label>
		</div>
	`

	const setField = (selector, value) => {
		const el = wrapper.querySelector(selector)
		if (!el) return
		el.value = value ?? ''
	}

	setField('input[data-field="name"]', entry.name)
	setField('input[data-field="raw_type"]', entry.raw_type)
	setField('input[data-field="format"]', entry.format)
	setField('input[data-field="path"]', entry.path)
	setField('textarea[data-field="description"]', entry.description)

	wrapper.addEventListener('input', (event) => {
		const target = event.target
		const field = target.dataset.field
		if (!field) return
		update(entry.id, { [field]: target.value })
	})

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
			mapping: normaliseMapping(entry.mappingText),
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
		mappingText: typeof entry.mappingText === 'string' ? `${entry.mappingText}` : entry.mappingText,
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
				mappingText: '',
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

export function createProjectSpecForm({ container, onChange }) {
	if (!container) {
		throw new Error('Missing container for project spec form')
	}

	const state = {
		parameters: [],
		inputs: [],
		outputs: [],
		activeTab: 'parameters',
		visibleSections: ['parameters', 'inputs', 'outputs'],
	}

	if (!document.getElementById('spec-type-suggestions')) {
		document.body.appendChild(renderTypeDatalist())
	}

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
		addBtn.textContent = `Add ${key === 'inputs' ? 'Input' : key === 'outputs' ? 'Output' : 'Parameter'}`
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

	Object.entries(sectionElements).forEach(([key, section]) => {
		section.className = 'spec-section'
		section.dataset.section = key
		section.innerHTML = `
			<div class="spec-section-header">
				<h4>${key.charAt(0).toUpperCase() + key.slice(1)}</h4>
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
				buildParameterEntry(entry, (id, changes) => mutate('parameters', id, changes)),
			)
		})

		state.inputs.forEach((entry) => {
			inputBody.appendChild(buildInputEntry(entry, (id, changes) => mutate('inputs', id, changes)))
		})

		state.outputs.forEach((entry) => {
			outputBody.appendChild(
				buildOutputEntry(entry, (id, changes) => mutate('outputs', id, changes)),
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
	const safeName = name || 'Project'

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
