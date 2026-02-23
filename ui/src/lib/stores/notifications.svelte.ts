// Notifications store using Svelte 5 runes
const NOTIFICATIONS_STORAGE_KEY = 'bv-notifications'
const NOTIFICATIONS_PROFILE_SCOPE_KEY = 'bv-notifications-profile-id'

export interface Notification {
	id: string
	title: string
	message: string
	type: 'success' | 'error' | 'info' | 'warning'
	timestamp: Date
	read: boolean
	data?: Record<string, unknown>
}

// Create reactive state
let notifications = $state<Notification[]>([])

// Load from localStorage on init
if (typeof window !== 'undefined') {
	try {
		const stored = localStorage.getItem(NOTIFICATIONS_STORAGE_KEY)
		if (stored) {
			const parsed = JSON.parse(stored)
			notifications = parsed.map((n: Notification) => ({
				...n,
				timestamp: new Date(n.timestamp),
			}))
		}
	} catch {
		// Ignore parse errors
	}
}

// Save to localStorage on changes
function persist() {
	if (typeof window !== 'undefined') {
		try {
			localStorage.setItem(NOTIFICATIONS_STORAGE_KEY, JSON.stringify(notifications))
		} catch {
			// Ignore storage errors
		}
	}
}

export function syncNotificationsProfileScope(profileId: string | null | undefined) {
	if (typeof window === 'undefined') return

	const normalized = (profileId || '').trim()

	try {
		const scoped = localStorage.getItem(NOTIFICATIONS_PROFILE_SCOPE_KEY) || ''
		if (!scoped) {
			// First run for scoped notifications: just set scope without clearing existing history.
			if (normalized) localStorage.setItem(NOTIFICATIONS_PROFILE_SCOPE_KEY, normalized)
			return
		}

		if (scoped !== normalized) {
			notifications = []
			persist()
			if (normalized) {
				localStorage.setItem(NOTIFICATIONS_PROFILE_SCOPE_KEY, normalized)
			} else {
				localStorage.removeItem(NOTIFICATIONS_PROFILE_SCOPE_KEY)
			}
		}
	} catch {
		// Ignore storage errors
	}
}

export function addNotification(
	title: string,
	message: string,
	type: Notification['type'] = 'info',
	data?: Record<string, unknown>,
): Notification {
	const notification: Notification = {
		id: `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
		title,
		message,
		type,
		timestamp: new Date(),
		read: false,
		data,
	}

	notifications = [notification, ...notifications].slice(0, 50) // Keep max 50 notifications
	persist()
	return notification
}

export function markAsRead(id: string) {
	notifications = notifications.map((n) => (n.id === id ? { ...n, read: true } : n))
	persist()
}

export function markAllAsRead() {
	notifications = notifications.map((n) => ({ ...n, read: true }))
	persist()
}

export function removeNotification(id: string) {
	notifications = notifications.filter((n) => n.id !== id)
	persist()
}

export function clearAllNotifications() {
	notifications = []
	persist()
}

export function getNotifications(): Notification[] {
	return notifications
}

export function getUnreadCount(): number {
	return notifications.filter((n) => !n.read).length
}

// Export reactive getters
export const notificationsStore = {
	get all() {
		return notifications
	},
	get unreadCount() {
		return notifications.filter((n) => !n.read).length
	},
}
