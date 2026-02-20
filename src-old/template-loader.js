export class TemplateLoader {
	constructor() {
		this.cache = new Map()
		this.templatePath = 'templates/'
	}

	async load(templateName) {
		if (this.cache.has(templateName)) {
			return this.cache.get(templateName)
		}

		try {
			const response = await fetch(`${this.templatePath}${templateName}.html`)
			if (!response.ok) {
				throw new Error(`Failed to load template: ${templateName}`)
			}
			const html = await response.text()
			this.cache.set(templateName, html)
			return html
		} catch (error) {
			console.error(`Error loading template ${templateName}:`, error)
			throw error
		}
	}

	async loadAndInject(templateName, targetElementId) {
		const html = await this.load(templateName)
		const target = document.getElementById(targetElementId)
		if (target) {
			target.innerHTML = html
		} else {
			console.error(`Target element ${targetElementId} not found`)
		}
		return html
	}

	clearCache() {
		this.cache.clear()
	}
}

export const templateLoader = new TemplateLoader()
