import { PARAM_KEYS, type Adjustments } from '../../shared/adjustments.ts'
import type { LutRef } from '../../shared/lut.ts'
import { sameEditLayers, type EditLayer } from '../../shared/layers.ts'
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
  /** 这一笔的文字层（★ 2026-10-19）；缺席 = 没有文字层。 */
  layers?: EditLayer[]
  /** 这一笔在历史面板里叫什么（“裁剪”“调色”“这一磨”…）。 */
  label?: string
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
 * ★ 2026-10-10（用户原话：「调色界面的回溯应该是[不]重复记忆的状态，刚才我试了
 *   一下两个滤镜重复切换记录了4个应该只算两个才对」）：**回到账本上已经有的那个
 *   画面 = 把位置挪过去，不再记一笔** —— 账本记的是"画面"，不是"操作流水"。
 *   来回切两个滤镜（A→B→A→B…）永远只有「出生 + A + B」三笔、人在两笔之间来回走；
 *   不认这一条的话每切一次涨一笔，用户按十下「上一步」都退不出他自己刚才那两步。
 *
 * 三条边界（都是"错了不报错"那一类，动这里之前先看）：
 *   · 判据是 `sameEdit` —— 它的 base **认对象身份**，所以这条**只可能在调色 /
 *     滤镜那条路上发生**：裁剪 / 点修每一刀都是一张**新位图**（哪怕宽高恰好一样），
 *     永远匹配不上，照旧老老实实记一笔。`ledger.test.ts` 有一条边界用例钉着。
 *   · 让出来的那一笔进 `future`（和 `undoEdit` 同一个位置口径）——「下一步」
 *     **还走得回去**，什么都不丢。所以这不是"撤销"，只是把位置挪一下。
 *   · 匹配到的那一笔**保持原样**（连 `seq` 都不动）；被让出去的那一笔拿 `seq: 0`
 *     （同 `undoEdit` 那条：`future` 是"还没决定要不要再回去"的位置，预算吃紧时
 *     它先出局）。`past` 先于 `future` 找 —— 同一张画面两边都出现时（理论上账本
 *     自己不该有重复，但这是纯函数、不替调用方担保）优先"往回走"。
 *
 * ⚠️ **每个分支都必须返回新数组**（`[...s.past, before]` / `slice`）：快照到处都是
 *   `{...s}` 浅展开，`past`/`future` 是**共享的数组引用** —— 一旦原地 `push`，
 *   改一版会让别的版本跟着变，而且一句错都不报。
 *
 * ⚠️ 入账用的是 **`before.seq`**（调用方在构造 `before` 时发号，发号器在 `App` 的
 *   `editSeqRef`）；第 4 个参数收下**不用** —— 签名里留着是为了让"每个记账点都被
 *   编译期逼着表态发过号"（少传一个就编译不过）。调用方（`App`）写的都是
 *   `before` 带同一个号、第 4 个参数再传一遍，两边恒等。挪位置那条路上连 `before`
 *   都用不上（没记这一笔，号白跳一个 —— 无害，号允许有空洞，它只用来比先后）。
 */
export function pushEdit(s: Snapshot, before: EditState, next: Omit<EditState, 'seq'>, _seq: number): Snapshot {
  /** 当前位置 —— 挪位置时它顶上 `future` 的队首（`seq: 0`，同 `undoEdit` 的口径）。 */
  const here: EditState = {
    base: s.base, params: s.params, lut: s.lut, layers: s.layers,
    label: s.editLabel ?? '原图', seq: 0,
  }
  const back = s.past.findIndex(e => sameEdit(e, next))
  if (back >= 0) {
    const hit = s.past[back]!
    return {
      ...s,
      past: s.past.slice(0, back),
      future: [...s.past.slice(back + 1), here, ...s.future],
      base: hit.base, params: hit.params, lut: hit.lut, layers: hit.layers,
      editLabel: hit.label ?? '调整',
    }
  }
  const fwd = s.future.findIndex(e => sameEdit(e, next))
  if (fwd >= 0) {
    const hit = s.future[fwd]!
    return {
      ...s,
      past: [...s.past, here, ...s.future.slice(0, fwd)],
      future: s.future.slice(fwd + 1),
      base: hit.base, params: hit.params, lut: hit.lut, layers: hit.layers,
      editLabel: hit.label ?? '调整',
    }
  }
  return {
    ...s, past: [...s.past, before], future: [],
    base: next.base, params: next.params, lut: next.lut, layers: next.layers,
    editLabel: next.label ?? '调整',
  }
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
  const cur: EditState = {
    base: s.base, params: s.params, lut: s.lut, layers: s.layers,
    label: s.editLabel ?? '原图', seq: 0,
  }
  return {
    ...s,
    past: s.past.slice(0, -1),
    future: [cur, ...s.future],
    base: s.past[s.past.length - 1]!.base,
    params: s.past[s.past.length - 1]!.params,
    lut: s.past[s.past.length - 1]!.lut,
    layers: s.past[s.past.length - 1]!.layers,
    editLabel: s.past[s.past.length - 1]!.label ?? '调整',
  }
}

/** 下一步：`undoEdit` 的反面（`future` 空时同样返回同一引用）。 */
export function redoEdit(s: Snapshot): Snapshot {
  if (s.future.length === 0) return s
  const cur: EditState = {
    base: s.base, params: s.params, lut: s.lut, layers: s.layers,
    label: s.editLabel ?? '原图', seq: 0,
  }
  const head = s.future[0]!
  return {
    ...s, past: [...s.past, cur], future: s.future.slice(1),
    base: head.base, params: head.params, lut: head.lut, layers: head.layers,
    editLabel: head.label ?? '调整',
  }
}

/**
 * 跳到账本里的任意一笔（1 起数）。越界会夹到两端。
 *
 * 和 `undoEdit` / `redoEdit` 是同一件事的“一步”和“直接跳”：目标之前进 `past`、
 * 之后进 `future`，目标本身成为当前位置。引用不变时返回原对象。
 */
export function jumpLedger(s: Snapshot, index: number): Snapshot {
  const total = ledgerTotal(s)
  const target = Math.max(1, Math.min(total, Math.round(index)))
  if (target === ledgerIndex(s)) return s
  const states: EditState[] = [
    ...s.past,
    {
      base: s.base, params: s.params, lut: s.lut, layers: s.layers,
      label: s.editLabel ?? '原图', seq: 0,
    },
    ...s.future,
  ]
  const hit = states[target - 1]!
  return {
    ...s,
    past: states.slice(0, target - 1),
    future: states.slice(target),
    base: hit.base,
    params: hit.params,
    lut: hit.lut,
    layers: hit.layers,
    editLabel: hit.label ?? '调整',
  }
}

/** 账本每一笔的显示名（顺序 = 从出生到最后一笔）。 */
export function ledgerLabels(s: Snapshot): string[] {
  return [
    ...s.past.map(e => e.label ?? '调整'),
    s.editLabel ?? '原图',
    ...s.future.map(e => e.label ?? '调整'),
  ]
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
export function sameEdit(a: { base: DecodedImage; params: Adjustments; lut: LutRef | null;
                           layers?: EditLayer[] },
                         b: { base: DecodedImage; params: Adjustments; lut: LutRef | null;
                           layers?: EditLayer[] }): boolean {
  if (a.base !== b.base) return false
  for (const k of PARAM_KEYS) if (a.params[k] !== b.params[k]) return false
  const la = a.lut, lb = b.lut
  if (la === null || lb === null) {
    if (la !== lb) return false
  } else if (la.lutId !== lb.lutId || la.amount !== lb.amount) {
    return false
  }
  return sameEditLayers(a.layers, b.layers)
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
