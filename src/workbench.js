// Workbench Panel - Bottom collapsible panel for SQL & Logs
export function createWorkbench({ loadSql, displayLogs }) {
	let isCollapsed = true
	let currentTab = 'logs' // Default to logs (most frequently used)
	let panelHeight = 400
	const MIN_HEIGHT = 150
	const MAX_HEIGHT_PERCENT = 0.7

	const panel = document.getElementById('workbench-panel')
	const resizeHandle = document.querySelector('.workbench-resize-handle')
	const collapseBtn = document.getElementById('workbench-collapse-btn')

	// ============================================================================
	// CORE FUNCTIONS
	// ============================================================================

	function togglePanel(forceOpen = null) {
		if (forceOpen !== null) {
			// Force to specific state
			isCollapsed = !forceOpen
		} else {
			// Toggle current state
			isCollapsed = !isCollapsed
		}

		panel.setAttribute('data-collapsed', isCollapsed.toString())

		if (!isCollapsed) {
			// Panel is OPEN - ensure it has the correct height
			panel.style.height = `${panelHeight}px`

			// Load content
			loadTabContent(currentTab)

			// Update collapse button
			if (collapseBtn) {
				collapseBtn.innerHTML = `
					<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
						<polyline points="6 9 12 15 18 9"/>
					</svg>
				`
				collapseBtn.title = 'Collapse (Esc)'
			}
		} else {
			// Panel is CLOSED - show UP chevron to expand
			if (collapseBtn) {
				collapseBtn.innerHTML = `
					<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
						<polyline points="18 15 12 9 6 15"/>
					</svg>
				`
				collapseBtn.title = 'Expand (Cmd+J)'
			}
		}

		// Save state
		localStorage.setItem('workbench-collapsed', isCollapsed.toString())
	}

	function openPanel(tab = null) {
		if (tab) {
			switchTab(tab)
		}
		if (isCollapsed) {
			togglePanel(true)
		}
	}

	function closePanel() {
		if (!isCollapsed) {
			togglePanel(false)
		}
	}

	function switchTab(tabName) {
		console.log('🔄 Switching workbench tab to:', tabName)
		currentTab = tabName

		// Update workbench tab buttons
		document.querySelectorAll('.workbench-tab').forEach((tab) => {
			if (tab.dataset.workbenchTab === tabName) {
				tab.classList.add('active')
			} else {
				tab.classList.remove('active')
			}
		})

		// Update main nav tabs to show which workbench tab is active (if they exist)
		document.querySelectorAll('.tab[data-tab="sql"], .tab[data-tab="logs"]').forEach((tab) => {
			tab.classList.remove('workbench-active')
		})
		const mainNavTab = document.querySelector(`.tab[data-tab="${tabName}"]`)
		if (mainNavTab && !isCollapsed) {
			mainNavTab.classList.add('workbench-active')
		}

		// Update panel content - remove active from all, add to target
		document.querySelectorAll('.workbench-panel-content').forEach((content) => {
			content.classList.remove('active')
		})

		const activePanel = document.getElementById(`workbench-${tabName}-panel`)
		if (activePanel) {
			activePanel.classList.add('active')
			console.log(`✅ Activated panel: workbench-${tabName}-panel`)
		} else {
			console.warn(`⚠️ Panel not found: workbench-${tabName}-panel`)
		}

		// Load content for the active tab
		loadTabContent(tabName)

		// Save state
		localStorage.setItem('workbench-active-tab', tabName)
	}

	function loadTabContent(tabName) {
		console.log('🔧 Loading workbench content for tab:', tabName)
		switch (tabName) {
			case 'sql':
				if (loadSql) {
					console.log('📊 Calling loadSql()')
					loadSql()
				} else {
					console.warn('⚠️ loadSql function not available')
				}
				break
			case 'logs':
				if (displayLogs) {
					console.log('📋 Calling displayLogs()')
					displayLogs()
				} else {
					console.warn('⚠️ displayLogs function not available')
				}
				break
		}
	}

	// ============================================================================
	// RESIZING
	// ============================================================================

	let isResizing = false
	let startY = 0
	let startHeight = 0

	function startResize(e) {
		isResizing = true
		startY = e.clientY
		startHeight = panelHeight

		resizeHandle.classList.add('resizing')
		document.body.style.cursor = 'row-resize'
		document.body.style.userSelect = 'none'

		document.addEventListener('mousemove', onResize)
		document.addEventListener('mouseup', stopResize)
	}

	function onResize(e) {
		if (!isResizing) return

		const delta = startY - e.clientY
		const newHeight = Math.max(
			MIN_HEIGHT,
			Math.min(startHeight + delta, window.innerHeight * MAX_HEIGHT_PERCENT),
		)

		panelHeight = newHeight
		panel.style.height = `${newHeight}px`

		// Save height
		localStorage.setItem('workbench-height', newHeight.toString())
	}

	function stopResize() {
		if (!isResizing) return

		isResizing = false
		resizeHandle.classList.remove('resizing')
		document.body.style.cursor = ''
		document.body.style.userSelect = ''

		document.removeEventListener('mousemove', onResize)
		document.removeEventListener('mouseup', stopResize)
	}

	// ============================================================================
	// INITIALIZATION
	// ============================================================================

	function init() {
		if (!panel) {
			console.error('❌ Workbench panel not found in DOM')
			return
		}

		console.log('🔧 Initializing workbench panel...')

		// Restore saved state
		const savedCollapsed = localStorage.getItem('workbench-collapsed')
		const savedTab = localStorage.getItem('workbench-active-tab')
		const savedHeight = localStorage.getItem('workbench-height')

		if (savedHeight) {
			panelHeight = parseInt(savedHeight, 10)
			panel.style.height = `${panelHeight}px`
		}

		if (savedTab && (savedTab === 'sql' || savedTab === 'logs')) {
			currentTab = savedTab
			switchTab(savedTab)
		} else {
			// Default to logs on first load
			switchTab('logs')
		}

		if (savedCollapsed === 'false') {
			isCollapsed = false
			panel.setAttribute('data-collapsed', 'false')
			// Update collapse button for open state - DOWN chevron
			if (collapseBtn) {
				collapseBtn.innerHTML = `
					<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
						<polyline points="6 9 12 15 18 9"/>
					</svg>
				`
				collapseBtn.title = 'Collapse (Esc)'
			}
		} else {
			// Update collapse button for collapsed state - UP chevron
			if (collapseBtn) {
				collapseBtn.innerHTML = `
					<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
						<polyline points="18 15 12 9 6 15"/>
					</svg>
				`
				collapseBtn.title = 'Expand (Cmd+J)'
			}
		}

		// Event listeners
		if (collapseBtn) {
			collapseBtn.addEventListener('click', (e) => {
				e.stopPropagation()
				togglePanel() // Toggle instead of always closing
			})
		}

		// Click header to expand/collapse
		const header = document.querySelector('.workbench-header')
		if (header) {
			header.addEventListener('click', (e) => {
				// Don't trigger if clicking on a tab or button
				if (e.target.closest('.workbench-tab') || e.target.closest('.workbench-action-btn')) {
					return
				}

				// Click empty space on header to toggle
				togglePanel()
			})
		}

		// Tab switching
		document.querySelectorAll('.workbench-tab').forEach((tab) => {
			tab.addEventListener('click', (e) => {
				e.stopPropagation() // Prevent header click from firing
				const tabName = tab.dataset.workbenchTab
				if (tabName) {
					// Switch tab first
					switchTab(tabName)
					// Then open panel if collapsed
					if (isCollapsed) {
						togglePanel(true)
					}
				}
			})
		})

		// Resize handle
		if (resizeHandle) {
			resizeHandle.addEventListener('mousedown', startResize)
		}

		// Keyboard shortcuts
		document.addEventListener('keydown', (e) => {
			// Escape to close
			if (e.key === 'Escape' && !isCollapsed) {
				closePanel()
			}
			// Cmd/Ctrl + J to toggle (like VS Code)
			if ((e.metaKey || e.ctrlKey) && e.key === 'j') {
				e.preventDefault()
				togglePanel()
			}
		})

		// Window resize handler
		window.addEventListener('resize', () => {
			const maxHeight = window.innerHeight * MAX_HEIGHT_PERCENT
			if (panelHeight > maxHeight) {
				panelHeight = maxHeight
				panel.style.height = `${panelHeight}px`
			}
		})

		console.log('✅ Workbench initialized:', { isCollapsed, currentTab, panelHeight })
	}

	return {
		init,
		openPanel,
		closePanel,
		togglePanel,
		switchTab,
		isOpen: () => !isCollapsed,
		getCurrentTab: () => currentTab,
	}
}
