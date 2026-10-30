/**
 * **短片导出编排**（★ 2026-10-20）。
 *
 * 一条链路：开会话 → 传源片（为了原声）→ 逐帧 seek / 渲染 / 编 JPEG →
 * 分批上传 → ffmpeg 收尾 → 拿回 MP4。任何一步失败都**尽力删掉会话**，
 * 不在本机临时目录里留下几十 MB 的帧。
 *
 * ⚠️ 渲染走的是**同一条 `TonePipeline`**（和照片完全相同的着色器），
 *   所以「胶片」「柔光人像」这些预设套在视频上，颜色不会被第二套实现带偏。
 * ⚠️ 帧率是"按时间轴取帧"，不是"按解码帧复制"：12fps 导出 30fps 素材时
 *   每个时刻取最近的一帧，播放速度不变、文件变小。
 */
import type { Adjustments } from '../../shared/adjustments.ts'
import type { Cube } from '../../shared/lut.ts'
import type { VideoAspect } from '../../shared/video.ts'
import { TonePipeline } from '../render/pipeline'
import { VIDEO_FRAME_BATCH, VIDEO_MAX_SECONDS } from '../../shared/video.ts'
import { videoFramePlan, videoOutputSize, type VideoSpeed } from './plan'
import {
  createFrameCanvas, drawVideoCover, ensureVideoReady, seekVideo,
} from './frames'
import { captionAt, paintCaption, type VideoCaption } from './captions'
import {
  deleteVideoSession, finishVideoSession, openVideoSession, uploadVideoFrames,
  uploadVideoMusic, uploadVideoSource,
} from './session'

export type VideoClipSource = {
  file: File
  /** 预览用的 blob URL；导出时同一个 `<video>` 会按段切 `src`。 */
  url: string
  startMs: number
  endMs: number
  meta: { width: number; height: number; durationMs: number }
}

export type VideoExportOptions = {
  clips: VideoClipSource[]
  /** 只用一个 `<video>`：多段时逐段换 `src`，手机上不会同时开 6 个解码器。 */
  video: HTMLVideoElement
  fps: number
  /** 变速倍数；缺省 1×。 */
  speed?: VideoSpeed
  /** 成片画幅；缺省跟原片一样。 */
  aspect?: VideoAspect
  /** 保留原声（默认 true）。关掉就不传源片、也不带音轨。 */
  keepAudio?: boolean
  /** 背景音乐；选了就上传并在成片里按模式混合 / 替换。 */
  music?: { file: File; mode: 'mix' | 'replace'; volume: number } | null
  /** 烧进画面的字幕（全片时间轴）。 */
  captions?: readonly VideoCaption[]
  adjustments: Adjustments
  lut?: { cube: Cube; amount: number } | null
  onProgress?: (done: number, total: number, stage: 'render' | 'upload' | 'encode') => void
  signal?: AbortSignal
}

export type VideoExportDeps = {
  fetch?: typeof fetch
  /** 出一帧 JPEG data URL（测试里直接给）。 */
  renderFrame?: (clipIndex: number, timeMs: number, filmTimeMs: number) => Promise<string>
  /** 编码完成后收尾（测试里给假实现）。 */
  finish?: (sessionId: string, body: {
    clips: {
      startMs: number; durationMs: number;
      sourceDurationMs?: number; speed?: number
    }[]
    width: number; height: number; fps: number; keepAudio: boolean
    music: { mode: 'mix' | 'replace'; volume: number } | null
  }) => Promise<Blob>
}

function abortError(): Error {
  return new DOMException('导出已取消', 'AbortError')
}

/** 真实渲染器：一条管线 + 两张画布，用完 `dispose()`。 */
async function createRenderer(
  options: VideoExportOptions, size: { width: number; height: number },
) {
  const sourceCanvas = createFrameCanvas(size)
  const outCanvas = document.createElement('canvas')
  const plateCanvas = document.createElement('canvas')
  const pipe = new TonePipeline(outCanvas)
  pipe.setLut(options.lut?.cube ?? null)
  return {
    async frame(clipIndex: number, timeMs: number, filmTimeMs: number): Promise<string> {
      const video = options.video
      const clip = options.clips[clipIndex]!
      if (video.getAttribute('src') !== clip.url) {
        video.src = clip.url
        video.load()
        await ensureVideoReady(video)
      }
      await seekVideo(video, timeMs)
      drawVideoCover(video, sourceCanvas, size)
      const bitmap = await createImageBitmap(sourceCanvas)
      try {
        pipe.setImage({ bitmap, width: size.width, height: size.height })
        pipe.resizeToImage()
        pipe.render(options.adjustments, options.lut?.amount ?? 0)
        const caption = captionAt(options.captions ?? [], filmTimeMs)
        if (!caption) return outCanvas.toDataURL('image/jpeg', 0.85)
        // WebGL 画布没有 2D 上下文：先拷贝到一张 2D 画布再画字。
        plateCanvas.width = size.width
        plateCanvas.height = size.height
        const plate = plateCanvas.getContext('2d')
        if (!plate) return outCanvas.toDataURL('image/jpeg', 0.85)
        plate.drawImage(outCanvas, 0, 0)
        paintCaption(plate, caption, size.width, size.height)
        return plateCanvas.toDataURL('image/jpeg', 0.85)
      } finally {
        bitmap.close()
      }
    },
    dispose() {
      pipe.dispose()
    },
  }
}

export async function exportVideo(
  options: VideoExportOptions, deps: VideoExportDeps = {},
): Promise<Blob> {
  if (options.clips.length === 0) throw new Error('先选一段短片。')
  const doFetch = deps.fetch ?? fetch.bind(globalThis)
  if (!deps.renderFrame) await ensureVideoReady(options.video)
  const metas = options.clips.map(clip => clip.meta)
  const plans = options.clips.map((clip, index) => videoFramePlan(
    { startMs: clip.startMs, endMs: clip.endMs }, metas[index]!.durationMs,
    options.fps, options.speed ?? 1,
  ))
  const totalMs = plans.reduce((sum, plan) => sum + plan.durationMs, 0)
  if (totalMs > VIDEO_MAX_SECONDS * 1000) {
    throw new Error(`几段加起来不能超过 ${VIDEO_MAX_SECONDS} 秒（现在 ${(totalMs / 1000).toFixed(1)} 秒）。`)
  }
  // 画幅来自第一段：多段拼接时每一段都按同一个画幅 cover 裁切。
  const size = videoOutputSize(
    metas[0]!.width, metas[0]!.height, undefined, options.aspect ?? 'source',
  )
  const keepAudio = options.keepAudio !== false
  const music = options.music ?? null
  const needSources = keepAudio && music?.mode !== 'replace'

  const session = await openVideoSession(doFetch)

  let renderer: Awaited<ReturnType<typeof createRenderer>> | null = null
  const cleanup = () => {
    renderer?.dispose()
    renderer = null
    void deleteVideoSession(session, doFetch)
  }

  try {
    // 静音导出不需要源片：少传一个几百 MB 的文件，也少一个失败点。
    if (needSources) {
      for (const [index, clip] of options.clips.entries()) {
        await uploadVideoSource(session, index, clip.file, doFetch)
      }
    }
    if (music) {
      await uploadVideoMusic(session, music.file, doFetch)
    }

    if (!deps.renderFrame) renderer = await createRenderer(options, size)
    let filmOffset = 0
    const jobs = plans.flatMap((plan, clipIndex) => {
      const offset = filmOffset
      filmOffset += plan.durationMs
      return plan.times.map(time => ({
        clipIndex,
        time,
        filmTime: offset + (time - options.clips[clipIndex]!.startMs),
      }))
    })
    const total = jobs.length
    for (let start = 0; start < total; start += VIDEO_FRAME_BATCH) {
      if (options.signal?.aborted) throw abortError()
      const slice = jobs.slice(start, start + VIDEO_FRAME_BATCH)
      const frames: string[] = []
      for (const job of slice) {
        if (options.signal?.aborted) throw abortError()
        frames.push(deps.renderFrame
          ? await deps.renderFrame(job.clipIndex, job.time, job.filmTime)
          : await renderer!.frame(job.clipIndex, job.time, job.filmTime))
        options.onProgress?.(frames.length + start, total, 'render')
      }
      await uploadVideoFrames(session, start, frames, doFetch)
    }

    options.onProgress?.(total, total, 'encode')
    const body = {
      clips: plans.map((plan, index) => ({
        startMs: Math.round(options.clips[index]!.startMs),
        durationMs: Math.round(plan.durationMs),
        sourceDurationMs: Math.round(plan.sourceDurationMs),
        speed: plan.speed,
      })),
      width: size.width,
      height: size.height,
      fps: options.fps,
      keepAudio,
      music: music ? { mode: music.mode, volume: music.volume } : null,
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
  }
}
