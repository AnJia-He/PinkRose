import { makeCanvas } from '../core/canvas'

/**
 * 光效（★ 2026-10-18）—— 「装饰」里的第五种模式。
 *
 * 四种程序化光效：逆光、漏光、光斑、霓虹。全部用 Canvas 渐变 + screen
 * 混合画在当前底图上，不依赖外部素材，也不调用模型。
 */
export type LightPreset = 'sun' | 'leak' | 'bokeh' | 'neon' | 'relight'

export type LightOptions = {
  preset: LightPreset
  /** 0~100；0 = 一个字节都不动。 */
  intensity: number
  /** 方向光：光源方向，0 = 上方、90 = 右侧、180 = 下方、270 = 左侧。 */
  angle?: number
  /** 方向光：-100 冷、0 中性、100 暖。 */
  warmth?: number
}

export const LIGHT_PRESETS: readonly { id: LightPreset; label: string }[] = [
  { id: 'sun', label: '逆光' },
  { id: 'leak', label: '漏光' },
  { id: 'bokeh', label: '光斑' },
  { id: 'neon', label: '霓虹' },
  { id: 'relight', label: '方向光' },
]

export const DEFAULT_LIGHT: LightOptions = {
  preset: 'sun', intensity: 60, angle: 315, warmth: 0,
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v))
const unit = (seed: number) => {
  let x = seed >>> 0
  x = (x ^ (x >>> 16)) >>> 0
  x = Math.imul(x, 0x7feb352d) >>> 0
  x = (x ^ (x >>> 15)) >>> 0
  x = Math.imul(x, 0x846ca68b) >>> 0
  return ((x ^ (x >>> 16)) >>> 0) / 4294967296
}

function warm(a: number): string {
  return `rgba(255,214,150,${clamp(a, 0, 1)})`
}

export function drawLight(
  ctx: CanvasRenderingContext2D, width: number, height: number,
  options: LightOptions,
): void {
  const amount = clamp(Number.isFinite(options.intensity) ? options.intensity : 0, 0, 100) / 100
  if (amount <= 0) return
  const w = Math.max(1, width)
  const h = Math.max(1, height)
  ctx.save()
  ctx.globalCompositeOperation = 'screen'

  if (options.preset === 'sun') {
    const cx = w * 0.18
    const cy = h * 0.12
    const r = Math.max(w, h) * 0.55
    const glow = ctx.createRadialGradient(cx, cy, 0, cx, cy, r)
    glow.addColorStop(0, warm(0.62 * amount))
    glow.addColorStop(0.18, warm(0.28 * amount))
    glow.addColorStop(1, warm(0))
    ctx.fillStyle = glow
    ctx.fillRect(0, 0, w, h)
    ctx.translate(cx, cy)
    for (let i = 0; i < 7; i++) {
      const ang = -0.55 + i * 0.18
      const len = Math.max(w, h) * (0.55 + unit(i + 7) * 0.25)
      const ray = ctx.createLinearGradient(0, 0, len, 0)
      ray.addColorStop(0, warm(0.10 * amount))
      ray.addColorStop(1, warm(0))
      ctx.save()
      ctx.rotate(ang)
      ctx.fillStyle = ray
      ctx.fillRect(0, -Math.max(1, h * 0.004), len, Math.max(2, h * 0.008))
      ctx.restore()
    }
  } else if (options.preset === 'leak') {
    const leak = ctx.createLinearGradient(0, 0, w, h)
    leak.addColorStop(0, `rgba(255,92,48,${0.48 * amount})`)
    leak.addColorStop(0.32, `rgba(255,64,140,${0.22 * amount})`)
    leak.addColorStop(0.62, 'rgba(255,64,140,0)')
    leak.addColorStop(1, `rgba(255,190,80,${0.34 * amount})`)
    ctx.fillStyle = leak
    ctx.fillRect(0, 0, w, h)
    const corner = ctx.createRadialGradient(w, h, 0, w, h, Math.max(w, h) * 0.65)
    corner.addColorStop(0, `rgba(255,220,120,${0.38 * amount})`)
    corner.addColorStop(1, 'rgba(255,220,120,0)')
    ctx.fillStyle = corner
    ctx.fillRect(0, 0, w, h)
  } else if (options.preset === 'bokeh') {
    const rMax = Math.min(w, h) * 0.12
    for (let i = 0; i < 22; i++) {
      const x = unit(i * 3 + 1) * w
      const y = unit(i * 5 + 2) * h
      const r = rMax * (0.25 + unit(i * 7 + 3) * 0.75)
      const g = ctx.createRadialGradient(x, y, 0, x, y, r)
      g.addColorStop(0, warm(0.34 * amount))
      g.addColorStop(0.55, warm(0.18 * amount))
      g.addColorStop(1, warm(0))
      ctx.fillStyle = g
      ctx.beginPath()
      ctx.arc(x, y, r, 0, Math.PI * 2)
      ctx.fill()
    }
  } else if (options.preset === 'neon') {
    const left = ctx.createLinearGradient(0, 0, w * 0.42, 0)
    left.addColorStop(0, `rgba(40,210,255,${0.42 * amount})`)
    left.addColorStop(1, 'rgba(40,210,255,0)')
    ctx.fillStyle = left
    ctx.fillRect(0, 0, w, h)
    const right = ctx.createLinearGradient(w, 0, w * 0.58, 0)
    right.addColorStop(0, `rgba(255,60,190,${0.42 * amount})`)
    right.addColorStop(1, 'rgba(255,60,190,0)')
    ctx.fillStyle = right
    ctx.fillRect(0, 0, w, h)
    const bottom = ctx.createLinearGradient(0, h, 0, h * 0.65)
    bottom.addColorStop(0, `rgba(170,80,255,${0.30 * amount})`)
    bottom.addColorStop(1, 'rgba(170,80,255,0)')
    ctx.fillStyle = bottom
    ctx.fillRect(0, 0, w, h)
  } else {
    // 方向光：把一侧提亮、另一侧压暗，再按冷暖给高光轻微染色。
    // 不是「换背景」那一类重画，仍保留原图的明暗与纹理。
    const rawAngle = Number.isFinite(options.angle) ? options.angle! : 315
    const angle = clamp(rawAngle, 0, 360) * Math.PI / 180
    const warmth = clamp(Number.isFinite(options.warmth) ? options.warmth! : 0, -100, 100)
    const ux = Math.sin(angle)
    const uy = -Math.cos(angle)
    const hotX = w * (0.5 + ux * 0.42)
    const hotY = h * (0.5 + uy * 0.42)
    const farX = w * (0.5 - ux * 0.42)
    const farY = h * (0.5 - uy * 0.42)
    const radius = Math.max(w, h) * 0.92
    const t = (warmth + 100) / 200
    const lr = Math.round(170 + 85 * t)
    const lg = Math.round(205 + 35 * t)
    const lb = Math.round(255 - 85 * t)

    const light = ctx.createRadialGradient(hotX, hotY, 0, hotX, hotY, radius)
    light.addColorStop(0, `rgba(${lr},${lg},${lb},${0.36 * amount})`)
    light.addColorStop(0.48, `rgba(${lr},${lg},${lb},${0.13 * amount})`)
    light.addColorStop(1, `rgba(${lr},${lg},${lb},0)`)
    ctx.globalCompositeOperation = 'soft-light'
    ctx.fillStyle = light
    ctx.fillRect(0, 0, w, h)

    const shade = ctx.createRadialGradient(farX, farY, 0, farX, farY, radius)
    shade.addColorStop(0, `rgba(8,10,18,${0.20 * amount})`)
    shade.addColorStop(1, 'rgba(8,10,18,0)')
    ctx.globalCompositeOperation = 'multiply'
    ctx.fillStyle = shade
    ctx.fillRect(0, 0, w, h)
  }
  ctx.restore()
}

export async function lightToBitmap(
  source: ImageBitmap, options: LightOptions,
): Promise<ImageBitmap> {
  const { canvas, ctx } = makeCanvas(source.width, source.height, '光效画不上去')
  ctx.drawImage(source, 0, 0)
  drawLight(ctx, source.width, source.height, options)
  return createImageBitmap(canvas)
}
