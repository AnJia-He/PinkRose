import { PARAM_KEYS, type Adjustments } from '../../shared/adjustments.ts'
import type { LutRef } from '../../shared/lut.ts'
import type { DecodedImage } from '../image/decode'
// ⚠️ 和 `history.ts` 是**互相**引用：那边只 import 本文件的 `EditState` 类型，
//    编译后一行不剩；本文件要 `bitmapsToClose` / `closeBitmaps` 是**真的运行时**
//    依赖（`settleLedger` 用）—— 方向是单向的（ledger → history），
//    所以不存在运行时循环。
import { bitmapsToClose, closeBitmaps, type Snapshot } from './history'

/**
 * 账本上的一笔 = 一个可以退回去的画面状态。
 * ⚠️ `base` 是**干净底图**（参数/滤镜不烘焙进去，09-21 spec §3.4 铁律）；
 *   调色类的笔记 `base` 与相邻笔**共享同一个对象**（零内存），只有裁剪/点修
 *   的笔才持有新位图。
 */
export type EditState = {
  base: DecodedImage
  params: Adjustments
  lut: LutRef | null
  /** 入账序号（全局单调，App 的发号器给）：预算驱逐按它排队。 */
  seq: number
}

/**
 * 所有版本账本里**额外保留**的底图总像素上限（spec §6 的预算，初值）。
 *
 * 口径和 `enforceLedgerBudget` 的 `measure` 是同一件事：只数 `past`/`future` 里的
 * 底图，**当前位置的 `base` 不算** —— 它本来就属于那一版、由 `MAX_SNAPSHOTS` 管着；
 * 这个预算管的是"为了能退回去而**多**留的那些底稿"。只有换过底图的笔（裁剪 /
 * 点修）占地方，调色笔与相邻笔共享同一个对象、零成本。
 *
 * 32_000_000 = 3200 万像素 ≈ 七八张 2048×2048 的底稿。
 * ⚠️ 真机验收后按内存占用调这个数（spec §6 明说）。
 */
export const LEDGER_PIXEL_BUDGET = 32_000_000

/**
 * 记一笔：把"改之前"压进 `past`、**清空 `future`**、当前位置换成 `next`。纯函数。
 *
 * ⚠️ **必须返回新数组**（`[...s.past, before]`）：快照到处都是 `{...s}` 浅展开，
 *   `past`/`future` 是**共享的数组引用** —— 一旦原地 `push`，改一版会让别的版本
 *   跟着变，而且一句错都不报。
 *
 * ⚠️ 入账用的是 **`before.seq`**（调用方在构造 `before` 时发号，发号器在 `App` 的
 *   `editSeqRef`）；第 4 个参数收下**不用** —— 签名里留着是为了让"每个记账点都被
 *   编译期逼着表态发过号"（少传一个就编译不过）。调用方（`App`）写的都是
 *   `before` 带同一个号、第 4 个参数再传一遍，两边恒等。
 */
export function pushEdit(s: Snapshot, before: EditState, next: Omit<EditState, 'seq'>, _seq: number): Snapshot {
  return { ...s, past: [...s.past, before], future: [], base: next.base, params: next.params, lut: next.lut }
}

/**
 * 上一步：「当前位置」压进 `future` 的**队首**，`past` 的最后一笔变成当前位置。
 *
 * `past` 空（已经站在出生那一笔上）时**返回同一引用** —— React 靠它跳过白渲染，
 * 别改成"返回一份拷贝"。
 *
 * ⚠️ 入栈的这一笔给 `seq: 0` 是**有意**的：预算驱逐按 seq 挑最老的丢，0 让它在内存
 *   吃紧时最先出局（`future` 是"还没决定要不要再回去"的位置，可弃）；也别"修"成
 *   继承某个真号。`seq` 不参与任何显示（位置是数出来的，见 `ledgerIndex`）。
 */
export function undoEdit(s: Snapshot): Snapshot {
  if (s.past.length === 0) return s
  const cur: EditState = { base: s.base, params: s.params, lut: s.lut, seq: 0 }
  return {
    ...s,
    past: s.past.slice(0, -1),
    future: [cur, ...s.future],
    base: s.past[s.past.length - 1]!.base,
    params: s.past[s.past.length - 1]!.params,
    lut: s.past[s.past.length - 1]!.lut,
  }
}

/** 下一步：`undoEdit` 的反面（`future` 空时同样返回同一引用）。 */
export function redoEdit(s: Snapshot): Snapshot {
  if (s.future.length === 0) return s
  const cur: EditState = { base: s.base, params: s.params, lut: s.lut, seq: 0 }
  const head = s.future[0]!
  return { ...s, past: [...s.past, cur], future: s.future.slice(1), base: head.base, params: head.params, lut: head.lut }
}

/**
 * 账本位置：**第几笔**（1 起数 —— 出生那一笔就是第 1）。
 * 调色屏左下角那组箭头显示的就是它（"第 2 / 共 5"），所以口径必须和 `ledgerTotal` 一致。
 */
export const ledgerIndex = (s: Snapshot): number => s.past.length + 1

/** 账本一共几笔（两边的历史 + 当前位置）。`total > 1` 才画那组箭头（spec §5.3）。 */
export const ledgerTotal = (s: Snapshot): number => s.past.length + 1 + s.future.length

/**
 * 两处"画面状态"是不是同一个 —— 净变化为零的调整**不记一笔**（spec §5.1）就靠它：
 * 滑块拖走又拖回原值，不该在账本上留一条空笔。
 *
 * ⚠️ 三个字段的判据**故意不一样**：
 *   · `base` 认**对象身份**：同一次裁剪的产物才是同一个对象；"宽高一样"的两张图
 *     是两个不同的位图（可能是同一张图裁出来的两次），比值说不了这件事。
 *   · `params` 逐键比**值**，键走 `PARAM_KEYS`（不手写键名 —— 以后加参数自动跟上）。
 *   · `lut` 也比值（`lutId` + `amount`）：它和 `params` 是并列的两件事（滤镜设计
 *     §3.2），一边有一边没有、或强度差 1，都算变过。
 */
export function sameEdit(a: { base: DecodedImage; params: Adjustments; lut: LutRef | null },
                         b: { base: DecodedImage; params: Adjustments; lut: LutRef | null }): boolean {
  if (a.base !== b.base) return false
  for (const k of PARAM_KEYS) if (a.params[k] !== b.params[k]) return false
  const la = a.lut, lb = b.lut
  if (la === null || lb === null) return la === lb
  return la.lutId === lb.lutId && la.amount === lb.amount
}

/**
 * 内存预算封顶：超了就丢**最早的非出生笔**（整笔丢，不是只丢位图），直到回到预算内。
 * 返回留下的 `list` 和**可以从内存里放掉的位图**（`toClose`，调用方负责 `close()`）。
 *
 * 三条规矩（spec §6，就是 Photoshop 那三道"上限封顶 / 出生保留 / 满了丢最老"）：
 *   · 只数 `past`/`future` 里的底图（账本"额外保留"的那些，按对象去重）；
 *   · **出生笔（`past[0]`）和当前位置永不丢** —— 丢了用户就回不到"这一版从哪来"；
 *     只剩出生笔还超就让它超着（版本数另有 `MAX_SNAPSHOTS` 封着）；
 *   · `seq` 全局单调，所以"跨版本、跨 past/future"比大小就能挑出全局最老的那一笔。
 *
 * ⚠️ `toClose` 两道闸，缺一个都是真事故：**同一张位图只报一次**（`Set`），
 *   且**还被任何地方引用着的一张都不能进**（`alive` 含每个快照的当前位置和留下的
 *   每一笔）—— 关了还在用的就是闪黑且不报错。口径和 `history.ts` 的
 *   `bitmapsToClose` 是同一件事（都认"活位图"），别只改一边。
 * ⚠️ 预算内**一个字节都不许动**：不改元素引用（React 不必白渲染）。
 */
export function enforceLedgerBudget(
  list: readonly Snapshot[], budgetPx: number,
): { list: Snapshot[]; toClose: DecodedImage[] } {
  const out: Snapshot[] = list.map(s => s)   // 浅拷贝一份数组（元素不动）
  const px = (b: DecodedImage) => b.width * b.height
  const measure = (ls: readonly Snapshot[]) => {
    const seen = new Set<DecodedImage>(); let sum = 0
    for (const s of ls) for (const b of [...s.past.map(p => p.base), ...s.future.map(f => f.base)])
      if (!seen.has(b)) { seen.add(b); sum += px(b) }
    return sum
  }
  const dropped: DecodedImage[] = []
  while (measure(out) > budgetPx) {
    // 候选 = 所有版本里 past[1..] 与 future 的笔（出生笔不参选），挑 seq 最小的那一笔丢
    let best: { si: number; where: 'past' | 'future'; idx: number; seq: number } | null = null
    out.forEach((s, si) => {
      s.past.forEach((e, idx) => {
        if (idx === 0) return
        if (!best || e.seq < best.seq) best = { si, where: 'past', idx, seq: e.seq }
      })
      s.future.forEach((e, idx) => {
        if (!best || e.seq < best.seq) best = { si, where: 'future', idx, seq: e.seq }
      })
    })
    if (!best) break                       // 只剩出生笔：超就超着（上限仍被版本数封住）
    const b = best as { si: number; where: 'past' | 'future'; idx: number }
    const s = out[b.si]!
    dropped.push(b.where === 'past' ? s.past[b.idx]!.base : s.future[b.idx]!.base)
    out[b.si] = b.where === 'past'
      ? { ...s, past: s.past.filter((_, i) => i !== b.idx) }
      : { ...s, future: s.future.filter((_, i) => i !== b.idx) }
  }
  // 还活着的位图一张都不能关（共享引用）；被丢的同一张也只许报一次
  const alive = new Set(out.flatMap(s => [...s.past.map(p => p.base), ...s.future.map(f => f.base), s.base]))
  const toClose = [...new Set(dropped.filter(b => !alive.has(b)))]
  return { list: out, toClose }
}

/**
 * ★ 2026-10-08（调色区账本 Task 5，spec §6）：**记账之后的统一收口** ——
 * 四处记账点（`flushEdit` / `commitCrop` / `commitRetouch` / `ledgerStep`）
 * 每记完一笔都走它，别在各处各写一遍（★ 2026-10-08 从 `App.tsx` 搬进 `core` ——
 * 它是纯逻辑，且 `app/baseEdit.ts` 那份共享骨架也要用它）。
 *
 * 两件事**一起**做，缺一件都是"错了不报错"：
 *   · **预算闸**（`enforceLedgerBudget`）：所有版本账本里额外留着的底图超了
 *     `LEDGER_PIXEL_BUDGET`（3200 万像素，初值）就**整笔**丢掉最早的那些
 *     （Photoshop 那三道：上限封顶 / 出生保留 / 满了丢最老）——出生笔和当前笔
 *     永不丢，丢了用户就回不到"这一版从哪来"；
 *   · **位图回收**：被驱逐的那些 + 这一趟离开 `history` 的那些，一起 `close()`。
 *     `close()` 幂等，所以写在 `setHistory` 的 updater 里也安全（StrictMode
 *     重放 updater 时不会关两遍出事）。
 *
 * ⚠️ **两份 `toClose` 都要**，不是二选一：驱逐是"预算"这条线，`bitmapsToClose`
 *   是"位图离开了历史"那条线（原来四个记账点各自都有的那一句）。只取前者的
 *   话，`cutAfter` / 删除那几条路上漏下的位图就没人关了 —— 那是纯泄漏、而且
 *   一句错都不报。
 * ⚠️ 传进来的 `withEdit` 必须**已经记完那一笔**（`pushEdit` 的结果）：闸看到
 *   的就是那份账本。`prev` 是记账之前的那份（回收要跟它比）。
 * ⚠️ 预算内它不改元素的引用（`enforceLedgerBudget` 只浅拷数组）—— React 靠
 *   引用相等跳过白渲染，别在这儿顺手 `map` 一遍。
 */
export function settleLedger(prev: readonly Snapshot[], withEdit: readonly Snapshot[]): Snapshot[] {
  const { list, toClose } = enforceLedgerBudget(withEdit, LEDGER_PIXEL_BUDGET)
  closeBitmaps([...toClose, ...bitmapsToClose(prev, list, { protectOriginal: true })])
  return list
}
