/**
 * **从 `<video>` 里逐帧取图**（★ 2026-10-20）。
 *
 * 为什么用"seek 到某一刻 → 画一帧"而不是 `requestVideoFrameCallback`：
 *   · 我们要的是**按固定时间轴出帧**，不是"浏览器解码到哪算哪"；
 *   · Safari 对 `requestVideoFrameCallback` 的支持比 seek 晚，苹果用户会先坏；
 *   · seek 的误差可以靠"多等一帧"兜住，而丢帧是补不回来的。
 *
 * ⚠️ 画面必须按目标尺寸**cover 铺满**：手机竖拍 9:16 和 16:9 的横屏
 *   导出到同一个尺寸时，直接拉伸会把脸拉长。
 */
import { makeCanvas } from '../core/canvas'

export type VideoFrameSize = { width: number; height: number }

/** 等一个一次性事件；超时抛中文错误（视频元数据读不出来时别让人干等）。 */
export function waitForMediaEvent(
  target: EventTarget,
  event: string,
  timeoutMs: number,
  message: string,
): Promise<void> {
  return new Promise((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | null = null
    const done = () => {
      if (timer) clearTimeout(timer)
      target.removeEventListener(event, done)
      target.removeEventListener('error', fail)
      resolve()
    }
    const fail = () => {
      if (timer) clearTimeout(timer)
      target.removeEventListener(event, done)
      target.removeEventListener('error', fail)
      reject(new Error(message))
    }
    timer = setTimeout(fail, timeoutMs)
    target.addEventListener(event, done, { once: true })
    target.addEventListener('error', fail, { once: true })
  })
}

/** 等到 `loadedmetadata`（已经就绪就直接返回）。 */
export async function ensureVideoReady(video: HTMLVideoElement): Promise<void> {
  if (video.readyState >= 1 && video.duration > 0) return
  await waitForMediaEvent(video, 'loadedmetadata', 20_000, '这段视频读不出来，换一个文件试试。')
}

/**
 * 把视频 seek 到 `timeMs` 并等画面真的换过去。
 * 同一时刻重复 seek 浏览器不会再发 `seeked`，所以先比一下。
 */
export async function seekVideo(video: HTMLVideoElement, timeMs: number): Promise<void> {
  const seconds = Math.max(0, timeMs / 1000)
  if (Math.abs(video.currentTime - seconds) < 0.001) return
  const wait = waitForMediaEvent(video, 'seeked', 10_000, '这一帧没取出来，再试一次。')
  video.currentTime = seconds
  await wait
}

/** 按 cover 把当前画面画进一张固定尺寸的 canvas。 */
export function drawVideoCover(
  video: HTMLVideoElement, canvas: HTMLCanvasElement, size: VideoFrameSize,
): void {
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('这台设备画不出视频帧')
  const sw = Math.max(1, video.videoWidth)
  const sh = Math.max(1, video.videoHeight)
  const scale = Math.max(size.width / sw, size.height / sh)
  const dw = sw * scale
  const dh = sh * scale
  ctx.fillStyle = '#000'
  ctx.fillRect(0, 0, size.width, size.height)
  ctx.drawImage(video, (size.width - dw) / 2, (size.height - dh) / 2, dw, dh)
}

/** 一张"取帧用"的画布；调用方负责复用（每帧新建一张会把内存打满）。 */
export function createFrameCanvas(size: VideoFrameSize): HTMLCanvasElement {
  const { canvas } = makeCanvas(size.width, size.height, '短片帧画布建不出来')
  return canvas
}
