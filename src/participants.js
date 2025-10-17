export function createParticipantsModule({ invoke }) {
	if (!invoke) {
		throw new Error('initParticipantsModule requires invoke')
	}

	let allParticipants = []
	let participantsSearchTerm = ''
	let selectedParticipantsForDelete = []

	function setSearchTerm(term) {
		participantsSearchTerm = (term || '').trim().toLowerCase()
		renderParticipantsTable()
	}

	function getParticipants() {
		return allParticipants.slice()
	}

	function getSelectedParticipants() {
		return selectedParticipantsForDelete.slice()
	}

	function participantMatchesSearch(participant) {
		if (!participantsSearchTerm) return true
		const term = participantsSearchTerm
		const values = [participant.id, participant.participant_id, participant.created_at]
		return values.some((value) => {
			if (value === null || value === undefined) return false
			return value.toString().toLowerCase().includes(term)
		})
	}

	function updateDeleteParticipantsButton() {
		const btn = document.getElementById('delete-selected-participants-btn')
		if (!btn) return
		if (selectedParticipantsForDelete.length > 0) {
			btn.style.display = 'block'
			btn.textContent = `Delete Selected (${selectedParticipantsForDelete.length})`
		} else {
			btn.style.display = 'none'
		}
	}

	function renderParticipantsTable() {
		const tbody = document.getElementById('participants-table')
		if (!tbody) return

		tbody.innerHTML = ''

		selectedParticipantsForDelete = selectedParticipantsForDelete.filter((id) =>
			allParticipants.some((p) => p.id === id),
		)

		const filtered = allParticipants.filter(participantMatchesSearch)

		filtered.forEach((p) => {
			const row = document.createElement('tr')
			const isSelected = selectedParticipantsForDelete.includes(p.id)
			row.innerHTML = `
				<td><input type="checkbox" class="participant-checkbox" data-id="${p.id}" ${
					isSelected ? 'checked' : ''
				} /></td>
				<td>${p.id}</td>
				<td>${p.participant_id}</td>
				<td>${p.created_at}</td>
			`
			tbody.appendChild(row)
		})

		document.querySelectorAll('#participants-table .participant-checkbox').forEach((checkbox) => {
			checkbox.addEventListener('change', (e) => {
				const id = parseInt(e.target.dataset.id)
				if (e.target.checked) {
					if (!selectedParticipantsForDelete.includes(id)) {
						selectedParticipantsForDelete.push(id)
					}
				} else {
					selectedParticipantsForDelete = selectedParticipantsForDelete.filter((x) => x !== id)
				}
				updateDeleteParticipantsButton()
			})
		})

		const countLabel = document.getElementById('participant-count')
		if (countLabel) {
			countLabel.textContent = allParticipants.length
		}

		const selectAllHeader = document.getElementById('select-all-participants-table')
		if (selectAllHeader) {
			const filteredCount = filtered.length
			const selectedCount = filtered.filter((p) =>
				selectedParticipantsForDelete.includes(p.id),
			).length
			selectAllHeader.checked = filteredCount > 0 && selectedCount === filteredCount
			selectAllHeader.indeterminate = selectedCount > 0 && selectedCount < filteredCount
		}

		updateDeleteParticipantsButton()
	}

	async function loadParticipants() {
		try {
			const participants = await invoke('get_participants')
			allParticipants = participants
			selectedParticipantsForDelete = []
			renderParticipantsTable()
		} catch (error) {
			console.error('Error loading participants:', error)
		}
	}

	function clearSelection() {
		selectedParticipantsForDelete = []
		updateDeleteParticipantsButton()
		renderParticipantsTable()
	}

	function handleSelectAll(checked) {
		const currentIds = allParticipants.filter(participantMatchesSearch).map((p) => p.id)
		if (checked) {
			selectedParticipantsForDelete = Array.from(
				new Set([...selectedParticipantsForDelete, ...currentIds]),
			)
		} else {
			selectedParticipantsForDelete = selectedParticipantsForDelete.filter(
				(id) => !currentIds.includes(id),
			)
		}
		renderParticipantsTable()
	}

	return {
		loadParticipants,
		renderParticipantsTable,
		setSearchTerm,
		getParticipants,
		getSelectedParticipants,
		clearSelection,
		handleSelectAll,
	}
}
