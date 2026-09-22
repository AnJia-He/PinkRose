import { MAX_DIMENSION, align32, fitWithin } from '../../shared/size'

export type PreparedImage = {
  /** data URL。送后端用（后端再转发给生成模型）。 */
  dataUrl: string
  width: number
  height: number
}

/**
 * 能被 drawImage 画出来、又自带尺寸的东西。
 *
 * ⚠️ **`DecodedImage` 不是它**——那个是 `{ bitmap, width, height }` 的包装对象，
 * 得传 `.bitmap` 进去。（`ImageBitmap` 自己就带 width/height，所以包装里那两个
 * 字段是冗余的，但计划一的类型已经这么定了，不去动它。）
 */
export type Sizable = CanvasImageSource & { width: number; height: number }

/**
 * 把一张图备成能送模型的（spec §4.4）：长边缩到 maxDim、宽高各自对齐到
 * 32 的倍数、编成 JPEG。
 *
 * **画布尺寸必须按对齐后的尺寸设**，不是在原图上缩——align32 会把边长
 * 推最多 16px，差这几像素就会让上游 400。
 *
 * 做在浏览器端是因为这里已经有解码好的位图，不必让原始大图多跑一趟网络。
 */
export async function prepareForModel(
  source: Sizable,
  maxDim = MAX_DIMENSION,
): Promise<PreparedImage> {
  const fitted = fitWithin(source.width, source.height, maxDim)
  const width = align32(fitted.width)
  const height = align32(fitted.height)

  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d', { colorSpace: 'srgb' })
  if (!ctx) throw new Error('拿不到 2D 上下文')

  // 等比缩放 + 至多 16px 的轻微拉伸。肉眼不可见，换来宽高都是 32 的倍数。
  ctx.drawImage(source, 0, 0, width, height)

  const blob = await new Promise<Blob | null>(r => canvas.toBlob(r, 'image/jpeg', 0.9))
  if (!blob) throw new Error('图片编码失败')
  return { dataUrl: await blobToDataUrl(blob), width, height }
}

/**
 * 路由用的缩略预览。
 *
 * 路由**不需要**全分辨率——VLM 只是"看看这照片长什么样"。送小图省带宽、
 * 省 token、也更快。1024 长边是保守选择（实测用的底图是 1200x800 和
 * 1024x768，看图结论准确）。
 *
 * ⚠️ 这个尺寸**没做过 A/B 实测**：更小（比如 512）会不会让模型看走眼，
 * 尚未验证。要动它之前先跑一次对比。
 */
export async function prepareForRouting(
  source: Sizable,
  maxDim = 1024,
): Promise<PreparedImage> {
  return prepareForModel(source, maxDim)
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((res, rej) => {
    const r = new FileReader()
    r.onload = () => res(r.result as string)
    r.onerror = () => rej(r.error)
    r.readAsDataURL(blob)
  })
}
