import { align32, fitWithin, MAX_DIMENSION } from '../shared/size'

/**
 * 「说一句」发图前的两道缩图（Task 11）—— 两个尺寸、两条路：
 *
 * | 谁用 | 长边 | 还修什么 | 为什么 |
 * |---|---|---|---|
 * | `prepareForRouting` | 640 | 只等比缩 | 路由（VLM 看一眼照片长什么样）不需要分辨率；电脑版实测 640 比 1024 快一半（来路与数据在 src/image/prepare.ts） |
 * | `prepareForModel` | 2048（`MAX_DIMENSION`）| 宽高各**对齐到 32 的倍数** | 上游硬约束：不是 32 倍数直接 400（服务端 `checkModelSize` 也拦一道） |
 *
 * ⚠️ **两个约束数都不许在这里写死**：2048 和 32 从共享 `shared/size.ts` 取（那份是
 * 自动同步产物，源头在电脑版）。640 是本文件自己的常量 —— 电脑版那份 prepare.ts
 * 的默认参数也是 640（同一个数、两处源），动之前两边一起看。
 *
 * ⚠️ 路由那条**故意不做 align32** —— 这是和电脑版 `prepareForRouting` 唯一的差别：
 * 电脑版那条复用了 prepareForModel 的管道，于是小图也会被 align32 抬到最短边 512，
 * 竖构图照片（如 1080×2048）的 640 小图会被横向抻开（338 宽 → 512 宽）。可
 * `/api/route` 对尺寸**没有任何要求**（只认 data URL 前缀），没有理由跟着抻。
 *
 * 管道（两条路共用）：离屏 2D 画布按**目标尺寸**建 → `canvas.createImage()` 载入
 * 照片 → drawImage 画满 → `canvasToTempFilePath` 出 jpg → `readFile(base64)` 拼成
 * data URL。和 `lib/image/thumbs.ts` / `export.ts` 一样借离屏 2D 画布 —— 这条
 * 「2D 离屏画布 → canvasToTempFilePath」的路子本仓库已实测可用。
 */

/** 路由预览的长边（电脑版同值；spec §4.2「缩图 640 → /api/route」）。 */
const ROUTE_MAX = 640

/** JPG 质量 —— 和电脑版 prepare.ts 同一个数（0.9：预览肉眼看不出差的那一档）。 */
const JPG_QUALITY = 0.9

/** 备好的图：data URL + 目标尺寸（送 /api/edit 时 width/height 照它填）。 */
export interface PreparedImage {
  dataUrl: string
  width: number
  height: number
}

/**
 * 路由用的小图：长边 640、JPEG data URL（只缩不放，小照片原样）。
 *
 * @param photoPath 照片的临时文件路径（选图/拍照拿到的那个）
 * @param w 照片原宽（`wx.getImageInfo` 量的，页面 `data.photoW`）
 * @param h 照片原高（同上）
 */
export async function prepareForRouting(photoPath: string, w: number, h: number): Promise<string> {
  const { width, height } = fitWithin(w, h, ROUTE_MAX)
  return (await encodeJpeg(photoPath, width, height)).dataUrl
}

/**
 * 送模型的正图：长边 2048（`MAX_DIMENSION`）+ 宽高对齐到 32 的倍数，JPEG data URL。
 *
 * ⚠️ 画布按**对齐后**的尺寸建（不是先按原尺寸画再对齐）—— align32 会把边长推
 * 最多 16px，差这几像素上游就 400（电脑版 prepare.ts 同一句警告）。
 */
export async function prepareForModel(
  photoPath: string,
  w: number,
  h: number,
): Promise<PreparedImage> {
  const fitted = fitWithin(w, h, MAX_DIMENSION)
  const width = align32(fitted.width)
  const height = align32(fitted.height)
  return await encodeJpeg(photoPath, width, height)
}

/** 真正的活：载入 → 画到目标尺寸 → jpg 临时文件 → base64 dataURL。 */
async function encodeJpeg(photoPath: string, width: number, height: number): Promise<PreparedImage> {
  const canvas = wx.createOffscreenCanvas({ type: '2d', width, height })
  const ctx = canvas.getContext('2d') as WechatMiniprogram.IAnyObject
  // ★ 图必须由**同一块画布** createImage（typings 写着：2d / webgl 画布造出来的图
  //   不能混用）；照片以临时文件路径喂 `img.src`。
  const img = canvas.createImage()
  await new Promise<void>((ok, no) => {
    img.onload = () => ok()
    img.onerror = () => {
      console.error('[prepare] 照片载不进离屏画布：' + photoPath)
      no(new Error('照片备不了，再试一次'))
    }
    img.src = photoPath
  })
  // 5 参 drawImage = 整张照片画满目标矩形（等比 + 至多 16px 的轻拉伸，同电脑版）
  ctx.drawImage(img, 0, 0, width, height)
  const filePath = await canvasToJpeg(canvas, width, height)
  const base64 = await readBase64(filePath)
  return { dataUrl: 'data:image/jpeg;base64,' + base64, width, height }
}

/** 离屏 2D 画布 → jpg 临时文件（参数形状照 lib/image/export.ts 的 canvasToFile）。 */
function canvasToJpeg(canvas: WechatMiniprogram.IAnyObject, w: number, h: number): Promise<string> {
  return new Promise((ok, no) => {
    wx.canvasToTempFilePath({
      canvas,
      x: 0,
      y: 0,
      width: w,
      height: h,
      destWidth: w,
      destHeight: h,
      fileType: 'jpg',
      quality: JPG_QUALITY,
      // 空路径也当失败 —— 别让 undefined 一路拼成"看着像 dataURL"的假货送去后端
      success: r => (r.tempFilePath
        ? ok(r.tempFilePath)
        : no(new Error('照片备不了，再试一次'))),
      fail: e => {
        console.error('[prepare] canvasToTempFilePath 失败：' + ((e && e.errMsg) || '未知原因'))
        no(new Error('照片备不了，再试一次'))
      },
    })
  })
}

/** 临时文件 → base64（拼 data URL 的最后一步）。 */
function readBase64(filePath: string): Promise<string> {
  return new Promise((ok, no) => {
    wx.getFileSystemManager().readFile({
      filePath,
      encoding: 'base64',
      success: r => (typeof r.data === 'string'
        ? ok(r.data)
        : no(new Error('照片备不了，再试一次'))),
      fail: e => {
        console.error('[prepare] 读临时文件失败：' + ((e && e.errMsg) || '未知原因'))
        no(new Error('照片备不了，再试一次'))
      },
    })
  })
}
