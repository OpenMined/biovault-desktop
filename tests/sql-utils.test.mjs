import test from 'node:test'
import assert from 'node:assert/strict'

import { __private__ as sqlUtils } from '../src/sql.js'

const { formatSql, highlightSql, extractSqlFromAi } = sqlUtils

test('formatSql uppercases keywords and preserves semicolon', () => {
	const formatted = formatSql("select id, name from participants where name like 'a%';")
	assert.equal(
		formatted,
		"SELECT id, name\nFROM participants\nWHERE name LIKE 'a%';",
	)
})

test('extractSqlFromAi handles code fences and plain text', () => {
	const fenced = extractSqlFromAi('```sql\nSELECT * FROM demo;\n```')
	assert.equal(fenced, 'SELECT * FROM demo;')

	const plain = extractSqlFromAi('SELECT 1')
	assert.equal(plain, 'SELECT 1')
})

test('highlightSql wraps keywords and strings', () => {
	const html = highlightSql("select 'Hi' as greeting")
	assert.match(html, /<span class="sql-token-keyword">SELECT<\/span>/)
	assert.match(html, /<span class="sql-token-string">&#39;Hi&#39;<\/span>/)
})

