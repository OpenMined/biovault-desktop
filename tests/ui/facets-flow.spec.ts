import { expect, test } from './playwright-fixtures'
import { promises as fs } from 'fs'
import os from 'os'
import path from 'path'
import { fileURLToPath } from 'url'
import { ensureNotInOnboarding, waitForAppReady } from './test-helpers.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const STORAGE_KEY = 'playwright:onboarded'
const SAMPLE_DIR = path.resolve(__dirname, '../../biovault/cli/tests/data/genotype_files')
const EXAMPLE_FACETS_FLOW_DIR = path.resolve(__dirname, '../../biovault/flows/example-facets')

function toPosix(p: string) {
	return p.replace(/\\/g, '/')
}

test.describe('Participant facets flow @facets-flow', () => {
	test('imports genotype files, imports editable facets, and runs facet aggregation flow', async ({
		page,
	}, testInfo) => {
		testInfo.setTimeout(60_000)

		const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'biovault-facets-flow-'))
		const sourceEntries = await fs.readdir(SAMPLE_DIR, { withFileTypes: true })
		const sourceFile = sourceEntries.find((entry) => entry.isFile())?.name
		if (!sourceFile) throw new Error('Sample genotype data directory is empty')

		const [flowYaml, moduleYaml, workflowNf] = await Promise.all([
			fs.readFile(path.join(EXAMPLE_FACETS_FLOW_DIR, 'flow.yaml'), 'utf8'),
			fs.readFile(path.join(EXAMPLE_FACETS_FLOW_DIR, 'module.yaml'), 'utf8'),
			fs.readFile(path.join(EXAMPLE_FACETS_FLOW_DIR, 'workflow.nf'), 'utf8'),
		])
		expect(flowYaml).toContain('name: example-facets')
		expect(flowYaml).toContain('facet_counts: File(facet_counts.tsv)')
		expect(flowYaml).toContain('required_facets:')
		expect(moduleYaml).toContain('entrypoint: workflow.nf')
		expect(workflowNf).toContain('facet_counts.tsv')

		const participants = [
			{ id: '100001', split: 'island', country: 'Bahamas', variants: 5 },
			{ id: '100002', split: 'mainland', country: 'Canada', variants: 8 },
			{ id: '100003', split: 'island', country: 'Bahamas', variants: 7 },
		]

		const preparedFiles = []
		for (const participant of participants) {
			const targetDir = path.join(tempRoot, participant.id)
			await fs.mkdir(targetDir, { recursive: true })
			const targetPath = path.join(targetDir, `${participant.id}_genotype.txt`)
			await fs.copyFile(path.join(SAMPLE_DIR, sourceFile), targetPath)
			preparedFiles.push({
				path: toPosix(targetPath),
				id: participant.id,
				extension: '.txt',
				variants: participant.variants,
			})
		}

		const facetFile = path.join(tempRoot, 'participant-facets.tsv')
		await fs.writeFile(
			facetFile,
			[
				'participant_id\tcountry\tsplit',
				...participants.map((p) => `${p.id}\t${p.country}\t${p.split}`),
				'',
			].join('\n'),
		)

		await page.addInitScript(
			({ storageKey, testData }) => {
				const w = window as any
				const cloneFiles = () => testData.files.map((file: any) => ({ ...file }))
				const cloneFacetRows = () =>
					testData.participants.flatMap((participant: any) => [
						{
							participant_id: participant.id,
							facet_name: 'country',
							facet_value: participant.country,
						},
						{
							participant_id: participant.id,
							facet_name: 'split',
							facet_value: participant.split,
						},
					])

					const state = {
						storageKey,
						folderPath: testData.folderPath,
						facetFile: testData.facetFile,
						files: cloneFiles(),
						importedFiles: [] as any[],
						participants: [] as any[],
						availableFacetRows: cloneFacetRows(),
						facetRows: [] as any[],
						nextFileId: 1,
						nextParticipantId: 1,
						lastRun: null as any,
						savedSamplePath: null as string | null,
						savedSampleParticipantIds: [] as string[],
					}

				const participantRowId = (participantId: string) => {
					let participant = state.participants.find((p) => p.participant_id === participantId)
					if (!participant) {
						participant = {
							id: state.nextParticipantId,
							participant_id: participantId,
							created_at: new Date().toISOString(),
						}
						state.nextParticipantId += 1
						state.participants.push(participant)
					}
					return participant.id
				}

				const facetsFor = (participantId: string) => {
					const facets: Record<string, string> = {}
					state.facetRows
						.filter((row) => row.participant_id === participantId)
						.forEach((row) => {
							facets[row.facet_name] = row.facet_value
						})
					return facets
				}

				const getCandidateId = (filePath: string) => {
					const match = /\/(\d{6})_[^/]+$/.exec(filePath)
					return match ? match[1] : null
				}

				window.sessionStorage.setItem(storageKey, 'true')
				w.__TEST_STATE__ = state
				w.__TEST_SELECT_FOLDER__ = () => state.folderPath
				w.__TEST_DIALOG_OPEN__ = (options: any) => {
					if (options?.filters?.some((filter: any) => filter.extensions?.includes('tsv'))) {
						return state.facetFile
					}
					return state.folderPath
				}
				w.__TEST_DIALOG_SAVE__ = () => `${state.folderPath}/saved-facets-sample.csv`

				w.__TEST_INVOKE_OVERRIDE__ = async (cmd: string, args: any = {}) => {
					switch (cmd) {
						case 'check_is_onboarded':
							return true
						case 'get_participants':
							return state.participants.map((p) => ({ ...p }))
						case 'get_files':
							return state.importedFiles.map((file) => ({
								...file,
								facets: facetsFor(file.participant_id),
							}))
						case 'get_modules':
						case 'get_command_logs':
						case 'get_flow_runs':
							return []
						case 'get_desktop_log_text':
							return ''
						case 'clear_desktop_log':
							return null
						case 'get_desktop_log_dir':
							return '/tmp'
						case 'get_config_path':
							return `${state.folderPath}/config.yaml`
						case 'get_queue_processor_status':
							return false
						case 'get_saved_dependency_states':
							return { dependencies: [] }
						case 'get_syftbox_state':
							return { is_authenticated: false }
						case 'get_syftbox_config_info':
							return { exists: false, path: null }
						case 'get_runs_base_dir':
							return `${state.folderPath}/runs`
						case 'check_docker_running':
							return true
						case 'get_extensions':
							return [{ extension: '.txt', count: state.files.length }]
						case 'search_txt_files':
							return state.files.map((file) => file.path)
						case 'suggest_patterns':
							return [
								{
									description: 'Parent folder -> Participant ID',
									pattern: '{parent:{id}}',
									regex_pattern: '',
									example: state.files[0]?.path || '',
									sample_extractions: state.files.map((file) => ({
										path: file.path,
										participant_id: file.id,
									})),
								},
							]
						case 'extract_ids_for_files': {
							const result: Record<string, string> = {}
							;(args.files || []).forEach((filePath: string) => {
								const id = getCandidateId(filePath)
								if (id) result[filePath] = id
							})
							return result
						}
						case 'detect_file_types': {
							const detections: Record<string, any> = {}
							;(args.files || []).forEach((filePath: string) => {
								detections[filePath] = {
									data_type: 'Genotype',
									source: '23andMe',
									grch_version: 'GRCh38',
								}
							})
							return detections
						}
						case 'import_files_pending': {
							const metadata = args.fileMetadata || {}
							Object.entries(metadata).forEach(([filePath, metaRaw]) => {
								const meta = metaRaw as any
								const participantId = meta.participant_id
								const source = state.files.find((file) => file.path === filePath)
								participantRowId(participantId)
								state.importedFiles.push({
									id: state.nextFileId,
									participant_name: participantId,
									participant_id: participantId,
									file_path: filePath,
									file_hash: `hash-${state.nextFileId}`,
									file_type: '.txt',
									file_size: 123,
									status: 'complete',
									data_type: meta.data_type || 'Genotype',
									source: meta.source || '23andMe',
									grch_version: meta.grch_version || 'GRCh38',
									row_count: source?.variants || 0,
									created_at: new Date().toISOString(),
									updated_at: new Date().toISOString(),
									facets: {},
									variants: source?.variants || 0,
								})
								state.nextFileId += 1
							})
							return { success: true, conflicts: [], errors: [] }
							}
						case 'preview_participant_facets': {
								const uniqueValues: Record<string, string[]> = {}
								for (const row of state.availableFacetRows) {
									uniqueValues[row.facet_name] = uniqueValues[row.facet_name] || []
									if (!uniqueValues[row.facet_name].includes(row.facet_value)) {
										uniqueValues[row.facet_name].push(row.facet_value)
									}
								}
								Object.values(uniqueValues).forEach((values) => values.sort())
								return {
									rows: state.availableFacetRows.map((row) => ({ ...row })),
									unique_values: uniqueValues,
									unknown_participant_ids: [],
									duplicate_keys: [],
								}
							}
						case 'import_participant_facets':
							for (const row of args.rows || []) {
								const existingIndex = state.facetRows.findIndex(
									(existing) =>
										existing.participant_id === row.participant_id &&
										existing.facet_name === row.facet_name,
								)
								if (existingIndex >= 0) {
									state.facetRows[existingIndex] = { ...row }
								} else {
									state.facetRows.push({ ...row })
								}
							}
							return (args.rows || []).length
						case 'save_participant_facets_sample':
							state.savedSamplePath = args.path
							state.savedSampleParticipantIds = args.participantIds || []
							return null
						case 'get_flows':
							return [
								{
									id: 501,
									name: testData.exampleFlowName,
									path: testData.exampleFlowDir,
									spec: {
										description:
											'Example facet-aware flow that aggregates simple variant counts by participant metadata facets.',
										inputs: {
											samplesheet: {
												type: 'List[GenotypeRecord]',
												description:
													'Genotype samplesheet with optional participant facet columns such as country and split.',
												required_facets: ['split'],
											},
										},
										steps: [{ id: 'facet_variant_counts', uses: 'local' }],
									},
								},
							]
						case 'run_flow': {
							const selectedIds = new Set(args.selection?.fileIds || [])
							const selectedFiles = state.importedFiles.filter((file) => selectedIds.has(file.id))
							const samplesheetRows = selectedFiles.map((file) => ({
								participant_id: file.participant_id,
								genotype_file: file.file_path,
								...facetsFor(file.participant_id),
							}))
							const aggregation: Record<string, { participants: number; variant_count: number }> = {}
							for (const file of selectedFiles) {
								const split = facetsFor(file.participant_id).split || 'unknown'
								aggregation[split] = aggregation[split] || {
									participants: 0,
									variant_count: 0,
								}
								aggregation[split].participants += 1
								aggregation[split].variant_count += file.variants || 0
							}
							state.lastRun = {
								id: 9001,
								flowId: args.flowId,
								samplesheetRows,
								aggregation,
							}
							return { id: 9001, status: 'running' }
						}
						default:
							console.warn('[Playwright facets-flow] Unhandled invoke command', cmd, args)
							return null
					}
				}
			},
			{
				storageKey: STORAGE_KEY,
				testData: {
					folderPath: toPosix(tempRoot),
					facetFile: toPosix(facetFile),
					files: preparedFiles,
					participants,
					exampleFlowDir: toPosix(EXAMPLE_FACETS_FLOW_DIR),
					exampleFlowName: 'example-facets',
				},
			},
		)

		await page.goto('/', { timeout: 30_000, waitUntil: 'domcontentloaded' })
		await waitForAppReady(page)
		await ensureNotInOnboarding(page)

		await page.locator('button.nav-item[data-tab="data"]').click()
		await expect(page.locator('#data-view.tab-content.active')).toBeVisible()

		const openImportBtn = page.locator('#open-import-modal-btn')
		await openImportBtn.click()
		const importModal = page.locator('#import-modal')
		await expect(importModal).not.toHaveAttribute('hidden')

		await page.locator('#folder-dropzone').click()
		await expect(page.locator('#file-types-section')).toBeVisible()
		await page.locator('.file-type-checkbox input[value=".txt"]').check()
		await expect(page.locator('#file-list tr[data-file-path]')).toHaveCount(preparedFiles.length)
		await expect(page.locator('.pattern-suggestion').first()).toBeVisible({ timeout: 5000 })
		await page.locator('.pattern-suggestion').first().click()
		await page.locator('#select-all-files').check()
		await expect(page.locator('#selected-count')).toHaveText(String(preparedFiles.length))
		await page.locator('#import-continue-btn').click()

		await expect(page.locator('#import-modal-review')).toBeVisible()
		await expect(page.locator('#detection-progress')).toBeHidden({ timeout: 10_000 })
		await page.locator('#select-all-review').check()
		await page.locator('#set-all-datatype').selectOption('Genotype')
		await page.locator('#set-all-source').selectOption('23andMe')
		await page.locator('#set-all-grch-version').selectOption('GRCh38')
		await page.waitForTimeout(250)
		await page.locator('#review-import-btn').click()
		await expect(importModal).toHaveAttribute('hidden', '', { timeout: 10_000 })
		await expect(page.locator('#files-table-body tr')).toHaveCount(preparedFiles.length)
		await page.locator('#select-all-data-files').check()

		await page.locator('#facets-import-btn').click()
		await expect(page.locator('#facets-modal')).not.toHaveClass(/hidden/)

		page.once('dialog', async (dialog) => {
			expect(dialog.message()).toContain('Saved sample facet file')
			await dialog.accept()
		})
		await page.locator('#facets-download-sample').click()
		await expect
			.poll(async () =>
				page.evaluate(() => {
					const w = window as any
					return w.__TEST_STATE__?.savedSamplePath
				}),
			)
			.toContain('saved-facets-sample.csv')
		await expect
			.poll(async () =>
				page.evaluate(() => {
					const w = window as any
					return w.__TEST_STATE__?.savedSampleParticipantIds
				}),
			)
			.toEqual(participants.map((p) => p.id))

		await page.locator('#facets-cancel').click()
		await expect(page.locator('#facets-modal')).toHaveClass(/hidden/)
		await page.locator('#run-analysis-btn').click()
		await expect(page.locator('#data-run-modal')).toBeVisible({ timeout: 5000 })
		await expect(page.locator('#data-run-facet-validation')).toContainText(
			'This flow requires facet: split',
		)
		await expect(page.locator('#data-run-facet-validation')).toContainText('100001')
		await expect(page.locator('#data-run-run-btn')).toBeDisabled()
		await page.locator('.data-run-cancel').last().click()
		await expect(page.locator('#data-run-modal')).toHaveCount(0)

		await page.locator('#facets-import-btn').click()
		await expect(page.locator('#facets-modal')).not.toHaveClass(/hidden/)
		await page.locator('#facets-choose-file').click()
		await expect(page.locator('#facets-preview-body tr')).toHaveCount(participants.length * 2)
		await expect(page.locator('#facets-unique-values')).toContainText('Bahamas')
		await expect(page.locator('#facets-unique-values')).toContainText('mainland')

		const firstParticipantSplitValue = page
			.locator('#facets-preview-body tr')
			.nth(1)
			.locator('.facet-edit[data-field="facet_value"]')
		await expect(
			page
				.locator('#facets-preview-body tr')
				.nth(1)
				.locator('.facet-edit[data-field="facet_name"]'),
		).toHaveValue('split')
		await firstParticipantSplitValue.fill('island-edited')
		await expect(page.locator('#facets-unique-values')).toContainText('island-edited')
		await firstParticipantSplitValue.fill('island')

		await expect(page.locator('#facets-confirm')).toBeEnabled()
		await page.locator('#facets-confirm').click()
		await expect(page.locator('#facets-modal')).toHaveClass(/hidden/)
		await expect(page.locator('.facet-header', { hasText: 'country' })).toBeVisible()
		await expect(page.locator('.facet-header', { hasText: 'split' })).toBeVisible()
		await expect(page.locator('#files-table-body')).toContainText('Bahamas')

		await page.locator('#facets-import-btn').click()
		await expect(page.locator('#facets-confirm')).toHaveText('Save Facets')
		await expect(page.locator('#facets-preview-body tr')).toHaveCount(participants.length * 2)
		await page.locator('#facets-cancel').click()
		await expect(page.locator('#facets-modal')).toHaveClass(/hidden/)

		await page.locator('#files-table-body tr').first().locator('.edit-facets-btn').click()
		await expect(page.locator('#facets-modal')).not.toHaveClass(/hidden/)
		await expect(page.locator('#facets-confirm')).toHaveText('Save Facets')
		await expect(page.locator('#facets-add-row')).toBeVisible()
		await expect(page.locator('#facets-preview-body tr')).toHaveCount(2)
		const firstParticipantCountryValue = page
			.locator('#facets-preview-body tr')
			.first()
			.locator('.facet-edit[data-field="facet_value"]')
		await expect(
			page
				.locator('#facets-preview-body tr')
				.first()
				.locator('.facet-edit[data-field="facet_name"]'),
		).toHaveValue('country')
		await firstParticipantCountryValue.fill('Barbados')
		await page.locator('#facets-confirm').click()
		await expect(page.locator('#facets-modal')).toHaveClass(/hidden/)
		await expect(page.locator('#files-table-body')).toContainText('Barbados')

		await expect(page.locator('#run-analysis-btn')).toBeVisible()
		await page.locator('#run-analysis-btn').click()
		await expect(page.locator('#data-run-modal')).toBeVisible({ timeout: 5000 })
		await expect(page.locator('.data-run-flow-option', { hasText: 'example-facets' })).toBeVisible()

		page.once('dialog', async (dialog) => {
			expect(dialog.message()).toContain('Flow started')
			await dialog.accept()
		})
		await page.locator('#data-run-run-btn').click()

		await expect
			.poll(async () =>
				page.evaluate(() => {
					const w = window as any
					return w.__TEST_STATE__?.lastRun
				}),
			)
			.toMatchObject({
				flowId: 501,
				aggregation: {
					island: { participants: 2, variant_count: 12 },
					mainland: { participants: 1, variant_count: 8 },
				},
			})

		const lastRun = await page.evaluate(() => {
			const w = window as any
			return w.__TEST_STATE__?.lastRun
		})
		expect(lastRun.samplesheetRows).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					participant_id: '100001',
					country: 'Barbados',
					split: 'island',
				}),
				expect.objectContaining({
					participant_id: '100002',
					country: 'Canada',
					split: 'mainland',
				}),
			]),
		)
	})
})
