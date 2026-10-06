import {
  cropOutputSize, effectiveAngle, rotatedBounds, type CropSpec,
} from '../core/crop'

/**
 * 把裁剪算式落到一张位图上（★ 2026-10-06）。
 *
 * 画法是"反过来画"：**不是**把照片转过去、而是把输出画布转回来 ——
 * 这样空角天然是空的、也不用算四个角跑到哪去了：
 *
 *   out.translate(-框左上角在外框里的像素)
 *   out.translate(外框中心)
 *   out.rotate(-θ)
 *   out.drawImage(底图, -imgW/2, -imgH/2)      // 中心对齐
 *
 * ★ **方向约定**（2026-10-06 补，跨任务裁定）：`θ > 0` ⇒ 底图在**输出**里
 *   **逆时针**转（等价说法：裁剪框顺时针转）。画布坐标系 y 朝下，所以
 *   "把坐标系转 -θ"画出来就是照片逆时针转 θ。
 *   ⚠️ **预览必须用同一个方向**（`ui/Canvas` 那儿的 CSS 是 `rotate(-θ)`）——
 *   写成反的，预览和成片会朝两个方向转，而外框尺寸和输出尺寸**两边一模一样**，
 *   单测和探针**全都看不出来**。
 *
 * ⚠️ 作用对象是**底图 `base`**（不带参数、不带滤镜）—— 参数和滤镜之后由管线
 *    盖上去（spec §3.1）。别改成"裁渲染后的画面"。
 */
export async function cropToBitmap(
  source: ImageBitmap, spec: CropSpec, turns: number,
): Promise<ImageBitmap> {
  const angle = effectiveAngle(spec, turns)
  const bounds = rotatedBounds(source.width, source.height, angle)
  const { width, height } = cropOutputSize(spec, turns, source.width, source.height)

  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d', { colorSpace: 'srgb' })
  // ✋ 拿不到上下文就**说出来** —— 返回一张空图会让用户以为"裁出来就是黑的"
  if (!ctx) throw new Error('裁剪时拿不到 2D 上下文（这张图画不出来）')

  ctx.imageSmoothingQuality = 'high'
  ctx.translate(-spec.rect.x * bounds.w, -spec.rect.y * bounds.h)
  ctx.translate(bounds.w / 2, bounds.h / 2)
  ctx.rotate((-angle * Math.PI) / 180)
  ctx.drawImage(source, -source.width / 2, -source.height / 2)

  return createImageBitmap(canvas)
}
