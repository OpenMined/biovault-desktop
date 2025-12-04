/**
 * Network module - Manages contacts and network discovery
 */

export function createNetworkModule({ invoke, shellApi }) {
	let _currentScanResult = null

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

	function createContactCard(contact, isContact) {
		const template = document.getElementById('contact-card-template')
		if (!template) {
			console.error('❌ contact-card-template not found in DOM')
			return null
		}

		const card = template.content.cloneNode(true).querySelector('.contact-card')
		if (!card) {
			console.error('❌ .contact-card not found in template')
			return null
		}
		card.dataset.email = contact.identity

		// Avatar with identicon
		const avatarEl = card.querySelector('.contact-avatar')
		if (avatarEl) {
			avatarEl.innerHTML = buildIdenticon(contact.fingerprint || contact.identity, 48)
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
			// Contact actions: show message and remove buttons
			messageBtn.style.display = 'inline-flex'
			addBtn.style.display = 'none'
			removeBtn.style.display = 'inline-flex'

			if (contact.has_changed) {
				trustBtn.style.display = 'inline-flex'
			} else {
				trustBtn.style.display = 'none'
			}
			console.log(`🔑 Contact card for ${contact.identity}: message=visible, remove=visible`)
		} else {
			// Discovered (not yet contact) actions: show add button only
			messageBtn.style.display = 'none'
			addBtn.style.display = 'inline-flex'
			trustBtn.style.display = 'none'
			removeBtn.style.display = 'none'
			console.log(`🌐 Discovered card for ${contact.identity}: add=visible`)
		}

		// Event handlers
		messageBtn.addEventListener('click', () => handleMessageContact(contact.identity))
		addBtn.addEventListener('click', () => handleAddContact(contact.identity))
		trustBtn.addEventListener('click', () => handleTrustChangedKey(contact.identity))
		removeBtn.addEventListener('click', () => handleRemoveContact(contact.identity))

		return card
	}

	function renderContacts(contacts) {
		const listEl = document.getElementById('contacts-list')
		const emptyEl = document.getElementById('contacts-empty')
		const countEl = document.getElementById('contacts-count')

		if (!listEl) {
			console.warn('contacts-list not found in DOM')
			return
		}

		// Clear existing cards (but keep the empty state element)
		listEl.querySelectorAll('.contact-card').forEach((el) => el.remove())

		if (contacts.length === 0) {
			if (emptyEl) emptyEl.style.display = 'block'
			if (countEl) countEl.textContent = '0'
			return
		}

		if (emptyEl) emptyEl.style.display = 'none'
		if (countEl) countEl.textContent = contacts.length.toString()

		contacts.forEach((contact) => {
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

		if (!listEl) {
			console.warn('network-list not found in DOM')
			return
		}

		// Clear existing cards
		listEl.querySelectorAll('.contact-card').forEach((el) => el.remove())

		if (discovered.length === 0) {
			if (emptyEl) emptyEl.style.display = 'block'
			if (countEl) countEl.textContent = '0'
			return
		}

		if (emptyEl) emptyEl.style.display = 'none'
		if (countEl) countEl.textContent = discovered.length.toString()

		discovered.forEach((contact) => {
			const card = createContactCard(contact, false)
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
			const result = await invoke('network_scan_datasites')
			_currentScanResult = result

			console.log('🔍 Network scan result:', result)
			console.log('🔍 Template check:', document.getElementById('contact-card-template'))
			console.log('🔍 Contacts list check:', document.getElementById('contacts-list'))
			console.log('🔍 Network list check:', document.getElementById('network-list'))

			renderContacts(result.contacts)
			renderDiscovered(result.discovered)

			console.log('Network scan complete:', {
				contacts: result.contacts.length,
				discovered: result.discovered.length,
			})
		} catch (error) {
			console.error('Failed to scan network:', error)
		} finally {
			if (refreshBtn) {
				refreshBtn.disabled = false
				refreshBtn.innerHTML =
					'<img src="assets/icons/scan-eye.svg" width="16" height="16" alt="Scan" /> Refresh'
			}
		}
	}

	async function handleMessageContact(identity) {
		console.log('📧 Opening message to:', identity)

		// Switch to messages tab
		if (typeof window.navigateTo === 'function') {
			window.navigateTo('messages')
			console.log('📧 Navigated to messages tab')
		} else {
			console.warn('📧 navigateTo not available')
		}

		// Give time for tab to switch, then start new message
		setTimeout(() => {
			if (window.__messagesModule?.startNewMessage) {
				console.log('📧 Starting new message to:', identity)
				window.__messagesModule.startNewMessage(identity)
			} else {
				console.warn('📧 startNewMessage not available on __messagesModule')
				// Fallback: try to find and fill the recipient input directly
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
			// Refresh the list
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
			// Get the directory containing the bundle file
			const folderPath = bundlePath.substring(0, bundlePath.lastIndexOf('/'))
			if (shellApi?.open) {
				await shellApi.open(folderPath)
			} else {
				// Fallback: use invoke to open folder
				await invoke('open_folder', { path: folderPath })
			}
		} catch (error) {
			console.error('Failed to open folder:', error)
		}
	}

	function init() {
		// Set up refresh button
		const refreshBtn = document.getElementById('network-refresh-btn')
		if (refreshBtn) {
			refreshBtn.addEventListener('click', scanNetwork)
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
	}
}
