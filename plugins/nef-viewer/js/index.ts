/**
 * Shows NEF attachments as photos in chat.
 *
 * Flow:
 * 1. Flux patches spot `.nef` attachments in incoming messages.
 * 2. Embedded JPEG preview gets downloaded with Range requests and cached on disk.
 * 3. A local MESSAGE_UPDATE swaps the attachment for the cached JPEG, so Discord renders an image.
 */

import { Dispatcher } from '@valenced/discord/common/flux'
import { onFluxEventDispatched, Stores } from '@valenced/discord/flux'
import { convert, loadIndex, previews } from './convert'

const RawFilePattern = /\.(nef|nrw)$/i
const MaxConcurrent = 2
const Tag = '[nef-viewer]'

/** Attachment IDs being converted, mapped to their message. */
const pending = new Map<string, { channelId: string; messageId: string }>()
const failed = new Set<string>()
const queue: Array<{ id: string; url: string }> = []
let running = 0
let active = false

function isRawAttachment(attachment: any) {
	return (
		typeof attachment?.filename === 'string' &&
		RawFilePattern.test(attachment.filename) &&
		typeof attachment.url === 'string'
	)
}

function toImageAttachment(attachment: any) {
	const preview = previews.get(attachment.id)
	if (!preview) return attachment

	return {
		...attachment,
		filename: attachment.filename.replace(RawFilePattern, '.jpg'),
		content_type: 'image/jpeg',
		url: preview.uri,
		proxy_url: preview.uri,
		width: preview.width,
		height: preview.height,
		size: preview.size,
	}
}

function schedule(attachment: any, channelId: string, messageId: string) {
	const { id } = attachment
	if (failed.has(id) || pending.has(id)) return

	pending.set(id, { channelId, messageId })
	queue.push({ id, url: attachment.url })
	pump()
}

function pump() {
	while (active && running < MaxConcurrent && queue.length) {
		const { id, url } = queue.shift()!
		running++

		convert(id, url)
			.then(() => refreshMessage(id))
			.catch(error => {
				failed.add(id)
				console.warn(`${Tag} Failed to convert ${id}:`, String(error))
			})
			.finally(() => {
				pending.delete(id)
				running--
				pump()
			})
	}
}

/** Re-dispatches stored message so the flux patch swaps in the converted preview. */
function refreshMessage(attachmentId: string) {
	const target = pending.get(attachmentId)
	if (!active || !target) return

	const message = (Stores.MessageStore as any)?.getMessage?.(
		target.channelId,
		target.messageId,
	)
	if (!message?.attachments) return

	Dispatcher.dispatch({
		type: 'MESSAGE_UPDATE',
		message: {
			id: message.id,
			channel_id: message.channel_id,
			attachments: message.attachments,
		},
	} as any)
}

/** Rewrites RAW attachments of message in place. Queues ones without a cached preview. */
function patchMessage(message: any, channelId?: string) {
	if (!message) return

	const channel = message.channel_id ?? channelId
	const { attachments } = message

	if (Array.isArray(attachments) && attachments.some(isRawAttachment))
		message.attachments = attachments.map((attachment: any) => {
			if (!isRawAttachment(attachment)) return attachment
			if (previews.has(attachment.id)) return toImageAttachment(attachment)
			if (channel && message.id) schedule(attachment, channel, message.id)
			return attachment
		})

	// Forwarded messages
	if (Array.isArray(message.message_snapshots))
		for (const snapshot of message.message_snapshots)
			if (snapshot?.message) {
				const { attachments } = snapshot.message
				if (Array.isArray(attachments))
					snapshot.message.attachments = attachments.map((a: any) =>
						isRawAttachment(a) ? toImageAttachment(a) : a,
					)
			}
}

const SingleMessageEvents = ['MESSAGE_CREATE', 'MESSAGE_UPDATE'] as const

const MessageListEvents = [
	'LOAD_MESSAGES_SUCCESS',
	'LOAD_MESSAGES_AROUND_SUCCESS',
	'LOAD_PINNED_MESSAGES_SUCCESS',
	'LOAD_RECENT_MENTIONS_SUCCESS',
] as const

export default plugin({
	start({ cleanup }) {
		active = true
		cleanup(() => {
			active = false
			queue.length = 0
		})

		loadIndex().catch(() => {})

		for (const type of SingleMessageEvents)
			cleanup(
				onFluxEventDispatched<{ message?: any }>(type, payload => {
					try {
						patchMessage(payload.message)
					} catch (error) {
						console.warn(`${Tag} ${type} patch failed:`, String(error))
					}
					return payload
				}),
			)

		for (const type of MessageListEvents)
			cleanup(
				onFluxEventDispatched<{ messages?: any[]; channelId?: string }>(
					type,
					payload => {
						try {
							if (Array.isArray(payload.messages))
								for (const message of payload.messages)
									patchMessage(message, payload.channelId)
						} catch (error) {
							console.warn(`${Tag} ${type} patch failed:`, String(error))
						}
						return payload
					},
				),
			)
	},
	stop({ plugin }) {
		// Already rendered messages keep the swapped attachment until reload
		plugin.requireReload()
	},
})
