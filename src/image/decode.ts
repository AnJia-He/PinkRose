/** 送给模型的图长边上限（spec §4.4）。调色路径不受此限制。 */
export const MAX_DIMENSION = 2048

/** API 硬约束：宽高必须是 32 的倍数，且在 [512, 4096]（spec §4.3） */
export const SIZE_MIN = 512
export const SIZE_MAX = 4096
const SIZE_STEP = 32

export function align32(n: number): number {
  const rounded = Math.round(n / SIZE_STEP) * SIZE_STEP
  return Math.max(SIZE_MIN, Math.min(SIZE_MAX, rounded))
}

export type Size = { width: number; height: number }

/** 等比缩放到长边不超过 max。只缩不放。 */
export function fitWithin(w: number, h: number, max: number): Size {
  const longest = Math.max(w, h)
  if (longest <= max) return { width: w, height: h }
  const k = max / longest
  return { width: Math.round(w * k), height: Math.round(h * k) }
}

export type DecodedImage = {
  /** 调用方负责在不再使用时调用 bitmap.close()——它占用的是 GPU 内存 */
  bitmap: ImageBitmap
  width: number
  height: number
}

/**
 * 解码用户选的文件。
 *
 * 关键：iPhone 拍的照片是 Display P3 色域，直接当 sRGB 用会让红色发暗、
 * 绿色发艳。这里用 createImageBitmap 的 colorSpaceConversion 让浏览器
 * 完成 P3 -> sRGB 转换（spec §5.3）。
 */
export async function decodeImageFile(file: File): Promise<DecodedImage> {
  const raw = await createImageBitmap(file, {
    colorSpaceConversion: 'default',   // 让浏览器做色彩空间转换
    premultiplyAlpha: 'none',
  })
  try {
    const bitmap = await toSrgbBitmap(raw)
    return { bitmap, width: bitmap.width, height: bitmap.height }
  } finally {
    // 必须是 finally：toSrgbBitmap 抛错时也得释放。
    // ImageBitmap 占的是 GPU 内存，泄漏几次就能把标签页拖垮。
    raw.close()
  }
}

/**
 * 把任意色域的位图重绘到 sRGB 画布上，再取回位图。
 *
 * 转换发生在 drawImage 那一行：2D 画布会按画布自身的色彩空间
 * （这里显式指定 srgb）解释源图并写入。若源图本来已是 sRGB，
 * 这一步就是恒等转换——所以**不会转换两次**。
 *
 * 早期版本在这里还调过一次 getImageData + putImageData，是多余的：
 * 它只是把同一批字节读出来再原样写回，却要多分配一个全分辨率的
 * 缓冲区（1200 万像素的照片约 49 MB）并强制一次 GPU 回读。
 */
async function toSrgbBitmap(src: ImageBitmap): Promise<ImageBitmap> {
  const canvas = document.createElement('canvas')
  canvas.width = src.width
  canvas.height = src.height
  const ctx = canvas.getContext('2d', { colorSpace: 'srgb' })
  if (!ctx) throw new Error('拿不到 2D 上下文，无法做色彩空间转换')
  ctx.drawImage(src, 0, 0)   // ← 色彩空间转换就发生在这一行
  return createImageBitmap(canvas)
}

/**
 * 说明：`align32` 与 `fitWithin` 在本计划里暂时没有调用方——它们服务的是
 * 生成式编辑那条路（spec §4.4），属于计划二。放在这里是因为它们是
 * spec §4.3 / §4.4 那几条硬约束的可执行形式（32 的倍数、[512,4096]、长边 2048），
 * 用测试钉死比写在注释里可靠——那几条约束是真金白银试出来的。
 */
