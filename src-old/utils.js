/**
 * Shared Utilities Module
 * Common functions used across Messages, Sessions, and other modules
 */

// ============================================================================
// HTML UTILITIES
// ============================================================================

/**
 * Escape HTML special characters to prevent XSS
 * @param {string|null|undefined} value - The value to escape
 * @returns {string} Escaped HTML string
 */
export function escapeHtml(value) {
	if (value === undefined || value === null) return ''
	const div = document.createElement('div')
	div.textContent = value
	return div.innerHTML
}

// ============================================================================
// DATE/TIME FORMATTING
// ============================================================================

/**
 * Format a date as a full date-time string
 * @param {string|Date|null} value - ISO string or Date object
 * @returns {string} Formatted date-time string
 */
export function formatDateTime(value) {
	if (!value) return ''
	const date = new Date(value)
	if (Number.isNaN(date.getTime())) return String(value)
	return date.toLocaleString()
}

/**
 * Format a date as a short date-time (for message timestamps)
 * @param {string|Date|null} value - ISO string or Date object
 * @returns {string} Formatted short date-time
 */
export function formatFullDateTime(value) {
	if (!value) return ''
	const date = new Date(value)
	if (Number.isNaN(date.getTime())) return String(value)
	return date.toLocaleString([], {
		month: 'short',
		day: 'numeric',
		hour: '2-digit',
		minute: '2-digit',
	})
}

/**
 * Format a date relative to now (e.g., "2h ago", "Yesterday")
 * @param {string|Date|null} value - ISO string or Date object
 * @returns {string} Relative time string
 */
export function formatRelativeTime(value) {
	if (!value) return ''
	const date = new Date(value)
	if (Number.isNaN(date.getTime())) return String(value)

	const now = new Date()
	const diff = now - date
	const minutes = Math.floor(diff / 60000)
	const hours = Math.floor(diff / 3600000)
	const days = Math.floor(diff / 86400000)

	if (days > 7) {
		return date.toLocaleDateString([], { month: 'short', day: 'numeric' })
	}
	if (days > 0) return `${days}d ago`
	if (hours > 0) return `${hours}h ago`
	if (minutes > 0) return `${minutes}m ago`
	return 'just now'
}

/**
 * Format a date for thread list display (smart time/date)
 * @param {string|Date|null} value - ISO string or Date object
 * @returns {string} Smart formatted date
 */
export function formatThreadDateTime(value) {
	if (!value) return ''
	const date = new Date(value)
	if (Number.isNaN(date.getTime())) return String(value)

	const now = new Date()
	const diff = now - date
	const oneDay = 24 * 60 * 60 * 1000

	// Today - show time only
	if (diff < oneDay && date.getDate() === now.getDate()) {
		return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
	}

	// Yesterday
	const yesterday = new Date(now - oneDay)
	if (date.getDate() === yesterday.getDate()) {
		return 'Yesterday'
	}

	// Within a week - show day name
	if (diff < 7 * oneDay) {
		return date.toLocaleDateString([], { weekday: 'short' })
	}

	// Older - show date
	return date.toLocaleDateString([], { month: 'short', day: 'numeric' })
}

/**
 * Format a date separator label (Today, Yesterday, Monday, etc.)
 * @param {string|Date|null} value - ISO string or Date object
 * @returns {string} Date separator label
 */
export function formatDateSeparator(value) {
	if (!value) return ''
	const date = new Date(value)
	if (Number.isNaN(date.getTime())) return ''

	const now = new Date()
	const today = new Date(now.getFullYear(), now.getMonth(), now.getDate())
	const yesterday = new Date(today.getTime() - 24 * 60 * 60 * 1000)
	const msgDate = new Date(date.getFullYear(), date.getMonth(), date.getDate())

	if (msgDate.getTime() === today.getTime()) {
		return 'Today'
	}
	if (msgDate.getTime() === yesterday.getTime()) {
		return 'Yesterday'
	}

	// Within last week
	const weekAgo = new Date(today.getTime() - 7 * 24 * 60 * 60 * 1000)
	if (msgDate >= weekAgo) {
		return date.toLocaleDateString([], { weekday: 'long' })
	}

	// Older
	return date.toLocaleDateString([], { weekday: 'long', month: 'short', day: 'numeric' })
}

/**
 * Get a unique key for a date (for grouping messages by date)
 * @param {string|Date|null} value - ISO string or Date object
 * @returns {string} Date key string
 */
export function getDateKey(value) {
	if (!value) return ''
	const date = new Date(value)
	if (Number.isNaN(date.getTime())) return ''
	return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`
}

// ============================================================================
// EMAIL UTILITIES
// ============================================================================

/**
 * Normalize an email address (lowercase, trimmed)
 * @param {string|null|undefined} email - Email address
 * @returns {string} Normalized email
 */
export function normalizeEmail(email) {
	if (!email) return ''
	return String(email).toLowerCase().trim()
}

/**
 * Check if two emails match (case-insensitive)
 * @param {string} email1 - First email
 * @param {string} email2 - Second email
 * @returns {boolean} True if emails match
 */
export function emailsMatch(email1, email2) {
	return normalizeEmail(email1) === normalizeEmail(email2)
}

/**
 * Get initials from an email address
 * @param {string|null|undefined} email - Email address
 * @returns {string} Initials (1-2 characters)
 */
export function getInitials(email) {
	if (!email) return '?'
	const name = email.split('@')[0]
	const parts = name.split(/[._-]/)
	if (parts.length >= 2) {
		return (parts[0][0] + parts[1][0]).toUpperCase()
	}
	return name.slice(0, 2).toUpperCase()
}

// ============================================================================
// DIALOG UTILITIES
// ============================================================================

/**
 * Show a confirmation dialog (with fallback to window.confirm)
 * @param {object|null} dialog - Tauri dialog object
 * @param {string} message - Confirmation message
 * @param {object} options - Dialog options
 * @returns {Promise<boolean>} User's choice
 */
export async function confirmWithDialog(dialog, message, options = {}) {
	if (dialog?.confirm) {
		return await dialog.confirm(message, options)
	}
	return window.confirm(message)
}

// ============================================================================
// METADATA UTILITIES
// ============================================================================

/**
 * Normalize metadata (parse JSON string if needed)
 * @param {string|object|null} value - Metadata value
 * @returns {object|null} Parsed metadata object
 */
export function normalizeMetadata(value) {
	if (!value) return null
	if (typeof value === 'string') {
		try {
			return JSON.parse(value)
		} catch (error) {
			console.warn('Failed to parse metadata string', error)
			return null
		}
	}
	return value
}
