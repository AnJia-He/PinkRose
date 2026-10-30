import { makeCanvas } from '../core/canvas'
import { featherMask } from '../core/retouch'

/**
 * 局部 AI 消除的裁切 / 标记 / 回贴。
 *
 * 用户只涂住要拿掉的东西。真正送去模型的是**围绕选区的一块方图**：
 * 周围留一圈上下文，选区上盖一层半透明红标；模型回图后只把掩码里的
 * 像素贴回原图，掩码外一个字节都不动。这样既不会重画整张照片，也不会
 * 因为模型顺手改了别处而把用户的构图弄丢。
 *
 * ⚠️ 模型和本地算法一样，只负责“这一块”。选得太大会把上下文压得太小，
 *    所以调用方要先过一遍面积闸门（`inpaintAreaTooLarge`）。
 */

/** 送给模型的正方形边长。1024 是质量 / 耗时 / 上传大小之间比较稳的一档。 */
export const AI_ERASE_SIDE = 1024

/**
 * 固定提示词。
 *
 * 两句话是故意写死的：
 * - `remove ... red overlay`：模型必须知道红标 = 要删的东西；
 * - `Do not preserve the person ...`：`buildEditPrompt` 看到 `preserve the
 *   person` 就不会再追加“保留人物身份”的保底句（那一句对消除路人正好是反的）。
 */
export const AI_ERASE_PROMPT =
  'Remove the object marked by the semi-transparent red overlay in this cropped photograph. '
  + 'Do not preserve the person or object marked in red; remove it completely. '
  + 'Reconstruct the background and surrounding texture naturally, matching the existing '
  + 'lighting, perspective, colors and focus. Keep everything else unchanged, including '
  + 'people, objects, background, composition and camera angle. Return a clean photograph '
  + 'with no red overlay, no added objects, no text and no watermark.'

/** 自定义局部编辑：只改红标区域，其他内容尽量保持原样。 */
export function localEditPrompt(instruction: string): string {
  const clean = instruction.trim().slice(0, 300)
  return 'Edit only the object or area marked by the semi-transparent red overlay in this '
    + `cropped photograph. Apply this instruction there: "${clean}". `
    + 'Reconstruct the surrounding texture naturally, matching the existing lighting, '
    + 'perspective, colors and focus. Keep everything outside the marked area unchanged, '
    + 'including people, objects, background, composition and camera angle. Return a clean '
    + 'photograph with no red overlay, no extra text and no watermark.'
}

export type InpaintBounds = {
  x0: number
  y0: number
  x1: number
  y1: number
  count: number
}

export type InpaintPlan = {
  /** 原图上的裁切框（像素，x1 / y1 是开区间）。 */
  crop: { x: number; y: number; w: number; h: number }
  /** 裁切框在模型方图里的落点（保持比例，留白由背景晕染填）。 */
  draw: { x: number; y: number; w: number; h: number }
  /** 送给模型的方图尺寸。 */
  size: { width: number; height: number }
}

export type InpaintInput = {
  imageDataUrl: string
  size: { width: number; height: number }
}

/**
 * 算出围绕选区的一块裁切框。
 *
 * 留白取选区长边的 45%，至少 24px：太紧模型看不见周围纹理，太松又会把
 * 太多无关内容塞进 1024 方图。裁切框永远夹在原图内，方图里用 `contain`
 * 摆放，所以照片边缘的选区也不会把内容裁掉。
 */
export function planInpaintCrop(
  width: number,
  height: number,
  bounds: InpaintBounds,
  side = AI_ERASE_SIDE,
): InpaintPlan {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    throw new Error('AI 消除需要有效的照片尺寸')
  }
  const bw = bounds.x1 - bounds.x0
  const bh = bounds.y1 - bounds.y0
  if (bw <= 0 || bh <= 0) throw new Error('AI 消除需要先涂出一块区域')

  const pad = Math.max(24, Math.round(Math.max(bw, bh) * 0.45))
  const x0 = Math.max(0, Math.floor(bounds.x0 - pad))
  const y0 = Math.max(0, Math.floor(bounds.y0 - pad))
  const x1 = Math.min(width, Math.ceil(bounds.x1 + pad))
  const y1 = Math.min(height, Math.ceil(bounds.y1 + pad))
  const cropW = Math.max(1, x1 - x0)
  const cropH = Math.max(1, y1 - y0)

  const scale = Math.min(side / cropW, side / cropH)
  const drawW = Math.max(1, Math.round(cropW * scale))
  const drawH = Math.max(1, Math.round(cropH * scale))
  return {
    crop: { x: x0, y: y0, w: cropW, h: cropH },
    draw: {
      x: Math.max(0, Math.round((side - drawW) / 2)),
      y: Math.max(0, Math.round((side - drawH) / 2)),
      w: drawW,
      h: drawH,
    },
    size: { width: side, height: side },
  }
}

/**
 * 选区面积闸门。
 *
 * 局部消除不是“重画整张”。选区超过照片的 60% 或 250 万像素时，模型能看到的
 * 周围上下文太少，回贴后也容易出现整块色差。让用户分几次消，比一次糊掉强。
 */
export function inpaintAreaTooLarge(
  width: number,
  height: number,
  bounds: Pick<InpaintBounds, 'x0' | 'y0' | 'x1' | 'y1'>,
): boolean {
  const area = Math.max(0, bounds.x1 - bounds.x0) * Math.max(0, bounds.y1 - bounds.y0)
  const max = Math.max(250_000, Math.min(2_500_000, Math.round(width * height * 0.6)))
  return area > max
}

/**
 * 生成送模的方图：原裁剪 + 红标。
 *
 * 先铺一层拉伸后的裁切图当“周围颜色”，再把保持比例的裁剪图画进中间；
 * 最后把掩码画成半透明红。模型的输出我们只取掩码内的像素，所以边缘留白
 * 不会污染原图。
 */
export async function buildInpaintInput(
  bitmap: ImageBitmap,
  mask: Uint8Array,
  plan: InpaintPlan,
): Promise<InpaintInput> {
  const width = bitmap.width
  const height = bitmap.height
  if (mask.length !== width * height) {
    throw new Error('AI 消除的掩码尺寸和照片对不上')
  }
  const { crop, draw, size } = plan
  const { canvas, ctx } = makeCanvas(size.width, size.height, '做不了 AI 消除的图')

  // 周围颜色：拉伸铺满，只在方图的留白里露脸；不参与回贴。
  ctx.save()
  ctx.globalAlpha = 0.35
  ctx.drawImage(bitmap, crop.x, crop.y, crop.w, crop.h, 0, 0, size.width, size.height)
  ctx.restore()
  ctx.drawImage(bitmap, crop.x, crop.y, crop.w, crop.h, draw.x, draw.y, draw.w, draw.h)

  const overlay = makeCanvas(crop.w, crop.h, '画不了 AI 消除的选区')
  const marked = overlay.ctx.createImageData(crop.w, crop.h)
  for (let y = 0; y < crop.h; y++) {
    for (let x = 0; x < crop.w; x++) {
      const cov = mask[(crop.y + y) * width + crop.x + x]!
      if (!cov) continue
      const p = (y * crop.w + x) * 4
      marked.data[p] = 255
      marked.data[p + 1] = 16
      marked.data[p + 2] = 16
      marked.data[p + 3] = Math.round(160 * cov / 255)
    }
  }
  overlay.ctx.putImageData(marked, 0, 0)
  ctx.drawImage(overlay.canvas, 0, 0, crop.w, crop.h, draw.x, draw.y, draw.w, draw.h)

  return { imageDataUrl: canvas.toDataURL('image/jpeg', 0.92), size }
}

/**
 * 只把掩码里的像素换成模型回图。掩码外用原图，alpha 也保持原样。
 * 纯函数单独拆出来，jsdom 里可以拿合成数据直接验。
 */
export function blendInpaintPixels(
  dst: Uint8ClampedArray,
  src: Uint8ClampedArray,
  mask: Uint8Array,
): void {
  if (dst.length !== src.length || dst.length !== mask.length * 4) {
    throw new Error('AI 消除回贴的尺寸对不上')
  }
  for (let i = 0; i < mask.length; i++) {
    const cov = mask[i]! / 255
    if (cov <= 0) continue
    const p = i * 4
    dst[p] = Math.round(dst[p]! * (1 - cov) + src[p]! * cov)
    dst[p + 1] = Math.round(dst[p + 1]! * (1 - cov) + src[p + 1]! * cov)
    dst[p + 2] = Math.round(dst[p + 2]! * (1 - cov) + src[p + 2]! * cov)
    // alpha 不动：照片本来就不透明，回贴也不该突然挖出一个洞。
  }
}

/**
 * 把模型回图缩放回裁切框、按掩码混进原图，产出新底图。
 *
 * `generated` 的实际尺寸可能和声明的 1024 不一致（上游有时会回别的尺寸），
 * 所以这里按实际宽高换算源子矩形，不按声明尺寸硬拉伸。
 */
export async function compositeInpaint(
  source: ImageBitmap,
  generated: ImageBitmap,
  mask: Uint8Array,
  plan: InpaintPlan,
): Promise<ImageBitmap> {
  const width = source.width
  const height = source.height
  if (mask.length !== width * height) {
    throw new Error('AI 消除的掩码尺寸和照片对不上')
  }
  if (generated.width <= 0 || generated.height <= 0) {
    throw new Error('模型没有返回可用的图片')
  }

  const { crop, draw, size } = plan
  const { canvas, ctx } = makeCanvas(width, height, '合不回 AI 消除的图', {
    willReadFrequently: true,
  })
  ctx.drawImage(source, 0, 0)
  const base = ctx.getImageData(0, 0, width, height)

  const layer = makeCanvas(width, height, '合不回 AI 消除的图', {
    willReadFrequently: true,
  })
  const sx = draw.x * generated.width / size.width
  const sy = draw.y * generated.height / size.height
  const sw = draw.w * generated.width / size.width
  const sh = draw.h * generated.height / size.height
  layer.ctx.drawImage(generated, sx, sy, sw, sh, crop.x, crop.y, crop.w, crop.h)
  const changed = layer.ctx.getImageData(0, 0, width, height)

  const feather = Math.max(2, Math.round(Math.min(width, height) * 0.006))
  const softMask = featherMask(mask, width, height, feather)
  blendInpaintPixels(base.data, changed.data, softMask)
  ctx.putImageData(base, 0, 0)
  return createImageBitmap(canvas)
}

/** 给调用方复用的类型别名（和 `maskBounds` 的返回形状一致）。 */
export type MaskBounds = InpaintBounds
