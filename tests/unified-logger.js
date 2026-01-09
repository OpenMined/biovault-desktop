#!/usr/bin/env node
import { WebSocketServer } from 'ws'
import fs from 'fs'
import path from 'path'

const LOG_FILE = process.argv[2] || path.resolve(process.cwd(), 'logs/unified.log')
const PORT = Number(process.argv[3] || process.env.UNIFIED_LOG_PORT || 9753)
const HOST = process.env.UNIFIED_LOG_HOST || '127.0.0.1'

fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true })
const stream = fs.createWriteStream(LOG_FILE, { flags: 'a' })

const writeLine = (line) => {
	const timestamp = new Date().toISOString()
	stream.write(`[${timestamp}] ${line}\n`)
	if (process.env.UNIFIED_LOG_STDOUT === '1') {
		process.stdout.write(`[${timestamp}] ${line}\n`)
	}
}

writeLine(`🚀 Unified logger started on ${HOST}:${PORT}`)

const wss = new WebSocketServer({ port: PORT, host: HOST })

wss.on('connection', (socket, request) => {
	const peer = request.socket.remoteAddress
	writeLine(`🔌 Client connected: ${peer}`)
	socket.on('message', (data) => {
		let payload = data.toString()
		try {
			const json = JSON.parse(payload)
			payload = JSON.stringify(json)
		} catch (error) {
			// keep raw payload
		}
		writeLine(payload)
	})

	socket.on('close', () => {
		writeLine(`🔌 Client disconnected: ${peer}`)
	})

	socket.on('error', (error) => {
		writeLine(`❌ WebSocket error (${peer}): ${error}`)
	})
})

wss.on('error', (error) => {
	writeLine(`❌ Logger server error: ${error}`)
	process.exitCode = 1
})

process.on('SIGINT', () => {
	writeLine('🛑 Unified logger shutting down')
	wss.close(() => {
		stream.end(() => process.exit(0))
	})
})

process.on('SIGTERM', () => {
	writeLine('🛑 Unified logger shutting down (SIGTERM)')
	wss.close(() => {
		stream.end(() => process.exit(0))
	})
})
