import type { InvokeArgs } from '@tauri-apps/api/core'

export interface ChatMessageBase {
	id: string
	from: string
	body: string
	created_at: string
}

export interface ConversationAdapter<TMessage extends ChatMessageBase = ChatMessageBase> {
	key: string
	currentUserEmail: string
	placeholder: string
	emptyText: string
	loadMessages: () => Promise<TMessage[]>
	sendMessage: (body: string) => Promise<void>
	attachPaths?: (paths: string[]) => Promise<void>
	kindLabel?: ((msg: TMessage) => string | null | undefined) | null
}

type InvokeFn = <T>(cmd: string, args?: InvokeArgs) => Promise<T>

export function buildSpaceConversationAdapter<TMessage extends ChatMessageBase>(params: {
	invoke: InvokeFn
	spaceId: string
	threadId: string
	spaceName: string
	participants: string[]
	currentUserEmail: string
	dedupeMessages: (messages: TMessage[]) => TMessage[]
	kindLabel: (msg: TMessage) => string | null | undefined
	onAfterSend?: () => Promise<void> | void
	attachPaths?: (paths: string[]) => Promise<void>
}): ConversationAdapter<TMessage> {
	const normalizedCurrentUser = params.currentUserEmail.toLowerCase()
	return {
		key: `space:${params.spaceId}`,
		currentUserEmail: params.currentUserEmail,
		placeholder: 'Message this space...',
		emptyText: 'No messages in this space yet',
		loadMessages: async () =>
			params.dedupeMessages(
				await params.invoke<TMessage[]>('get_thread_messages', {
					threadId: params.threadId,
				}),
			),
		sendMessage: async (body: string) => {
			const recipients = params.participants.filter(
				(p) => p.trim().toLowerCase() !== normalizedCurrentUser,
			)
			if (recipients.length === 0) {
				throw new Error('This space has no recipients yet')
			}
			await params.invoke('send_message', {
				request: {
					recipients,
					subject: params.spaceName,
					body,
				},
			})
			await params.onAfterSend?.()
		},
		attachPaths: params.attachPaths,
		kindLabel: params.kindLabel,
	}
}

export function buildSessionConversationAdapter<TMessage extends ChatMessageBase>(params: {
	invoke: InvokeFn
	sessionId: string
	currentUserEmail: string
	attachPaths?: (paths: string[]) => Promise<void>
}): ConversationAdapter<TMessage> {
	return {
		key: `session:${params.sessionId}`,
		currentUserEmail: params.currentUserEmail,
		placeholder: 'Message this session...',
		emptyText: 'No session messages yet.',
		loadMessages: () =>
			params.invoke<TMessage[]>('get_session_chat_messages', { sessionId: params.sessionId }),
		sendMessage: (body: string) =>
			params.invoke('send_session_chat_message', { sessionId: params.sessionId, body }),
		attachPaths: params.attachPaths,
	}
}
