export function createContactAutocomplete({ invoke, getCurrentUserEmail }) {
	let cachedEmails = null
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
		if (cachedEmails && cachedForEmail === currentEmail) return cachedEmails

		try {
			const contacts = await invoke('key_list_contacts', { currentEmail })
			const emails = contacts
				.map((c) => c.identity)
				.filter(Boolean)
				.filter((email) => !currentEmail || email !== currentEmail)
				.filter((value, index, self) => self.indexOf(value) === index)

			cachedEmails = emails
			cachedForEmail = currentEmail
		} catch (error) {
			console.error('[Contacts] Failed to load contact emails for autocomplete:', error)
			cachedEmails = []
			cachedForEmail = currentEmail
		}

		return cachedEmails
	}

	function renderDatalist(emails) {
		const datalist = ensureDatalist()
		datalist.innerHTML = emails
			.map((email) => `<option value="${escapeHtml(email)}"></option>`)
			.join('')
		return datalist
	}

	async function attachToInputs(inputIds = []) {
		const emails = await loadContactEmails()
		const datalist = renderDatalist(emails)

		inputIds.forEach((id) => {
			const input = document.getElementById(id)
			if (input) {
				input.setAttribute('list', datalist.id)
			}
		})

		return emails
	}

	async function refresh() {
		cachedEmails = null
		cachedForEmail = null
		return attachToInputs([])
	}

	function getEmails() {
		return cachedEmails || []
	}

	return {
		attachToInputs,
		refresh,
		getEmails,
	}
}
