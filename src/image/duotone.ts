import { makeCanvas } from '../core/canvas'

/**
 * 双色调 / 渐变映射（★ 2026-10-19）—— 「装饰」里的第六种模式。
 *
 * 把每个像素的亮度映射到「暗部颜色 → 亮部颜色」这条渐变上，再按强度和
 * 原图混合。它不是全局调色参数，而是一层写进当前底图的像素效果：
 * 和光效 / 边框一样走 base-edit 账本，可撤销，不碰调色参数、不进历史转盘。
 */
export type DuotonePreset = 'ink' | 'rose' | 'steel' | 'ember' | 'violet' | 'noir'

export type DuotoneOptions = {
  preset: DuotonePreset
  /** 暗部颜色，#rrggbb。 */
  shadow: string
  /** 亮部颜色，#rrggbb。 */
  highlight: string
  /** 0~100；0 = 一个字节都不动。 */
  intensity: number
}

export const DUOTONE_PRESETS: readonly {
  id: DuotonePreset
  label: string
  shadow: string
  highlight: string
}[] = [
  { id: 'ink', label: '墨青', shadow: '#0b1f2a', highlight: '#e8d7b8' },
  { id: 'rose', label: '玫瑰金', shadow: '#2a1020', highlight: '#ffd9b0' },
  { id: 'steel', label: '银蓝', shadow: '#0a1633', highlight: '#d9ecff' },
  { id: 'ember', label: '赤焰', shadow: '#1a0808', highlight: '#ffcf8a' },
  { id: 'violet', label: '紫夜', shadow: '#160b2e', highlight: '#f0c8ff' },
  { id: 'noir', label: '黑白', shadow: '#000000', highlight: '#ffffff' },
]

const INK = DUOTONE_PRESETS[0]!

export const DEFAULT_DUOTONE: DuotoneOptions = {
  preset: INK.id,
  shadow: INK.shadow,
  highlight: INK.highlight,
  intensity: 70,
}

const clamp = (value: number, lo: number, hi: number) =>
  Math.max(lo, Math.min(hi, value))

/** `#rgb` / `#rrggbb` → [r,g,b]；不合法返回 null。 */
export function parseHexColor(value: string): [number, number, number] | null {
  const text = value.trim()
  const short = /^#([0-9a-f]{3})$/i.exec(text)
  if (short) {
    const [r, g, b] = short[1]!.split('')
    return [
      Number.parseInt(`${r}${r}`, 16),
      Number.parseInt(`${g}${g}`, 16),
      Number.parseInt(`${b}${b}`, 16),
    ]
  }
  const long = /^#([0-9a-f]{6})$/i.exec(text)
  if (!long) return null
  return [
    Number.parseInt(long[1]!.slice(0, 2), 16),
    Number.parseInt(long[1]!.slice(2, 4), 16),
    Number.parseInt(long[1]!.slice(4, 6), 16),
  ]
}

/**
 * 纯函数：原地把 RGBA 像素映射成双色调。
 * 强度 0 / 颜色非法时返回 `{ changed: 0 }`，一个字节都不写。
 */
export function duotonePixels(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  options: DuotoneOptions,
): { changed: number } {
  if (data.length !== width * height * 4) {
    throw new Error(`像素尺寸和照片对不上（${data.length} 字节，照片 ${width}×${height}）`)
  }
  const amount = clamp(Number.isFinite(options.intensity) ? options.intensity : 0, 0, 100) / 100
  if (amount <= 0) return { changed: 0 }
  const shadow = parseHexColor(options.shadow)
  const highlight = parseHexColor(options.highlight)
  if (!shadow || !highlight) return { changed: 0 }

  let changed = 0
  for (let i = 0; i < data.length; i += 4) {
    const r = data[i]!
    const g = data[i + 1]!
    const b = data[i + 2]!
    const luma = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255
    // 轻微 S 曲线：暗部 / 亮部过渡更柔，中间调不会挤成一条硬边。
    const t = luma * luma * (3 - 2 * luma)
    const tr = shadow[0] + (highlight[0] - shadow[0]) * t
    const tg = shadow[1] + (highlight[1] - shadow[1]) * t
    const tb = shadow[2] + (highlight[2] - shadow[2]) * t
    const nr = Math.round(r + (tr - r) * amount)
    const ng = Math.round(g + (tg - g) * amount)
    const nb = Math.round(b + (tb - b) * amount)
    if (nr !== r || ng !== g || nb !== b) changed++
    data[i] = nr
    data[i + 1] = ng
    data[i + 2] = nb
    // alpha 不动
  }
  return { changed }
}

/** 把双色调落到一张新底图上。 */
export async function duotoneToBitmap(
  source: ImageBitmap,
  options: DuotoneOptions,
): Promise<ImageBitmap> {
  const { canvas, ctx } = makeCanvas(source.width, source.height, '双色调画不上去', {
    willReadFrequently: true,
  })
  ctx.drawImage(source, 0, 0)
  const image = ctx.getImageData(0, 0, source.width, source.height)
  duotonePixels(image.data, source.width, source.height, options)
  ctx.putImageData(image, 0, 0)
  return createImageBitmap(canvas)
}
