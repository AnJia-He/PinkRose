/**
 * **照片电影的时间轴与镜头运动**（★ 2026-10-20）。
 *
 * 和「照片动图」的区别：动图是一张照片停几秒；电影是**每张照片缓慢推近 /
 * 拉远 / 平移**，像 iPhone 的回忆视频。这里只算纯数字，渲染在 `movie/export`。
 *
 * ⚠️ 时长上限沿用短片的 20 秒：480 帧已经是逐帧渲染的耐心上限；
 *   照片越多，每张能分到的时间越短（界面会先把上限算出来）。
 */
import { VIDEO_MAX_SECONDS } from '../../shared/video.ts'

/** 一张照片最少停多久。 */
export const PHOTO_MOVIE_MIN_MS = 1000
/** 一张照片最多停多久。 */
export const PHOTO_MOVIE_MAX_MS = 4000
/** 最多放多少张照片。 */
export const PHOTO_MOVIE_MAX_PHOTOS = 12

export type PhotoMovieMotion = 'none' | 'in' | 'out' | 'pan'
export type PhotoMovieTransition = 'cut' | 'fade'

export const PHOTO_TRANSITIONS: { id: PhotoMovieTransition; label: string }[] = [
  { id: 'cut', label: '硬切' },
  { id: 'fade', label: '淡入淡出' },
]

export const PHOTO_MOTIONS: { id: PhotoMovieMotion; label: string }[] = [
  { id: 'in', label: '推近' },
  { id: 'out', label: '拉远' },
  { id: 'pan', label: '平移' },
  { id: 'none', label: '静止' },
]

export type PhotoMovieShot = {
  photoIndex: number
  startMs: number
  endMs: number
  frames: number
}

export type PhotoMovieTimeline = {
  shots: PhotoMovieShot[]
  totalMs: number
  totalFrames: number
  /** 相邻两张之间重叠的帧数；硬切为 0。 */
  overlapFrames: number
}

/** 照片张数固定时，每张最多能停多久（保证全片不超 20 秒）。 */
export function maxPerPhotoMs(count: number): number {
  if (count <= 0) return PHOTO_MOVIE_MIN_MS
  return Math.max(PHOTO_MOVIE_MIN_MS,
    Math.min(PHOTO_MOVIE_MAX_MS, Math.floor(VIDEO_MAX_SECONDS * 1000 / count)))
}

/**
 * 排时间轴。每张照片的帧数是 `round(时长 × fps)`，至少 2 帧（否则推拉没有过程）。
 * 全片超过 20 秒直接抛错 —— 调用方在界面上先拦住，这里是最后一道。
 */
export function photoMovieTimeline(
  count: number, perPhotoMs: number, fps: number,
  transition: PhotoMovieTransition = 'cut',
): PhotoMovieTimeline {
  if (count <= 0) throw new Error('先选照片。')
  if (count > PHOTO_MOVIE_MAX_PHOTOS) {
    throw new Error(`一次最多 ${PHOTO_MOVIE_MAX_PHOTOS} 张照片。`)
  }
  const span = Math.round(Math.max(PHOTO_MOVIE_MIN_MS, Math.min(PHOTO_MOVIE_MAX_MS, perPhotoMs)))
  const frames = Math.max(2, Math.round((span / 1000) * fps))
  // 淡入淡出 = 0.4 秒；但每张至少要留出重叠之外的两帧，别把很短的镜头吃光。
  const overlapFrames = transition === 'fade'
    ? Math.max(1, Math.min(Math.round(fps * 0.4), Math.floor(frames / 3)))
    : 0
  const totalFrames = frames * count - overlapFrames * (count - 1)
  const totalMs = Math.round((totalFrames / fps) * 1000)
  if (totalMs > VIDEO_MAX_SECONDS * 1000) {
    throw new Error(`一共 ${count} 张、每张 ${span / 1000} 秒，超过 ${VIDEO_MAX_SECONDS} 秒了；先缩短每张时长。`)
  }
  const shots: PhotoMovieShot[] = []
  const stepMs = Math.round((frames - overlapFrames) / fps * 1000)
  for (let index = 0; index < count; index++) {
    shots.push({
      photoIndex: index,
      startMs: index * stepMs,
      endMs: index * stepMs + Math.round(frames / fps * 1000),
      frames,
    })
  }
  return { shots, totalMs, totalFrames, overlapFrames }
}

/**
 * 某张照片某一帧的**绘制矩形**（目标画布坐标）。
 *
 * 先按 cover 把照片铺满画布，再按进度把画面放大 0–12%：
 *   · 推近：1 → 1.12；拉远：1.12 → 1；
 *   · 平移：固定 1.08，横向从一侧扫到另一侧（奇偶张反向，剪起来不呆板）。
 * 放大是把画面裁小再铺满，所以永远盖住画布，不会露出黑边。
 */
export function kenBurnsRect(
  source: { width: number; height: number },
  target: { width: number; height: number },
  progress: number,
  motion: PhotoMovieMotion,
  shotIndex: number,
): { dx: number; dy: number; dw: number; dh: number } {
  const p = Math.max(0, Math.min(1, progress))
  const srcW = Math.max(1, source.width)
  const srcH = Math.max(1, source.height)
  const zoom = motion === 'in' ? 1 + 0.12 * p
    : motion === 'out' ? 1.12 - 0.12 * p
      : motion === 'pan' ? 1.08
        : 1
  const cover = Math.max(target.width / srcW, target.height / srcH)
  const dw = srcW * cover * zoom
  const dh = srcH * cover * zoom
  const spareX = Math.max(0, dw - target.width)
  const spareY = Math.max(0, dh - target.height)
  const panX = motion === 'pan'
    ? (shotIndex % 2 === 0 ? -1 + 2 * p : 1 - 2 * p)
    : 0
  return {
    dx: -spareX / 2 + panX * (spareX / 2),
    dy: -spareY / 2,
    dw,
    dh,
  }
}
