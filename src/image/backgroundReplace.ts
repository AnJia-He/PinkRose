import { makeCanvas } from '../core/canvas'
import { eraseAlphaPixels } from './transparency'
import { coverRect } from './doubleExposure'

export type BackgroundFill =
  | { kind: 'color'; color: string }
  | { kind: 'blur' }
  | { kind: 'image'; bitmap: ImageBitmap; transform: BackgroundTransform }
  | { kind: 'sky'; preset: SkyPreset; transform: BackgroundTransform }

/** 画布和位图都能作为合成源；换背景前后都走同一条 drawImage 路径。 */
export type BackgroundSource = ImageBitmap | HTMLCanvasElement

/**
 * 背景图 / 生成天空的取景变换。
 *
 * `scale` 是 1–1.8 倍；`x` / `y` 是 -1–1 的**相对可用余量**，不是画布百分比：
 * 1 倍时没有余量，所以移动为 0；1.2 倍时最多各移动 0.1 个画布宽高。
 * 这样滑杆不会把背景拖出画面留下空白，用户也不需要理解两套单位。
 */
export type BackgroundTransform = {
  scale: number
  x: number
  y: number
  flip: boolean
}

export const DEFAULT_BACKGROUND_TRANSFORM: BackgroundTransform = Object.freeze({
  scale: 1, x: 0, y: 0, flip: false,
})

export function normalizeBackgroundTransform(
  input: Partial<BackgroundTransform> = {},
): BackgroundTransform {
  const rawScale = Number.isFinite(input.scale) ? input.scale! : 1
  const scale = Math.max(1, Math.min(1.8, rawScale))
  const limit = (scale - 1) / 2
  const axis = (value: number | undefined) => {
    const n = Number.isFinite(value) ? value! : 0
    return Math.max(-1, Math.min(1, n)) * limit
  }
  return { scale, x: axis(input.x), y: axis(input.y), flip: !!input.flip }
}

export type BackgroundKind =
  | 'transparent' | 'white' | 'blue' | 'gray' | 'blur' | 'color' | 'image'
  | 'sky-blue' | 'sky-sunset' | 'sky-dusk'

export type SkyPreset = 'blue' | 'sunset' | 'dusk'

export const BACKGROUND_COLORS: Record<'white' | 'blue' | 'gray', string> = {
  white: '#ffffff',
  blue: '#438edb',
  gray: '#e7e2dc',
}

/** 界面只选一种「背景」，这里翻成像素层认的合成参数；透明返回 null。 */
export function resolveBackgroundFill(
  kind: BackgroundKind, color: string, bitmap: ImageBitmap | null,
  transform: Partial<BackgroundTransform> = {},
): BackgroundFill | null {
  if (kind === 'white' || kind === 'blue' || kind === 'gray') {
    return { kind: 'color', color: BACKGROUND_COLORS[kind] }
  }
  if (kind === 'color') return { kind: 'color', color }
  if (kind === 'blur') return { kind: 'blur' }
  if (kind === 'image') {
    return bitmap
      ? { kind: 'image', bitmap, transform: normalizeBackgroundTransform(transform) }
      : null
  }
  if (kind === 'sky-blue') {
    return { kind: 'sky', preset: 'blue', transform: normalizeBackgroundTransform(transform) }
  }
  if (kind === 'sky-sunset') {
    return { kind: 'sky', preset: 'sunset', transform: normalizeBackgroundTransform(transform) }
  }
  if (kind === 'sky-dusk') {
    return { kind: 'sky', preset: 'dusk', transform: normalizeBackgroundTransform(transform) }
  }
  return null
}

const COLOR_RE = /^#[0-9a-f]{6}$/i

/**
 * 本地生成天空：三段渐变 + 柔光太阳 + 软云 / 星点。尺寸跟底图一致，
 * 不依赖外部图片；人物边缘仍由掩码负责。
 */
export function paintSky(
  ctx: CanvasRenderingContext2D, w: number, h: number, preset: SkyPreset,
  transform: Partial<BackgroundTransform> = {},
): void {
  const t = normalizeBackgroundTransform(transform)
  ctx.save()
  ctx.translate(w / 2 + t.x * w, h / 2 + t.y * h)
  ctx.scale(t.scale, t.scale)
  if (t.flip) ctx.scale(-1, 1)
  ctx.translate(-w / 2, -h / 2)
  paintSkyRaw(ctx, w, h, preset)
  ctx.restore()
}

function paintSkyRaw(
  ctx: CanvasRenderingContext2D, w: number, h: number, preset: SkyPreset,
): void {
  const stops = preset === 'blue'
    ? [[0, '#2d7fd3'], [0.58, '#8fc6ec'], [1, '#f2eee4']]
    : preset === 'sunset'
      ? [[0, '#4b3a70'], [0.5, '#e87963'], [0.72, '#ffb46f'], [1, '#ffe0ad']]
      : [[0, '#18213f'], [0.55, '#514675'], [0.82, '#b26f77'], [1, '#e0a07e']]
  const sky = ctx.createLinearGradient(0, 0, 0, h)
  for (const [at, color] of stops) sky.addColorStop(at as number, color as string)
  ctx.fillStyle = sky
  ctx.fillRect(0, 0, w, h)

  const short = Math.min(w, h)
  const sunX = preset === 'sunset' ? w * 0.64 : w * 0.73
  const sunY = preset === 'sunset' ? h * 0.58 : preset === 'dusk' ? h * 0.66 : h * 0.22
  const sun = ctx.createRadialGradient(sunX, sunY, 0, sunX, sunY, short * 0.42)
  sun.addColorStop(0, preset === 'dusk' ? 'rgba(255,220,180,.55)' : 'rgba(255,246,205,.9)')
  sun.addColorStop(0.25, preset === 'sunset' ? 'rgba(255,185,110,.35)' : 'rgba(255,240,190,.22)')
  sun.addColorStop(1, 'rgba(255,240,190,0)')
  ctx.fillStyle = sun
  ctx.fillRect(0, 0, w, h)

  if (preset === 'dusk') {
    ctx.fillStyle = 'rgba(255,255,255,.78)'
    const stars = [
      [0.12, 0.12, 1.2], [0.24, 0.08, 1], [0.36, 0.18, 1.6],
      [0.48, 0.06, 1], [0.58, 0.14, 1.2], [0.83, 0.1, 1.4],
      [0.9, 0.22, 1], [0.16, 0.28, 1.1], [0.72, 0.25, 1],
    ]
    for (const [nx, ny, r] of stars) {
      ctx.beginPath()
      ctx.arc(nx! * w, ny! * h, r!, 0, Math.PI * 2)
      ctx.fill()
    }
  } else {
    const clouds = preset === 'blue'
      ? [[0.2, 0.3, 0.22, 0.08], [0.62, 0.18, 0.18, 0.06], [0.8, 0.42, 0.2, 0.07]]
      : [[0.18, 0.42, 0.2, 0.07], [0.72, 0.32, 0.22, 0.08]]
    for (const [nx, ny, rx, ry] of clouds) {
      const cx = nx! * w
      const cy = ny! * h
      const gx = ctx.createRadialGradient(cx, cy, 0, cx, cy, rx! * w)
      gx.addColorStop(0, preset === 'sunset' ? 'rgba(255,215,205,.4)' : 'rgba(255,255,255,.48)')
      gx.addColorStop(0.55, preset === 'sunset' ? 'rgba(255,190,180,.16)' : 'rgba(255,255,255,.18)')
      gx.addColorStop(1, 'rgba(255,255,255,0)')
      ctx.save()
      ctx.translate(cx, cy)
      ctx.scale(1, ry! / rx!)
      ctx.translate(-cx, -cy)
      ctx.fillStyle = gx
      ctx.fillRect(cx - rx! * w, cy - rx! * w, rx! * w * 2, rx! * w * 2)
      ctx.restore()
    }
  }
}

/**
 * 按背景掩码把主体抠出来，放进新的背景里。
 *
 * 掩码 `255` = 去掉的背景；主体边缘先按覆盖率压 alpha，再盖到新背景上，
 * 所以软边不会变成一圈硬黑边。输出与 `transparentToBitmap` 一样是新底图。
 */
export async function replaceBackgroundToBitmap(
  source: BackgroundSource, mask: Uint8Array, fill: BackgroundFill,
): Promise<{ bitmap: ImageBitmap; covered: number }> {
  const w = source.width
  const h = source.height
  if (mask.length !== w * h) {
    throw new Error(`掩码尺寸和照片对不上（掩码 ${mask.length} 字节，照片 ${w}×${h}）`)
  }

  const fg = makeCanvas(w, h, '扣不出主体', { willReadFrequently: true })
  fg.ctx.drawImage(source, 0, 0)
  const image = fg.ctx.getImageData(0, 0, w, h)
  const { covered } = eraseAlphaPixels(image.data, w, h, mask)
  if (covered > 0) fg.ctx.putImageData(image, 0, 0)

  const out = makeCanvas(w, h, '换不了背景')
  if (fill.kind === 'color') {
    out.ctx.fillStyle = COLOR_RE.test(fill.color) ? fill.color : '#ffffff'
    out.ctx.fillRect(0, 0, w, h)
  } else if (fill.kind === 'blur') {
    // 稍微放大一点再糊，避免模糊把画布四边拖成透明。
    const grow = 1.04
    const dw = w * grow
    const dh = h * grow
    out.ctx.save()
    out.ctx.filter = `blur(${Math.max(8, Math.round(Math.min(w, h) * 0.025))}px)`
    out.ctx.drawImage(source, (w - dw) / 2, (h - dh) / 2, dw, dh)
    out.ctx.restore()
  } else if (fill.kind === 'sky') {
    paintSky(out.ctx, w, h, fill.preset, fill.transform)
  } else {
    const t = fill.transform ?? DEFAULT_BACKGROUND_TRANSFORM
    out.ctx.save()
    out.ctx.translate(w / 2 + t.x * w, h / 2 + t.y * h)
    out.ctx.scale(t.scale, t.scale)
    if (t.flip) out.ctx.scale(-1, 1)
    out.ctx.translate(-w / 2, -h / 2)
    const r = coverRect(fill.bitmap.width, fill.bitmap.height, w, h)
    out.ctx.drawImage(fill.bitmap, r.x, r.y, r.width, r.height)
    out.ctx.restore()
  }
  out.ctx.drawImage(fg.canvas, 0, 0)
  const bitmap = await createImageBitmap(out.canvas, { premultiplyAlpha: 'none' })
  return { bitmap, covered }
}
