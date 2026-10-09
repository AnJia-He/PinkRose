import piexif from 'piexifjs'

export type ExportFormat = 'image/jpeg' | 'image/png'

export function buildFilename(original: string, format: ExportFormat): string {
  const ext = format === 'image/png' ? 'png' : 'jpg'
  const stem = original.replace(/\.[^.]+$/, '')
  return `${stem}_pinkrose.${ext}`
}

/**
 * 画布 → 可导出的 blob（JPEG 时把原图的 EXIF 写回去，spec §5.4）。
 *
 * **分享和下载共用这一步**，所以它只管做图、不管图去哪。分成"做图"和
 * "送出去"两件事，是因为同一次导出可能先试分享、失败再退回下载 ——
 * 那不该把图重做一遍。
 *
 * 为什么要写回 EXIF：canvas.toBlob() 产出的图不带原始 EXIF，
 * 拍摄时间和 GPS 会丢，而旅游照的时间地点对用户有意义。
 */
export async function buildExportBlob(
  canvas: HTMLCanvasElement,
  originalFile: File,
  format: ExportFormat = 'image/jpeg',
  quality = 0.95,
): Promise<Blob> {
  const blob = await new Promise<Blob | null>(res => canvas.toBlob(res, format, quality))
  if (!blob) throw new Error('导出失败：canvas 没有产出图片')
  if (format !== 'image/jpeg') return blob

  try {
    return await withExif(blob, originalFile)
  } catch (e) {
    // EXIF 写回失败不该挡住用户拿到图，降级为不带 EXIF 保存
    console.warn('EXIF 写回失败，照常导出（无 EXIF）', e)
    return blob
  }
}

/** blob → 存成文件。浏览器只能丢进"下载"文件夹，进不了相册。 */
export function downloadImage(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  // 不能在这里同步 revoke：Safari 有「同一个任务里被 revoke 的下载会被取消」
  // 的历史问题，而重编码后的 12–48 MP JPEG 正是那种大 blob。保存又是本产品
  // 在 iPhone 上的终点动作，赌不起——推迟到下载真正开始之后再释放。
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

/** 浏览器给的那两个口子。lib.dom 里未必有，这里自己声明最小用得到的形状。 */
type ShareNavigator = {
  canShare?: (data: { files?: File[] }) => boolean
  share?: (data: { files?: File[] }) => Promise<void>
}

/**
 * 这台设备能不能把**图片**交给系统分享面板。
 *
 * **必须用 `canShare` 问，不能只看 `navigator.share` 在不在。** 桌面 Chrome
 * 就是反例：它的 `share` 在，但只能分享文字和链接。只看 share 存不存在，
 * 桌面上就会多出一个"分享"按钮，点下去弹出一个**分享不了图片**的面板 ——
 * 比没有这个按钮还糟。
 *
 * 探测要用一个**真的图片文件**去问：不带 files 的 canShare 只回答
 * "能不能分享文字"。
 *
 * 探测本身失败（老浏览器、隐私模式、异常）一律按"不能分享"处理：
 * 大不了退回下载，不该让整个页面挂掉。
 */
export function canShareImage(): boolean {
  if (typeof navigator === 'undefined') return false
  const nav = navigator as unknown as ShareNavigator
  if (typeof nav.canShare !== 'function') return false
  try {
    // 空文件也行：canShare 看的是 MIME 类型，不看内容
    return nav.canShare({ files: [new File([new Blob()], 'probe.jpg', { type: 'image/jpeg' })] })
  } catch {
    return false
  }
}

/**
 * blob → 系统分享面板（手机上一步就能选微信）。
 *
 * **用户自己关掉面板不算失败**：那种情况下 resolve，什么都不做。
 * 当成失败处理的话，用户每次取消都会被弹一句错误、还会白下载一份 ——
 * 恰好是他刚刚表示不想要的东西。
 *
 * 真正失败（权限、系统拒绝、面板崩了）才往外抛，由调用方决定怎么办
 * （现在的做法是退回下载，至少让他拿得到图）。
 */
export async function shareImage(blob: Blob, filename: string): Promise<void> {
  const nav = navigator as unknown as ShareNavigator
  if (typeof nav.share !== 'function') throw new Error('这台设备不支持分享')
  const file = new File([blob], filename, { type: blob.type || 'image/jpeg' })
  try {
    await nav.share({ files: [file] })
  } catch (e) {
    // AbortError = 用户自己取消。不是错误，别往外抛。
    if (e instanceof DOMException && e.name === 'AbortError') return
    throw e
  }
}

async function withExif(blob: Blob, originalFile: File): Promise<Blob> {
  const originalDataUrl = await blobToDataUrl(originalFile)
  const exifObj = piexif.load(originalDataUrl)

  // 尺寸会变，这两个字段必须清掉，否则看图软件会显示错误信息
  delete exifObj['0th']?.[piexif.ImageIFD.ImageWidth]
  delete exifObj['0th']?.[piexif.ImageIFD.ImageLength]
  delete exifObj['Exif']?.[piexif.ExifIFD.PixelXDimension]
  delete exifObj['Exif']?.[piexif.ExifIFD.PixelYDimension]

  // Orientation 也必须清掉，这条最容易漏。
  //
  // 解码时 createImageBitmap 的 imageOrientation 默认是 'from-image'，
  // 意思是**已经按 EXIF 把画面摆正了**——canvas 上是正立的像素网格。
  // 若再把原始的 Orientation=6（含义是"显示时顺时针转 90°"）写回去，
  // 看图软件会对着已经正立的图**再转一次**，导出图的方向就错了。
  //
  // 竖拍的手机照片几乎全都带 Orientation=6，所以这条不处理必然翻车。
  delete exifObj['0th']?.[piexif.ImageIFD.Orientation]

  // 原图内嵌的缩略图（IFD1）也必须清掉，这条同样容易漏。
  //
  // 两个理由：
  //   1. 它是**修改前**的画面预览。导出文件里带着一张旧预览，
  //      文件管理器/相册的缩略图模式会显示修图前的样子，与像素本身矛盾。
  //   2. piexif.dump 对缩略图有 64KB 上限，超了会抛错；那个错误会被
  //      下面的 catch 吞掉，用户拿到的就会是**完全没有 EXIF** 的文件——
  //      拍摄时间和 GPS 全丢，恰好是这个任务存在的意义所在。
  delete exifObj['1st']
  // 注：@types/piexifjs 把 thumbnail 声明成 `string`（不是 `string | null`），
  // 所以这里只能 delete，不能赋 null。对 piexif.dump 而言效果一样——
  // 它的判据是 `("thumbnail" in exif_dict) && (exif_dict["thumbnail"] != null)`
  // （piexif.js:197），删掉键与赋 null 都会让这个条件为假。
  delete exifObj.thumbnail

  const exifBytes = piexif.dump(exifObj)
  const newDataUrl = await blobToDataUrl(blob)
  return dataUrlToBlob(piexif.insert(exifBytes, newDataUrl))
}

/**
 * Blob → data URL —— 定义搬到 `image/blob.ts` 了（那段 `FileReader` 原来
 * 在这儿和 `prepare.ts` 各写了一份，2026-10-09 收成一份）。这里 import 完
 * 再转出去，免得调用方为了一个函数多认一个模块。
 */
import { blobToDataUrl } from '../image/blob'
export { blobToDataUrl }

function dataUrlToBlob(dataUrl: string): Blob {
  const [head, body] = dataUrl.split(',')
  const mime = head.match(/:(.*?);/)?.[1] ?? 'image/jpeg'
  const bin = atob(body)
  const arr = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i)
  return new Blob([arr], { type: mime })
}
