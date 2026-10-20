import type { ByteReader } from './nef'

const HeadSize = 256 * 1024
const MinChunk = 64 * 1024

/**
 * Creates a reader over remote file using HTTP Range requests.
 * Only TIFF headers and preview bytes get downloaded, not the whole RAW file.
 */
export function createRangeReader(url: string): ByteReader {
	const chunks: Array<{ start: number; bytes: Uint8Array }> = []
	let size = Number.POSITIVE_INFINITY

	const fetchChunk = async (start: number, length: number) => {
		const res = await fetch(url, {
			headers: { Range: `bytes=${start}-${start + length - 1}` },
		})
		if (!res.ok) throw new Error(`HTTP ${res.status}`)

		const bytes = new Uint8Array(await res.arrayBuffer())

		// 200 means the server ignored Range and sent the whole file
		if (res.status === 200) {
			chunks.length = 0
			chunks.push({ start: 0, bytes })
			size = bytes.length
			return
		}

		const total = /\/(\d+)$/.exec(res.headers.get('content-range') ?? '')
		if (total) size = Number(total[1])
		chunks.push({ start, bytes })
	}

	const fromChunks = (offset: number, length: number) => {
		const want = Math.min(offset + length, size)
		for (const { start, bytes } of chunks)
			if (offset >= start && want <= start + bytes.length)
				return bytes.subarray(offset - start, want - start)
		return null
	}

	return async (offset, length) => {
		if (!chunks.length) await fetchChunk(0, HeadSize)
		if (offset >= size) return new Uint8Array(0)

		const hit = fromChunks(offset, length)
		if (hit) return hit

		await fetchChunk(offset, Math.max(length, MinChunk))
		return fromChunks(offset, length) ?? new Uint8Array(0)
	}
}
