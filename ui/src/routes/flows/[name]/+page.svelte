<script lang="ts">
	import { page } from '$app/stores'
	import { goto } from '$app/navigation'
	import { invoke } from '@tauri-apps/api/core'
	import { onMount } from 'svelte'
	import { Button } from '$lib/components/ui/button/index.js'
	import * as Card from '$lib/components/ui/card/index.js'
	import * as Dialog from '$lib/components/ui/dialog/index.js'
	import { Badge } from '$lib/components/ui/badge/index.js'
	import { Input } from '$lib/components/ui/input/index.js'
	import { Textarea } from '$lib/components/ui/textarea/index.js'
	import { Checkbox } from '$lib/components/ui/checkbox/index.js'
	import { Switch } from '$lib/components/ui/switch/index.js'
	import { Select } from '$lib/components/ui/select/index.js'
	import {
		parseFlowType,
		serializeFlowType,
		friendlyFlowType,
		unwrapOptional,
		type FlowTypeNode,
	} from '$lib/flows/type-parser'
	import RunFlowDialog from '$lib/components/run-flow-dialog.svelte'
	import ArrowLeftIcon from '@lucide/svelte/icons/arrow-left'
	import PlayIcon from '@lucide/svelte/icons/play'
	import FolderOpenIcon from '@lucide/svelte/icons/folder-open'
	import SaveIcon from '@lucide/svelte/icons/save'
	import CheckCircleIcon from '@lucide/svelte/icons/check-circle'
	import AlertTriangleIcon from '@lucide/svelte/icons/triangle-alert'
	import LoaderIcon from '@lucide/svelte/icons/loader'
	import PlusIcon from '@lucide/svelte/icons/plus'
	import TrashIcon from '@lucide/svelte/icons/trash-2'
	import RefreshCwIcon from '@lucide/svelte/icons/refresh-cw'
	import ClockIcon from '@lucide/svelte/icons/clock'
	import XCircleIcon from '@lucide/svelte/icons/x-circle'

	interface Pipeline {
		id: number
		name: string
		flow_path: string
		created_at?: string
	}

	interface PipelineRun {
		id: number
		pipeline_id: number
		pipeline_name: string
		status: string
		work_dir: string
		results_dir?: string
		created_at: string
	}

	type FlowInputSpec = string | { type?: string; default?: string | null }
	interface EditableField {
		name: string
		type: string
		optional: boolean
	}
	type BuilderKind = 'single' | 'list' | 'record' | 'listRecord' | 'map'
	interface TypeBuilderModel {
		kind: BuilderKind
		optional: boolean
		singleType: string
		listItemType: string
		mapKeyType: string
		mapValueType: string
		fields: EditableField[]
	}
	interface TypeOption {
		id: string
		label: string
		expr: string
		isCustom: boolean
		source?: 'user' | 'imported'
	}
	interface CustomEditorTarget {
		kind: 'single' | 'list' | 'mapKey' | 'mapValue' | 'field'
		fieldIndex?: number
	}

	interface FlowStepSpec {
		id: string
		uses?: string
		with?: Record<string, unknown>
		publish?: Record<string, string>
		share?: Record<string, unknown>
		barrier?: Record<string, unknown>
	}

	interface FlowSpec {
		name: string
		description?: string | null
		multiparty?: boolean | null
		vars?: Record<string, string>
		inputs: Record<string, FlowInputSpec>
		steps: FlowStepSpec[]
		datasites: string[]
	}

	interface ModuleInfo {
		id: number
		name: string
		path: string
		inputs?: ModulePortInfo[]
		outputs?: ModulePortInfo[]
	}

	interface ModulePortInfo {
		name: string
		raw_type?: string
		path?: string | null
		description?: string | null
		required?: boolean
	}

	interface FlowEditorPayload {
		flow_id?: number
		flow_path: string
		spec?: FlowSpec | null
		raw_yaml?: string | null
		modules: ModuleInfo[]
	}

	interface FlowValidationResult {
		valid: boolean
		errors: string[]
		warnings: string[]
		diagram: string
	}
	interface GuidedIssue {
		level: 'error' | 'warning'
		message: string
		section: Section | 'global'
		stepIndex?: number
	}
	interface DatasiteTemplate {
		id: string
		label: string
		description: string
		values: string[]
	}

	type EditorMode = 'guided' | 'yaml'
	type Section = 'overview' | 'inputs' | 'steps' | 'datasites' | 'advanced' | 'runs'

	const sections: Array<{ id: Section; label: string }> = [
		{ id: 'overview', label: 'Overview' },
		{ id: 'inputs', label: 'Inputs' },
		{ id: 'steps', label: 'Steps' },
		{ id: 'datasites', label: 'Datasites' },
		{ id: 'advanced', label: 'Advanced' },
		{ id: 'runs', label: 'Runs' },
	]

	let flowName = $derived($page.params.name)
	let loading = $state(true)
	let error = $state<string | null>(null)
	let mode = $state<EditorMode>('guided')
	let section = $state<Section>('overview')
	let selectedStepIndex = $state(0)
	let runDialogOpen = $state(false)

	let currentFlow = $state<Pipeline | null>(null)
	let editorPayload = $state<FlowEditorPayload | null>(null)
	let editorSpec = $state<FlowSpec | null>(null)
	let yamlText = $state('')
	let initialYaml = $state('')
	let guidedDirty = $state(false)
	let saving = $state(false)
	let validating = $state(false)
	let validation = $state<FlowValidationResult | null>(null)
	let guidedIssues = $derived(getGuidedIssues(editorSpec))

	let runs = $state<PipelineRun[]>([])
	let refreshingRuns = $state(false)
	let wizardBindingKey = $state('')
	let wizardBindingValue = $state('')
	let wizardOutputKey = $state('')
	let wizardOutputValue = $state('')
	let inputEditorOpen = $state(false)
	let editingInputOriginalName = $state('')
	let editingInputName = $state('')
	let editingInputDefault = $state('')
	let editingTypeRaw = $state('File')
	let editingBuilder = $state<TypeBuilderModel | null>(null)
	let editingUseRaw = $state(false)
	let customTypes = $state<TypeOption[]>([])
	let customTypeEditorOpen = $state(false)
	let customTypeName = $state('')
	let customTypeRaw = $state('String')
	let customTypeBuilder = $state<TypeBuilderModel | null>(null)
	let customTypeUseRaw = $state(false)
	let customTypeError = $state<string | null>(null)
	let customEditorTarget = $state<CustomEditorTarget | null>(null)
	const NEW_CUSTOM_TYPE_VALUE = '__new_custom_type__'
	const BUILT_IN_TYPES: TypeOption[] = [
		{ id: 'file', label: 'File', expr: 'File', isCustom: false },
		{ id: 'directory', label: 'Directory', expr: 'Directory', isCustom: false },
		{ id: 'string', label: 'String', expr: 'String', isCustom: false },
		{ id: 'bool', label: 'Bool', expr: 'Bool', isCustom: false },
		{ id: 'integer', label: 'Integer', expr: 'Integer', isCustom: false },
		{ id: 'float', label: 'Float', expr: 'Float', isCustom: false },
		{ id: 'genotype-record', label: 'GenotypeRecord', expr: 'GenotypeRecord', isCustom: false },
	]
	const DATASITE_TEMPLATES: DatasiteTemplate[] = [
		{
			id: 'two-party',
			label: '2-Party',
			description: 'One coordinator and one participant',
			values: ['coordinator@sandbox.local', 'participant@sandbox.local'],
		},
		{
			id: 'three-party',
			label: '3-Party',
			description: 'One coordinator and two participants',
			values: ['coordinator@sandbox.local', 'participant1@sandbox.local', 'participant2@sandbox.local'],
		},
		{
			id: 'n-party',
			label: '5-Party',
			description: 'One coordinator and four participants',
			values: [
				'coordinator@sandbox.local',
				'participant1@sandbox.local',
				'participant2@sandbox.local',
				'participant3@sandbox.local',
				'participant4@sandbox.local',
			],
		},
	]

	function clone<T>(value: T): T {
		return JSON.parse(JSON.stringify(value)) as T
	}

	function slugifyTypeId(value: string): string {
		const slug = value
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, '-')
			.replace(/^-+|-+$/g, '')
		return slug || 'custom-type'
	}

	function canonicalBuiltInType(token: string): string {
		const trimmed = token.trim()
		if (!trimmed) return trimmed
		const match = BUILT_IN_TYPES.find((item) => item.expr.toLowerCase() === trimmed.toLowerCase())
		return match ? match.expr : trimmed
	}

	function typeOptions(): TypeOption[] {
		return [...BUILT_IN_TYPES, ...customTypes]
	}

	function builtInTypeOptions(): TypeOption[] {
		return BUILT_IN_TYPES
	}

	function userCustomTypeOptions(): TypeOption[] {
		return customTypes.filter((item) => item.source !== 'imported')
	}

	function importedTypeOptions(): TypeOption[] {
		return customTypes.filter((item) => item.source === 'imported')
	}

	function ensureTypeInRegistry(expr: string, source: 'user' | 'imported' = 'imported') {
		const trimmed = canonicalBuiltInType(expr)
		if (!trimmed) return
		if (BUILT_IN_TYPES.some((item) => item.expr.toLowerCase() === trimmed.toLowerCase())) return
		if (customTypes.some((item) => item.expr.toLowerCase() === trimmed.toLowerCase())) return
		const nextId = `${source}-${slugifyTypeId(trimmed)}-${customTypes.length + 1}`
		const nextLabel =
			trimmed.length > 42 ? `${trimmed.slice(0, 39)}...` : trimmed
		customTypes = [
			...customTypes,
			{ id: nextId, label: nextLabel, expr: trimmed, isCustom: true, source },
		]
	}

	function registerBuilderTypes(builder: TypeBuilderModel | null) {
		if (!builder) return
		if (builder.kind === 'single') ensureTypeInRegistry(builder.singleType)
		if (builder.kind === 'list') ensureTypeInRegistry(builder.listItemType)
		if (builder.kind === 'map') {
			ensureTypeInRegistry(builder.mapKeyType)
			ensureTypeInRegistry(builder.mapValueType)
		}
		if (builder.kind === 'record' || builder.kind === 'listRecord') {
			for (const field of builder.fields) ensureTypeInRegistry(field.type)
		}
	}

	function collectTypeTokens(node: FlowTypeNode, out: Set<string>) {
		if (node.kind === 'named') {
			out.add(node.name)
			return
		}
		if (node.kind === 'optional') {
			collectTypeTokens(node.inner, out)
			return
		}
		if (node.kind === 'list') {
			collectTypeTokens(node.item, out)
			return
		}
		if (node.kind === 'map') {
			collectTypeTokens(node.key, out)
			collectTypeTokens(node.value, out)
			return
		}
		if (node.kind === 'record') {
			for (const field of node.fields) collectTypeTokens(field.type, out)
		}
	}

	function importTypesFromFlowSpec(spec: FlowSpec | null) {
		if (!spec) return
		for (const input of Object.values(spec.inputs ?? {})) {
			const parsed = parseInputSpec(input)
			const parseResult = parseFlowType(parsed.type)
			if (!parseResult.node) continue
			const tokens = new Set<string>()
			collectTypeTokens(parseResult.node, tokens)
			for (const token of tokens) ensureTypeInRegistry(token, 'imported')
		}
	}

	function defaultSpec(name: string): FlowSpec {
		return {
			name,
			description: '',
			multiparty: false,
			vars: {},
			inputs: {},
			steps: [],
			datasites: [],
		}
	}

	function normalizeSpec(spec: FlowSpec | null | undefined, name: string): FlowSpec {
		if (!spec) return defaultSpec(name)
		return {
			name: spec.name || name,
			description: spec.description ?? '',
			multiparty: spec.multiparty ?? false,
			vars: spec.vars ?? {},
			inputs: spec.inputs ?? {},
			steps: spec.steps ?? [],
			datasites: spec.datasites ?? [],
		}
	}

	function setSpec(mutator: (draft: FlowSpec) => void) {
		if (!editorSpec) return
		const next = clone(editorSpec)
		mutator(next)
		editorSpec = next
		guidedDirty = true
	}

	function parseInputSpec(value: FlowInputSpec): { type: string; defaultValue: string } {
		if (typeof value === 'string') {
			return { type: value, defaultValue: '' }
		}
		return {
			type: value.type ?? '',
			defaultValue: value.default == null ? '' : String(value.default),
		}
	}

	function buildInputSpec(type: string, defaultValue: string): FlowInputSpec {
		const t = type.trim()
		const d = defaultValue.trim()
		if (!d) return t
		return { type: t, default: d }
	}

	function makeInputName(existing: Record<string, FlowInputSpec>) {
		let idx = 1
		let candidate = `input_${idx}`
		while (candidate in existing) {
			idx += 1
			candidate = `input_${idx}`
		}
		return candidate
	}

	function renameInput(oldName: string, newName: string) {
		const clean = newName.trim()
		if (!clean || clean === oldName || !editorSpec) return
		if (editorSpec.inputs[clean] !== undefined) return
		setSpec((draft) => {
			const value = draft.inputs[oldName]
			delete draft.inputs[oldName]
			draft.inputs[clean] = value
		})
	}

	function removeInput(name: string) {
		setSpec((draft) => {
			delete draft.inputs[name]
		})
	}

	function openInputEditor(name: string, value: FlowInputSpec) {
		const parsed = parseInputSpec(value)
		editingInputOriginalName = name
		editingInputName = name
		editingInputDefault = parsed.defaultValue
		editingTypeRaw = parsed.type
		ensureTypeInRegistry(parsed.type)
		const builder = parseTypeBuilderModel(parsed.type)
		editingBuilder = builder
		registerBuilderTypes(builder)
		editingUseRaw = !builder
		inputEditorOpen = true
	}

	function startCreateInput() {
		const initialName = makeInputName(editorSpec?.inputs ?? {})
		editingInputOriginalName = ''
		editingInputName = initialName
		editingInputDefault = ''
		editingTypeRaw = 'File'
		editingBuilder = parseTypeBuilderModel('File')
		registerBuilderTypes(editingBuilder)
		editingUseRaw = false
		inputEditorOpen = true
	}

	function closeInputEditor() {
		inputEditorOpen = false
		editingInputOriginalName = ''
		editingInputName = ''
		editingInputDefault = ''
		editingTypeRaw = 'File'
		editingBuilder = null
		editingUseRaw = false
	}

	function currentEditingType(): string {
		if (editingUseRaw || !editingBuilder) {
			return editingTypeRaw
		}
		return serializeTypeBuilderModel(editingBuilder)
	}

	function validateEditingInput(): { valid: boolean; errors: string[] } {
		const errors: string[] = []
		const name = editingInputName.trim()
		const type = currentEditingType().trim()
		if (!name) errors.push('Input name is required.')
		if (name && !/^[a-z][a-z0-9_]*$/.test(name)) {
			errors.push('Input name must start with a letter and use lowercase letters, numbers, underscores.')
		}
		if (!type) errors.push('Input type is required.')
		const parsed = parseFlowType(type)
		if (!parsed.node) errors.push(parsed.error ?? 'Type expression is invalid.')

		if (editorSpec && editingInputOriginalName !== name && editorSpec.inputs[name] !== undefined) {
			errors.push(`Input "${name}" already exists.`)
		}
		if (!editingUseRaw && editingBuilder) {
			if ((editingBuilder.kind === 'record' || editingBuilder.kind === 'listRecord') && editingBuilder.fields.length === 0) {
				errors.push('Record types need at least one field.')
			}
			const fieldNames = editingBuilder.fields.map((f) => f.name.trim()).filter(Boolean)
			if (fieldNames.length !== new Set(fieldNames).size) {
				errors.push('Record field names must be unique.')
			}
		}
		return { valid: errors.length === 0, errors }
	}

	function saveInputEditor() {
		const check = validateEditingInput()
		if (!check.valid) {
			error = check.errors[0]
			return
		}
		const nextName = editingInputName.trim()
		const nextType = currentEditingType().trim()
		if (
			editorSpec &&
			editingInputOriginalName !== nextName &&
			editorSpec.inputs[nextName] !== undefined
		) {
			error = `Input "${nextName}" already exists`
			return
		}
		setSpec((draft) => {
			if (editingInputOriginalName) {
				delete draft.inputs[editingInputOriginalName]
			}
			draft.inputs[nextName] = buildInputSpec(nextType, editingInputDefault)
		})
		closeInputEditor()
	}

	function buildBindingValueOptions(currentIndex: number): string[] {
		const options: string[] = []
		if (!editorSpec) return options
		for (const name of Object.keys(editorSpec.inputs)) {
			options.push(`inputs.${name}`)
		}
		for (let i = 0; i < currentIndex; i += 1) {
			const step = editorSpec.steps[i]
			options.push(`step.${step.id}.outputs`)
			const publish = step.publish ?? {}
			for (const key of Object.keys(publish)) {
				options.push(`step.${step.id}.outputs.${key}`)
			}
			const share = step.share ?? {}
			for (const key of Object.keys(share)) {
				options.push(`step.${step.id}.share.${key}`)
			}
		}
		return Array.from(new Set(options))
	}

	function getStepDependencies(step: FlowStepSpec): string[] {
		const refs = new Set<string>()
		for (const value of Object.values(step.with ?? {})) {
			if (typeof value !== 'string') continue
			const matches = value.matchAll(/step\.([a-zA-Z0-9_-]+)\./g)
			for (const match of matches) {
				if (match[1]) refs.add(match[1])
			}
		}
		return [...refs]
	}

	function getModuleInfoByName(name: string | undefined): ModuleInfo | null {
		if (!name?.trim() || !editorPayload) return null
		return editorPayload.modules.find((module) => module.name === name.trim()) ?? null
	}

	function moduleRequiredInputNames(step: FlowStepSpec): string[] {
		const moduleInfo = getModuleInfoByName(step.uses)
		if (!moduleInfo) return []
		const inputs = moduleInfo.inputs ?? []
		return inputs.filter((item) => item.required !== false).map((item) => item.name).filter(Boolean)
	}

	function moduleOutputPorts(step: FlowStepSpec): ModulePortInfo[] {
		const moduleInfo = getModuleInfoByName(step.uses)
		return moduleInfo?.outputs ?? []
	}

	function moduleOutputNames(step: FlowStepSpec): string[] {
		return moduleOutputPorts(step).map((item) => item.name).filter(Boolean)
	}

	function findModuleOutput(step: FlowStepSpec, outputName: string): ModulePortInfo | null {
		return moduleOutputPorts(step).find((item) => item.name === outputName) ?? null
	}

	function moduleOutputDefaultPublishValue(step: FlowStepSpec, outputName: string): string {
		const port = findModuleOutput(step, outputName)
		if (!port) return ''
		const t = (port.raw_type ?? '').toLowerCase()
		const path = port.path?.trim() ?? ''
		if (path) {
			if (t === 'file' || t.endsWith('file')) return `File(${path})`
			if (t === 'directory' || t.endsWith('directory')) return `Directory(${path})`
		}
		return `self.outputs.${port.name}`
	}

	function stepUndeclaredPublishKeys(step: FlowStepSpec): string[] {
		const declared = new Set(moduleOutputNames(step))
		if (declared.size === 0) return []
		return Object.keys(step.publish ?? {}).filter((key) => !declared.has(key))
	}

	function stepMissingDeclaredOutputs(step: FlowStepSpec): string[] {
		const declared = moduleOutputNames(step)
		const current = new Set(Object.keys(step.publish ?? {}))
		return declared.filter((name) => !current.has(name))
	}

	function stepMissingRequiredBindings(step: FlowStepSpec): string[] {
		const required = moduleRequiredInputNames(step)
		if (required.length === 0) return []
		const withMap = step.with ?? {}
		return required.filter((name) => {
			const value = withMap[name]
			return typeof value !== 'string' || !value.trim()
		})
	}

	function addMissingRequiredBindings(index: number) {
		const step = editorSpec?.steps[index]
		if (!step) return
		const required = moduleRequiredInputNames(step)
		if (required.length === 0) return
		const withMap = step.with ?? {}
		const bindingOptions = buildBindingValueOptions(index)
		const next = getStepBindings(step)
		for (const key of required) {
			const existing = withMap[key]
			if (typeof existing === 'string' && existing.trim()) continue
			const suggested = bindingOptions.find((option) => option === `inputs.${key}`) ?? ''
			next.push({ key, value: suggested })
		}
		setStepBindings(index, next)
	}

	function getStepIssues(step: FlowStepSpec, index: number, allSteps: FlowStepSpec[]): GuidedIssue[] {
		const issues: GuidedIssue[] = []
		const cleanId = step.id?.trim() ?? ''
		if (!cleanId) {
			issues.push({ level: 'error', section: 'steps', stepIndex: index, message: 'Step ID is required.' })
		} else if (!/^[a-zA-Z][a-zA-Z0-9_-]*$/.test(cleanId)) {
			issues.push({
				level: 'warning',
				section: 'steps',
				stepIndex: index,
				message: `Step "${cleanId}" should use letters/numbers/_/-.`,
			})
		}

		if (!step.uses?.trim()) {
			issues.push({ level: 'error', section: 'steps', stepIndex: index, message: 'Module (uses) is required.' })
		}
		const moduleInfo = getModuleInfoByName(step.uses)
		if (step.uses?.trim() && !moduleInfo) {
			issues.push({
				level: 'warning',
				section: 'steps',
				stepIndex: index,
				message: `Module "${step.uses}" was not found in installed modules.`,
			})
		}

		const duplicate = allSteps.findIndex((s, i) => i !== index && s.id.trim() === cleanId)
		if (cleanId && duplicate >= 0) {
			issues.push({
				level: 'error',
				section: 'steps',
				stepIndex: index,
				message: `Step ID "${cleanId}" is duplicated.`,
			})
		}

		for (const [key, value] of Object.entries(step.with ?? {})) {
			if (!key.trim()) {
				issues.push({ level: 'error', section: 'steps', stepIndex: index, message: 'Binding key cannot be empty.' })
				continue
			}
			const text = typeof value === 'string' ? value.trim() : ''
			if (!text) {
				issues.push({
					level: 'error',
					section: 'steps',
					stepIndex: index,
					message: `Binding "${key}" has no value.`,
				})
				continue
			}
			if (!text.startsWith('inputs.') && !text.startsWith('step.')) {
				issues.push({
					level: 'warning',
					section: 'steps',
					stepIndex: index,
					message: `Binding "${key}" should usually reference "inputs." or "step." values.`,
				})
			}
		}
		if (moduleInfo && (moduleInfo.inputs?.length ?? 0) > 0) {
			const allowed = new Set((moduleInfo.inputs ?? []).map((item) => item.name))
			for (const key of Object.keys(step.with ?? {})) {
				if (!allowed.has(key)) {
					issues.push({
						level: 'warning',
						section: 'steps',
						stepIndex: index,
						message: `Binding "${key}" is not declared by module "${moduleInfo.name}".`,
					})
				}
			}
		}
		for (const missing of stepMissingRequiredBindings(step)) {
			issues.push({
				level: 'error',
				section: 'steps',
				stepIndex: index,
				message: `Required module input "${missing}" is missing.`,
			})
		}

		for (const [key, value] of Object.entries(step.publish ?? {})) {
			if (!key.trim()) {
				issues.push({ level: 'error', section: 'steps', stepIndex: index, message: 'Publish key cannot be empty.' })
			}
			if (!value.trim()) {
				issues.push({
					level: 'error',
					section: 'steps',
					stepIndex: index,
					message: `Publish "${key || 'unnamed'}" has no value.`,
				})
			}
		}
		for (const key of stepUndeclaredPublishKeys(step)) {
			issues.push({
				level: 'warning',
				section: 'steps',
				stepIndex: index,
				message: `Publish key "${key}" is not declared by module outputs.`,
			})
		}
		return issues
	}

	function getGuidedIssues(spec: FlowSpec | null): GuidedIssue[] {
		if (!spec) return []
		const issues: GuidedIssue[] = []
		if (!spec.name.trim()) {
			issues.push({ level: 'error', section: 'overview', message: 'Flow name is required.' })
		}
		if (spec.datasites.length === 0) {
			issues.push({
				level: 'warning',
				section: 'datasites',
				message: 'No datasites configured. Most multiparty flows require at least one.',
			})
		}
		spec.steps.forEach((step, index) => {
			issues.push(...getStepIssues(step, index, spec.steps))
		})
		return issues
	}

	function guidedBlockingErrors(spec: FlowSpec | null): number {
		return getGuidedIssues(spec).filter((item) => item.level === 'error').length
	}

	function applyDatasiteTemplate(template: DatasiteTemplate) {
		setSpec((draft) => {
			draft.datasites = [...template.values]
		})
	}

	function addWizardBinding(index: number) {
		if (!wizardBindingKey.trim() || !wizardBindingValue.trim()) return
		const step = editorSpec?.steps[index]
		if (!step) return
		const current = getStepBindings(step)
		current.push({ key: wizardBindingKey.trim(), value: wizardBindingValue.trim() })
		setStepBindings(index, current)
		wizardBindingKey = ''
		wizardBindingValue = ''
	}

	function addWizardOutput(index: number) {
		if (!wizardOutputKey.trim() || !wizardOutputValue.trim()) return
		const step = editorSpec?.steps[index]
		if (!step) return
		const current = getStepPublishes(step)
		current.push({ key: wizardOutputKey.trim(), value: wizardOutputValue.trim() })
		setStepPublishes(index, current)
		wizardOutputKey = ''
		wizardOutputValue = ''
	}

	function autoFillWizardOutputValue(index: number) {
		const step = editorSpec?.steps[index]
		if (!step) return
		const key = wizardOutputKey.trim()
		if (!key) return
		if (wizardOutputValue.trim()) return
		wizardOutputValue = moduleOutputDefaultPublishValue(step, key)
	}

	function addMissingDeclaredOutputs(index: number) {
		const step = editorSpec?.steps[index]
		if (!step) return
		const missing = stepMissingDeclaredOutputs(step)
		if (missing.length === 0) return
		const current = getStepPublishes(step)
		for (const key of missing) {
			current.push({ key, value: moduleOutputDefaultPublishValue(step, key) })
		}
		setStepPublishes(index, current)
	}

	function safeParseType(raw: string): FlowTypeNode {
		const parsed = parseFlowType(raw)
		if (parsed.node) return parsed.node
		return { kind: 'named', name: raw.trim() || 'String' }
	}

	function toEditableField(field: { name: string; type: FlowTypeNode }): EditableField {
		const unwrapped = unwrapOptional(field.type)
		return {
			name: field.name,
			type: serializeFlowType(unwrapped.node),
			optional: unwrapped.optional,
		}
	}

	function parseTypeBuilderModel(typeRaw: string): TypeBuilderModel | null {
		const parsed = parseFlowType(typeRaw)
		if (!parsed.node) return null
		const outer = unwrapOptional(parsed.node)
		const base: TypeBuilderModel = {
			kind: 'single',
			optional: outer.optional,
			singleType: 'String',
			listItemType: 'String',
			mapKeyType: 'String',
			mapValueType: 'String',
			fields: [],
		}

		if (outer.node.kind === 'named') {
			base.kind = 'single'
			base.singleType = canonicalBuiltInType(outer.node.name)
			return base
		}
		if (outer.node.kind === 'record') {
			base.kind = 'record'
			base.fields = outer.node.fields.map(toEditableField)
			return base
		}
		if (outer.node.kind === 'list') {
			const item = unwrapOptional(outer.node.item)
			if (item.node.kind === 'record') {
				base.kind = 'listRecord'
				base.fields = item.node.fields.map(toEditableField)
				return base
			}
			base.kind = 'list'
			base.listItemType = canonicalBuiltInType(serializeFlowType(item.node))
			return base
		}
		if (outer.node.kind === 'map') {
			base.kind = 'map'
			base.mapKeyType = canonicalBuiltInType(serializeFlowType(outer.node.key))
			base.mapValueType = canonicalBuiltInType(serializeFlowType(outer.node.value))
			return base
		}
		return null
	}

	function serializeTypeBuilderModel(model: TypeBuilderModel): string {
		let node: FlowTypeNode
		if (model.kind === 'single') {
			node = safeParseType(model.singleType)
		} else if (model.kind === 'list') {
			node = { kind: 'list', item: safeParseType(model.listItemType) }
		} else if (model.kind === 'map') {
			node = {
				kind: 'map',
				key: safeParseType(model.mapKeyType),
				value: safeParseType(model.mapValueType),
			}
		} else {
			const fields = model.fields
				.filter((field) => field.name.trim().length > 0)
				.map((field) => {
					let fieldNode = safeParseType(field.type)
					if (field.optional) fieldNode = { kind: 'optional', inner: fieldNode }
					return { name: field.name.trim(), type: fieldNode }
				})
			const recordNode: FlowTypeNode = { kind: 'record', fields }
			node = model.kind === 'record' ? recordNode : { kind: 'list', item: recordNode }
		}

		if (model.optional) node = { kind: 'optional', inner: node }
		return serializeFlowType(node)
	}

	function syncBuilderToRaw(model: TypeBuilderModel) {
		editingBuilder = model
		editingTypeRaw = serializeTypeBuilderModel(model)
	}

	function setBuilderKind(model: TypeBuilderModel, kind: BuilderKind) {
		const next = clone(model)
		next.kind = kind
		if ((kind === 'record' || kind === 'listRecord') && next.fields.length === 0) {
			next.fields.push({ name: 'field_1', type: 'String', optional: false })
		}
		syncBuilderToRaw(next)
	}

	function setBuilderOptional(model: TypeBuilderModel, optional: boolean) {
		const next = clone(model)
		next.optional = optional
		syncBuilderToRaw(next)
	}

	function addBuilderField(model: TypeBuilderModel) {
		const next = clone(model)
		next.fields.push({ name: `field_${next.fields.length + 1}`, type: 'String', optional: false })
		syncBuilderToRaw(next)
	}

	function removeBuilderField(model: TypeBuilderModel, index: number) {
		const next = clone(model)
		next.fields.splice(index, 1)
		syncBuilderToRaw(next)
	}

	function updateBuilderField(
		model: TypeBuilderModel,
		index: number,
		key: 'name' | 'type' | 'optional',
		value: string | boolean,
	) {
		const next = clone(model)
		if (!next.fields[index]) return
		if (key === 'optional') next.fields[index].optional = Boolean(value)
		else if (key === 'name') next.fields[index].name = String(value)
		else next.fields[index].type = String(value)
		syncBuilderToRaw(next)
	}

	function applyTypeToTarget(expr: string, target: CustomEditorTarget) {
		if (!editingBuilder) return
		const next = clone(editingBuilder)
		if (target.kind === 'single') next.singleType = expr
		if (target.kind === 'list') next.listItemType = expr
		if (target.kind === 'mapKey') next.mapKeyType = expr
		if (target.kind === 'mapValue') next.mapValueType = expr
		if (target.kind === 'field' && target.fieldIndex != null && next.fields[target.fieldIndex]) {
			next.fields[target.fieldIndex].type = expr
		}
		syncBuilderToRaw(next)
	}

	function handleTypeSelection(value: string, target: CustomEditorTarget) {
		if (value === NEW_CUSTOM_TYPE_VALUE) {
			customEditorTarget = target
			customTypeName = ''
			customTypeRaw = 'String'
			customTypeBuilder = parseTypeBuilderModel('String')
			customTypeUseRaw = false
			customTypeError = null
			customTypeEditorOpen = true
			return
		}
		applyTypeToTarget(value, target)
	}

	function closeCustomTypeEditor() {
		customTypeEditorOpen = false
		customTypeName = ''
		customTypeRaw = 'String'
		customTypeBuilder = null
		customTypeUseRaw = false
		customTypeError = null
		customEditorTarget = null
	}

	function currentCustomTypeExpr(): string {
		if (customTypeUseRaw || !customTypeBuilder) return customTypeRaw.trim()
		return serializeTypeBuilderModel(customTypeBuilder).trim()
	}

	function syncCustomBuilderToRaw(model: TypeBuilderModel) {
		customTypeBuilder = model
		customTypeRaw = serializeTypeBuilderModel(model)
	}

	function setCustomBuilderKind(model: TypeBuilderModel, kind: BuilderKind) {
		const next = clone(model)
		next.kind = kind
		if ((kind === 'record' || kind === 'listRecord') && next.fields.length === 0) {
			next.fields.push({ name: 'field_1', type: 'String', optional: false })
		}
		syncCustomBuilderToRaw(next)
	}

	function setCustomBuilderOptional(model: TypeBuilderModel, optional: boolean) {
		const next = clone(model)
		next.optional = optional
		syncCustomBuilderToRaw(next)
	}

	function setCustomBuilderType(model: TypeBuilderModel, target: 'single' | 'list' | 'mapKey' | 'mapValue', value: string) {
		const next = clone(model)
		if (target === 'single') next.singleType = value
		if (target === 'list') next.listItemType = value
		if (target === 'mapKey') next.mapKeyType = value
		if (target === 'mapValue') next.mapValueType = value
		syncCustomBuilderToRaw(next)
	}

	function addCustomBuilderField(model: TypeBuilderModel) {
		const next = clone(model)
		next.fields.push({ name: `field_${next.fields.length + 1}`, type: 'String', optional: false })
		syncCustomBuilderToRaw(next)
	}

	function updateCustomBuilderField(
		model: TypeBuilderModel,
		index: number,
		key: 'name' | 'type' | 'optional',
		value: string | boolean,
	) {
		const next = clone(model)
		if (!next.fields[index]) return
		if (key === 'optional') next.fields[index].optional = Boolean(value)
		else if (key === 'name') next.fields[index].name = String(value)
		else next.fields[index].type = String(value)
		syncCustomBuilderToRaw(next)
	}

	function removeCustomBuilderField(model: TypeBuilderModel, index: number) {
		const next = clone(model)
		next.fields.splice(index, 1)
		syncCustomBuilderToRaw(next)
	}

	function saveCustomType() {
		const name = customTypeName.trim()
		const expr = currentCustomTypeExpr()
		if (!name) {
			customTypeError = 'Custom type name is required.'
			return
		}
		if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(name)) {
			customTypeError = 'Use letters, numbers, and underscores. Start with a letter.'
			return
		}
		if (!expr) {
			customTypeError = 'Custom type expression is required.'
			return
		}
		const parsed = parseFlowType(expr)
		if (!parsed.node) {
			customTypeError = parsed.error ?? 'Type expression is invalid.'
			return
		}

		const existingByName = customTypes.find((item) => item.label.toLowerCase() === name.toLowerCase())
		let resolvedExpr = expr
		if (existingByName) {
			customTypes = customTypes.map((item) =>
				item.id === existingByName.id
					? { ...item, label: name, expr, source: 'user' as const }
					: item,
			)
		} else {
			const id = `user-${slugifyTypeId(name)}-${customTypes.length + 1}`
			customTypes = [
				...customTypes,
				{ id, label: name, expr, isCustom: true, source: 'user' },
			]
		}
		if (customEditorTarget) {
			applyTypeToTarget(resolvedExpr, customEditorTarget)
		}
		closeCustomTypeEditor()
	}

	function addStep() {
		setSpec((draft) => {
			let idx = draft.steps.length + 1
			let id = `step_${idx}`
			while (draft.steps.some((step) => step.id === id)) {
				idx += 1
				id = `step_${idx}`
			}
			draft.steps.push({ id, uses: '', with: {} })
			selectedStepIndex = draft.steps.length - 1
		})
	}

	function removeStep(index: number) {
		setSpec((draft) => {
			draft.steps.splice(index, 1)
			if (selectedStepIndex >= draft.steps.length) {
				selectedStepIndex = Math.max(0, draft.steps.length - 1)
			}
		})
	}

	function moveStep(index: number, direction: -1 | 1) {
		setSpec((draft) => {
			const nextIndex = index + direction
			if (nextIndex < 0 || nextIndex >= draft.steps.length) return
			const [current] = draft.steps.splice(index, 1)
			draft.steps.splice(nextIndex, 0, current)
			selectedStepIndex = nextIndex
		})
	}

	function updateStepField(index: number, key: 'id' | 'uses', value: string) {
		setSpec((draft) => {
			if (!draft.steps[index]) return
			draft.steps[index][key] = value
		})
	}

	function getStepBindings(step: FlowStepSpec): Array<{ key: string; value: string }> {
		const withMap = step.with ?? {}
		return Object.entries(withMap).map(([key, value]) => ({
			key,
			value: typeof value === 'string' ? value : JSON.stringify(value),
		}))
	}

	function setStepBindings(index: number, bindings: Array<{ key: string; value: string }>) {
		setSpec((draft) => {
			const target = draft.steps[index]
			if (!target) return
			const next: Record<string, string> = {}
			for (const binding of bindings) {
				if (!binding.key.trim()) continue
				next[binding.key.trim()] = binding.value.trim()
			}
			target.with = next
		})
	}

	function addBinding(index: number) {
		const step = editorSpec?.steps[index]
		if (!step) return
		const current = getStepBindings(step)
		current.push({ key: '', value: '' })
		setStepBindings(index, current)
	}

	function removeBinding(index: number, bindingIndex: number) {
		const step = editorSpec?.steps[index]
		if (!step) return
		const current = getStepBindings(step)
		current.splice(bindingIndex, 1)
		setStepBindings(index, current)
	}

	function updateBinding(index: number, bindingIndex: number, key: 'key' | 'value', value: string) {
		const step = editorSpec?.steps[index]
		if (!step) return
		const current = getStepBindings(step)
		if (!current[bindingIndex]) return
		current[bindingIndex][key] = value
		setStepBindings(index, current)
	}

	function getStepPublishes(step: FlowStepSpec): Array<{ key: string; value: string }> {
		const publishMap = step.publish ?? {}
		return Object.entries(publishMap).map(([key, value]) => ({ key, value }))
	}

	function setStepPublishes(index: number, publishes: Array<{ key: string; value: string }>) {
		setSpec((draft) => {
			const target = draft.steps[index]
			if (!target) return
			const next: Record<string, string> = {}
			for (const item of publishes) {
				if (!item.key.trim()) continue
				next[item.key.trim()] = item.value.trim()
			}
			target.publish = next
		})
	}

	function addPublish(index: number) {
		const step = editorSpec?.steps[index]
		if (!step) return
		const current = getStepPublishes(step)
		current.push({ key: '', value: '' })
		setStepPublishes(index, current)
	}

	function removePublish(index: number, publishIndex: number) {
		const step = editorSpec?.steps[index]
		if (!step) return
		const current = getStepPublishes(step)
		current.splice(publishIndex, 1)
		setStepPublishes(index, current)
	}

	function updatePublish(
		index: number,
		publishIndex: number,
		key: 'key' | 'value',
		value: string,
	) {
		const step = editorSpec?.steps[index]
		if (!step) return
		const current = getStepPublishes(step)
		if (!current[publishIndex]) return
		current[publishIndex][key] = value
		setStepPublishes(index, current)
	}

	function addDatasite() {
		setSpec((draft) => {
			let idx = draft.datasites.length + 1
			let id = `datasite${idx}@sandbox.local`
			while (draft.datasites.includes(id)) {
				idx += 1
				id = `datasite${idx}@sandbox.local`
			}
			draft.datasites.push(id)
		})
	}

	function updateDatasite(index: number, value: string) {
		setSpec((draft) => {
			draft.datasites[index] = value
		})
	}

	function removeDatasite(index: number) {
		setSpec((draft) => {
			draft.datasites.splice(index, 1)
		})
	}

	function addVar() {
		setSpec((draft) => {
			draft.vars = draft.vars ?? {}
			let idx = 1
			let candidate = `var_${idx}`
			while (draft.vars[candidate] !== undefined) {
				idx += 1
				candidate = `var_${idx}`
			}
			draft.vars[candidate] = ''
		})
	}

	function renameVar(oldName: string, newName: string) {
		if (!editorSpec) return
		const clean = newName.trim()
		if (!clean || clean === oldName) return
		if ((editorSpec.vars ?? {})[clean] !== undefined) return
		setSpec((draft) => {
			draft.vars = draft.vars ?? {}
			const value = draft.vars[oldName]
			delete draft.vars[oldName]
			draft.vars[clean] = value
		})
	}

	function updateVar(name: string, value: string) {
		setSpec((draft) => {
			draft.vars = draft.vars ?? {}
			draft.vars[name] = value
		})
	}

	function removeVar(name: string) {
		setSpec((draft) => {
			draft.vars = draft.vars ?? {}
			delete draft.vars[name]
		})
	}

	async function loadRuns(flowId: number) {
		const allRuns = await invoke<PipelineRun[]>('get_flow_runs')
		runs = allRuns
			.filter((r) => r.pipeline_id === flowId)
			.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
			.slice(0, 20)
	}

	async function refreshRuns() {
		if (!currentFlow) return
		refreshingRuns = true
		try {
			await loadRuns(currentFlow.id)
		} finally {
			refreshingRuns = false
		}
	}

	async function loadEditor() {
		loading = true
		error = null
		try {
			const flows = await invoke<Pipeline[]>('get_flows')
			const flow = flows.find((item) => item.name === flowName)
			if (!flow) {
				error = `Flow "${flowName}" not found`
				return
			}
			currentFlow = flow

			const payload = await invoke<FlowEditorPayload>('load_flow_editor', {
				flowId: flow.id,
			})
			editorPayload = payload
			editorSpec = normalizeSpec(payload.spec ?? null, flow.name)
			importTypesFromFlowSpec(editorSpec)
			yamlText = payload.raw_yaml ?? ''
			initialYaml = yamlText
			guidedDirty = false
			selectedStepIndex = 0
			validation = null

			await loadRuns(flow.id)
		} catch (e) {
			error = e instanceof Error ? e.message : String(e)
		} finally {
			loading = false
		}
	}

	onMount(loadEditor)

	async function saveGuided() {
		if (!editorPayload || !editorSpec) return
		saving = true
		error = null
		try {
			await invoke('save_flow_editor', {
				flowId: currentFlow?.id,
				flowPath: editorPayload.flow_path,
				spec: editorSpec,
			})
			guidedDirty = false
			await loadEditor()
		} catch (e) {
			error = e instanceof Error ? e.message : String(e)
		} finally {
			saving = false
		}
	}

	async function saveYaml() {
		if (!editorPayload) return
		saving = true
		error = null
		try {
			await invoke('save_flow_yaml', {
				flowId: currentFlow?.id,
				flowPath: editorPayload.flow_path,
				rawYaml: yamlText,
			})
			await loadEditor()
		} catch (e) {
			error = e instanceof Error ? e.message : String(e)
		} finally {
			saving = false
		}
	}

	async function validateFlow() {
		if (!editorPayload) return
		validating = true
		error = null
		try {
			validation = await invoke<FlowValidationResult>('validate_flow', {
				flowPath: editorPayload.flow_path,
			})
		} catch (e) {
			error = e instanceof Error ? e.message : String(e)
		} finally {
			validating = false
		}
	}

	async function openInFolder() {
		if (!currentFlow) return
		try {
			await invoke('show_in_folder', { path: currentFlow.flow_path })
		} catch (e) {
			error = e instanceof Error ? e.message : String(e)
		}
	}

	async function deleteRun(runId: number) {
		try {
			await invoke('delete_flow_run', { runId })
			runs = runs.filter((run) => run.id !== runId)
		} catch (e) {
			error = e instanceof Error ? e.message : String(e)
		}
	}

	function yamlIsDirty() {
		return yamlText !== initialYaml
	}

	function formatDate(dateStr: string): string {
		const date = new Date(dateStr)
		return date.toLocaleDateString(undefined, {
			month: 'short',
			day: 'numeric',
			hour: '2-digit',
			minute: '2-digit',
		})
	}

	function getStatusBadge(status: string) {
		switch (status.toLowerCase()) {
			case 'completed':
			case 'success':
				return { variant: 'default' as const, icon: CheckCircleIcon, label: 'Completed' }
			case 'failed':
			case 'error':
				return { variant: 'destructive' as const, icon: XCircleIcon, label: 'Failed' }
			case 'running':
				return { variant: 'secondary' as const, icon: LoaderIcon, label: 'Running' }
			default:
				return { variant: 'outline' as const, icon: ClockIcon, label: status }
		}
	}
</script>

<div class="flex h-full flex-col">
	<div class="border-b px-6 py-4">
		<div class="flex flex-wrap items-center gap-3">
			<Button variant="ghost" size="icon" onclick={() => goto('/flows')}>
				<ArrowLeftIcon class="size-5" />
			</Button>

			<div class="min-w-0 flex-1">
				<h1 class="truncate text-xl font-semibold">{flowName}</h1>
				<p class="text-muted-foreground text-sm">Flow editor with guided and YAML modes</p>
			</div>

			<div class="flex flex-wrap items-center gap-2">
				<Button
					variant={mode === 'guided' ? 'default' : 'outline'}
					size="sm"
					onclick={() => (mode = 'guided')}
				>
					Guided
				</Button>
				<Button
					variant={mode === 'yaml' ? 'default' : 'outline'}
					size="sm"
					onclick={() => (mode = 'yaml')}
				>
					YAML
				</Button>

				<Button variant="outline" size="sm" onclick={validateFlow} disabled={validating || saving || !editorPayload}>
					{#if validating}
						<LoaderIcon class="size-4 animate-spin" />
					{:else}
						<CheckCircleIcon class="size-4" />
					{/if}
					Validate
				</Button>

				<Button variant="outline" size="sm" onclick={openInFolder} disabled={!currentFlow}>
					<FolderOpenIcon class="size-4" />
					Open Folder
				</Button>

				<Button size="sm" onclick={() => (runDialogOpen = true)} disabled={!currentFlow}>
					<PlayIcon class="size-4" />
					Run
				</Button>

					<Button
						size="sm"
						onclick={mode === 'guided' ? saveGuided : saveYaml}
						disabled={saving || (mode === 'guided' ? !guidedDirty || guidedBlockingErrors(editorSpec) > 0 : !yamlIsDirty())}
					>
					{#if saving}
						<LoaderIcon class="size-4 animate-spin" />
					{:else}
						<SaveIcon class="size-4" />
					{/if}
					Save
				</Button>
			</div>
		</div>
	</div>

	{#if loading}
		<div class="flex flex-1 items-center justify-center">
			<p class="text-muted-foreground">Loading flow editor...</p>
		</div>
	{:else if error}
		<div class="mx-6 mt-6 rounded-lg border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive">
			{error}
		</div>
	{:else if editorSpec && editorPayload}
		<div class="flex min-h-0 flex-1">
			<div class="w-56 shrink-0 border-r p-3">
				<div class="space-y-1">
					{#each sections as item}
						<button
							type="button"
							onclick={() => (section = item.id)}
							class="w-full rounded-md px-3 py-2 text-left text-sm transition-colors {section === item.id
								? 'bg-primary text-primary-foreground'
								: 'hover:bg-accent'}"
						>
							{item.label}
						</button>
					{/each}
				</div>

				<div class="mt-4 rounded-md border p-3 text-xs text-muted-foreground">
					<div class="font-medium text-foreground">Mode notes</div>
					<div class="mt-1">
						Guided mode edits common fields quickly. YAML mode preserves full file shape for advanced flow features.
					</div>
				</div>
			</div>

			<div class="min-h-0 flex-1 overflow-auto p-6">
					{#if validation}
					<div class="mb-5 rounded-lg border px-4 py-3">
						<div class="flex items-center gap-2 text-sm font-medium">
							{#if validation.valid}
								<CheckCircleIcon class="size-4 text-emerald-600" />
								Validation passed
							{:else}
								<AlertTriangleIcon class="size-4 text-amber-600" />
								Validation failed
							{/if}
						</div>
						{#if validation.errors.length > 0}
							<div class="mt-2 text-sm text-destructive">
								{#each validation.errors as item}
									<div>{item}</div>
								{/each}
							</div>
						{/if}
						{#if validation.warnings.length > 0}
							<div class="mt-2 text-sm text-amber-600">
								{#each validation.warnings as item}
									<div>{item}</div>
								{/each}
							</div>
						{/if}
						{#if validation.diagram}
							<details class="mt-3">
								<summary class="cursor-pointer text-sm font-medium">Execution diagram</summary>
								<pre class="mt-2 overflow-auto rounded-md bg-muted p-3 text-xs">{validation.diagram}</pre>
							</details>
						{/if}
					</div>
					{/if}

					{#if mode === 'guided' && guidedIssues.length > 0}
						<div class="mb-5 rounded-lg border px-4 py-3">
							<div class="flex items-center gap-2 text-sm font-medium">
								<AlertTriangleIcon class="size-4 text-amber-600" />
								Guided checks
								<Badge variant="outline">
									{guidedIssues.filter((item) => item.level === 'error').length} errors
								</Badge>
								<Badge variant="secondary">
									{guidedIssues.filter((item) => item.level === 'warning').length} warnings
								</Badge>
							</div>
							<div class="mt-2 space-y-1 text-sm">
								{#each guidedIssues.slice(0, 8) as issue}
									<div class={issue.level === 'error' ? 'text-destructive' : 'text-amber-700'}>
										[{issue.section}{issue.stepIndex != null ? ` #${issue.stepIndex + 1}` : ''}] {issue.message}
									</div>
								{/each}
								{#if guidedIssues.length > 8}
									<div class="text-xs text-muted-foreground">
										+ {guidedIssues.length - 8} more checks
									</div>
								{/if}
							</div>
						</div>
					{/if}

					{#if mode === 'yaml'}
					<Card.Root>
						<Card.Header>
							<Card.Title>flow.yaml</Card.Title>
						</Card.Header>
						<Card.Content>
							<Textarea
								bind:value={yamlText}
								class="min-h-[560px] font-mono text-xs"
								spellcheck="false"
							/>
						</Card.Content>
					</Card.Root>
				{:else if section === 'overview'}
					<div class="space-y-4">
						<Card.Root>
							<Card.Header>
								<Card.Title>Metadata</Card.Title>
							</Card.Header>
							<Card.Content>
								<div class="grid gap-3 md:grid-cols-2">
									<div class="space-y-2">
										<div class="text-sm font-medium">Flow name</div>
										<Input
											value={editorSpec.name}
											oninput={(event) =>
												setSpec((draft) => {
													draft.name = event.currentTarget.value
												})}
										/>
									</div>
									<div class="space-y-2">
										<div class="text-sm font-medium">Multiparty</div>
										<label class="flex items-center gap-2 text-sm">
											<Checkbox
												checked={Boolean(editorSpec.multiparty)}
												onCheckedChange={(value) =>
													setSpec((draft) => {
														draft.multiparty = !!value
													})}
											/>
											Enable multiparty scheduling defaults
										</label>
									</div>
								</div>
								<div class="mt-3 space-y-2">
									<div class="text-sm font-medium">Description</div>
									<Textarea
										value={editorSpec.description ?? ''}
										oninput={(event) =>
											setSpec((draft) => {
												draft.description = event.currentTarget.value
											})}
										class="min-h-24 text-sm"
									/>
								</div>
							</Card.Content>
						</Card.Root>
					</div>
				{:else if section === 'inputs'}
					<Card.Root>
						<Card.Header>
							<div class="flex items-center justify-between">
								<Card.Title>Inputs</Card.Title>
								<Button variant="outline" size="sm" onclick={startCreateInput}>
									<PlusIcon class="size-4" />
									Add Input
								</Button>
							</div>
						</Card.Header>
						<Card.Content>
							<div class="space-y-3">
								{#each Object.entries(editorSpec.inputs) as [name, specValue]}
									{@const parsed = parseInputSpec(specValue)}
									{@const typeParsed = parseFlowType(parsed.type)}
									<div class="rounded-md border p-3">
										<div class="grid gap-2 md:grid-cols-[1fr,1fr,1fr,auto,auto]">
											<div class="min-w-0">
												<div class="truncate text-sm font-medium">{name}</div>
											</div>
											<div class="min-w-0">
												{#if typeParsed.node}
													<div class="truncate text-sm">{friendlyFlowType(typeParsed.node)}</div>
												{:else}
													<div class="truncate text-sm text-destructive">Invalid type</div>
												{/if}
											</div>
											<div class="min-w-0">
												<div class="truncate text-xs text-muted-foreground">{parsed.type}</div>
											</div>
											<div class="min-w-0">
												<div class="truncate text-xs text-muted-foreground">
													{parsed.defaultValue ? `Default: ${parsed.defaultValue}` : 'No default'}
												</div>
											</div>
											<div class="flex gap-1 justify-end">
												<Button variant="outline" size="sm" onclick={() => openInputEditor(name, specValue)}>
													Edit
												</Button>
												<Button variant="ghost" size="icon" onclick={() => removeInput(name)}>
													<TrashIcon class="size-4" />
												</Button>
											</div>
										</div>
									</div>
								{/each}
								{#if Object.keys(editorSpec.inputs).length === 0}
									<div class="rounded-md border border-dashed p-6 text-center text-sm text-muted-foreground">
										No inputs yet. Add one to start building flow configuration.
									</div>
								{/if}
							</div>
						</Card.Content>
					</Card.Root>
				{:else if section === 'steps'}
					<div class="grid gap-4 lg:grid-cols-[320px,1fr]">
						<Card.Root>
								<Card.Header>
									<div class="flex items-center justify-between">
										<Card.Title>Flow Map</Card.Title>
										<Button variant="outline" size="sm" onclick={addStep}>
											<PlusIcon class="size-4" />
											Add Step
										</Button>
									</div>
									<div class="text-xs text-muted-foreground">
										Visual order of execution with dependency hints.
									</div>
								</Card.Header>
							<Card.Content>
								<div class="space-y-2">
									{#if editorSpec.steps.length === 0}
										<p class="text-sm text-muted-foreground">No steps yet.</p>
									{/if}
											{#each editorSpec.steps as step, index}
												{@const stepIssues = getStepIssues(step, index, editorSpec.steps)}
												{@const deps = getStepDependencies(step)}
												{@const missingRequired = stepMissingRequiredBindings(step)}
												{@const missingDeclaredOutputs = stepMissingDeclaredOutputs(step)}
												<button
											type="button"
											onclick={() => (selectedStepIndex = index)}
											class="w-full rounded-lg border p-3 text-left transition-colors {selectedStepIndex ===
											index
												? 'border-primary bg-primary/5'
												: 'hover:bg-accent'}"
										>
												<div class="flex items-center justify-between gap-2">
													<div class="min-w-0">
														<div class="truncate text-sm font-medium">{step.id}</div>
														<div class="truncate text-xs text-muted-foreground">uses: {step.uses || '-'}</div>
														<div class="mt-1 flex flex-wrap gap-1">
															<Badge variant="outline">with {Object.keys(step.with ?? {}).length}</Badge>
															<Badge variant="outline">publish {Object.keys(step.publish ?? {}).length}</Badge>
															{#if deps.length > 0}
																<Badge variant="secondary">depends {deps.join(', ')}</Badge>
															{/if}
															{#if missingRequired.length > 0}
																<Badge variant="destructive">missing {missingRequired.length} required</Badge>
															{/if}
															{#if missingDeclaredOutputs.length > 0}
																<Badge variant="outline">missing {missingDeclaredOutputs.length} outputs</Badge>
															{/if}
															{#if stepIssues.some((item) => item.level === 'error')}
																<Badge variant="destructive">issues</Badge>
															{/if}
														</div>
													</div>
													<Badge variant="outline">{index + 1}</Badge>
												</div>
											</button>
										{/each}
								</div>
							</Card.Content>
						</Card.Root>

						<Card.Root>
							<Card.Header>
								<Card.Title>Step Inspector</Card.Title>
							</Card.Header>
								<Card.Content>
									{#if editorSpec.steps[selectedStepIndex]}
										{@const step = editorSpec.steps[selectedStepIndex]}
										{@const bindingOptions = buildBindingValueOptions(selectedStepIndex)}
										{@const moduleInfo = getModuleInfoByName(step.uses)}
										{@const requiredInputs = moduleRequiredInputNames(step)}
										{@const missingRequired = stepMissingRequiredBindings(step)}
										{@const declaredOutputs = moduleOutputNames(step)}
										{@const missingDeclaredOutputs = stepMissingDeclaredOutputs(step)}
										{@const undeclaredPublishKeys = stepUndeclaredPublishKeys(step)}
										{@const stepIssues = getStepIssues(step, selectedStepIndex, editorSpec.steps)}
										<div class="space-y-4">
											{#if stepIssues.length > 0}
												<div class="rounded-md border px-3 py-2 text-xs">
													{#each stepIssues as issue}
														<div class={issue.level === 'error' ? 'text-destructive' : 'text-amber-700'}>
															{issue.message}
														</div>
													{/each}
												</div>
											{/if}
											<div class="grid gap-3 md:grid-cols-2">
											<div class="space-y-1">
												<div class="text-sm font-medium">Step ID</div>
												<Input
													value={step.id}
													oninput={(event) =>
														updateStepField(selectedStepIndex, 'id', event.currentTarget.value)}
												/>
											</div>
												<div class="space-y-1">
													<div class="text-sm font-medium">Uses</div>
													<Select
														class="h-9 rounded-md border bg-background px-3 text-sm"
														value={step.uses ?? ''}
														onchange={(event) =>
															updateStepField(selectedStepIndex, 'uses', (event.currentTarget as HTMLSelectElement).value)}
													>
														<option value="">Select a module</option>
														{#each editorPayload.modules as module}
															<option value={module.name}>{module.name}</option>
														{/each}
													</Select>
													<Input
														value={step.uses ?? ''}
														list="module-suggestions"
														placeholder="or type a custom module id"
														oninput={(event) =>
															updateStepField(selectedStepIndex, 'uses', event.currentTarget.value)}
													/>
													<datalist id="module-suggestions">
														{#each editorPayload.modules as module}
															<option value={module.name}></option>
														{/each}
													</datalist>
													{#if moduleInfo}
														<div class="flex flex-wrap gap-1 text-xs">
															<Badge variant="secondary">
																{(moduleInfo.inputs ?? []).length} inputs
															</Badge>
															<Badge variant="outline">
																{(moduleInfo.outputs ?? []).length} outputs
															</Badge>
														</div>
													{/if}
												</div>
											</div>
											{#if moduleInfo}
												<div class="rounded-md border bg-muted/20 p-3">
													<div class="flex items-center justify-between gap-2">
														<div class="text-xs font-medium">Module-required inputs</div>
														<Button
															variant="outline"
															size="sm"
															onclick={() => addMissingRequiredBindings(selectedStepIndex)}
															disabled={missingRequired.length === 0}
														>
															Add Missing Required
														</Button>
													</div>
													{#if requiredInputs.length === 0}
														<div class="mt-2 text-xs text-muted-foreground">
															This module does not declare required inputs.
														</div>
													{:else}
														<div class="mt-2 flex flex-wrap gap-1">
															{#each requiredInputs as name}
																<Badge variant={missingRequired.includes(name) ? 'destructive' : 'secondary'}>
																	{name}
																</Badge>
															{/each}
														</div>
													{/if}
												</div>
												<div class="rounded-md border bg-muted/20 p-3">
													<div class="flex items-center justify-between gap-2">
														<div class="text-xs font-medium">Module-declared outputs</div>
														<Button
															variant="outline"
															size="sm"
															onclick={() => addMissingDeclaredOutputs(selectedStepIndex)}
															disabled={missingDeclaredOutputs.length === 0}
														>
															Add All Declared Outputs
														</Button>
													</div>
													{#if declaredOutputs.length === 0}
														<div class="mt-2 text-xs text-muted-foreground">
															This module does not declare outputs.
														</div>
													{:else}
														<div class="mt-2 flex flex-wrap gap-1">
															{#each declaredOutputs as name}
																<Badge variant={missingDeclaredOutputs.includes(name) ? 'outline' : 'secondary'}>
																	{name}
																</Badge>
															{/each}
														</div>
													{/if}
													{#if undeclaredPublishKeys.length > 0}
														<div class="mt-2 text-xs text-amber-700">
															Custom publish keys: {undeclaredPublishKeys.join(', ')}
														</div>
													{/if}
												</div>
											{/if}

											<div class="flex flex-wrap items-center gap-2">
											<Button
												variant="outline"
												size="sm"
												onclick={() => moveStep(selectedStepIndex, -1)}
												disabled={selectedStepIndex === 0}
											>
												Move Up
											</Button>
											<Button
												variant="outline"
												size="sm"
												onclick={() => moveStep(selectedStepIndex, 1)}
												disabled={selectedStepIndex >= editorSpec.steps.length - 1}
											>
												Move Down
											</Button>
											<Button variant="ghost" size="sm" onclick={() => removeStep(selectedStepIndex)}>
												<TrashIcon class="size-4" />
												Delete Step
											</Button>
										</div>

											<div class="space-y-2">
												<div class="rounded-md border bg-muted/20 p-3">
													<div class="text-xs font-medium">Wizard: Add binding</div>
													<div class="mt-2 grid gap-2 md:grid-cols-[1fr,2fr,auto]">
														<Input bind:value={wizardBindingKey} list="module-input-key-options" placeholder="module input key" />
														<Select
															class="h-9 rounded-md border bg-background px-3 text-sm"
															value={wizardBindingValue}
															onchange={(event) => (wizardBindingValue = (event.currentTarget as HTMLSelectElement).value)}
														>
															<option value="">Choose source value</option>
															{#each bindingOptions as option}
																<option value={option}>{option}</option>
															{/each}
														</Select>
														<Button
															variant="outline"
															size="sm"
															onclick={() => addWizardBinding(selectedStepIndex)}
															disabled={!wizardBindingKey.trim() || !wizardBindingValue.trim()}
														>
															Add
														</Button>
													</div>
													<datalist id="module-input-key-options">
														{#each moduleInfo?.inputs ?? [] as moduleInput}
															<option value={moduleInput.name}></option>
														{/each}
													</datalist>
												</div>
												<div class="flex items-center justify-between">
													<div class="text-sm font-medium">Bindings</div>
												<Button variant="outline" size="sm" onclick={() => addBinding(selectedStepIndex)}>
													<PlusIcon class="size-4" />
													Add Binding
												</Button>
											</div>
											{#each getStepBindings(step) as binding, bindingIndex}
												<div class="grid gap-2 md:grid-cols-[1fr,2fr,auto]">
													<Input
														placeholder="input name"
														value={binding.key}
														oninput={(event) =>
															updateBinding(
																selectedStepIndex,
																bindingIndex,
																'key',
																event.currentTarget.value,
															)}
													/>
													<Input
														placeholder="inputs.sample or step.other.outputs.x"
														value={binding.value}
														list="binding-value-options"
														oninput={(event) =>
															updateBinding(
																selectedStepIndex,
																bindingIndex,
																'value',
																event.currentTarget.value,
															)}
													/>
													<Button
														variant="ghost"
														size="icon"
														onclick={() => removeBinding(selectedStepIndex, bindingIndex)}
													>
														<TrashIcon class="size-4" />
													</Button>
												</div>
											{/each}
											<datalist id="binding-value-options">
												{#each bindingOptions as option}
													<option value={option}></option>
												{/each}
											</datalist>
										</div>

											<div class="space-y-2">
												<div class="rounded-md border bg-muted/20 p-3">
													<div class="text-xs font-medium">Wizard: Add output</div>
													<div class="mt-2 grid gap-2 md:grid-cols-[1fr,2fr,auto]">
														<Input
															bind:value={wizardOutputKey}
															list="module-output-key-options"
															placeholder="output key"
															onblur={() => autoFillWizardOutputValue(selectedStepIndex)}
														/>
														<Input bind:value={wizardOutputValue} placeholder="step output expression or path" />
														<Button
															variant="outline"
															size="sm"
															onclick={() => addWizardOutput(selectedStepIndex)}
															disabled={!wizardOutputKey.trim() || !wizardOutputValue.trim()}
														>
															Add
														</Button>
													</div>
													<datalist id="module-output-key-options">
														{#each moduleInfo?.outputs ?? [] as moduleOutput}
															<option value={moduleOutput.name}></option>
														{/each}
													</datalist>
												</div>
												<div class="flex items-center justify-between">
												<div class="text-sm font-medium">Outputs (publish)</div>
												<Button variant="outline" size="sm" onclick={() => addPublish(selectedStepIndex)}>
													<PlusIcon class="size-4" />
													Add Output
												</Button>
											</div>
											{#each getStepPublishes(step) as publishItem, publishIndex}
												<div class="grid gap-2 md:grid-cols-[1fr,2fr,auto]">
													<Input
														placeholder="output key"
														value={publishItem.key}
														oninput={(event) =>
															updatePublish(
																selectedStepIndex,
																publishIndex,
																'key',
																event.currentTarget.value,
															)}
													/>
													<Input
														placeholder="File(path) or binding"
														value={publishItem.value}
														oninput={(event) =>
															updatePublish(
																selectedStepIndex,
																publishIndex,
																'value',
																event.currentTarget.value,
															)}
													/>
													<Button
														variant="ghost"
														size="icon"
														onclick={() => removePublish(selectedStepIndex, publishIndex)}
													>
														<TrashIcon class="size-4" />
													</Button>
												</div>
											{/each}
										</div>
									</div>
								{:else}
									<p class="text-sm text-muted-foreground">Select a step to edit.</p>
								{/if}
							</Card.Content>
						</Card.Root>
					</div>
					{:else if section === 'datasites'}
						<Card.Root>
							<Card.Header>
								<div class="flex items-center justify-between">
									<Card.Title>Datasites</Card.Title>
									<Button variant="outline" size="sm" onclick={addDatasite}>
										<PlusIcon class="size-4" />
										Add Datasite
									</Button>
								</div>
								<div class="text-xs text-muted-foreground">
									Datasites define who participates in this flow. Use a template for quick setup.
								</div>
							</Card.Header>
							<Card.Content>
								<div class="mb-4 grid gap-2 md:grid-cols-3">
									{#each DATASITE_TEMPLATES as template}
										<button
											type="button"
											class="rounded-md border bg-muted/20 p-3 text-left transition-colors hover:bg-accent"
											onclick={() => applyDatasiteTemplate(template)}
										>
											<div class="text-sm font-medium">{template.label}</div>
											<div class="text-xs text-muted-foreground">{template.description}</div>
										</button>
									{/each}
								</div>
								<div class="space-y-2">
									{#each editorSpec.datasites as datasite, index}
										<div class="grid gap-2 md:grid-cols-[1fr,auto]">
											<Input value={datasite} oninput={(event) => updateDatasite(index, event.currentTarget.value)} />
											<Button variant="ghost" size="icon" onclick={() => removeDatasite(index)}>
												<TrashIcon class="size-4" />
											</Button>
										</div>
									{/each}
									{#if editorSpec.datasites.length === 0}
										<div class="rounded-md border border-dashed p-4 text-sm text-muted-foreground">
											No datasites configured yet.
										</div>
									{/if}
								</div>
							</Card.Content>
						</Card.Root>
				{:else if section === 'advanced'}
					<Card.Root>
						<Card.Header>
							<div class="flex items-center justify-between">
								<Card.Title>Variables</Card.Title>
								<Button variant="outline" size="sm" onclick={addVar}>
									<PlusIcon class="size-4" />
									Add Variable
								</Button>
							</div>
						</Card.Header>
						<Card.Content>
							<div class="space-y-3">
								{#each Object.entries(editorSpec.vars ?? {}) as [name, value]}
									<div class="grid gap-2 md:grid-cols-[1fr,2fr,auto]">
										<Input value={name} onblur={(event) => renameVar(name, event.currentTarget.value)} />
										<Input value={value} oninput={(event) => updateVar(name, event.currentTarget.value)} />
										<Button variant="ghost" size="icon" onclick={() => removeVar(name)}>
											<TrashIcon class="size-4" />
										</Button>
									</div>
								{/each}
							</div>
							<div class="mt-4 rounded-md border border-amber-300/40 bg-amber-50 px-3 py-2 text-xs text-amber-700">
								For advanced keys like coordination, MPC, roles, and rich module refs, use YAML mode to keep full
								parity with CLI flow files.
							</div>
						</Card.Content>
					</Card.Root>
				{:else if section === 'runs'}
					<Card.Root>
						<Card.Header>
							<div class="flex items-center justify-between">
								<Card.Title>Recent Runs</Card.Title>
								<Button variant="outline" size="sm" onclick={refreshRuns} disabled={refreshingRuns || !currentFlow}>
									{#if refreshingRuns}
										<LoaderIcon class="size-4 animate-spin" />
									{:else}
										<RefreshCwIcon class="size-4" />
									{/if}
									Refresh
								</Button>
							</div>
						</Card.Header>
						<Card.Content>
							{#if runs.length === 0}
								<p class="py-4 text-center text-sm text-muted-foreground">No runs yet</p>
							{:else}
								<div class="space-y-2">
									{#each runs as run}
										{@const status = getStatusBadge(run.status)}
										{@const StatusIcon = status.icon}
										<div class="flex items-center gap-3 rounded-lg border p-3">
											<StatusIcon
												class="size-4 {status.label === 'Running'
													? 'animate-spin text-muted-foreground'
													: status.variant === 'destructive'
														? 'text-destructive'
														: 'text-muted-foreground'}"
											/>
											<div class="min-w-0 flex-1">
												<div class="text-sm font-medium">Run #{run.id}</div>
												<div class="text-xs text-muted-foreground">{formatDate(run.created_at)}</div>
											</div>
											<Badge variant={status.variant}>{status.label}</Badge>
											<Button variant="ghost" size="icon" onclick={() => deleteRun(run.id)}>
												<TrashIcon class="size-4" />
											</Button>
										</div>
									{/each}
								</div>
							{/if}
						</Card.Content>
					</Card.Root>
				{/if}
			</div>
		</div>
	{/if}
</div>

<Dialog.Root bind:open={inputEditorOpen} onOpenChange={(open) => !open && closeInputEditor()}>
	<Dialog.Content class="max-h-[85vh] w-[95vw] max-w-3xl overflow-hidden p-0 sm:w-full">
		<Dialog.Header class="px-6 pt-6">
			<Dialog.Title>{editingInputOriginalName ? 'Edit Input' : 'Add Input'}</Dialog.Title>
			<Dialog.Description>
				Define what the flow needs from users. Keep names short, and use the type builder to avoid YAML syntax.
			</Dialog.Description>
		</Dialog.Header>

		<div class="space-y-4 overflow-y-auto px-6 pb-4">
			<div class="grid gap-3 md:grid-cols-2">
				<div class="space-y-1">
					<div class="text-sm font-medium">Input name</div>
					<Input bind:value={editingInputName} placeholder="input_name" />
					<div class="text-xs text-muted-foreground">
						Machine-friendly key used in bindings (for example: <code>inputs.{editingInputName || 'input_name'}</code>).
					</div>
				</div>
				<div class="space-y-1">
					<div class="text-sm font-medium">Default (optional)</div>
					<Input bind:value={editingInputDefault} placeholder="default value" />
					<div class="text-xs text-muted-foreground">
						Leave empty if users must provide this at run time.
					</div>
				</div>
			</div>

			<div class="space-y-2">
				<div class="flex items-center justify-between">
					<div class="text-sm font-medium">Type Builder</div>
					<Button
						type="button"
						variant="outline"
						size="sm"
						onclick={() => {
							editingUseRaw = !editingUseRaw
							if (!editingUseRaw && !editingBuilder) {
								editingBuilder = parseTypeBuilderModel(editingTypeRaw)
							}
						}}
					>
						{editingUseRaw ? 'Use Builder' : 'Use Raw Type'}
					</Button>
				</div>
				<div class="text-xs text-muted-foreground">
					Choose a type from the dropdowns. Use raw mode only when you need a flow-spec expression not covered by the builder.
				</div>

				{#if !editingUseRaw && editingBuilder}
					{@const builder = editingBuilder}
					<div class="space-y-3 rounded-md border bg-muted/20 p-3">
						<div class="flex flex-wrap gap-1">
							{#each ['single', 'list', 'record', 'listRecord', 'map'] as kind}
								<Button
									type="button"
									variant={builder.kind === kind ? 'default' : 'outline'}
									size="sm"
									class="h-7 px-2 text-xs"
									onclick={() => setBuilderKind(builder, kind as BuilderKind)}
								>
									{kind === 'single'
										? 'Single Value'
										: kind === 'list'
											? 'List'
											: kind === 'record'
												? 'Record'
												: kind === 'listRecord'
													? 'List of Records'
													: 'Map'}
								</Button>
							{/each}
						</div>

						<div class="grid gap-2 md:grid-cols-[auto,1fr]">
							<div
								class="border-input bg-background flex h-9 items-center justify-between gap-2 rounded-md border px-3 text-sm shadow-xs"
							>
								<span>Optional</span>
								<Switch
									checked={builder.optional}
									onCheckedChange={(value) => setBuilderOptional(builder, !!value)}
								/>
							</div>
							{#if builder.kind === 'single'}
								<Select
									class="h-9 rounded-md border bg-background px-3 text-sm"
									value={builder.singleType}
									onchange={(event) =>
										handleTypeSelection(
											(event.currentTarget as HTMLSelectElement).value,
											{ kind: 'single' },
										)}
								>
									<optgroup label="Built-in">
										{#each builtInTypeOptions() as option}
											<option value={option.expr}>{option.label}</option>
										{/each}
									</optgroup>
									{#if userCustomTypeOptions().length > 0}
										<optgroup label="Custom">
											{#each userCustomTypeOptions() as option}
												<option value={option.expr}>{option.label}</option>
											{/each}
										</optgroup>
									{/if}
									{#if importedTypeOptions().length > 0}
										<optgroup label="Imported From Flow">
											{#each importedTypeOptions() as option}
												<option value={option.expr}>{option.label}</option>
											{/each}
										</optgroup>
									{/if}
									<option value={NEW_CUSTOM_TYPE_VALUE}>+ Create Custom Type</option>
								</Select>
							{:else if builder.kind === 'list'}
								<Select
									class="h-9 rounded-md border bg-background px-3 text-sm"
									value={builder.listItemType}
									onchange={(event) =>
										handleTypeSelection(
											(event.currentTarget as HTMLSelectElement).value,
											{ kind: 'list' },
										)}
								>
									<optgroup label="Built-in">
										{#each builtInTypeOptions() as option}
											<option value={option.expr}>{option.label}</option>
										{/each}
									</optgroup>
									{#if userCustomTypeOptions().length > 0}
										<optgroup label="Custom">
											{#each userCustomTypeOptions() as option}
												<option value={option.expr}>{option.label}</option>
											{/each}
										</optgroup>
									{/if}
									{#if importedTypeOptions().length > 0}
										<optgroup label="Imported From Flow">
											{#each importedTypeOptions() as option}
												<option value={option.expr}>{option.label}</option>
											{/each}
										</optgroup>
									{/if}
									<option value={NEW_CUSTOM_TYPE_VALUE}>+ Create Custom Type</option>
								</Select>
							{:else if builder.kind === 'map'}
								<div class="grid gap-2 md:grid-cols-2">
									<Select
										class="h-9 rounded-md border bg-background px-3 text-sm"
										value={builder.mapKeyType}
										onchange={(event) =>
											handleTypeSelection(
												(event.currentTarget as HTMLSelectElement).value,
												{ kind: 'mapKey' },
											)}
									>
										<optgroup label="Built-in">
											{#each builtInTypeOptions() as option}
												<option value={option.expr}>{option.label}</option>
											{/each}
										</optgroup>
										{#if userCustomTypeOptions().length > 0}
											<optgroup label="Custom">
												{#each userCustomTypeOptions() as option}
													<option value={option.expr}>{option.label}</option>
												{/each}
											</optgroup>
										{/if}
										{#if importedTypeOptions().length > 0}
											<optgroup label="Imported From Flow">
												{#each importedTypeOptions() as option}
													<option value={option.expr}>{option.label}</option>
												{/each}
											</optgroup>
										{/if}
										<option value={NEW_CUSTOM_TYPE_VALUE}>+ Create Custom Type</option>
									</Select>
									<Select
										class="h-9 rounded-md border bg-background px-3 text-sm"
										value={builder.mapValueType}
										onchange={(event) =>
											handleTypeSelection(
												(event.currentTarget as HTMLSelectElement).value,
												{ kind: 'mapValue' },
											)}
									>
										<optgroup label="Built-in">
											{#each builtInTypeOptions() as option}
												<option value={option.expr}>{option.label}</option>
											{/each}
										</optgroup>
										{#if userCustomTypeOptions().length > 0}
											<optgroup label="Custom">
												{#each userCustomTypeOptions() as option}
													<option value={option.expr}>{option.label}</option>
												{/each}
											</optgroup>
										{/if}
										{#if importedTypeOptions().length > 0}
											<optgroup label="Imported From Flow">
												{#each importedTypeOptions() as option}
													<option value={option.expr}>{option.label}</option>
												{/each}
											</optgroup>
										{/if}
										<option value={NEW_CUSTOM_TYPE_VALUE}>+ Create Custom Type</option>
									</Select>
								</div>
							{/if}
						</div>

						{#if builder.kind === 'record' || builder.kind === 'listRecord'}
							<div class="rounded-md border bg-background p-2">
								<div class="mb-2 flex items-center justify-between text-xs font-medium">
									<span>Record Fields</span>
									<Button
										type="button"
										variant="outline"
										size="sm"
										class="h-7 px-2 text-xs"
										onclick={() => addBuilderField(builder)}
									>
										<PlusIcon class="size-3" />
										Add Field
									</Button>
								</div>
								<div class="space-y-2">
									{#each builder.fields as field, index}
										<div class="grid gap-2 md:grid-cols-[1fr,1fr,auto,auto]">
											<Input
												value={field.name}
												placeholder="field name"
												oninput={(event) =>
													updateBuilderField(builder, index, 'name', event.currentTarget.value)}
											/>
											<Select
												class="h-9 rounded-md border bg-background px-3 text-sm"
												value={field.type}
												onchange={(event) => {
													const value = (event.currentTarget as HTMLSelectElement).value
													if (value === NEW_CUSTOM_TYPE_VALUE) {
														customEditorTarget = { kind: 'field', fieldIndex: index }
														customTypeName = ''
														customTypeRaw = 'String'
														customTypeBuilder = parseTypeBuilderModel('String')
														customTypeUseRaw = false
														customTypeError = null
														customTypeEditorOpen = true
													} else {
														updateBuilderField(builder, index, 'type', value)
													}
												}}
											>
												<optgroup label="Built-in">
													{#each builtInTypeOptions() as option}
														<option value={option.expr}>{option.label}</option>
													{/each}
												</optgroup>
												{#if userCustomTypeOptions().length > 0}
													<optgroup label="Custom">
														{#each userCustomTypeOptions() as option}
															<option value={option.expr}>{option.label}</option>
														{/each}
													</optgroup>
												{/if}
												{#if importedTypeOptions().length > 0}
													<optgroup label="Imported From Flow">
														{#each importedTypeOptions() as option}
															<option value={option.expr}>{option.label}</option>
														{/each}
													</optgroup>
												{/if}
												<option value={NEW_CUSTOM_TYPE_VALUE}>+ Create Custom Type</option>
											</Select>
											<label class="flex items-center gap-2 rounded-md border px-2 text-xs">
												<Checkbox
													checked={field.optional}
													onCheckedChange={(value) =>
														updateBuilderField(builder, index, 'optional', !!value)}
												/>
												Optional
											</label>
											<Button
												type="button"
												variant="ghost"
												size="icon"
												onclick={() => removeBuilderField(builder, index)}
											>
												<TrashIcon class="size-4" />
											</Button>
										</div>
									{/each}
								</div>
							</div>
						{/if}
					</div>
				{:else}
					<div class="space-y-2 rounded-md border bg-muted/20 p-3">
						<Input bind:value={editingTypeRaw} placeholder="Raw type expression" />
						<div class="text-xs text-muted-foreground">
							Use raw mode for custom expressions the builder cannot represent.
						</div>
					</div>
				{/if}
			</div>

			{#if true}
				{@const parsed = parseFlowType(currentEditingType())}
				{@const inputValidation = validateEditingInput()}
				<div class="flex flex-wrap items-center gap-2">
					{#if parsed.node}
						{@const friendly = friendlyFlowType(parsed.node)}
						{@const raw = serializeFlowType(parsed.node)}
						<Badge variant="secondary">{friendly}</Badge>
						{#if friendly.toLowerCase() !== raw.toLowerCase()}
							<Badge variant="outline" class="max-w-full truncate">{raw}</Badge>
						{/if}
					{:else}
						<Badge variant="destructive">Type parse error</Badge>
						<span class="text-xs text-destructive">{parsed.error}</span>
					{/if}
				</div>
				{#if !inputValidation.valid}
					<div class="mt-2 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
						{#each inputValidation.errors as item}
							<div>{item}</div>
						{/each}
					</div>
				{/if}
			{/if}
		</div>

		<Dialog.Footer class="border-t px-6 py-4">
			<Button variant="outline" onclick={closeInputEditor}>Cancel</Button>
			<Button onclick={saveInputEditor} disabled={!validateEditingInput().valid}>Save Input</Button>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>

<Dialog.Root bind:open={customTypeEditorOpen} onOpenChange={(open) => !open && closeCustomTypeEditor()}>
	<Dialog.Content class="max-h-[85vh] w-[95vw] max-w-2xl overflow-hidden p-0 sm:w-full">
		<Dialog.Header class="px-6 pt-6">
			<Dialog.Title>Create Custom Type</Dialog.Title>
			<Dialog.Description>
				Create a reusable alias for a flow-spec type expression. This affects editor UX only; YAML still saves concrete expressions.
			</Dialog.Description>
		</Dialog.Header>
		<div class="space-y-4 overflow-y-auto px-6 pb-4">
			<div class="space-y-1">
				<div class="text-sm font-medium">Custom type name</div>
				<Input bind:value={customTypeName} placeholder="e.g. ParticipantRow" />
				<div class="text-xs text-muted-foreground">
					Readable label shown in type pickers.
				</div>
			</div>
			<div class="flex items-center justify-between">
				<div class="text-sm font-medium">Definition</div>
				<Button
					type="button"
					variant="outline"
					size="sm"
					onclick={() => {
						customTypeUseRaw = !customTypeUseRaw
						if (!customTypeUseRaw && !customTypeBuilder) {
							customTypeBuilder = parseTypeBuilderModel(customTypeRaw)
						}
					}}
				>
					{customTypeUseRaw ? 'Use Builder' : 'Use Raw Type'}
				</Button>
			</div>
			{#if !customTypeUseRaw && customTypeBuilder}
				{@const builder = customTypeBuilder}
				<div class="space-y-3 rounded-md border bg-muted/20 p-3">
					<div class="flex flex-wrap gap-1">
						{#each ['single', 'list', 'record', 'listRecord', 'map'] as kind}
							<Button
								type="button"
								variant={builder.kind === kind ? 'default' : 'outline'}
								size="sm"
								class="h-7 px-2 text-xs"
								onclick={() => setCustomBuilderKind(builder, kind as BuilderKind)}
							>
								{kind === 'single'
									? 'Single Value'
									: kind === 'list'
										? 'List'
										: kind === 'record'
											? 'Record'
											: kind === 'listRecord'
												? 'List of Records'
												: 'Map'}
							</Button>
						{/each}
					</div>
					<div class="grid gap-2 md:grid-cols-[auto,1fr]">
						<div
							class="border-input bg-background flex h-9 items-center justify-between gap-2 rounded-md border px-3 text-sm shadow-xs"
						>
							<span>Optional</span>
							<Switch
								checked={builder.optional}
								onCheckedChange={(value) => setCustomBuilderOptional(builder, !!value)}
							/>
						</div>
						{#if builder.kind === 'single'}
							<Select
								class="h-9 rounded-md border bg-background px-3 text-sm"
								value={builder.singleType}
								onchange={(event) => setCustomBuilderType(builder, 'single', (event.currentTarget as HTMLSelectElement).value)}
							>
								<optgroup label="Built-in">
									{#each builtInTypeOptions() as option}
										<option value={option.expr}>{option.label}</option>
									{/each}
								</optgroup>
								{#if userCustomTypeOptions().length > 0}
									<optgroup label="Custom">
										{#each userCustomTypeOptions() as option}
											<option value={option.expr}>{option.label}</option>
										{/each}
									</optgroup>
								{/if}
								{#if importedTypeOptions().length > 0}
									<optgroup label="Imported From Flow">
										{#each importedTypeOptions() as option}
											<option value={option.expr}>{option.label}</option>
										{/each}
									</optgroup>
								{/if}
							</Select>
						{:else if builder.kind === 'list'}
							<Select
								class="h-9 rounded-md border bg-background px-3 text-sm"
								value={builder.listItemType}
								onchange={(event) => setCustomBuilderType(builder, 'list', (event.currentTarget as HTMLSelectElement).value)}
							>
								<optgroup label="Built-in">
									{#each builtInTypeOptions() as option}
										<option value={option.expr}>{option.label}</option>
									{/each}
								</optgroup>
								{#if userCustomTypeOptions().length > 0}
									<optgroup label="Custom">
										{#each userCustomTypeOptions() as option}
											<option value={option.expr}>{option.label}</option>
										{/each}
									</optgroup>
								{/if}
								{#if importedTypeOptions().length > 0}
									<optgroup label="Imported From Flow">
										{#each importedTypeOptions() as option}
											<option value={option.expr}>{option.label}</option>
										{/each}
									</optgroup>
								{/if}
							</Select>
						{:else if builder.kind === 'map'}
							<div class="grid gap-2 md:grid-cols-2">
								<Select
									class="h-9 rounded-md border bg-background px-3 text-sm"
									value={builder.mapKeyType}
									onchange={(event) => setCustomBuilderType(builder, 'mapKey', (event.currentTarget as HTMLSelectElement).value)}
								>
									<optgroup label="Built-in">
										{#each builtInTypeOptions() as option}
											<option value={option.expr}>{option.label}</option>
										{/each}
									</optgroup>
									{#if userCustomTypeOptions().length > 0}
										<optgroup label="Custom">
											{#each userCustomTypeOptions() as option}
												<option value={option.expr}>{option.label}</option>
											{/each}
										</optgroup>
									{/if}
									{#if importedTypeOptions().length > 0}
										<optgroup label="Imported From Flow">
											{#each importedTypeOptions() as option}
												<option value={option.expr}>{option.label}</option>
											{/each}
										</optgroup>
									{/if}
								</Select>
								<Select
									class="h-9 rounded-md border bg-background px-3 text-sm"
									value={builder.mapValueType}
									onchange={(event) => setCustomBuilderType(builder, 'mapValue', (event.currentTarget as HTMLSelectElement).value)}
								>
									<optgroup label="Built-in">
										{#each builtInTypeOptions() as option}
											<option value={option.expr}>{option.label}</option>
										{/each}
									</optgroup>
									{#if userCustomTypeOptions().length > 0}
										<optgroup label="Custom">
											{#each userCustomTypeOptions() as option}
												<option value={option.expr}>{option.label}</option>
											{/each}
										</optgroup>
									{/if}
									{#if importedTypeOptions().length > 0}
										<optgroup label="Imported From Flow">
											{#each importedTypeOptions() as option}
												<option value={option.expr}>{option.label}</option>
											{/each}
										</optgroup>
									{/if}
								</Select>
							</div>
						{/if}
					</div>
					{#if builder.kind === 'record' || builder.kind === 'listRecord'}
						<div class="rounded-md border bg-background p-2">
							<div class="mb-2 flex items-center justify-between text-xs font-medium">
								<span>Record Fields</span>
								<Button type="button" variant="outline" size="sm" class="h-7 px-2 text-xs" onclick={() => addCustomBuilderField(builder)}>
									<PlusIcon class="size-3" />
									Add Field
								</Button>
							</div>
							<div class="space-y-2">
								{#each builder.fields as field, index}
									<div class="grid gap-2 md:grid-cols-[1fr,1fr,auto,auto]">
										<Input value={field.name} placeholder="field name" oninput={(event) => updateCustomBuilderField(builder, index, 'name', event.currentTarget.value)} />
										<Select
											class="h-9 rounded-md border bg-background px-3 text-sm"
											value={field.type}
											onchange={(event) => updateCustomBuilderField(builder, index, 'type', (event.currentTarget as HTMLSelectElement).value)}
										>
											<optgroup label="Built-in">
												{#each builtInTypeOptions() as option}
													<option value={option.expr}>{option.label}</option>
												{/each}
											</optgroup>
											{#if userCustomTypeOptions().length > 0}
												<optgroup label="Custom">
													{#each userCustomTypeOptions() as option}
														<option value={option.expr}>{option.label}</option>
													{/each}
												</optgroup>
											{/if}
											{#if importedTypeOptions().length > 0}
												<optgroup label="Imported From Flow">
													{#each importedTypeOptions() as option}
														<option value={option.expr}>{option.label}</option>
													{/each}
												</optgroup>
											{/if}
										</Select>
										<label class="flex items-center gap-2 rounded-md border px-2 text-xs">
											<Checkbox
												checked={field.optional}
												onCheckedChange={(value) => updateCustomBuilderField(builder, index, 'optional', !!value)}
											/>
											Optional
										</label>
										<Button type="button" variant="ghost" size="icon" onclick={() => removeCustomBuilderField(builder, index)}>
											<TrashIcon class="size-4" />
										</Button>
									</div>
								{/each}
							</div>
						</div>
					{/if}
				</div>
			{:else}
				<Input bind:value={customTypeRaw} placeholder="Raw type expression" />
			{/if}
			{#if customTypeError}
				<div class="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
					{customTypeError}
				</div>
			{/if}
		</div>
		<Dialog.Footer class="border-t px-6 py-4">
			<Button variant="outline" onclick={closeCustomTypeEditor}>Cancel</Button>
			<Button onclick={saveCustomType}>Save Custom Type</Button>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>

{#if currentFlow}
	<RunFlowDialog
		bind:open={runDialogOpen}
		pipelineId={currentFlow.id}
		pipelineName={currentFlow.name}
		onRunStarted={refreshRuns}
	/>
{/if}
