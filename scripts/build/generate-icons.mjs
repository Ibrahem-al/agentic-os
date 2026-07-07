/**
 * Agentic OS icon generator — "The Recall Constellation".
 *
 * Pure-Node (node:zlib / node:fs / node:path / Buffer only — NO deps) rasterizer
 * that draws the logo's primitive stack with 4x4 supersampled anti-aliasing,
 * encodes PNG via zlib, and assembles a multi-size ICO (PNG-compressed entries
 * incl. a 256 whose width/height byte is 0), an ICNS (PNG OSType chunks), the
 * individual PNG set, the runtime window icon, the SVG source of truth, and the
 * renderer favicon. Deterministic (fixed math + zlib level 9) and re-runnable.
 *
 * Palette (exact oklch -> sRGB via oklab; conversion already done, hardcoded):
 *   --color-accent      oklch(0.68 0.14 268) = #7393EE  (hero + medium node, glow)
 *   --color-accent-ink  oklch(0.97 0.01 268) = #F2F5FC  (small node + hero nucleus)
 *   --color-bg          oklch(0.145 0 0)     = #0A0A0A  (anchors the tile dark end)
 * Designed tile/rim/edge values (stated as designed, anchored to those tokens):
 *   tile gradient  #26262F -> #0E0E13  (bg lifted/tinted toward the accent hue)
 *   hairline rim   #303039              (~--color-line-strong flattened on tile)
 *   edge strokes   #6273D6              (accent darkened ~18% for node-over-edge)
 *
 * Run: npm run icons
 */
import { Buffer } from 'node:buffer'
import console from 'node:console'
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import process from 'node:process'
import { deflateSync } from 'node:zlib'
import { fileURLToPath, URL } from 'node:url'

const repoRoot = fileURLToPath(new URL('../..', import.meta.url))

// ---------------------------------------------------------------------------
// SPEC — the primitive stack (draw order 1 = bottom). The SVG below and this
// list are the same image by construction: both are pure primitives.
// ---------------------------------------------------------------------------
const LOGO_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024" width="1024" height="1024">
  <defs>
    <linearGradient id="tile" x1="512" y1="10" x2="512" y2="1014" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="#26262F"/>
      <stop offset="1" stop-color="#0E0E13"/>
    </linearGradient>
    <radialGradient id="glow" cx="400" cy="640" r="360" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="#7393EE" stop-opacity="0.2"/>
      <stop offset="1" stop-color="#7393EE" stop-opacity="0"/>
    </radialGradient>
  </defs>
  <rect x="0" y="0" width="1024" height="1024" rx="224" fill="#303039"/>
  <rect x="10" y="10" width="1004" height="1004" rx="214" fill="url(#tile)"/>
  <circle cx="400" cy="640" r="360" fill="url(#glow)"/>
  <line x1="400" y1="640" x2="712" y2="344" stroke="#6273D6" stroke-width="100" stroke-linecap="round"/>
  <line x1="400" y1="640" x2="296" y2="300" stroke="#6273D6" stroke-width="100" stroke-linecap="round"/>
  <circle cx="296" cy="300" r="88" fill="#F2F5FC"/>
  <circle cx="712" cy="344" r="118" fill="#7393EE"/>
  <circle cx="400" cy="640" r="168" fill="#7393EE"/>
  <circle cx="400" cy="640" r="64" fill="#F2F5FC"/>
</svg>
`

/** #rrggbb -> [r,g,b] in 0..1 (sRGB / gamma space; no linear-light conversion). */
function hex(h) {
  const n = parseInt(h.slice(1), 16)
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255]
}

const RIM = hex('#303039')
const TILE_TOP = hex('#26262F')
const TILE_BOT = hex('#0E0E13')
const GLOW = hex('#7393EE')
const EDGE = hex('#6273D6')
const ACCENT = hex('#7393EE')
const INK = hex('#F2F5FC')

// Stroke width is a SPEC knob: bumped 84 -> 100 after the 16px visual review
// (the ~1.3px edges at 84 read too faint / disconnected on a low-DPI taskbar;
// 100 thickens the connective tissue without disturbing the node hierarchy).
const STROKE_W = 100
const STROKE_R = STROKE_W / 2

const clamp = (x, lo, hi) => (x < lo ? lo : x > hi ? hi : x)
const lerp = (a, b, t) => a + (b - a) * t

/** Signed distance to a rounded rect; <= 0 means inside. */
function insideRoundRect(px, py, x, y, w, h, r) {
  const cx = x + w / 2
  const cy = y + h / 2
  const dx = Math.abs(px - cx) - (w / 2 - r)
  const dy = Math.abs(py - cy) - (h / 2 - r)
  const ax = Math.max(dx, 0)
  const ay = Math.max(dy, 0)
  const outside = Math.hypot(ax, ay)
  const inside = Math.min(Math.max(dx, dy), 0)
  return outside + inside - r <= 0
}

/** Euclidean distance from (px,py) to segment A->B (round-cap capsule test). */
function distToSegment(px, py, ax, ay, bx, by) {
  const vx = bx - ax
  const vy = by - ay
  const wx = px - ax
  const wy = py - ay
  const c1 = vx * wx + vy * wy
  if (c1 <= 0) return Math.hypot(px - ax, py - ay)
  const c2 = vx * vx + vy * vy
  if (c2 <= c1) return Math.hypot(px - bx, py - by)
  const t = c1 / c2
  return Math.hypot(px - (ax + t * vx), py - (ay + t * vy))
}

/**
 * Source-over composite of straight-alpha src (sr,sg,sb,sa) onto acc (mutated),
 * done IN sRGB (gamma) space to match Chromium's SVG compositing so the raster
 * tile agrees with the favicon/TitleBar.
 */
function over(acc, sr, sg, sb, sa) {
  if (sa <= 0) return
  const da = acc[3]
  const na = sa + da * (1 - sa)
  if (na <= 0) {
    acc[0] = 0
    acc[1] = 0
    acc[2] = 0
    acc[3] = 0
    return
  }
  const w2 = da * (1 - sa)
  const inv = 1 / na
  acc[0] = (sr * sa + acc[0] * w2) * inv
  acc[1] = (sg * sa + acc[1] * w2) * inv
  acc[2] = (sb * sa + acc[2] * w2) * inv
  acc[3] = na
}

/** Evaluate the full primitive stack at design-space (dx,dy) into acc. */
function shade(dx, dy, acc) {
  // 1. rim
  if (insideRoundRect(dx, dy, 0, 0, 1024, 1024, 224)) over(acc, RIM[0], RIM[1], RIM[2], 1)
  // 2. tile (vertical linear gradient, sRGB lerp)
  if (insideRoundRect(dx, dy, 10, 10, 1004, 1004, 214)) {
    const t = clamp((dy - 10) / 1004, 0, 1)
    over(acc, lerp(TILE_TOP[0], TILE_BOT[0], t), lerp(TILE_TOP[1], TILE_BOT[1], t), lerp(TILE_TOP[2], TILE_BOT[2], t), 1)
  }
  // 3. glow (radial, alpha = 0.20 * (1 - dist/360), fades to 0 at rim)
  const dg = Math.hypot(dx - 400, dy - 640)
  if (dg < 360) over(acc, GLOW[0], GLOW[1], GLOW[2], 0.2 * (1 - dg / 360))
  // 4. edge1 capsule (hero -> medium node)
  if (distToSegment(dx, dy, 400, 640, 712, 344) <= STROKE_R) over(acc, EDGE[0], EDGE[1], EDGE[2], 1)
  // 5. edge2 capsule (hero -> small node)
  if (distToSegment(dx, dy, 400, 640, 296, 300) <= STROKE_R) over(acc, EDGE[0], EDGE[1], EDGE[2], 1)
  // 6. nodeC (small, near-white)
  if (Math.hypot(dx - 296, dy - 300) <= 88) over(acc, INK[0], INK[1], INK[2], 1)
  // 7. nodeB (medium, accent)
  if (Math.hypot(dx - 712, dy - 344) <= 118) over(acc, ACCENT[0], ACCENT[1], ACCENT[2], 1)
  // 8. nodeA (hero, accent)
  if (Math.hypot(dx - 400, dy - 640) <= 168) over(acc, ACCENT[0], ACCENT[1], ACCENT[2], 1)
  // 9. core (hero nucleus, near-white)
  if (Math.hypot(dx - 400, dy - 640) <= 64) over(acc, INK[0], INK[1], INK[2], 1)
}

const to8 = (x) => (x <= 0 ? 0 : x >= 1 ? 255 : Math.round(x * 255))

/** Render one size independently from the 1024 spec (never downscale a bitmap). */
function render(size) {
  const scale = 1024 / size
  const out = Buffer.alloc(size * size * 4)
  const acc = [0, 0, 0, 0]
  for (let oy = 0; oy < size; oy++) {
    for (let ox = 0; ox < size; ox++) {
      let pr = 0
      let pg = 0
      let pb = 0
      let pa = 0
      // 4x4 supersampling; accumulate in premultiplied space for the box average.
      for (let sj = 0; sj < 4; sj++) {
        const dy = (oy + (sj + 0.5) / 4) * scale
        for (let si = 0; si < 4; si++) {
          const dx = (ox + (si + 0.5) / 4) * scale
          acc[0] = 0
          acc[1] = 0
          acc[2] = 0
          acc[3] = 0
          shade(dx, dy, acc)
          pr += acc[0] * acc[3]
          pg += acc[1] * acc[3]
          pb += acc[2] * acc[3]
          pa += acc[3]
        }
      }
      const a = pa / 16
      let r = 0
      let g = 0
      let b = 0
      if (a > 0) {
        r = pr / 16 / a
        g = pg / 16 / a
        b = pb / 16 / a
      }
      const o = (oy * size + ox) * 4
      out[o] = to8(r)
      out[o + 1] = to8(g)
      out[o + 2] = to8(b)
      out[o + 3] = to8(a)
    }
  }
  return out
}

// ---------------------------------------------------------------------------
// PNG encoder (8-bit RGBA, filter 0, zlib level 9) + CRC32.
// ---------------------------------------------------------------------------
const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

function crc32(buf) {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function pngChunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length, 0)
  const typeBuf = Buffer.from(type, 'latin1')
  const body = Buffer.concat([typeBuf, data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body), 0)
  return Buffer.concat([len, body, crc])
}

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

function encodePng(size, rgba) {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // color type RGBA
  ihdr[10] = 0 // deflate
  ihdr[11] = 0 // no filter
  ihdr[12] = 0 // no interlace
  const stride = size * 4
  const raw = Buffer.alloc((stride + 1) * size)
  for (let y = 0; y < size; y++) {
    raw[y * (stride + 1)] = 0 // filter type 0 (None) per scanline
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride)
  }
  const idat = deflateSync(raw, { level: 9 })
  return Buffer.concat([PNG_SIG, pngChunk('IHDR', ihdr), pngChunk('IDAT', idat), pngChunk('IEND', Buffer.alloc(0))])
}

// ---------------------------------------------------------------------------
// ICO (Vista+ PNG-compressed entries; 256 entry width/height byte = 0).
// ---------------------------------------------------------------------------
function buildIco(entries) {
  const count = entries.length
  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0) // reserved
  header.writeUInt16LE(1, 2) // type = icon
  header.writeUInt16LE(count, 4)
  const dir = Buffer.alloc(16 * count)
  let offset = 6 + 16 * count
  entries.forEach((e, i) => {
    const b = 16 * i
    dir[b] = e.size >= 256 ? 0 : e.size // width byte (0 == 256)
    dir[b + 1] = e.size >= 256 ? 0 : e.size // height byte
    dir[b + 2] = 0 // color count
    dir[b + 3] = 0 // reserved
    dir.writeUInt16LE(1, b + 4) // planes
    dir.writeUInt16LE(32, b + 6) // bit count
    dir.writeUInt32LE(e.png.length, b + 8) // bytes in resource
    dir.writeUInt32LE(offset, b + 12) // offset
    offset += e.png.length
  })
  return Buffer.concat([header, dir, ...entries.map((e) => e.png)])
}

// ---------------------------------------------------------------------------
// ICNS (icns magic + total length + PNG OSType chunks).
// ---------------------------------------------------------------------------
function buildIcns(entries) {
  const chunks = entries.map((e) => {
    const head = Buffer.alloc(8)
    head.write(e.type, 0, 'latin1')
    head.writeUInt32BE(e.png.length + 8, 4)
    return Buffer.concat([head, e.png])
  })
  const body = Buffer.concat(chunks)
  const head = Buffer.alloc(8)
  head.write('icns', 0, 'latin1')
  head.writeUInt32BE(body.length + 8, 4)
  return Buffer.concat([head, body])
}

// ---------------------------------------------------------------------------
// Emit.
// ---------------------------------------------------------------------------
function write(relPath, data) {
  const abs = join(repoRoot, relPath)
  mkdirSync(dirname(abs), { recursive: true })
  writeFileSync(abs, data)
  return abs
}

const SIZES = [16, 24, 32, 48, 64, 128, 256, 512, 1024]
const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256]
const ICNS_MAP = [
  { type: 'ic11', size: 32 },
  { type: 'ic12', size: 64 },
  { type: 'ic07', size: 128 },
  { type: 'ic08', size: 256 },
  { type: 'ic09', size: 512 },
  { type: 'ic10', size: 1024 }
]

console.log('[icons] rendering constellation mark from the 1024 spec...')
const pngBySize = new Map()
for (const size of SIZES) {
  const png = encodePng(size, render(size))
  pngBySize.set(size, png)
  write(join('build', 'icons', `${size}.png`), png)
  console.log(`[icons]   build/icons/${size}.png (${png.length} bytes)`)
}

// SVG source of truth + renderer favicon (file, not data: URI — CSP blocks data:).
write(join('build', 'logo.svg'), LOGO_SVG)
write(join('src', 'renderer', 'public', 'favicon.svg'), LOGO_SVG)
// icon.png (512, linux + dev window icon) and runtime resources icon (256).
write(join('build', 'icon.png'), pngBySize.get(512))
write(join('resources', 'icon.png'), pngBySize.get(256))
// Multi-size ICO (win/NSIS) and ICNS (mac).
const icoPath = write(
  join('build', 'icon.ico'),
  buildIco(ICO_SIZES.map((size) => ({ size, png: pngBySize.get(size) })))
)
const icnsPath = write(
  join('build', 'icon.icns'),
  buildIcns(ICNS_MAP.map((m) => ({ type: m.type, png: pngBySize.get(m.size) })))
)
console.log('[icons] wrote build/logo.svg, src/renderer/public/favicon.svg, build/icon.png, resources/icon.png')
console.log('[icons] wrote build/icon.ico, build/icon.icns')

// ---------------------------------------------------------------------------
// Self-validation — re-read every artifact and assert structure; exit 1 on fail.
// ---------------------------------------------------------------------------
const failures = []
function check(cond, msg) {
  if (!cond) failures.push(msg)
}

function pngDims(buf) {
  if (buf.length < 24) return null
  const sigOk = buf.subarray(0, 8).equals(PNG_SIG)
  const ihdrOk = buf.subarray(12, 16).toString('latin1') === 'IHDR'
  if (!sigOk || !ihdrOk) return null
  return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) }
}

for (const size of SIZES) {
  const buf = readFileSync(join(repoRoot, 'build', 'icons', `${size}.png`))
  const dims = pngDims(buf)
  check(dims !== null, `build/icons/${size}.png is not a valid PNG (bad signature/IHDR)`)
  check(dims !== null && dims.w === size && dims.h === size, `build/icons/${size}.png IHDR dims != ${size}x${size}`)
}

// ICO structure.
{
  const ico = readFileSync(icoPath)
  check(ico.readUInt16LE(0) === 0, 'ICO reserved field != 0')
  check(ico.readUInt16LE(2) === 1, 'ICO type field != 1')
  const count = ico.readUInt16LE(4)
  check(count === ICO_SIZES.length, `ICO count ${count} != ${ICO_SIZES.length}`)
  let has256 = false
  for (let i = 0; i < count; i++) {
    const b = 6 + 16 * i
    const wByte = ico[b]
    const off = ico.readUInt32LE(b + 12)
    const len = ico.readUInt32LE(b + 8)
    check(off + len <= ico.length, `ICO entry ${i} payload runs past EOF`)
    check(ico.subarray(off, off + 8).equals(PNG_SIG), `ICO entry ${i} payload is not a PNG`)
    if (wByte === 0) {
      has256 = true
      const dims = pngDims(ico.subarray(off, off + len))
      check(dims !== null && dims.w === 256 && dims.h === 256, 'ICO 256 entry (width byte 0) payload is not 256x256')
    }
  }
  check(has256, 'ICO has no 256px entry (width byte 0) — electron-builder requires it')
}

// ICNS structure.
{
  const icns = readFileSync(icnsPath)
  check(icns.subarray(0, 4).toString('latin1') === 'icns', 'ICNS magic != "icns"')
  check(icns.readUInt32BE(4) === icns.length, `ICNS declared length ${icns.readUInt32BE(4)} != file length ${icns.length}`)
}

// SVG + runtime icon presence.
check(readFileSync(join(repoRoot, 'build', 'logo.svg'), 'utf8').includes('<svg'), 'build/logo.svg missing <svg')
check(
  readFileSync(join(repoRoot, 'src', 'renderer', 'public', 'favicon.svg'), 'utf8').includes('<svg'),
  'favicon.svg missing <svg'
)
check(pngDims(readFileSync(join(repoRoot, 'build', 'icon.png')))?.w === 512, 'build/icon.png is not 512px')
check(pngDims(readFileSync(join(repoRoot, 'resources', 'icon.png')))?.w === 256, 'resources/icon.png is not 256px')

if (failures.length > 0) {
  console.error('[icons] SELF-VALIDATION FAILED:')
  for (const f of failures) console.error(`  - ${f}`)
  process.exit(1)
}
console.log('[icons] self-validation passed — ICO(256 present)/ICNS/PNG all structurally valid.')
