import { makeCanvas } from '../core/canvas'
import { decodeImageFile } from '../image/decode'

/**
 * 纯前端 GIF 编码（★ 2026-10-19）。
 *
 * 为什么不是视频：Safari 的 WebKit 在部分环境没有 MediaRecorder / captureStream；
 * 照片动图用 Canvas + GIF 编码，苹果端、桌面端和 PWA 都能直接导出。
 *
 * 采用「全局调色板 + 中位切分」：
 *   · 所有帧共用一个 256 色表，文件不随帧数线性膨胀；
 *   · 每帧只存索引，LZW 压缩；
 *   · 不追求照片级无损，目标是社交分享、表情包和轻量预览。
 */

export type GifFit = 'cover' | 'contain'

export type GifOptions = {
  width: number
  height: number
  /** 每帧停留时间，毫秒；实际写入 GIF 时按 10ms 取整。 */
  delayMs: number
  /** 填满裁切 / 完整留白，默认 cover。 */
  fit?: GifFit
  /** 留白处的底色，默认白色。 */
  background?: string
  /** 循环播放，默认 true。 */
  loop?: boolean
}

export type GifSource = CanvasImageSource & { width: number; height: number }

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v))
const MAX_COLORS = 256
const SAMPLE_LIMIT = 24_000

type RGB = [number, number, number]

function push16(out: number[], value: number): void {
  out.push(value & 0xff, (value >> 8) & 0xff)
}

function fillPalette(palette: RGB[]): Uint8Array {
  const table = new Uint8Array(MAX_COLORS * 3)
  const fallback = palette[palette.length - 1] ?? [0, 0, 0]
  for (let i = 0; i < MAX_COLORS; i++) {
    const c = palette[i] ?? fallback
    table[i * 3] = c[0]
    table[i * 3 + 1] = c[1]
    table[i * 3 + 2] = c[2]
  }
  return table
}

/**
 * 中位切分：每轮找「最长边 × 样本数」最大的盒子，沿最长通道切一半。
 * 对照片来说比固定色立方保留更多肤色和天空渐变。
 */
export function medianCutPalette(samples: readonly RGB[], maxColors = MAX_COLORS): Uint8Array {
  const source = samples.length > 0 ? [...samples] : [[0, 0, 0] as RGB]
  const limit = clamp(Math.floor(maxColors), 2, MAX_COLORS)
  let boxes: RGB[][] = [source]
  while (boxes.length < limit) {
    let pick = -1
    let bestScore = -1
    let channel = 0
    for (let i = 0; i < boxes.length; i++) {
      const box = boxes[i]!
      if (box.length < 2) continue
      let rMin = 255, rMax = 0, gMin = 255, gMax = 0, bMin = 255, bMax = 0
      for (const c of box) {
        if (c[0] < rMin) rMin = c[0]
        if (c[0] > rMax) rMax = c[0]
        if (c[1] < gMin) gMin = c[1]
        if (c[1] > gMax) gMax = c[1]
        if (c[2] < bMin) bMin = c[2]
        if (c[2] > bMax) bMax = c[2]
      }
      const ranges = [rMax - rMin, gMax - gMin, bMax - bMin]
      const ch = ranges[0]! >= ranges[1]! && ranges[0]! >= ranges[2]!
        ? 0 : ranges[1]! >= ranges[2]! ? 1 : 2
      const score = ranges[ch]! * Math.sqrt(box.length)
      if (score > bestScore) {
        bestScore = score
        pick = i
        channel = ch
      }
    }
    if (pick < 0 || bestScore <= 0) break
    const box = boxes[pick]!
    box.sort((a, b) => a[channel as 0 | 1 | 2]! - b[channel as 0 | 1 | 2]!)
    const mid = Math.floor(box.length / 2)
    boxes.splice(pick, 1, box.slice(0, mid), box.slice(mid))
  }
  const palette: RGB[] = boxes.map(box => {
    let r = 0, g = 0, b = 0
    for (const c of box) { r += c[0]; g += c[1]; b += c[2] }
    const n = Math.max(1, box.length)
    return [Math.round(r / n), Math.round(g / n), Math.round(b / n)]
  })
  return fillPalette(palette)
}

function buildLookup(palette: Uint8Array): Uint8Array {
  const lookup = new Uint8Array(32 * 32 * 32)
  for (let key = 0; key < lookup.length; key++) {
    const r = ((key >> 10) & 31) * 8 + 4
    const g = ((key >> 5) & 31) * 8 + 4
    const b = (key & 31) * 8 + 4
    let best = 0
    let bestD = Infinity
    for (let i = 0; i < MAX_COLORS; i++) {
      const dr = r - palette[i * 3]!
      const dg = g - palette[i * 3 + 1]!
      const db = b - palette[i * 3 + 2]!
      const d = dr * dr + dg * dg + db * db
      if (d < bestD) { bestD = d; best = i }
    }
    lookup[key] = best
  }
  return lookup
}

function indexedFrame(data: Uint8ClampedArray, lookup: Uint8Array): Uint8Array {
  const out = new Uint8Array(data.length / 4)
  for (let i = 0, p = 0; i < data.length; i += 4, p++) {
    const key = ((data[i]! >> 3) << 10) | ((data[i + 1]! >> 3) << 5) | (data[i + 2]! >> 3)
    out[p] = lookup[key]!
  }
  return out
}

/** LZW 编码，输出带 255 字节子块和结束 0 的 GIF 图像数据。 */
export function lzwEncode(pixels: Uint8Array): Uint8Array {
  const clear = 256
  const end = 257
  let codeSize = 9
  let next = 258
  const dict = new Map<number, number>()
  const bytes: number[] = []
  let bitBuffer = 0
  let bitCount = 0
  const emit = (code: number) => {
    bitBuffer |= code << bitCount
    bitCount += codeSize
    while (bitCount >= 8) {
      bytes.push(bitBuffer & 0xff)
      bitBuffer >>>= 8
      bitCount -= 8
    }
  }
  emit(clear)
  let prefix = pixels[0] ?? 0
  for (let i = 1; i < pixels.length; i++) {
    const c = pixels[i]!
    const key = (prefix << 8) | c
    const hit = dict.get(key)
    if (hit !== undefined) {
      prefix = hit
      continue
    }
    emit(prefix)
    if (next < 4096) {
      dict.set(key, next++)
      // 编码器新增词条比解码器早一步：解码器要读到这一笔之后才把
      // 自己的 next 推到同一个值。所以码长要在 next 越过 2^codeSize
      // 之后再升，不能在相等时就升 —— 早一位会让后续所有位流错开。
      if (next === (1 << codeSize) + 1 && codeSize < 12) codeSize++
    } else {
      emit(clear)
      dict.clear()
      next = 258
      codeSize = 9
    }
    prefix = c
  }
  emit(prefix)
  emit(end)
  if (bitCount > 0) bytes.push(bitBuffer & 0xff)
  const out: number[] = []
  for (let i = 0; i < bytes.length; i += 255) {
    const n = Math.min(255, bytes.length - i)
    out.push(n, ...bytes.slice(i, i + n))
  }
  out.push(0)
  return Uint8Array.from(out)
}

/** 把索引帧装成 GIF89a；`palette` 必须正好 256 个 RGB。 */
export function encodeGifBytes(
  width: number,
  height: number,
  palette: Uint8Array,
  frames: readonly Uint8Array[],
  delayMs: number,
  loop = true,
): Uint8Array {
  if (frames.length === 0) throw new Error('照片动图至少要有一帧')
  if (palette.length !== MAX_COLORS * 3) throw new Error('GIF 调色板必须是 256 色')
  const out: number[] = []
  for (const ch of 'GIF89a') out.push(ch.charCodeAt(0))
  push16(out, width)
  push16(out, height)
  out.push(0xf7, 0, 0) // GCT，256 色
  for (let i = 0; i < palette.length; i++) out.push(palette[i]!)
  if (loop) {
    out.push(0x21, 0xff, 0x0b)
    for (const ch of 'NETSCAPE2.0') out.push(ch.charCodeAt(0))
    out.push(0x03, 0x01, 0x00, 0x00, 0x00)
  }
  const delay = Math.max(2, Math.round(delayMs / 10))
  for (const frame of frames) {
    if (frame.length !== width * height) throw new Error('GIF 帧尺寸和画面不一致')
    out.push(0x21, 0xf9, 0x04, 0x08, delay & 0xff, (delay >> 8) & 0xff, 0, 0)
    out.push(0x2c)
    push16(out, 0)
    push16(out, 0)
    push16(out, width)
    push16(out, height)
    out.push(0)
    out.push(8)
    const packed = lzwEncode(frame)
    for (let i = 0; i < packed.length; i++) out.push(packed[i]!)
  }
  out.push(0x3b)
  return Uint8Array.from(out)
}

function drawFrame(
  ctx: CanvasRenderingContext2D,
  source: GifSource,
  width: number,
  height: number,
  fit: GifFit,
): void {
  const sw = Math.max(1, source.width)
  const sh = Math.max(1, source.height)
  const scale = fit === 'cover'
    ? Math.max(width / sw, height / sh)
    : Math.min(width / sw, height / sh)
  const dw = sw * scale
  const dh = sh * scale
  ctx.drawImage(source, (width - dw) / 2, (height - dh) / 2, dw, dh)
}

/** 把已经解码的图片源合成成 GIF；调用方负责关闭 ImageBitmap。 */
export function encodeGif(
  sources: readonly GifSource[],
  options: GifOptions,
): Blob {
  if (sources.length === 0) throw new Error('先选几张照片')
  // 9:16 的 1080px 宽会算出 1920px 高；上限必须容得下它，
  // 否则宽高分别钳制会把画幅压扁。GIF 本身支持到 65535。
  const width = clamp(Math.round(options.width), 64, 2048)
  const height = clamp(Math.round(options.height), 64, 2048)
  const fit: GifFit = options.fit ?? 'cover'
  const { ctx } = makeCanvas(width, height, '照片动图画不出来')
  const samples: RGB[] = []
  const datas: Uint8ClampedArray[] = []
  for (const source of sources) {
    ctx.fillStyle = options.background ?? '#ffffff'
    ctx.fillRect(0, 0, width, height)
    drawFrame(ctx, source, width, height, fit)
    const data = ctx.getImageData(0, 0, width, height).data
    datas.push(data)
    const step = Math.max(1, Math.floor((width * height) / SAMPLE_LIMIT))
    for (let p = 0; p < width * height; p += step) {
      const i = p * 4
      samples.push([data[i]!, data[i + 1]!, data[i + 2]!])
    }
  }
  const palette = medianCutPalette(samples)
  const lookup = buildLookup(palette)
  const frames = datas.map(data => indexedFrame(data, lookup))
  const bytes = encodeGifBytes(
    width, height, palette, frames, options.delayMs, options.loop ?? true,
  )
  return new Blob([bytes.buffer as ArrayBuffer], { type: 'image/gif' })
}

/** 从文件/Blob 解码并生成 GIF；解码后的位图在本函数内释放。 */
export async function encodeGifFromBlobs(
  blobs: readonly Blob[], options: GifOptions,
): Promise<Blob> {
  const bitmaps: ImageBitmap[] = []
  try {
    for (const blob of blobs) bitmaps.push(await createImageBitmap(blob))
    return encodeGif(bitmaps, options)
  } finally {
    for (const bitmap of bitmaps) bitmap.close()
  }
}

/**
 * UI 入口：用和编辑器同一条解码链路（含 HEIC / TIFF 的 `<img>` 兜底、P3→sRGB），
 * 再交给 GIF 编码。解码位图在函数返回前释放。
 */
export async function encodeGifFromFiles(
  files: readonly File[], options: GifOptions,
): Promise<Blob> {
  const decoded: Awaited<ReturnType<typeof decodeImageFile>>[] = []
  try {
    for (const file of files) decoded.push(await decodeImageFile(file))
    return encodeGif(decoded.map(item => item.bitmap), options)
  } finally {
    for (const item of decoded) item.bitmap.close()
  }
}
