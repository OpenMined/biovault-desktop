export function createProgressUI() {
	const progressTasks = new Map()

	function ensureProgressContainer() {
		let container = document.getElementById('operation-progress')
		if (!container) {
			container = document.createElement('div')
			container.id = 'operation-progress'
			container.className = 'operation-progress'
			document.body.appendChild(container)
		}
		return container
	}

	function showProgressTask(id, label, options = {}) {
		const { state = 'active' } = options
		const container = ensureProgressContainer()
		let task = progressTasks.get(id)

		if (!task) {
			const entry = document.createElement('div')
			entry.className = 'operation-progress-entry'
			entry.dataset.taskId = id

			const labelEl = document.createElement('div')
			labelEl.className = 'operation-progress-label'
			entry.appendChild(labelEl)

			const track = document.createElement('div')
			track.className = 'operation-progress-track'
			const bar = document.createElement('div')
			bar.className = 'operation-progress-bar'
			track.appendChild(bar)
			entry.appendChild(track)

			container.appendChild(entry)
			progressTasks.set(id, { entry, labelEl, bar })
			task = progressTasks.get(id)
		}

		task.entry.classList.remove('success', 'error', 'waiting')
		if (state === 'waiting') {
			task.entry.classList.add('waiting')
		}

		task.labelEl.textContent = label
		task.bar.style.animation = 'progress-indeterminate 1.2s ease-in-out infinite'
		task.bar.style.width = state === 'waiting' ? '30%' : '40%'
		task.bar.style.background = ''

		container.setAttribute('data-visible', 'true')
	}

	function finishProgressTask(id, { status = 'success', message } = {}) {
		const task = progressTasks.get(id)
		if (!task) return

		const { entry, labelEl, bar } = task
		entry.classList.remove('waiting')

		if (status === 'success') {
			entry.classList.add('success')
			labelEl.textContent = message || `${labelEl.textContent} complete`
			bar.style.background = ''
		} else if (status === 'error') {
			entry.classList.add('error')
			labelEl.textContent = message || `${labelEl.textContent} failed`
			bar.style.background = ''
		}

		bar.style.animation = 'none'
		bar.style.width = '100%'

		const container = ensureProgressContainer()
		setTimeout(
			() => {
				if (entry.parentElement === container) {
					container.removeChild(entry)
				}
				progressTasks.delete(id)
				if (!container.children.length) {
					container.removeAttribute('data-visible')
				}
			},
			status === 'error' ? 4500 : 2000,
		)
	}

	function setButtonLoading(button, label) {
		if (button.classList.contains('btn-loading')) {
			updateButtonLoadingLabel(button, label)
			return
		}

		if (!button.dataset.originalContent) {
			button.dataset.originalContent = button.innerHTML
		}

		button.disabled = true
		button.classList.add('btn-loading')
		button.innerHTML = ''

		const spinner = document.createElement('span')
		spinner.className = 'button-spinner'
		const text = document.createElement('span')
		text.className = 'button-spinner-label'
		text.textContent = label

		button.append(spinner, text)
	}

	function updateButtonLoadingLabel(button, label) {
		const labelEl = button.querySelector('.button-spinner-label')
		if (labelEl) {
			labelEl.textContent = label
		} else if (button.disabled) {
			button.textContent = label
		}
	}

	function clearButtonLoading(button) {
		if (button.dataset.originalContent) {
			button.innerHTML = button.dataset.originalContent
			delete button.dataset.originalContent
		} else {
			button.textContent = button.textContent || 'Install'
		}
		button.disabled = false
		button.classList.remove('btn-loading')
	}

	return {
		showProgressTask,
		finishProgressTask,
		setButtonLoading,
		updateButtonLoadingLabel,
		clearButtonLoading,
	}
}
