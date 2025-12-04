#!/usr/bin/env node
/**
 * WhatsApp Bridge for BioVault Desktop
 *
 * IPC Protocol (JSON over stdin/stdout):
 *
 * Commands (stdin):
 *   { "cmd": "login" }                    - Start QR login flow
 *   { "cmd": "logout" }                   - Logout and clear credentials
 *   { "cmd": "status" }                   - Get connection status
 *   { "cmd": "send", "to": "+1234567890", "text": "Hello" }  - Send message
 *   { "cmd": "shutdown" }                 - Graceful shutdown
 *
 * Events (stdout):
 *   { "event": "qr", "data": "base64-qr-image" }
 *   { "event": "connected", "data": { "jid": "...", "name": "..." } }
 *   { "event": "disconnected", "data": { "reason": "..." } }
 *   { "event": "message", "data": { "from": "...", "text": "...", ... } }
 *   { "event": "sent", "data": { "to": "...", "id": "..." } }
 *   { "event": "error", "data": { "message": "...", "code": "..." } }
 *   { "event": "status", "data": { "connected": true/false, "jid": "..." } }
 */

import { createInterface } from 'readline'
import { mkdir, rm } from 'fs/promises'
import { existsSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import qrcode from 'qrcode'
import pino from 'pino'
import makeWASocket, {
	useMultiFileAuthState,
	DisconnectReason,
	fetchLatestBaileysVersion,
	makeCacheableSignalKeyStore,
} from '@whiskeysockets/baileys'

// Auth credentials directory (global so multiple BioVault instances can share)
const AUTH_DIR = join(homedir(), '.baileys')

// Silent logger for Baileys
const logger = pino({ level: 'silent' })

// Global socket reference
let sock = null
let isConnected = false
let currentJid = null
let _isReconnecting = false

/**
 * Send JSON event to stdout (for Tauri to receive)
 */
function emit(event, data = {}) {
	const msg = JSON.stringify({ event, data })
	process.stdout.write(msg + '\n')
}

/**
 * Log to stderr for debugging (won't interfere with IPC)
 */
function log(...args) {
	console.error('[bridge]', ...args)
}

/**
 * Convert phone number to WhatsApp JID
 */
function toJid(phone) {
	// Remove any non-digit characters except +
	let cleaned = phone.replace(/[^\d+]/g, '')
	// Remove leading +
	if (cleaned.startsWith('+')) {
		cleaned = cleaned.slice(1)
	}
	return `${cleaned}@s.whatsapp.net`
}

/**
 * Extract phone number from JID
 * JID format: 123456789:21@s.whatsapp.net or 123456789@s.whatsapp.net
 */
function fromJid(jid) {
	if (!jid) return null
	// Handle both formats: "123456789:21@..." and "123456789@..."
	const match = jid.match(/^(\d+)(?::\d+)?@/)
	return match ? `+${match[1]}` : null
}

/**
 * Initialize WhatsApp connection
 */
async function initSocket(printQr = true) {
	log('initSocket called, printQr:', printQr)
	try {
		await mkdir(AUTH_DIR, { recursive: true })

		const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR)
		const { version } = await fetchLatestBaileysVersion()

		sock = makeWASocket({
			auth: {
				creds: state.creds,
				keys: makeCacheableSignalKeyStore(state.keys, logger),
			},
			version,
			logger,
			printQRInTerminal: false,
			browser: ['BioVault', 'Desktop', '1.0.0'],
			syncFullHistory: false,
			markOnlineOnConnect: false,
		})

		// Handle credential updates
		sock.ev.on('creds.update', saveCreds)

		// Handle connection updates
		sock.ev.on('connection.update', async (update) => {
			const { connection, lastDisconnect, qr } = update
			log('connection.update:', {
				connection,
				hasQr: !!qr,
				lastDisconnect: lastDisconnect?.error?.output?.statusCode,
			})

			if (qr && printQr) {
				try {
					// Generate QR code as base64 PNG
					const qrDataUrl = await qrcode.toDataURL(qr, {
						width: 256,
						margin: 2,
						color: { dark: '#000000', light: '#ffffff' },
					})
					emit('qr', { qr: qrDataUrl })
				} catch (err) {
					emit('error', { message: 'Failed to generate QR code', code: 'QR_ERROR' })
				}
			}

			if (connection === 'close') {
				isConnected = false
				const statusCode = lastDisconnect?.error?.output?.statusCode
				const reason = DisconnectReason[statusCode] || 'unknown'

				if (statusCode === DisconnectReason.loggedOut) {
					emit('disconnected', { reason: 'logged_out', statusCode })
					// Clear auth on logout
					await clearAuth()
				} else if (statusCode === DisconnectReason.restartRequired || statusCode === 515) {
					// 515 = restart required after QR scan. Credentials ARE saved.
					// Close current socket and reconnect WITHOUT showing QR.
					log('515 restartRequired - closing socket and reconnecting...')
					emit('disconnected', { reason: 'restartRequired', statusCode, reconnecting: true })
					try {
						sock?.ws?.close()
					} catch {
						// Ignore close errors
					}
					sock = null
					_isReconnecting = true
					// Short delay then reconnect without QR
					setTimeout(() => {
						log('Starting reconnect after 515...')
						initSocket(false)
							.then(() => {
								log('initSocket(false) completed successfully')
							})
							.catch((err) => {
								log('initSocket(false) failed:', err.message)
							})
							.finally(() => {
								_isReconnecting = false
							})
					}, 1000)
				} else if (
					statusCode === DisconnectReason.connectionClosed ||
					statusCode === DisconnectReason.connectionLost ||
					statusCode === DisconnectReason.timedOut
				) {
					emit('disconnected', { reason, statusCode, reconnecting: true })
					// Auto-reconnect after delay
					setTimeout(() => initSocket(false), 2000)
				} else {
					emit('disconnected', { reason, statusCode })
					// For unknown errors, also try to reconnect
					if (statusCode !== DisconnectReason.loggedOut) {
						setTimeout(() => initSocket(false), 3000)
					}
				}
			}

			if (connection === 'open') {
				log('Connection OPEN! User:', sock.user)
				isConnected = true
				currentJid = sock.user?.id
				const name = sock.user?.name || 'Unknown'
				const phone = fromJid(currentJid)
				log('Emitting connected event:', { jid: currentJid, name, phone })
				emit('connected', { connected: true, jid: currentJid, name, phone })
			}
		})

		// Handle incoming messages
		sock.ev.on('messages.upsert', ({ messages, type }) => {
			if (type !== 'notify') return

			for (const msg of messages) {
				// Skip messages from self
				if (msg.key.fromMe) continue

				const from = fromJid(msg.key.remoteJid)
				const text = msg.message?.conversation || msg.message?.extendedTextMessage?.text || ''
				const timestamp = msg.messageTimestamp
				const id = msg.key.id

				if (text) {
					emit('message', {
						id,
						from,
						text,
						timestamp: Number(timestamp),
						jid: msg.key.remoteJid,
					})
				}
			}
		})

		log('initSocket completed, socket created')
	} catch (err) {
		log('initSocket ERROR:', err.message)
		emit('error', { message: err.message, code: 'INIT_ERROR' })
	}
}

/**
 * Clear authentication data
 */
async function clearAuth() {
	try {
		if (existsSync(AUTH_DIR)) {
			await rm(AUTH_DIR, { recursive: true, force: true })
		}
	} catch (err) {
		// Ignore errors
	}
}

/**
 * Handle incoming commands from stdin
 */
async function handleCommand(line) {
	let cmd
	try {
		cmd = JSON.parse(line)
	} catch {
		emit('error', { message: 'Invalid JSON', code: 'PARSE_ERROR' })
		return
	}

	switch (cmd.cmd) {
		case 'login':
			if (sock) {
				// Already have a socket, check if connected
				if (isConnected) {
					emit('connected', {
						connected: true,
						jid: currentJid,
						name: sock.user?.name,
						phone: fromJid(currentJid),
					})
				} else {
					// Reinitialize to get new QR
					await initSocket(true)
				}
			} else {
				await initSocket(true)
			}
			break

		case 'logout':
			if (sock) {
				await sock.logout()
				sock = null
				isConnected = false
				currentJid = null
			}
			await clearAuth()
			emit('disconnected', { reason: 'logout' })
			break

		case 'status':
			emit('status', {
				connected: isConnected,
				jid: currentJid,
				phone: fromJid(currentJid),
				name: sock?.user?.name || null,
			})
			break

		case 'send':
			if (!isConnected || !sock) {
				emit('error', { message: 'Not connected', code: 'NOT_CONNECTED' })
				break
			}
			if (!cmd.to || !cmd.text) {
				emit('error', { message: 'Missing "to" or "text"', code: 'INVALID_PARAMS' })
				break
			}
			try {
				const jid = toJid(cmd.to)
				const result = await sock.sendMessage(jid, { text: cmd.text })
				emit('sent', {
					to: cmd.to,
					id: result.key.id,
					timestamp: Date.now(),
				})
			} catch (err) {
				emit('error', { message: err.message, code: 'SEND_ERROR' })
			}
			break

		case 'shutdown':
			if (sock) {
				sock.end()
				sock = null
			}
			emit('status', { connected: false, shutdown: true })
			process.exit(0)
			break

		default:
			emit('error', { message: `Unknown command: ${cmd.cmd}`, code: 'UNKNOWN_CMD' })
	}
}

// Set up stdin reader
const rl = createInterface({
	input: process.stdin,
	output: process.stdout,
	terminal: false,
})

rl.on('line', handleCommand)

// Handle process signals
process.on('SIGINT', () => {
	if (sock) sock.end()
	process.exit(0)
})

process.on('SIGTERM', () => {
	if (sock) sock.end()
	process.exit(0)
})

// Check if we have existing credentials and auto-connect
;(async () => {
	if (existsSync(join(AUTH_DIR, 'creds.json'))) {
		// We have credentials, try to connect silently
		await initSocket(false)
	} else {
		// No credentials, emit status
		emit('status', { connected: false, jid: null })
	}
})()
