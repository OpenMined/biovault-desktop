#!/usr/bin/env node
import http from 'http'
import { createReadStream, promises as fs } from 'fs'
import path from 'path'

const rootDir = process.argv[2] ? path.resolve(process.argv[2]) : null
const port = Number.parseInt(process.argv[3] || '', 10)
const host = process.argv[4] || '127.0.0.1'

if (!rootDir || !Number.isFinite(port)) {
	console.error('Usage: static-server.js <rootDir> <port> [host]')
	process.exit(2)
}

const MIME_BY_EXT = new Map([
	['.html', 'text/html; charset=utf-8'],
	['.js', 'text/javascript; charset=utf-8'],
	['.css', 'text/css; charset=utf-8'],
	['.svg', 'image/svg+xml'],
	['.png', 'image/png'],
	['.jpg', 'image/jpeg'],
	['.jpeg', 'image/jpeg'],
	['.gif', 'image/gif'],
	['.json', 'application/json; charset=utf-8'],
	['.txt', 'text/plain; charset=utf-8'],
	['.woff', 'font/woff'],
	['.woff2', 'font/woff2'],
])

function safeResolvePath(urlPathname) {
	const decoded = (() => {
		try {
			return decodeURIComponent(urlPathname)
		} catch {
			return urlPathname
		}
	})()
	const normalized = decoded.replaceAll('\\', '/')
	const candidate = path.resolve(rootDir, `.${normalized}`)
	if (!candidate.startsWith(rootDir + path.sep) && candidate !== rootDir) {
		return null
	}
	return candidate
}

async function resolveFilePath(urlPathname) {
	let fsPath = safeResolvePath(urlPathname)
	if (!fsPath) return null
	let stat
	try {
		stat = await fs.stat(fsPath)
	} catch {
		return null
	}
	if (stat.isDirectory()) {
		fsPath = path.join(fsPath, 'index.html')
		try {
			await fs.access(fsPath)
		} catch {
			return null
		}
	}
	return fsPath
}

const server = http.createServer(async (req, res) => {
	const url = new URL(req.url || '/', `http://${host}`)
	const pathname = url.pathname || '/'

	const fsPath = await resolveFilePath(pathname)
	if (!fsPath) {
		res.statusCode = 404
		res.setHeader('Content-Type', 'text/plain; charset=utf-8')
		res.end('Not Found')
		return
	}

	const ext = path.extname(fsPath).toLowerCase()
	res.setHeader('Content-Type', MIME_BY_EXT.get(ext) || 'application/octet-stream')
	createReadStream(fsPath)
		.on('error', () => {
			res.statusCode = 500
			res.end('Internal Server Error')
		})
		.pipe(res)
})

server.listen(port, host, () => {
	console.log(`Static server listening on http://${host}:${port} (root: ${rootDir})`)
})

process.on('SIGTERM', () => server.close(() => process.exit(0)))
process.on('SIGINT', () => server.close(() => process.exit(0)))
