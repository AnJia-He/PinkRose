import type { Adjustments } from './adjustments.ts'

/**
 * 作品的**元数据** —— 不含图，也不含配方。
 *
 * 列表接口一次把这个用户的全部元数据给出去（§3.5：「名单本小，一下子全拿出来」），
 * 图再一张张取。所以这个结构要**小**：别往里加会变大的东西。
 */
export type WorkMeta = {
  id: number
  /** 用户起的名字。**空 = 用最后改动的时间当名字**（§3.5） */
  alias: string | null
  createdAt: number
  updatedAt: number
  bytes: number
  /** 有没有缩略图。没有的时候前端退回取原图（前端生成缩略图可能失败，见 Task 6） */
  hasThumb: boolean
  /** 0 = 未评分，1~5 星；用于选片和「只看精选」。 */
  rating: number
  /** -1 = 排除，0 = 未标记，1 = 保留。 */
  flag: WorkFlag
  /** Lightroom 风格的整理色标；缺省 = 没打色标（兼容旧数据）。 */
  color?: WorkColor
  /** 用户原文件名，只含基础文件名（无路径）；旧作品和程序生成成片可为 null。 */
  sourceName?: string | null
  /** EXIF 拍摄时间（毫秒）；没有可信拍摄时间时为 null，不拿上传时间冒充。 */
  capturedAt?: number | null
  /** EXIF 机身与镜头原始字段；旧作品或程序生成成片可为空。 */
  cameraMake?: string | null
  cameraModel?: string | null
  lensModel?: string | null
}

export type WorkFlag = -1 | 0 | 1

export const WORK_COLORS = ['none', 'red', 'yellow', 'green', 'blue', 'purple'] as const
export type WorkColor = typeof WORK_COLORS[number]

export const WORK_COLOR_LABELS: Record<WorkColor, string> = {
  none: '无',
  red: '红',
  yellow: '黄',
  green: '绿',
  blue: '蓝',
  purple: '紫',
}

export function isWorkColor(value: unknown): value is WorkColor {
  return typeof value === 'string' && (WORK_COLORS as readonly string[]).includes(value)
}

export function cameraName(
  work: Pick<WorkMeta, 'cameraMake' | 'cameraModel'>,
): string | null {
  const make = work.cameraMake?.trim()
  const model = work.cameraModel?.trim()
  if (!make) return model || null
  if (!model) return make
  return model.toLowerCase().startsWith(make.toLowerCase()) ? model : `${make} ${model}`
}

/** 用户自建的相册 / 收藏集。 */
export type AlbumMeta = {
  id: number
  name: string
  createdAt: number
  workCount: number
}

/**
 * **配方**：这张图是怎么来的。§3.5.1 说它必须分成两拦 ——
 *
 * - `params`：**调色**，能套到别的图上（纯数值）
 * - `edits`：**用 AI 做过哪几句原话**，套不走 —— 只对这张照片有意义
 *
 * ⚠️ **两拦永远是分开的两个字段。** 合成一个数组 = 用户会以为"这一整套都能复用"，
 * 而「把后面那个人去掉」换一张照片就是另一回事（§3.5.1，spec 点名要变异这条）。
 */
export type Recipe = {
  params: Adjustments
  edits: string[]
  /**
   * ★ 2026-10-05：这张作品的配方里用的滤镜。
   * **只存名字不存 id** —— 作品的图是存的时候烤好的，id 没有渲染作用；
   * 详情页「套到别的图上」按**名字**去找还在不在（滤镜被删了就只套调色）。
   *
   * ⚠️ **可选**（`?`）：2026-10-05 之前存的作品没有这个键。服务端 `readRecipe`
   * 出口一定给显式的 `null`（读的人不必再判 undefined），但**类型上是可选的** ——
   * 定成必填会让本任务把客户端的类型一起弄红，而那一步属于 Task 12。
   */
  lut?: { name: string; amount: number } | null
}

export type WorkDetail = WorkMeta & {
  recipe: Recipe
  /** 已开启分享时的 token；null / 缺省 = 没分享。只给作品主人。 */
  shareToken?: string | null
}

/** 公开分享页能看到的**最小一份**：没有用户、没有配方、没有硬盘文件名。 */
export type SharedWork = {
  token: string
  alias: string | null
  createdAt: number
  updatedAt: number
  hasThumb: boolean
}

/**
 * 能按天分组的东西要有的**最少那一个字段**。
 *
 * ⚠️ 分组和标签**只碰 `updatedAt`**，别的字段一概不看 —— 所以作品（`WorkMeta`）
 * 和会话（`SessionMeta`）都能喂进来，而 `DayGroup` 默认那个参数仍然是 `WorkMeta`，
 * 现有调用点一个字都不用改。
 */
export type DayGroupable = { updatedAt: number }

export type DayGroup<T extends DayGroupable = WorkMeta> = { day: string; label: string; works: T[] }

const pad = (n: number): string => String(n).padStart(2, '0')

/**
 * `'2026-09-25'` —— 分组和排序用的键。
 *
 * ⚠️ **别拿显示名当键**：显示名今年是「9月25日」、明年会变成「2026年9月25日」，
 * 拿它当键会在跨年那天错位。
 */
export function dayKey(ts: number): string {
  const d = new Date(ts)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/** 「9月25日」；**不是今年的才带年份** */
export function dayLabel(ts: number, now: number): string {
  const d = new Date(ts)
  const year = d.getFullYear() === new Date(now).getFullYear() ? '' : `${d.getFullYear()}年`
  return `${year}${d.getMonth() + 1}月${d.getDate()}日`
}

/**
 * 这张作品在界面上叫什么。
 *
 * **没起名字就用最后改动的时间**（§3.5）—— 于是「搜 9月25」自然就等于按日期搜，
 * 一个机制两种用法。这也是为什么这个函数住在 `shared/`：它是"名字"的唯一来源。
 */
export function workNameAt(w: WorkMeta, now: number, at: number): string {
  if (w.alias) return w.alias
  const d = new Date(at)
  return `${dayLabel(at, now)} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

export function workName(w: WorkMeta, now: number): string {
  return workNameAt(w, now, w.updatedAt)
}

/**
 * 搜索：按**屏幕上看得到的那个名字**匹配。
 *
 * 所以改了名之后，原来的日期就搜不到了 —— 那是**对的**：屏幕上没有那几个字了，
 * 还让它搜中的话，用户会看到"一堆屏幕上没这几个字的图"。
 */
export function matchesQueryAt(
  w: WorkMeta, query: string, now: number, at: number,
): boolean {
  const q = query.trim().toLowerCase()
  if (!q) return true
  const original = [
    w.sourceName, w.cameraMake, w.cameraModel, w.lensModel,
  ].filter((value): value is string => typeof value === 'string' && !!value.trim())
    .join(' ').toLowerCase()
  return workNameAt(w, now, at).toLowerCase().includes(q) || original.includes(q)
}

export function matchesQuery(w: WorkMeta, query: string, now: number): boolean {
  return matchesQueryAt(w, query, now, w.updatedAt)
}

/**
 * 按天分组，新的在前，组内也新的在前。
 *
 * ★ 泛型（Task 6）：**分组逻辑只有这一份** —— 对话列表（§6.1）和作品页用的是
 * 同一个函数、同一个 `dayLabel`。复制一份出来的话，同一天会在两页里显示成
 * 两个名字（一个「10月1日」一个「2026年10月1日」），而且没人会同时看着两页。
 */
export function groupByDay<T extends DayGroupable>(
  works: readonly T[], now: number, timeOf: (work: T) => number = work => work.updatedAt,
): DayGroup<T>[] {
  const sorted = [...works].sort((a, b) => timeOf(b) - timeOf(a))
  const groups = new Map<string, DayGroup<T>>()
  for (const w of sorted) {
    const at = timeOf(w)
    const key = dayKey(at)
    let g = groups.get(key)
    if (!g) {
      g = { day: key, label: dayLabel(at, now), works: [] }
      groups.set(key, g)
    }
    g.works.push(w)
  }
  return [...groups.values()]
}
