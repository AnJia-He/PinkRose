/**
 * 本地作品集（Task 17，spec §13.2）：把每张「保存」过的成片在**手机本地**留一份
 * （全尺寸 jpg + 一张长边 ~256px 的缩略图）+ 一份清单（storage）。
 * 「作品」页（pages/works）只读它；修图页「保存」成功顺带写它。
 *
 * ## 存哪 / 长什么样
 * - 目录：`wx.env.USER_DATA_PATH/works/`，每张两个文件：`w<id>.jpg`（全尺寸）+
 *   `w<id>t.jpg`（缩略图）。
 * - 清单：storage 一个 key（下面 `KEY`），JSON 数组、**新的在前**；一条
 *   `{ id, file, thumb, w, h, bytes, at }`。file / thumb 存**绝对路径** ——
 *   USER_DATA_PATH 是安装期固定的逻辑路径，页面拿它直接喂 `<image>` / previewImage。
 * - `bytes` = 两个文件加一起的字节数（cap 和「我的」页的占用都读它）。
 *
 * ## 谁在写（相册是主承诺，这里只是顺带）
 * 修图页「保存」在 `saveToAlbum` **成功之后**调 `add` —— 写作品失败绝不冒泡到
 * 相册那条（接线与例外在 pages/index/index.ts 的 onSave 里，见那里的注释）。
 *
 * ## 已知边界（spec §13.2 就写明的，别当 bug 修）
 * - **删小程序 / 换手机即失** —— 本地存储，不做云备份（要做得另立任务）。
 * - **不做清单自愈**：文件被清理工具删了而清单还在时，页面就是裂图 —— 靠「清空」
 *   兜底（`clear` 是**枚举目录**删的，连清单外的孤儿文件一起清）。
 * - **cap = 150MB**（本机文件系统总盘 200MB 留余量）：到顶 `add` 抛
 *   `WorksFullError`，调用方据此弹「去『我的』清一清」（别的失败不打扰用户）。
 */

import { fitWithin } from './shared/size'

/** 清单在 storage 里的 key。换结构（比如以后加云备份）时升版本号，别原地改形状。 */
const KEY = 'works:v1'

/** USER_DATA_PATH 下的作品目录名（全尺寸 + 缩略图都在这下面）。 */
const DIR_NAME = 'works'

/** 总占用上限（spec §13.2：首版 ~150MB，本机文件系统总盘 200MB 留余量）。 */
const CAP_BYTES = 150 * 1024 * 1024

/** 缩略图长边（~256px）：列表一格 ~170pt，两倍余量够看；一张 jpg ~10~20KB。 */
const THUMB_SIDE = 256

/** 缩略图 jpg 质量 —— 它是「看个大概」的图，0.8 在 256px 上肉眼看不出（全尺寸那档是 0.92）。 */
const THUMB_QUALITY = 0.8

/**
 * 清单里的一条。`file` / `thumb` 是绝对路径；`bytes` = 两个文件加起来；
 * `at` = 收进来的时刻（Date.now()；页面不做日期分组，只留档）。
 */
export interface WorkEntry {
  id: string
  file: string
  thumb: string
  w: number
  h: number
  bytes: number
  at: number
}

/**
 * cap 到顶时 `add` 抛的错。**message 就是给用户看的那句** —— 调用方拿
 * `instanceof WorksFullError` 认它、弹专属 toast（别的失败只在控制台记一笔）。
 */
export class WorksFullError extends Error {}

/** 作品目录的绝对路径（惰性取：wx.env 在模块求值那一刻不保证已就绪）。 */
function dirPath(): string {
  return wx.env.USER_DATA_PATH + '/' + DIR_NAME
}

/** 同一毫秒里连存两张也不撞名：时间戳 + 两位序号（冒烟里探针和保存可能挨着跑）。 */
let seq = 0
function newId(): string {
  seq = (seq + 1) % 100
  return String(Date.now()) + String(seq).padStart(2, '0')
}

/** 清单怎么读怎么写的唯一入口（损坏/缺失都当空 —— 自愈不做，见文件头）。 */
function readManifest(): WorkEntry[] {
  const v = wx.getStorageSync(KEY)
  return Array.isArray(v) ? (v as WorkEntry[]) : []
}

function writeManifest(list: WorkEntry[]): void {
  wx.setStorageSync(KEY, list)
}

/** 删文件不吵：已经没了 / 删不动都不拦流程（清单才是账本，别为文件卡死）。 */
function unlinkQuietly(path: string): void {
  try {
    wx.getFileSystemManager().unlinkSync(path)
  } catch (e) {
    /* 见上 */
  }
}

/** 文件多大事（读不到给 0 —— 刚 copy 成功还读不到就当没有，不值得为它整体失败）。
 *  ⚠️ statSync 的重载返回 `Stats | FileStats[]`（recursive 那支），这里永远传单文件，
 *  `Array.isArray` 那半只是为了取到 `.size` 而收窄类型。 */
function sizeOf(path: string): number {
  try {
    const st = wx.getFileSystemManager().statSync(path)
    return Array.isArray(st) ? 0 : st.size
  } catch (e) {
    return 0
  }
}

/** 目录不存在才建（accessSync 先探一下 —— mkdir 对已存在的目录会报错）。 */
function ensureDir(): void {
  const fsm = wx.getFileSystemManager()
  try {
    fsm.accessSync(dirPath())
  } catch (e) {
    try {
      fsm.mkdirSync(dirPath(), true)
    } catch (e2) {
      console.error('[works] 本地作品目录建不起来：' + reasonOf(e2))
      throw new Error('收进作品集失败：本地目录建不起来')
    }
  }
}

/** 量一张本地图的真实宽高 —— 记录进清单的就是它，**测得准**（见 `add` 的注释）。 */
function measure(srcPath: string): Promise<{ width: number; height: number }> {
  return new Promise((ok, no) => {
    wx.getImageInfo({
      src: srcPath,
      success: r =>
        r.width > 0 && r.height > 0 ? ok({ width: r.width, height: r.height }) : no(new Error('量不到图尺寸（宽高为 0）')),
      fail: e => no(new Error('读不到刚导出的文件（' + reasonOf(e) + '）')),
    })
  })
}

/**
 * 从导出的全尺寸文件生成一张长边 ~256px 的缩略图（离屏 2D 画布 `drawImage` +
 * `canvasToTempFilePath` —— 和 lib/image/export.ts 的 pixels 兜底路同一套玩法，
 * 那条在模拟器实测过走得通）。返回一张临时文件路径，调用方把它 copy 进 works 目录。
 * 失败抛人话 —— `add` 据此整体失败（**不许写半张**）。
 */
function makeThumb(srcPath: string, w: number, h: number): Promise<string> {
  const t = fitWithin(w, h, THUMB_SIDE)
  const canvas = wx.createOffscreenCanvas({ type: '2d', width: t.width, height: t.height })
  const ctx = canvas.getContext('2d') as WechatMiniprogram.IAnyObject
  const img = canvas.createImage()
  return new Promise((ok, no) => {
    img.onload = () => {
      try {
        ctx.drawImage(img, 0, 0, t.width, t.height)
      } catch (e) {
        no(new Error('缩略图画不出来（' + reasonOf(e) + '）'))
        return
      }
      wx.canvasToTempFilePath({
        canvas,
        x: 0,
        y: 0,
        width: t.width,
        height: t.height,
        destWidth: t.width,
        destHeight: t.height,
        fileType: 'jpg',
        quality: THUMB_QUALITY,
        // 空路径也当失败（同 export.ts 那条判据的收口）
        success: r => (r.tempFilePath ? ok(r.tempFilePath) : no(new Error('缩略图导出给了空路径'))),
        fail: e => no(new Error('缩略图导出失败（' + reasonOf(e) + '）')),
      })
    }
    img.onerror = () => no(new Error('缩略图加载不出来源图'))
    img.src = srcPath
  })
}

/** 全部作品，新的在前（「作品」页 onShow 直接喂 setData）。 */
function list(): WorkEntry[] {
  return readManifest()
}

/**
 * 收一张进作品集：`srcPath` = 刚导出的**全尺寸临时文件**。
 *
 * 步骤与顺序（顺序就是"不许写半张"的保证）：
 *   ① 量源文件 → ② cap 检查（超了抛 `WorksFullError`）→ ③ 建目录 → ④ 量真实宽高
 *   → ⑤ 生成缩略图（还没往 works 目录写任何东西 —— 这步失败就整体失败，目录是干净的）
 *   → ⑥ copy 全尺寸 + 缩略图进目录（任何一步炸了：把已写进去的清掉再抛）
 *   → ⑦ 清单前插 + 写 storage。
 *
 * 宽高**实测**（`measure`）而不是信调用方转述：导出在超设备上限的机器上会缩，
 * 量文件本体永远和存下来的那张一致。
 */
async function add(srcPath: string): Promise<WorkEntry> {
  const fsm = wx.getFileSystemManager()
  // ① 源文件先量（cap 要用它，顺带确认文件读得到）
  let srcBytes = 0
  try {
    const st = fsm.statSync(srcPath)
    srcBytes = Array.isArray(st) ? 0 : st.size
  } catch (e) {
    throw new Error('收进作品集失败：刚导出的文件找不到了')
  }
  // ② cap：现在清单的占用 + 这张全尺寸。缩略图那十几 KB 没算进来 ——
  //    和 150MB 的余量比可忽略（真到顶也就多放一张而已，坏事不在这）
  const before = readManifest()
  let used = 0
  for (const e of before) used += e.bytes
  if (used + srcBytes > CAP_BYTES) throw new WorksFullError('作品放满了，去「我的」清一清')
  // ③ 目录（后两步都往它里面写）
  ensureDir()
  // ④ 真实宽高（缩略图和清单都用它）
  const size = await measure(srcPath)
  // ⑤ 缩略图（先出图、后落章 —— 见函数头）
  const thumbTmp = await makeThumb(srcPath, size.width, size.height)
  // ⑥ 两个文件落进目录；炸了就把这半张清掉
  const id = newId()
  const file = dirPath() + '/w' + id + '.jpg'
  const thumb = dirPath() + '/w' + id + 't.jpg'
  try {
    fsm.copyFileSync(srcPath, file)
    fsm.copyFileSync(thumbTmp, thumb)
  } catch (e) {
    unlinkQuietly(file)
    unlinkQuietly(thumb)
    console.error('[works] 文件没能放进本地目录：' + reasonOf(e))
    throw new Error('收进作品集失败：文件没能放进本地目录')
  }
  // ⑦ 清单前插（重新读一遍再拼 —— await 期间清单可能被别人动过）
  const entry: WorkEntry = {
    id,
    file,
    thumb,
    w: size.width,
    h: size.height,
    bytes: sizeOf(file) + sizeOf(thumb),
    at: Date.now(),
  }
  try {
    writeManifest([entry, ...readManifest()])
  } catch (e) {
    // 清单没写下来 = 刚 copy 的两个文件没人记得住 —— 清掉，别当孤儿留在盘上
    //（T18 复审 M2；storage 写炸了都走这）
    unlinkQuietly(file)
    unlinkQuietly(thumb)
    console.error('[works] 清单没能写下来：' + reasonOf(e))
    throw new Error('收进作品集失败：清单没能写下来')
  }
  return entry
}

/**
 * 删几条（「作品」页长按删用；以后批删同一入口）：文件尽力删（删不动就算了）、
 * 清单必删（账本里不能再留着）。返回真删掉的条数（调用方拿去记日志）。
 */
function remove(ids: string[]): number {
  const kill: { [id: string]: true } = {}
  for (const id of ids) kill[id] = true
  const keep: WorkEntry[] = []
  let removed = 0
  for (const e of readManifest()) {
    if (kill[e.id]) {
      unlinkQuietly(e.file)
      unlinkQuietly(e.thumb)
      removed++
    } else {
      keep.push(e)
    }
  }
  if (removed) writeManifest(keep)
  return removed
}

/**
 * 清空（「我的」页用）：**枚举目录**全删（连清单外的孤儿文件一起 —— 这就是
 * 「不做清单自愈」的兜底），然后删清单。单个文件删不动不拦（再清一次即可）。
 */
function clear(): void {
  const fsm = wx.getFileSystemManager()
  try {
    for (const name of fsm.readdirSync(dirPath())) unlinkQuietly(dirPath() + '/' + name)
  } catch (e) {
    /* 目录不存在 = 本来就空 */
  }
  wx.removeStorageSync(KEY)
}

/** 占用统计（「我的」页显示 N 张 · X MB 用；cap 那一侧在 add 里自己算）。 */
function usage(): { count: number; bytes: number } {
  const l = readManifest()
  let bytes = 0
  for (const e of l) bytes += e.bytes
  return { count: l.length, bytes }
}

function reasonOf(e: unknown): string {
  return e && (e as Error).message ? (e as Error).message : String(e)
}

/** 这一族的唯一出口（名字照 spec §13.2 的叫法：list / add / remove / clear / usage）。 */
export const works = { list, add, remove, clear, usage }
