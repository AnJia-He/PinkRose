import { makeCanvas } from '../core/canvas'
import { detectFaceBox, detectFaceBoxes, type FaceBox } from '../core/faceDetect'

/**
 * 人脸框在长边 ≤640 的副本上估，再按比例放回原图。640 足够稳定，
 * 也不会让 12 MP 照片的打开动作卡在主线程上。
 */
export async function detectFaceInBitmap(source: ImageBitmap): Promise<FaceBox | null> {
  const scale = Math.min(1, 640 / Math.max(1, Math.max(source.width, source.height)))
  const w = Math.max(1, Math.round(source.width * scale))
  const h = Math.max(1, Math.round(source.height * scale))
  const { ctx } = makeCanvas(w, h, '认不出人脸', { willReadFrequently: true })
  ctx.drawImage(source, 0, 0, w, h)
  const image = ctx.getImageData(0, 0, w, h)
  const face = detectFaceBox(image.data, w, h)
  if (!face) return null
  const k = source.width / w
  return {
    x: face.x * k,
    y: face.y * k,
    w: face.w * k,
    h: face.h * k,
    confidence: face.confidence,
  }
}

/**
 * 合影版本：同一张 640px 预览上找多张脸，再按比例放回原图。
 * 单脸链路保持不变，避免影响编辑器现有的人像框和测试。
 */
export async function detectFacesInBitmap(
  source: ImageBitmap, maxFaces = 6,
): Promise<FaceBox[]> {
  const scale = Math.min(1, 640 / Math.max(1, Math.max(source.width, source.height)))
  const w = Math.max(1, Math.round(source.width * scale))
  const h = Math.max(1, Math.round(source.height * scale))
  const { ctx } = makeCanvas(w, h, '认不出人脸', { willReadFrequently: true })
  ctx.drawImage(source, 0, 0, w, h)
  const image = ctx.getImageData(0, 0, w, h)
  const faces = detectFaceBoxes(image.data, w, h, maxFaces)
  if (faces.length === 0) return []
  const k = source.width / w
  return faces.map(face => ({
    x: face.x * k,
    y: face.y * k,
    w: face.w * k,
    h: face.h * k,
    confidence: face.confidence,
  }))
}
