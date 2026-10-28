# MarksPlugins

Mark's plugin repository for [Revenge Next](https://github.com/revenge-mod/revenge-bundle-next) on Discord Android. Add the repository once and every plugin below shows up in **Browse**.

## Plugins

### NEF Viewer

A [Revenge Next](https://github.com/revenge-mod/revenge-bundle-next) plugin for Discord Android.
It shows Nikon RAW attachments (`.nef`, `.nrw`) as photos in chat, instead of as a file to download.

## How it works

Nikon cameras store a full-size JPEG preview inside every NEF file. The plugin uses that preview.
It does not decode the RAW sensor data, which would be too slow on a phone.

1. The plugin watches incoming messages for `.nef` and `.nrw` attachments.
2. It reads the TIFF headers with HTTP Range requests and finds the largest embedded JPEG.
3. It downloads only that JPEG. A 10 MB NEF usually needs about 1 MB.
4. It saves the JPEG to Discord's cache folder (`cache/nef-viewer/`).
5. It swaps the attachment for the cached JPEG, so Discord shows a normal image.

The camera orientation tag is kept, so portrait shots display upright.
Converted photos stay cached, so they show instantly the next time.

## Install

### From link (recommended)

1. In Discord, go to **Settings** > **Plugins** > **Advanced**.
2. Paste this link into **Repository URL**, then tap **Add repository**:

   ```
   https://raw.githubusercontent.com/MarkLong0467/MarksPlugins/gh-pages/
   ```

3. Go back to **Plugins**, open **Browse**, and install any plugin, such as **NEF Viewer**.
4. Turn the plugin on, then reload Discord.

Updates arrive through the same link.

### From file

1. Download `marklong.nef-viewer@1.0.0.zip` from the `pool` folder on the `gh-pages` branch.
2. In Discord, go to **Settings** > **Plugins** > **Advanced**.
3. Tap **Install from file** and pick the ZIP.
4. Turn the plugin on, then reload Discord.

## Limits

- The photo is the camera's embedded JPEG preview, not a fresh RAW development. Edits made in Lightroom or similar apps don't show.
- After conversion, tapping the photo opens the JPEG. Use Discord on another device to download the original `.nef`.
- Messages that loaded before the plugin started show the photo after you reopen the channel.
- Turning the plugin off needs a reload to bring back the file view.

## Build

You need [Bun](https://bun.com/). See [TEMPLATE.md](./TEMPLATE.md) for the full toolchain and release flow.

```sh
bun install
bun run build nef-viewer     # plugins/nef-viewer/build/js/index.js
./gradlew packageNefViewer   # build/dist/marklong.nef-viewer@<version>.zip
```

Source lives in `plugins/nef-viewer/js/`:

| File         | Role                                                  |
| ------------ | ----------------------------------------------------- |
| `index.ts`   | Flux patches, conversion queue, message refresh       |
| `nef.ts`     | TIFF/NEF parser, JPEG size reader, orientation insert |
| `http.ts`    | Range request reader                                  |
| `convert.ts` | Conversion and on-disk cache                          |
| `base64.ts`  | Base64 encoder for writing binary files               |

## License

GPL-3.0, same as the Revenge plugin template this repository is based on.
