/**
 * 把一张已经排好的 JPEG 包成单页 PDF（★ 2026-10-20）。
 *
 * 打印店和归档常用 PDF；这里不需要引入 PDF 库：DCTDecode 可以直接嵌入
 * JPEG 原始字节，页面尺寸按 300dpi 换算成 PDF 点（1/72 英寸）。
 */

const encoder = new TextEncoder()

function ascii(value: string): Uint8Array {
  return encoder.encode(value)
}

function number(value: number): string {
  return Number.isFinite(value) ? value.toFixed(3).replace(/\.?0+$/, '') : '0'
}

export function jpegToPdf(
  jpeg: Uint8Array, widthPx: number, heightPx: number, dpi = 300,
): Uint8Array {
  if (jpeg.length === 0 || widthPx <= 0 || heightPx <= 0 || dpi <= 0) {
    throw new Error('PDF 的图片尺寸不对')
  }
  const pageW = (widthPx / dpi) * 72
  const pageH = (heightPx / dpi) * 72
  const content = `q\n${number(pageW)} 0 0 ${number(pageH)} 0 0 cm\n/Im0 Do\nQ\n`
  const chunks: Uint8Array[] = []
  const offsets: number[] = []
  let size = 0
  const push = (part: string | Uint8Array) => {
    const bytes = typeof part === 'string' ? ascii(part) : part
    chunks.push(bytes)
    size += bytes.length
  }
  const object = (body: string) => {
    offsets.push(size)
    push(body)
  }

  push('%PDF-1.4\n')
  object('1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n')
  object('2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n')
  object(
    `3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${number(pageW)} ${number(pageH)}]`
    + ` /Resources << /XObject << /Im0 4 0 R >> >> /Contents 5 0 R >>\nendobj\n`,
  )
  offsets.push(size)
  push(
    `4 0 obj\n<< /Type /XObject /Subtype /Image /Width ${Math.round(widthPx)}`
    + ` /Height ${Math.round(heightPx)} /ColorSpace /DeviceRGB /BitsPerComponent 8`
    + ` /Filter /DCTDecode /Length ${jpeg.length} >>\nstream\n`,
  )
  push(jpeg)
  push('\nendstream\nendobj\n')
  const contentBytes = ascii(content)
  object(`5 0 obj\n<< /Length ${contentBytes.length} >>\nstream\n${content}\nendstream\nendobj\n`)
  const xrefStart = size
  push(`xref\n0 6\n0000000000 65535 f \n`)
  for (const offset of offsets) {
    push(`${String(offset).padStart(10, '0')} 00000 n \n`)
  }
  push(`trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`)

  const out = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    out.set(chunk, offset)
    offset += chunk.length
  }
  return out
}
