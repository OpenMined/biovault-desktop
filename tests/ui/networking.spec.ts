/**
 * Networking stability smoke test.
 * @tag networking
 */
import { expect, test } from './playwright-fixtures'
import WebSocket from 'ws'
import * as fs from 'fs'
import * as path from 'path'
import { ensureLogSocket, log, setWsPort } from './onboarding-helper.js'
import { waitForAppReady } from './test-helpers.js'

const TEST_TIMEOUT = 150_000
const SYFTBOX_READY_TIMEOUT = 30_000
const SYFTBOX_RESTART_TIMEOUT = 45_000
const SYNC_TIMEOUT = 60_000
const OFFLINE_GUARD_MS = 3_000
const OFFLINE_SYNC_TIMEOUT = 90_000
const POLL_INTERVAL_MS = 500

interface Backend {
        invoke: (
                cmd: string,
                args?: Record<string, unknown>,
                timeoutMs?: number,
        ) => Promise<any>
        close: () => Promise<void>
}

function delay(ms: number) {
        return new Promise((resolve) => setTimeout(resolve, ms))
}

async function connectBackend(port: number): Promise<Backend> {
        const socket = new WebSocket(`ws://localhost:${port}`)
        await new Promise<void>((resolve, reject) => {
                const timeout = setTimeout(
                        () => reject(new Error(`WS connect timeout on port ${port}`)),
                        10_000,
                )
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
        const pending = new Map<
                number,
                { resolve: (value: any) => void; reject: (error: any) => void }
        >()

        socket.on('message', (data) => {
                let parsed: any
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

        function invoke(
                cmd: string,
                args: Record<string, unknown> = {},
                timeoutMs = 30_000,
        ) {
                const id = ++nextId
                socket.send(JSON.stringify({ id, cmd, args }))
                return new Promise<any>((resolve, reject) => {
                        pending.set(id, { resolve, reject })
                        setTimeout(() => {
                                if (!pending.has(id)) return
                                pending.delete(id)
                                reject(new Error(`WS invoke timeout: ${cmd}`))
                        }, timeoutMs)
                })
        }

        async function close() {
                if (socket.readyState !== WebSocket.OPEN) return
                await new Promise<void>((resolve) => {
                        socket.once('close', () => resolve())
                        socket.close()
                })
        }

        return { invoke, close }
}

function resolveDatasitesRoot(dataDir: string): string {
        return path.basename(dataDir) === 'datasites'
                ? dataDir
                : path.join(dataDir, 'datasites')
}

async function getSyftboxDataDir(backend: Backend): Promise<string> {
        const info = await backend.invoke('get_syftbox_config_info')
        const dataDir = info?.data_dir
        if (!dataDir || typeof dataDir !== 'string') {
                throw new Error('WS bridge did not return a usable data_dir')
        }
        return path.normalize(dataDir)
}

async function waitForSyftboxRunning(
        backend: Backend,
        expected: boolean,
        label: string,
        timeoutMs: number,
) {
        const start = Date.now()
        while (Date.now() - start < timeoutMs) {
                const state = await backend
                        .invoke('get_syftbox_state', {}, 10_000)
                        .catch(() => null)
                if (state?.running === expected) {
                        return state
                }
                await delay(POLL_INTERVAL_MS)
        }
        throw new Error(
                `[${label}] syftbox running state did not become ${expected}`,
        )
}

async function waitForSyftboxReady(
        backend: Backend,
        label: string,
        timeoutMs = SYFTBOX_READY_TIMEOUT,
) {
        const start = Date.now()
        let started = false
        let lastState: any = null
        let lastQueue: any = null
        let lastError: string | null = null

        while (Date.now() - start < timeoutMs) {
                try {
                        lastState = await backend.invoke('get_syftbox_state', {}, 10_000)
                } catch (err) {
                        lastError = String(err)
                }

                if (lastState && !lastState.running && !started) {
                        try {
                                await backend.invoke('start_syftbox_client', {}, 30_000)
                                started = true
                        } catch (err) {
                                lastError = String(err)
                        }
                }

                try {
                        lastQueue = await backend.invoke('syftbox_queue_status', {}, 15_000)
                } catch (err) {
                        lastError = String(err)
                }

                const queueError = lastQueue?.error
                const hasControlPlane = Boolean(lastQueue?.control_plane_url)
                if (lastState?.running && !queueError && hasControlPlane) {
                        return { state: lastState, queue: lastQueue }
                }

                await delay(POLL_INTERVAL_MS)
        }

        throw new Error(
                `[${label}] syftbox not ready after ${timeoutMs}ms (state=${JSON.stringify(
                        lastState,
                )}, queueError=${lastQueue?.error ?? lastError ?? 'unknown'})`,
        )
}

async function restartSyftbox(backend: Backend, label: string) {
        await backend.invoke('stop_syftbox_client', {}, 20_000)
        await waitForSyftboxRunning(backend, false, label, 15_000)
        await backend.invoke('start_syftbox_client', {}, 30_000)
        await waitForSyftboxRunning(backend, true, label, SYFTBOX_RESTART_TIMEOUT)
}

async function createSyncFile(
        dataDir: string,
        ownerEmail: string,
        label: string,
) {
        const safeLabel = label.replace(/[^a-z0-9_-]/gi, '-')
        const baseDir = path.join(
                resolveDatasitesRoot(dataDir),
                ownerEmail,
                'public',
                'biovault',
                'networking-smoke',
        )
        await fs.promises.mkdir(baseDir, { recursive: true })
        const fileName = `${safeLabel}-${Date.now()}.txt`
        const filePath = path.join(baseDir, fileName)
        const body = `networking-smoke ${safeLabel} ${new Date().toISOString()}\n`
        await fs.promises.writeFile(filePath, body, 'utf-8')
        return { fileName, filePath, body }
}

async function waitForRemoteFile(
        backend1: Backend,
        backend2: Backend,
        targetPath: string,
        label: string,
        timeoutMs = SYNC_TIMEOUT,
) {
        const start = Date.now()
        let syncAttempts = 0
        while (Date.now() - start < timeoutMs) {
                if (fs.existsSync(targetPath)) {
                        return
                }
                if (syncAttempts % 3 === 0) {
                        await Promise.allSettled([
                                backend1.invoke('trigger_syftbox_sync').catch(() => {}),
                                backend2.invoke('trigger_syftbox_sync').catch(() => {}),
                        ])
                }
                syncAttempts += 1
                await delay(POLL_INTERVAL_MS)
        }
        throw new Error(`[${label}] timed out waiting for synced file: ${targetPath}`)
}

test.describe.configure({ timeout: TEST_TIMEOUT })

test.describe('Networking stability @networking', () => {
        test('control plane restart and file sync', async ({ browser }) => {
                const wsPort1 = Number.parseInt(
                        process.env.DEV_WS_BRIDGE_PORT_BASE || '3333',
                        10,
                )
                const wsPort2 = wsPort1 + 1
                const email1 = process.env.CLIENT1_EMAIL || 'client1@sandbox.local'
                const email2 = process.env.CLIENT2_EMAIL || 'client2@sandbox.local'
                const uiBaseUrl = process.env.UI_BASE_URL || 'http://localhost:8082'

                const logSocket = await ensureLogSocket()
                log(logSocket, { event: 'networking-start', email1, email2 })

                const page1 = await browser.newPage()
                const page2 = await browser.newPage()

                await setWsPort(page1, wsPort1)
                await setWsPort(page2, wsPort2)

                await page1.goto(uiBaseUrl)
                await page2.goto(uiBaseUrl)

                await waitForAppReady(page1, { timeout: 20_000 })
                await waitForAppReady(page2, { timeout: 20_000 })

                const backend1 = await connectBackend(wsPort1)
                const backend2 = await connectBackend(wsPort2)

                try {
                        const dataDir1 = await getSyftboxDataDir(backend1)
                        const dataDir2 = await getSyftboxDataDir(backend2)
                        log(logSocket, { event: 'syftbox-data-dir', dataDir1, dataDir2 })

                        const readiness1 = await waitForSyftboxReady(backend1, 'client1')
                        const readiness2 = await waitForSyftboxReady(backend2, 'client2')
                        expect(readiness1.queue?.control_plane_url).toBeTruthy()
                        expect(readiness2.queue?.control_plane_url).toBeTruthy()

                        const diagnostics1 = await backend1
                                .invoke('get_syftbox_diagnostics', {}, 10_000)
                                .catch(() => null)
                        const diagnostics2 = await backend2
                                .invoke('get_syftbox_diagnostics', {}, 10_000)
                                .catch(() => null)
                        log(logSocket, { event: 'syftbox-diagnostics', diagnostics1, diagnostics2 })

                        const initialFile = await createSyncFile(
                                dataDir1,
                                email1,
                                'initial',
                        )
                        const remoteInitial = path.join(
                                resolveDatasitesRoot(dataDir2),
                                email1,
                                'public',
                                'biovault',
                                'networking-smoke',
                                initialFile.fileName,
                        )
                        log(logSocket, {
                                event: 'sync-start',
                                label: 'initial',
                                local: initialFile.filePath,
                                remote: remoteInitial,
                        })
                        await waitForRemoteFile(backend1, backend2, remoteInitial, 'initial')
                        expect(fs.existsSync(remoteInitial)).toBe(true)

                        log(logSocket, { event: 'syftbox-restart', target: 'client1' })
                        await restartSyftbox(backend1, 'client1')
                        await waitForSyftboxReady(backend1, 'client1')

                        const restartFile = await createSyncFile(
                                dataDir1,
                                email1,
                                'after-restart',
                        )
                        const remoteRestart = path.join(
                                resolveDatasitesRoot(dataDir2),
                                email1,
                                'public',
                                'biovault',
                                'networking-smoke',
                                restartFile.fileName,
                        )
                        log(logSocket, {
                                event: 'sync-start',
                                label: 'after-restart',
                                local: restartFile.filePath,
                                remote: remoteRestart,
                        })
                        await waitForRemoteFile(
                                backend1,
                                backend2,
                                remoteRestart,
                                'after-restart',
                        )
                        expect(fs.existsSync(remoteRestart)).toBe(true)
                } finally {
                        await backend1.close()
                        await backend2.close()
                        if (logSocket) {
                                await new Promise<void>((resolve) => {
                                        logSocket.once('close', () => resolve())
                                        logSocket.close()
                                })
                        }
                }
        })

        test('client2 offline recovery and resync', async ({ browser }, testInfo) => {
                testInfo.setTimeout(180_000)
                const wsPort1 = Number.parseInt(
                        process.env.DEV_WS_BRIDGE_PORT_BASE || '3333',
                        10,
                )
                const wsPort2 = wsPort1 + 1
                const email1 = process.env.CLIENT1_EMAIL || 'client1@sandbox.local'
                const email2 = process.env.CLIENT2_EMAIL || 'client2@sandbox.local'
                const uiBaseUrl = process.env.UI_BASE_URL || 'http://localhost:8082'

                const logSocket = await ensureLogSocket()
                log(logSocket, { event: 'networking-offline-start', email1, email2 })

                const page1 = await browser.newPage()
                const page2 = await browser.newPage()

                await setWsPort(page1, wsPort1)
                await setWsPort(page2, wsPort2)

                await page1.goto(uiBaseUrl)
                await page2.goto(uiBaseUrl)

                await waitForAppReady(page1, { timeout: 20_000 })
                await waitForAppReady(page2, { timeout: 20_000 })

                const backend1 = await connectBackend(wsPort1)
                const backend2 = await connectBackend(wsPort2)

                try {
                        const dataDir1 = await getSyftboxDataDir(backend1)
                        const dataDir2 = await getSyftboxDataDir(backend2)
                        log(logSocket, { event: 'syftbox-data-dir', dataDir1, dataDir2 })

                        await waitForSyftboxReady(backend1, 'client1')
                        await waitForSyftboxReady(backend2, 'client2')

                        log(logSocket, { event: 'syftbox-stop', target: 'client2' })
                        await backend2.invoke('stop_syftbox_client', {}, 20_000)
                        await waitForSyftboxRunning(backend2, false, 'client2', 20_000)

                        const offlineFile = await createSyncFile(
                                dataDir1,
                                email1,
                                'client2-offline',
                        )
                        const remoteOffline = path.join(
                                resolveDatasitesRoot(dataDir2),
                                email1,
                                'public',
                                'biovault',
                                'networking-smoke',
                                offlineFile.fileName,
                        )
                        log(logSocket, {
                                event: 'sync-start',
                                label: 'client2-offline',
                                local: offlineFile.filePath,
                                remote: remoteOffline,
                        })

                        await delay(OFFLINE_GUARD_MS)
                        expect(fs.existsSync(remoteOffline)).toBe(false)

                        log(logSocket, { event: 'syftbox-start', target: 'client2' })
                        await backend2.invoke('start_syftbox_client', {}, 30_000)
                        await waitForSyftboxReady(
                                backend2,
                                'client2-restart',
                                SYFTBOX_READY_TIMEOUT + 30_000,
                        )

                        await waitForRemoteFile(
                                backend1,
                                backend2,
                                remoteOffline,
                                'client2-offline',
                                OFFLINE_SYNC_TIMEOUT,
                        )
                        expect(fs.existsSync(remoteOffline)).toBe(true)
                } finally {
                        await backend2
                                .invoke('start_syftbox_client', {}, 30_000)
                                .catch(() => {})
                        await waitForSyftboxRunning(
                                backend2,
                                true,
                                'client2-recover',
                                20_000,
                        ).catch(() => {})
                        await backend1.close()
                        await backend2.close()
                        if (logSocket) {
                                await new Promise<void>((resolve) => {
                                        logSocket.once('close', () => resolve())
                                        logSocket.close()
                                })
                        }
                }
        })
})
