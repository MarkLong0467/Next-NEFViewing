import { FileModule } from '@valenced/discord/native'
import { toBase64 } from './base64'
import { createRangeReader } from './http'
import { findPreview, readJpegInfo, withOrientation } from './nef'

const CacheDir = 'nef-viewer'
const IndexPath = `${CacheDir}/index.json`

export interface ConvertedPreview {
	/** `file://` URI of cached JPEG. */
	uri: string
	width: number
	height: number
	size: number
}

/** Converted previews keyed by attachment ID. */
export const previews = new Map<string, ConvertedPreview>()

function cachePath(relative: string) {
	return `${FileModule.getConstants().CacheDirPath}/${relative}`
}

/** Loads cached previews from disk, dropping entries with missing files. */
export async function loadIndex() {
	let index: Record<string, ConvertedPreview> = {}
	try {
		index = JSON.parse(await FileModule.readFile(cachePath(IndexPath), 'utf8'))
	} catch {
		return
	}

	await Promise.all(
		Object.entries(index).map(async ([id, preview]) => {
			const exists = await FileModule.fileExists(
				preview.uri.replace(/^file:\/\//, ''),
			).catch(() => false)
			if (exists) previews.set(id, preview)
		}),
	)
}

let saving: Promise<unknown> = Promise.resolve()

function saveIndex() {
	const data = JSON.stringify(Object.fromEntries(previews))
	saving = saving
		.then(() => FileModule.writeFile('cache', IndexPath, data, 'utf8'))
		.catch(() => {})
}

/** Downloads embedded JPEG preview of RAW file and caches it on disk. */
export async function convert(id: string, url: string) {
	const read = createRangeReader(url)

	const location = await findPreview(read)
	if (!location) throw new Error('No embedded JPEG preview found')

	let jpeg = await read(location.offset, location.length)
	const info = readJpegInfo(jpeg)
	if (!info) throw new Error('Embedded preview is not a valid JPEG')

	const { orientation } = location
	if (orientation > 1 && orientation <= 8 && !info.hasExif)
		jpeg = withOrientation(jpeg, orientation)

	// Orientations 5 to 8 rotate by 90 degrees
	const rotated = orientation >= 5 && orientation <= 8

	const path = await FileModule.writeFile(
		'cache',
		`${CacheDir}/${id}.jpg`,
		toBase64(jpeg),
		'base64',
	)

	const preview: ConvertedPreview = {
		uri: path.startsWith('file://') ? path : `file://${path}`,
		width: rotated ? info.height : info.width,
		height: rotated ? info.width : info.height,
		size: jpeg.length,
	}

	previews.set(id, preview)
	saveIndex()
	return preview
}
