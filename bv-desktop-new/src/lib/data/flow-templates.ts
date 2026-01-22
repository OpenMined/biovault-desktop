// Built-in flow templates for genetic analysis pipelines

export interface FlowTemplate {
	id: string
	name: string
	description: string
	icon: 'dna' | 'user' | 'scan-eye'
	color: 'blue' | 'purple' | 'green' | 'red'
	sourceUrl: string
}

export const flowTemplates: FlowTemplate[] = [
	{
		id: 'apol1',
		name: 'APOL1 Classifier',
		description: 'Genetic variant analysis',
		icon: 'dna',
		color: 'blue',
		sourceUrl:
			'https://github.com/OpenMined/bioscript/blob/main/examples/apol1/apol1-classifier/flow.yaml',
	},
	{
		id: 'brca',
		name: 'BRCA Classifier',
		description: 'Cancer risk assessment',
		icon: 'user',
		color: 'purple',
		sourceUrl:
			'https://github.com/OpenMined/bioscript/blob/main/examples/brca/brca-classifier/flow.yaml',
	},
	{
		id: 'herc2',
		name: 'HERC2 Classifier',
		description: 'Pigmentation analysis',
		icon: 'scan-eye',
		color: 'green',
		sourceUrl:
			'https://github.com/OpenMined/bioscript/blob/main/examples/herc2/herc2-classifier/flow.yaml',
	},
	{
		id: 'thalassemia',
		name: 'Thalassemia Classifier',
		description: 'Blood disorder variants',
		icon: 'dna',
		color: 'red',
		sourceUrl:
			'https://github.com/OpenMined/bioscript/blob/main/examples/thalassemia/thalassemia-classifier/flow.yaml',
	},
]

// Color mappings for template cards
export const templateColors: Record<FlowTemplate['color'], { gradient: string; bg: string }> = {
	blue: {
		gradient: 'from-blue-500 to-blue-600',
		bg: 'bg-blue-500',
	},
	purple: {
		gradient: 'from-violet-500 to-violet-600',
		bg: 'bg-violet-500',
	},
	green: {
		gradient: 'from-emerald-500 to-emerald-600',
		bg: 'bg-emerald-500',
	},
	red: {
		gradient: 'from-red-500 to-red-600',
		bg: 'bg-red-500',
	},
}
