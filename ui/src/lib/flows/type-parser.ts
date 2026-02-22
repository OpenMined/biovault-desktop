export type FlowTypeNode =
	| { kind: 'named'; name: string }
	| { kind: 'list'; item: FlowTypeNode }
	| { kind: 'map'; key: FlowTypeNode; value: FlowTypeNode }
	| { kind: 'record'; fields: Array<{ name: string; type: FlowTypeNode }> }
	| { kind: 'optional'; inner: FlowTypeNode }

export interface FlowTypeParseResult {
	node?: FlowTypeNode
	error?: string
}

const PRIMITIVE_LABELS: Record<string, string> = {
	String: 'Text',
	Bool: 'Boolean',
	File: 'File',
	Directory: 'Directory',
	Integer: 'Integer',
	Int: 'Integer',
	Float: 'Float',
	Number: 'Number',
}

class Parser {
	private pos = 0

	constructor(private readonly input: string) {}

	parse(): FlowTypeNode {
		const node = this.parseType()
		this.skipWs()
		if (!this.eof()) {
			throw new Error(`Unexpected token at position ${this.pos + 1}`)
		}
		return node
	}

	private parseType(): FlowTypeNode {
		this.skipWs()
		let node = this.parsePrimary()
		this.skipWs()
		if (this.peek() === '?') {
			this.pos += 1
			node = { kind: 'optional', inner: node }
		}
		return node
	}

	private parsePrimary(): FlowTypeNode {
		if (this.consumeWord('List')) {
			this.expect('[')
			const item = this.parseType()
			this.expect(']')
			return { kind: 'list', item }
		}
		if (this.consumeWord('Map')) {
			this.expect('[')
			const key = this.parseType()
			this.expect(',')
			const value = this.parseType()
			this.expect(']')
			return { kind: 'map', key, value }
		}
		if (this.consumeWord('Record')) {
			this.expect('{')
			const fields: Array<{ name: string; type: FlowTypeNode }> = []
			this.skipWs()
			while (this.peek() !== '}') {
				const name = this.parseIdentifier()
				this.expect(':')
				const type = this.parseType()
				fields.push({ name, type })
				this.skipWs()
				if (this.peek() === ',') {
					this.pos += 1
					this.skipWs()
				} else {
					break
				}
			}
			this.expect('}')
			return { kind: 'record', fields }
		}
		const name = this.parseIdentifier()
		return { kind: 'named', name }
	}

	private parseIdentifier(): string {
		this.skipWs()
		const start = this.pos
		while (!this.eof()) {
			const c = this.peek()
			if (!c || !/[A-Za-z0-9_.-]/.test(c)) {
				break
			}
			this.pos += 1
		}
		if (this.pos === start) {
			throw new Error(`Expected type identifier at position ${this.pos + 1}`)
		}
		return this.input.slice(start, this.pos)
	}

	private consumeWord(word: string): boolean {
		this.skipWs()
		if (!this.input.slice(this.pos).startsWith(word)) return false
		const next = this.input[this.pos + word.length]
		if (next && /[A-Za-z0-9_]/.test(next)) return false
		this.pos += word.length
		return true
	}

	private expect(ch: string) {
		this.skipWs()
		if (this.peek() !== ch) {
			throw new Error(`Expected '${ch}' at position ${this.pos + 1}`)
		}
		this.pos += 1
	}

	private skipWs() {
		while (!this.eof() && /\s/.test(this.peek() ?? '')) this.pos += 1
	}

	private peek(): string | undefined {
		return this.input[this.pos]
	}

	private eof() {
		return this.pos >= this.input.length
	}
}

export function parseFlowType(raw: string): FlowTypeParseResult {
	const trimmed = raw.trim()
	if (!trimmed) return { error: 'Type is empty' }
	try {
		return { node: new Parser(trimmed).parse() }
	} catch (e) {
		return { error: e instanceof Error ? e.message : String(e) }
	}
}

export function serializeFlowType(node: FlowTypeNode): string {
	switch (node.kind) {
		case 'named':
			return node.name
		case 'list':
			return `List[${serializeFlowType(node.item)}]`
		case 'map':
			return `Map[${serializeFlowType(node.key)}, ${serializeFlowType(node.value)}]`
		case 'record':
			return `Record{${node.fields
				.map((field) => `${field.name}: ${serializeFlowType(field.type)}`)
				.join(', ')}}`
		case 'optional':
			return `${serializeFlowType(node.inner)}?`
	}
}

export function friendlyFlowType(node: FlowTypeNode): string {
	switch (node.kind) {
		case 'named':
			return PRIMITIVE_LABELS[node.name] ?? node.name
		case 'list':
			return `List of ${friendlyFlowType(node.item)}`
		case 'map':
			return `Map from ${friendlyFlowType(node.key)} to ${friendlyFlowType(node.value)}`
		case 'record':
			return `${node.fields.length}-field record`
		case 'optional':
			return `Optional ${friendlyFlowType(node.inner)}`
	}
}

export function unwrapOptional(node: FlowTypeNode): { node: FlowTypeNode; optional: boolean } {
	if (node.kind === 'optional') {
		return { node: node.inner, optional: true }
	}
	return { node, optional: false }
}
