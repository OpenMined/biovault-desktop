export function createContactAutocomplete({ invoke, getCurrentUserEmail }) {
	let cachedContacts = null
	let cachedForEmail = null
	const datalistId = 'contact-email-suggestions'

	function escapeHtml(value) {
		const div = document.createElement('div')
		div.textContent = value
		return div.innerHTML
	}

	function ensureDatalist() {
		let datalist = document.getElementById(datalistId)
		if (!datalist) {
			datalist = document.createElement('datalist')
			datalist.id = datalistId
			document.body.appendChild(datalist)
		}
		return datalist
	}

	async function loadContactEmails() {
		const currentEmail = getCurrentUserEmail?.() || null
		if (cachedContacts && cachedForEmail === currentEmail) return cachedContacts

		const contactSet = new Map() // email -> { email, isTrusted }

		try {
			// Load trusted contacts (already in vault)
			const contacts = await invoke('key_list_contacts', { currentEmail })
			for (const c of contacts) {
				if (c.identity && (!currentEmail || c.identity !== currentEmail)) {
					contactSet.set(c.identity, { email: c.identity, isTrusted: true })
				}
			}
		} catch (error) {
			console.error('[Contacts] Failed to load trusted contacts:', error)
		}

		try {
			// Load discovered contacts from network (not yet trusted)
			const networkScan = await invoke('network_scan_datasites')
			if (networkScan?.discovered) {
				for (const d of networkScan.discovered) {
					if (d.identity && (!currentEmail || d.identity !== currentEmail)) {
						// Only add if not already in contacts
						if (!contactSet.has(d.identity)) {
							contactSet.set(d.identity, { email: d.identity, isTrusted: false })
						}
					}
				}
			}
		} catch (error) {
			console.error('[Contacts] Failed to scan network contacts:', error)
		}

		// Sort: trusted first, then alphabetically
		const sorted = Array.from(contactSet.values()).sort((a, b) => {
			if (a.isTrusted !== b.isTrusted) return a.isTrusted ? -1 : 1
			return a.email.toLowerCase().localeCompare(b.email.toLowerCase())
		})

		cachedContacts = sorted
		cachedForEmail = currentEmail

		return cachedContacts
	}

	function renderDatalist(contacts) {
		const datalist = ensureDatalist()
		// Show trusted contacts first, then network contacts with indicator
		datalist.innerHTML = contacts
			.map((c) => {
				const label = c.isTrusted ? c.email : `${c.email}`
				return `<option value="${escapeHtml(c.email)}" label="${escapeHtml(label)}"></option>`
			})
			.join('')
		return datalist
	}

	async function attachToInputs(inputIds = []) {
		const contacts = await loadContactEmails()
		const datalist = renderDatalist(contacts)

		inputIds.forEach((id) => {
			const input = document.getElementById(id)
			if (input) {
				input.setAttribute('list', datalist.id)
			}
		})

		return contacts.map((c) => c.email)
	}

	async function refresh() {
		cachedContacts = null
		cachedForEmail = null
		return attachToInputs([])
	}

	function getEmails() {
		return (cachedContacts || []).map((c) => c.email)
	}

	function getContacts() {
		return cachedContacts || []
	}

	return {
		attachToInputs,
		refresh,
		getEmails,
		getContacts,
	}
}
