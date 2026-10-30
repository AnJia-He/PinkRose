import { makeCanvas } from '../core/canvas'
import { decodeImageFile } from '../image/decode'
import type { GifFit } from './gif'

/**
 * 照片视频（MP4）客户端（★ 2026-10-20）。
 *
 * GIF 在 Safari 也能做，但只有 256 色。MP4 交给本机 Node 服务端的 ffmpeg：
 *   ① 浏览器先把每张照片按目标画幅画成 JPEG 帧（尺寸、留白、裁切都在本地完成）；
 *   ② 帧通过同源 `/api/motion` 发给服务端，ffmpeg 编成 H.264；
 *   ③ 返回 Blob 直接下载。苹果端不需要 MediaRecorder。
 */

export type MotionOptions = {
  width: number
  height: number
  delayMs: number
  fit?: GifFit
  background?: string
}

async function renderJpegFrames(
  files: readonly File[], options: MotionOptions,
): Promise<string[]> {
  const width = Math.max(64, Math.round(options.width))
  const height = Math.max(64, Math.round(options.height))
  const fit: GifFit = options.fit ?? 'cover'
  const { canvas, ctx } = makeCanvas(width, height, '照片视频帧画不出来')
  const decoded: Awaited<ReturnType<typeof decodeImageFile>>[] = []
  try {
    for (const file of files) decoded.push(await decodeImageFile(file))
    const frames: string[] = []
    for (const item of decoded) {
      const sw = Math.max(1, item.width)
      const sh = Math.max(1, item.height)
      const scale = fit === 'cover'
        ? Math.max(width / sw, height / sh)
        : Math.min(width / sw, height / sh)
      const dw = sw * scale
      const dh = sh * scale
      ctx.fillStyle = options.background ?? '#ffffff'
      ctx.fillRect(0, 0, width, height)
      ctx.drawImage(item.bitmap, (width - dw) / 2, (height - dh) / 2, dw, dh)
      frames.push(canvas.toDataURL('image/jpeg', 0.9))
    }
    return frames
  } finally {
    for (const item of decoded) item.bitmap.close()
  }
}

export async function renderMotionMp4(
  files: readonly File[], options: MotionOptions,
): Promise<Blob> {
  const frames = await renderJpegFrames(files, options)
  const res = await fetch('/api/motion', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      frames,
      width: Math.max(64, Math.round(options.width)),
      height: Math.max(64, Math.round(options.height)),
      frameMs: options.delayMs,
    }),
  })
  if (!res.ok) {
    let message = '照片视频没生成，再试一次。'
    try {
      const body = await res.json() as { error?: { message?: string } }
      if (body.error?.message) message = body.error.message
    } catch { /* 非 JSON 错误沿用兜底文案 */ }
    throw new Error(message)
  }
  return res.blob()
}
