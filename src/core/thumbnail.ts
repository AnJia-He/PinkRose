import { MAX_DIMENSION, fitWithin } from '../../shared/size.ts'
import { makeCanvas } from './canvas.ts'
import type { Sizable } from '../image/prepare'

/**
 * **每一步的小图**的边长上限（今天挂在照片区上方那条历史时间轴上，
 * `ui/StepStrip`；★ 2026-10-06 晚之前它挂在对话气泡下面 `.bubble-thumb`）。
 *
 * ★ 2026-10-04（晚）：用户说「**对话框里的图片缩略图好模糊**」—— 从 160 提到 480。
 *   和下面作品集那张是**同一个病、同一个算法**（那一次 2026-09-25 修过，
 *   这一张漏了）。账：
 *     · 那时的显示框（`.bubble-thumb`）是 `width: 120px`（CSS 写死），
 *       DPR 2 的屏上要 **240 个设备像素**垫着；
 *     · `makeThumbnail` 按**长边**缩（`fitWithin`），所以竖图吃亏：
 *       1080×2048 那种竖图 160 长边 → **宽只有 84**，被拉成 120 CSS = 2.9×
 *       （DPR 2 时 84 → 240，**2.86 倍**）—— 这就是"模糊"的来历；
 *     · 要宽 ≥ 240：3:4 竖图（宽=0.75×长边）→ 长边 320 就够；
 *       9:16（0.5625）→ 427；1080×2048（0.527）→ 455。
 *   取 **480**（和作品集那张同一个数）：9:16 和 1080×2048 都盖得住。
 *   ⚠️ **换到时间轴上之后这个数照旧够用**（而且更宽裕）：格子高 56px（CSS），
 *   DPR 2 只要 112 个设备像素垫短边 —— 480 长边对最容易吃亏的 1080×2048 是 253。
 *   别因为它"看着富余"就调小：哪一版是哪一版就靠这张小图认，而它一分流量不花。
 *
 * ⚠️ **这一张不进数据库、也不上传** —— 每一步的缩略图是**客户端现做的**
 *    （活着的时候按画布抓，恢复的时候按服务端存的底图现做，见 App.tsx 那两处），
 *    所以调大它**只花内存不花流量**：一张约 30~50 KB 的字符串，六步也就两百来 KB。
 * ⚠️ 换一张更糊的说法：已经是**旧版 160** 做出来的那些小图不会自己变清楚 ——
 *    但它们只是内存里的，刷新/重开就按新的重做了。
 */
export const THUMB_MAX_SIDE = 480

/**
 * **作品集列表上那张缩略图**（`.gallery-thumb`）的边长上限。
 *
 * 为什么要两个数、为什么不能把上面那个改大（2026-09-25 实测）：
 * 它们看的不是同一件事 —— 它们**被显示出来的尺寸不一样**
 * （`.gallery-thumb` 是格子宽的 100%，上面那张是时间轴上一格 ~56px 高），
 * 需要的源像素也就跟着不一样。两个数各自对着自己的显示尺寸算，别合并成一个。
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
 *    （2026-10-04 起那个也是 480 了，所以今天"忘传"恰好不糊 —— 但两者的显示
 *    尺寸不一样，哪天其中一个变了，这个坑就会回来：**该传就传**）。
 * ⚠️ 这是给**新存的**作品用的：2026-09-25 之前存进库的那些，缩略图还是 160 那一版
 *    （图在服务器上，改名/替换不会顺手重做），它们照旧会糊。
 */
export const GALLERY_THUMB_MAX_SIDE = 480

/** 「按住看原图」那张预览的边长上限（★ 2026-10-08 从 `App.tsx` 搬进这儿 ——
 *  恢复会话的 hook 和 `onPick` 两处都要用）。
 *  不直接拿原图：3000 万像素重新上传一次纹理很贵，而"看原图"永远是在
 *  屏幕大小上比的，1280 已经看不出和原图的差别。 */
export const ORIGINAL_PREVIEW_MAX_SIDE = 1280

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
  const { canvas, ctx } = makeCanvas(width, height, '做不了缩略图')
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
  const { canvas, ctx } = makeCanvas(width, height, '做不了 data URL')
  // 这里缩图是**用户那张照片的一次画质损失**，平滑档给最好的（和 resize.ts
  // 那条同款理由：默认档缩出来的边缘有锯齿）。
  ctx.imageSmoothingQuality = 'high'
  ctx.drawImage(source, 0, 0, canvas.width, canvas.height)
  return canvas.toDataURL('image/jpeg', quality)
}
