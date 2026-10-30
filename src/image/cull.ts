import { fitWithin } from '../../shared/size.ts'
import { makeCanvas } from '../core/canvas'
import { cullMetrics, type CullMetrics } from '../core/cull'
import { decodeImageFile } from './decode'

const CULL_SIDE = 256

async function metricsFromBitmap(bitmap: ImageBitmap): Promise<CullMetrics> {
  const { width, height } = fitWithin(bitmap.width, bitmap.height, CULL_SIDE)
  const { ctx } = makeCanvas(width, height, '看不清这张照片')
  ctx.imageSmoothingQuality = 'high'
  ctx.drawImage(bitmap, 0, 0, width, height)
  const data = ctx.getImageData(0, 0, width, height).data
  const luma = new Float32Array(width * height)
  for (let i = 0; i < luma.length; i++) {
    const p = i * 4
    luma[i] = data[p]! * 0.2126 + data[p + 1]! * 0.7152 + data[p + 2]! * 0.0722
  }
  return cullMetrics(luma, width, height)
}

/** Decode one file and measure a small luma copy; no model, no upload. */
export async function analyzePhoto(file: File): Promise<CullMetrics> {
  const decoded = await decodeImageFile(file)
  try {
    return await metricsFromBitmap(decoded.bitmap)
  } finally {
    decoded.bitmap.close()
  }
}

/** Measure an already-fetched thumbnail; no model, no upload. */
export async function analyzePhotoBlob(blob: Blob): Promise<CullMetrics> {
  const bitmap = await createImageBitmap(blob)
  try {
    return await metricsFromBitmap(bitmap)
  } finally {
    bitmap.close()
  }
}
