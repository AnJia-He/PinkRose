import { fitWithin } from '../../shared/size.ts'
import type { Sizable } from '../image/prepare'

/** 对话里那张小图的边长上限。160 够看清"天蓝了没有"，再大就只是浪费内存。 */
export const THUMB_MAX_SIDE = 160

/**
 * **作品集列表上那张缩略图**（`.gallery-thumb`）的边长上限。
 *
 * 为什么要两个数、为什么不能把上面那个改大（2026-09-25 实测）：
 * 它们看的不是同一件事 —— 对话里那张只要够认出"天蓝了没有"，
 * 而列表这张是用户挑图的地方，糊一点他一眼就看得出来。
 *
 * 而它以前之所以糊，**根因不在 DPR，在这个错配**：
 *   · `makeThumbnail` 按**长边**缩（`fitWithin`）：竖图 1200×1600 → 120×160；
 *   · `.gallery-thumb` 是 `width: 100%; aspect-ratio: 1/1; object-fit: cover`
 *     —— **一个正方形的框，按宽度铺**，`cover` 的缩放系数是
 *     `max(框宽/图宽, 框高/图高)`，正方形框里起决定作用的是**短边（宽）**：
 *     `max(181/120, 181/160) = 1.51`。
 *   · 一句话：**`maxSide` 限制的是长边，而决定清晰度的是短边。**
 *     DPR 只是把同一个错配再乘一遍（DPR 2 的屏上就是 3.02×）。
 *
 * 480 是怎么来的（量出来的，不是随手取的大数）：格子最宽实测 181 CSS
 * （1280×600 的桌面），DPR 2 时每格要铺 362 设备像素；竖图缩略图的宽度 =
 * `maxSide × (1200/1600)` = `480 × 0.75` = **360** —— 是 362 的 99.4%，
 * 落在项目接受的那条 1.05× 线内。数字见 `.superpowers/sdd/2026-09-25-gallery/
 * thumb-sharpness.json`，`scripts/check-mobile-layout.mjs` 里有一条判据守着它。
 *
 * ⚠️ 只把这个数改大**不够**：调用点得**显式传**它。不传就回落到 `THUMB_MAX_SIDE`
 *    那个 160 —— 一声不吭，量出来照旧是糊的（`src/App.tsx` 的 `saveOnce`）。
 * ⚠️ 这是给**新存的**作品用的：2026-09-25 之前存进库的那些，缩略图还是 160 那一版
 *    （图在服务器上，改名/替换不会顺手重做），它们照旧会糊。
 */
export const GALLERY_THUMB_MAX_SIDE = 480

/**
 * 把一张图/画布缩成一张小图，返回 data URL。
 *
 * **返回字符串而不是位图**：位图占 GPU 内存（这个项目为此写过好几个
 * `bitmapsToClose` 的注释），而对话里最多六张缩略图，为它们占六份 GPU 内存
 * 完全不值。data URL 是普通内存，一张约 5~10 KB。
 *
 * 用 JPEG 0.7：缩略图看的是"大概长什么样"，不是细节。
 * 带 alpha 的图会变黑底，但我们的图都是照片，没有透明通道。
 *
 * ⚠️ 调用时机很要紧：**必须在画面真的更新之后**再抓。详见 Snapshot.thumb 的注释。
 */
export function makeThumbnail(source: Sizable, maxSide = THUMB_MAX_SIDE): string {
  const { width, height } = fitWithin(source.width, source.height, maxSide)
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, width)
  canvas.height = Math.max(1, height)
  const ctx = canvas.getContext('2d', { colorSpace: 'srgb' })
  if (!ctx) throw new Error('拿不到 2D 上下文，做不了缩略图')
  ctx.imageSmoothingQuality = 'high'
  ctx.drawImage(source, 0, 0, canvas.width, canvas.height)
  return canvas.toDataURL('image/jpeg', 0.7)
}
