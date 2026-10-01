import { MAX_DIMENSION, fitWithin } from '../../shared/size.ts'
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

/**
 * 位图/画布 → data URL。**送给服务端的图都走这条路**：
 *   · 建会话那张原图（`onPick`）—— 画质 **0.92**（默认值）；
 *   · 每一步落盘的那张底图（落盘副作用）—— 画质 **0.9**（显式传）。
 *
 * 0.9x 是"存下来接着改"的那一份，不是缩略图，画质要够 ——
 * 但也不是最终导出（那一步在 `buildExportBlob`，走的是 blob 不是 data URL）。
 *
 * ★ **先压到 `MAX_DIMENSION`（`fitWithin`，只缩不放），再编码** ——
 * 2026-10-01 评审补的，原来是"按画布原尺寸整张送"。**两处调用都要这顶帽子**：
 *   · 建会话那趟：画布只按**设备 WebGL 上限**缩过图（见 `render/limits.ts`），
 *     桌面上那就是 16384 —— 一张 ≥24 MP 的照片会**整张**从这条路送出去。
 *   · 落盘那趟：生成有个"**提供方回的图比它声明的更大**"的偏差分支
 *     （`App.tsx` 的"以实际为准，不拉伸"），4096² 的底图同样整张上路。
 * 而服务端 `MAX_IMAGE_BYTES` 是 8 MB：6000px 的 0.92 JPEG 就能撞线 → **413**
 * → 建会话/落盘失败，用户看到的是「存不下来」—— **指错了地方**（真相是"这张
 * 照片太大"），而且整条落盘从那以后都不会发生。
 * 压到 2048 之后字节预算才是**确定性**的：长边 2048 的 0.9x JPEG 在 0.5~1 MB
 * 量级，离 8 MB 很远。设计文档的存储估量本来也是按 2048 算的
 * （「一步一张，量级在 1 MB 以内」）。
 *
 * ⚠️ 压的**只是这一份输出**：传进来的画布/位图**一个像素都不动** ——
 * 画布是工作台，预览、导出、下一次生成都按它的分辨率走（缩了它 = 每次导出降级）。
 *
 * ⚠️ **代价说在明处**：传一张 6000px 的照片、只拖滑块、然后**恢复**这条会话，
 *    拿到的是 2048 的底 —— 不恢复的话，这一趟导出本来能到 6000px。
 *    这是"存得住"本身的价格（流水线从 `MAX_DIMENSION` 往下全按 2048 设计，
 *    恢复出来的底接着改，每一步也都一致）。
 *
 * ⚠️ 别用 `makeThumbnail` 代替：那个是 **0.7**，而且会**缩到 480**。
 * 拿它当原图传上去，用户回头再打开这张会话，底图是糊的 —— 而且不报错。
 */
export function bitmapToDataUrl(source: Sizable, quality = 0.92): string {
  const { width, height } = fitWithin(source.width, source.height, MAX_DIMENSION)
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, width)
  canvas.height = Math.max(1, height)
  const ctx = canvas.getContext('2d', { colorSpace: 'srgb' })
  if (!ctx) throw new Error('拿不到 2D 上下文，做不了 data URL')
  // 这里缩图是**用户那张照片的一次画质损失**，平滑档给最好的（和 resize.ts
  // 那条同款理由：默认档缩出来的边缘有锯齿）。
  ctx.imageSmoothingQuality = 'high'
  ctx.drawImage(source, 0, 0, canvas.width, canvas.height)
  return canvas.toDataURL('image/jpeg', quality)
}
