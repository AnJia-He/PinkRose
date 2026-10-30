export const ID_PHOTO_SHEET_WIDTH = 1800
export const ID_PHOTO_SHEET_HEIGHT = 1200

export type SheetPhoto = { x: number; y: number; w: number; h: number }

/**
 * 6 寸相纸 1800×1200（300dpi），默认 4×2 八张，居中排布并留裁切线。
 */
export function layoutIdPhotoSheet(
  photoW: number, photoH: number, cols = 4, rows = 2,
  margin = 60, gap = 28,
): SheetPhoto[] {
  const safeW = Math.max(1, photoW)
  const safeH = Math.max(1, photoH)
  const usableW = ID_PHOTO_SHEET_WIDTH - margin * 2 - gap * (cols - 1)
  const usableH = ID_PHOTO_SHEET_HEIGHT - margin * 2 - gap * (rows - 1)
  const scale = Math.min(1, usableW / (cols * safeW), usableH / (rows * safeH))
  const w = Math.max(1, Math.round(safeW * scale))
  const h = Math.max(1, Math.round(safeH * scale))
  const totalW = cols * w + gap * (cols - 1)
  const totalH = rows * h + gap * (rows - 1)
  const x0 = Math.round((ID_PHOTO_SHEET_WIDTH - totalW) / 2)
  const y0 = Math.round((ID_PHOTO_SHEET_HEIGHT - totalH) / 2)
  const out: SheetPhoto[] = []
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      out.push({
        x: x0 + col * (w + gap),
        y: y0 + row * (h + gap),
        w, h,
      })
    }
  }
  return out
}

export async function renderIdPhotoSheet(
  photo: Blob, cols = 4, rows = 2,
): Promise<{ blob: Blob; width: number; height: number }> {
  const bitmap = await createImageBitmap(photo)
  try {
    const canvas = document.createElement('canvas')
    canvas.width = ID_PHOTO_SHEET_WIDTH
    canvas.height = ID_PHOTO_SHEET_HEIGHT
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('拿不到 2D 上下文，排不了版')
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, canvas.width, canvas.height)
    const cells = layoutIdPhotoSheet(bitmap.width, bitmap.height, cols, rows)
    for (const cell of cells) {
      ctx.drawImage(bitmap, cell.x, cell.y, cell.w, cell.h)
      ctx.strokeStyle = 'rgba(0, 0, 0, .18)'
      ctx.lineWidth = 1
      ctx.strokeRect(cell.x + 0.5, cell.y + 0.5, cell.w - 1, cell.h - 1)
    }
    const blob = await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob(
        b => (b ? resolve(b) : reject(new Error('浏览器没有生成排版文件'))),
        'image/jpeg', 0.95,
      )
    })
    return { blob, width: canvas.width, height: canvas.height }
  } finally {
    bitmap.close()
  }
}
