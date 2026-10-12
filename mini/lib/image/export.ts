import type { Adjustments } from '../shared/adjustments'
import { fitWithin } from '../shared/size'
import type { CanvasNode, TonePipeline } from '../gl/tonePipeline'
import { putPixelsFlipped } from './pixels'

/**
 * 「保存」这一条路的两半：**全尺寸导出**（`exportPhoto`）→ **写进相册**（`saveToAlbum`，
 * 含授权引导）。页面（`pages/index/index.ts` 的 `onSave`）只管防重入、把失败的人话
 * toast 出来 —— 这里给出来的 Error 消息就已经是**能直接给用户看**的话。
 *
 * ## 尺寸：导出 = 照片原尺寸
 * 画布 buffer 本来就是照片原尺寸（`startRender` 里调的 `resizeToImage`，显示靠 CSS），
 * 所以导出要做的只是**重画一帧**。唯一的例外是设备上限：`MAX_TEXTURE_SIZE` 和
 * `MAX_VIEWPORT_DIMS` 里小的那个托底（`fitWithin` 来自共享 `size.ts`）—— 16384 下
 * 基本不触发（模拟器实测 16384），写上是兜底：真机上老机器的上限可能比照片小。
 *
 * ## ★ 双路径（2026-10-12 裁定）
 * `wx.canvasToTempFilePath` 的官方 typings 只说了 `canvas` 参数是"canvas type="2d"
 * 时使用"——**webgl 画布认不认没人验过**，所以两条路都写：
 *   ① canvas 路 —— `canvasToTempFilePath({ canvas: 画布节点 })`：一步到位、零拷贝；
 *   ② pixels 路 —— `readPixels()`（**翻行**，GL 自下而上）→ 离屏 2D 画布 `putImageData`
 *      → 从那张 2D 画布 `canvasToTempFilePath`。
 * 先 ① 后 ②：① 报错、**或导出的文件是纯色**（见下「两道空白防线」）时退到 ②。
 * 真机/模拟器实际哪条在跑，见
 * `mini/README.md`「全尺寸导出存相册」那节的实测记录（2026-10-12 模拟器：① 就通）。
 * `ExportedPhoto.via` 把"这趟走的哪条"还给调用方（探针拿它出证据），控制台也打一行。
 *
 * ## ★ 两道空白防线（2026-10-12 审查 Critical 后补）
 * 「① 报错才退 ②」防不住**"没报错、但导出的是一张空白图"** —— webgl 画布认不认
 * `canvasToTempFilePath` 本来就没文档化，「成功但空白」正是它可能的结局；真发生了
 * 就是黑图配一声「已存到相册」（这项目记过的"最坏结果"）。所以：
 *   ① **buffer 断言（两路共用）**：渲染后、**任何导出动作之前** —— 16×16 网格数颜色
 *      （照 `pages/index.ts` 的 `__probeColors`，不翻行），纯色 = 这张图根本没画出来
 *      （着色器编不过 / 上下文坏了）→ 抛人话、**绝不进相册**。⚠️ 这时**不落 ②**：
 *      两路导出去的都会是同一张纯色图，多导一遍没有意义。成本 = 一次全量 readPixels。
 *   ② **文件级空白检查（只保 ①）**：① 的回调"成功"了也要把文件画进一张 64×64 的
 *      离屏 2D 画布采样一遍，纯色就当 ① 失败、自动落 ② 重导。这是「① 成功但空白」
 *      的唯一防线。① 的 success 回调给**空路径**也算失败（同一处判据的收口）。
 *
 * ## 借完要还（和 thumbs.ts 同一条）
 * 导出 = buffer 调目标尺寸 + 用**当前参数** render；导出完必须 `resizeToImage()` +
 * `render(当前参数)` 把屏幕画回来。⚠️ 放在 `finally` 里：中间哪条路炸了，屏幕也得
 * 是好的（留在"导出那一帧"上的画面比报错本身更吓人）。
 */

/** 导出走的哪条路（见文件头「双路径」） */
export type ExportVia = 'canvas' | 'pixels'

/** 导出只需要宽高 —— 把 `node.createImage()` 加载好的 img 直接传进来也行（结构上就带这俩数） */
export interface PhotoSize {
  width: number
  height: number
}

export interface ExportedPhoto {
  /** 临时文件路径（下一步喂给 `wx.saveImageToPhotosAlbum`） */
  path: string
  /** 这趟走的哪条路 —— 探针/日志要看它，界面不看 */
  via: ExportVia
}

export interface ExportPhotoOpts {
  /** 只给自动化探针用：跳过第一条路、直接走 readPixels 兜底（两条路都要各实测一次，得有入口） */
  forceFallback?: boolean
}

/**
 * JPG 质量。0.92 = 视觉上和无损难分、体积又能压下来的常见档
 * （spec §5.3「JPG 高质量省空间」，就是这一档落下来的数）。
 */
const JPG_QUALITY = 0.92

// ── 两道空白防线（两路共用 / 只保 ① 路；理由见文件头）────────────────────────

/** 采样网格（和 `pages/index.ts` 的 `__probeColors` 同款 16×16） */
const BLANK_GRID = 16

/**
 * 文件侧判"纯色"的容差（每通道极差）——**不能像 GL 侧那样用全等**：
 * 文件过了一趟 JPEG 压缩，一块纯色会被压出几阶差（GL 侧的像素没这一步）。
 */
const BLANK_TOLERANCE = 8

/**
 * 「画面是空白」专门的一个错误类型 —— 唯一的作用是**穿过 exportPhoto 的通用
 * catch**（那里会把技术错误换成一句通用人话；这条自己就是人话，不能被换掉）。
 */
class BlankFrameError extends Error {}

/**
 * ★ 第一道空白防线（两路共用）：buffer 是不是纯色 —— `render(a)` 之后、任何导出
 * 动作之前调。纯色 = 这张图根本没画出来（着色器编不过 / 上下文坏了），**抛**：
 * ① 这时落 ② 没有意义（两路都会导出一张纯色图）；② 抛出去之后**绝不进相册**。
 *
 * 采样照 `__probeColors` 的配方：16×16 网格、数**不同颜色数**（GL 侧像素是全等值，
 * 纯色 = 恰好 1 种）。⚠️ 不翻行 —— 数颜色和行序无关。
 * 成本：一次全量 readPixels（12MP 约 48MB）—— 两道防线里它更贵，但它是**唯一**
 * 能拦住"两路都空白"的闸。
 */
function assertPainted(pipe: TonePipeline, size: PhotoSize): void {
  const px = pipe.readPixels()
  const seen: { [k: string]: true } = {}
  for (let i = 0; i < BLANK_GRID; i++) {
    for (let j = 0; j < BLANK_GRID; j++) {
      const x = Math.floor((i + 0.5) * size.width / BLANK_GRID)
      const y = Math.floor((j + 0.5) * size.height / BLANK_GRID)
      const o = (y * size.width + x) * 4
      seen[px[o] + ',' + px[o + 1] + ',' + px[o + 2]] = true
      if (Object.keys(seen).length > 1) return // 早就不是纯色了，别白扫完
    }
  }
  const only = Object.keys(seen)[0] || ''
  console.error('[export] 画面是纯色（' + only + '）—— 渲染没出画面，不导出、不进相册')
  throw new BlankFrameError('照片没画出来，再点一次试试')
}

/**
 * ★ 第二道空白防线（只保 ① 路）：① 导出的**文件**是不是纯色 —— 画进一张 64×64 的
 * 离屏 2D 画布采一采。① 的"成功"回调给了路径，文件里也可能是空白（见文件头）。
 *
 * 判据 = 每通道**极差 ≤ BLANK_TOLERANCE**（理由见那个常量）；读都读不回来
 * （onerror）按"不可用"抛 —— 调用方当 ① 失败、落 ② 处理。
 */
function fileLooksBlank(path: string): Promise<boolean> {
  const n = 64
  const canvas = wx.createOffscreenCanvas({ type: '2d', width: n, height: n })
  const ctx = canvas.getContext('2d') as WechatMiniprogram.IAnyObject
  const img = canvas.createImage()
  return new Promise<boolean>((ok, no) => {
    img.onload = () => {
      try {
        ctx.drawImage(img, 0, 0, n, n)
        const data: Uint8Array = ctx.getImageData(0, 0, n, n).data
        const lo = [255, 255, 255]
        const hi = [0, 0, 0]
        for (let i = 0; i < n * n; i++) {
          for (let c = 0; c < 3; c++) {
            const v = data[i * 4 + c]
            if (v < lo[c]) lo[c] = v
            if (v > hi[c]) hi[c] = v
          }
        }
        const spread = Math.max(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2])
        ok(spread <= BLANK_TOLERANCE)
      } catch (e) {
        no(e) // 画不进/读不出（上下文坏了）：当不可用，落 ②
      }
    }
    img.onerror = () => no(new Error('① 导出的文件读不回来'))
    img.src = path
  })
}

/**
 * 把「照片 + 当前参数」按**照片原尺寸**渲染出来，导成一张 JPG 临时文件。
 *
 * @param node  画布节点（`wx.canvasToTempFilePath` 认的是节点，管线的 node 是私有的，所以单传 —— 同 thumbs）
 * @param pipe  渲染管线（照片已经在里面了）
 * @param photo 照片尺寸（导出的目标尺寸；设备上限兜底在这里判）
 * @param a     当前参数（**调用这一刻**的，别传快照）
 *
 * 失败时抛的 Error 是**人话**（"给用户看"级别），细节在 `console` 里。
 */
export async function exportPhoto(
  node: CanvasNode,
  pipe: TonePipeline,
  photo: PhotoSize,
  a: Adjustments,
  opts: ExportPhotoOpts = {},
): Promise<ExportedPhoto> {
  const t0 = Date.now()
  // 设备上限兜底：读不到（上下文坏了）就不设限 —— 渲染那一步自然会先失败
  const maxSide = pipe.maxCanvasSide() || Math.max(photo.width, photo.height)
  const size = fitWithin(photo.width, photo.height, maxSide)
  if (size.width !== photo.width || size.height !== photo.height) {
    console.warn('[export] 照片 ' + photo.width + '×' + photo.height +
      ' 超过这台设备能画的 ' + maxSide + ' —— 导出缩到 ' + size.width + '×' + size.height)
  }

  try {
    node.width = size.width
    node.height = size.height
    pipe.render(a)
    assertPainted(pipe, size) // ★ 第一道空白防线（两路共用；抛出去绝不进相册）

    let out: ExportedPhoto | null = null
    if (!opts.forceFallback) {
      try {
        const path = await canvasToFile(node, size)
        // ★ 第二道空白防线：① 说"成功"也可能给出一张空白（webgl 画布是未文档化的支持）
        if (await fileLooksBlank(path)) {
          console.warn('[export] 画布路导出的文件是纯色（这张图没画出来）—— 不当作结果，改走像素兜底')
        } else {
          out = { path, via: 'canvas' }
        }
      } catch (e) {
        // 这一步失败 = 小程序不认 webgl 画布的 canvasToTempFilePath（Ruling 5 防的就是它）
        console.warn('[export] 画布直接导出不行，改走像素兜底：' + reasonOf(e))
      }
    }
    if (!out) out = { path: await pixelsToFile(pipe, a, size), via: 'pixels' }

    console.info('[export] 导出完成（' + out.via + ' 路）：' + size.width + '×' + size.height +
      '，' + (Date.now() - t0) + 'ms')
    return out
  } catch (e) {
    if (e instanceof BlankFrameError) throw e // 它自己就是人话（控制台那一行已经在防线里打过）
    console.error('[export] 导出失败：', e)
    throw new Error('这张照片导出失败了，再点一次试试')
  } finally {
    // 借完要还（和 thumbs.ts 同一条，理由见文件头）
    pipe.resizeToImage()
    pipe.render(a)
  }
}

// ── 存进相册 ─────────────────────────────────────────────────────────────────

/**
 * 「存相册」这条路失败了时抛的 Error —— 带一个 `kind`：
 *   · `'denied'` —— 用户没允许存相册（modal 引导已经出过，`message` 是一句陈述）
 *   · `'other'`  —— 别的毛病（`message` 带"再点一次试试"）
 * 页面把 `message` 原样 toast 出去即可。
 */
export interface AlbumError extends Error {
  kind: 'denied' | 'other'
}

/**
 * 把导出的临时文件写进**手机相册**。成功时自己 toast「已存到相册」（spec §4.4 的原话）。
 *
 * 授权流（微信的规矩）：第一次调 `saveImageToPhotosAlbum` 会弹**系统框**；
 * 用户拒过一次之后系统框**不再弹**、接口只会直接失败（errMsg 里含 `auth deny`）——
 * 这时弹一句人话把他带去 `wx.openSetting` 打开；回来若已允许，**自动再存一次**。
 */
export async function saveToAlbum(filePath: string): Promise<void> {
  let r = await trySave(filePath)
  if (!r.ok && r.deny) {
    // `getSetting` 只看一眼是不是"明确拒过"（undefined = 从没问过）—— 两种都去设置里
    // 引导：errMsg 说没授权，而能改这个状态的地方只有设置页
    const deniedBefore = await writeAlbumEquals(false)
    console.info('[export] 存相册被拦（明确拒过 = ' + deniedBefore + '）→ 引导去设置')
    if (await guideToSetting()) r = await trySave(filePath)
  }
  if (r.ok) {
    wx.showToast({ title: '已存到相册', icon: 'success' })
    return
  }
  if (r.deny) throw albumError('denied', '还没允许保存到相册')
  throw albumError('other', '存相册失败了，再点一次试试')
}

type SaveResult = { ok: true } | { ok: false; deny: boolean; errMsg: string }

function trySave(filePath: string): Promise<SaveResult> {
  return new Promise(res => {
    wx.saveImageToPhotosAlbum({
      filePath,
      success: () => res({ ok: true }),
      fail: e => {
        const errMsg = (e && e.errMsg) || ''
        console.error('[export] saveImageToPhotosAlbum 失败：' + errMsg)
        res({ ok: false, deny: isAuthDeny(errMsg), errMsg })
      },
    })
  })
}

/** errMsg 里这两种字样 = 权限问题（`authorize` 是"没授权"那族报错的通用词根） */
function isAuthDeny(errMsg: string): boolean {
  const m = errMsg.toLowerCase()
  return m.includes('auth deny') || m.includes('authorize')
}

/** `scope.writePhotosAlbum` 是不是正好等于 `v`（`undefined` = 从没问过，不算） */
function writeAlbumEquals(v: boolean): Promise<boolean> {
  return new Promise(res => {
    wx.getSetting({
      success: r => res(r.authSetting['scope.writePhotosAlbum'] === v),
      fail: () => res(false), // 查不动就当不是 —— 只会多走一次引导，不会误报成功
    })
  })
}

/** 弹一句人话 → 用户点了「去设置」才开设置页。返回：回来之后权限开了没有。 */
function guideToSetting(): Promise<boolean> {
  return new Promise(res => {
    wx.showModal({
      title: '存不进相册',
      // 文案过了 docs/文案规范.md：说「你」、说清"哪不对 + 怎么办"（工具语域，不加戏）
      content: '还没允许保存到相册。去设置里打开「保存到相册」，回来就能存了。',
      confirmText: '去设置',
      cancelText: '算了',
      success: r => {
        if (!r.confirm) return res(false) // 用户说算了 —— 按"没允许"收场，不再连环弹窗
        // `openSetting` 的返回里就带着改完之后的授权表，省一次 getSetting
        wx.openSetting({
          success: r2 => res(r2.authSetting['scope.writePhotosAlbum'] === true),
          fail: e => {
            console.error('[export] openSetting 打不开：' + reasonOf(e))
            res(false)
          },
        })
      },
      fail: () => res(false),
    })
  })
}

function albumError(kind: AlbumError['kind'], message: string): AlbumError {
  const e = new Error(message) as AlbumError
  e.kind = kind
  return e
}

// ── 两条导出路 ───────────────────────────────────────────────────────────────

/** ① canvas 路 / 兜底的最后一步共用：从一张画布导成 JPG 临时文件 */
function canvasToFile(canvas: WechatMiniprogram.IAnyObject, size: PhotoSize): Promise<string> {
  return new Promise((ok, no) => {
    wx.canvasToTempFilePath({
      canvas,
      x: 0,
      y: 0,
      width: size.width,
      height: size.height,
      destWidth: size.width,
      destHeight: size.height,
      fileType: 'jpg',
      quality: JPG_QUALITY,
      // ⚠️ 空路径当**失败**（同一处"① 成功回调不可信"判据的收口）——让它落 ②，
      // 别把 undefined 一路喂给 saveImageToPhotosAlbum
      success: r => (r.tempFilePath ? ok(r.tempFilePath) : no(new Error('画布导成临时文件失败：空路径'))),
      fail: e => no(new Error('画布导成临时文件失败：' + ((e && e.errMsg) || '未知原因'))),
    })
  })
}

/** ② pixels 路：读回画布像素（**翻行**）→ 贴进离屏 2D 画布 → 从那张 2D 画布导出 */
async function pixelsToFile(pipe: TonePipeline, a: Adjustments, size: PhotoSize): Promise<string> {
  // 读之前重渲一帧最稳（2026-10-12 探针经验，见 mini/README「已知平台行为」）
  pipe.render(a)
  const px = pipe.readPixels()
  const canvas = wx.createOffscreenCanvas({ type: '2d', width: size.width, height: size.height })
  // GL 行序自下而上 —— 翻行的规矩只有一份（lib/image/pixels.ts）
  putPixelsFlipped(canvas.getContext('2d'), px, size.width, size.height, 0, 0)
  return await canvasToFile(canvas, size)
}

function reasonOf(e: unknown): string {
  return e && (e as Error).message ? (e as Error).message : String(e)
}
