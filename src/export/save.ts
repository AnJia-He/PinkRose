import piexif from 'piexifjs'

export type ExportFormat = 'image/jpeg' | 'image/png'

export function buildFilename(original: string, format: ExportFormat): string {
  const ext = format === 'image/png' ? 'png' : 'jpg'
  const stem = original.replace(/\.[^.]+$/, '')
  return `${stem}_ruixing.${ext}`
}

/**
 * 导出画布内容为文件下载。JPEG 时把原图的 EXIF 写回去（spec §5.4）。
 *
 * 为什么要写回 EXIF：canvas.toBlob() 产出的图不带原始 EXIF，
 * 拍摄时间和 GPS 会丢，而旅游照的时间地点对用户有意义。
 */
export async function exportImage(
  canvas: HTMLCanvasElement,
  originalFile: File,
  format: ExportFormat = 'image/jpeg',
  quality = 0.95,
): Promise<void> {
  const blob = await new Promise<Blob | null>(res => canvas.toBlob(res, format, quality))
  if (!blob) throw new Error('导出失败：canvas 没有产出图片')

  let payload: Blob = blob

  if (format === 'image/jpeg') {
    try {
      payload = await withExif(blob, originalFile)
    } catch (e) {
      // EXIF 写回失败不该挡住用户拿到图，降级为不带 EXIF 保存
      console.warn('EXIF 写回失败，照常导出（无 EXIF）', e)
    }
  }

  const url = URL.createObjectURL(payload)
  const a = document.createElement('a')
  a.href = url
  a.download = buildFilename(originalFile.name, format)
  a.click()
  URL.revokeObjectURL(url)
}

async function withExif(blob: Blob, originalFile: File): Promise<Blob> {
  const originalDataUrl = await fileToDataUrl(originalFile)
  const exifObj = piexif.load(originalDataUrl)

  // 尺寸会变，这两个字段必须清掉，否则看图软件会显示错误信息
  delete exifObj['0th']?.[piexif.ImageIFD.ImageWidth]
  delete exifObj['0th']?.[piexif.ImageIFD.ImageLength]
  delete exifObj['Exif']?.[piexif.ExifIFD.PixelXDimension]
  delete exifObj['Exif']?.[piexif.ExifIFD.PixelYDimension]

  // Orientation 也必须清掉，这条最容易漏。
  //
  // 解码时 createImageBitmap 的 imageOrientation 默认是 'from-image'，
  // 意思是**已经按 EXIF 把画面摆正了**——canvas 上是正立的像素网格。
  // 若再把原始的 Orientation=6（含义是"显示时顺时针转 90°"）写回去，
  // 看图软件会对着已经正立的图**再转一次**，导出图的方向就错了。
  //
  // 竖拍的手机照片几乎全都带 Orientation=6，所以这条不处理必然翻车。
  delete exifObj['0th']?.[piexif.ImageIFD.Orientation]

  const exifBytes = piexif.dump(exifObj)
  const newDataUrl = await blobToDataUrl(blob)
  return dataUrlToBlob(piexif.insert(exifBytes, newDataUrl))
}

function fileToDataUrl(file: File): Promise<string> {
  return new Promise((res, rej) => {
    const r = new FileReader()
    r.onload = () => res(r.result as string)
    r.onerror = () => rej(r.error)
    r.readAsDataURL(file)
  })
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((res, rej) => {
    const r = new FileReader()
    r.onload = () => res(r.result as string)
    r.onerror = () => rej(r.error)
    r.readAsDataURL(blob)
  })
}

function dataUrlToBlob(dataUrl: string): Blob {
  const [head, body] = dataUrl.split(',')
  const mime = head.match(/:(.*?);/)?.[1] ?? 'image/jpeg'
  const bin = atob(body)
  const arr = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i)
  return new Blob([arr], { type: mime })
}
