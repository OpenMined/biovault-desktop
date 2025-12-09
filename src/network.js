/**
 * Network module - Manages contacts, network discovery, and published datasets
 */

export function createNetworkModule({ invoke, shellApi }) {
	let _currentScanResult = null
	let _currentDatasets = []
	let _currentView = 'peers'
	let _searchQuery = ''

	function buildIdenticon(seed, size = 48) {
		let hash = 0
		for (let i = 0; i < seed.length; i += 1) {
			hash = (hash * 31 + seed.charCodeAt(i)) >>> 0
		}
		const hue = hash % 360
		const bg = `hsl(${hue}, 40%, 92%)`
		const fg = `hsl(${hue}, 55%, 45%)`

		const grid = 5
		const cell = size / grid
		let rects = ''
		for (let y = 0; y < grid; y += 1) {
			for (let x = 0; x < Math.ceil(grid / 2); x += 1) {
				const idx = y * grid + x
				const bit = (hash >> idx % 32) & 1
				if (bit) {
					rects += `<rect x="${x * cell}" y="${y * cell}" width="${cell}" height="${cell}" fill="${fg}"/>`
					if (x !== grid - 1 - x) {
						rects += `<rect x="${(grid - 1 - x) * cell}" y="${y * cell}" width="${cell}" height="${cell}" fill="${fg}"/>`
					}
				}
			}
		}
		return `<svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" xmlns="http://www.w3.org/2000/svg"><rect width="${size}" height="${size}" fill="${bg}" rx="8"/>${rects}</svg>`
	}

	function formatFileSize(bytes) {
		if (!bytes) return 'Unknown size'
		if (bytes < 1024) return `${bytes} B`
		if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
		if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
		return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`
	}

	function setViewMode(mode) {
		if (mode !== 'peers' && mode !== 'datasets') return
		_currentView = mode

		const peersView = document.getElementById('peers-view')
		const datasetsView = document.getElementById('datasets-view')

		if (peersView && datasetsView) {
			peersView.style.display = mode === 'peers' ? 'block' : 'none'
			datasetsView.style.display = mode === 'datasets' ? 'block' : 'none'
		}

		const toggleButtons = document.querySelectorAll('#network-view-toggle .pill-button')
		toggleButtons.forEach((btn) => {
			if (btn.dataset.view === mode) {
				btn.classList.add('active')
			} else {
				btn.classList.remove('active')
			}
		})

		// Update search placeholder
		const searchInput = document.getElementById('network-search-input')
		if (searchInput) {
			searchInput.placeholder = mode === 'peers' ? 'Search peers...' : 'Search datasets...'
		}

		applySearchFilter()
	}

	function applySearchFilter() {
		const query = _searchQuery.toLowerCase().trim()

		if (_currentView === 'peers') {
			// Filter peer cards
			const contactCards = document.querySelectorAll('#contacts-list .contact-card')
			const discoveredCards = document.querySelectorAll('#network-list .contact-card')

			;[...contactCards, ...discoveredCards].forEach((card) => {
				const email = card.dataset.email?.toLowerCase() || ''
				const matches = !query || email.includes(query)
				card.style.display = matches ? 'flex' : 'none'
			})
		} else {
			// Filter dataset rows
			const datasetItems = document.querySelectorAll('#datasets-list .dataset-item')
			datasetItems.forEach((item) => {
				const name = item.dataset.name?.toLowerCase() || ''
				const owner = item.dataset.owner?.toLowerCase() || ''
				const matches = !query || name.includes(query) || owner.includes(query)
				item.style.display = matches ? 'block' : 'none'
			})
		}
	}

	function createContactCard(contact, isContact) {
		const template = document.getElementById('contact-card-template')
		if (!template) {
			console.error('contact-card-template not found in DOM')
			return null
		}

		const card = template.content.cloneNode(true).querySelector('.contact-card')
		if (!card) {
			console.error('.contact-card not found in template')
			return null
		}
		card.dataset.email = contact.identity

		// Avatar with identicon
		const avatarEl = card.querySelector('.contact-avatar')
		if (avatarEl) {
			avatarEl.innerHTML = buildIdenticon(contact.identity, 48)
		}

		// Email
		const emailEl = card.querySelector('.contact-email')
		if (emailEl) {
			emailEl.textContent = contact.identity
		}

		// Fingerprint
		const fpEl = card.querySelector('.contact-fingerprint')
		if (fpEl) {
			const shortFp = contact.fingerprint ? contact.fingerprint.slice(0, 16) + '...' : 'Unknown'
			fpEl.textContent = shortFp
			fpEl.title = contact.fingerprint || 'Unknown fingerprint'
		}

		// Path and open folder button (only for contacts)
		const pathEl = card.querySelector('.contact-path')
		const openFolderBtn = card.querySelector('.open-folder-btn')
		if (pathEl) {
			if (isContact && contact.local_bundle_path) {
				pathEl.textContent = contact.local_bundle_path
				pathEl.style.display = 'block'
				if (openFolderBtn) {
					openFolderBtn.style.display = 'inline-flex'
					openFolderBtn.addEventListener('click', (e) => {
						e.stopPropagation()
						handleOpenBundleFolder(contact.local_bundle_path)
					})
				}
			} else {
				pathEl.style.display = 'none'
				if (openFolderBtn) {
					openFolderBtn.style.display = 'none'
				}
			}
		}

		// Status badges
		const trustedBadge = card.querySelector('.status-badge.trusted')
		const warningBadge = card.querySelector('.status-badge.warning')

		if (isContact) {
			if (contact.has_changed) {
				trustedBadge.style.display = 'none'
				warningBadge.style.display = 'inline-flex'
				warningBadge.textContent = 'Key Changed!'
			} else {
				trustedBadge.style.display = 'inline-flex'
				warningBadge.style.display = 'none'
			}
		} else {
			trustedBadge.style.display = 'none'
			warningBadge.style.display = 'none'
		}

		// Action buttons
		const messageBtn = card.querySelector('.message-btn')
		const addBtn = card.querySelector('.add-btn')
		const trustBtn = card.querySelector('.trust-btn')
		const removeBtn = card.querySelector('.remove-btn')

		if (isContact) {
			messageBtn.style.display = 'inline-flex'
			addBtn.style.display = 'none'
			removeBtn.style.display = 'inline-flex'
			trustBtn.style.display = contact.has_changed ? 'inline-flex' : 'none'
		} else {
			messageBtn.style.display = 'none'
			addBtn.style.display = 'inline-flex'
			trustBtn.style.display = 'none'
			removeBtn.style.display = 'none'
		}

		// Event handlers
		messageBtn.addEventListener('click', () => handleMessageContact(contact.identity))
		addBtn.addEventListener('click', () => handleAddContact(contact.identity))
		trustBtn.addEventListener('click', () => handleTrustChangedKey(contact.identity))
		removeBtn.addEventListener('click', () => handleRemoveContact(contact.identity))

		return card
	}

	function createDatasetCard(dataset) {
		const template = document.getElementById('dataset-card-template')
		if (!template) {
			console.error('dataset-card-template not found in DOM')
			return null
		}

		// Clone entire template content (row + assets panel)
		const fragment = template.content.cloneNode(true)
		const row = fragment.querySelector('.dataset-row')
		const assetsPanel = fragment.querySelector('.dataset-assets-panel')

		if (!row) {
			console.error('.dataset-row not found in template')
			return null
		}

		// Create wrapper to hold both row and expandable panel
		const wrapper = document.createElement('div')
		wrapper.className = 'dataset-item'
		wrapper.dataset.name = dataset.name
		wrapper.dataset.owner = dataset.owner

		row.dataset.name = dataset.name
		row.dataset.owner = dataset.owner
		if (dataset.is_own) {
			row.classList.add('is-own')
		}

		// Owner with identicon
		const ownerIdenticonEl = row.querySelector('.owner-identicon')
		if (ownerIdenticonEl) {
			const parent = ownerIdenticonEl.parentElement
			if (parent) {
				const identiconSvg = buildIdenticon(dataset.owner, 32)
				const span = document.createElement('span')
				span.innerHTML = identiconSvg
				span.style.display = 'inline-flex'
				parent.replaceChild(span, ownerIdenticonEl)
			}
		}
		const ownerEmailEl = row.querySelector('.owner-email')
		if (ownerEmailEl) {
			ownerEmailEl.textContent = dataset.owner
		}

		// Dataset name
		const nameEl = row.querySelector('.dataset-name')
		if (nameEl) {
			nameEl.textContent = dataset.name
		}

		// Version badge
		const versionEl = row.querySelector('.dataset-version')
		if (versionEl) {
			versionEl.textContent = dataset.version || 'v1.0.0'
		}

		// Description
		const descEl = row.querySelector('.dataset-description')
		if (descEl) {
			descEl.textContent = dataset.description || ''
		}

		// Assets count and expand button
		const assetsCountEl = row.querySelector('.assets-count')
		const expandBtn = row.querySelector('.expand-assets-btn')
		const assetCount = dataset.assets?.length || 0

		if (assetsCountEl) {
			assetsCountEl.textContent = assetCount
		}

		// Hide expand button if no assets
		if (expandBtn && assetCount === 0) {
			expandBtn.style.display = 'none'
		}

		// Populate assets panel
		const assetsListEl = assetsPanel?.querySelector('.assets-list')
		if (assetsListEl && assetCount > 0) {
			dataset.assets.forEach((asset) => {
				const assetRow = createAssetRow(asset)
				if (assetRow) {
					assetsListEl.appendChild(assetRow)
				}
			})
		}

		// Toggle assets panel on expand button click
		if (expandBtn && assetsPanel) {
			expandBtn.addEventListener('click', () => {
				const isExpanded = assetsPanel.style.display !== 'none'
				assetsPanel.style.display = isExpanded ? 'none' : 'block'
				expandBtn.classList.toggle('expanded', !isExpanded)
			})
		}

		// Status badge - show "YOUR DATASET" for own, "Trusted" for trusted peers
		const trustedBadge = row.querySelector('.status-badge.trusted')
		if (trustedBadge) {
			if (dataset.is_own) {
				trustedBadge.textContent = 'YOURS'
				trustedBadge.style.display = 'inline-flex'
				trustedBadge.style.background = '#e0e7ff'
				trustedBadge.style.color = '#4338ca'
			} else if (dataset.is_trusted) {
				trustedBadge.textContent = 'Trusted'
				trustedBadge.style.display = 'inline-flex'
			} else {
				trustedBadge.style.display = 'none'
			}
		}

		// Action buttons
		const newSessionBtn = row.querySelector('.new-session-btn')
		const addPeerBtn = row.querySelector('.add-peer-btn')
		const messagePeerBtn = row.querySelector('.message-peer-btn')
		const openDatasetBtn = row.querySelector('.open-dataset-btn')

		// For own datasets: hide new session, add peer, and message buttons
		if (dataset.is_own) {
			if (newSessionBtn) newSessionBtn.style.display = 'none'
			if (addPeerBtn) addPeerBtn.style.display = 'none'
			if (messagePeerBtn) messagePeerBtn.style.display = 'none'
		} else if (dataset.is_trusted) {
			if (addPeerBtn) addPeerBtn.style.display = 'none'
			if (messagePeerBtn) messagePeerBtn.style.display = 'inline-flex'
		} else {
			if (addPeerBtn) addPeerBtn.style.display = 'inline-flex'
			if (messagePeerBtn) messagePeerBtn.style.display = 'none'
		}

		// Event handlers
		if (!dataset.is_own && newSessionBtn) {
			newSessionBtn.addEventListener('click', () => handleNewSession(dataset))
		}
		if (addPeerBtn) {
			addPeerBtn.addEventListener('click', () => handleNavigateToPeers(dataset.owner))
		}
		if (messagePeerBtn) {
			messagePeerBtn.addEventListener('click', () => handleMessageContact(dataset.owner))
		}
		if (openDatasetBtn) {
			openDatasetBtn.addEventListener('click', () => handleOpenDatasetFolder(dataset.dataset_path))
		}

		// Populate code snippet
		const codeSnippetEl = assetsPanel?.querySelector('.code-snippet-code code')
		if (codeSnippetEl) {
			const snippet = `import beaver
bv = beaver.ctx()
dataset = bv.datasets["${dataset.owner}"]["${dataset.name}"]`
			codeSnippetEl.textContent = snippet
		}

		// Copy snippet button
		const copyBtn = assetsPanel?.querySelector('.copy-snippet-btn')
		if (copyBtn && codeSnippetEl) {
			copyBtn.addEventListener('click', async () => {
				try {
					await navigator.clipboard.writeText(codeSnippetEl.textContent)
					copyBtn.classList.add('copied')
					const labelSpan = copyBtn.querySelector('span')
					if (labelSpan) labelSpan.textContent = 'Copied!'
					setTimeout(() => {
						copyBtn.classList.remove('copied')
						if (labelSpan) labelSpan.textContent = 'Copy'
					}, 2000)
				} catch (err) {
					console.error('Failed to copy:', err)
				}
			})
		}

		wrapper.appendChild(row)
		if (assetsPanel) {
			wrapper.appendChild(assetsPanel)
		}

		return wrapper
	}

	function createAssetRow(asset) {
		const template = document.getElementById('asset-row-template')
		if (!template) return null

		const row = template.content.cloneNode(true).querySelector('.asset-row')
		if (!row) return null

		row.dataset.key = asset.key

		const keyEl = row.querySelector('.asset-key')
		if (keyEl) {
			keyEl.textContent = asset.key
		}

		const typeEl = row.querySelector('.asset-type')
		if (typeEl) {
			typeEl.textContent = asset.kind || 'unknown'
		}

		const sizeEl = row.querySelector('.asset-size')
		if (sizeEl) {
			sizeEl.textContent = formatFileSize(asset.mock_size)
		}

		const openBtn = row.querySelector('.open-asset-btn')
		if (openBtn) {
			if (asset.mock_path) {
				openBtn.addEventListener('click', () => handleOpenAssetFolder(asset.mock_path))
			} else {
				openBtn.style.opacity = '0.3'
				openBtn.disabled = true
			}
		}

		return row
	}

	function renderContacts(contacts) {
		const listEl = document.getElementById('contacts-list')
		const emptyEl = document.getElementById('contacts-empty')
		const countEl = document.getElementById('contacts-count')

		const deduped = []
		const seen = new Map()
		;(contacts || []).forEach((c) => {
			const id = c.identity
			if (!id) return
			if (!seen.has(id)) {
				seen.set(id, deduped.length)
				deduped.push(c)
				return
			}
			const idx = seen.get(id)
			const existing = deduped[idx]
			const existingHasPath = !!existing.local_bundle_path
			const candidateHasPath = !!c.local_bundle_path
			const candidateChanged = !!c.has_changed
			const existingChanged = !!existing.has_changed
			if (
				(candidateHasPath && !existingHasPath) ||
				(candidateHasPath === existingHasPath && candidateChanged && !existingChanged)
			) {
				deduped[idx] = c
			}
		})

		if (!listEl) return

		while (listEl.firstChild) {
			listEl.removeChild(listEl.firstChild)
		}
		if (emptyEl) {
			listEl.appendChild(emptyEl)
		}

		if (deduped.length === 0) {
			if (emptyEl) emptyEl.style.display = 'block'
			if (countEl) countEl.textContent = '0'
			return
		}

		if (emptyEl) emptyEl.style.display = 'none'
		if (countEl) countEl.textContent = deduped.length.toString()

		deduped.forEach((contact) => {
			const card = createContactCard(contact, true)
			if (card) {
				listEl.appendChild(card)
			}
		})
	}

	function renderDiscovered(discovered) {
		const listEl = document.getElementById('network-list')
		const emptyEl = document.getElementById('network-empty')
		const countEl = document.getElementById('network-count')

		const deduped = []
		const seen = new Set()
		;(discovered || []).forEach((c) => {
			if (!c.identity || seen.has(c.identity)) return
			seen.add(c.identity)
			deduped.push(c)
		})

		if (!listEl) return

		while (listEl.firstChild) {
			listEl.removeChild(listEl.firstChild)
		}
		if (emptyEl) {
			listEl.appendChild(emptyEl)
		}

		if (deduped.length === 0) {
			if (emptyEl) emptyEl.style.display = 'block'
			if (countEl) countEl.textContent = '0'
			return
		}

		if (emptyEl) emptyEl.style.display = 'none'
		if (countEl) countEl.textContent = deduped.length.toString()

		deduped.forEach((contact) => {
			const card = createContactCard(contact, false)
			if (card) {
				listEl.appendChild(card)
			}
		})
	}

	function renderDatasets(datasets) {
		const listEl = document.getElementById('datasets-list')
		const emptyEl = document.getElementById('datasets-empty')
		const countEl = document.getElementById('datasets-count')

		if (!listEl) return

		while (listEl.firstChild) {
			listEl.removeChild(listEl.firstChild)
		}
		if (emptyEl) {
			listEl.appendChild(emptyEl)
		}

		_currentDatasets = datasets || []

		if (_currentDatasets.length === 0) {
			if (emptyEl) emptyEl.style.display = 'block'
			if (countEl) countEl.textContent = '0'
			return
		}

		if (emptyEl) emptyEl.style.display = 'none'
		if (countEl) countEl.textContent = _currentDatasets.length.toString()

		_currentDatasets.forEach((dataset) => {
			const card = createDatasetCard(dataset)
			if (card) {
				listEl.appendChild(card)
			}
		})
	}

	async function scanNetwork() {
		const refreshBtn = document.getElementById('network-refresh-btn')
		if (refreshBtn) {
			refreshBtn.disabled = true
			refreshBtn.innerHTML =
				'<img src="assets/icons/loader.svg" width="16" height="16" alt="Loading" class="spin" /> Scanning...'
		}

		try {
			// Scan for peers
			const peerResult = await invoke('network_scan_datasites')
			_currentScanResult = peerResult

			renderContacts(peerResult.contacts)
			renderDiscovered(peerResult.discovered)

			console.log('Peer scan complete:', {
				contacts: peerResult.contacts?.length || 0,
				discovered: peerResult.discovered?.length || 0,
			})

			// Scan for datasets
			const datasetResult = await invoke('network_scan_datasets')
			renderDatasets(datasetResult.datasets)

			console.log('Dataset scan complete:', {
				datasets: datasetResult.datasets?.length || 0,
			})

			applySearchFilter()
		} catch (error) {
			console.error('Failed to scan network:', error)
		} finally {
			if (refreshBtn) {
				refreshBtn.disabled = false
				refreshBtn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"></circle><line x1="21" y1="21" x2="16.65" y2="16.65"></line></svg><span>Scan</span>`
			}
		}
	}

	async function handleMessageContact(identity) {
		console.log('Opening message to:', identity)

		if (typeof window.navigateTo === 'function') {
			window.navigateTo('messages')
		}

		setTimeout(() => {
			if (window.__messagesModule?.startNewMessage) {
				window.__messagesModule.startNewMessage(identity)
			} else {
				const recipientInput = document.getElementById('message-recipient-input')
				if (recipientInput) {
					recipientInput.value = identity
					recipientInput.dispatchEvent(new Event('input', { bubbles: true }))
				}
			}
		}, 200)
	}

	async function handleAddContact(identity) {
		try {
			await invoke('network_import_contact', { identity })
			console.log('Added contact:', identity)
			await scanNetwork()
		} catch (error) {
			console.error('Failed to add contact:', error)
			alert(`Failed to add contact: ${error}`)
		}
	}

	async function handleTrustChangedKey(identity) {
		const confirmed = confirm(
			`The key for ${identity} has changed.\n\nThis could mean they regenerated their key, or it could indicate a security issue.\n\nDo you want to trust the new key?`,
		)
		if (!confirmed) return

		try {
			await invoke('network_trust_changed_key', { identity })
			console.log('Trusted new key for:', identity)
			await scanNetwork()
		} catch (error) {
			console.error('Failed to trust key:', error)
			alert(`Failed to trust key: ${error}`)
		}
	}

	async function handleRemoveContact(identity) {
		const confirmed = confirm(
			`Remove ${identity} from your contacts?\n\nYou will no longer be able to send encrypted messages to them until you add them again.`,
		)
		if (!confirmed) return

		try {
			await invoke('network_remove_contact', { identity })
			console.log('Removed contact:', identity)
			await scanNetwork()
		} catch (error) {
			console.error('Failed to remove contact:', error)
			alert(`Failed to remove contact: ${error}`)
		}
	}

	async function handleOpenBundleFolder(bundlePath) {
		if (!bundlePath) return
		try {
			const folderPath = bundlePath.substring(0, bundlePath.lastIndexOf('/'))
			if (shellApi?.open) {
				await shellApi.open(folderPath)
			} else {
				await invoke('open_folder', { path: folderPath })
			}
		} catch (error) {
			console.error('Failed to open folder:', error)
		}
	}

	async function handleOpenDatasetFolder(datasetPath) {
		if (!datasetPath) return
		try {
			const folderPath = datasetPath.substring(0, datasetPath.lastIndexOf('/'))
			await invoke('open_folder', { path: folderPath })
		} catch (error) {
			console.error('Failed to open dataset folder:', error)
		}
	}

	async function handleOpenAssetFolder(assetPath) {
		if (!assetPath) return
		try {
			const folderPath = assetPath.substring(0, assetPath.lastIndexOf('/'))
			await invoke('open_folder', { path: folderPath })
		} catch (error) {
			console.error('Failed to open asset folder:', error)
		}
	}

	function handleNavigateToPeers(owner) {
		// Switch to peers view and focus on the owner
		setViewMode('peers')
		_searchQuery = owner
		const searchInput = document.getElementById('network-search-input')
		if (searchInput) {
			searchInput.value = owner
		}
		applySearchFilter()
	}

	async function handleNewSession(dataset) {
		console.log('Creating new session with dataset:', dataset.name, 'from', dataset.owner)

		// Navigate to sessions tab
		if (typeof window.navigateTo === 'function') {
			window.navigateTo('sessions')
		}

		// Wait for navigation, then open modal with dataset info
		setTimeout(() => {
			if (window.__sessionsModule?.openCreateSessionWithDataset) {
				window.__sessionsModule.openCreateSessionWithDataset(dataset)
			} else {
				// Fallback: just open the create modal
				const createBtn = document.getElementById('create-session-btn')
				if (createBtn) {
					createBtn.click()
				}
			}
		}, 200)
	}

	function init() {
		// Set up refresh button
		const refreshBtn = document.getElementById('network-refresh-btn')
		if (refreshBtn) {
			refreshBtn.addEventListener('click', scanNetwork)
		}

		// Set up view toggle
		const toggleButtons = document.querySelectorAll('#network-view-toggle .pill-button')
		toggleButtons.forEach((btn) => {
			btn.addEventListener('click', () => {
				setViewMode(btn.dataset.view)
			})
		})

		// Set up search
		const searchInput = document.getElementById('network-search-input')
		if (searchInput) {
			searchInput.addEventListener('input', (e) => {
				_searchQuery = e.target.value
				applySearchFilter()
			})
		}

		// Initial scan when tab is first shown
		const networkView = document.getElementById('network-view')
		if (networkView) {
			const observer = new MutationObserver((mutations) => {
				mutations.forEach((mutation) => {
					if (
						mutation.type === 'attributes' &&
						mutation.attributeName === 'class' &&
						networkView.classList.contains('active')
					) {
						scanNetwork()
					}
				})
			})
			observer.observe(networkView, { attributes: true })
		}
	}

	return {
		init,
		scanNetwork,
		setViewMode,
	}
}
