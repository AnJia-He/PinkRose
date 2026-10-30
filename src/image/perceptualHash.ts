import { makeCanvas } from '../core/canvas'
import { DHASH_HEIGHT, DHASH_WIDTH, dHashFromGray } from '../core/perceptualHash'

/** 从缩略图 Blob 计算 9×8 灰度 dHash；只在本机内存中处理。 */
export async function perceptualHashFromBlob(blob: Blob): Promise<string> {
  const bitmap = await createImageBitmap(blob)
  try {
    const { ctx } = makeCanvas(
      DHASH_WIDTH, DHASH_HEIGHT, '相似照片分析失败', { willReadFrequently: true },
    )
    ctx.imageSmoothingEnabled = true
    ctx.imageSmoothingQuality = 'high'
    ctx.drawImage(bitmap, 0, 0, DHASH_WIDTH, DHASH_HEIGHT)
    const image = ctx.getImageData(0, 0, DHASH_WIDTH, DHASH_HEIGHT)
    const gray = new Uint8Array(DHASH_WIDTH * DHASH_HEIGHT)
    for (let i = 0, p = 0; i < image.data.length; i += 4, p++) {
      gray[p] = Math.round(
        image.data[i]! * 0.2126
        + image.data[i + 1]! * 0.7152
        + image.data[i + 2]! * 0.0722,
      )
    }
    return dHashFromGray(gray)
  } finally {
    bitmap.close()
  }
}
