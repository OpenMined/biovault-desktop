import { test as base, expect, type TestInfo, type Page } from '@playwright/test'
import * as readline from 'node:readline'

const pausedTests = new Set<string>()
let warnedNoTty = false

function shouldPauseInteractive() {
	return process.env.INTERACTIVE_MODE === '1'
}

async function promptForEnter(message: string) {
	await new Promise<void>((resolve) => {
		const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
		rl.question(message, () => {
			rl.close()
			resolve()
		})
	})
}

function formatTestLabel(testInfo?: TestInfo) {
	if (!testInfo) return 'Test finished.'
	const titlePath = testInfo.titlePath().filter(Boolean)
	if (titlePath.length === 0) return 'Test finished.'
	return `${titlePath.join(' > ')} finished.`
}

export async function pauseForInteractive(testInfo?: TestInfo) {
	if (!shouldPauseInteractive()) return
	if (!process.stdin.isTTY) {
		if (!warnedNoTty) {
			console.log('[Playwright] Interactive mode requested but no TTY; skipping pause.')
			warnedNoTty = true
		}
		return
	}

	const testId = testInfo?.testId
	if (testId && pausedTests.has(testId)) return
	if (testId) pausedTests.add(testId)

	if (testInfo) {
		testInfo.setTimeout(0)
	}

	const label = formatTestLabel(testInfo)
	await promptForEnter(`\n[Playwright] ${label} Press Enter to continue.\n`)
}

const test = base

test.afterEach(async ({}, testInfo) => {
	await pauseForInteractive(testInfo)
})

export { test, expect }
export type { Page, TestInfo }
