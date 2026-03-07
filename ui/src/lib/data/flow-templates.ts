// Built-in flow templates from the biovault repo

export interface FlowTemplate {
	id: string
	name: string
	description: string
	icon: 'dna' | 'user' | 'scan-eye'
	color: 'blue' | 'purple' | 'green' | 'red'
	sourceUrl: string
	localTemplateKey?: string
	dependencies?: string[]
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
		localTemplateKey: 'apol1',
		dependencies: ['apol1-classifier'],
	},
	{
		id: 'allele-freq',
		name: 'Allele Frequency',
		description: 'Allele frequency analysis',
		icon: 'dna',
		color: 'blue',
		sourceUrl: 'https://github.com/OpenMined/biovault/blob/main/flows/allele-freq/flow.yaml',
	},
	{
		id: 'brca',
		name: 'BRCA Classifier',
		description: 'Cancer risk assessment',
		icon: 'user',
		color: 'purple',
		sourceUrl: 'https://github.com/OpenMined/bioscript/blob/main/examples/brca/brca-classifier/flow.yaml',
		localTemplateKey: 'brca',
		dependencies: ['brca-classifier'],
	},
	{
		id: 'clinvar-vcf',
		name: 'ClinVar VCF',
		description: 'Clinical variant classification',
		icon: 'dna',
		color: 'purple',
		sourceUrl: 'https://github.com/OpenMined/biovault/blob/main/flows/clinvar-vcf/flow.yaml',
	},
	{
		id: 'herc2',
		name: 'HERC2 Classifier',
		description: 'Pigmentation analysis',
		icon: 'scan-eye',
		color: 'green',
		sourceUrl:
			'https://github.com/OpenMined/bioscript/blob/main/examples/herc2/herc2-classifier/flow.yaml',
		localTemplateKey: 'herc2',
		dependencies: ['herc2-classifier'],
	},
	{
		id: 'eye-color',
		name: 'Eye Color',
		description: 'Pigmentation analysis',
		icon: 'scan-eye',
		color: 'green',
		sourceUrl: 'https://github.com/OpenMined/biovault/blob/main/flows/eye-color/flow.yaml',
	},
	{
		id: 'gra-mpileup',
		name: 'GRA Mpileup',
		description: 'Genomic read alignment pileup',
		icon: 'dna',
		color: 'blue',
		sourceUrl: 'https://github.com/OpenMined/biovault/blob/main/flows/gra-mpileup/flow.yaml',
	},
	{
		id: 'haplo-y',
		name: 'Haplo Y',
		description: 'Y-chromosome haplogroup analysis',
		icon: 'user',
		color: 'purple',
		sourceUrl: 'https://github.com/OpenMined/biovault/blob/main/flows/haplo-y/flow.yaml',
	},
	{
		id: 'multiparty-allele-freq',
		name: 'Multiparty Allele Freq',
		description: 'Collaborative allele frequency computation',
		icon: 'dna',
		color: 'green',
		sourceUrl:
			'https://github.com/OpenMined/biovault/blob/main/flows/multiparty-allele-freq/flow.yaml',
	},
	{
		id: 'multiparty',
		name: 'Multiparty Demo',
		description: '3-party collaborative flow',
		icon: 'user',
		color: 'blue',
		sourceUrl: 'https://github.com/OpenMined/biovault/blob/main/flows/multiparty/flow.yaml',
	},
	{
		id: 'red-hair',
		name: 'Red Hair',
		description: 'Hair pigmentation variants',
		icon: 'scan-eye',
		color: 'red',
		sourceUrl: 'https://github.com/OpenMined/biovault/blob/main/flows/red-hair/flow.yaml',
	},
	{
		id: 'syqure-allele-agg-smpc',
		name: 'SyQure Allele Agg SMPC',
		description: 'Secure multiparty allele aggregation',
		icon: 'dna',
		color: 'purple',
		sourceUrl:
			'https://github.com/OpenMined/biovault/blob/main/flows/syqure-allele-agg-smpc/flow.yaml',
	},
	{
		id: 'syqure-allele-agg',
		name: 'SyQure Allele Agg',
		description: 'SyQure allele aggregation',
		icon: 'dna',
		color: 'blue',
		sourceUrl: 'https://github.com/OpenMined/biovault/blob/main/flows/syqure-allele-agg/flow.yaml',
	},
	{
		id: 'syqure-demo',
		name: 'SyQure Demo',
		description: 'MPC rsid aggregation demo',
		icon: 'user',
		color: 'green',
		sourceUrl: 'https://github.com/OpenMined/biovault/blob/main/flows/syqure-demo/flow.yaml',
	},
	{
		id: 'syqure-smoke-test',
		name: 'SyQure Smoke Test',
		description: 'SyQure smoke test flow',
		icon: 'dna',
		color: 'red',
		sourceUrl: 'https://github.com/OpenMined/biovault/blob/main/flows/syqure-smoke-test/flow.yaml',
	},
	{
		id: 'thalassemia',
		name: 'Thalassemia Classifier',
		description: 'Blood disorder variants',
		icon: 'dna',
		color: 'red',
		sourceUrl:
			'https://github.com/OpenMined/bioscript/blob/main/examples/thalassemia/thalassemia-classifier/flow.yaml',
		localTemplateKey: 'thalassemia',
		dependencies: ['thalassemia-classifier'],
	},
	{
		id: 'trusted-allele-agg',
		name: 'Trusted Allele Agg',
		description: 'Trusted allele aggregation',
		icon: 'dna',
		color: 'purple',
		sourceUrl: 'https://github.com/OpenMined/biovault/blob/main/flows/trusted-allele-agg/flow.yaml',
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
