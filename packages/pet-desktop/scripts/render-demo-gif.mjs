#!/usr/bin/env node
// Renders packages/pet/assets/demo.gif from the built-in sprite sheets.
// Pure-JS pipeline (no native deps): PNG decode via node:zlib -> 2x box
// downscale (256px -> 128px per frame) -> global median-cut palette
// (slot 0 = transparent) -> GIF89a with per-frame delays from manifest.json.
//
// Re-run with: bun packages/pet-desktop/scripts/render-demo-gif.mjs

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { inflateSync } from 'node:zlib'

const here = dirname(fileURLToPath(import.meta.url))
const spritesDir = join(here, '..', 'assets', 'sprites')
const outFile = join(here, '..', '..', 'pet', 'assets', 'demo.gif')

// How many 256px frames each story beat contributes (short loops repeat).
const STORY = [
  ['idle', 3], // 3 * 1100ms = 3.3s
  ['thinking', 6], // 1 loop    = 0.9s
  ['working', 10], // ~1.7 loops = 1.2s
  ['celebrating', 7], // 1.4 loops = 1.0s
  ['pet', 8], // 2 loops    = 1.1s
]
const PET = 'deepseek-chan'

// ---------- PNG decode (8-bit RGBA, non-interlaced) ----------

function decodePng(buf) {
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
  for (let i = 0; i < 8; i++) {
    if (buf[i] !== sig[i]) throw new Error('not a PNG')
  }
  let pos = 8
  let width = 0
  let height = 0
  const idat = []
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos)
    const type = buf.toString('ascii', pos + 4, pos + 8)
    const data = buf.subarray(pos + 8, pos + 8 + len)
    if (type === 'IHDR') {
      width = data.readUInt32BE(0)
      height = data.readUInt32BE(4)
      const bitDepth = data[8]
      const colorType = data[9]
      const interlace = data[12]
      if (bitDepth !== 8 || colorType !== 6 || interlace !== 0) {
        throw new Error(
          `unsupported PNG: bitDepth=${bitDepth} colorType=${colorType} interlace=${interlace}`,
        )
      }
    } else if (type === 'IDAT') {
      idat.push(data)
    } else if (type === 'IEND') {
      break
    }
    pos += 12 + len
  }
  const raw = inflateSync(Buffer.concat(idat))
  const bpp = 4
  const stride = width * bpp
  const out = Buffer.alloc(width * height * bpp)
  let prev = Buffer.alloc(stride)
  let src = 0
  for (let y = 0; y < height; y++) {
    const filter = raw[src++]
    const line = raw.subarray(src, src + stride)
    src += stride
    const cur = out.subarray(y * stride, (y + 1) * stride)
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? cur[x - bpp] : 0
      const b = prev[x]
      const c = x >= bpp ? prev[x - bpp] : 0
      let v = line[x]
      switch (filter) {
        case 0:
          break
        case 1:
          v = (v + a) & 0xff
          break
        case 2:
          v = (v + b) & 0xff
          break
        case 3:
          v = (v + ((a + b) >> 1)) & 0xff
          break
        case 4: {
          const p = a + b - c
          const pa = Math.abs(p - a)
          const pb = Math.abs(p - b)
          const pc = Math.abs(p - c)
          v = (v + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 0xff
          break
        }
        default:
          throw new Error(`unknown PNG filter ${filter}`)
      }
      cur[x] = v
    }
    prev = cur
  }
  return { width, height, data: out }
}

// ---------- sprite slicing + 2x box downscale ----------

// Returns frames as {r,g,b,a} arrays of 128x128 pixels.
function loadMoodFrames(file, frameCount) {
  const png = decodePng(readFileSync(join(spritesDir, file)))
  const physFrame = 256
  if (png.height !== physFrame || png.width !== physFrame * frameCount) {
    throw new Error(
      `${file}: expected ${physFrame * frameCount}x${physFrame}, got ${png.width}x${png.height}`,
    )
  }
  const frames = []
  for (let f = 0; f < frameCount; f++) {
    const pixels = Array.from({ length: 128 * 128 })
    for (let y = 0; y < 128; y++) {
      for (let x = 0; x < 128; x++) {
        let r = 0
        let g = 0
        let b = 0
        let a = 0
        for (let dy = 0; dy < 2; dy++) {
          for (let dx = 0; dx < 2; dx++) {
            const i = ((y * 2 + dy) * png.width + f * physFrame + x * 2 + dx) * 4
            r += png.data[i]
            g += png.data[i + 1]
            b += png.data[i + 2]
            a += png.data[i + 3]
          }
        }
        pixels[y * 128 + x] = {
          r: r >> 2,
          g: g >> 2,
          b: b >> 2,
          a: a >> 2,
        }
      }
    }
    frames.push(pixels)
  }
  return frames
}

// ---------- median-cut quantization (255 colors + transparent slot 0) ----------

function buildPalette(allFrames) {
  const hist = new Map()
  for (const pixels of allFrames) {
    for (const p of pixels) {
      if (p.a < 128) continue
      const key = (p.r << 16) | (p.g << 8) | p.b
      hist.set(key, (hist.get(key) || 0) + 1)
    }
  }
  const colors = [...hist].map(([key, count]) => ({
    r: key >> 16,
    g: (key >> 8) & 0xff,
    b: key & 0xff,
    count,
  }))
  let boxes = [colors]
  while (boxes.length < 255) {
    let bi = -1
    let best = -1
    for (let i = 0; i < boxes.length; i++) {
      if (boxes[i].length < 2) continue
      let total = 0
      for (const c of boxes[i]) total += c.count
      if (total > best) {
        best = total
        bi = i
      }
    }
    if (bi < 0) break
    const box = boxes[bi]
    let ranges = [0, 0, 0]
    for (const ch of ['r', 'g', 'b']) {
      let lo = 255
      let hi = 0
      for (const c of box) {
        if (c[ch] < lo) lo = c[ch]
        if (c[ch] > hi) hi = c[ch]
      }
      ranges[ch === 'r' ? 0 : ch === 'g' ? 1 : 2] = hi - lo
    }
    const ch = ['r', 'g', 'b'][ranges.indexOf(Math.max(...ranges))]
    box.sort((p, q) => p[ch] - q[ch])
    let total = 0
    for (const c of box) total += c.count
    let acc = 0
    let cut = 0
    while (cut < box.length - 1 && acc < total / 2) acc += box[cut++].count
    boxes.splice(bi, 1, box.slice(0, cut), box.slice(cut))
  }
  const palette = [[0, 0, 0]] // slot 0 = transparent
  const map = new Map()
  for (const box of boxes) {
    let r = 0
    let g = 0
    let b = 0
    let n = 0
    for (const c of box) {
      r += c.r * c.count
      g += c.g * c.count
      b += c.b * c.count
      n += c.count
    }
    const idx = palette.length
    palette.push([Math.round(r / n), Math.round(g / n), Math.round(b / n)])
    for (const c of box) map.set((c.r << 16) | (c.g << 8) | c.b, idx)
  }
  while (palette.length < 256) palette.push([0, 0, 0])
  return { palette, map }
}

function indexFrame(pixels, map) {
  const out = new Uint8Array(pixels.length)
  for (let i = 0; i < pixels.length; i++) {
    const p = pixels[i]
    out[i] = p.a >= 128 ? map.get((p.r << 16) | (p.g << 8) | p.b) : 0
  }
  return out
}

// ---------- GIF89a encoder ----------

function lzwEncode(indices, minCodeSize) {
  const clearCode = 1 << minCodeSize
  const eoiCode = clearCode + 1
  const bytes = []
  let bitBuf = 0
  let bitCount = 0
  let codeSize = minCodeSize + 1
  let nextCode = eoiCode + 1
  let dict = new Map()
  const emit = (code) => {
    bitBuf |= code << bitCount
    bitCount += codeSize
    while (bitCount >= 8) {
      bytes.push(bitBuf & 0xff)
      bitBuf >>= 8
      bitCount -= 8
    }
  }
  const reset = () => {
    dict = new Map()
    nextCode = eoiCode + 1
    codeSize = minCodeSize + 1
  }
  emit(clearCode)
  let prefix = indices[0]
  for (let i = 1; i < indices.length; i++) {
    const k = indices[i]
    const key = prefix * 258 + k
    const existing = dict.get(key)
    if (existing !== undefined) {
      prefix = existing
    } else {
      emit(prefix)
      if (nextCode === 4096) {
        emit(clearCode)
        reset()
      } else {
        dict.set(key, nextCode++)
        // GIF defers the width bump by one table slot: the decoder lags the
        // encoder's dictionary by one entry, so grow at 2^codeSize + 1.
        if (nextCode === (1 << codeSize) + 1) codeSize++
      }
      prefix = k
    }
  }
  emit(prefix)
  emit(eoiCode)
  if (bitCount > 0) bytes.push(bitBuf & 0xff)
  return Buffer.from(bytes)
}

function encodeGif(width, height, palette, frames, delaysCs) {
  const parts = []
  parts.push(Buffer.from('GIF89a', 'ascii'))
  const lsd = Buffer.alloc(7)
  lsd.writeUInt16LE(width, 0)
  lsd.writeUInt16LE(height, 2)
  lsd[4] = 0xf7 // global palette, 8-bit color resolution, 256 entries
  lsd[5] = 0
  lsd[6] = 0
  parts.push(lsd)
  const gct = Buffer.alloc(256 * 3)
  palette.forEach(([r, g, b], i) => {
    gct[i * 3] = r
    gct[i * 3 + 1] = g
    gct[i * 3 + 2] = b
  })
  parts.push(gct)
  // NETSCAPE looping extension: loop forever
  parts.push(
    Buffer.from([
      0x21,
      0xff,
      0x0b,
      ...Buffer.from('NETSCAPE2.0', 'ascii'),
      0x03,
      0x01,
      0x00,
      0x00,
      0x00,
    ]),
  )
  for (let f = 0; f < frames.length; f++) {
    const gce = Buffer.alloc(8)
    gce[0] = 0x21
    gce[1] = 0xf9
    gce[2] = 0x04
    gce[3] = 0x09 // disposal 2 (restore to background) + transparency flag
    gce.writeUInt16LE(delaysCs[f], 4)
    gce[6] = 0 // transparent index = palette slot 0
    gce[7] = 0x00
    parts.push(gce)
    const img = Buffer.alloc(10)
    img[0] = 0x2c
    img.writeUInt16LE(0, 1)
    img.writeUInt16LE(0, 3)
    img.writeUInt16LE(width, 5)
    img.writeUInt16LE(height, 7)
    img[9] = 0x00 // no local palette
    parts.push(img)
    const data = lzwEncode(frames[f], 8)
    parts.push(Buffer.from([0x08])) // LZW min code size
    for (let off = 0; off < data.length; off += 255) {
      const chunk = data.subarray(off, off + 255)
      parts.push(Buffer.from([chunk.length]), chunk)
    }
    parts.push(Buffer.from([0x00]))
  }
  parts.push(Buffer.from([0x3b]))
  return Buffer.concat(parts)
}

// ---------- assemble the story ----------

const manifest = JSON.parse(readFileSync(join(spritesDir, 'manifest.json'), 'utf8'))
const moods = manifest.pets[PET].moods

const allFrames = []
const frameDelays = []
for (const [mood, count] of STORY) {
  const spec = moods[mood]
  const sheet = loadMoodFrames(spec.file, spec.frames)
  for (let i = 0; i < count; i++) {
    allFrames.push(sheet[i % spec.frames])
    frameDelays.push(Math.max(2, Math.round(spec.frameDurationMs / 10)))
  }
}

const { palette, map } = buildPalette(allFrames)
const indexed = allFrames.map((f) => indexFrame(f, map))
const gif = encodeGif(128, 128, palette, indexed, frameDelays)
mkdirSync(dirname(outFile), { recursive: true })
writeFileSync(outFile, gif)

const totalMs = frameDelays.reduce((s, d) => s + d * 10, 0)
console.log(
  `wrote ${outFile}: ${indexed.length} frames, ${(totalMs / 1000).toFixed(2)}s loop, ${(gif.length / 1024).toFixed(1)} KiB, palette ${palette.length} colors`,
)
