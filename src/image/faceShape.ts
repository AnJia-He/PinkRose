import type { FaceBox } from '../core/faceDetect'
import { makeCanvas } from '../core/canvas'

/**
 * 人像自动塑形的像素引擎。
 *
 * 输入一个本地肤色估计出来的人脸框，按比例假设眼睛位置，做三类反向采样：
 * - `slim`：脸颊两侧向中心收；
 * - `eyes`：两眼附近做局部放大；
 * - `chin`：下半张脸向中心收并轻微提下巴；
 * - `nose`：鼻梁两侧向中线收，收窄鼻翼。
 *
 * 所有位移在脸框边缘淡出到 0，脸框外逐字节不变。没有神经网络关键点，
 * 因此只适合正脸；侧脸 / 小脸仍由用户用「液化」手动推。
 */
export type FaceShapeOptions = {
  slim?: number
  eyes?: number
  chin?: number
  nose?: number
  body?: number
  /** 小头：0~100，围绕脸中心缩放整个头部区域。 */
  head?: number
  /** 颅顶：0~100，把额头上方的头顶中段向上拉，边缘淡出。 */
  crown?: number
  /** 长腿：0~100，把脸下方身体中段向下拉伸，上下缘淡出。 */
  legs?: number
  /** 瘦颈：0~100，把下巴下方的颈部两侧向中心收。 */
  neck?: number
  /** 双下巴：0~100，把下巴下方的软组织轻轻向上提。 */
  doubleChin?: number
  /** 肩线：0~100，把肩线外侧轻轻抬起并稍微收窄。 */
  shoulder?: number
  /** 微笑：0~100，把嘴角向斜上方轻提，幅度很小。 */
  smile?: number
}

export type FaceShapeResult = {
  changed: number
  rect: { x: number; y: number; w: number; h: number } | null
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v))
const smoothstep = (lo: number, hi: number, v: number) => {
  const t = clamp((v - lo) / Math.max(1e-8, hi - lo), 0, 1)
  return t * t * (3 - 2 * t)
}

export function faceShapePixels(
  data: Uint8ClampedArray, width: number, height: number,
  face: FaceBox, opts: FaceShapeOptions = {},
): FaceShapeResult {
  if (data.length !== width * height * 4) {
    throw new Error(`像素尺寸和照片对不上（像素 ${data.length} 字节，照片 ${width}×${height}）`)
  }
  if (face.w <= 0 || face.h <= 0) return { changed: 0, rect: null }
  const slim = clamp(opts.slim ?? 0, 0, 100) / 100
  const eyes = clamp(opts.eyes ?? 0, 0, 100) / 100
  const chin = clamp(opts.chin ?? 0, 0, 100) / 100
  const nose = clamp(opts.nose ?? 0, 0, 100) / 100
  const body = clamp(opts.body ?? 0, 0, 100) / 100
  const head = clamp(opts.head ?? 0, 0, 100) / 100
  const crown = clamp(opts.crown ?? 0, 0, 100) / 100
  const legs = clamp(opts.legs ?? 0, 0, 100) / 100
  const neck = clamp(opts.neck ?? 0, 0, 100) / 100
  const doubleChin = clamp(opts.doubleChin ?? 0, 0, 100) / 100
  const shoulder = clamp(opts.shoulder ?? 0, 0, 100) / 100
  const smile = clamp(opts.smile ?? 0, 0, 100) / 100
  if (slim <= 0 && eyes <= 0 && chin <= 0 && nose <= 0 && body <= 0 && head <= 0
    && crown <= 0 && legs <= 0 && neck <= 0 && doubleChin <= 0 && shoulder <= 0
    && smile <= 0) {
    return { changed: 0, rect: null }
  }

  const cx = face.x + face.w / 2
  const cy = face.y + face.h / 2
  const halfW = face.w / 2
  const halfH = face.h / 2
  const bodyTop = face.y + face.h * 0.82
  const bodySpan = Math.max(1, height - bodyTop)
  const bodyHalfW = Math.max(face.w * 0.95, width * 0.24)
  const pad = Math.max(4, Math.round(face.w * 0.28))
  let outX0 = clamp(Math.floor(face.x - pad), 0, width)
  let outY0 = clamp(Math.floor(face.y - pad), 0, height)
  let outX1 = clamp(Math.ceil(face.x + face.w + pad), 0, width)
  let outY1 = clamp(Math.ceil(face.y + face.h + pad), 0, height)
  if (body > 0 || legs > 0) {
    outX0 = Math.min(outX0, clamp(Math.floor(cx - bodyHalfW * 1.15), 0, width))
    outX1 = Math.max(outX1, clamp(Math.ceil(cx + bodyHalfW * 1.15), 0, width))
    outY1 = height
  }
  if (head > 0) {
    // 头区包括脸和一部分头发；输出矩形要完整包住椭圆，否则顶部/两侧会被
    // 采样边界切出一条直边。
    outX0 = Math.min(outX0, clamp(Math.floor(cx - face.w * 1.05), 0, width))
    outX1 = Math.max(outX1, clamp(Math.ceil(cx + face.w * 1.05), 0, width))
    outY0 = Math.min(outY0, clamp(Math.floor(cy - face.h * 1.05), 0, height))
    outY1 = Math.max(outY1, clamp(Math.ceil(cy + face.h * 1.05), 0, height))
  }
  if (crown > 0) {
    outX0 = Math.min(outX0, clamp(Math.floor(cx - face.w * 0.62), 0, width))
    outX1 = Math.max(outX1, clamp(Math.ceil(cx + face.w * 0.62), 0, width))
    outY0 = Math.min(outY0, clamp(Math.floor(face.y - face.h * 0.38), 0, height))
    outY1 = Math.max(outY1, clamp(Math.ceil(face.y + face.h * 0.12), 0, height))
  }
  if (neck > 0 || doubleChin > 0) {
    outX0 = Math.min(outX0, clamp(Math.floor(cx - face.w * 0.65), 0, width))
    outX1 = Math.max(outX1, clamp(Math.ceil(cx + face.w * 0.65), 0, width))
    outY1 = Math.max(outY1, clamp(Math.ceil(face.y + face.h * 1.32), 0, height))
  }
  if (shoulder > 0) {
    outX0 = Math.min(outX0, clamp(Math.floor(cx - bodyHalfW * 1.35), 0, width))
    outX1 = Math.max(outX1, clamp(Math.ceil(cx + bodyHalfW * 1.35), 0, width))
    outY1 = Math.max(outY1, clamp(Math.ceil(face.y + face.h * 1.60), 0, height))
  }
  if (outX1 <= outX0 || outY1 <= outY0) return { changed: 0, rect: null }

  const src = new Uint8ClampedArray(data.length)
  src.set(data)

  const eyeY = face.y + face.h * 0.42
  const eyeR = face.w * 0.19
  const eyeRy = face.h * 0.15
  const eyeXs = [face.x + face.w * 0.3, face.x + face.w * 0.7]
  const noseY = face.y + face.h * 0.58
  const noseRx = face.w * 0.18
  const noseRy = face.h * 0.13
  const mouthY = face.y + face.h * 0.76
  const mouthCornerX = face.w * 0.18
  const mouthRx = face.w * 0.16
  const mouthRy = face.h * 0.09

  let changed = 0
  for (let y = outY0; y < outY1; y++) {
    const ny = (y - cy) / halfH
    for (let x = outX0; x < outX1; x++) {
      const nx = (x - cx) / halfW
      const radial = Math.hypot(nx, ny) / 1.05
      const edge = 1 - smoothstep(0.82, 1.02, radial)
      let srcX = x
      let srcY = y
      let moved = 0

      if (slim > 0) {
        const side = smoothstep(0.12, 0.82, Math.abs(nx))
        const cheeks = 0.45 + 0.55 * Math.exp(-Math.pow((ny - 0.08) / 0.66, 2))
        const dx = (x - cx) * 0.22 * slim * side * cheeks * edge
        srcX += dx
        moved = Math.max(moved, Math.abs(dx))
      }
      if (chin > 0) {
        const lower = smoothstep(0.08, 0.92, ny)
        const side = smoothstep(0.1, 0.9, Math.abs(nx))
        const center = 1 - smoothstep(0.05, 0.55, Math.abs(nx))
        const dx = (x - cx) * 0.28 * chin * lower * side * edge
        const dy = face.h * 0.035 * chin * lower * center * edge
        srcX += dx
        srcY += dy
        moved = Math.max(moved, Math.abs(dx), Math.abs(dy))
      }
      if (smile > 0) {
        // 嘴角两个软边椭圆：输出像素在图上的嘴角处向下 / 向外取样，
        // 内容便会向斜上方、略向外移动，形成很小的微笑弧度。
        let best = 0
        let sx = srcX
        let sy = srcY
        for (const side of [-1, 1]) {
          const ex = cx + side * mouthCornerX
          const q = 1 - smoothstep(0.35, 1, Math.hypot(
            (x - ex) / Math.max(1e-6, mouthRx),
            (y - mouthY) / Math.max(1e-6, mouthRy),
          ))
          if (q <= best) continue
          best = q
          sx = srcX - side * face.w * 0.012 * smile * q
          sy = srcY + face.h * 0.045 * smile * q
        }
        if (best > 0) {
          srcX = sx
          srcY = sy
          moved = Math.max(moved, best * smile * face.h * 0.045)
        }
      }
      if (neck > 0) {
        const neckTop = face.y + face.h * 0.86
        const neckBottom = face.y + face.h * 1.30
        if (y >= neckTop && y <= neckBottom) {
          const vertical = smoothstep(neckTop, neckTop + face.h * 0.10, y)
            * (1 - smoothstep(neckBottom - face.h * 0.18, neckBottom, y))
          const nxNeck = (x - cx) / Math.max(1, face.w * 0.55)
          const side = smoothstep(0.08, 1, Math.abs(nxNeck))
          const outer = 1 - smoothstep(1, 1.45, Math.abs(nxNeck))
          const dx = (x - cx) * 0.18 * neck * side * outer * vertical
          if (Math.abs(dx) > 0.02) {
            srcX += dx
            moved = Math.max(moved, Math.abs(dx))
          }
        }
      }
      if (doubleChin > 0) {
        const top = face.y + face.h * 0.78
        const bottom = face.y + face.h * 1.10
        if (y >= top && y <= bottom) {
          const vertical = smoothstep(top, top + face.h * 0.06, y)
            * (1 - smoothstep(bottom - face.h * 0.10, bottom, y))
          const nxChin = (x - cx) / Math.max(1, face.w * 0.55)
          const horizontal = 1 - smoothstep(0.35, 1, Math.abs(nxChin))
          const dy = face.h * 0.06 * doubleChin * vertical * horizontal
          if (dy > 0.02) {
            // 向下取样 → 下巴下方的内容向上提，视觉上减轻双下巴。
            srcY += dy
            moved = Math.max(moved, dy)
          }
        }
      }
      if (shoulder > 0) {
        const top = face.y + face.h * 1.08
        const bottom = face.y + face.h * 1.55
        if (y >= top && y <= bottom) {
          const by = (y - top) / Math.max(1, bottom - top)
          const vertical = smoothstep(0, 0.14, by) * (1 - smoothstep(0.78, 1, by))
          const nxShoulder = (x - cx) / Math.max(1, bodyHalfW)
          const side = smoothstep(0.25, 1, Math.abs(nxShoulder))
          const outer = 1 - smoothstep(1, 1.45, Math.abs(nxShoulder))
          const weight = shoulder * side * outer * vertical
          if (weight > 0.002) {
            const dx = (x - cx) * 0.12 * weight
            const dy = face.h * 0.10 * weight
            srcX += dx
            srcY += dy
            moved = Math.max(moved, Math.abs(dx), dy)
          }
        }
      }
      if (nose > 0) {
        // 输出像素在鼻梁附近时，向鼻翼外侧取样（再映回原位）—— 两侧一起
        // 向中线挤，鼻子看起来变窄；椭圆边缘淡出，鼻尖 / 鼻翼不硬切。
        const q = 1 - smoothstep(0.15, 1, Math.hypot(
          (x - cx) / Math.max(1e-6, noseRx),
          (y - noseY) / Math.max(1e-6, noseRy),
        ))
        if (q > 0) {
          const scale = 1 + 0.60 * nose * q
          const sx = cx + (srcX - cx) * scale
          const dx = sx - srcX
          srcX = sx
          moved = Math.max(moved, Math.abs(dx))
        }
      }
      if (crown > 0) {
        // 输出像素在额头 / 头顶中段时，向下取样 → 这块内容整体上移，
        // 视觉上额头和颅顶变高；上下缘都淡出，避免出现横向接缝。
        const crownTop = face.y - face.h * 0.38
        const crownBottom = face.y + face.h * 0.12
        if (y >= crownTop && y <= crownBottom) {
          const vertical = smoothstep(crownTop, crownTop + face.h * 0.12, y)
            * (1 - smoothstep(crownBottom - face.h * 0.18, crownBottom, y))
          const horizontal = 1 - smoothstep(
            0.35, 1, Math.abs(x - cx) / Math.max(1, face.w * 0.62),
          )
          const dy = face.h * 0.20 * crown * vertical * horizontal
          if (dy > 0.02) {
            srcY += dy
            moved = Math.max(moved, dy)
          }
        }
      }
      if (body > 0 && y > bodyTop) {
        const by = (y - bodyTop) / bodySpan
        const fade = smoothstep(0, 0.16, by)
        const bx = (x - cx) / bodyHalfW
        const side = smoothstep(0.12, 0.98, Math.abs(bx))
        const dx = (x - cx) * 0.18 * body * side * fade
        srcX += dx
        moved = Math.max(moved, Math.abs(dx))
      }
      if (legs > 0 && y > bodyTop) {
        // 输出像素在身体中段时向上取样 → 内容整体向下拉，视觉上腿变长；
        // 最上和最下缘都淡出，避免颈部和画面底部出现横向接缝。
        const by = (y - bodyTop) / bodySpan
        const vertical = smoothstep(0, 0.12, by) * (1 - smoothstep(0.84, 1, by))
        const horizontal = 1 - smoothstep(
          0.35, 1, Math.abs(x - cx) / Math.max(1, bodyHalfW),
        )
        const dy = bodySpan * 0.10 * legs * vertical * horizontal
        if (dy > 0.02) {
          srcY -= dy
          moved = Math.max(moved, dy)
        }
      }
      if (eyes > 0) {
        let best = 0
        let bestX = srcX
        let bestY = srcY
        for (const ex of eyeXs) {
          const dx = (x - ex) / eyeR
          const dy = (y - eyeY) / eyeRy
          const d = Math.hypot(dx, dy)
          const q = 1 - smoothstep(0.5, 1, d)
          if (q <= best) continue
          const scale = 1 - 0.38 * eyes * q
          best = q
          bestX = ex + (srcX - ex) * scale
          bestY = eyeY + (srcY - eyeY) * scale
        }
        if (best > 0) {
          srcX = bestX
          srcY = bestY
          moved = Math.max(moved, best)
        }
      }
      if (head > 0) {
        // 输出像素向脸中心外取样 → 头部内容在画面里变小；椭圆边缘淡出，
        // 避免在头/颈交界处出现一刀切。
        const d = Math.hypot(
          (x - cx) / Math.max(1, face.w * 0.95),
          (y - cy) / Math.max(1, face.h),
        )
        const q = 1 - smoothstep(0.55, 1.02, d)
        if (q > 0) {
          const scale = 1 + 0.15 * head * q
          const sx = cx + (srcX - cx) * scale
          const sy = cy + (srcY - cy) * scale
          moved = Math.max(moved, Math.abs(sx - srcX), Math.abs(sy - srcY))
          srcX = sx
          srcY = sy
        }
      }

      if (moved < 0.02) continue
      const sx = clamp(srcX, 0, width - 1)
      const sy = clamp(srcY, 0, height - 1)
      const ix = Math.floor(sx)
      const iy = Math.floor(sy)
      const ix1 = Math.min(ix + 1, width - 1)
      const iy1 = Math.min(iy + 1, height - 1)
      const fx = sx - ix
      const fy = sy - iy
      const i00 = (iy * width + ix) * 4
      const i10 = (iy * width + ix1) * 4
      const i01 = (iy1 * width + ix) * 4
      const i11 = (iy1 * width + ix1) * 4
      const di = (y * width + x) * 4
      let diff = false
      for (let c = 0; c < 4; c++) {
        const a = src[i00 + c]! * (1 - fx) + src[i10 + c]! * fx
        const b = src[i01 + c]! * (1 - fx) + src[i11 + c]! * fx
        const v = Math.round(a * (1 - fy) + b * fy)
        if (v !== data[di + c]) diff = true
        data[di + c] = v
      }
      if (diff) changed++
    }
  }
  return {
    changed,
    rect: changed > 0
      ? { x: outX0, y: outY0, w: outX1 - outX0, h: outY1 - outY0 }
      : null,
  }
}

/** 小头后的脸框（以脸中心为锚点缩小），供预览框和后续补光/妆容共用。 */
export function headScaledFace(face: FaceBox, head: number): FaceBox {
  const amount = clamp(head, 0, 100) / 100
  if (amount <= 0) return face
  const shrink = 1 + 0.15 * amount
  const w = face.w / shrink
  const h = face.h / shrink
  return {
    x: face.x + (face.w - w) / 2,
    y: face.y + (face.h - h) / 2,
    w,
    h,
    confidence: face.confidence,
  }
}

/**
 * 把塑形落到画布。`maxSide` 用于实时预览（≤1400）；提交时省略 = 原尺寸。
 * 返回的 `face` 是**这张输出图**里的坐标，预览层拿它画人脸框不会漂。
 */
export async function faceShapeToBitmap(
  source: ImageBitmap, face: FaceBox, opts: FaceShapeOptions,
  maxSide = Number.POSITIVE_INFINITY,
): Promise<{ bitmap: ImageBitmap; changed: number; scale: number; face: FaceBox }> {
  const scale = Math.min(1, maxSide / Math.max(1, Math.max(source.width, source.height)))
  const w = Math.max(1, Math.round(source.width * scale))
  const h = Math.max(1, Math.round(source.height * scale))
  const { canvas, ctx } = makeCanvas(w, h, '人像塑形失败', { willReadFrequently: true })
  ctx.drawImage(source, 0, 0, w, h)
  const image = ctx.getImageData(0, 0, w, h)
  const scaled: FaceBox = {
    x: face.x * scale,
    y: face.y * scale,
    w: face.w * scale,
    h: face.h * scale,
    confidence: face.confidence,
  }
  const { changed } = faceShapePixels(image.data, w, h, scaled, opts)
  if (changed > 0) ctx.putImageData(image, 0, 0)
  const bitmap = await createImageBitmap(canvas)
  return { bitmap, changed, scale, face: headScaledFace(scaled, opts.head ?? 0) }
}
