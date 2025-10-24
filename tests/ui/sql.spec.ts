import { expect, test } from '@playwright/test'

test.describe('SQL tab', () => {
	test.beforeEach(async ({ page }) => {
		await page.addInitScript(() => {
			const responses = {
				tables: [{ name: 'participants' }, { name: 'measurements' }],
				schema: {
					columns: [
						{ name: 'id', type: 'INTEGER', nullable: false, primary_key: true },
						{ name: 'participant_id', type: 'TEXT', nullable: false, primary_key: false },
					],
					indexes: ['idx_participants_participant_id'],
					foreign_keys: [],
				},
				runResult: {
					operation: 'read',
					headers: ['id', 'participant_id'],
					rows: [
						['1', 'P-001'],
						['2', 'P-002'],
					],
					total_rows: 2,
					truncated: false,
					execution_time_ms: 5,
					affected_rows: null,
					message: null,
				},
				aiSql: 'select participant_id, created_at from participants limit 5;',
			}

			const w = /** @type {any} */ window

			w.__TEST_INVOKE_OVERRIDE__ = async (cmd) => {
				switch (cmd) {
					case 'check_is_onboarded':
						return true
					case 'get_participants':
						return []
					case 'get_files':
						return []
					case 'get_projects':
						return []
					case 'get_command_logs':
						return []
					case 'get_saved_dependency_states':
						return { dependencies: [] }
					case 'get_syftbox_state':
						return { is_authenticated: false }
					case 'sql_list_tables':
						return responses.tables
					case 'sql_get_table_schema':
						return responses.schema
					case 'sql_run_query':
						return responses.runResult
					case 'sql_export_query':
						return { path: '/tmp/query.csv', rows_written: 2 }
					case 'get_settings':
						return {
							docker_path: '/usr/local/bin/docker',
							java_path: '/usr/bin/java',
							syftbox_path: '/usr/local/bin/syftbox',
							biovault_path: 'bv',
							email: 'tester@example.com',
							ai_api_url: 'https://openrouter.ai/api/v1/chat/completions',
							ai_api_token: 'sk-test',
							ai_model: 'openrouter/auto',
						}
					default:
						return null
				}
			}

			w.__SQL_AI_PROVIDER__ = {
				async generate(prompt) {
					const trimmed = prompt.trim()
					if (trimmed.length === 0) {
						return ''
					}
					return responses.aiSql
				},
			}
		})

		await page.goto(`http://localhost:${process.env.UI_PORT || 8082}`)
		await page.waitForLoadState('networkidle')
	})

	test('displays tables, schema, and query results', async ({ page }) => {
		// First make sure workbench panel exists
		await expect(page.locator('.workbench-panel')).toBeVisible()

		// Click SQL in the workbench (bottom panel)
		const sqlTab = page.locator('.workbench-tab[data-workbench-tab="sql"]')
		await expect(sqlTab).toBeVisible()
		await sqlTab.click()

		// Wait a moment for panel to expand and content to load
		await page.waitForTimeout(500)

		// Wait for SQL table list to be visible (which means panel expanded and SQL loaded)
		const tableList = page.locator('#sql-table-list .sql-table-btn')
		await expect(tableList).toHaveCount(2)
		await expect(tableList.nth(0)).toHaveText('participants')

		await tableList.nth(0).click()

		await expect(page.locator('#sql-status')).toHaveText(/Query completed successfully/i)
		await expect(page.locator('#sql-result-table thead tr th').first()).toHaveText('id')
		await expect(page.locator('#sql-result-table tbody tr')).toHaveCount(2)
		await expect(page.locator('#sql-table-schema')).toContainText('participant_id')
		await expect(page.locator('#sql-result-meta')).toContainText('2 rows')
	})

	test('AI assistant populates the SQL editor', async ({ page }) => {
		// First make sure workbench panel exists
		await expect(page.locator('.workbench-panel')).toBeVisible()

		// Click SQL in the workbench (bottom panel)
		const sqlTab = page.locator('.workbench-tab[data-workbench-tab="sql"]')
		await expect(sqlTab).toBeVisible()
		await sqlTab.click()

		// Wait a moment for panel to expand and content to load
		await page.waitForTimeout(500)

		// Wait for SQL AI prompt to be visible (which means panel expanded and SQL loaded)
		const prompt = page.locator('#sql-ai-prompt')
		await expect(prompt).toBeVisible()
		await prompt.fill('Show latest participant records.')
		await page.locator('#sql-ai-submit-btn').click()

		await expect(page.locator('#sql-ai-status')).toHaveText(/SQL generated/i)
		const editorValue = await page.locator('#sql-editor-input').inputValue()
		await expect(editorValue).toContain('SELECT participant_id')
	})
})
