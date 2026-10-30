import type { Adjustments } from '../../shared/adjustments.ts'
import type { LutRef } from '../../shared/lut.ts'
import type { EditLayer } from '../../shared/layers.ts'
import type { DecodedImage } from '../image/decode'
import type { EditState } from './ledger'

export type Snapshot = {
  /** 与聊天记录里那条助手消息同 id —— 「回到这一步」按钮靠它对上号。 */
  id: number
  /** 给用户看的短标签，比如"原图"。 */
  label: string
  /**
   * **当前位置这一笔**叫什么（“原图”“裁剪”“调色”“这一磨”…）。
   *
   * ★ 2026-10-19：账本历史面板要用它给每一笔起名字。`label` 是**版本**的
   *   标签（原图 / 生成式编辑），这一份是**这一版里最后一笔编辑**的标签，
   *   两者不是一回事。
   */
  editLabel?: string
  /**
   * 走到这一步的**那句话**（用户的原话，已经过服务端补全的英文 prompt）。
   *
   * ★ 2026-09-30 加，为「再来一版」。原来只有 `label`，那条是**给我的**
   * 分类（"生成式编辑"），不是给用户的那句话 —— 靠它重跑不了。
   *
   * 缺席（undefined）表示这一步没有可重跑的指令：原图、以及将来任何
   * 不是"一句话生成出来的"步骤。**别写成空串**，两者语义不同：
   * 空串是"有指令但是空的"，那会让「再来一版」出现在一个按不动的按钮上。
   */
  prompt?: string
  base: DecodedImage
  params: Adjustments
  /**
   * 这一步用着哪个滤镜、强度多少（null = 没用）。
   *
   * ★ 2026-10-05（滤镜）：和 `params` 是**并列的两件事**（滤镜不是参数里的一个数字，
   * 见设计 §3.2），但走的是**同一条路**：按步记下来、跟着这一步一起还原。
   * 今天它有三个用处：
   *   · 「回到这一步」（`App` 的 `onJump`）把 `setParams(target.params)` 和
   *     `setLut(target.lut)` **一起**做 —— 少还原滤镜的话，主画面和那条气泡上的
   *     小图（从带滤镜的画面上抓的）对不上，而「回到原图」也不再是原图；
   *   · 用户把某个滤镜删掉时，`App` 的 `dropGoneLut` 要把它从这几步里清掉；
   *   · 从服务端接回来时它是 `SessionStep.lut` 的落点，最后一步那一份还会
   *     被设回"当前滤镜"。
   *
   * ⚠️ **它今天也上不了"服务端那半"的车**：落盘时它确实跟着 `steps` 一起送
   * （`App` 里那个 `snapshot` 映射），但服务端 `mergeSteps` 对**库里已有的 id**
   * 是**原样保留库里那条**（`if (old) { out.push(old); continue }`）—— 客户端
   * 送来的 params / prompt / lut 对一个已有 id 一个字都不采纳（历史不许被客户端
   * 改写）。真正从 payload 构造的只有**新步骤**，而新步骤紧接着被顶层 `patch.lut`
   * 盖成"当前滤镜"。所以那一份**今天是无效载荷**：留着是因为它就是 `SessionStep`
   * 的形状（`lut` 是线上格式的一部分），哪天服务端改成"客户端赢"它就有意义了。
   *
   * ⚠️ **必填，不是可选**：定成可选的话，多一个构造点忘了写它就是"这一步的滤镜
   * 静默丢了"（`useGeneration` 推快照 / 恢复会话那两处各是一个）。定成必填，
   * 每个构造点都被编译期逼着表态 —— **原图那一步就是 `lut: null`**。
   */
  lut: LutRef | null
  /** 这一步的文字层（★ 2026-10-19）。缺席 = 没有文字层，老数据照旧。 */
  layers?: EditLayer[]
  /** 原图。这一条永远不会被挤出去。 */
  isOriginal: boolean
  /**
   * 当前位置**之前**的历史。`past[0]`（非空时）= 这一版的出生状态，永不驱逐。
   *
   * ★ 2026-10-08（调色区账本）：老字段 `base` / `params` / `lut` = 这一版账本的
   *   **当前位置**（语义没变，读它们的老代码一行不用改），`past` / `future`
   *   围着它转。本任务只搭数据形状 —— 所有构造点给的都是空数组，记账从 Task 2 起。
   *
   * ⚠️ **必填，不是可选**：定成可选的话，多一个构造点忘了写它就是"这一版的账本
   *   静默从缺"（和 `lut` 同一条理由）。定成必填，每个构造点都被编译期逼着表态
   *   —— 新快照就是 `past: [], future: []`。
   */
  past: EditState[]
  /** 退过之后的位置（「下一步」走这里）。新记账会清空它。 */
  future: EditState[]
  /**
   * 这一步长什么样的缩略图（data URL）。**空串 = 还没生成**。
   *
   * 为什么是字符串不是位图：位图占 GPU 内存，一步一张、最多六步，
   * 而缩略图的价值远不值那个代价。一张 data URL 约 5~10 KB，普通内存。
   *
   * 为什么会有"还没生成"这个中间态：快照是在 `setParams` / `setImage`
   * **同一个批次**里推入的，而那一刻画布还没重画（React 的状态更新是异步的）。
   * 直接抓会抓到**上一步的颜色**。所以先推空，等画面更新后由 App 补上
   * （见 src/App.tsx 里那个 effect）。
   */
  thumb: string
}

/**
 * 最多留几步。
 *
 * 每一条生成式快照的 base 是一张 2048 长边的位图，占的是 GPU 内存；
 * 原图更贵（全分辨率）。6 步足够覆盖一次真实的修图对话。
 */
export const MAX_SNAPSHOTS = 6

/** 追加一步。超过上限时丢最老的**非原图**条目。纯函数，不改入参。 */
export function pushSnapshot(list: readonly Snapshot[], s: Snapshot): Snapshot[] {
  const out = [...list, s]
  while (out.length > MAX_SNAPSHOTS) {
    const i = out.findIndex(x => !x.isOriginal)
    if (i < 0) break          // 理论上不可能（只有一条原图），但不能死循环
    out.splice(i, 1)
  }
  return out
}

/**
 * 从某一步继续改：把它**之后**的步骤全部切掉（那一步保留）。
 *
 * ★ 2026-10-05 改名（原名 `jumpTo`）："跳转"不再删任何东西了（见 `App` 的
 *   `onJump`）—— 只有"从这个位置**再生成一版**"才切（`runGenerate` 的
 *   `origin`）。名字跟着语义走：留着 `jumpTo` 这个名字，下一个读的人会以为
 *   跳转还会截断，而它不会了。
 *
 * 找不到 id 时返回一份拷贝 —— 不做任何事，但也不让调用方拿到同一个引用，
 * 免得 React 以为状态变了（原 `jumpTo` 的行为，一字未改）。
 */
export function cutAfter(list: readonly Snapshot[], id: number): Snapshot[] {
  const i = list.findIndex(s => s.id === id)
  return i < 0 ? [...list] : list.slice(0, i + 1)
}

/**
 * 给某一步补上缩略图。纯函数，不改入参。
 *
 * 找不到那个 id 时返回一份拷贝 —— 不做任何事，但也不让调用方拿到同一个引用，
 * 免得 React 以为状态变了。
 */
export function attachThumb(
  list: readonly Snapshot[], id: number, thumb: string,
): Snapshot[] {
  return list.map(s => (s.id === id ? { ...s, thumb } : s))
}

/** 一个快照名下活着的全部底图（当前位置 + 账本）。按对象去重。 */
export function snapshotBitmaps(s: Snapshot): DecodedImage[] {
  const out: DecodedImage[] = []
  const seen = new Set<DecodedImage>()
  for (const b of [s.base, ...s.past.map(p => p.base), ...s.future.map(f => f.base)]) {
    if (!seen.has(b)) { seen.add(b); out.push(b) }
  }
  return out
}

/**
 * 算出哪些位图可以从内存里放掉了。
 *
 * 位图占 GPU 内存，不 close 会一直攒着，几次生成就能把标签页拖垮。
 * 但**还在用的一张都不能关**——关了画布直接空白。
 *
 * ★ 2026-10-08（调色区账本）：「还在用」的集合从"每一步的 `base`"扩成
 *   "每一个快照名下活着的全部底图（`base` + 账本里的每一笔）"（见
 *   `snapshotBitmaps`）—— 账本里的位图漏一个就是泄漏，关早一个就是闪黑。
 *   两处去重都是必须的：`keep` 认"还被别处引用着"，`seen` 认"同一张在
 *   `before` 里被两条路引用着"（调色笔与相邻笔共享底图对象，只许关一次）。
 */
export function bitmapsToClose(
  before: readonly Snapshot[],
  after: readonly Snapshot[],
  opts: { protectOriginal?: boolean } = {},
): DecodedImage[] {
  const keep = new Set(after.flatMap(snapshotBitmaps))
  const out: DecodedImage[] = []
  const seen = new Set<DecodedImage>()
  for (const s of before) {
    if (opts.protectOriginal && s.isOriginal) continue   // 原图整个账本都不关
    for (const b of snapshotBitmaps(s)) {
      if (keep.has(b) || seen.has(b)) continue
      seen.add(b); out.push(b)
    }
  }
  return out
}

/**
 * 关掉一批位图（`bitmapsToClose` 的产物）。
 *
 * ★ 2026-10-04：这句 `for…close()` 原来在四处各写了一遍（切换会话、换图、
 *   归零、「回到这一步」）—— 收成一句，理由只有一份：**不关就是"切几次把
 *   标签页拖垮"**（ImageBitmap 占 GPU 内存，32 MP 一张约 129 MB）。
 *   `close()` 幂等 —— StrictMode 重放 updater 也安全（见 open 那段的注释）。
 * ★ 2026-10-08：从 `App.tsx` 搬进这儿（`settleLedger` 也用它，两处都要）。
 */
export function closeBitmaps(imgs: readonly DecodedImage[]): void {
  for (const img of imgs) img.bitmap.close()
}
