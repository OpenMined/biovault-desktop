// Notifications store using Svelte 5 runes

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
		const stored = localStorage.getItem('bv-notifications')
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
			localStorage.setItem('bv-notifications', JSON.stringify(notifications))
		} catch {
			// Ignore storage errors
		}
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
