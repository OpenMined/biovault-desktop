/**
 * Basic tests for the BioVault Agent Client (Node.js/TypeScript)
 *
 * These tests require a running BioVault Desktop instance with the
 * WebSocket bridge enabled.
 *
 * Run with:
 *   npx ts-node test-agent.ts
 */

import { BioVaultAgent, BioVaultAgentError } from './biovault-agent'

interface TestResult {
	name: string
	passed: boolean
	error?: string
	output?: string
}

const results: TestResult[] = []

async function runTest(
	name: string,
	testFn: (agent: BioVaultAgent) => Promise<void>,
): Promise<void> {
	console.log(`\nTest: ${name}`)
	const agent = new BioVaultAgent()

	try {
		await agent.connect()
		await testFn(agent)
		results.push({ name, passed: true })
		console.log('  Result: PASSED')
	} catch (err) {
		const error = err instanceof Error ? err.message : String(err)
		results.push({ name, passed: false, error })
		console.log(`  Result: FAILED - ${error}`)
	} finally {
		await agent.disconnect()
	}
}

// -------------------------------------------------------------------------
// Tests
// -------------------------------------------------------------------------

async function testConnection(agent: BioVaultAgent): Promise<void> {
	if (!agent.connected) {
		throw new Error('Not connected')
	}
	console.log('  Connection: OK')
}

async function testDiscover(agent: BioVaultAgent): Promise<void> {
	const result = await agent.discover()
	if (!result.version) throw new Error('Missing version')
	if (!result.name) throw new Error('Missing name')
	if (result.name !== 'BioVault Desktop Agent API') {
		throw new Error(`Unexpected name: ${result.name}`)
	}
	console.log(`  API Version: ${result.version}`)
}

async function testListCommands(agent: BioVaultAgent): Promise<void> {
	const result = await agent.listCommands()
	if (!result.version) throw new Error('Missing version')
	if (!Array.isArray(result.commands)) throw new Error('Missing commands array')
	if (result.commands.length < 50) {
		throw new Error(`Expected 50+ commands, got ${result.commands.length}`)
	}
	console.log(`  Commands: ${result.commands.length}`)
}

async function testGetAppVersion(agent: BioVaultAgent): Promise<void> {
	const version = await agent.getAppVersion()
	if (typeof version !== 'string') throw new Error('Version not a string')
	if (version.length === 0) throw new Error('Version is empty')
	console.log(`  App Version: ${version}`)
}

async function testIsDevMode(agent: BioVaultAgent): Promise<void> {
	const isDevMode = await agent.isDevMode()
	if (typeof isDevMode !== 'boolean') throw new Error('Not a boolean')
	console.log(`  Dev Mode: ${isDevMode}`)
}

async function testCheckIsOnboarded(agent: BioVaultAgent): Promise<void> {
	const isOnboarded = await agent.checkIsOnboarded()
	if (typeof isOnboarded !== 'boolean') throw new Error('Not a boolean')
	console.log(`  Onboarded: ${isOnboarded}`)
}

async function testGetSyftboxState(agent: BioVaultAgent): Promise<void> {
	const state = await agent.getSyftboxState()
	if (typeof state !== 'object') throw new Error('Not an object')
	if (!('running' in state)) throw new Error('Missing running field')
	console.log(`  SyftBox Running: ${state.running}`)
}

async function testCheckDependencies(agent: BioVaultAgent): Promise<void> {
	const deps = await agent.checkDependencies()
	if (!Array.isArray(deps)) throw new Error('Not an array')
	console.log(`  Dependencies: ${deps.length} found`)
	for (const dep of deps.slice(0, 3)) {
		const d = dep as { name: string; installed: boolean }
		const status = d.installed ? 'installed' : 'missing'
		console.log(`    - ${d.name}: ${status}`)
	}
}

async function testGetProjects(agent: BioVaultAgent): Promise<void> {
	const projects = await agent.getProjects()
	if (!Array.isArray(projects)) throw new Error('Not an array')
	console.log(`  Projects: ${projects.length} found`)
}

async function testSqlListTables(agent: BioVaultAgent): Promise<void> {
	const tables = await agent.sqlListTables()
	if (!Array.isArray(tables)) throw new Error('Not an array')
	console.log(`  Database Tables: ${tables.length}`)
	for (const table of tables.slice(0, 5)) {
		console.log(`    - ${table}`)
	}
}

async function testAuditLog(agent: BioVaultAgent): Promise<void> {
	const log = await agent.getAuditLog(5)
	if (!Array.isArray(log)) throw new Error('Not an array')
	console.log(`  Audit Log Entries: ${log.length}`)

	if (log.length > 0) {
		const entry = log[log.length - 1] as { timestamp?: string; cmd?: string }
		if (!entry.timestamp) throw new Error('Missing timestamp')
		if (!entry.cmd) throw new Error('Missing cmd')
	}
}

async function testInvalidCommand(agent: BioVaultAgent): Promise<void> {
	try {
		await agent.invoke('this_command_does_not_exist')
		throw new Error('Should have raised an error')
	} catch (err) {
		if (err instanceof BioVaultAgentError) {
			if (!err.message.includes('Unhandled command')) {
				throw new Error(`Unexpected error message: ${err.message}`)
			}
			console.log('  Invalid command handling: OK')
		} else {
			throw err
		}
	}
}

async function testAuthWithWrongToken(): Promise<void> {
	// Only run if token auth is configured
	if (!process.env.AGENT_BRIDGE_TOKEN) {
		console.log('  Skipping (no token configured)')
		return
	}

	const agent = new BioVaultAgent({ token: 'wrong-token' })
	try {
		await agent.connect()
		await agent.getAppVersion()
		throw new Error('Should have been rejected')
	} catch (err) {
		if (err instanceof BioVaultAgentError) {
			if (!err.message.includes('Authentication failed')) {
				throw new Error(`Unexpected error: ${err.message}`)
			}
			console.log('  Auth rejection: OK')
		} else {
			throw err
		}
	} finally {
		await agent.disconnect()
	}
}

// -------------------------------------------------------------------------
// Main
// -------------------------------------------------------------------------

async function runAllTests(): Promise<boolean> {
	console.log('\nBioVault Agent Client Tests (Node.js)')
	console.log('='.repeat(50))

	await runTest('Connection', testConnection)
	await runTest('API Discovery', testDiscover)
	await runTest('List Commands', testListCommands)
	await runTest('Get App Version', testGetAppVersion)
	await runTest('Dev Mode Check', testIsDevMode)
	await runTest('Onboarding Status', testCheckIsOnboarded)
	await runTest('SyftBox State', testGetSyftboxState)
	await runTest('Dependencies', testCheckDependencies)
	await runTest('Projects', testGetProjects)
	await runTest('SQL Tables', testSqlListTables)
	await runTest('Audit Log', testAuditLog)
	await runTest('Invalid Command', testInvalidCommand)

	// Special test that creates its own agent
	console.log('\nTest: Auth Rejection')
	try {
		await testAuthWithWrongToken()
		results.push({ name: 'Auth Rejection', passed: true })
		console.log('  Result: PASSED')
	} catch (err) {
		const error = err instanceof Error ? err.message : String(err)
		results.push({ name: 'Auth Rejection', passed: false, error })
		console.log(`  Result: FAILED - ${error}`)
	}

	// Summary
	const passed = results.filter((r) => r.passed).length
	const failed = results.filter((r) => !r.passed).length

	console.log('\n' + '='.repeat(50))
	console.log(`Results: ${passed} passed, ${failed} failed`)
	console.log('='.repeat(50))

	return failed === 0
}

// Run tests
runAllTests()
	.then((success) => process.exit(success ? 0 : 1))
	.catch((err) => {
		console.error('Test runner error:', err)
		process.exit(1)
	})
