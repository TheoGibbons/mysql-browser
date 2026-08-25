/**
 * Rasterises resources/icon.svg into the app icons electron-builder ships, and
 * copies the same artwork into the marketing site as its favicon and link-preview
 * image.
 *
 * Run with `npm run icon`. Chromium (via Electron, already a dev dependency) does
 * the rasterising, so no image library is needed. The SVG is re-encoded at each
 * target size rather than scaled from one bitmap, so the small sizes stay crisp.
 */

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { app, BrowserWindow } = require('electron')

const ROOT = path.join(__dirname, '..')
const SVG = path.join(ROOT, 'resources', 'icon.svg')
const ICO = path.join(ROOT, 'resources', 'icon.ico')
const PNG = path.join(ROOT, 'resources', 'icon.png')

// The site's Docker build context is ./site, so its Dockerfile cannot reach
// resources/. The favicons are therefore generated copies committed under
// site/public/ rather than something the image build pulls in.
const SITE_SVG = path.join(ROOT, 'site', 'public', 'favicon.svg')
const SITE_ICO = path.join(ROOT, 'site', 'public', 'favicon.ico')
const SITE_OG = path.join(ROOT, 'site', 'public', 'og-image.png')

/** Sizes Windows picks between: taskbar, Explorer views, and the installer. */
const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256]

/** Packs PNG-compressed entries into an .ico (Vista+ reads PNG entries directly). */
function buildIco(images) {
  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0) // reserved
  header.writeUInt16LE(1, 2) // 1 = icon
  header.writeUInt16LE(images.length, 4)

  const directory = Buffer.alloc(16 * images.length)
  let offset = header.length + directory.length

  images.forEach(({ size, buffer }, i) => {
    const at = i * 16
    // 256 is stored as 0 — the field is a single byte.
    directory.writeUInt8(size >= 256 ? 0 : size, at)
    directory.writeUInt8(size >= 256 ? 0 : size, at + 1)
    directory.writeUInt8(0, at + 2) // palette size, 0 for truecolour
    directory.writeUInt8(0, at + 3) // reserved
    directory.writeUInt16LE(1, at + 4) // colour planes
    directory.writeUInt16LE(32, at + 6) // bits per pixel
    directory.writeUInt32LE(buffer.length, at + 8)
    directory.writeUInt32LE(offset, at + 12)
    offset += buffer.length
  })

  return Buffer.concat([header, directory, ...images.map((i) => i.buffer)])
}

/** Renders the SVG at `size` and returns the PNG bytes. */
async function render(win, svg, size) {
  const sized = svg
    .replace(/width="\d+"/, `width="${size}"`)
    .replace(/height="\d+"/, `height="${size}"`)
  const dataUrl = `data:image/svg+xml;base64,${Buffer.from(sized).toString('base64')}`

  const result = await win.webContents.executeJavaScript(`
    (async () => {
      const img = new Image()
      img.src = ${JSON.stringify(dataUrl)}
      await img.decode()
      const canvas = document.createElement('canvas')
      canvas.width = ${size}
      canvas.height = ${size}
      const ctx = canvas.getContext('2d')
      ctx.drawImage(img, 0, 0, ${size}, ${size})
      return canvas.toDataURL('image/png')
    })()
  `)

  return Buffer.from(result.replace(/^data:image\/png;base64,/, ''), 'base64')
}

// Keep the render out of the real app's userData, which this script has no
// business touching.
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'icon-build-')))

app.whenReady().then(async () => {
  const svg = fs.readFileSync(SVG, 'utf8')
  const win = new BrowserWindow({ show: false, width: 300, height: 300 })
  await win.loadURL('data:text/html,<body></body>')

  const images = []
  for (const size of ICO_SIZES) {
    images.push({ size, buffer: await render(win, svg, size) })
  }

  fs.writeFileSync(ICO, buildIco(images))
  fs.writeFileSync(PNG, await render(win, svg, 512))

  // Vector for browsers that take an SVG favicon; the .ico is the automatic
  // /favicon.ico fallback for those that don't, so the page needs no extra tag.
  fs.writeFileSync(SITE_SVG, svg)
  fs.copyFileSync(ICO, SITE_ICO)

  // og:image. The 512px square is what the page advertises, so its dimensions
  // are hardcoded in the og:image:width/height tags — change one, change both.
  fs.copyFileSync(PNG, SITE_OG)

  console.log(`icon.ico  ${ICO_SIZES.join(', ')}px  (${fs.statSync(ICO).size} bytes)`)
  console.log(`icon.png  512px            (${fs.statSync(PNG).size} bytes)`)
  console.log(`site/public/favicon.svg + favicon.ico + og-image.png`)

  win.destroy()
  app.quit()
})
