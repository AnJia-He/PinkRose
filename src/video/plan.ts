/**
 * **短片调色的时间轴规划**（★ 2026-10-20）。
 *
 * 视频和照片最大的不同：一帧只修一次很快，540 帧串起来就是"这张图要修 540 遍"。
 * 所以这里把"为哪几帧出图、每个时刻取哪一刻、输出多大"算清楚，**纯函数、可测**：
 *
 *   · 帧时刻 = 起点 + n / fps，最后一帧不越过终点；
 *   · 输出尺寸不超过长边上限，**宽高都取偶数** —— H.264 的 yuv420p 要求偶数，
 *     奇数尺寸在 ffmpeg 那里会直接失败，而且报错要翻半天才看明白；
 *   · 时长上限挡在**取帧之前**：先告诉用户"先剪到 20 秒内"，而不是让他等十分钟。
 *
 * ⚠️ 上限不是"产品觉得你拍得太长"，是本地逐帧渲染的内存/时间预算：
 *   24fps × 20 秒 = 480 帧，一帧 1280 长边的 JPEG 约 100–250KB。
 */

export {
  VIDEO_FPS_OPTIONS, VIDEO_FRAME_BATCH, VIDEO_MAX_FRAME_BYTES, VIDEO_MAX_LONG_EDGE,
  VIDEO_MAX_SECONDS, VIDEO_MAX_SOURCE_BYTES, VIDEO_MIN_SECONDS,
} from '../../shared/video.ts'

import {
  VIDEO_FPS_OPTIONS, VIDEO_MAX_LONG_EDGE, VIDEO_MAX_SECONDS, VIDEO_MIN_SECONDS,
} from '../../shared/video.ts'
import type { VideoAspect } from '../../shared/video.ts'

export type VideoRange = { startMs: number; endMs: number }

export type VideoPlan = {
  /** 每一帧在原视频时间轴上的时刻（毫秒）。 */
  times: number[]
  fps: number
  /** 成片时长（变速之后的时长）。 */
  durationMs: number
  /** 这一段在原片里占的时长（变速之前的时长）。 */
  sourceDurationMs: number
  /** 变速倍数：0.5 / 1 / 2。 */
  speed: VideoSpeed
}

/** 变速倍数。音频用 ffmpeg 的 atempo 同步拉伸（0.5–2.0 都在它支持范围内）。 */
export const VIDEO_SPEEDS = [0.5, 1, 2] as const
export type VideoSpeed = (typeof VIDEO_SPEEDS)[number]

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

/**
 * 算出要取哪些帧。`startMs` / `endMs` 会被夹进 `[0, durationMs]`，
 * 起点不晚于终点；太短或太长的区间**抛中文错误**（调用方直接展示）。
 */
export function videoFramePlan(
  range: VideoRange, durationMs: number, fps: number, speed: VideoSpeed = 1,
): VideoPlan {
  if (!Number.isFinite(durationMs) || durationMs <= 0) {
    throw new Error('这段视频读不出时长，换一个文件试试。')
  }
  if (!VIDEO_FPS_OPTIONS.includes(fps as 12 | 24)) {
    throw new Error('帧率只能是 12 或 24。')
  }
  if (!VIDEO_SPEEDS.includes(speed)) {
    throw new Error('速度只能是 0.5× / 1× / 2×。')
  }
  const startMs = clamp(Number.isFinite(range.startMs) ? range.startMs : 0, 0, durationMs)
  const endMs = clamp(Number.isFinite(range.endMs) ? range.endMs : durationMs, 0, durationMs)
  const span = endMs - startMs
  // 上下限都按**成片时长**算：2× 的 1 秒素材只出 0.5 秒，0.5× 的 20 秒素材
  // 会变成 40 秒 —— 后者不允许。
  const outSpan = span / speed
  if (outSpan < VIDEO_MIN_SECONDS * 1000) {
    throw new Error(`至少留 ${VIDEO_MIN_SECONDS} 秒再导出。`)
  }
  if (outSpan > VIDEO_MAX_SECONDS * 1000) {
    throw new Error(`先剪到 ${VIDEO_MAX_SECONDS} 秒以内再导出（现在 ${(outSpan / 1000).toFixed(1)} 秒）。`)
  }
  const count = Math.max(2, Math.round((outSpan / 1000) * fps))
  // 每个输出帧在源片上跨过的时长 = 源片区间 / 帧数（0.5× 时更大，2× 时更小）。
  const step = span / count
  const times: number[] = []
  for (let i = 0; i < count; i++) times.push(startMs + step * i)
  return { times, fps, durationMs: outSpan, sourceDurationMs: span, speed }
}

/**
 * 输出尺寸：长边不超过 `maxLongEdge`，保持比例，**宽高都取偶数**。
 * 源视频本身是奇数尺寸时也照样能出片（先缩到偶数，不裁内容）。
 */
export function videoOutputSize(
  width: number, height: number, maxLongEdge = VIDEO_MAX_LONG_EDGE,
  aspect: VideoAspect = 'source',
): { width: number; height: number } {
  const w = Math.max(2, Math.round(width))
  const h = Math.max(2, Math.round(height))
  const even = (value: number) => Math.max(2, Math.round(value / 2) * 2)
  if (aspect === 'source') {
    const scale = Math.min(1, maxLongEdge / Math.max(w, h))
    return { width: even(w * scale), height: even(h * scale) }
  }
  const ratio = aspect === '1:1' ? 1
    : aspect === '4:5' ? 4 / 5
      : aspect === '9:16' ? 9 / 16
        : 16 / 9
  // 先算"从原片里能裁出的最大区域"——竖屏 9:16 从横屏里裁，
  // 宽度只有原片的一小条；再按长边上限缩，**绝不放大**（放大会糊）。
  const srcRatio = w / h
  const cropW = ratio >= srcRatio ? w : h * ratio
  const cropH = ratio >= srcRatio ? w / ratio : h
  const scale = Math.min(1, maxLongEdge / Math.max(cropW, cropH))
  return { width: even(cropW * scale), height: even(cropH * scale) }
}

/** `12.4` → `0:12.4`。面板上的时长读数用，不参与计算。 */
export function formatVideoTime(ms: number): string {
  const safe = Math.max(0, ms)
  const totalSeconds = safe / 1000
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds - minutes * 60
  return `${minutes}:${seconds.toFixed(1).padStart(4, '0')}`
}
