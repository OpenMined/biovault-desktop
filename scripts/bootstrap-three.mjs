#!/usr/bin/env node

import WebSocket from 'ws'
import fs from 'node:fs'
import path from 'node:path'

function parseArgs(argv) {
	const args = new Map()
	for (let i = 2; i < argv.length; i += 1) {
		const token = argv[i]
		if (!token.startsWith('--')) continue
		const key = token.slice(2)
		const next = argv[i + 1]
		if (!next || next.startsWith('--')) {
			args.set(key, '1')
		} else {
			args.set(key, next)
			i += 1
		}
	}
	return args
}

function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms))
}

async function importContactWithRetry(backend, fromLabel, identity, attempts = 40) {
	for (let attempt = 1; attempt <= attempts; attempt += 1) {
		try {
			await backend.invoke('network_import_contact', { identity })
			return
		} catch (err) {
			if (attempt === attempts) throw err
			if (attempt % 5 === 0) {
				console.log(
					`[bootstrap] ${fromLabel}: still waiting for ${identity} DID (${attempt}/${attempts})`,
				)
			}
			await backend.invoke('trigger_syftbox_sync').catch(() => {})
			await sleep(1000)
		}
	}
}

async function connectBackend(port, label, timeoutMs = 120_000) {
	const start = Date.now()
	while (Date.now() - start < timeoutMs) {
		try {
			const socket = new WebSocket(`ws://localhost:${port}`)
			await new Promise((resolve, reject) => {
				const timeout = setTimeout(() => reject(new Error('connect timeout')), 5000)
				socket.once('open', () => {
					clearTimeout(timeout)
					resolve()
				})
				socket.once('error', (err) => {
					clearTimeout(timeout)
					reject(err)
				})
			})
			let nextId = 0
			const pending = new Map()
			socket.on('message', (data) => {
				let parsed
				try {
					parsed = JSON.parse(data.toString())
				} catch {
					return
				}
				const entry = pending.get(parsed?.id)
				if (!entry) return
				pending.delete(parsed.id)
				if (parsed.error) entry.reject(new Error(parsed.error))
				else entry.resolve(parsed.result)
			})

			async function invoke(cmd, args = {}, cmdTimeoutMs = 30_000) {
				const id = ++nextId
				socket.send(JSON.stringify({ id, cmd, args }))
				return await new Promise((resolve, reject) => {
					pending.set(id, { resolve, reject })
					setTimeout(() => {
						if (!pending.has(id)) return
						pending.delete(id)
						reject(new Error(`WS invoke timeout: ${cmd}`))
					}, cmdTimeoutMs)
				})
			}

			async function close() {
				if (socket.readyState !== WebSocket.OPEN) return
				await new Promise((resolve) => {
					socket.once('close', resolve)
					socket.close()
				})
			}

			console.log(`[bootstrap] connected ${label} on ws:${port}`)
			return { invoke, close }
		} catch {
			await sleep(1000)
		}
	}
	throw new Error(`failed to connect ${label} on ws:${port} within ${timeoutMs}ms`)
}

function buildFlowSpec(flowName, client1, client2, aggregator) {
	return {
		apiVersion: 'syftbox.openmined.org/v1alpha1',
		kind: 'Flow',
		metadata: {
			name: flowName,
			version: '0.1.0',
		},
		spec: {
			vars: {
				flow_path: 'syft://{datasite.current}/shared/flows/{flow_name}',
				run_path: '{vars.flow_path}/{run_id}',
				step_path: '{vars.run_path}/{step.number}-{step.id}',
			},
			coordination: {
				url: '{vars.run_path}/_progress',
				share_with: 'all',
			},
			datasites: {
				all: [aggregator, client1, client2],
				groups: {
					aggregator: { include: [aggregator] },
					contributors: { include: [client1, client2] },
				},
			},
			roles: [
				{ id: 'contributor1', description: 'First data contributor' },
				{ id: 'contributor2', description: 'Second data contributor' },
				{ id: 'aggregator', description: 'Aggregates contributions' },
			],
			steps: [
				{
					id: 'generate',
					name: 'Generate Numbers',
					description: 'Generate random numbers locally',
					run: { targets: 'contributors', strategy: 'parallel' },
					share: {
						numbers_shared: {
							source: 'self.outputs.numbers',
							url: '{vars.step_path}/numbers.json',
							permissions: { read: [aggregator] },
						},
					},
				},
				{
					id: 'contributions_ready',
					name: 'Wait for Contributions',
					description: 'Wait for all contributors to share',
					barrier: {
						wait_for: 'generate',
						targets: 'contributors',
						timeout: 300,
					},
				},
				{
					id: 'aggregate',
					name: 'Aggregate Sum',
					description: 'Compute sum of all contributions',
					run: { targets: 'aggregator' },
					depends_on: ['contributions_ready'],
					share: {
						result_shared: {
							source: 'self.outputs.result',
							url: '{vars.step_path}/result.json',
							permissions: { read: [client1, client2, aggregator] },
						},
					},
				},
			],
		},
	}
}

function inferFlowNameFromYamlFile(flowFilePath) {
	const text = fs.readFileSync(flowFilePath, 'utf8')
	const metadataBlock = text.match(/metadata:\s*([\s\S]*?)(?:\n[a-zA-Z_][a-zA-Z0-9_]*:|\n$)/m)
	if (metadataBlock) {
		const m = metadataBlock[1].match(/^\s*name:\s*["']?([A-Za-z0-9._-]+)["']?\s*$/m)
		if (m?.[1]) return m[1]
	}
	const topLevel = text.match(/^\s*name:\s*["']?([A-Za-z0-9._-]+)["']?\s*$/m)
	if (topLevel?.[1]) return topLevel[1]
	return path.basename(flowFilePath).replace(/\.(ya?ml)$/i, '')
}

async function importFlowProject(backends, flowFilePath) {
	await Promise.all(
		backends.map(async ({ backend, email }) => {
			await backend.invoke(
				'import_flow',
				{
					flowFile: flowFilePath,
					overwrite: true,
				},
				120_000,
			)
			console.log(`[bootstrap] imported flow file on ${email}: ${flowFilePath}`)
		}),
	)
}

async function resolveInvitationFlowSpec(backend, flowName) {
	const flows = await backend.invoke('get_flows', {})
	const flow = (flows || []).find((entry) => entry?.name === flowName)
	if (!flow?.spec) {
		throw new Error(`flow "${flowName}" not found after import`)
	}
	return flow.spec
}

async function waitForStepStatus(backend, sessionId, stepId, expectedStatuses, label, timeoutMs = 300_000) {
	const start = Date.now()
	let lastStatus = ''
	while (Date.now() - start < timeoutMs) {
		try {
			const state = await backend.invoke('get_multiparty_flow_state', { sessionId }, 120_000)
			const step = (state?.steps || []).find((s) => s?.id === stepId)
			const status = step?.status ? String(step.status) : ''
			if (status) {
				lastStatus = status
				if (expectedStatuses.includes(status)) return
				if (status === 'Failed') {
					throw new Error(`${label}: step "${stepId}" entered Failed state`)
				}
			}
		} catch (error) {
			if (String(error).includes('Failed state')) throw error
		}
		await backend.invoke('trigger_syftbox_sync').catch(() => {})
		await sleep(1500)
	}
	throw new Error(`${label}: timed out waiting for "${stepId}" [${expectedStatuses}] (last=${lastStatus})`)
}

async function runStepAndWait(backend, sessionId, stepId, label, timeoutMs = 300_000) {
	const start = Date.now()
	const rpcTimeout = 120_000
	while (Date.now() - start < timeoutMs) {
		try {
			await backend.invoke('run_flow_step', { sessionId, stepId }, rpcTimeout)
			console.log(`[auto-run] ${label}: started ${stepId}`)
			break
		} catch (error) {
			const msg = String(error)
			if (/step is not ready to run \(status:\s*(completed|shared|running)\)/i.test(msg)) {
				console.log(`[auto-run] ${label}: ${stepId} already running/done`)
				break
			}
			if (
				/dependency.*not satisfied/i.test(msg) ||
				/not ready to run.*waiting/i.test(msg) ||
				/WS invoke timeout/i.test(msg)
			) {
				await backend.invoke('trigger_syftbox_sync').catch(() => {})
				await sleep(1500)
				continue
			}
			throw error
		}
	}
	await waitForStepStatus(backend, sessionId, stepId, ['Completed', 'Shared'], label, timeoutMs)
	console.log(`[auto-run] ${label}: ${stepId} completed`)
}

async function shareStepAndWait(backend, sessionId, stepId, label, timeoutMs = 300_000) {
	const rpcTimeout = 120_000
	try {
		await backend.invoke('share_step_outputs', { sessionId, stepId }, rpcTimeout)
		console.log(`[auto-run] ${label}: shared ${stepId}`)
	} catch (error) {
		if (!/WS invoke timeout/i.test(String(error))) throw error
		console.log(`[auto-run] ${label}: share timeout (transient), waiting for status...`)
	}
	await waitForStepStatus(backend, sessionId, stepId, ['Shared'], label, timeoutMs)
	console.log(`[auto-run] ${label}: ${stepId} shared`)
}

async function autoRunFlowSteps(backends, sessionId, flowSpec, participants, stopBefore) {
	const { b1, b2, b3, e1, e2, e3 } = backends

	console.log('[auto-run] accepting invitation on all backends...')
	const threadId = null
	await Promise.all([
		b1.invoke('accept_flow_invitation', {
			sessionId, flowName: flowSpec?.metadata?.name || 'flow',
			flowSpec, participants, autoRunAll: false, threadId,
		}, 120_000),
		b2.invoke('accept_flow_invitation', {
			sessionId, flowName: flowSpec?.metadata?.name || 'flow',
			flowSpec, participants, autoRunAll: false, threadId,
		}, 120_000),
		b3.invoke('accept_flow_invitation', {
			sessionId, flowName: flowSpec?.metadata?.name || 'flow',
			flowSpec, participants, autoRunAll: false, threadId,
		}, 120_000),
	])
	console.log('[auto-run] all backends accepted')

	await sleep(2000)
	await b1.invoke('trigger_syftbox_sync').catch(() => {})
	await b2.invoke('trigger_syftbox_sync').catch(() => {})
	await b3.invoke('trigger_syftbox_sync').catch(() => {})

	// Extract step ids from flow spec
	const steps = flowSpec?.spec?.steps || flowSpec?.steps || []
	const stepIds = steps.map((s) => s.id).filter(Boolean)
	console.log(`[auto-run] flow steps: ${stepIds.join(', ')}`)
	if (stopBefore) {
		console.log(`[auto-run] will stop before: ${stopBefore}`)
	}

	for (const stepDef of steps) {
		const sid = stepDef.id
		if (!sid) continue
		if (stopBefore && sid === stopBefore) {
			console.log(`[auto-run] stopping before step: ${sid}`)
			break
		}

		// Skip barrier steps - they auto-resolve
		if (stepDef.barrier) {
			console.log(`[auto-run] skipping barrier: ${sid}`)
			continue
		}

		const targets = stepDef.run?.targets || ''
		const isClients = targets === 'clients' || targets === 'contributors'
		const isAggregator = targets === 'aggregator'
		const isAll = targets === 'all'

		if (isClients) {
			console.log(`[auto-run] running ${sid} on clients...`)
			await Promise.all([
				runStepAndWait(b1, sessionId, sid, e1),
				runStepAndWait(b2, sessionId, sid, e2),
			])
			if (stepDef.share) {
				console.log(`[auto-run] sharing ${sid} from clients...`)
				await Promise.all([
					shareStepAndWait(b1, sessionId, sid, e1),
					shareStepAndWait(b2, sessionId, sid, e2),
				])
				await b3.invoke('trigger_syftbox_sync').catch(() => {})
				await sleep(2000)
			}
		} else if (isAggregator) {
			console.log(`[auto-run] running ${sid} on aggregator...`)
			await runStepAndWait(b3, sessionId, sid, e3)
			if (stepDef.share) {
				console.log(`[auto-run] sharing ${sid} from aggregator...`)
				await shareStepAndWait(b3, sessionId, sid, e3)
				await b1.invoke('trigger_syftbox_sync').catch(() => {})
				await b2.invoke('trigger_syftbox_sync').catch(() => {})
				await sleep(2000)
			}
		} else if (isAll) {
			console.log(`[auto-run] running ${sid} on all...`)
			await Promise.all([
				runStepAndWait(b1, sessionId, sid, e1),
				runStepAndWait(b2, sessionId, sid, e2),
				runStepAndWait(b3, sessionId, sid, e3),
			])
			if (stepDef.share) {
				console.log(`[auto-run] sharing ${sid} from all...`)
				await Promise.all([
					shareStepAndWait(b1, sessionId, sid, e1),
					shareStepAndWait(b2, sessionId, sid, e2),
					shareStepAndWait(b3, sessionId, sid, e3),
				])
			}
		}
	}

	console.log('[auto-run] done')
}

async function ensureOnboarded(backend, email, label) {
	const onboarded = await backend.invoke('check_is_onboarded')
	if (onboarded) {
		console.log(`[bootstrap] ${label}: already onboarded`)
		return
	}
	console.log(`[bootstrap] ${label}: completing onboarding...`)
	await backend.invoke('complete_onboarding', { email }, 180_000)
	for (let attempt = 0; attempt < 30; attempt += 1) {
		const ok = await backend.invoke('check_is_onboarded').catch(() => false)
		if (ok) {
			console.log(`[bootstrap] ${label}: onboarding complete`)
			return
		}
		await sleep(1000)
	}
	throw new Error(`${label}: onboarding did not complete`)
}

async function main() {
	const args = parseArgs(process.argv)
	const ws1 = Number(args.get('ws1') || '3333')
	const ws2 = Number(args.get('ws2') || '3334')
	const ws3 = Number(args.get('ws3') || '3335')
	const email1 = args.get('email1') || 'client1@sandbox.local'
	const email2 = args.get('email2') || 'client2@sandbox.local'
	const email3 = args.get('email3') || 'aggregator@sandbox.local'
	const requestedFlowName = args.get('flow') || 'multiparty'
	const flowFileArg = args.get('flow-file') || ''
	const explicitFlowName = args.get('flow-name') || ''
	const autoRun = args.has('auto-run')
	const stopBefore = args.get('stop-before') || ''
	const flowFilePath = flowFileArg ? path.resolve(process.cwd(), flowFileArg) : ''
	if (flowFilePath && !fs.existsSync(flowFilePath)) {
		throw new Error(`flow file not found: ${flowFilePath}`)
	}

	const backend1 = await connectBackend(ws1, email1)
	const backend2 = await connectBackend(ws2, email2)
	const backend3 = await connectBackend(ws3, email3)
	try {
		await ensureOnboarded(backend1, email1, email1)
		await ensureOnboarded(backend2, email2, email2)
		await ensureOnboarded(backend3, email3, email3)

		await backend1.invoke('trigger_syftbox_sync').catch(() => {})
		await backend2.invoke('trigger_syftbox_sync').catch(() => {})
		await backend3.invoke('trigger_syftbox_sync').catch(() => {})
		await sleep(1500)

		console.log('[bootstrap] importing contacts...')
		await importContactWithRetry(backend1, email1, email2)
		await importContactWithRetry(backend1, email1, email3)
		await importContactWithRetry(backend2, email2, email1)
		await importContactWithRetry(backend2, email2, email3)
		await importContactWithRetry(backend3, email3, email1)
		await importContactWithRetry(backend3, email3, email2)

		let flowName = requestedFlowName
		let flowSpec = null
		if (flowFilePath) {
			flowName = explicitFlowName || inferFlowNameFromYamlFile(flowFilePath)
			console.log(`[bootstrap] importing project flow "${flowName}" from ${flowFilePath}`)
			await importFlowProject(
				[
					{ backend: backend1, email: email1 },
					{ backend: backend2, email: email2 },
					{ backend: backend3, email: email3 },
				],
				flowFilePath,
			)
			flowSpec = await resolveInvitationFlowSpec(backend3, flowName)
		} else {
			flowSpec = buildFlowSpec(flowName, email1, email2, email3)
			console.log(`[bootstrap] importing flow "${flowName}" on aggregator...`)
			await backend3.invoke(
				'import_flow_from_json',
				{
					request: {
						name: flowName,
						flow_json: flowSpec,
						overwrite: true,
					},
				},
				60_000,
			)
		}

		const sessionId = `session-${Date.now()}`
		// Order must match flow.yaml inputs.datasites.default: [aggregator, client1, client2]
		// so that {datasites[0]} = aggregator, {datasites[1]} = client1, etc.
		const participants = [
			{ email: email3, role: 'aggregator' },
			{ email: email1, role: 'contributor1' },
			{ email: email2, role: 'contributor2' },
		]
		console.log('[bootstrap] creating group thread + flow invitation...')
		const invitation = await backend3.invoke(
			'send_message',
			{
				request: {
					recipients: [email1, email2],
					body: `Join me in a multiparty flow! Flow: ${flowName} - ${Date.now()}`,
					subject: `Multiparty Flow: ${flowName}`,
					metadata: {
						flow_invitation: {
							flow_name: flowName,
							session_id: sessionId,
							participants,
							flow_spec: flowSpec,
						},
					},
				},
			},
			60_000,
		)

		await backend1.invoke('sync_messages_with_failures').catch(() => {})
		await backend2.invoke('sync_messages_with_failures').catch(() => {})
		await backend3.invoke('sync_messages_with_failures').catch(() => {})

		console.log(
			`[bootstrap] done: thread=${invitation?.thread_id || 'unknown'} session=${sessionId}`,
		)

		if (autoRun) {
			await autoRunFlowSteps(
				{ b1: backend1, b2: backend2, b3: backend3, e1: email1, e2: email2, e3: email3 },
				sessionId,
				flowSpec,
				participants,
				stopBefore || null,
			)
		}
	} finally {
		await backend1.close().catch(() => {})
		await backend2.close().catch(() => {})
		await backend3.close().catch(() => {})
	}
}

main().catch((err) => {
	console.error(`[bootstrap] failed: ${err?.message || String(err)}`)
	process.exit(1)
})
