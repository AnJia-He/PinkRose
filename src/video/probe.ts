/**
 * **导入时读一段视频的元数据**（★ 2026-10-20）。
 *
 * 用一个临时 `<video>` 读 `loadedmetadata`，读完立刻把 `src` 摘掉 ——
 * 用户可能一次选六段，不能为了拿时长在页面里常驻六个解码器。
 *
 * 读不出来（浏览器不支持这个编码）时抛中文错误，由面板决定怎么显示。
 */
import { waitForMediaEvent } from './frames'

export type VideoFileMeta = {
  width: number
  height: number
  durationMs: number
}

export function probeVideoFile(file: File, url?: string): Promise<VideoFileMeta> {
  const ownUrl = url ? null : URL.createObjectURL(file)
  const video = document.createElement('video')
  video.preload = 'metadata'
  video.muted = true
  video.playsInline = true
  video.src = url ?? ownUrl!
  const cleanup = () => {
    video.removeAttribute('src')
    video.load()
    if (ownUrl) URL.revokeObjectURL(ownUrl)
  }
  return waitForMediaEvent(
    video, 'loadedmetadata', 20_000,
    '这个浏览器打不开这段视频（可能是编码格式不支持）。换成 H.264 的 MP4 再试。',
  ).then(async () => {
    const duration = await readDuration(video)
    const meta = {
      width: video.videoWidth,
      height: video.videoHeight,
      durationMs: Math.round(duration * 1000),
    }
    cleanup()
    if (!Number.isFinite(meta.durationMs) || meta.durationMs <= 0) {
      throw new Error('这段视频读不出时长，换一个文件试试。')
    }
    return meta
  }, (e) => {
    cleanup()
    throw e
  })
}

/**
 * 读时长。**MediaRecorder 录出来的 WebM 没有时长头**（`duration === Infinity`），
 * 直接读会得到 Infinity。经典办法：把 currentTime 顶到极大值，浏览器为了
 * 跳过去会先把整段扫一遍，然后算出真实时长。
 */
async function readDuration(video: HTMLVideoElement): Promise<number> {
  if (Number.isFinite(video.duration) && video.duration > 0) return video.duration
  await new Promise<void>((resolve) => {
    let settled = false
    const done = () => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      video.removeEventListener('durationchange', check)
      video.removeEventListener('timeupdate', check)
      resolve()
    }
    const check = () => {
      if (Number.isFinite(video.duration) && video.duration > 0) done()
    }
    const timer = setTimeout(done, 3000)
    video.addEventListener('durationchange', check)
    video.addEventListener('timeupdate', check)
    try {
      video.currentTime = Number.MAX_SAFE_INTEGER
    } catch {
      done()
    }
  })
  return video.duration
}
