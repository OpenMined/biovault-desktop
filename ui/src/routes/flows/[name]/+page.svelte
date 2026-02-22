<script lang="ts">
	import { page } from '$app/stores'
	import { goto } from '$app/navigation'
	import { invoke } from '@tauri-apps/api/core'
	import { onMount } from 'svelte'
	import { Button } from '$lib/components/ui/button/index.js'
	import * as Card from '$lib/components/ui/card/index.js'
	import { Badge } from '$lib/components/ui/badge/index.js'
	import { Input } from '$lib/components/ui/input/index.js'
	import { Textarea } from '$lib/components/ui/textarea/index.js'
	import { Checkbox } from '$lib/components/ui/checkbox/index.js'
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
	interface RecordTypeModel {
		container: 'record' | 'listRecord'
		outerOptional: boolean
		fields: EditableField[]
	}
	interface ListTypeModel {
		outerOptional: boolean
		itemType: string
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

	let runs = $state<PipelineRun[]>([])
	let refreshingRuns = $state(false)
	const commonTypePresets = [
		'File',
		'Directory',
		'String',
		'Bool',
		'List[GenotypeRecord]',
		'List[File]',
		'List[String]',
		'Record{participant_id: String, aligned_file: File}',
		'List[Record{participant_id: String, aligned_file: File}]',
	]

	function clone<T>(value: T): T {
		return JSON.parse(JSON.stringify(value)) as T
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

	function addInput() {
		setSpec((draft) => {
			let idx = 1
			let candidate = `input_${idx}`
			while (candidate in draft.inputs) {
				idx += 1
				candidate = `input_${idx}`
			}
			draft.inputs[candidate] = 'File'
		})
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

	function updateInput(name: string, key: 'type' | 'default', value: string) {
		setSpec((draft) => {
			const parsed = parseInputSpec(draft.inputs[name])
			if (key === 'type') {
				parsed.type = value
			} else {
				parsed.defaultValue = value
			}
			draft.inputs[name] = buildInputSpec(parsed.type, parsed.defaultValue)
		})
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

	function parseRecordTypeModel(typeRaw: string): RecordTypeModel | null {
		const parsed = parseFlowType(typeRaw)
		if (!parsed.node) return null
		const outer = unwrapOptional(parsed.node)
		if (outer.node.kind === 'record') {
			return {
				container: 'record',
				outerOptional: outer.optional,
				fields: outer.node.fields.map(toEditableField),
			}
		}
		if (outer.node.kind === 'list') {
			const inner = unwrapOptional(outer.node.item)
			if (inner.node.kind === 'record') {
				return {
					container: 'listRecord',
					outerOptional: outer.optional,
					fields: inner.node.fields.map(toEditableField),
				}
			}
		}
		return null
	}

	function serializeRecordTypeModel(model: RecordTypeModel): string {
		const fields = model.fields
			.filter((field) => field.name.trim().length > 0)
			.map((field) => {
				let node = safeParseType(field.type)
				if (field.optional) node = { kind: 'optional', inner: node }
				return { name: field.name.trim(), type: node }
			})
		let node: FlowTypeNode = { kind: 'record', fields }
		if (model.container === 'listRecord') {
			node = { kind: 'list', item: node }
		}
		if (model.outerOptional) {
			node = { kind: 'optional', inner: node }
		}
		return serializeFlowType(node)
	}

	function parseListTypeModel(typeRaw: string): ListTypeModel | null {
		const parsed = parseFlowType(typeRaw)
		if (!parsed.node) return null
		const outer = unwrapOptional(parsed.node)
		if (outer.node.kind !== 'list') return null
		const item = unwrapOptional(outer.node.item)
		if (item.node.kind === 'record') return null
		return {
			outerOptional: outer.optional,
			itemType: serializeFlowType(item.node),
		}
	}

	function serializeListTypeModel(model: ListTypeModel): string {
		let node: FlowTypeNode = { kind: 'list', item: safeParseType(model.itemType) }
		if (model.outerOptional) node = { kind: 'optional', inner: node }
		return serializeFlowType(node)
	}

	function setRecordModelType(inputName: string, model: RecordTypeModel) {
		updateInput(inputName, 'type', serializeRecordTypeModel(model))
	}

	function setListModelType(inputName: string, model: ListTypeModel) {
		updateInput(inputName, 'type', serializeListTypeModel(model))
	}

	function addRecordField(inputName: string, model: RecordTypeModel) {
		const next = clone(model)
		next.fields.push({ name: `field_${next.fields.length + 1}`, type: 'String', optional: false })
		setRecordModelType(inputName, next)
	}

	function removeRecordField(inputName: string, model: RecordTypeModel, index: number) {
		const next = clone(model)
		next.fields.splice(index, 1)
		setRecordModelType(inputName, next)
	}

	function updateRecordField(
		inputName: string,
		model: RecordTypeModel,
		index: number,
		key: 'name' | 'type' | 'optional',
		value: string | boolean,
	) {
		const next = clone(model)
		if (!next.fields[index]) return
		if (key === 'optional') {
			next.fields[index].optional = Boolean(value)
		} else if (key === 'name') {
			next.fields[index].name = String(value)
		} else {
			next.fields[index].type = String(value)
		}
		setRecordModelType(inputName, next)
	}

	function setListItemType(inputName: string, model: ListTypeModel, itemType: string) {
		const next = clone(model)
		next.itemType = itemType
		setListModelType(inputName, next)
	}

	function setListOptional(inputName: string, model: ListTypeModel, optional: boolean) {
		const next = clone(model)
		next.outerOptional = optional
		setListModelType(inputName, next)
	}

	function useTypePreset(inputName: string, preset: string) {
		updateInput(inputName, 'type', preset)
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
					disabled={saving || (mode === 'guided' ? !guidedDirty : !yamlIsDirty())}
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
								<Button variant="outline" size="sm" onclick={addInput}>
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
									{@const recordModel = parseRecordTypeModel(parsed.type)}
									{@const listModel = parseListTypeModel(parsed.type)}
									<div class="space-y-3 rounded-md border p-3">
										<div class="grid gap-2 md:grid-cols-[1fr,1.4fr,1fr,auto]">
											<Input value={name} onblur={(event) => renameInput(name, event.currentTarget.value)} />
											<Input
												placeholder="Type"
												value={parsed.type}
												list="flow-type-presets"
												oninput={(event) => updateInput(name, 'type', event.currentTarget.value)}
											/>
											<Input
												placeholder="Default"
												value={parsed.defaultValue}
												oninput={(event) => updateInput(name, 'default', event.currentTarget.value)}
											/>
											<Button variant="ghost" size="icon" onclick={() => removeInput(name)}>
												<TrashIcon class="size-4" />
											</Button>
										</div>

										<div class="flex flex-wrap items-center gap-2">
											{#if typeParsed.node}
												<Badge variant="secondary">{friendlyFlowType(typeParsed.node)}</Badge>
												<Badge variant="outline">{serializeFlowType(typeParsed.node)}</Badge>
											{:else if typeParsed.error}
												<Badge variant="destructive">Type parse error</Badge>
												<span class="text-xs text-destructive">{typeParsed.error}</span>
											{/if}
										</div>

										<div class="flex flex-wrap gap-1">
											{#each commonTypePresets as preset}
												<Button
													type="button"
													variant="outline"
													size="sm"
													class="h-7 px-2 text-xs"
													onclick={() => useTypePreset(name, preset)}
												>
													{preset}
												</Button>
											{/each}
										</div>

										{#if recordModel}
											<div class="rounded-md border bg-muted/30 p-2">
												<div class="mb-2 flex items-center justify-between text-xs font-medium">
													<span>Record Fields</span>
													<Button
														type="button"
														variant="outline"
														size="sm"
														class="h-7 px-2 text-xs"
														onclick={() => addRecordField(name, recordModel)}
													>
														<PlusIcon class="size-3" />
														Add Field
													</Button>
												</div>
												<div class="space-y-2">
													{#each recordModel.fields as field, index}
														<div class="grid gap-2 md:grid-cols-[1fr,1fr,auto,auto]">
															<Input
																value={field.name}
																placeholder="field name"
																oninput={(event) =>
																	updateRecordField(
																		name,
																		recordModel,
																		index,
																		'name',
																		event.currentTarget.value,
																	)}
															/>
															<Input
																value={field.type}
																list="flow-type-presets"
																placeholder="field type"
																oninput={(event) =>
																	updateRecordField(
																		name,
																		recordModel,
																		index,
																		'type',
																		event.currentTarget.value,
																	)}
															/>
															<label class="flex items-center gap-2 rounded-md border px-2 text-xs">
																<Checkbox
																	checked={field.optional}
																	onCheckedChange={(value) =>
																		updateRecordField(name, recordModel, index, 'optional', !!value)}
																/>
																Optional
															</label>
															<Button
																type="button"
																variant="ghost"
																size="icon"
																onclick={() => removeRecordField(name, recordModel, index)}
															>
																<TrashIcon class="size-4" />
															</Button>
														</div>
													{/each}
												</div>
											</div>
										{:else if listModel}
											<div class="rounded-md border bg-muted/30 p-2">
												<div class="mb-2 text-xs font-medium">List Item Type</div>
												<div class="grid gap-2 md:grid-cols-[1fr,auto]">
													<Input
														value={listModel.itemType}
														list="flow-type-presets"
														placeholder="item type"
														oninput={(event) => setListItemType(name, listModel, event.currentTarget.value)}
													/>
													<label class="flex items-center gap-2 rounded-md border px-2 text-xs">
														<Checkbox
															checked={listModel.outerOptional}
															onCheckedChange={(value) => setListOptional(name, listModel, !!value)}
														/>
														Optional List
													</label>
												</div>
											</div>
										{/if}
									</div>
								{/each}
							</div>
							<datalist id="flow-type-presets">
								{#each commonTypePresets as preset}
									<option value={preset}></option>
								{/each}
							</datalist>
						</Card.Content>
					</Card.Root>
				{:else if section === 'steps'}
					<div class="grid gap-4 lg:grid-cols-[320px,1fr]">
						<Card.Root>
							<Card.Header>
								<div class="flex items-center justify-between">
									<Card.Title>Step Graph</Card.Title>
									<Button variant="outline" size="sm" onclick={addStep}>
										<PlusIcon class="size-4" />
										Add Step
									</Button>
								</div>
							</Card.Header>
							<Card.Content>
								<div class="space-y-2">
									{#if editorSpec.steps.length === 0}
										<p class="text-sm text-muted-foreground">No steps yet.</p>
									{/if}
									{#each editorSpec.steps as step, index}
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
									<div class="space-y-4">
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
												<Input
													value={step.uses ?? ''}
													list="module-suggestions"
													oninput={(event) =>
														updateStepField(selectedStepIndex, 'uses', event.currentTarget.value)}
												/>
												<datalist id="module-suggestions">
													{#each editorPayload.modules as module}
														<option value={module.name}></option>
													{/each}
												</datalist>
											</div>
										</div>

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
										</div>

										<div class="space-y-2">
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
						</Card.Header>
						<Card.Content>
							<div class="space-y-2">
								{#each editorSpec.datasites as datasite, index}
									<div class="grid gap-2 md:grid-cols-[1fr,auto]">
										<Input value={datasite} oninput={(event) => updateDatasite(index, event.currentTarget.value)} />
										<Button variant="ghost" size="icon" onclick={() => removeDatasite(index)}>
											<TrashIcon class="size-4" />
										</Button>
									</div>
								{/each}
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

{#if currentFlow}
	<RunFlowDialog
		bind:open={runDialogOpen}
		pipelineId={currentFlow.id}
		pipelineName={currentFlow.name}
		onRunStarted={refreshRuns}
	/>
{/if}
