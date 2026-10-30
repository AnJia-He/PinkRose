/**
 * **浏览器 canvas → AVIF**（★ 2026-10-20）。
 *
 * canvas 不会编 AVIF；把已经修好的画面编成 PNG，交给本机服务端的 ffmpeg 转。
 * 图片不经过云端，参数只有质量（数值）。
 */
import { blobToDataUrl } from '../image/blob'

/** 和服务端 `AVIF_MAX_SOURCE_BYTES` 同一个数；超过就不发，给一句能照做的提示。 */
export const AVIF_SOURCE_LIMIT = 12 * 1024 * 1024

function canvasBlob(
  canvas: HTMLCanvasElement, type: string, quality?: number,
): Promise<Blob | null> {
  return new Promise(resolve => canvas.toBlob(resolve, type, quality))
}

export async function encodeAvif(
  canvas: HTMLCanvasElement,
  quality: number,
  doFetch: typeof fetch = fetch.bind(globalThis),
): Promise<Blob> {
  // ★ 2026-10-20（大图）：PNG 中间图在 24MP 上很容易超过服务端 12MB 上限。
  // WebP 95 附近同样保留 alpha，体积通常只有 PNG 的 1/3~1/5；Safari 也能本地编。
  // 先试 WebP，再按体积逐级降一档；WebP 不可用才退回 PNG。
  let source: Blob | null = null
  for (const q of [0.88, 0.8, 0.72]) {
    const blob = await canvasBlob(canvas, 'image/webp', q)
    if (!blob || blob.type !== 'image/webp') break
    source = blob
    if (blob.size <= AVIF_SOURCE_LIMIT) break
  }
  if (!source) source = await canvasBlob(canvas, 'image/png')
  if (!source) throw new Error('AVIF 导出失败：画布没有产出图片')
  if (source.size > AVIF_SOURCE_LIMIT) {
    throw new Error('这张图导出 AVIF 的中间图还是太大，先把长边调到 4096 以内再试。')
  }
  const image = await blobToDataUrl(source)
  const res = await doFetch('/api/convert/avif', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ image, quality: Math.round(quality * 100) }),
  })
  if (!res.ok) {
    const detail = await res.json().catch(() => null) as { message?: string } | null
    throw new Error(detail?.message ?? 'AVIF 没转出来，换 JPG / WebP 导出。')
  }
  return res.blob()
}
