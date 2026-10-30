/**
 * 浏览器 canvas → HEIC。
 *
 * HEIC 容器由本机服务端的系统编码器生成。客户端先把已经修好的画面编成
 * JPEG 源图：这样不依赖 sips 是否能读 WebP，也不会因为透明 PNG 太大而
 * 撞服务端上限。图片不经过云端。
 */
import { blobToDataUrl } from '../image/blob'

/** 服务端同一个上限；超过就先降到更小的 JPEG 质量。 */
export const HEIC_SOURCE_LIMIT = 24 * 1024 * 1024

function canvasBlob(
  canvas: HTMLCanvasElement, type: string, quality?: number,
): Promise<Blob | null> {
  return new Promise(resolve => canvas.toBlob(resolve, type, quality))
}

export async function encodeHeic(
  canvas: HTMLCanvasElement,
  quality: number,
  doFetch: typeof fetch = fetch.bind(globalThis),
): Promise<Blob> {
  let source: Blob | null = null
  for (const q of [0.98, 0.92, 0.84]) {
    const blob = await canvasBlob(canvas, 'image/jpeg', q)
    if (!blob) break
    source = blob
    if (blob.size <= HEIC_SOURCE_LIMIT) break
  }
  if (!source) throw new Error('HEIC 导出失败：画布没有产出图片')
  if (source.size > HEIC_SOURCE_LIMIT) {
    throw new Error('这张图导出 HEIC 的源图太大，先把长边调到 4096 以内再试。')
  }
  const image = await blobToDataUrl(source)
  const res = await doFetch('/api/convert/heic', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ image, quality: Math.round(quality * 100) }),
  })
  if (!res.ok) {
    const detail = await res.json().catch(() => null) as {
      message?: string
      error?: { message?: string }
    } | null
    throw new Error(detail?.error?.message ?? detail?.message
      ?? 'HEIC 没转出来，换 JPG 或 WebP 导出。')
  }
  const blob = await res.blob()
  return blob.type ? blob : new Blob([blob], { type: 'image/heic' })
}
