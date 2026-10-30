import type { FaceBox } from '../core/faceDetect'
import { makeCanvas } from '../core/canvas'

/**
 * 人像美妆：按本地正脸框估计嘴唇和两颊，只给这些区域上色。
 *
 * 和磨皮 / 人像塑形同一条：纯像素函数 + `baseEdit` 落地，不写全局参数、
 * 不调用模型。0 = 一个字节都不动；嘴唇用颜色门避开牙齿，腮红用肤色门
 * 避开头发 / 眼睛 / 背景。
 */
export type LipShadeId = 'coral' | 'rose' | 'berry'

export const LIP_SHADES = [
  { id: 'coral', label: '珊瑚', rgb: [232, 96, 88] },
  { id: 'rose', label: '玫瑰', rgb: [190, 64, 92] },
  { id: 'berry', label: '莓果', rgb: [140, 48, 84] },
] as const satisfies readonly { id: LipShadeId; label: string; rgb: readonly [number, number, number] }[]

const BLUSH_RGB = [236, 150, 150] as const

export type MakeupOptions = {
  /** 口红强度 0~100；0 = 不动。 */
  lip?: number
  /** 腮红强度 0~100；0 = 不动。 */
  blush?: number
  /** 口红色号；缺省玫瑰。 */
  lipShade?: LipShadeId
}

const clamp01 = (v: number) => Math.max(0, Math.min(1, v))
const smoothstep = (lo: number, hi: number, v: number) => {
  const t = clamp01((v - lo) / Math.max(1e-8, hi - lo))
  return t * t * (3 - 2 * t)
}
const luma = (r: number, g: number, b: number) => 0.299 * r + 0.587 * g + 0.114 * b

/**
 * 「像嘴唇」的程度：高饱和的红唇，或者低亮度、带一点红的重色唇。
 * 暖肤色（低饱和、高亮度）会被压在 0，避免把下巴 / 脸颊当成嘴。
 */
function lipness(r: number, g: number, b: number): number {
  const mx = Math.max(r, g, b)
  const mn = Math.min(r, g, b)
  const sat = mx <= 1e-6 ? 0 : (mx - mn) / mx
  const red = r - (g + b) / 2
  // 嘴唇的饱和度明显高于嘴周阴影；只靠"暗 + 偏红"会把上唇阴影也涂成
  // 一圈粉色（真机验过）。饱和度门槛把阴影挡在外面。
  return smoothstep(0.28, 0.42, sat) * smoothstep(0.04, 0.14, red)
}

/** 保持原亮度的「换色」：把目标色的色相 / 饱和度带过来，明暗仍由原像素决定。 */
function recolor(
  r: number, g: number, b: number,
  tint: readonly [number, number, number], amount: number,
  darken = 1,
): [number, number, number] {
  const l = luma(r, g, b)
  const tl = luma(tint[0], tint[1], tint[2])
  const target = [
    tint[0] + (l - tl) * darken,
    tint[1] + (l - tl) * darken,
    tint[2] + (l - tl) * darken,
  ] as const
  return [
    r + (target[0] - r) * amount,
    g + (target[1] - g) * amount,
    b + (target[2] - b) * amount,
  ]
}

/** 软边椭圆：中心 1，边缘 0。 */
function ellipse(x: number, y: number, cx: number, cy: number, rx: number, ry: number): number {
  const d = Math.hypot((x - cx) / Math.max(1e-6, rx), (y - cy) / Math.max(1e-6, ry))
  if (d >= 1) return 0
  return 1 - smoothstep(0.68, 1, d)
}

/**
 * 在脸框下半部找「红色像素重心」，用它放嘴唇椭圆。
 *
 * 为什么不能只按 `face.y + 0.78h`：本地脸框常把脖子 / 胸口一起框进来
 * （`detectFaceBox` 的高度上限是宽度的 1.45 倍），近景人像的嘴可能落在
 * 0.68h。红色重心跟着实际嘴唇走；找不到够红的区域就返回 null，调用方
 * 退回几何估计。
 */
function findLipCenter(
  data: Uint8ClampedArray, width: number, height: number, face: FaceBox,
): { x: number; y: number } | null {
  const cx = face.x + face.w / 2
  const x0 = Math.max(0, Math.floor(face.x + face.w * 0.20))
  const x1 = Math.min(width, Math.ceil(face.x + face.w * 0.80))
  const y0 = Math.max(0, Math.floor(face.y + face.h * 0.55))
  const y1 = Math.min(height, Math.ceil(face.y + face.h * 0.95))
  if (x1 <= x0 || y1 <= y0) return null

  const gw = x1 - x0
  const gh = y1 - y0
  const weights = new Float32Array(gw * gh)
  let maxWeight = 0
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = (y * width + x) * 4
      const rn = data[i]! / 255
      const gn = data[i + 1]! / 255
      const bn = data[i + 2]! / 255
      const color = lipness(rn, gn, bn)
      const dx = Math.abs(x - cx) / Math.max(1, face.w * 0.5)
      const dy = (y - face.y) / Math.max(1, face.h)
      const spatial = (1 - smoothstep(0.35, 0.55, dx))
        * smoothstep(0.55, 0.62, dy)
        * (1 - smoothstep(0.90, 0.98, dy))
      const w = color * spatial
      if (w <= 0) continue
      weights[(y - y0) * gw + (x - x0)] = w
      if (w > maxWeight) maxWeight = w
    }
  }
  // 先做 5×5 平滑再找峰：嘴唇是一整块，不是一颗最红的噪点；平滑后峰
  // 不会跑到单像素高光上，也不会被下巴 / 头发的散红拖走。
  let best = 0
  let bestX = 0
  let bestY = 0
  for (let y = 0; y < gh; y++) {
    for (let x = 0; x < gw; x++) {
      let sum = 0
      for (let dy = -2; dy <= 2; dy++) {
        const yy = Math.max(0, Math.min(gh - 1, y + dy))
        for (let dx = -2; dx <= 2; dx++) {
          const xx = Math.max(0, Math.min(gw - 1, x + dx))
          sum += weights[yy * gw + xx]!
        }
      }
      if (sum > best) {
        best = sum
        bestX = x
        bestY = y
      }
    }
  }
  if (best <= 0) return null

  // 峰附近一个「嘴大小」的窗口里取红色区域的**外接框中心**。
  // 不取重心：嘴唇是一圈红边，重心会被上唇 / 下唇的强弱拉偏；外接框
  // 的中心才落在嘴的几何中心上。
  const wx = Math.max(8, Math.round(face.w * 0.28))
  const wy = Math.max(6, Math.round(face.h * 0.15))
  const cut = maxWeight * 0.25
  let minX = gw
  let maxX = -1
  let minY = gh
  let maxY = -1
  for (let y = Math.max(0, bestY - wy); y <= Math.min(gh - 1, bestY + wy); y++) {
    for (let x = Math.max(0, bestX - wx); x <= Math.min(gw - 1, bestX + wx); x++) {
      const w = weights[y * gw + x]!
      if (w < cut) continue
      if (x < minX) minX = x
      if (x > maxX) maxX = x
      if (y < minY) minY = y
      if (y > maxY) maxY = y
    }
  }
  if (maxX < minX || maxY < minY) return null
  return {
    x: x0 + (minX + maxX) / 2,
    y: y0 + (minY + maxY) / 2,
  }
}

/**
 * 原地给嘴唇 / 两颊上色。只扫描这两个椭圆的并集外接框，不整图扫。
 * 返回 `changed` = RGB 真的变了的像素数（alpha 永远不碰）。
 */
export function makeupPixels(
  data: Uint8ClampedArray, width: number, height: number,
  face: FaceBox, opts: MakeupOptions = {},
): { changed: number } {
  if (data.length !== width * height * 4) {
    throw new Error(`像素尺寸和照片对不上（像素 ${data.length} 字节，照片 ${width}×${height}）`)
  }
  const lip = Math.max(0, Math.min(100, typeof opts.lip === 'number' && Number.isFinite(opts.lip) ? opts.lip : 0))
  const blush = Math.max(0, Math.min(100, typeof opts.blush === 'number' && Number.isFinite(opts.blush) ? opts.blush : 0))
  if (lip <= 0 && blush <= 0) return { changed: 0 }

  const shade = LIP_SHADES.find(s => s.id === opts.lipShade) ?? LIP_SHADES[1]
  const foundLip = findLipCenter(data, width, height, face)
  const lipRx = Math.max(2, face.w * 0.22)
  const lipRy = Math.max(2, face.h * 0.08)
  const lipCx = foundLip?.x ?? face.x + face.w * 0.5
  const lipCy = (foundLip?.y ?? face.y + face.h * 0.74) + face.h * 0.02
  const blushY = face.y + face.h * 0.62
  const blushRx = Math.max(2, face.w * 0.15)
  const blushRy = Math.max(2, face.h * 0.10)
  const blushXs = [face.x + face.w * 0.30, face.x + face.w * 0.70]

  const x0 = Math.max(0, Math.floor(Math.min(
    lipCx - lipRx, blushXs[0]! - blushRx, blushXs[1]! - blushRx,
  )))
  const y0 = Math.max(0, Math.floor(Math.min(lipCy - lipRy, blushY - blushRy)))
  const x1 = Math.min(width, Math.ceil(Math.max(
    lipCx + lipRx, blushXs[0]! + blushRx, blushXs[1]! + blushRx,
  )))
  const y1 = Math.min(height, Math.ceil(Math.max(lipCy + lipRy, blushY + blushRy)))
  if (x1 <= x0 || y1 <= y0) return { changed: 0 }

  let changed = 0
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = (y * width + x) * 4
      const r0 = data[i]!
      const g0 = data[i + 1]!
      const b0 = data[i + 2]!
      let r = r0
      let g = g0
      let b = b0

      if (lip > 0) {
        const cov = ellipse(x, y, lipCx, lipCy, lipRx, lipRy)
        if (cov > 0) {
          const rn = r0 / 255
          const gn = g0 / 255
          const bn = b0 / 255
          // 嘴唇偏红；牙齿又亮又低饱和，被后半段压掉。
          const gate = lipness(rn, gn, bn)
          const amount = (lip / 100) * 0.50 * cov * gate
          if (amount > 0) {
            const out = recolor(r, g, b, shade.rgb, amount, 0.90)
            r = out[0]; g = out[1]; b = out[2]
          }
        }
      }

      if (blush > 0) {
        let cov = 0
        for (const cx of blushXs) {
          const c = ellipse(x, y, cx, blushY, blushRx, blushRy)
          if (c > cov) cov = c
        }
        if (cov > 0) {
          const rn = r0 / 255
          const gn = g0 / 255
          const bn = b0 / 255
          const cb = -0.168736 * rn - 0.331264 * gn + 0.5 * bn + 0.5
          const cr = 0.5 * rn - 0.418688 * gn - 0.081312 * bn + 0.5
          const skin = smoothstep(0.28, 0.34, cb) * (1 - smoothstep(0.48, 0.54, cb))
            * smoothstep(0.50, 0.56, cr) * (1 - smoothstep(0.66, 0.72, cr))
            * smoothstep(0.10, 0.22, luma(rn, gn, bn))
          const amount = (blush / 100) * 0.18 * cov * skin
          if (amount > 0) {
            const out = recolor(r, g, b, BLUSH_RGB, amount)
            r = out[0]; g = out[1]; b = out[2]
          }
        }
      }

      const nr = Math.round(Math.max(0, Math.min(255, r)))
      const ng = Math.round(Math.max(0, Math.min(255, g)))
      const nb = Math.round(Math.max(0, Math.min(255, b)))
      if (nr !== r0 || ng !== g0 || nb !== b0) {
        data[i] = nr
        data[i + 1] = ng
        data[i + 2] = nb
        changed++
      }
    }
  }
  return { changed }
}

/** 把美妆落到画布；`maxSide` 用于实时预览，提交时省略 = 原尺寸。 */
export async function makeupToBitmap(
  source: ImageBitmap, face: FaceBox, opts: MakeupOptions,
  maxSide = Number.POSITIVE_INFINITY,
): Promise<{ bitmap: ImageBitmap; changed: number; scale: number; face: FaceBox }> {
  const scale = Math.min(1, maxSide / Math.max(1, Math.max(source.width, source.height)))
  const w = Math.max(1, Math.round(source.width * scale))
  const h = Math.max(1, Math.round(source.height * scale))
  const { canvas, ctx } = makeCanvas(w, h, '美妆失败', { willReadFrequently: true })
  ctx.drawImage(source, 0, 0, w, h)
  const image = ctx.getImageData(0, 0, w, h)
  const scaled: FaceBox = {
    x: face.x * scale, y: face.y * scale, w: face.w * scale, h: face.h * scale,
    confidence: face.confidence,
  }
  const { changed } = makeupPixels(image.data, w, h, scaled, opts)
  if (changed > 0) ctx.putImageData(image, 0, 0)
  const bitmap = await createImageBitmap(canvas)
  return { bitmap, changed, scale, face: scaled }
}
