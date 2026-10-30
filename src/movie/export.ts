/**
 * **照片电影的导出编排**（★ 2026-10-20）。
 *
 * 把每张照片按时间轴生成一串带缓慢推拉的帧，走和短片完全相同的服务端会话
 * （分批传帧 → ffmpeg 编码 → 接音乐）。没有任何源视频，所以原声一定是关的，
 * 音乐按"替换"模式铺满全片。
 */
import type { Adjustments } from '../../shared/adjustments.ts'
import type { VideoAspect } from '../../shared/video.ts'
import { VIDEO_FRAME_BATCH } from '../../shared/video.ts'
import { decodeImageFile } from '../image/decode'
import { makeCanvas } from '../core/canvas'
import { TonePipeline } from '../render/pipeline'
import { videoOutputSize } from '../video/plan'
import {
  deleteVideoSession, finishVideoSession, openVideoSession, uploadVideoFrames,
  uploadVideoMusic,
} from '../video/session'
import {
  kenBurnsRect, photoMovieTimeline, type PhotoMovieMotion, type PhotoMovieTransition,
} from './plan'

export type PhotoMovieOptions = {
  photos: File[]
  perPhotoMs: number
  motion: PhotoMovieMotion
  /** 两张之间的转场；缺省硬切。 */
  transition?: PhotoMovieTransition
  fps: number
  aspect: VideoAspect
  adjustments: Adjustments
  music?: { file: File; volume: number } | null
  onProgress?: (done: number, total: number, stage: 'render' | 'upload' | 'encode') => void
  signal?: AbortSignal
}

export type PhotoMovieDeps = {
  fetch?: typeof fetch
  renderFrame?: (
    photoIndex: number, frameIndex: number, framesPerPhoto: number,
  ) => Promise<string>
  /** 转场帧：把前一张的尾帧与后一张的头帧按 alpha 混合。 */
  renderBlend?: (
    fromPhoto: number, fromFrame: number, toPhoto: number, toFrame: number,
    framesPerPhoto: number, alpha: number,
  ) => Promise<string>
  finish?: (sessionId: string, body: {
    clips: { startMs: number; durationMs: number }[]
    width: number; height: number; fps: number; keepAudio: boolean
    music: { mode: 'mix' | 'replace'; volume: number } | null
  }) => Promise<Blob>
}

function abortError(): Error {
  return new DOMException('导出已取消', 'AbortError')
}

export async function exportPhotoMovie(
  options: PhotoMovieOptions, deps: PhotoMovieDeps = {},
): Promise<Blob> {
  if (options.photos.length === 0) throw new Error('先选照片。')
  const plan = photoMovieTimeline(
    options.photos.length, options.perPhotoMs, options.fps, options.transition ?? 'cut',
  )
  const doFetch = deps.fetch ?? fetch.bind(globalThis)
  const session = await openVideoSession(doFetch)

  const decoded: Awaited<ReturnType<typeof decodeImageFile>>[] = []
  let renderer: ReturnType<typeof createRenderer> | null = null
  const cleanup = () => {
    renderer?.dispose()
    renderer = null
    for (const item of decoded) item.bitmap.close()
    void deleteVideoSession(session, doFetch)
  }

  try {
    if (!deps.renderFrame) {
      for (const file of options.photos) decoded.push(await decodeImageFile(file))
    }
    const first = decoded[0]
    const size = videoOutputSize(
      first?.width ?? 1080, first?.height ?? 1080, undefined, options.aspect,
    )
    if (!deps.renderFrame) renderer = createRenderer(options, decoded, size)

    if (options.music) await uploadVideoMusic(session, options.music.file, doFetch)

    const total = plan.totalFrames
    let done = 0
    const frames: string[] = []
    const emit = async (frame: string) => {
      frames.push(frame)
      done++
      options.onProgress?.(done, total, 'render')
      if (frames.length >= VIDEO_FRAME_BATCH) {
        await uploadVideoFrames(session, done - frames.length, frames, doFetch)
        frames.length = 0
      }
    }
    const overlap = plan.overlapFrames
    for (let shotIndex = 0; shotIndex < plan.shots.length; shotIndex++) {
      const shot = plan.shots[shotIndex]!
      // 淡入淡出时：第一张不跳头，最后一张不留尾；中间的头部和尾部都交给转场。
      const startFrame = shotIndex === 0 ? 0 : overlap
      const endFrame = shotIndex === plan.shots.length - 1
        ? shot.frames
        : shot.frames - overlap
      for (let index = startFrame; index < endFrame; index++) {
        if (options.signal?.aborted) throw abortError()
        await emit(deps.renderFrame
          ? await deps.renderFrame(shot.photoIndex, index, shot.frames)
          : await renderer!.frame(shot.photoIndex, index, shot.frames))
      }
      if (overlap > 0 && shotIndex < plan.shots.length - 1) {
        const next = plan.shots[shotIndex + 1]!
        for (let index = 0; index < overlap; index++) {
          if (options.signal?.aborted) throw abortError()
          const alpha = (index + 1) / (overlap + 1)
          await emit(deps.renderBlend
            ? await deps.renderBlend(
              shot.photoIndex, shot.frames - overlap + index,
              next.photoIndex, index, shot.frames, alpha,
            )
            : await renderer!.blend(
              shot.photoIndex, shot.frames - overlap + index,
              next.photoIndex, index, shot.frames, alpha,
            ))
        }
      }
    }
    if (frames.length > 0) {
      await uploadVideoFrames(session, done - frames.length, frames, doFetch)
      frames.length = 0
    }

    options.onProgress?.(total, total, 'encode')
    const body = {
      // 没有源音轨；这一段只用来告诉服务端成片总长（配乐按它循环 / 截断）。
      clips: [{ startMs: 0, durationMs: plan.totalMs }],
      width: size.width,
      height: size.height,
      fps: options.fps,
      keepAudio: false,
      music: options.music
        ? { mode: 'replace' as const, volume: options.music.volume }
        : null,
    }
    const blob = deps.finish
      ? await deps.finish(session.id, body)
      : await finishVideoSession(session, body, doFetch)
    return blob
  } catch (e) {
    cleanup()
    throw e
  } finally {
    renderer?.dispose()
    for (const item of decoded) item.bitmap.close()
  }
}

function createRenderer(
  options: PhotoMovieOptions,
  photos: Awaited<ReturnType<typeof decodeImageFile>>[],
  size: { width: number; height: number },
) {
  const { canvas: sourceCanvas, ctx } = makeCanvas(size.width, size.height, '电影帧画不出来')
  const outCanvas = document.createElement('canvas')
  const blendCanvas = document.createElement('canvas')
  blendCanvas.width = size.width
  blendCanvas.height = size.height
  const blendCtx = blendCanvas.getContext('2d')
  const pipe = new TonePipeline(outCanvas)
  pipe.setLut(null)
  /** 渲染一帧到 outCanvas（调用方必须在下一帧之前把它用掉）。 */
  async function paint(photoIndex: number, frameIndex: number, frames: number) {
    const photo = photos[photoIndex]!
    const progress = frames <= 1 ? 0 : frameIndex / (frames - 1)
    const rect = kenBurnsRect(photo, size, progress, options.motion, photoIndex)
    ctx.fillStyle = '#000'
    ctx.fillRect(0, 0, size.width, size.height)
    ctx.drawImage(photo.bitmap, rect.dx, rect.dy, rect.dw, rect.dh)
    const bitmap = await createImageBitmap(sourceCanvas)
    try {
      pipe.setImage({ bitmap, width: size.width, height: size.height })
      pipe.resizeToImage()
      pipe.render(options.adjustments, 0)
    } finally {
      bitmap.close()
    }
  }
  return {
    async frame(photoIndex: number, frameIndex: number, frames: number): Promise<string> {
      await paint(photoIndex, frameIndex, frames)
      return outCanvas.toDataURL('image/jpeg', 0.85)
    },
    async blend(
      fromPhoto: number, fromFrame: number, toPhoto: number, toFrame: number,
      frames: number, alpha: number,
    ): Promise<string> {
      await paint(fromPhoto, fromFrame, frames)
      if (!blendCtx) {
        await paint(toPhoto, toFrame, frames)
        return outCanvas.toDataURL('image/jpeg', 0.85)
      }
      blendCtx.globalAlpha = 1
      blendCtx.clearRect(0, 0, size.width, size.height)
      blendCtx.drawImage(outCanvas, 0, 0)
      await paint(toPhoto, toFrame, frames)
      blendCtx.globalAlpha = Math.max(0, Math.min(1, alpha))
      blendCtx.drawImage(outCanvas, 0, 0)
      blendCtx.globalAlpha = 1
      return blendCanvas.toDataURL('image/jpeg', 0.85)
    },
    dispose() {
      pipe.dispose()
    },
  }
}
