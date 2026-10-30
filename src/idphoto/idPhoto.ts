import type { FaceBox } from '../core/faceDetect'
import { makeCanvas } from '../core/canvas'
import { decodeImageFile } from '../image/decode'
import { detectFaceInBitmap } from '../image/faceDetect'
import { selectSubjectToMask } from '../image/backgroundSelect'
import { replaceBackgroundToBitmap } from '../image/backgroundReplace'

export type IdPhotoSize = {
  id: string
  label: string
  width: number
  height: number
  note: string
}

export const ID_PHOTO_SIZES: readonly IdPhotoSize[] = [
  { id: 'one', label: '一寸', width: 295, height: 413, note: '25 × 35 mm' },
  { id: 'two', label: '二寸', width: 413, height: 579, note: '35 × 49 mm' },
  { id: 'small-two', label: '小二寸', width: 390, height: 567, note: '33 × 48 mm' },
  { id: 'visa', label: '签证', width: 413, height: 531, note: '35 × 45 mm' },
] as const

export type IdPhotoBackground = {
  id: string
  label: string
  color: string
}

export const ID_PHOTO_BACKGROUNDS: readonly IdPhotoBackground[] = [
  { id: 'white', label: '白底', color: '#ffffff' },
  { id: 'blue', label: '蓝底', color: '#438edb' },
  { id: 'red', label: '红底', color: '#d63b3b' },
  { id: 'gray', label: '浅灰', color: '#e7e2dc' },
] as const

export type CropRect = { x: number; y: number; w: number; h: number }

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v))

/**
 * 按目标比例从原图取一块：脸高约占画面 58%，头顶留 12%。脸不在正中或贴近
 * 边缘时先把框收回图内；没有脸就取居中的最大目标比例区域。
 */
export function computeIdPhotoCrop(
  face: FaceBox | null, imageW: number, imageH: number,
  outW: number, outH: number,
): CropRect {
  const aspect = outW / outH
  let w: number
  let h: number
  let x: number
  let y: number
  if (face && face.w > 0 && face.h > 0) {
    h = face.h / 0.52
    w = h * aspect
    x = face.x + face.w / 2 - w / 2
    y = face.y - h * 0.18
  } else {
    h = imageH
    w = h * aspect
    if (w > imageW) {
      w = imageW
      h = w / aspect
    }
    x = (imageW - w) / 2
    y = (imageH - h) / 2
  }
  const fit = Math.min(1, imageW / w, imageH / h)
  w *= fit
  h *= fit
  x = clamp(x, 0, Math.max(0, imageW - w))
  y = clamp(y, 0, Math.max(0, imageH - h))
  return {
    x: Math.round(x), y: Math.round(y),
    w: Math.max(1, Math.round(w)), h: Math.max(1, Math.round(h)),
  }
}

export type IdPhotoResult = {
  blob: Blob
  filename: string
  width: number
  height: number
}

export async function renderIdPhoto(
  file: File, size: IdPhotoSize, background: IdPhotoBackground,
): Promise<IdPhotoResult> {
  const decoded = await decodeImageFile(file)
  let cropped: ImageBitmap | null = null
  let subject: ImageBitmap | null = null
  try {
    const face = await detectFaceInBitmap(decoded.bitmap)
    const crop = computeIdPhotoCrop(face, decoded.width, decoded.height, size.width, size.height)
    const { canvas, ctx } = makeCanvas(size.width, size.height, '裁不了证件照')
    ctx.drawImage(decoded.bitmap, crop.x, crop.y, crop.w, crop.h, 0, 0, size.width, size.height)
    cropped = await createImageBitmap(canvas)
    const mask = new Uint8Array(size.width * size.height)
    const picked = await selectSubjectToMask(cropped, mask)
    if (picked.subjectRatio < 0.02 || picked.subjectRatio > 0.95) {
      throw new Error('没认出人物主体，换一张更正、背景更干净的照片试试')
    }
    const composed = await replaceBackgroundToBitmap(cropped, mask, {
      kind: 'color', color: background.color,
    })
    subject = composed.bitmap
    const out = makeCanvas(size.width, size.height, '导出不了证件照')
    out.ctx.drawImage(subject, 0, 0)
    const blob = await new Promise<Blob>((resolve, reject) => {
      out.canvas.toBlob(
        b => (b ? resolve(b) : reject(new Error('浏览器没有生成图片文件'))),
        'image/jpeg', 0.95,
      )
    })
    const base = file.name.replace(/\.[^.]+$/, '') || '证件照'
    return {
      blob,
      filename: `${base}-${size.label}-${background.label}.jpg`,
      width: size.width,
      height: size.height,
    }
  } finally {
    subject?.close()
    cropped?.close()
    decoded.bitmap.close()
  }
}
