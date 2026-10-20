/**
 * Locates the embedded JPEG preview in a NEF (TIFF-based) RAW file.
 *
 * Nikon cameras store a full-size JPEG preview next to the sensor data.
 * Decoding that preview is far cheaper than demosaicing the RAW data on a phone.
 */

/** Reads `length` bytes at `offset`. May return fewer bytes at end of file. */
export type ByteReader = (offset: number, length: number) => Promise<Uint8Array>

export interface PreviewLocation {
	offset: number
	length: number
	/** EXIF orientation from IFD0, 1 when absent. */
	orientation: number
}

const TagCompression = 0x0103
const TagOrientation = 0x0112
const TagSubIFDs = 0x014a
const TagJpegOffset = 0x0201
const TagJpegLength = 0x0202

const TypeSizes: Record<number, number> = {
	1: 1,
	2: 1,
	3: 2,
	4: 4,
	5: 8,
	6: 1,
	7: 1,
	8: 2,
	9: 4,
	10: 8,
	11: 4,
	12: 8,
	13: 4,
}

const MaxIfds = 32

interface IfdEntry {
	type: number
	count: number
	/** Absolute offset of the value bytes. */
	valueOffset: number
}

class TiffReader {
	constructor(
		readonly read: ByteReader,
		readonly le: boolean,
	) {}

	u16(b: Uint8Array, i: number) {
		return this.le ? b[i]! | (b[i + 1]! << 8) : (b[i]! << 8) | b[i + 1]!
	}

	u32(b: Uint8Array, i: number) {
		return this.le
			? (b[i]! | (b[i + 1]! << 8) | (b[i + 2]! << 16) | (b[i + 3]! << 24)) >>> 0
			: ((b[i]! << 24) | (b[i + 1]! << 16) | (b[i + 2]! << 8) | b[i + 3]!) >>> 0
	}

	async ifd(offset: number) {
		const head = await this.read(offset, 2)
		if (head.length < 2) return null

		const count = this.u16(head, 0)
		const body = await this.read(offset + 2, count * 12 + 4)
		if (body.length < count * 12 + 4) return null

		const entries = new Map<number, IfdEntry>()
		for (let i = 0; i < count; i++) {
			const p = i * 12
			const type = this.u16(body, p + 2)
			const n = this.u32(body, p + 4)
			const size = (TypeSizes[type] ?? 1) * n
			entries.set(this.u16(body, p), {
				type,
				count: n,
				valueOffset: size <= 4 ? offset + 2 + p + 8 : this.u32(body, p + 8),
			})
		}

		return { entries, next: this.u32(body, count * 12) }
	}

	/** Reads integer values of SHORT, LONG or IFD entry. */
	async values(entry: IfdEntry, max = 16) {
		const size = entry.type === 3 ? 2 : 4
		const n = Math.min(entry.count, max)
		const b = await this.read(entry.valueOffset, n * size)
		const out: number[] = []
		for (let i = 0; i + size <= b.length; i += size)
			out.push(size === 2 ? this.u16(b, i) : this.u32(b, i))
		return out
	}

	async value(entry: IfdEntry | undefined) {
		if (!entry) return undefined
		return (await this.values(entry, 1))[0]
	}
}

/**
 * Finds the largest embedded JPEG across IFD0, its chain, and every SubIFD.
 * Returns `null` for non-TIFF data or files without a JPEG preview.
 */
export async function findPreview(
	read: ByteReader,
): Promise<PreviewLocation | null> {
	const header = await read(0, 8)
	if (header.length < 8) return null

	const order = String.fromCharCode(header[0]!, header[1]!)
	if (order !== 'II' && order !== 'MM') return null

	const tiff = new TiffReader(read, order === 'II')
	if (tiff.u16(header, 2) !== 42) return null

	const queue = [tiff.u32(header, 4)]
	const seen = new Set<number>()
	let best: { offset: number; length: number } | null = null
	let orientation = 1

	while (queue.length && seen.size < MaxIfds) {
		const offset = queue.shift()!
		if (!offset || seen.has(offset)) continue
		const isIfd0 = seen.size === 0
		seen.add(offset)

		const ifd = await tiff.ifd(offset)
		if (!ifd) continue
		const { entries, next } = ifd

		if (isIfd0)
			orientation = (await tiff.value(entries.get(TagOrientation))) ?? 1

		const subIfds = entries.get(TagSubIFDs)
		if (subIfds) queue.push(...(await tiff.values(subIfds)))
		if (next) queue.push(next)

		const jpegOffset = await tiff.value(entries.get(TagJpegOffset))
		const jpegLength = await tiff.value(entries.get(TagJpegLength))
		if (!jpegOffset || !jpegLength) continue

		// Compression 6 is old-style JPEG, 7 is JPEG. Absent tag still allows a JPEG interchange block.
		const compression = await tiff.value(entries.get(TagCompression))
		if (compression !== undefined && compression !== 6 && compression !== 7)
			continue

		if (!best || jpegLength > best.length)
			best = { offset: jpegOffset, length: jpegLength }
	}

	return best && { ...best, orientation }
}

/** Reads pixel dimensions from JPEG SOF marker, and whether an EXIF APP1 segment exists. */
export function readJpegInfo(jpeg: Uint8Array) {
	if (jpeg[0] !== 0xff || jpeg[1] !== 0xd8) return null

	let hasExif = false
	let i = 2
	while (i + 4 <= jpeg.length) {
		if (jpeg[i] !== 0xff) return null
		const marker = jpeg[i + 1]!

		// Fill bytes and standalone markers
		if (marker === 0xff) {
			i++
			continue
		}
		if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
			i += 2
			continue
		}
		if (marker === 0xda || marker === 0xd9) return null

		const segLength = (jpeg[i + 2]! << 8) | jpeg[i + 3]!

		if (
			marker === 0xe1 &&
			jpeg[i + 4] === 0x45 &&
			jpeg[i + 5] === 0x78 &&
			jpeg[i + 6] === 0x69 &&
			jpeg[i + 7] === 0x66
		)
			hasExif = true

		const isSof =
			marker >= 0xc0 &&
			marker <= 0xcf &&
			marker !== 0xc4 &&
			marker !== 0xc8 &&
			marker !== 0xcc
		if (isSof && i + 9 <= jpeg.length)
			return {
				height: (jpeg[i + 5]! << 8) | jpeg[i + 6]!,
				width: (jpeg[i + 7]! << 8) | jpeg[i + 8]!,
				hasExif,
			}

		i += 2 + segLength
	}

	return null
}

/** Inserts minimal EXIF APP1 segment holding `orientation` right after SOI. */
export function withOrientation(jpeg: Uint8Array, orientation: number) {
	// biome-ignore format: byte layout
	const app1 = [
		0xff, 0xe1, 0x00, 0x22,
		0x45, 0x78, 0x69, 0x66, 0x00, 0x00, // "Exif\0\0"
		0x4d, 0x4d, 0x00, 0x2a, 0x00, 0x00, 0x00, 0x08, // big-endian TIFF header
		0x00, 0x01, // one entry
		0x01, 0x12, 0x00, 0x03, 0x00, 0x00, 0x00, 0x01, 0x00, orientation & 0xff, 0x00, 0x00,
		0x00, 0x00, 0x00, 0x00, // no next IFD
	]

	const out = new Uint8Array(jpeg.length + app1.length)
	out.set(jpeg.subarray(0, 2), 0)
	out.set(app1, 2)
	out.set(jpeg.subarray(2), 2 + app1.length)
	return out
}
