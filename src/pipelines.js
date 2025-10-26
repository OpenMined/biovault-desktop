export function createPipelinesModule({
	invoke,
	dialog,
	open: _open,
	navigateTo,
	showCreateProjectModal,
	openProjectEditor,
}) {
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
			const gridContainer = document.getElementById('pipelines-grid')
			const emptyState = document.getElementById('pipelines-empty-state')

			if (!gridContainer) {
				console.error('pipelines-grid container not found')
				return
			}

			if (!pipelines || pipelines.length === 0) {
				gridContainer.innerHTML = ''
				if (emptyState) emptyState.style.display = 'flex'
				pipelineState.pipelines = []
				return
			}

			if (emptyState) emptyState.style.display = 'none'
			gridContainer.innerHTML = ''

			pipelines.forEach((pipeline) => {
				const stepCount = pipeline.spec?.steps?.length || 0
				const description = pipeline.spec?.description || 'Click to configure and manage steps'

				const card = document.createElement('div')
				card.className = 'pipeline-card'

				card.innerHTML = `
				<div class="pipeline-card-header">
					<h3 class="pipeline-card-title">${pipeline.name}</h3>
					<button class="pipeline-card-menu" onclick="event.stopPropagation(); pipelineModule.showPipelineMenu(${
						pipeline.id
					}, event)">⋯</button>
				</div>
				<p class="pipeline-card-description">${description}</p>
				<div class="pipeline-card-footer">
					<span class="pipeline-step-badge">${stepCount} ${stepCount === 1 ? 'step' : 'steps'}</span>
					<button class="pipeline-run-btn" onclick="event.stopPropagation(); pipelineModule.runPipeline(${
						pipeline.id
					})">▶ Run</button>
				</div>
			`

				card.addEventListener('click', () => {
					showPipelineDetails(pipeline.id)
				})
				gridContainer.appendChild(card)
			})

			pipelineState.pipelines = pipelines
		} catch (error) {
			console.error('Error loading pipelines:', error)
		}
	}

	// Show pipeline creation options (similar to step picker)
	async function showCreatePipelineWizard() {
		const modalHtml = `
			<div id="pipeline-picker-modal" class="modal-overlay" style="display: flex;">
				<div class="modal-content" style="width: 500px;">
					<div class="modal-header">
						<h2>New Pipeline</h2>
						<button class="modal-close" onclick="pipelineModule.closePipelinePickerModal()">×</button>
					</div>
					<div class="modal-body">
						<h3 style="font-size: 14px; font-weight: 600; color: #374151; margin: 0 0 12px 0;">Choose an Option</h3>
						<div style="display: flex; flex-direction: column; gap: 8px;">
							<button class="action-btn" onclick="pipelineModule.importPipelineFromURL()">
								<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
									<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"></path>
									<path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"></path>
								</svg>
								Import from GitHub URL
							</button>
							<button class="action-btn" onclick="pipelineModule.importExistingPipeline()">
								<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
									<path d="M3 7v10a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-6l-2-2H5a2 2 0 0 0-2 2z"></path>
								</svg>
								Browse Local Folder
							</button>
							<button class="action-btn" onclick="pipelineModule.createBlankPipeline()">
								<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
									<line x1="12" y1="5" x2="12" y2="19"></line>
									<line x1="5" y1="12" x2="19" y2="12"></line>
								</svg>
								Create Blank Pipeline
							</button>
						</div>
					</div>
				</div>
			</div>
		`

		document.body.insertAdjacentHTML('beforeend', modalHtml)
	}

	function closePipelinePickerModal() {
		const modal = document.getElementById('pipeline-picker-modal')
		if (modal) modal.remove()
	}

	async function createBlankPipeline() {
		closePipelinePickerModal()

		const name = prompt('Pipeline name:')
		if (!name) return

		try {
			// Create pipeline spec matching CLI PipelineSpec structure
			const spec = {
				name: name,
				inputs: {},
				steps: [],
			}

			// Invoke the create pipeline command
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
				await loadPipelines()
			}
		} catch (error) {
			console.error('Error creating pipeline:', error)
			const errorMsg = error?.message || error?.toString() || String(error) || 'Unknown error'
			alert('Failed to create pipeline: ' + errorMsg)
		}
	}

	async function importPipelineFromURL() {
		closePipelinePickerModal()

		// Show URL input modal instead of using prompt()
		const modalHtml = `
			<div id="url-input-modal" class="modal-overlay" style="display: flex;">
				<div class="modal-content" style="width: 600px;">
					<div class="modal-header">
						<h2>Import Pipeline from GitHub</h2>
						<button class="modal-close" onclick="pipelineModule.closeURLInputModal()">×</button>
					</div>
					<div class="modal-body">
						<label style="display: block; margin-bottom: 8px; font-weight: 600; color: #374151;">
							GitHub URL to pipeline.yaml
						</label>
						<input 
							type="text" 
							id="pipeline-url-input" 
							placeholder="https://github.com/OpenMined/biovault/blob/main/pipeline_sql.yaml"
							style="width: 100%; padding: 10px 12px; border: 1px solid #e5e7eb; border-radius: 6px; font-size: 14px; box-sizing: border-box; font-family: 'SF Mono', Monaco, monospace;"
						>
						<p style="font-size: 13px; color: #6b7280; margin-top: 8px;">
							This will import the pipeline and automatically download all referenced steps.
						</p>
					</div>
					<div class="modal-footer">
						<button class="secondary-btn" onclick="pipelineModule.closeURLInputModal()">Cancel</button>
						<button class="primary-btn" onclick="pipelineModule.submitPipelineURL()">Import Pipeline</button>
					</div>
				</div>
			</div>
		`

		document.body.insertAdjacentHTML('beforeend', modalHtml)

		// Focus on input
		setTimeout(() => {
			const input = document.getElementById('pipeline-url-input')
			if (input) {
				input.focus()
				input.addEventListener('keypress', (e) => {
					if (e.key === 'Enter') {
						pipelineModule.submitPipelineURL()
					}
				})
			}
		}, 100)
	}

	function closeURLInputModal() {
		const modal = document.getElementById('url-input-modal')
		if (modal) modal.remove()
	}

	async function submitPipelineURL() {
		const input = document.getElementById('pipeline-url-input')
		if (!input) return

		const url = input.value.trim()
		if (!url) {
			alert('Please enter a URL')
			return
		}

		try {
			closeURLInputModal()

			// Call CLI function that imports pipeline AND all its step dependencies!
			const result = await invoke('import_pipeline_with_deps', {
				url: url,
				nameOverride: null,
				overwrite: false,
			})

			await loadPipelines()

			console.log('✅ Imported pipeline with all dependencies from URL:', url)
			alert('Pipeline and all its steps imported successfully!')
		} catch (error) {
			console.error('Error importing pipeline from URL:', error)
			const errorMsg = error?.message || error?.toString() || String(error) || 'Unknown error'
			alert('Failed to import pipeline: ' + errorMsg)
		}
	}

	async function importExistingPipeline() {
		try {
			const selected = await dialog.open({
				directory: true,
				multiple: false,
			})

			if (selected) {
				// Check if it has a pipeline.yaml
				const pipelineYamlPath = selected + '/pipeline.yaml'

				// Extract name from folder
				const name = selected.split('/').pop() || selected.split('\\').pop() || 'imported-pipeline'

				// Register in database
				const result = await invoke('create_pipeline', {
					request: {
						name: name,
						directory: selected,
					},
				})

				closePipelinePickerModal()
				await loadPipelines()

				console.log('✅ Imported pipeline:', name)
			}
		} catch (error) {
			console.error('Error importing pipeline:', error)
			const errorMsg = error?.message || error?.toString() || String(error) || 'Unknown error'
			alert('Failed to import pipeline: ' + errorMsg)
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
			// Don't include publish/store if they're empty (CLI parity)
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

	// Show pipeline detail view
	async function showPipelineDetails(pipelineId) {
		try {
			const pipeline = pipelineState.pipelines.find((p) => p.id === pipelineId)
			if (!pipeline) {
				console.error('Pipeline not found:', pipelineId)
				return
			}

			pipelineState.currentPipeline = pipeline

			// Hide main view, show detail view
			const mainView = document.getElementById('pipelines-main-view')
			const detailView = document.getElementById('pipeline-detail-view')

			if (mainView) mainView.style.display = 'none'
			if (detailView) detailView.style.display = 'flex'

			// Update header
			const nameEl = document.getElementById('pipeline-detail-name')
			const descEl = document.getElementById('pipeline-detail-description')

			if (nameEl) nameEl.textContent = pipeline.name
			if (descEl) {
				descEl.textContent =
					pipeline.spec?.description || `Pipeline with ${pipeline.spec?.steps?.length || 0} steps`
			}

			// Load and display steps
			await loadPipelineSteps(pipelineId)
		} catch (error) {
			console.error('Error showing pipeline details:', error)
		}
	}

	// Load pipeline steps for detail view
	async function loadPipelineSteps(pipelineId) {
		try {
			const pipeline = pipelineState.pipelines.find((p) => p.id === pipelineId)
			if (!pipeline) return

			const stepsContainer = document.getElementById('pipeline-steps-list')
			if (!stepsContainer) return

			const steps = pipeline.spec?.steps || []

			if (steps.length === 0) {
				stepsContainer.innerHTML = `
				<div style="text-align: center; padding: 40px; color: #9ca3af;">
					<p>No steps in this pipeline yet.</p>
					<p style="font-size: 13px; margin-top: 8px;">Click "+ Add Step" above to add your first step.</p>
				</div>
			`
				return
			}

			stepsContainer.innerHTML = ''

			steps.forEach((step, index) => {
				const stepDiv = document.createElement('div')
				stepDiv.className = 'pipeline-step-item'

				const stepName = step.id || `step-${index + 1}`
				const stepUses = step.uses || 'Unknown step'

				const hasBindings = step.with && Object.keys(step.with).length > 0
				const bindingCount = Object.keys(step.with || {}).length

				stepDiv.innerHTML = `
				<div class="pipeline-step-drag-handle" title="Drag to reorder">⋮⋮</div>
				<div class="pipeline-step-number">${index + 1}</div>
				<div class="pipeline-step-info">
					<h4>${stepName}</h4>
					<p>Uses: ${stepUses}</p>
					${
						!hasBindings
							? '<span class="warning-badge">⚠️ Not configured</span>'
							: `<span class="success-badge">✓ ${bindingCount} binding${
									bindingCount === 1 ? '' : 's'
							  }</span>`
					}
				</div>
				<div class="pipeline-step-actions">
					<button class="btn-secondary-small" onclick="pipelineModule.configureStepBindings(${index})">Configure</button>
					<button class="btn-secondary-small" onclick="pipelineModule.editPipelineStep(${index})">Edit Project</button>
					<button class="btn-secondary-small" onclick="pipelineModule.removePipelineStep(${index})" style="color: #dc3545;">Remove</button>
				</div>
			`

				stepsContainer.appendChild(stepDiv)
			})
		} catch (error) {
			console.error('Error loading pipeline steps:', error)
		}
	}

	// Go back to pipelines list
	function backToPipelinesList() {
		document.getElementById('pipeline-detail-view').style.display = 'none'
		document.getElementById('pipelines-main-view').style.display = 'block'
		pipelineState.currentPipeline = null
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

	// Show pipeline menu (for ... button)
	function showPipelineMenu(pipelineId, event) {
		// TODO: Implement context menu for edit, delete, open folder options
		console.log('Menu for pipeline:', pipelineId)
	}

	// Attach back button handler
	function attachBackButton() {
		const backBtn = document.getElementById('back-to-pipelines-btn')
		if (backBtn) {
			backBtn.addEventListener('click', backToPipelinesList)
		}
	}

	// Attach detail view button handlers
	function attachDetailViewButtons() {
		const runBtn = document.getElementById('pipeline-detail-run')
		if (runBtn) {
			runBtn.addEventListener('click', () => {
				if (pipelineState.currentPipeline) {
					runPipeline(pipelineState.currentPipeline.id)
				}
			})
		}

		const editBtn = document.getElementById('pipeline-detail-edit')
		if (editBtn) {
			editBtn.addEventListener('click', () => {
				if (pipelineState.currentPipeline) {
					editPipeline(pipelineState.currentPipeline.id)
				}
			})
		}

		const addStepBtn = document.getElementById('add-step-to-pipeline')
		if (addStepBtn) {
			addStepBtn.addEventListener('click', () => {
				if (pipelineState.currentPipeline) {
					showStepPickerModal()
				} else {
					console.error('Cannot add step: no current pipeline')
				}
			})
		}
	}

	// Initialization function
	function initialize() {
		// Make functions available globally FIRST (before loading pipelines)
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
			backToPipelinesList,
			showCreatePipelineWizard,
			closePipelinePickerModal,
			createBlankPipeline,
			importPipelineFromURL,
			closeURLInputModal,
			submitPipelineURL,
			importExistingPipeline,
			importStepFromURL,
			loadPipelineSteps,
			editPipelineStep,
			removePipelineStep,
			closeStepPickerModal,
			browseForStepFolder,
			createNewStepProject,
			closeBindingConfigModal,
			saveStepWithBindings,
			configureStepBindings,
			updateStepBindings,
		}

		// Load pipelines after setting up global handlers
		loadPipelines()

		// Attach event handlers to all create pipeline buttons
		const createBtn = document.getElementById('create-pipeline-btn')
		if (createBtn) {
			createBtn.addEventListener('click', showCreatePipelineWizard)
		}

		const emptyCreateBtn = document.getElementById('empty-create-pipeline-btn')
		if (emptyCreateBtn) {
			emptyCreateBtn.addEventListener('click', showCreatePipelineWizard)
		}

		const runCreateBtn = document.getElementById('run-create-pipeline-btn')
		if (runCreateBtn) {
			runCreateBtn.addEventListener('click', showCreatePipelineWizard)
		}

		// Attach back button handler
		attachBackButton()

		// Attach detail view button handlers
		attachDetailViewButtons()
	}

	// Show step picker modal (choose existing or create new)
	async function showStepPickerModal() {
		try {
			const projects = await invoke('get_projects')

			const modalHtml = `
				<div id="step-picker-modal" class="modal-overlay" style="display: flex;">
					<div class="modal-content" style="width: 600px; max-height: 80vh;">
						<div class="modal-header">
							<h2>Add Step to Pipeline</h2>
							<button class="modal-close" onclick="pipelineModule.closeStepPickerModal()">×</button>
						</div>
						<div class="modal-body" style="max-height: 60vh; overflow-y: auto;">
							<h3 style="font-size: 14px; font-weight: 600; color: #374151; margin: 0 0 12px 0;">Select Existing Project</h3>
							${
								projects.length > 0
									? `
								<div class="project-select-list">
									${projects
										.map(
											(p) => `
										<div class="project-select-item" data-path="${p.project_path}" data-name="${p.name}">
											<div class="project-select-info">
												<div class="project-select-name">${p.name}</div>
												<div class="project-select-path">${p.project_path}</div>
											</div>
											<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
												<polyline points="9 18 15 12 9 6"></polyline>
											</svg>
										</div>
									`,
										)
										.join('')}
								</div>
							`
									: '<p style="color: #9ca3af; padding: 20px; text-align: center;">No projects registered yet</p>'
							}
							
							<div style="border-top: 1px solid #e5e7eb; margin: 20px 0; padding-top: 20px;">
								<h3 style="font-size: 14px; font-weight: 600; color: #374151; margin: 0 0 12px 0;">Or Choose Action</h3>
								<div style="display: flex; flex-direction: column; gap: 8px;">
							<button class="action-btn" onclick="pipelineModule.importStepFromURL()">
								<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
									<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"></path>
									<path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"></path>
								</svg>
								Import from GitHub URL
							</button>
							<button class="action-btn" onclick="pipelineModule.browseForStepFolder()">
								<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
									<path d="M3 7v10a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-6l-2-2H5a2 2 0 0 0-2 2z"></path>
								</svg>
								Browse Local Folder
							</button>
							<button class="action-btn" onclick="pipelineModule.createNewStepProject()">
								<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
									<line x1="12" y1="5" x2="12" y2="19"></line>
									<line x1="5" y1="12" x2="19" y2="12"></line>
								</svg>
								Create New Project
							</button>
								</div>
							</div>
						</div>
					</div>
				</div>
			`

			document.body.insertAdjacentHTML('beforeend', modalHtml)

			// Add click handlers for project items
			document.querySelectorAll('.project-select-item').forEach((item) => {
				item.addEventListener('click', async () => {
					const path = item.dataset.path
					const name = item.dataset.name
					await addStepFromPath(path, name)
					closeStepPickerModal()
				})
			})
		} catch (error) {
			console.error('Error showing step picker:', error)
			alert('Failed to show step picker: ' + error)
		}
	}

	function closeStepPickerModal() {
		const modal = document.getElementById('step-picker-modal')
		if (modal) modal.remove()
	}

	async function importStepFromURL() {
		closeStepPickerModal()

		const url = prompt(
			'Paste GitHub URL to project.yaml:\n(e.g., https://github.com/OpenMined/biovault/blob/main/cli/examples/pipeline/count-lines/project.yaml)',
		)
		if (!url) return

		try {
			// Call CLI library to import from URL
			const result = await invoke('import_project', {
				source: url,
				name: null,
				overwrite: false,
			})

			// Add the imported project as a step
			await addStepFromPath(result.project_path, result.name)

			console.log('✅ Imported and added step from URL:', url)
		} catch (error) {
			console.error('Error importing from URL:', error)
			const errorMsg = error?.message || error?.toString() || String(error) || 'Unknown error'
			alert('Failed to import from URL: ' + errorMsg)
		}
	}

	async function browseForStepFolder() {
		try {
			const selected = await dialog.open({
				directory: true,
				multiple: false,
			})

			if (selected) {
				// Import/register the project first so it appears in the list
				try {
					await invoke('import_project_from_folder', { folderPath: selected })
				} catch (e) {
					// Might already be registered, that's ok
					console.log('Project may already be registered:', e)
				}

				// Extract name from path
				const name = selected.split('/').pop() || selected.split('\\').pop() || 'step'
				await addStepFromPath(selected, name)
				closeStepPickerModal()
			}
		} catch (error) {
			console.error('Error browsing for step:', error)
		}
	}

	function createNewStepProject() {
		closeStepPickerModal()
		if (showCreateProjectModal) {
			// Set flag so project gets added to pipeline after creation
			window._addingStepToPipeline = pipelineState.currentPipeline.id
			showCreateProjectModal()
		}
	}

	async function addStepFromPath(projectPath, projectName) {
		if (!pipelineState.currentPipeline) return

		try {
			// Load current pipeline
			const editorData = await invoke('load_pipeline_editor', {
				pipelineId: pipelineState.currentPipeline.id,
			})

			// Create step WITHOUT bindings (configure later)
			const stepId = projectName.toLowerCase().replace(/[^a-z0-9]/g, '-')
			const newStep = {
				id: stepId,
				uses: projectPath,
				with: {}, // Empty - configure later via button
			}

			// Add step
			if (!editorData.spec.steps) {
				editorData.spec.steps = []
			}
			editorData.spec.steps.push(newStep)

			// Save
			await invoke('save_pipeline_editor', {
				pipelineId: pipelineState.currentPipeline.id,
				pipelinePath: pipelineState.currentPipeline.pipeline_path,
				spec: editorData.spec,
			})

			// Refresh
			await loadPipelines()
			const updated = pipelineState.pipelines.find((p) => p.id === pipelineState.currentPipeline.id)
			if (updated) {
				pipelineState.currentPipeline = updated
			}
			await loadPipelineSteps(pipelineState.currentPipeline.id)

			console.log('✅ Added step (configure bindings later):', stepId)
		} catch (error) {
			console.error('Error adding step:', error)
			alert('Failed to add step: ' + error)
		}
	}

	async function showBindingConfigModal(projectPath, projectName, projectSpec) {
		const inputs = projectSpec.metadata?.inputs || []
		const pipelineInputs = pipelineState.currentPipeline.spec?.inputs || {}
		const existingSteps = pipelineState.currentPipeline.spec?.steps || []

		const stepId = projectName.toLowerCase().replace(/[^a-z0-9]/g, '-')

		const modalHtml = `
			<div id="binding-config-modal" class="modal-overlay" style="display: flex;">
				<div class="modal-content" style="width: 700px; max-height: 85vh;">
					<div class="modal-header">
						<h2>Configure Step: ${projectName}</h2>
						<button class="modal-close" onclick="pipelineModule.closeBindingConfigModal()">×</button>
					</div>
					<div class="modal-body" style="max-height: 65vh; overflow-y: auto;">
						<p style="color: #6b7280; margin: 0 0 20px 0; font-size: 14px;">
							Configure how this step receives its inputs
						</p>
						
						${
							inputs.length > 0
								? `
							<div class="bindings-list">
								${inputs
									.map((input) => {
										// Smart default: try to match pipeline input with same name
										const defaultBinding = pipelineInputs[input.name] ? `inputs.${input.name}` : ''

										return `
										<div class="binding-item">
											<label class="binding-label">
												<span class="binding-name">${input.name}</span>
												<span class="binding-type">${input.type}</span>
											</label>
											<input 
												type="text" 
												class="binding-input"
												data-input="${input.name}"
												value="${defaultBinding}"
												placeholder="e.g., inputs.${input.name} or step.filter.outputs.data"
											/>
											<p class="binding-hint">${input.description || ''}</p>
										</div>
									`
									})
									.join('')}
							</div>
						`
								: '<p style="color: #9ca3af;">This step has no inputs to configure.</p>'
						}
					</div>
					<div class="modal-footer">
						<button class="secondary-btn" onclick="pipelineModule.closeBindingConfigModal()">Cancel</button>
						<button class="primary-btn" onclick="pipelineModule.saveStepWithBindings('${projectPath}', '${stepId}')">Add Step</button>
					</div>
				</div>
			</div>
		`

		document.body.insertAdjacentHTML('beforeend', modalHtml)
	}

	function closeBindingConfigModal() {
		const modal = document.getElementById('binding-config-modal')
		if (modal) modal.remove()
	}

	async function saveStepWithBindings(projectPath, stepId) {
		try {
			// Collect bindings from inputs
			const bindings = {}
			document.querySelectorAll('.binding-input').forEach((input) => {
				const inputName = input.dataset.input
				const value = input.value.trim()
				if (value) {
					bindings[inputName] = value
				}
			})

			// Load current pipeline
			const editorData = await invoke('load_pipeline_editor', {
				pipelineId: pipelineState.currentPipeline.id,
			})

			// Create step with bindings
			const newStep = {
				id: stepId,
				uses: projectPath,
				with: bindings,
			}

			// Add step
			if (!editorData.spec.steps) {
				editorData.spec.steps = []
			}
			editorData.spec.steps.push(newStep)

			// Save
			await invoke('save_pipeline_editor', {
				pipelineId: pipelineState.currentPipeline.id,
				pipelinePath: pipelineState.currentPipeline.pipeline_path,
				spec: editorData.spec,
			})

			// Refresh
			await loadPipelines()
			const updated = pipelineState.pipelines.find((p) => p.id === pipelineState.currentPipeline.id)
			if (updated) {
				pipelineState.currentPipeline = updated
			}
			await loadPipelineSteps(pipelineState.currentPipeline.id)

			closeBindingConfigModal()
			console.log('✅ Added step with bindings:', stepId)
		} catch (error) {
			console.error('Error saving step:', error)
			alert('Failed to save step: ' + error)
		}
	}

	// Configure step bindings
	async function configureStepBindings(stepIndex) {
		if (!pipelineState.currentPipeline) return

		const step = pipelineState.currentPipeline.spec?.steps?.[stepIndex]
		if (!step) return

		try {
			// Load project spec to get inputs
			const projectSpec = await invoke('load_project_editor', {
				projectPath: step.uses,
			})

			// Show binding config with existing bindings
			await showBindingConfigModalForEdit(step, stepIndex, projectSpec)
		} catch (error) {
			console.error('Error loading project for configuration:', error)
			alert('Failed to load project: ' + error)
		}
	}

	async function showBindingConfigModalForEdit(step, stepIndex, projectSpec) {
		const inputs = projectSpec.metadata?.inputs || []
		const pipelineInputs = pipelineState.currentPipeline.spec?.inputs || {}

		const modalHtml = `
			<div id="binding-config-modal" class="modal-overlay" style="display: flex;">
				<div class="modal-content" style="width: 700px; max-height: 85vh;">
					<div class="modal-header">
						<h2>Configure Bindings: ${step.id}</h2>
						<button class="modal-close" onclick="pipelineModule.closeBindingConfigModal()">×</button>
					</div>
					<div class="modal-body" style="max-height: 65vh; overflow-y: auto;">
						<p style="color: #6b7280; margin: 0 0 20px 0; font-size: 14px;">
							Configure how this step receives its inputs
						</p>
						
						${
							inputs.length > 0
								? `
							<div class="bindings-list">
								${inputs
									.map((input) => {
										// Use existing binding or smart default
										const existingBinding = step.with?.[input.name] || ''
										const defaultBinding =
											existingBinding || (pipelineInputs[input.name] ? `inputs.${input.name}` : '')

										return `
										<div class="binding-item">
											<label class="binding-label">
												<span class="binding-name">${input.name}</span>
												<span class="binding-type">${input.type}</span>
											</label>
											<input 
												type="text" 
												class="binding-input"
												data-input="${input.name}"
												value="${defaultBinding}"
												placeholder="e.g., inputs.${input.name} or step.filter.outputs.data"
											/>
											<p class="binding-hint">${input.description || ''}</p>
										</div>
									`
									})
									.join('')}
							</div>
						`
								: '<p style="color: #9ca3af;">This step has no inputs to configure.</p>'
						}
					</div>
					<div class="modal-footer">
						<button class="secondary-btn" onclick="pipelineModule.closeBindingConfigModal()">Cancel</button>
						<button class="primary-btn" onclick="pipelineModule.updateStepBindings(${stepIndex})">Save Bindings</button>
					</div>
				</div>
			</div>
		`

		document.body.insertAdjacentHTML('beforeend', modalHtml)
	}

	async function updateStepBindings(stepIndex) {
		try {
			// Collect bindings
			const bindings = {}
			document.querySelectorAll('.binding-input').forEach((input) => {
				const inputName = input.dataset.input
				const value = input.value.trim()
				if (value) {
					bindings[inputName] = value
				}
			})

			// Load pipeline
			const editorData = await invoke('load_pipeline_editor', {
				pipelineId: pipelineState.currentPipeline.id,
			})

			// Update step bindings
			if (editorData.spec.steps[stepIndex]) {
				editorData.spec.steps[stepIndex].with = bindings
			}

			// Save
			await invoke('save_pipeline_editor', {
				pipelineId: pipelineState.currentPipeline.id,
				pipelinePath: pipelineState.currentPipeline.pipeline_path,
				spec: editorData.spec,
			})

			// Refresh
			await loadPipelines()
			const updated = pipelineState.pipelines.find((p) => p.id === pipelineState.currentPipeline.id)
			if (updated) {
				pipelineState.currentPipeline = updated
			}
			await loadPipelineSteps(pipelineState.currentPipeline.id)

			closeBindingConfigModal()
			console.log('✅ Updated bindings for step')
		} catch (error) {
			console.error('Error updating bindings:', error)
			alert('Failed to update bindings: ' + error)
		}
	}

	// Edit a pipeline step - opens the project editor for that step
	async function editPipelineStep(stepIndex) {
		if (!pipelineState.currentPipeline) {
			console.error('No current pipeline')
			return
		}

		const step = pipelineState.currentPipeline.spec?.steps?.[stepIndex]
		if (!step) {
			console.error('Step not found at index:', stepIndex)
			return
		}

		// Open the project editor for this step's project
		if (openProjectEditor && step.uses) {
			await openProjectEditor({ projectPath: step.uses })
		} else {
			console.error('Cannot open project editor: missing function or project path')
		}
	}

	// Remove a pipeline step
	async function removePipelineStep(stepIndex) {
		if (!pipelineState.currentPipeline) {
			console.error('No current pipeline')
			return
		}

		if (!confirm('Are you sure you want to remove this step from the pipeline?')) {
			return
		}

		try {
			// Load current pipeline spec
			const editorData = await invoke('load_pipeline_editor', {
				pipelineId: pipelineState.currentPipeline.id,
			})

			// Remove the step
			editorData.spec.steps.splice(stepIndex, 1)

			// Save updated pipeline
			await invoke('save_pipeline_editor', {
				pipelineId: pipelineState.currentPipeline.id,
				pipelinePath: pipelineState.currentPipeline.pipeline_path,
				spec: editorData.spec,
			})

			// Reload pipelines and steps
			await loadPipelines()

			const updatedPipeline = pipelineState.pipelines.find(
				(p) => p.id === pipelineState.currentPipeline.id,
			)
			if (updatedPipeline) {
				pipelineState.currentPipeline = updatedPipeline
			}

			await loadPipelineSteps(pipelineState.currentPipeline.id)

			console.log('✅ Removed step from pipeline')
		} catch (error) {
			console.error('Error removing step:', error)
			alert('Failed to remove step: ' + error.message)
		}
	}

	// Add a newly created project as a step to the current pipeline
	async function addProjectAsStep(projectPath, projectName) {
		if (!pipelineState.currentPipeline) {
			console.error('No current pipeline to add step to')
			return
		}

		try {
			console.log('🔧 Adding step to pipeline:', pipelineState.currentPipeline.name)

			// Load current pipeline spec
			const editorData = await invoke('load_pipeline_editor', {
				pipelineId: pipelineState.currentPipeline.id,
			})

			console.log('📄 Loaded pipeline spec:', editorData.spec)

			// Create new step (CLI parity - only include non-empty fields)
			const stepId = projectName.toLowerCase().replace(/[^a-z0-9]/g, '-')
			const newStep = {
				id: stepId,
				uses: projectPath,
				with: {},
				// Don't include publish/store unless they have values (CLI parity)
			}

			console.log('➕ New step:', newStep)

			// Add step to pipeline
			if (!editorData.spec.steps) {
				editorData.spec.steps = []
			}
			editorData.spec.steps.push(newStep)

			console.log('📝 Updated spec with', editorData.spec.steps.length, 'steps')

			// Save updated pipeline
			await invoke('save_pipeline_editor', {
				pipelineId: pipelineState.currentPipeline.id,
				pipelinePath: pipelineState.currentPipeline.pipeline_path,
				spec: editorData.spec,
			})

			console.log('💾 Saved pipeline')

			// Reload pipelines list (now includes spec from YAML files)
			await loadPipelines()
			console.log('🔄 Reloaded pipelines list')

			// Update current pipeline reference with fresh data
			const updatedPipeline = pipelineState.pipelines.find(
				(p) => p.id === pipelineState.currentPipeline.id,
			)
			if (updatedPipeline) {
				pipelineState.currentPipeline = updatedPipeline
				console.log(
					'✅ Updated current pipeline, steps count:',
					updatedPipeline.spec?.steps?.length || 0,
				)
			}

			// Reload the steps display
			await loadPipelineSteps(pipelineState.currentPipeline.id)
			console.log('🎉 Refreshed step display')

			console.log(`✅ Added step "${stepId}" to pipeline "${pipelineState.currentPipeline.name}"`)
		} catch (error) {
			console.error('Error adding step to pipeline:', error)
			alert('Failed to add step to pipeline: ' + error.message)
		}
	}

	return {
		initialize,
		loadPipelines,
		showPipelineDetails,
		backToPipelinesList,
		addProjectAsStep, // Expose for project creation to call
	}
}
