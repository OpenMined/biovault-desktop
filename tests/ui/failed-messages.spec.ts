import { expect, test } from './playwright-fixtures'
import { waitForAppReady, ensureNotInOnboarding } from './test-helpers.js'

test.describe('Failed Messages', () => {
	const mockFailedMessages = [
		{
			id: 'fail-1',
			sender_identity: 'alice@sandbox.local',
			sender_fingerprint: 'ABC123DEF456',
			recipient_fingerprint: 'XYZ789GHI012',
			failure_reason: 'SenderBundleNotCached',
			failure_reason_display: "Sender's key not found in your contacts",
			error_details: 'No cached bundle for sender alice@sandbox.local',
			suggested_action: "Import alice@sandbox.local's public key to decrypt this message",
			created_at: '2025-12-04T10:00:00Z',
			dismissed: false,
		},
		{
			id: 'fail-2',
			sender_identity: 'bob@sandbox.local',
			sender_fingerprint: 'GHI789JKL012',
			recipient_fingerprint: null,
			failure_reason: 'RecipientKeyMismatch',
			failure_reason_display: 'Message was encrypted for a different key',
			error_details: 'Recipient key fingerprint does not match local key',
			suggested_action: 'This message may have been sent before you regenerated your keys',
			created_at: '2025-12-04T09:30:00Z',
			dismissed: false,
		},
	]

	test.beforeEach(async ({ page }) => {
		// Some pages never reach the `load` event (e.g. long-lived connections); avoid flaking on navigation.
		await page.addInitScript(
			(mockData) => {
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
						case 'get_desktop_log_text':
							return ''
						case 'clear_desktop_log':
							return null
						case 'get_desktop_log_dir':
							return '/tmp'
						case 'get_saved_dependency_states':
							return { dependencies: [] }
						case 'get_syftbox_state':
							return { running: true, mode: 'Online' }
						case 'check_syftbox_auth':
							return true
						case 'get_dev_mode_info':
							return { dev_mode: true, dev_syftbox: true }
						case 'get_settings':
							return {
								docker_path: '/usr/local/bin/docker',
								java_path: '/usr/bin/java',
								syftbox_path: '/usr/local/bin/syftbox',
								biovault_path: 'bv',
								email: 'tester@sandbox.local',
								ai_api_url: '',
								ai_api_token: '',
								ai_model: '',
								syftbox_server_url: 'https://syftbox.net',
							}
						case 'list_message_threads':
							return [
								{
									thread_id: 'thread-1',
									subject: 'Test Thread',
									participants: ['tester@sandbox.local', 'alice@sandbox.local'],
									unread_count: 0,
									last_message_at: '2025-12-04T08:00:00Z',
									last_message_preview: 'Hello!',
									has_project: false,
								},
							]
						case 'sync_messages':
							return { new_message_ids: [], new_messages: 0 }
						case 'sync_messages_with_failures':
							return {
								new_message_ids: [],
								new_messages: 0,
								new_failed: 0,
								total_failed: mockData.mockFailedMessages.length,
							}
						case 'list_failed_messages':
							return {
								failed_messages: mockData.mockFailedMessages,
								count: mockData.mockFailedMessages.length,
							}
						case 'count_failed_messages':
							return mockData.mockFailedMessages.length
						case 'dismiss_failed_message':
							return true
						case 'delete_failed_message':
							return true
						case 'network_import_contact':
							return { success: true }
						default:
							return null
					}
				}
			},
			{ mockFailedMessages },
		)

		await page.goto('/', { timeout: 15_000, waitUntil: 'commit' })
	})

	test('shows failed messages badge count', async ({ page }) => {
		await waitForAppReady(page)
		await ensureNotInOnboarding(page)

		// Navigate to Messages tab
		const messagesNavItem = page.locator('.nav-item[data-tab="messages"]')
		await expect(messagesNavItem).toBeVisible({ timeout: 5000 })
		await messagesNavItem.click()

		// Wait for Messages view to be active
		const messagesView = page.locator('#messages-view')
		await expect(messagesView).toBeVisible()

		// Wait for the failed badge to appear
		const failedBadge = page.locator('#failed-messages-badge')
		await expect(failedBadge).toBeVisible({ timeout: 5000 })
		await expect(failedBadge).toHaveText('2')
	})

	test('displays failed messages when clicking Failed filter', async ({ page }) => {
		await waitForAppReady(page)
		await ensureNotInOnboarding(page)

		// Navigate to Messages tab
		const messagesNavItem = page.locator('.nav-item[data-tab="messages"]')
		await expect(messagesNavItem).toBeVisible({ timeout: 5000 })
		await messagesNavItem.click()

		// Wait for Messages view
		const messagesView = page.locator('#messages-view')
		await expect(messagesView).toBeVisible()

		// Click the Failed filter button
		const failedFilter = page.locator('.message-filter[data-filter="failed"]')
		await expect(failedFilter).toBeVisible({ timeout: 5000 })
		await failedFilter.click()

		// Wait for failed messages to load
		await page.waitForTimeout(500)

		// Should see failed message items
		const failedItems = page.locator('.failed-message-item')
		await expect(failedItems).toHaveCount(2)

		// Check first failed message shows sender
		await expect(failedItems.first()).toContainText('alice@sandbox.local')
		await expect(page.locator('.message-thread-error-tag').first()).toHaveText('Missing Key')
	})

	test('shows failed message details when clicking a failed message', async ({ page }) => {
		await waitForAppReady(page)
		await ensureNotInOnboarding(page)

		// Navigate to Messages tab
		const messagesNavItem = page.locator('.nav-item[data-tab="messages"]')
		await expect(messagesNavItem).toBeVisible({ timeout: 5000 })
		await messagesNavItem.click()

		// Wait for Messages view
		const messagesView = page.locator('#messages-view')
		await expect(messagesView).toBeVisible()

		// Click Failed filter
		const failedFilter = page.locator('.message-filter[data-filter="failed"]')
		await failedFilter.click()
		await page.waitForTimeout(500)

		// Click the first failed message
		const failedItem = page.locator('.failed-message-item').first()
		await failedItem.click()

		// Should see the details panel
		const detailsPanel = page.locator('.failed-message-details')
		await expect(detailsPanel).toBeVisible({ timeout: 5000 })

		// Check the content
		await expect(page.locator('.failed-message-header h3')).toContainText(
			'Message Could Not Be Decrypted',
		)
		await expect(page.locator('.info-value').first()).toContainText('alice@sandbox.local')
		await expect(page.locator('.info-value.fingerprint').first()).toContainText('ABC123DEF456')

		// Check action buttons are present
		const actionsDiv = page.locator('.failed-message-actions')
		await expect(actionsDiv.locator('button:has-text("Import Sender\'s Key")')).toBeVisible()
		await expect(actionsDiv.locator('button:has-text("Compose Message to Sender")')).toBeVisible()
		await expect(actionsDiv.locator('button:has-text("Dismiss")')).toBeVisible()
		await expect(actionsDiv.locator('button:has-text("Delete")')).toBeVisible()
	})

	test('shows suggested action for missing key', async ({ page }) => {
		await waitForAppReady(page)
		await ensureNotInOnboarding(page)

		// Navigate to Messages tab
		const messagesNavItem = page.locator('.nav-item[data-tab="messages"]')
		await expect(messagesNavItem).toBeVisible({ timeout: 5000 })
		await messagesNavItem.click()

		// Click Failed filter
		const failedFilter = page.locator('.message-filter[data-filter="failed"]')
		await failedFilter.click()
		await page.waitForTimeout(500)

		// Click the first failed message (alice - missing key)
		const failedItem = page.locator('.failed-message-item').first()
		await failedItem.click()

		// Check suggested action
		const suggestion = page.locator('.failed-message-suggestion')
		await expect(suggestion).toBeVisible()
		await expect(suggestion).toContainText('Import')
		await expect(suggestion).toContainText('public key')
	})

	test('technical details can be expanded', async ({ page }) => {
		await waitForAppReady(page)
		await ensureNotInOnboarding(page)

		// Navigate to Messages tab
		const messagesNavItem = page.locator('.nav-item[data-tab="messages"]')
		await expect(messagesNavItem).toBeVisible({ timeout: 5000 })
		await messagesNavItem.click()

		// Click Failed filter
		const failedFilter = page.locator('.message-filter[data-filter="failed"]')
		await failedFilter.click()
		await page.waitForTimeout(500)

		// Click the first failed message
		const failedItem = page.locator('.failed-message-item').first()
		await failedItem.click()

		// Find and click the technical details summary
		const summary = page.locator('.failed-message-technical summary')
		await expect(summary).toBeVisible()
		await summary.click()

		// Check that the pre content is visible
		const technicalPre = page.locator('.failed-message-technical pre')
		await expect(technicalPre).toBeVisible()
		await expect(technicalPre).toContainText('No cached bundle')
	})
})
