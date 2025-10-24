export function createPipelinesModule({ invoke, dialog, open: _open, navigateTo }) {
	// State management
	const pipelineState = {
		pipelines: [],
		currentPipeline: null,
		wizardStep: 0,
		wizardData: {
			name: '',
			inputs: {},
			steps: [],
		},
	}

	// Tab switching functionality
	function initTabNavigation() {
		const tabs = document.querySelectorAll('.run-tab')
		const contents = document.querySelectorAll('.run-tab-content')

		tabs.forEach((tab) => {
			tab.addEventListener('click', () => {
				const targetTab = tab.dataset.tab

				// Update active tab
				tabs.forEach((t) => t.classList.remove('active'))
				tab.classList.add('active')

				// Show corresponding content
				contents.forEach((content) => {
					if (content.id === `${targetTab}-view`) {
						content.style.display = 'block'
						// Load content when tab is activated
						if (targetTab === 'pipelines') {
							loadPipelines()
						}
					} else {
						content.style.display = 'none'
					}
				})
			})
		})
	}

	// Load pipelines list
	async function loadPipelines() {
		try {
			const pipelines = await invoke('get_pipelines')
			const container = document.getElementById('pipelines-list')

			if (!container) {
				console.error('pipelines-list container not found')
				return
			}

			if (!pipelines || pipelines.length === 0) {
				container.innerHTML =
					'<p style="color: #666; padding: 20px; text-align: center">No pipelines yet. Create one to get started.</p>'
				return
			}

			container.innerHTML = ''

			pipelines.forEach((pipeline) => {
				const stepCount = pipeline.spec?.steps?.length || 0

				const card = document.createElement('div')
				card.className = 'project-item'
				card.style.cursor = 'pointer'

				const description =
					pipeline.spec?.description ||
					`Pipeline with ${stepCount} ${stepCount === 1 ? 'step' : 'steps'}`

				card.innerHTML = `
					<div style="flex: 1;">
						<div class="project-header">
							<strong>${pipeline.name}</strong>
						</div>
						<div class="project-meta">
							${description}
						</div>
					</div>
					<div class="project-actions" style="display: flex; gap: 8px;">
						<button class="secondary-btn" onclick="event.stopPropagation(); pipelineModule.runPipeline(${pipeline.id})" title="Run Pipeline">▶ Run</button>
						<button class="secondary-btn" onclick="event.stopPropagation(); pipelineModule.deletePipeline(${pipeline.id})" title="Delete">Delete</button>
					</div>
				`

				card.addEventListener('click', () => {
					// Open folder on click
					pipelineModule.openPipelineFolder(pipeline.pipeline_path)
				})

				container.appendChild(card)
			})

			// Update pipeline count badges
			const pipelineCountBadges = document.querySelectorAll('#pipelines-count')
			pipelineCountBadges.forEach((badge) => {
				badge.textContent = pipelines.length
			})

			pipelineState.pipelines = pipelines
		} catch (error) {
			console.error('Error loading pipelines:', error)
		}
	}

	// Create pipeline wizard - SIMPLIFIED
	async function showCreatePipelineWizard() {
		const modalHtml = `
			<div id="simple-pipeline-modal" class="modal-overlay" style="display: flex;">
				<div class="modal-content" style="width: 400px;">
					<div class="modal-header">
						<h2>New Pipeline</h2>
						<button class="modal-close" onclick="pipelineModule.closeSimplePipelineModal()">×</button>
					</div>
					<div class="modal-body">
						<label style="display: block; margin-bottom: 8px; font-weight: 600;">
							Pipeline Name *
						</label>
						<input 
							type="text" 
							id="simple-pipeline-name" 
							placeholder="my-analysis-pipeline"
							autocapitalize="off"
							autocomplete="off"
							autocorrect="off"
							style="width: 100%; padding: 8px 12px; border: 1px solid #e5e7eb; border-radius: 6px; font-size: 14px; box-sizing: border-box;"
						>
						<p style="font-size: 13px; color: #6b7280; margin-top: 8px;">
							A blank pipeline template will be created with this name.
						</p>
					</div>
					<div class="modal-footer">
						<button class="secondary-btn" onclick="pipelineModule.closeSimplePipelineModal()">Cancel</button>
						<button class="btn-primary" onclick="pipelineModule.createSimplePipeline()">Create Pipeline</button>
					</div>
				</div>
			</div>
		`

		document.body.insertAdjacentHTML('beforeend', modalHtml)

		// Focus on input
		setTimeout(() => {
			const input = document.getElementById('simple-pipeline-name')
			if (input) {
				input.focus()
				input.addEventListener('keypress', (e) => {
					if (e.key === 'Enter') {
						pipelineModule.createSimplePipeline()
					}
				})
			}
		}, 100)
	}

	// Close simple pipeline modal
	function closeSimplePipelineModal() {
		const modal = document.getElementById('simple-pipeline-modal')
		if (modal) modal.remove()
	}

	// Create simple pipeline with just a name
	async function createSimplePipeline() {
		const nameInput = document.getElementById('simple-pipeline-name')
		if (!nameInput) return

		const name = nameInput.value.trim()
		if (!name) {
			alert('Please enter a pipeline name')
			return
		}

		try {
			// Create pipeline spec matching CLI PipelineSpec structure exactly
			// Corresponds to: pub struct PipelineSpec { pub name: String, context: Option, inputs: BTreeMap, steps: Vec }
			const spec = {
				name: name,
				// context is optional, omit for blank pipeline
				// inputs defaults to empty BTreeMap in CLI
				inputs: {},
				// steps defaults to empty Vec in CLI
				steps: [],
			}

			// Invoke the create pipeline command - must match CLI behavior
			const result = await invoke('create_pipeline', {
				request: {
					name: name,
					directory: null,
				},
			})

			// Save the pipeline spec
			await invoke('save_pipeline_editor', {
				pipelineId: result.id,
				pipelinePath: result.pipeline_path,
				spec: spec,
			})

			if (result) {
				closeSimplePipelineModal()
				// Reload pipelines to show the new one
				await loadPipelines()
			}
		} catch (error) {
			console.error('Error creating pipeline:', error)
			alert('Failed to create pipeline: ' + error.message)
		}
	}

	// Wizard navigation
	function wizardNext() {
		if (pipelineState.wizardStep < 3) {
			// Validate current step
			if (pipelineState.wizardStep === 0) {
				const name = document.getElementById('pipeline-name').value.trim()
				if (!name) {
					alert('Please enter a pipeline name')
					return
				}
				pipelineState.wizardData.name = name
			}

			pipelineState.wizardStep++
			updateWizardView()
		}
	}

	function wizardBack() {
		if (pipelineState.wizardStep > 0) {
			pipelineState.wizardStep--
			updateWizardView()
		}
	}

	function updateWizardView() {
		// Hide all steps
		document.querySelectorAll('.wizard-step').forEach((step) => {
			step.style.display = 'none'
		})

		// Show current step
		document.getElementById(`step-${pipelineState.wizardStep}`).style.display = 'block'

		// Update buttons
		const backBtn = document.getElementById('wizard-back')
		const nextBtn = document.getElementById('wizard-next')
		const createBtn = document.getElementById('wizard-create')

		backBtn.disabled = pipelineState.wizardStep === 0

		if (pipelineState.wizardStep === 3) {
			nextBtn.style.display = 'none'
			createBtn.style.display = 'inline-block'
			updatePipelinePreview()
		} else {
			nextBtn.style.display = 'inline-block'
			createBtn.style.display = 'none'
		}
	}

	// Add pipeline input
	function addPipelineInput() {
		// Suggest common inputs based on steps
		const suggestedInputs = []
		pipelineState.wizardData.steps.forEach((step) => {
			Object.keys(step.with).forEach((inputKey) => {
				const value = step.with[inputKey]
				if (value.startsWith('inputs.')) {
					const inputName = value.replace('inputs.', '')
					if (!pipelineState.wizardData.inputs[inputName] && !suggestedInputs.includes(inputName)) {
						suggestedInputs.push(inputName)
					}
				}
			})
		})

		let inputName
		if (suggestedInputs.length > 0) {
			inputName = prompt(
				'Input name (suggested: ' + suggestedInputs.join(', ') + '):\n' + 'Or enter a custom name:',
			)
		} else {
			inputName = prompt('Input name (e.g., samplesheet, data_dir):')
		}
		if (!inputName) return

		const inputType = prompt('Input type (File, Directory, String):', 'File')
		if (!inputType) return

		pipelineState.wizardData.inputs[inputName] = inputType
		updatePipelineInputsList()
	}

	function updatePipelineInputsList() {
		const container = document.getElementById('pipeline-inputs-list')
		container.innerHTML = ''

		Object.entries(pipelineState.wizardData.inputs).forEach(([name, type]) => {
			const div = document.createElement('div')
			div.style.cssText =
				'padding: 10px; background: #f5f5f5; margin-bottom: 10px; border-radius: 4px;'
			div.innerHTML = `
				<strong>${name}</strong>: ${type}
				<button class="delete-btn" style="float: right; padding: 2px 8px;"
					onclick="pipelineModule.removePipelineInput('${name}')">
					Remove
				</button>
			`
			container.appendChild(div)
		})
	}

	function removePipelineInput(name) {
		delete pipelineState.wizardData.inputs[name]
		updatePipelineInputsList()
	}

	// Add pipeline step
	async function addPipelineStep() {
		try {
			// Get available projects from database
			const projects = await invoke('get_projects')

			// Create a modal for step configuration
			const modalHtml = `
				<div id="add-step-modal" class="modal-overlay" style="display: flex;">
					<div class="modal-content" style="width: 600px;">
						<div class="modal-header">
							<h2>Add Pipeline Step</h2>
							<button class="modal-close" onclick="pipelineModule.closeAddStepModal()">×</button>
						</div>
						<div class="modal-body">
							<label style="display: block; margin-bottom: 15px;">
								<span style="display: block; margin-bottom: 5px;">Step ID *</span>
								<input type="text" id="step-id-input" placeholder="e.g., filter, count, analyze" style="width: 100%;">
							</label>

							<label style="display: block; margin-bottom: 15px;">
								<span style="display: block; margin-bottom: 5px;">Select Project *</span>
								<select id="project-select" style="width: 100%; margin-bottom: 10px;">
									<option value="">-- Select from registered projects --</option>
									${projects
										.map(
											(p) =>
												`<option value="${p.project_path}">${p.name} (${p.project_path})</option>`,
										)
										.join('')}
									<option value="browse">-- Browse for project folder/yaml --</option>
								</select>
							</label>

							<div style="display: flex; align-items: center; gap: 10px; margin-bottom: 15px;">
								<span style="color: #666;">OR</span>
								<button class="secondary-btn" onclick="pipelineModule.browseForProject()">
									Browse for Project...
								</button>
							</div>

							<div id="selected-project-path" style="padding: 10px; background: #f5f5f5; border-radius: 4px; margin-bottom: 15px; display: none;">
								<strong>Selected:</strong> <span id="project-path-display"></span>
							</div>

							<div id="step-bindings" style="display: none;">
								<h4>Configure Input Bindings</h4>
								<div id="step-bindings-list"></div>

								<h4 style="margin-top: 20px;">Published Outputs (Optional)</h4>
								<div id="step-publish-list">
									<div style="margin-bottom: 10px;">
										<input type="text" id="publish-output-name" placeholder="e.g., filtered_sheet, counted_sheet" style="width: 100%;">
										<small style="color: #666;">Comma-separated list of outputs to publish from this step</small>
									</div>
								</div>

								<h4 style="margin-top: 20px;">Store to Database (Optional)</h4>
								<div style="padding: 10px; background: #f9f9f9; border-radius: 4px;">
									<label style="display: flex; align-items: center; margin-bottom: 10px;">
										<input type="checkbox" id="enable-store" style="margin-right: 10px;">
										<span>Store output to SQL database</span>
									</label>
									<div id="store-config" style="display: none;">
										<label style="display: block; margin-bottom: 10px;">
											<span style="display: block; margin-bottom: 3px; font-size: 13px;">Store Name:</span>
											<input type="text" id="store-name" placeholder="e.g., counts_sql" style="width: 100%;">
										</label>
										<label style="display: block; margin-bottom: 10px;">
											<span style="display: block; margin-bottom: 3px; font-size: 13px;">Source Output:</span>
											<input type="text" id="store-source" placeholder="e.g., counted_sheet" style="width: 100%;">
										</label>
										<label style="display: block; margin-bottom: 10px;">
											<span style="display: block; margin-bottom: 3px; font-size: 13px;">Table Name:</span>
											<input type="text" id="store-table" placeholder="e.g., pipeline_counts_{run_id}" style="width: 100%;">
										</label>
										<label style="display: block; margin-bottom: 10px;">
											<span style="display: block; margin-bottom: 3px; font-size: 13px;">Key Column:</span>
											<input type="text" id="store-key" placeholder="e.g., participant_id" style="width: 100%;">
										</label>
									</div>
								</div>
							</div>
						</div>
						<div class="modal-footer">
							<button class="secondary-btn" onclick="pipelineModule.closeAddStepModal()">
								Cancel
							</button>
							<button class="primary-btn" onclick="pipelineModule.confirmAddStep()">
								Add Step
							</button>
						</div>
					</div>
				</div>
			`

			// Add modal to page
			const modalContainer = document.createElement('div')
			modalContainer.innerHTML = modalHtml
			document.body.appendChild(modalContainer)

			// Handle project selection change
			document.getElementById('project-select').addEventListener('change', async (e) => {
				if (e.target.value === 'browse') {
					await browseForProject()
				} else if (e.target.value) {
					showSelectedProject(e.target.value)
					// Auto-populate step ID from project name if empty
					const stepIdInput = document.getElementById('step-id-input')
					if (!stepIdInput.value) {
						const projectName = e.target.options[e.target.selectedIndex].text.split(' ')[0]
						stepIdInput.value = projectName.toLowerCase().replace(/[^a-z0-9]/g, '-')
					}
				}
			})

			// Handle store checkbox
			document.getElementById('enable-store').addEventListener('change', (e) => {
				const storeConfig = document.getElementById('store-config')
				storeConfig.style.display = e.target.checked ? 'block' : 'none'

				// Generate smart defaults when enabling store
				if (e.target.checked) {
					const stepId = document.getElementById('step-id-input').value
					const publishOutputs = document
						.getElementById('publish-outputs')
						.value.split(',')
						.map((s) => s.trim())
						.filter((s) => s)

					// Set default store name based on step name
					const storeNameInput = document.getElementById('store-name')
					if (!storeNameInput.value && stepId) {
						storeNameInput.value = `store_${stepId}`
					}

					// Set default source - prefer CSV/sheet related outputs
					const storeSourceInput = document.getElementById('store-source')
					if (!storeSourceInput.value) {
						if (publishOutputs.length === 1) {
							// Only one output, use it
							storeSourceInput.value = publishOutputs[0]
						} else if (publishOutputs.length > 1) {
							// Multiple outputs, find CSV/sheet related one
							const csvRelated = publishOutputs.find(
								(output) =>
									output.includes('csv') ||
									output.includes('sheet') ||
									output.includes('table') ||
									output.includes('data'),
							)
							storeSourceInput.value = csvRelated || publishOutputs[0]
						}
					}

					// Set default table name
					const storeTableInput = document.getElementById('store-table')
					if (!storeTableInput.value && stepId) {
						storeTableInput.value = `${stepId}_{run_id}`
					}

					// Set default key column
					const storeKeyInput = document.getElementById('store-key')
					if (!storeKeyInput.value) {
						storeKeyInput.value = 'participant_id'
					}
				}
			})

			// Store selected project path in state for later use
			pipelineState.tempStepProject = null
			pipelineState.tempStepBindings = {}
		} catch (error) {
			console.error('Error adding step:', error)
			alert('Error loading projects: ' + error)
		}
	}

	// Browse for project folder or yaml file
	async function browseForProject() {
		try {
			const selected = await dialog.open({
				multiple: false,
				directory: false,
				filters: [
					{ name: 'Project Files', extensions: ['yaml', 'yml'] },
					{ name: 'All Files', extensions: ['*'] },
				],
			})

			if (selected) {
				// If user selected a project.yaml file, use the parent directory
				let projectPath = selected
				if (selected.endsWith('.yaml') || selected.endsWith('.yml')) {
					// Get parent directory
					projectPath = selected.substring(0, selected.lastIndexOf('/'))
				}

				showSelectedProject(projectPath)
				document.getElementById('project-select').value = ''

				// Auto-populate step ID from folder name if empty
				const stepIdInput = document.getElementById('step-id-input')
				if (!stepIdInput.value) {
					// Get the last folder name from the path
					const folderName = projectPath.split('/').pop() || projectPath.split('\\').pop()
					stepIdInput.value = folderName.toLowerCase().replace(/[^a-z0-9]/g, '-')
				}
			}
		} catch (error) {
			console.error('Error browsing for project:', error)
		}
	}

	// Show selected project and load bindings
	function showSelectedProject(projectPath) {
		pipelineState.tempStepProject = projectPath

		// Show selected path
		const display = document.getElementById('selected-project-path')
		const pathDisplay = document.getElementById('project-path-display')
		display.style.display = 'block'
		pathDisplay.textContent = projectPath

		// Show bindings section
		const bindingsSection = document.getElementById('step-bindings')
		bindingsSection.style.display = 'block'

		// Create binding inputs for common project inputs
		const bindingsList = document.getElementById('step-bindings-list')
		bindingsList.innerHTML = ''

		const commonInputs = ['samplesheet', 'data_dir']
		const isFirstStep = pipelineState.wizardData.steps.length === 0

		commonInputs.forEach((inputName) => {
			let defaultBinding = ''

			if (isFirstStep) {
				// First step usually binds to pipeline inputs
				defaultBinding = `inputs.${inputName}`
			} else {
				// Later steps might bind to previous step outputs
				const prevStep = pipelineState.wizardData.steps[pipelineState.wizardData.steps.length - 1]
				if (inputName === 'samplesheet' && prevStep.id.includes('filter')) {
					defaultBinding = `step.${prevStep.id}.outputs.filtered_sheet`
				} else if (inputName === 'data_dir') {
					defaultBinding = 'inputs.data_dir'
				} else {
					defaultBinding = `inputs.${inputName}`
				}
			}

			const bindingDiv = document.createElement('div')
			bindingDiv.style.marginBottom = '10px'
			bindingDiv.innerHTML = `
				<label style="display: block;">
					<span style="display: block; margin-bottom: 3px; font-size: 13px;">${inputName}:</span>
					<input type="text"
						id="binding-${inputName}"
						value="${defaultBinding}"
						placeholder="e.g., inputs.${inputName} or step.filter.outputs.filtered_sheet"
						style="width: 100%; font-size: 13px;">
				</label>
			`
			bindingsList.appendChild(bindingDiv)
		})
	}

	// Close add step modal
	function closeAddStepModal() {
		const modal = document.getElementById('add-step-modal')
		if (modal) {
			modal.parentElement.remove()
		}
		pipelineState.tempStepProject = null
		pipelineState.tempStepBindings = {}
	}

	// Confirm and add the step
	function confirmAddStep() {
		const stepId = document.getElementById('step-id-input')?.value?.trim()

		if (!stepId) {
			alert('Please enter a Step ID')
			return
		}

		if (!pipelineState.tempStepProject) {
			alert('Please select a project')
			return
		}

		const step = {
			id: stepId,
			uses: pipelineState.tempStepProject,
			with: {},
			publish: null,
			store: null,
		}

		// Collect bindings
		const commonInputs = ['samplesheet', 'data_dir']
		commonInputs.forEach((inputName) => {
			const value = document.getElementById(`binding-${inputName}`)?.value?.trim()
			if (value) {
				step.with[inputName] = value
			}
		})

		// Collect published outputs
		const publishOutputs = document.getElementById('publish-output-name')?.value?.trim()
		if (publishOutputs) {
			step.publish = {}
			// Parse comma-separated outputs
			publishOutputs.split(',').forEach((output) => {
				const outputName = output.trim()
				if (outputName) {
					// For MVP, assume File type for outputs
					step.publish[outputName] = `File(${outputName}.csv)`
				}
			})
		}

		// Collect store configuration if enabled
		if (document.getElementById('enable-store')?.checked) {
			const storeName = document.getElementById('store-name')?.value?.trim() || 'sql_store'
			const storeSource = document.getElementById('store-source')?.value?.trim()
			const storeTable = document.getElementById('store-table')?.value?.trim()
			const storeKey = document.getElementById('store-key')?.value?.trim()

			if (storeSource && storeTable && storeKey) {
				step.store = {}
				step.store[storeName] = {
					kind: 'sql',
					destination: 'SQL()',
					source: storeSource,
					table_name: storeTable,
					key_column: storeKey,
				}
			}
		}

		pipelineState.wizardData.steps.push(step)
		updatePipelineStepsList()
		closeAddStepModal()
	}

	function updatePipelineStepsList() {
		const container = document.getElementById('pipeline-steps-list')
		container.innerHTML = ''

		pipelineState.wizardData.steps.forEach((step, index) => {
			const div = document.createElement('div')
			div.style.cssText =
				'padding: 15px; background: #f5f5f5; margin-bottom: 10px; border-radius: 4px;'

			const bindings = step.with
				? Object.entries(step.with)
						.map(([key, value]) => `${key}: ${value}`)
						.join(', ')
				: ''

			const hasPublish = step.publish && Object.keys(step.publish).length > 0
			const hasStore = step.store && Object.keys(step.store).length > 0

			div.innerHTML = `
				<strong>Step ${index + 1}: ${step.id}</strong><br>
				Uses: ${step.uses}<br>
				${bindings ? `Bindings: ${bindings}` : 'No bindings'}
				${hasPublish ? `<br>📤 Publishes: ${Object.keys(step.publish).join(', ')}` : ''}
				${hasStore ? `<br>💾 Stores to SQL: ${Object.keys(step.store).join(', ')}` : ''}
				<div style="margin-top: 10px;">
					<button class="secondary-btn" style="padding: 2px 8px;"
						onclick="pipelineModule.moveStepUp(${index})">↑</button>
					<button class="secondary-btn" style="padding: 2px 8px;"
						onclick="pipelineModule.moveStepDown(${index})">↓</button>
					<button class="delete-btn" style="float: right; padding: 2px 8px;"
						onclick="pipelineModule.removeStep(${index})">Remove</button>
				</div>
			`
			container.appendChild(div)
		})
	}

	function removeStep(index) {
		pipelineState.wizardData.steps.splice(index, 1)
		updatePipelineStepsList()
	}

	function moveStepUp(index) {
		if (index > 0) {
			const temp = pipelineState.wizardData.steps[index]
			pipelineState.wizardData.steps[index] = pipelineState.wizardData.steps[index - 1]
			pipelineState.wizardData.steps[index - 1] = temp
			updatePipelineStepsList()
		}
	}

	function moveStepDown(index) {
		if (index < pipelineState.wizardData.steps.length - 1) {
			const temp = pipelineState.wizardData.steps[index]
			pipelineState.wizardData.steps[index] = pipelineState.wizardData.steps[index + 1]
			pipelineState.wizardData.steps[index + 1] = temp
			updatePipelineStepsList()
		}
	}

	// Update preview
	function updatePipelinePreview() {
		const preview = document.getElementById('pipeline-preview')

		// Generate YAML-like preview
		let yaml = `name: ${pipelineState.wizardData.name}\n`

		if (Object.keys(pipelineState.wizardData.inputs).length > 0) {
			yaml += 'inputs:\n'
			Object.entries(pipelineState.wizardData.inputs).forEach(([name, type]) => {
				yaml += `  ${name}: ${type}\n`
			})
		}

		if (pipelineState.wizardData.steps.length > 0) {
			yaml += '\nsteps:\n'
			pipelineState.wizardData.steps.forEach((step) => {
				yaml += `  - id: ${step.id}\n`
				yaml += `    uses: ${step.uses}\n`
				if (step.with && Object.keys(step.with).length > 0) {
					yaml += `    with:\n`
					Object.entries(step.with).forEach(([key, value]) => {
						yaml += `      ${key}: ${value}\n`
					})
				}
				if (step.publish && Object.keys(step.publish).length > 0) {
					yaml += `    publish:\n`
					Object.entries(step.publish).forEach(([key, value]) => {
						yaml += `      ${key}: ${value}\n`
					})
				}
				if (step.store && Object.keys(step.store).length > 0) {
					yaml += `    store:\n`
					Object.entries(step.store).forEach(([storeName, storeConfig]) => {
						yaml += `      ${storeName}:\n`
						yaml += `        kind: ${storeConfig.kind}\n`
						yaml += `        destination: ${storeConfig.destination}\n`
						yaml += `        source: ${storeConfig.source}\n`
						yaml += `        table_name: ${storeConfig.table_name}\n`
						yaml += `        key_column: ${storeConfig.key_column}\n`
					})
				}
			})
		}

		preview.textContent = yaml
	}

	// Create pipeline
	async function createPipeline() {
		try {
			const result = await invoke('create_pipeline', {
				request: {
					name: pipelineState.wizardData.name,
					directory: null,
				},
			})

			// Save the pipeline spec
			const spec = {
				name: pipelineState.wizardData.name,
				inputs: pipelineState.wizardData.inputs,
				steps: pipelineState.wizardData.steps,
			}

			await invoke('save_pipeline_editor', {
				pipelineId: result.id,
				pipelinePath: result.pipeline_path,
				spec: spec,
			})

			closeWizard()
			await loadPipelines()
			alert('Pipeline created successfully!')
		} catch (error) {
			alert('Error creating pipeline: ' + error)
		}
	}

	// Close wizard
	function closeWizard() {
		const modal = document.getElementById('pipeline-wizard-modal')
		if (modal) {
			modal.parentElement.remove()
		}
	}

	// Run pipeline with better dialog
	async function runPipeline(pipelineId) {
		try {
			const pipeline = pipelineState.pipelines.find((p) => p.id === pipelineId)
			if (!pipeline) return

			// Load pipeline to get inputs
			const editorData = await invoke('load_pipeline_editor', {
				pipelineId: pipelineId,
			})

			// Collect all required inputs from the pipeline
			const requiredInputs = {}

			// First, check if pipeline has defined inputs
			if (editorData.spec && editorData.spec.inputs) {
				Object.assign(requiredInputs, editorData.spec.inputs)
			}

			// Also scan steps for any inputs. references that aren't defined
			if (editorData.spec && editorData.spec.steps) {
				editorData.spec.steps.forEach((step) => {
					if (step.with) {
						Object.values(step.with).forEach((value) => {
							if (typeof value === 'string' && value.startsWith('inputs.')) {
								const inputName = value.replace('inputs.', '')
								if (!requiredInputs[inputName]) {
									// Guess the type based on the name
									if (inputName.includes('dir') || inputName.includes('folder')) {
										requiredInputs[inputName] = 'Directory'
									} else if (inputName.includes('sheet') || inputName.includes('file')) {
										requiredInputs[inputName] = 'File'
									} else {
										requiredInputs[inputName] = 'String'
									}
								}
							}
						})
					}
				})
			}

			// Create a nice dialog for input selection
			const inputs = await showPipelineInputDialog(pipeline.name, requiredInputs)
			if (!inputs) return // User cancelled

			// Run the pipeline
			const run = await invoke('run_pipeline', {
				pipelineId: pipelineId,
				inputOverrides: inputs,
				resultsDir: null,
			})

			alert(`Pipeline started! Run ID: ${run.id}`)

			// Navigate to results tab if available
			if (navigateTo) {
				navigateTo('runs')
			}
		} catch (error) {
			alert('Error running pipeline: ' + error)
		}
	}

	// Show pipeline input dialog with file/folder pickers
	async function showPipelineInputDialog(pipelineName, requiredInputs) {
		// Create modal HTML
		const modalHtml = `
			<div id="pipeline-run-modal" class="modal-overlay" style="display: flex;">
				<div class="modal-content" style="width: 600px;">
					<div class="modal-header">
						<h2>Run Pipeline: ${pipelineName}</h2>
						<button class="modal-close" onclick="pipelineModule.closePipelineRunDialog()">×</button>
					</div>
					<div class="modal-body">
						<h3>Configure Inputs</h3>
						<div id="pipeline-input-fields"></div>
					</div>
					<div class="modal-footer">
						<button class="secondary-btn" onclick="pipelineModule.closePipelineRunDialog()">
							Cancel
						</button>
						<button class="primary-btn" onclick="pipelineModule.confirmPipelineRun()">
							Run Pipeline
						</button>
					</div>
				</div>
			</div>
		`

		// Add modal to page
		const modalContainer = document.createElement('div')
		modalContainer.innerHTML = modalHtml
		document.body.appendChild(modalContainer)

		// Create input fields
		const container = document.getElementById('pipeline-input-fields')
		let hasInputs = false

		for (const [name, type] of Object.entries(requiredInputs)) {
			hasInputs = true
			const fieldDiv = document.createElement('div')
			fieldDiv.style.marginBottom = '15px'

			if (type === 'File' || type === 'Directory') {
				fieldDiv.innerHTML = `
					<label style="display: block; margin-bottom: 5px;">
						${name} (${type}) *
					</label>
					<div style="display: flex; gap: 10px;">
						<input type="text" id="input-${name}" style="flex: 1;" placeholder="Select ${type.toLowerCase()}..." readonly>
						<button class="secondary-btn" onclick="pipelineModule.selectPath('${name}', '${type}')">
							Browse...
						</button>
					</div>
				`
			} else {
				fieldDiv.innerHTML = `
					<label style="display: block; margin-bottom: 5px;">
						${name} (${type})
					</label>
					<input type="text" id="input-${name}" style="width: 100%;" placeholder="Enter value...">
				`
			}

			container.appendChild(fieldDiv)
		}

		if (!hasInputs) {
			container.innerHTML = '<p style="color: #666;">No inputs required for this pipeline.</p>'
		}

		// Return a promise that resolves with the inputs
		return new Promise((resolve) => {
			window.pipelineModule.confirmPipelineRun = () => {
				const inputs = {}
				for (const name of Object.keys(requiredInputs)) {
					const value = document.getElementById(`input-${name}`)?.value
					if (value) {
						inputs[name] = value
					}
				}
				closePipelineRunDialog()
				resolve(inputs)
			}

			window.pipelineModule.closePipelineRunDialog = () => {
				closePipelineRunDialog()
				resolve(null)
			}
		})
	}

	function closePipelineRunDialog() {
		const modal = document.getElementById('pipeline-run-modal')
		if (modal) {
			modal.parentElement.remove()
		}
	}

	async function selectPath(inputName, type) {
		try {
			let path
			if (type === 'File') {
				const selected = await dialog.open({
					multiple: false,
					directory: false,
				})
				path = selected
			} else if (type === 'Directory') {
				const selected = await dialog.open({
					multiple: false,
					directory: true,
				})
				path = selected
			}

			if (path) {
				document.getElementById(`input-${inputName}`).value = path
			}
		} catch (error) {
			console.error('Error selecting path:', error)
		}
	}

	// Delete pipeline
	async function deletePipeline(pipelineId) {
		if (!confirm('Are you sure you want to delete this pipeline?')) {
			return
		}

		try {
			await invoke('delete_pipeline', { pipelineId: pipelineId })
			await loadPipelines()
		} catch (error) {
			alert('Error deleting pipeline: ' + error)
		}
	}

	// Open pipeline folder
	async function openPipelineFolder(path) {
		try {
			await invoke('open_folder', { path })
		} catch (error) {
			alert('Error opening folder: ' + error)
		}
	}

	// Edit pipeline (placeholder for now)
	async function editPipeline(pipelineId) {
		alert('Pipeline editor coming soon! For now, you can edit the pipeline.yaml file directly.')
		const pipeline = pipelineState.pipelines.find((p) => p.id === pipelineId)
		if (pipeline) {
			await openPipelineFolder(pipeline.pipeline_path)
		}
	}

	// Show pipeline details view
	function showPipelineDetails(pipelineId) {
		const pipeline = pipelineState.pipelines.find((p) => p.id === pipelineId)
		if (!pipeline) return

		const gridView = document.getElementById('pipelines-grid-view')
		const detailsView = document.getElementById('pipeline-details-view')
		const stepsListContainer = document.getElementById('pipeline-steps-list')

		if (!gridView || !detailsView || !stepsListContainer) return

		// Update details header
		document.getElementById('pipeline-title').textContent = pipeline.name
		document.getElementById('pipeline-description').textContent =
			pipeline.spec?.description || `Pipeline with ${pipeline.spec?.steps?.length || 0} steps`

		// Render steps
		stepsListContainer.innerHTML = ''
		const steps = pipeline.spec?.steps || []

		if (steps.length === 0) {
			stepsListContainer.innerHTML =
				'<p style="color: #9ca3af; text-align: center; padding: 32px;">No steps in this pipeline</p>'
		} else {
			steps.forEach((step, index) => {
				const stepEl = document.createElement('div')
				stepEl.className = 'step-item'
				stepEl.innerHTML = `
					<div class="step-info">
						<h4>Step ${index + 1}: ${step.project_path?.split('/').pop() || 'Step'}</h4>
						<p>${step.project_path}</p>
					</div>
					<div class="step-actions">
						<button class="pipeline-card-icon-btn" title="Edit">✎</button>
						<button class="pipeline-card-icon-btn" title="Remove">×</button>
					</div>
				`
				stepsListContainer.appendChild(stepEl)
			})
		}

		// Show details view, hide grid
		gridView.style.display = 'none'
		detailsView.style.display = 'flex'
	}

	// Show pipeline menu (for ... button)
	function showPipelineMenu(pipelineId, event) {
		// TODO: Implement context menu for edit, delete, open folder options
		console.log('Menu for pipeline:', pipelineId)
	}

	// Back to pipelines grid
	function backToPipelinesGrid() {
		const gridView = document.getElementById('pipelines-grid-view')
		const detailsView = document.getElementById('pipeline-details-view')

		if (gridView && detailsView) {
			gridView.style.display = 'flex'
			detailsView.style.display = 'none'
		}
	}

	// Attach back button handler
	function attachBackButton() {
		const backBtn = document.getElementById('back-to-pipelines-btn')
		if (backBtn) {
			backBtn.addEventListener('click', backToPipelinesGrid)
		}
	}

	// Initialization function
	function initialize() {
		// Load pipelines immediately
		loadPipelines()

		// Attach event handlers
		const createBtn = document.getElementById('create-pipeline-btn')
		if (createBtn) {
			createBtn.addEventListener('click', showCreatePipelineWizard)
		}

		// Also attach to any other create pipeline buttons with different IDs
		const runCreateBtn = document.getElementById('run-create-pipeline-btn')
		if (runCreateBtn) {
			runCreateBtn.addEventListener('click', showCreatePipelineWizard)
		}

		// Attach back button handler
		attachBackButton()

		// Make functions available globally for onclick handlers
		window.pipelineModule = {
			editPipeline,
			runPipeline,
			openPipelineFolder,
			deletePipeline,
			closeWizard,
			wizardNext,
			wizardBack,
			addPipelineInput,
			removePipelineInput,
			addPipelineStep,
			removeStep,
			moveStepUp,
			moveStepDown,
			createPipeline,
			selectPath,
			closePipelineRunDialog,
			browseForProject,
			closeAddStepModal,
			confirmAddStep,
			showPipelineDetails,
			showPipelineMenu,
			backToPipelinesGrid,
			showCreatePipelineWizard,
			closeSimplePipelineModal,
			createSimplePipeline,
		}
	}

	return {
		initialize,
		loadPipelines,
	}
}
