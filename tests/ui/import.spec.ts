import { expect, test } from '@playwright/test'
import { promises as fs } from 'fs'
import os from 'os'
import path from 'path'
import { fileURLToPath } from 'url'
import WebSocket from 'ws'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

/** @type {WebSocket | null} */
let logSocket = null

async function ensureLogSocket() {
	if (logSocket || !process.env.UNIFIED_LOG_WS) return
	logSocket = new WebSocket(process.env.UNIFIED_LOG_WS)
	await new Promise((resolve, reject) => {
		logSocket?.once('open', resolve)
		logSocket?.once('error', reject)
	})
}

/**
 * @param {Record<string, unknown>} payload
 */
function sendUnifiedLog(payload) {
	if (!logSocket || logSocket.readyState !== WebSocket.OPEN) return
	try {
		logSocket.send(JSON.stringify({ timestamp: new Date().toISOString(), ...payload }))
	} catch (error) {
		// Best-effort logging; swallow errors to avoid test failures
	}
}

const STORAGE_KEY = 'playwright:onboarded'
const SAMPLE_DIR = path.resolve(__dirname, '../../biovault/cli/tests/data/genotype_files')

const FILE_TEMPLATES = [
	{ id: '000000', name: 'carika.txt' },
	{ id: '103704', name: 'X_X_GSAv3-DTC_GRCh38-07-01-2025.txt' },
	{ id: '111442', name: 'X_X_GSAv3-DTC_GRCh38-07-01-2025.txt' },
	{ id: '117292', name: 'X_X_GSAv3-DTC_GRCh38-07-01-2025.txt' },
	{ id: '123364', name: 'X_X_GSAv3-DTC_GRCh38-07-01-2025.txt' },
	{ id: '256789', name: 'Combined_Genome.txt' },
	{ id: '356789', name: 'Eric_Uhden_Full_20110718111059.txt' },
	{ id: '456789', name: '20120718021406.csv' },
]

function toPosix(p) {
	return p.replace(/\\/g, '/')
}

test.describe('Import Data workflow', () => {
	test.beforeAll(async () => {
		await ensureLogSocket()
	})

	test.afterAll(async () => {
		if (logSocket) {
			await new Promise((resolve) => {
				logSocket?.once('close', resolve)
				logSocket?.close()
			})
			logSocket = null
		}
	})

	test('end-to-end import review and cleanup', async ({ page }) => {
		await ensureLogSocket()
		page.on('console', (msg) => {
			sendUnifiedLog({ source: 'browser', type: msg.type(), text: msg.text() })
		})
		sendUnifiedLog({ event: 'test-start', name: 'import-flow' })
		const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'biovault-import-'))
		const sourceEntries = await fs.readdir(SAMPLE_DIR, { withFileTypes: true })
		const sourceFiles = sourceEntries.filter((entry) => entry.isFile()).map((entry) => entry.name)
		if (sourceFiles.length === 0) {
			throw new Error('Sample data directory is empty')
		}

		/** @type {{ path: string; id: string; extension: string }[]} */
		const preparedFiles = []

		for (let i = 0; i < FILE_TEMPLATES.length; i += 1) {
			const template = FILE_TEMPLATES[i]
			const sourceName = sourceFiles[i % sourceFiles.length]
			const sourcePath = path.join(SAMPLE_DIR, sourceName)
			const targetDir = path.join(tempRoot, template.id)
			await fs.mkdir(targetDir, { recursive: true })
			const targetPath = path.join(targetDir, `${template.id}_${template.name}`)
			await fs.copyFile(sourcePath, targetPath)
			preparedFiles.push({
				path: toPosix(targetPath),
				id: template.id,
				extension: path.extname(targetPath),
			})
		}

		const folderPathPosix = toPosix(tempRoot)

		await page.addInitScript(
			({ storageKey, testData }) => {
				const w = /** @type {any} */ window

				const cloneFiles = () => testData.files.map((file) => ({ ...file }))

				const state = {
					storageKey,
					folderPath: testData.folderPath,
					files: cloneFiles(),
					importedFiles: [],
					participants: [],
					showInFolderCalls: [],
					nextFileId: 1,
					nextParticipantId: 1,
					debugLogs: [],
				}

				const ensureSessionOnboarded = () => {
					window.sessionStorage.setItem(storageKey, 'true')
				}

				const resetState = () => {
					state.files = cloneFiles()
					state.importedFiles = []
					state.participants = []
					state.showInFolderCalls = []
					state.nextFileId = 1
					state.nextParticipantId = 1
					ensureSessionOnboarded()
				}

				resetState()

				w.__TEST_STATE__ = state
				w.__RESET_TEST_STATE__ = resetState
				w.__TEST_SELECT_FOLDER__ = () => state.folderPath

				const normalizeExt = (ext) => {
					if (!ext) return ''
					return ext.startsWith('.') ? ext : `.${ext}`
				}

				const getCandidateId = (filePath) => {
					const match = /\/(\d{6})_[^/]+$/.exec(filePath)
					return match ? match[1] : null
				}

				w.__TEST_INVOKE_OVERRIDE__ = async (cmd, args = {}) => {
					switch (cmd) {
						case 'check_is_onboarded':
							return true
						case 'get_participants':
							return state.participants.map((p) => ({ ...p }))
						case 'get_files':
							return state.importedFiles.map((f) => ({ ...f }))
						case 'get_projects':
						case 'get_command_logs':
							return []
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
						case 'get_extensions': {
							const counts = new Map()
							state.files.forEach((file) => {
								const ext = normalizeExt(file.extension)
								counts.set(ext, (counts.get(ext) || 0) + 1)
							})
							return Array.from(counts.entries()).map(([extension, count]) => ({
								extension,
								count,
							}))
						}
						case 'search_txt_files': {
							const extensions = (args.extensions || []).map((ext) => normalizeExt(ext))
							if (extensions.length === 0) return []
							return state.files
								.filter((file) => extensions.includes(normalizeExt(file.extension)))
								.map((file) => file.path)
						}
						case 'suggest_patterns': {
							const sample = state.files
								.slice(0, 2)
								.map((file) => ({ path: file.path, participant_id: getCandidateId(file.path) }))
							return [
								{
									description: 'Parent folder → Participant ID',
									pattern: '{parent:{id}}',
									regex_pattern: '',
									example: sample[0]?.path || '',
									sample_extractions: sample,
								},
							]
						}
						case 'extract_ids_for_files': {
							state.debugLogs.push({ cmd, files: Array.isArray(args.files) ? [...args.files] : [] })
							const result = {}
							;(args.files || []).forEach((filePath) => {
								const id = getCandidateId(filePath)
								if (id) result[filePath] = id
							})
							return result
						}
						case 'show_in_folder':
							state.showInFolderCalls.push(args.filePath)
							return null
						case 'detect_file_types': {
							const detections = {}
							;(args.files || []).forEach((filePath) => {
								const isCsv = filePath.endsWith('.csv')
								if (isCsv) return
								detections[filePath] = {
									data_type: 'Genotype',
									source: '23andMe',
									grch_version: '38',
								}
							})
							return detections
						}
						case 'import_files_pending': {
							const metadata = args.fileMetadata || {}
							Object.entries(metadata).forEach(([filePath, meta]) => {
								const participantId = meta.participant_id
								state.importedFiles.push({
									id: state.nextFileId,
									participant_name: participantId,
									participant_id: participantId,
									file_path: filePath,
									status: 'complete',
									data_type: meta.data_type || 'Unknown',
									source: meta.source || 'Unknown',
									grch_version: meta.grch_version || 'Unknown',
									created_at: new Date().toISOString(),
								})
								state.nextFileId += 1

								if (!state.participants.some((p) => p.participant_id === participantId)) {
									state.participants.push({
										id: state.nextParticipantId,
										participant_id: participantId,
										created_at: new Date().toISOString(),
									})
									state.nextParticipantId += 1
								}
							})

							return { success: true, conflicts: [], errors: [] }
						}
						case 'delete_files_bulk': {
							const ids = new Set(args.fileIds || [])
							const before = state.importedFiles.length
							state.importedFiles = state.importedFiles.filter((file) => !ids.has(file.id))
							return before - state.importedFiles.length
						}
						case 'delete_participants_bulk': {
							const ids = new Set(args.participantIds || [])
							const toDelete = state.participants.filter((p) => ids.has(p.id))
							state.participants = state.participants.filter((p) => !ids.has(p.id))
							const participantIds = new Set(toDelete.map((p) => p.participant_id))
							state.importedFiles = state.importedFiles.filter(
								(file) => !participantIds.has(file.participant_id),
							)
							return toDelete.length
						}
						default:
							console.warn('[Playwright] Unhandled invoke command', cmd, args)
							return null
					}
				}

				ensureSessionOnboarded()
			},
			{ storageKey: STORAGE_KEY, testData: { folderPath: folderPathPosix, files: preparedFiles } },
		)

		await page.goto('/')

		await page.evaluate(() => {
			const w = /** @type {any} */ window
			w.__RESET_TEST_STATE__?.()
		})

		await page.getByRole('button', { name: 'Import Data' }).click()

		await page.locator('#pick-folder').click()

		const typeSelect = page.locator('#file-type-select')
		await expect(typeSelect).toBeVisible()
		await typeSelect.selectOption(['.txt', '.csv'])

		const fileList = page.locator('#file-list li')
		await expect(fileList).toHaveCount(preparedFiles.length)

		const patternChip = page.locator('.pattern-chip', { hasText: '{parent:{id}}' })
		await expect(patternChip).toBeVisible()
		await patternChip.click()
		sendUnifiedLog({ event: 'pattern-selected', value: '{parent:{id}}' })

		const fillAllParticipantIds = async () => {
			const participantInputs = page.locator('.participant-id-input')
			await expect(participantInputs).toHaveCount(preparedFiles.length)
			const ids = await participantInputs.evaluateAll((elements) => elements.map((el) => el.value))
			console.log('Detected participant IDs:', ids)
			sendUnifiedLog({ event: 'participant-ids-detected', ids })
			for (let i = 0; i < preparedFiles.length; i += 1) {
				await participantInputs.nth(i).fill(preparedFiles[i].id)
			}
			const normalizedIds = await participantInputs.evaluateAll((elements) =>
				elements.map((el) => el.value.trim()),
			)
			expect(normalizedIds).toEqual(preparedFiles.map((f) => f.id))
		}

		const expectReviewSelectValues = async (columnIndex, expectedValue) => {
			const rows = page.locator('#review-files-table tr')
			const count = await rows.count()
			for (let i = 0; i < count; i += 1) {
				await expect(rows.nth(i).locator('td').nth(columnIndex).locator('select')).toHaveValue(
					expectedValue,
				)
			}
		}

		await fillAllParticipantIds()

		const selectAllFiles = page.locator('#select-all-files')
		await selectAllFiles.check()
		await expect(page.locator('.file-checkbox:checked')).toHaveCount(preparedFiles.length)
		await expect(page.locator('#selected-count')).toHaveText(String(preparedFiles.length))

		const csvRow = page.locator('#file-list li', { hasText: '.csv' })
		await csvRow.locator('input[type="checkbox"]').uncheck()
		await expect(page.locator('#selected-count')).toHaveText(String(preparedFiles.length - 1))
		await csvRow.locator('input[type="checkbox"]').check()
		await expect(page.locator('#selected-count')).toHaveText(String(preparedFiles.length))
		await fillAllParticipantIds()

		await page.locator('.show-in-folder-btn').first().click()
		await expect
			.poll(async () => {
				return page.evaluate(() => {
					const w = /** @type {any} */ window
					return w.__TEST_STATE__?.showInFolderCalls?.length || 0
				})
			})
			.toBe(1)

		await page.locator('#reset-import-btn').click()
		await expect(page.locator('#selected-path')).toHaveText('No folder selected')
		await expect(page.locator('#file-list li')).toHaveCount(0)

		// Re-select folder after reset
		await page.locator('#pick-folder').click()
		await typeSelect.selectOption(['.txt', '.csv'])
		await patternChip.click()
		await selectAllFiles.check()
		await csvRow.locator('input[type="checkbox"]').check()
		await fillAllParticipantIds()

		console.log('Selected file count:', await page.locator('#selected-count').textContent())
		console.log(
			'Extracted input count:',
			await page.locator('.participant-id-input.extracted').count(),
		)
		console.log(
			'Invoke debug logs:',
			await page.evaluate(() => {
				const w = /** @type {any} */ window
				return w.__TEST_STATE__?.debugLogs || []
			}),
		)
		console.log(
			'Import button debug state:',
			await page.evaluate(() => {
				const w = /** @type {any} */ window
				return w.__IMPORT_DEBUG__ || null
			}),
		)
		await expect(page.locator('#import-btn')).toBeEnabled()
		await page.locator('#import-btn').click()

		await expect(page.locator('#import-review-view')).toHaveClass(/active/)

		const reviewRows = page.locator('#review-files-table tr')
		await expect(reviewRows).toHaveCount(preparedFiles.length)

		const reviewSelectAll = page.locator('#select-all-review')
		await reviewSelectAll.check()
		sendUnifiedLog({ event: 'review-select-all', state: 'checked' })
		await reviewSelectAll.uncheck()
		sendUnifiedLog({ event: 'review-select-all', state: 'unchecked' })
		await reviewSelectAll.check()
		sendUnifiedLog({ event: 'review-select-all', state: 'rechecked' })

		await page.locator('#set-all-datatype').selectOption('Unknown')
		await page.locator('#set-all-source').selectOption('Unknown')
		await page.locator('#set-all-grch').selectOption('36')
		sendUnifiedLog({ event: 'bulk-set', data_type: 'Unknown', source: 'Unknown', grch: '36' })
		await expectReviewSelectValues(2, 'Unknown')
		await expectReviewSelectValues(3, 'Unknown')
		await expectReviewSelectValues(4, '36')

		await page.locator('#set-all-datatype').selectOption('Genotype')
		await page.locator('#set-all-source').selectOption('23andMe')
		await page.locator('#set-all-grch').selectOption('38')
		sendUnifiedLog({ event: 'bulk-set', data_type: 'Genotype', source: '23andMe', grch: '38' })
		await expectReviewSelectValues(2, 'Genotype')
		await expectReviewSelectValues(3, '23andMe')
		await expectReviewSelectValues(4, '38')

		await page.locator('#detect-types-btn').click()
		sendUnifiedLog({ event: 'detect-types-triggered' })
		await expect(page.locator('#detection-progress')).toBeVisible()
		await expect(page.locator('#detection-progress')).toBeHidden({ timeout: 10_000 })

		const incompleteRows = await reviewRows.evaluateAll((rows) => {
			return rows
				.filter((row) => !row.classList.contains('review-row-complete'))
				.map((row) => row.dataset.filePath)
		})

		for (const filePath of incompleteRows) {
			await page
				.locator(`#review-files-table tr[data-file-path="${filePath}"] input[type="checkbox"]`)
				.uncheck()
		}

		await reviewRows.first().locator('button').click()
		await expect
			.poll(async () => {
				return page.evaluate(() => {
					const w = /** @type {any} */ window
					return w.__TEST_STATE__?.showInFolderCalls?.length || 0
				})
			})
			.toBe(2)

		await page.locator('#review-import-btn').click()

		await expect(page.locator('#files-view')).toHaveClass(/active/)
		await expect(page.locator('#files-table tr')).toHaveCount(
			preparedFiles.length - incompleteRows.length,
		)

		await page.getByRole('button', { name: 'Import Data' }).click()
		await page.locator('#pick-folder').click()
		await typeSelect.selectOption(['.txt', '.csv'])

		const alreadyImported = page.locator('#file-list li.already-imported')
		await expect(alreadyImported).toHaveCount(preparedFiles.length - incompleteRows.length)

		const availableCheckboxes = page.locator('#file-list li input[type="checkbox"]:not([disabled])')
		await expect(availableCheckboxes).toHaveCount(incompleteRows.length)

		await page.getByRole('button', { name: 'Files' }).click()
		await page.locator('#select-all-files-table').check()
		page.once('dialog', (dialog) => dialog.accept())
		await page.locator('#delete-selected-files-btn').click()
		await expect.poll(async () => page.locator('#files-table tr').count()).toBe(0)

		await page.getByRole('button', { name: 'Participants' }).click()
		await page.locator('#select-all-participants-table').check()
		page.once('dialog', (dialog) => dialog.accept())
		await page.locator('#delete-selected-participants-btn').click()
		await expect.poll(async () => page.locator('#participants-table tr').count()).toBe(0)

		const showCalls = await page.evaluate(() => {
			const w = /** @type {any} */ window
			return w.__TEST_STATE__?.showInFolderCalls || []
		})
		expect(showCalls.length).toBe(2)
	})
})
