// Built-in flow templates from the biovault repo

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
		id: 'allele-freq',
		name: 'Allele Frequency',
		description: 'Allele frequency analysis',
		icon: 'dna',
		color: 'blue',
		sourceUrl:
			'https://github.com/OpenMined/biovault/blob/main/flows/allele-freq/flow.yaml',
	},
	{
		id: 'clinvar-vcf',
		name: 'ClinVar VCF',
		description: 'Clinical variant classification',
		icon: 'dna',
		color: 'purple',
		sourceUrl:
			'https://github.com/OpenMined/biovault/blob/main/flows/clinvar-vcf/flow.yaml',
	},
	{
		id: 'eye-color',
		name: 'Eye Color',
		description: 'Pigmentation analysis',
		icon: 'scan-eye',
		color: 'green',
		sourceUrl:
			'https://github.com/OpenMined/biovault/blob/main/flows/eye-color/flow.yaml',
	},
	{
		id: 'gra-mpileup',
		name: 'GRA Mpileup',
		description: 'Genomic read alignment pileup',
		icon: 'dna',
		color: 'blue',
		sourceUrl:
			'https://github.com/OpenMined/biovault/blob/main/flows/gra-mpileup/flow.yaml',
	},
	{
		id: 'haplo-y',
		name: 'Haplo Y',
		description: 'Y-chromosome haplogroup analysis',
		icon: 'user',
		color: 'purple',
		sourceUrl:
			'https://github.com/OpenMined/biovault/blob/main/flows/haplo-y/flow.yaml',
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
		name: 'Multiparty',
		description: 'Multiparty computation demo',
		icon: 'user',
		color: 'blue',
		sourceUrl:
			'https://github.com/OpenMined/biovault/blob/main/flows/multiparty/flow.yaml',
	},
	{
		id: 'red-hair',
		name: 'Red Hair',
		description: 'Hair pigmentation variants',
		icon: 'scan-eye',
		color: 'red',
		sourceUrl:
			'https://github.com/OpenMined/biovault/blob/main/flows/red-hair/flow.yaml',
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
		sourceUrl:
			'https://github.com/OpenMined/biovault/blob/main/flows/syqure-allele-agg/flow.yaml',
	},
	{
		id: 'syqure-demo',
		name: 'SyQure Demo',
		description: 'SyQure demonstration flow',
		icon: 'user',
		color: 'green',
		sourceUrl:
			'https://github.com/OpenMined/biovault/blob/main/flows/syqure-demo/flow.yaml',
	},
	{
		id: 'syqure-smoke-test',
		name: 'SyQure Smoke Test',
		description: 'SyQure smoke test flow',
		icon: 'dna',
		color: 'red',
		sourceUrl:
			'https://github.com/OpenMined/biovault/blob/main/flows/syqure-smoke-test/flow.yaml',
	},
	{
		id: 'trusted-allele-agg',
		name: 'Trusted Allele Agg',
		description: 'Trusted allele aggregation',
		icon: 'dna',
		color: 'purple',
		sourceUrl:
			'https://github.com/OpenMined/biovault/blob/main/flows/trusted-allele-agg/flow.yaml',
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
