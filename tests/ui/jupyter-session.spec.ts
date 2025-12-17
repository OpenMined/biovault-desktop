/**
 * Jupyter Session Test
 * Creates a solo session and interacts with Jupyter notebook
 * @tag jupyter-session
 *
 * NOTE: When adding new backend commands to tests, remember to also add them
 * to src-tauri/src/ws_bridge.rs for the WebSocket bridge to work in browser mode.
 * Required commands for this test:
 * - get_session_jupyter_status
 * - launch_session_jupyter
 * - stop_session_jupyter
 * - reset_session_jupyter
 */
import { expect, test, type Page } from '@playwright/test'
import WebSocket from 'ws'
import { waitForAppReady } from './test-helpers.js'

const TEST_TIMEOUT = 180_000 // 3 minutes max
const UI_TIMEOUT = 5_000
const JUPYTER_STARTUP_TIMEOUT = 90_000 // 90 seconds for Jupyter startup (cache should be warm)

test.describe.configure({ timeout: TEST_TIMEOUT })

interface Backend {
	invoke: (cmd: string, args?: Record<string, unknown>) => Promise<any>
	close: () => Promise<void>
}

async function setWsPort(page: Page, port: number) {
	await page.addInitScript((portNum: number) => {
		const w = window as any
		w.__DEV_WS_BRIDGE_PORT__ = portNum
		w.process = w.process || {}
		w.process.env = w.process.env || {}
		w.process.env.USE_REAL_INVOKE = 'true'
	}, port)
}

async function connectBackend(port: number): Promise<Backend> {
	const socket = new WebSocket(`ws://localhost:${port}`)
	await new Promise<void>((resolve, reject) => {
		const timeout = setTimeout(() => reject(new Error(`WS connect timeout on port ${port}`)), 5_000)
		socket.once('open', () => {
			clearTimeout(timeout)
			resolve()
		})
		socket.once('error', (err) => {
			clearTimeout(timeout)
			reject(err)
		})
	})

	let nextId = 0
	const pending = new Map<number, { resolve: (v: any) => void; reject: (e: any) => void }>()

	socket.on('message', (data) => {
		let parsed: any
		try {
			parsed = JSON.parse(data.toString())
		} catch {
			return
		}
		const entry = pending.get(parsed?.id)
		if (!entry) return
		pending.delete(parsed.id)
		if (parsed.error) entry.reject(new Error(parsed.error))
		else entry.resolve(parsed.result)
	})

	function invoke(cmd: string, args: Record<string, unknown> = {}) {
		const id = ++nextId
		socket.send(JSON.stringify({ id, cmd, args }))
		return new Promise<any>((resolve, reject) => {
			pending.set(id, { resolve, reject })
			setTimeout(() => {
				if (!pending.has(id)) return
				pending.delete(id)
				reject(new Error(`WS invoke timeout: ${cmd}`))
			}, 30_000)
		})
	}

	async function close() {
		if (socket.readyState !== WebSocket.OPEN) return
		await new Promise<void>((resolve) => {
			socket.once('close', () => resolve())
			socket.close()
		})
	}

	return { invoke, close }
}

test.describe('Jupyter Session @jupyter-session', () => {
	test('create solo session and run notebook cell', async ({ browser }) => {
		const wsPort = Number.parseInt(process.env.DEV_WS_BRIDGE_PORT_BASE || '3333', 10)
		const email = process.env.CLIENT1_EMAIL || 'client1@sandbox.local'

		const context = await browser.newContext()
		const page = await context.newPage()

		await setWsPort(page, wsPort)

		const backend = await connectBackend(wsPort)

		await page.goto(process.env.UI_BASE_URL || 'http://localhost:8082')
		await waitForAppReady(page, { timeout: 10_000 })

		// Check if onboarding is needed
		const isOnboarded = await backend.invoke('check_is_onboarded')
		if (!isOnboarded) {
			// Complete onboarding via backend
			await backend.invoke('complete_onboarding', { email })
			// Generate keys
			await backend.invoke('key_generate', { email, force: false })
			// Reload page after onboarding
			await page.reload()
			await waitForAppReady(page, { timeout: 10_000 })
		}

		// Verify we're logged in
		await backend.invoke('get_dev_mode_info')

		// ============================================================
		// Navigate to Sessions tab
		// ============================================================
		await page.locator('.nav-item[data-tab="sessions"]').click()
		await expect(page.locator('.sessions-container')).toBeVisible({ timeout: UI_TIMEOUT })

		// ============================================================
		// Create a solo session (no peer)
		// ============================================================
		await page.locator('#new-session-btn').click()
		await expect(page.locator('#create-session-modal')).toBeVisible({ timeout: UI_TIMEOUT })

		const sessionName = `Jupyter-Test-${Date.now()}`
		await page.locator('#session-name-input').fill(sessionName)
		// Leave peer input empty for solo session

		await page.locator('#confirm-create-session-btn').click()
		await expect(page.locator('#create-session-modal')).toBeHidden({ timeout: UI_TIMEOUT })

		// Wait for session to appear in list and be selected
		await expect(page.locator('#session-name')).toContainText(sessionName, { timeout: UI_TIMEOUT })

		// ============================================================
		// Launch Jupyter with example notebooks
		// ============================================================

		// Check the "Copy examples" checkbox to get the 01-hello-beaver.ipynb notebook
		console.log('Looking for Copy examples checkbox...')
		const copyExamplesCheckbox = page.locator('#copy-examples-checkbox')
		if (await copyExamplesCheckbox.isVisible({ timeout: 2000 }).catch(() => false)) {
			console.log('Checking Copy examples checkbox...')
			await copyExamplesCheckbox.check()
			console.log('Copy examples checkbox checked!')
		} else {
			console.log('WARNING: Copy examples checkbox not found!')
		}

		console.log('Clicking Launch Jupyter button...')
		const launchBtn = page.locator('#launch-session-jupyter-btn')
		await expect(launchBtn).toBeVisible({ timeout: UI_TIMEOUT })
		await launchBtn.click()
		console.log('Launch button clicked, waiting for Jupyter to start...')

		// Wait for Jupyter status to change to "Running"
		await expect(page.locator('.jupyter-status-indicator')).toContainText('Running', {
			timeout: JUPYTER_STARTUP_TIMEOUT,
		})
		console.log('Jupyter is running!')

		// Get the Jupyter URL from the link and open in a new tab
		const openJupyterLink = page.locator('#session-jupyter-link')
		await expect(openJupyterLink).toBeVisible({ timeout: UI_TIMEOUT })

		// Get the href attribute
		const jupyterUrl = await openJupyterLink.getAttribute('href')
		if (!jupyterUrl) throw new Error('Jupyter URL not found in link')

		// Create a new page and navigate to Jupyter
		const jupyterPage = await context.newPage()
		await jupyterPage.goto(jupyterUrl)
		await jupyterPage.waitForLoadState('networkidle')

		// ============================================================
		// Interact with Jupyter notebook
		// ============================================================

		// Wait for JupyterLab to fully load
		console.log('Waiting for JupyterLab to load...')
		await jupyterPage.waitForSelector('.jp-Launcher, .jp-NotebookPanel, .jp-DirListing', {
			timeout: 30_000,
		})
		console.log('JupyterLab loaded!')

		// Dismiss any notification popups (like "Would you like to get notified about official Jupyter news?")
		const noButton = jupyterPage.locator('button:has-text("No")').first()
		if (await noButton.isVisible({ timeout: 2000 }).catch(() => false)) {
			console.log('Dismissing notification popup...')
			await noButton.click()
			await jupyterPage.waitForTimeout(500)
		}

		// Look for the 01-hello-beaver.ipynb file in the file browser (left panel)
		console.log('Looking for file browser...')
		const fileBrowser = jupyterPage.locator('.jp-DirListing-content')
		await expect(fileBrowser).toBeVisible({ timeout: 5000 })
		console.log('File browser visible!')

		// Find the notebook item - it shows as truncated text like "01-hello-beaver.i..."
		const helloNotebook = fileBrowser
			.locator('.jp-DirListing-item')
			.filter({ hasText: /01-hello-beaver/i })
			.first()

		if (await helloNotebook.isVisible({ timeout: 5000 }).catch(() => false)) {
			console.log('Found 01-hello-beaver notebook, double-clicking to open...')
			await helloNotebook.dblclick()
			console.log('Waiting for notebook panel to appear...')
			await jupyterPage.waitForSelector('.jp-NotebookPanel', { timeout: 15_000 })
			console.log('Notebook panel opened!')
		} else {
			console.log('WARNING: 01-hello-beaver not found, falling back to creating new notebook...')
			const pythonNotebook = jupyterPage
				.locator('.jp-LauncherCard')
				.filter({ hasText: /Python 3/ })
				.first()
			if (await pythonNotebook.isVisible({ timeout: 2000 }).catch(() => false)) {
				console.log('Clicking Python 3 launcher card...')
				await pythonNotebook.click()
				await jupyterPage.waitForSelector('.jp-NotebookPanel', { timeout: 15_000 })
			} else {
				console.log('ERROR: Could not find launcher card either!')
			}
		}

		// Wait for notebook to be ready with code cells
		console.log('Waiting for code cells...')
		await jupyterPage.waitForSelector('.jp-CodeCell', { timeout: 15_000 })
		console.log('Code cells ready!')

		// Dismiss the notification popup if it appears again
		const noButton2 = jupyterPage.locator('button:has-text("No")').first()
		if (await noButton2.isVisible({ timeout: 1000 }).catch(() => false)) {
			await noButton2.click()
			await jupyterPage.waitForTimeout(500)
		}

		// Wait for notebook to fully render
		await jupyterPage.waitForTimeout(2000)

		// Use the Run menu to "Run All Cells" - this runs ALL cells in the notebook
		console.log('Running all cells via Run menu...')

		// Click on the Run menu
		const runMenu = jupyterPage.locator('div.lm-MenuBar-itemLabel:has-text("Run")')
		await runMenu.click()
		await jupyterPage.waitForTimeout(500)

		// Click "Run All Cells" (exact match to avoid "Restart Kernel and Run All Cells...")
		const runAllOption = jupyterPage.getByText('Run All Cells', { exact: true })
		await runAllOption.click()

		console.log('Executing all cells...')

		// Wait for execution to complete - watch for kernel to become idle
		// The kernel indicator shows [*] while busy and a number when idle
		// Give it enough time to run all cells
		await jupyterPage.waitForTimeout(5000)

		// Wait for kernel to become idle (circle icon instead of filled)
		try {
			// The kernel status shows in the toolbar - wait for it to show "Idle"
			await jupyterPage.waitForFunction(
				() => {
					const status = document.querySelector('.jp-Notebook-ExecutionIndicator')
					return status?.textContent?.includes('Idle') || !status?.textContent?.includes('Busy')
				},
				{ timeout: 120_000 },
			)
		} catch {
			// If we can't detect idle status, just wait a reasonable time
			console.log('Could not detect kernel idle, waiting 30s...')
			await jupyterPage.waitForTimeout(30_000)
		}

		console.log('All cells executed!')

		// Scroll to the bottom of the notebook to see all outputs
		await jupyterPage.keyboard.press('End')
		await jupyterPage.waitForTimeout(1000)

		// Scroll back to top
		await jupyterPage.keyboard.press('Home')
		await jupyterPage.waitForTimeout(500)

		// Verify that we have some output in the notebook
		const outputAreas = jupyterPage.locator('.jp-OutputArea-output')
		const outputCount = await outputAreas.count()
		console.log(`Found ${outputCount} output areas`)
		expect(outputCount).toBeGreaterThan(0)

		// ============================================================
		// Verify specific notebook outputs to confirm it ran correctly
		// ============================================================
		console.log('Verifying notebook outputs...')

		// Get all output text
		const allOutputText = await jupyterPage.locator('.jp-OutputArea').allTextContents()
		const combinedOutput = allOutputText.join('\n')
		console.log('=== Notebook Output Summary ===')
		console.log(combinedOutput.substring(0, 2000))
		console.log('=== End Output Summary ===')

		// Check for evidence that beaver imported successfully
		// The notebook should show BeaverContext or session info
		const hasBeaverOutput =
			combinedOutput.includes('BeaverContext') ||
			combinedOutput.includes('Session') ||
			combinedOutput.includes('datasets') ||
			combinedOutput.includes('client1@sandbox') ||
			combinedOutput.includes('bv.')

		if (!hasBeaverOutput) {
			console.log('WARNING: No beaver-related output found. Notebook may not have run correctly.')
		}

		// Assert the final cell output to confirm notebook ran to completion
		const expectedFinalOutput = 'Total revenue (real data): $35.80'
		if (combinedOutput.includes(expectedFinalOutput)) {
			console.log(`✅ Found expected final output: "${expectedFinalOutput}"`)
		} else {
			console.log(`❌ Expected final output not found: "${expectedFinalOutput}"`)
			console.log('Full output (last 500 chars):', combinedOutput.slice(-500))
			throw new Error(`Notebook did not produce expected output: "${expectedFinalOutput}"`)
		}

		// Check that cell execution numbers are present (indicates cells ran)
		const executionIndicators = jupyterPage.locator('.jp-InputArea-prompt')
		const execCount = await executionIndicators.count()
		console.log(`Found ${execCount} executed cells (with [n] indicators)`)
		expect(execCount).toBeGreaterThan(0)

		// ============================================================
		// Check for cell errors and log them
		// ============================================================
		const errorOutputs = jupyterPage.locator(
			'[data-mime-type="application/vnd.jupyter.stderr"], .jp-OutputArea-output .jp-RenderedText[data-mime-type="application/vnd.jupyter.stderr"]',
		)
		const errorCount = await errorOutputs.count()

		if (errorCount > 0) {
			console.log(`\n${'='.repeat(60)}`)
			console.log(`⚠️  Found ${errorCount} stderr output(s) in notebook:`)
			console.log('='.repeat(60))

			for (let i = 0; i < errorCount; i++) {
				const errorText = await errorOutputs.nth(i).textContent()
				if (errorText) {
					console.log(`\n--- Stderr ${i + 1} ---`)
					console.log(errorText)
				}
			}
			console.log('='.repeat(60))
		} else {
			console.log('✅ No stderr outputs in notebook')
		}

		// Check for Python tracebacks/exceptions
		const tracebackOutputs = jupyterPage.locator(
			'.jp-OutputArea-output pre:has-text("Traceback"), .jp-OutputArea-output pre:has-text("Error:")',
		)
		const tracebackCount = await tracebackOutputs.count()

		if (tracebackCount > 0) {
			console.log(`\n${'='.repeat(60)}`)
			console.log(`❌ Found ${tracebackCount} Python traceback(s)/error(s):`)
			console.log('='.repeat(60))

			for (let i = 0; i < tracebackCount; i++) {
				const tbText = await tracebackOutputs.nth(i).textContent()
				if (tbText) {
					console.log(`\n--- Error ${i + 1} ---`)
					console.log(tbText)
				}
			}

			// Fail the test if there are Python errors
			console.log('\n' + '='.repeat(60))
			throw new Error(
				`Notebook execution failed with ${tracebackCount} Python error(s). See output above.`,
			)
		}

		// Pause at the end so user can inspect the outputs
		// Use a longer timeout for interactive viewing (default 10s for inspection)
		const pauseTime = process.env.JUPYTER_PAUSE_TIME
			? parseInt(process.env.JUPYTER_PAUSE_TIME, 10)
			: 10_000
		console.log(`Pausing for ${pauseTime / 1000} seconds to view outputs...`)
		await jupyterPage.waitForTimeout(pauseTime)

		// ============================================================
		// Cleanup
		// ============================================================
		await backend.close()
		await context.close()
	})
})
