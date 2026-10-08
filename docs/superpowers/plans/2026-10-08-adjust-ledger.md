# 调色区账本（每版一本修改记录）实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 调色区里的一切操作（裁剪 / 点修 / 调色）都只改「当前这一版」——不往转盘加格；左下角箭头改成翻这本"修改账本"（上一步 / 下一步）；落盘改成"哪一版改了就存哪一版"，且像素一律存干净底图（顺带修掉探针抓到的"刷新后参数应用两次"）。

**Architecture:** 每个 `Snapshot`（= 转盘一格 = 一个对话版本）带一本账：`past` / `future` 两个 `EditState[]`，而 `base` / `params` / `lut` 三个既有字段 = 账本的**当前位置**（语义不变，读它们的老代码一行不用改）。裁剪/点修/调色的落定各自变成 `pushEdit`（把"改之前"压进 `past`、清空 `future`）。落盘新开一个 `stateStepId` 协议位：`params`/`lut`/`base` 挂在"正在编辑的那一版"上（不再写死最后一步）；`base` 从**干净位图**编码（画布只留给封面缩略图）。

**Tech Stack:** React 18 · TypeScript · 既有 WebGL 管线 · vitest（jsdom）· Playwright 探针（真机）· Express/SQLite 后端（`server/sessions.ts`）。

**Spec:** `docs/superpowers/specs/2026-10-08-adjust-ledger-design.md`（**执行前先通读**；探针证据在 §3 的 `.superpowers/probe-persist-bake.mjs`）

## Global Constraints

- **调色区的操作不进转盘**：裁剪 / 点修 / 调色都不加 `.strip-node` 格子（spec §5.4）。
- **箭头翻账本、不翻版本**：`ui/StepNav` 从"翻版本"改成"翻当前版本的账本"，且**不跟对话打交道**（一条消息不产生、一步不切、一分钱不花）（spec §5.3）。
- **底图永远干净**：参数 / 滤镜**绝不烘焙进 `base`**（09-21 spec §3.4 铁律；10-08 探针实测落盘违反了它，本轮修）。
- **出生笔与当前位置永不丢**：预算驱逐跳过 `past[0]` 和"当前所见"（spec §6）。
- **预算**：`LEDGER_PIXEL_BUDGET = 3200 万像素`（所有版本账本里额外保留的底图总像素；真机验收后按内存调）。
- **落盘**：只认"哪一版脏了存哪一版"（`stateStepId`）；**版本跳转前先 flush**（消灭"两版同时脏"）（spec §7）。
- **刷新后**：账本清空（每版只剩当前位置一笔）、照片样子（底图+参数+滤镜）不丢、**不翻倍**。
- 提交前 `npm test` + `npm run typecheck` **两个都要绿**；改完 UI 跑一次 `npm run check:layout`。
- ⚠️ **后端不热重载**：改了 `server/` 要重启才能被真机探针看到。
- ⚠️ **中间态说明**：Task 3 之后、Task 8 之前，"裁剪的落盘"还走旧路（刷新会丢裁剪）——这是计划内的中间态，Task 8 修好；**这两段之间别切分支给别人用**。

---

## 文件结构

| 文件 | 职责 |
|---|---|
| `src/core/ledger.ts`（新） | 账本的**纯逻辑**：`EditState` 类型、记账/上一步/下一步/计数、净零判断、预算驱逐。不碰 React、不碰 DOM。 |
| `src/core/ledger.test.ts`（新） | 上面那批纯函数的单测。 |
| `src/core/history.ts`（改） | `Snapshot` 加 `past`/`future`；`bitmapsToClose` 认账本（收集活位图）。 |
| `src/core/history.test.ts`（改） | 构造点补 `past`/`future`；新增"回收认账本"用例。 |
| `src/App.tsx`（改） | `commitCrop`/`commitRetouch` 改记账；写回 effect 改写（现场镜像 + 起一笔 + 定稿闹钟）；`flushEdit` 与各定稿点；箭头接线（`ledgerStep`）；`markDirty`/`dirtyRef`；落盘 effect 重写；缩略图维护；`loadSession` 的离屏小图。 |
| `src/app/useLocalStep.ts` + `.test.ts`（删） | 裁剪/点修不再推快照，这个入口退役。 |
| `src/app/useGeneration.ts`（改） | deps 加 `flushEdit`，成功路径（baseSeq 闸门之后）先定稿再推新版本。 |
| `src/ui/StepNav.tsx`（微改） | 只改 `aria-label` 组名文案（`切换版本` → 账本的说法）。 |
| `src/api/sessions.ts`（改） | `SessionPatch` 加 `stateStepId?: number`。 |
| `server/sessions.ts`（改） | `mergeSteps` 认 `stateStepId`（新文件落在指定那一步的 image 上）；`params`/`lut` 写指定那一步；id 校验。 |
| `server/sessions.test.ts`（改/新） | 上面那批的服务端用例。 |
| `docs/文案规范.md`（改） | 「上一步 / 下一步」那条的说法跟着账本改。 |
| `docs/superpowers/specs/2026-10-06-edit-tools-design.md`（改） | 那条"版本照旧进转盘"的更正块**再更正一次**（作废）。 |
| `.superpowers/probe-adjust-ledger.mjs`（新，不进库） | 真机探针（零模型花费）。 |

---

### Task 1: `Snapshot` 长出账本（类型 + 构造点 + 位图回收认账本）

**Files:**
- Create: `src/core/ledger.ts`（**只放 `EditState` 类型**，函数在 Task 2）
- Modify: `src/core/history.ts`（`Snapshot` 加 `past`/`future`；`bitmapsToClose` 扩展）
- Modify: `src/core/history.test.ts`（构造点补字段 + 新用例）
- Modify: `src/app/useGeneration.ts`（新快照带空账本）
- Modify: `src/app/useLocalStep.ts`（同上——它 Task 3 才退役，先让它编译过）
- Modify: `src/App.tsx`（`loadSession` 两处构造点）
- Modify: 任何**直接构造 `Snapshot` 字面量**的测试（`grep -n "isOriginal:" src/**/*.test.ts*` 找全）

**Interfaces:**
- Produces: `EditState = { base: DecodedImage; params: Adjustments; lut: LutRef | null; seq: number }`（`src/core/ledger.ts` 导出）
- Produces: `Snapshot.past: EditState[]`、`Snapshot.future: EditState[]`（新快照 = `[]`、`[]`）
- Produces: `bitmapsToClose(before, after, opts)` 语义不变，但"位图合集"= 每个快照的 `[base, ...past.map(p=>p.base), ...future.map(f=>f.base)]`（按对象去重）；`protectOriginal` 时**整个原图快照的账本都不关**

- [ ] **Step 1: 写失败的测试**（`src/core/history.test.ts` 里加一组）

```ts
// 账本里的位图也要被认出来 —— 漏一个就是 GPU 内存泄漏
it('★ 位图回收要认账本：某一步被切掉时，它 past/future 里的位图一起还回去', () => {
  const a = fakeImage('a'); const b = fakeImage('b'); const c = fakeImage('c')
  const s1 = snap({ id: 1, base: a, past: [{ base: b, params: ZERO, lut: null, seq: 1 }], future: [] })
  const s2 = snap({ id: 2, base: c, past: [], future: [] })
  expect(bitmapsToClose([s1, s2], [s2]).sort()).toEqual([a, b].sort())
})

it('★ 账本里的位图还被别的笔引用着就不许关（共享对象只关一次）', () => {
  const a = fakeImage('a'); const b = fakeImage('b')
  const s1 = snap({ id: 1, base: a, past: [{ base: b, params: ZERO, lut: null, seq: 1 }], future: [] })
  const s2 = snap({ id: 2, base: b, past: [], future: [] })   // 同一张 b 也被 s2 用着
  expect(bitmapsToClose([s1, s2], [s2])).toEqual([a])
})
```

（`fakeImage` / `snap` 是本文件里现成的夹具风格，按现有写法补 `past`/`future` 默认值。）

- [ ] **Step 2: 跑测试看它红**

Run: `npx vitest run src/core/history.test.ts`
Expected: FAIL（`Snapshot` 上没有 `past` 字段 / 断言不等）

- [ ] **Step 3: 实现**

`src/core/ledger.ts`（新建，只有类型）：

```ts
import type { Adjustments } from '../../shared/adjustments.ts'
import type { LutRef } from '../../shared/lut.ts'
import type { DecodedImage } from '../image/decode'

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
```

`src/core/history.ts`：

```ts
import type { EditState } from './ledger'

export type Snapshot = {
  ...现有字段一个字不动,
  /** 当前位置之前的历史。`past[0]`（非空时）= 出生状态，永不驱逐。 */
  past: EditState[]
  /** 退过之后的位置（「下一步」走这里）。新记账会清空它。 */
  future: EditState[]
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
```

`bitmapsToClose` 改为：

```ts
export function bitmapsToClose(before, after, opts = {}) {
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
```

构造点批量补 `past: [], future: []`：`useGeneration.ts` 的 `pushSnapshot(...)`、`useLocalStep.ts` 的 `pushSnapshot(...)`、`App.tsx` `loadSession` 里的两处 `steps.push({...})`、以及测试里的夹具。

- [ ] **Step 4: 跑全部相关测试**

Run: `npx vitest run src/core/ src/app/useLocalStep.test.ts` 然后 `npm run typecheck`
Expected: 全绿

- [ ] **Step 5: Commit**

```bash
git add -A src/core src/app src/App.tsx
git commit -m "feat(账本): Snapshot 长出 past/future —— 底图回收认账本（含共享对象只关一次）"
```

---

### Task 2: 账本纯函数（记账 / 撤销 / 重做 / 计数 / 净零 / 预算驱逐）

**Files:**
- Modify: `src/core/ledger.ts`（加函数）
- Test: `src/core/ledger.test.ts`（新）

**Interfaces:**
- Produces（Task 3–6 全靠这几个名字，`src/core/ledger.ts` 导出）：
  - `pushEdit(s: Snapshot, before: EditState, next: Omit<EditState, 'seq'>, seq: number): Snapshot`
  - `undoEdit(s: Snapshot): Snapshot`（past 空时返回**同一引用**）
  - `redoEdit(s: Snapshot): Snapshot`（future 空时返回同一引用）
  - `ledgerIndex(s): number`（1 起数）、`ledgerTotal(s): number`
  - `sameEdit(a: { base; params; lut }, b: { base; params; lut }): boolean`
  - `enforceLedgerBudget(list: readonly Snapshot[], budgetPx: number): { list: Snapshot[]; toClose: DecodedImage[] }`
  - `LEDGER_PIXEL_BUDGET = 32_000_000`（常量）

- [ ] **Step 1: 写失败的测试**（`src/core/ledger.test.ts`，整份新建）

```ts
import { describe, expect, it } from 'vitest'
import {
  enforceLedgerBudget, ledgerIndex, ledgerTotal, pushEdit, redoEdit, sameEdit, undoEdit,
  LEDGER_PIXEL_BUDGET, type EditState,
} from './ledger'
import type { Snapshot } from './history'
import { ZERO } from '../../shared/adjustments.ts'

const img = (w: number, h: number, tag = '') => ({ bitmap: { tag }, width: w, height: h }) as any
const st = (base: any, params = ZERO, lut: any = null, seq = 1): EditState => ({ base, params, lut, seq })
const snap = (o: Partial<Snapshot> = {}): Snapshot => ({
  id: 1, label: 'x', base: img(100, 100), params: ZERO, lut: null, isOriginal: false, thumb: '', past: [], future: [], ...o,
})

describe('账本：记账 / 撤销 / 重做', () => {
  it('记一笔：把 before 压进 past、清空 future、当前位置变 next', () => {
    const s0 = snap({ future: [st(img(9, 9))] })
    const s1 = pushEdit(s0, st(s0.base), { base: img(50, 50), params: ZERO, lut: null }, 7)
    expect(s1.past).toHaveLength(1)
    expect(s1.past[0]!.base).toBe(s0.base)
    expect(s1.future).toEqual([])
    expect(s1.base).toMatchObject({ width: 50 })
    expect(s1.past[0]!.seq).toBe(7)
  })

  it('上一步 / 下一步：来回走，画面状态跟着换；两头都是"返回同一引用"', () => {
    const a = img(10, 10); const b = img(20, 20)
    const s0 = snap({ base: a })
    const s1 = pushEdit(s0, st(a), { base: b, params: ZERO, lut: null }, 1)
    const back = undoEdit(s1)
    expect(back.base).toBe(a)
    expect(back.future).toHaveLength(1)
    expect(back.future[0]!.base).toBe(b)
    const fwd = redoEdit(back)
    expect(fwd.base).toBe(b)
    expect(fwd.future).toEqual([])
    expect(undoEdit(s0)).toBe(s0)      // 到头：同一引用（React 不会白渲染）
    expect(redoEdit(s1)).toBe(s1)
  })

  it('记数：1 起数、含出生笔', () => {
    const s0 = snap()
    const s1 = pushEdit(s0, st(s0.base), { base: img(2, 2), params: ZERO, lut: null }, 1)
    const s2 = undoEdit(s1)
    expect(ledgerIndex(s0)).toBe(1); expect(ledgerTotal(s0)).toBe(1)
    expect(ledgerIndex(s2)).toBe(1); expect(ledgerTotal(s2)).toBe(2)
    expect(ledgerIndex(s1)).toBe(2); expect(ledgerTotal(s1)).toBe(2)
  })

  it('净零判断：base 认对象、params/lut 认值', () => {
    const b = img(1, 1)
    expect(sameEdit({ base: b, params: ZERO, lut: null }, { base: b, params: { ...ZERO }, lut: null })).toBe(true)
    expect(sameEdit({ base: b, params: ZERO, lut: null }, { base: b, params: { ...ZERO, exposure: 1 }, lut: null })).toBe(false)
    expect(sameEdit(
      { base: b, params: ZERO, lut: { lutId: 1, amount: 50 } },
      { base: b, params: ZERO, lut: { lutId: 1, amount: 50 } })).toBe(true)
    expect(sameEdit({ base: b, params: ZERO, lut: null }, { base: img(1, 1), params: ZERO, lut: null })).toBe(false)
  })
})

describe('预算驱逐', () => {
  it('超预算：丢最早的非出生笔（按 seq），出生笔和当前位置不动', () => {
    const birth = st(img(4000, 4000, 'birth'), ZERO, null, 1)          // 16MP，被钉住
    const e1 = st(img(4000, 4000, 'e1'), ZERO, null, 2)                // 16MP，最早 → 先丢
    const others = img(1000, 1000, 'cur')                              // 1MP（当前位置）
    const s = snap({ base: others, past: [birth, e1], future: [] })
    const out = enforceLedgerBudget([s], 20_000_000)                   // 16+16+1 = 33MP → 丢 e1 后 17MP
    expect(out.list[0]!.past.map(p => p.base)).toEqual([birth.base])
    expect(out.toClose).toEqual([e1.base])
  })

  it('丢的是"整笔"：future 里的笔也排队；还在别处引用的位图不 close', () => {
    const shared = img(400, 400, 'shared')                             // 0.16MP
    const big1 = st(img(4000, 4000, 'b1'), ZERO, null, 2)
    const big2 = st(img(4000, 4000, 'b2'), ZERO, null, 3)
    const s1 = snap({ id: 1, base: img(10, 10), past: [st(img(1, 1), ZERO, null, 1), big1], future: [] })
    const s2 = snap({ id: 2, base: shared, past: [st(img(1, 1), ZERO, null, 1), big2], future: [] })
    const out = enforceLedgerBudget([s1, s2], 20_000_000)
    expect(out.list[1]!.past.map(p => p.seq)).toEqual([1])             // b2 被丢、出生留
    expect(out.toClose).toEqual([big2.base])                           // shared 还活着，不在 toClose
  })

  it('预算内：一个字节都不动（返回同一份 list）', () => {
    const s = snap()
    expect(enforceLedgerBudget([s], LEDGER_PIXEL_BUDGET).list).toBe([s][0] as any && enforceLedgerBudget([s], LEDGER_PIXEL_BUDGET).list)
  })
})
```

（最后一条"原样返回"按实现写成 `const out = enforceLedgerBudget([s], ...); expect(out.list[0]).toBe(s); expect(out.toClose).toEqual([])` —— 上面那行是示意，写测试时按这个意思写清楚。）

- [ ] **Step 2: 跑测试看它红**

Run: `npx vitest run src/core/ledger.test.ts`
Expected: FAIL（函数不存在）

- [ ] **Step 3: 实现**（`src/core/ledger.ts` 追加）

```ts
export const LEDGER_PIXEL_BUDGET = 32_000_000   // 真机验收后按内存调（spec §6）

/**
 * 记一笔：把"改之前"压进 `past`、清空 `future`、当前位置换成 `next`。纯函数。
 * ⚠️ `seq` 由调用方在构造 `before` 时发号（发号器在 App），这里收下不用 ——
 * 签名里留着是为了让"每个记账点都被编译期逼着表态发过号"。
 */
export function pushEdit(s: Snapshot, before: EditState, next: Omit<EditState, 'seq'>, _seq: number): Snapshot {
  return { ...s, past: [...s.past, before], future: [], base: next.base, params: next.params, lut: next.lut }
}
```

```ts
export function undoEdit(s: Snapshot): Snapshot {
  if (s.past.length === 0) return s
  const cur: EditState = { base: s.base, params: s.params, lut: s.lut, seq: 0 }  // seq 不参与显示
  return {
    ...s,
    past: s.past.slice(0, -1),
    future: [cur, ...s.future],
    base: s.past[s.past.length - 1]!.base,
    params: s.past[s.past.length - 1]!.params,
    lut: s.past[s.past.length - 1]!.lut,
  }
}

export function redoEdit(s: Snapshot): Snapshot {
  if (s.future.length === 0) return s
  const cur: EditState = { base: s.base, params: s.params, lut: s.lut, seq: 0 }
  const head = s.future[0]!
  return { ...s, past: [...s.past, cur], future: s.future.slice(1), base: head.base, params: head.params, lut: head.lut }
}

export const ledgerIndex = (s: Snapshot): number => s.past.length + 1
export const ledgerTotal = (s: Snapshot): number => s.past.length + 1 + s.future.length

export function sameEdit(a: { base: DecodedImage; params: Adjustments; lut: LutRef | null },
                         b: { base: DecodedImage; params: Adjustments; lut: LutRef | null }): boolean {
  if (a.base !== b.base) return false
  for (const k of PARAM_KEYS) if (a.params[k] !== b.params[k]) return false
  const la = a.lut, lb = b.lut
  if (la === null || lb === null) return la === lb
  return la.lutId === lb.lutId && la.amount === lb.amount
}

export function enforceLedgerBudget(list: readonly Snapshot[], budgetPx: number) {
  let out = list.map(s => s)   // 浅拷贝一份数组（元素不动）
  const px = (b: DecodedImage) => b.width * b.height
  const measure = (ls: readonly Snapshot[]) => {
    const seen = new Set<DecodedImage>(); let sum = 0
    for (const s of ls) for (const b of [...s.past.map(p => p.base), ...s.future.map(f => f.base)])
      if (!seen.has(b)) { seen.add(b); sum += px(b) }
    return sum
  }
  const dropped: DecodedImage[] = []
  while (measure(out) > budgetPx) {
    // 候选 = 所有版本里 past[1..] 与 future 的笔，按 seq 最早的先丢
    let best: { si: number; where: 'past' | 'future'; idx: number; seq: number } | null = null
    out.forEach((s, si) => {
      s.past.forEach((e, idx) => { if (idx === 0) return
        if (!best || e.seq < best.seq) best = { si, where: 'past', idx, seq: e.seq } })
      s.future.forEach((e, idx) => {
        if (!best || e.seq < best.seq) best = { si, where: 'future', idx, seq: e.seq } })
    })
    if (!best) break                       // 只剩出生笔：超就超着（上限仍被版本数封住）
    const b = best as { si: number; where: 'past' | 'future'; idx: number }
    const s = out[b.si]!
    dropped.push(b.where === 'past' ? s.past[b.idx]!.base : s.future[b.idx]!.base)
    out[b.si] = b.where === 'past'
      ? { ...s, past: s.past.filter((_, i) => i !== b.idx) }
      : { ...s, future: s.future.filter((_, i) => i !== b.idx) }
  }
  // 还活着的位图一张都不能关（共享引用）
  const alive = new Set(out.flatMap(s => [...s.past.map(p => p.base), ...s.future.map(f => f.base), s.base]))
  const toClose = [...new Set(dropped.filter(b => !alive.has(b)))]
  return { list: out, toClose }
}
```

（`PARAM_KEYS` 从 `shared/adjustments.ts` 导入——`sameEdit` 只用它列键。若不想引，`Object.keys(a.params)` 也行，但**逐键比**这个口径别改。）

- [ ] **Step 4: 跑测试看它绿**

Run: `npx vitest run src/core/ledger.test.ts` + `npm run typecheck`
Expected: 全绿

- [ ] **Step 5: Commit**

```bash
git add src/core/ledger.ts src/core/ledger.test.ts
git commit -m "feat(账本): 纯函数 —— 记账/撤销/重做/净零判断/预算驱逐（出生与当前永不丢）"
```

---

### Task 3: 裁剪 / 点修改记账（转盘不再加格）；`useLocalStep` 退役

**Files:**
- Modify: `src/App.tsx`（`commitCrop` :1196、`commitRetouch` :1348）
- Delete: `src/app/useLocalStep.ts`、`src/app/useLocalStep.test.ts`
- Modify: `src/App.test.tsx`（**翻一批预期**，见 Step 1）

**Interfaces:**
- Consumes: `pushEdit`（Task 2）、`Snapshot.past/future`（Task 1）
- Produces: `editSeqRef = useRef(0)`（App 里新发号器，与 `idRef` 分开）；`markDirtyRef` 还不存在——本任务先用一个占位：**把"底图换版"仍照旧 `baseSeqRef.current++`**（落盘 Task 8 才改成 dirty）。

- [ ] **Step 1: 先翻测试预期（这一批"红"是计划的红）**

`src/App.test.tsx` 里这些用例的预期**从"进转盘"翻成"不进转盘"**（逐条读、逐条改）：

- `★（评审 Important ②）同一批次里还有别的 setState 时，站中间裁照样把未来那几步切掉`（:1952）——**行为没了**：站中间裁**不再切**未来版本。改写成"站中间裁：后面几版原样留着，账本加在**当前这一版**上"。
- `★ 站在中间那一步裁：被切掉的步骤，它们的位图要还回去`（:1909）——同样翻：裁完后面那版**还在**、位图**不关**（还在用）。
- `★（终审 I1）生成在裁剪那几百毫秒里落地 → 这一刀作废`（:1999）——闸门还在（`baseSeqRef` + 新增 `cursorIdRef` 比对），但"推步/切步"的说法改成"账本一个字不动、位图还回去"。
- `★（评审 Critical）裁完之后那一趟落盘必须重新带底图`（:1933）——**落盘那条 Task 8 才改**，这一轮里它照样绿（`baseSeqRef` 还在推）；只把 `labels` 那行从 `['原图', '裁剪']` 改成 `['原图']`（不再新步骤）。
- 任何数 `.strip-node` 且期望"裁剪后 +1"的地方（`grep -n "strip-node" src/App.test.tsx`）翻成**不变**。
- `localStep` 的专测（`src/app/useLocalStep.test.ts`）整份删。

- [ ] **Step 2: 跑测试看它们红**（确认翻过的预期确实因为行为没改而红）

Run: `npx vitest run src/App.test.tsx -t "裁"`
Expected: FAIL（转盘还是 +1 格 / 未来的版本还被切）

- [ ] **Step 3: 改 `commitCrop`**（替换 `localStep` 那一段；`commitRetouch` 同构照改）

```ts
// ★★ 2026-10-08（用户定死的关系）：裁剪是**调色区里的操作**，只改「当前这一版」——
//   不推新快照（转盘不加格）、不切未来（后面几版原样留着）、不挪光标、不碰对话。
//   它的"账"是这一版自己的账本：pushEdit 把"裁之前"压进 past（spec §5.2）。
const seqAt = baseSeqRef.current
// ⚠️ "这一刀冲着哪一版去的"必须在 await 之前读出来（和 `at` 同一条规矩，
//   理由见下面那段旧注释——隔着 await 的地方，位置一律当场读、传值）。
const at = cursorIdRef.current
try {
  const bitmap = await cropToBitmap(image.bitmap, crop.spec, crop.turns)
  if (baseSeqRef.current !== seqAt || cursorIdRef.current !== at) {
    bitmap.close()
    console.error('裁剪回来时底图/位置已经变了（多半是生成落地），这一刀不写进去')
    noticeBad('裁的时候画面已经变了 —— 这一刀没算数。要的话，再裁一次。')
    setCrop(null); setTool(null)
    return
  }
  const base: DecodedImage = { bitmap, width: bitmap.width, height: bitmap.height }
  // ★ 先定稿没落定的调色、再记裁剪这一笔（顺序不能反；`flushEdit` 是 Task 4 的产物，
  //   本任务先留一行 TODO 注释占位，Task 4 接上）。
  const seq = ++editSeqRef.current
  setHistory(prev => {
    const next = prev.map(s => {
      if (s.id !== at) return s
      const before: EditState = { base: s.base, params: s.params, lut: s.lut, seq }
      return pushEdit(s, before, { base, params: s.params, lut: s.lut }, seq)
    })
    closeBitmaps(bitmapsToClose(prev, next, { protectOriginal: true }))
    return next
  })
  baseSeqRef.current++
  setImage(base)
  setPending(null)
  setPendingReplace(null)
  setCrop(null); setTool(null)
} catch (e) { /* 原样保留 */ }
```

⚠️ **删掉**：`const id = ++idRef.current`、`moveCursor(id)`、`setCrop(null)` 之前那句"不推 baseSeq"之类的旧注释、`localStep` 的 import。
⚠️ 保留：锁在 `at` 上的那条"读值不读 ref"的注释精神（这里保留简版）。
⚠️ `commitRetouch` 同构：`before` 用**擦之前**的 `s.base/params/lut`，`next` 的 base = 擦出来的位图；`noticeBad('擦掉了…')` 那段**原样不动**。

- [ ] **Step 4: 跑测试 + 类型 + 全量**

Run: `npm test`（⚠️ 若撞到 "Worker exited unexpectedly" 先重跑）+ `npm run typecheck`
Expected: 全绿

- [ ] **Step 5: Commit**

```bash
git add -A src/
git commit -m "feat(账本): 裁剪/点修改记账 —— 转盘不再加格、不再切未来；useLocalStep 退役"
```

---

### Task 4: 「一笔」的定稿机制（现场镜像 + 起笔 + 定稿闹钟 + flush 点）

**Files:**
- Modify: `src/App.tsx`（改 `549836b` 那条写回 effect :2103；新增 `editPendingRef`/`flushEdit`；接线各 flush 点）
- Modify: `src/app/useGeneration.ts`（deps 加 `flushEdit`，成功路径调用）
- Test: `src/App.test.tsx`（新一组）+ `src/app/useLocalStep.test.ts` 已删

**Interfaces:**
- Produces: `flushEdit(): void`（App 内 `useCallback`，deps `[]`）——把没定稿的一笔记入账本；没有待办时是**空操作**。
- Produces（给 Task 8）：`editPendingRef`、`markDirty` 的**插入点**已在代码里留好（见 Task 8 的说明）。
- Consumes: `pushEdit`、`sameEdit`（Task 2）

- [ ] **Step 1: 写失败的测试**（`src/App.test.tsx` 新 describe）

```ts
describe('调色的「一笔」', () => {
  it('★ 拖一次滑块、停手 = 一笔；连着调（不歇）合并成同一笔', async () => {
    await renderApp(); await uploadPhoto(); await goNav('调色')
    await setSlider('亮度', 40); await setSlider('亮度', 60)   // 两次改、没等定稿
    await vi.advanceTimersByTimeAsync(900)                      // 停手 → 定稿
    // 账本 = 出生 + 1 笔
    await goNav('调色'); expect(stepNav()!.textContent).toContain('2 / 2')
  })

  it('★ 定稿后马上退 = 退掉刚才那一笔（先定稿、再退）', async () => {
    await renderApp(); await uploadPhoto(); await goNav('调色')
    await setSlider('亮度', 60)
    await tap(navBtns()[0]!)                                    // 不到 800ms 就按
    expect(canvasProps.params.at(-1)!.exposure).toBe(0)          // 退回到了调之前
    expect(stepNav()!.textContent).toContain('1 / 2')            // 那一笔被记上了
  })

  it('净零（拖走又拖回原值）不记', async () => { /* 拖 60 → 拖回 0 → 定稿 → 1 / 1 */ })

  it('★ 剪一刀之前，先把没定稿的调色单独记一笔（顺序：先调色、后裁剪）', async () => {
    // 调亮度（不等定稿）→ 立刻裁剪 → 完成
    // 账本 = [出生, 调色笔, 裁剪笔]（3 笔）；退一步回到"没裁但调过色"
  })
})
```

（`setSlider` / `tap` / `stepNav` / `navBtns` 用文件里现成的写法；`vi.useFakeTimers()` 若与既有 fake-timer 用例冲突，就改用 `await new Promise(r => setTimeout(r, 900))` 的真等待——看这个文件里等防抖的现成姿势。）

- [ ] **Step 2: 跑测试看它红**

Run: `npx vitest run src/App.test.tsx -t "一笔"`
Expected: FAIL（还没有定稿机制，箭头也没有——这一组里用到箭头的断言到 Task 5 才全绿；**先把不依赖箭头的断言跑红**，箭头相关的三条留在 Task 5 后补跑）

- [ ] **Step 3: 实现**

（a）App 里加 ref 与回调（放在写回 effect 附近）：

```ts
/** 没定稿的那一笔：一次连续调色从这里起，"停手 + 定稿点"把它记进账本。 */
const editPendingRef = useRef<{ stepId: number; before: EditState } | null>(null)
const editSeqRef = useRef(0)   // 账本发号器（Task 3 已加）

/**
 * 把没定稿的一笔记进账本（没有待办 = 空操作，重复调用无害）。
 * "之后"取**快照里的现场值**——写回 effect 一直在把它镜像成最新。
 */
const flushEdit = useCallback(() => {
  const p = editPendingRef.current
  if (!p) return
  editPendingRef.current = null
  setHistory(h => h.map(s => {
    if (s.id !== p.stepId) return s
    const next = { base: s.base, params: s.params, lut: s.lut }
    if (sameEdit(p.before, next)) return s          // 净零：不记
    const seq = ++editSeqRef.current
    return pushEdit(s, { ...p.before, seq }, next, seq)
  }))
}, [])
```

（b）**改写 `549836b` 那条 effect**（:2103 整段替换）：

```ts
/**
 * ★ 2026-10-08（账本）：调色区的**现场**与"当前这一版"之间那条链 —— 三件事：
 *   ① 现场镜像：把 live `params`/`lut` 写回**当前这一版**（原 549836b 的放宽版：
 *      从"只在最新一步"到"当前这一版"——站在旧版本上改的也该写回旧版本）；
 *   ② 起一笔：第一次跟快照不一样时，把"改之前"拍进 `editPendingRef`；
 *   ③ 定稿闹钟：停手 ~800ms 把它记进账本（`flushEdit`）。
 * ⚠️ 闹钟的清理会跟着**每次 history 变化**跑（写回本身就会改 history）——
 *   所以"early return"之前必须先把闹钟立好（见下面那段），不然它会自己把自己取消掉。
 */
useEffect(() => {
  const cur = history.find(s => s.id === cursorId)
  if (cur && (cur.params !== params || cur.lut !== lut)) {
    if (!editPendingRef.current) {
      editPendingRef.current = { stepId: cur.id, before: { base: cur.base, params: cur.params, lut: cur.lut, seq: 0 } }
    }
    setHistory(h => h.map(s => (s.id === cur.id ? { ...s, params, lut } : s)))
  }
  if (!editPendingRef.current) return
  const t = setTimeout(() => flushEdit(), 800)
  return () => clearTimeout(t)
}, [params, lut, cursorId, history, flushEdit])
```

（c）**接线各定稿点**（每处一行 `flushEdit()`，位置按下面的说明放）：

- `commitCrop` / `commitRetouch`：在 setHistory 记账**之前**（Task 3 留的 TODO 处）；
- `onJump`（:2048）：第一行（在 `moveCursor` 之前）；
- `useGeneration` 成功路径：`baseSeqRef.current !== seqAtStart` 闸门之后、`setHistory(prev => ...)` 之前——**deps 对象加 `flushEdit`**（接口在 `useGeneration.ts` 顶部，:60~110，照现有写法加一行）；
- `startNew`（:1778）与 `loadSession`（:740）：`flushPersist()` 之前再来一句 `flushEdit()`（先定稿、再落盘，发出去的内容才是定稿后的）；
- 每一处**整段换掉/清空 history** 的地方（`loadSession`、`onPick`、`resetEditor`、`onSessionDeleted`）：`editPendingRef.current = null`（挂在 `closeBitmaps(...)` 同一批里），不清的话它会永远堵住下一次"起一笔"。

（d）`dropGoneLut`（:489）顺手扫账本：

```ts
setHistory((prev) => prev.map((s) => ({
  ...s,
  lut: s.lut?.lutId === id ? null : s.lut,
  past: s.past.map((p) => (p.lut?.lutId === id ? { ...p, lut: null } : p)),
  future: s.future.map((f) => (f.lut?.lutId === id ? { ...f, lut: null } : f)),
})))
```

- [ ] **Step 4: 跑测试**

Run: `npx vitest run src/App.test.tsx -t "一笔"` + `npm test` + `npm run typecheck`
Expected: 不依赖箭头的断言全绿（Task 5 后补跑全组）

- [ ] **Step 5: Commit**

```bash
git add -A src/ docs/superpowers/specs/2026-10-08-adjust-ledger-design.md
git commit -m "feat(账本): 调色的「一笔」—— 现场镜像写回当前这一版、停手 800ms 定稿、各跳转点先定稿"
```

---

### Task 5: 箭头改成翻账本（`ledgerStep`）

**Files:**
- Modify: `src/App.tsx`（StepNav 渲染块 :3046-3056 + 新增 `ledgerStep`）
- Modify: `src/ui/StepNav.tsx`（只改 `aria-label="切换版本"` 的组名）
- Test: `src/App.test.tsx`（重写 :7588 那一组 + Task 4 组里依赖箭头的三条）

**Interfaces:**
- Consumes: `undoEdit`/`redoEdit`/`ledgerIndex`/`ledgerTotal`/`sameEdit`/`pushEdit`（Task 2）、`flushEdit`（Task 4）
- Produces: `ledgerStep(dir: -1 | 1): void`（App 内 `useCallback`）

- [ ] **Step 1: 重写测试**（`describe('调色屏的「上一步 / 下一步」')` 整组换成账本语义）

```ts
describe('调色屏的「上一步 / 下一步」= 翻当前这一版的账本', () => {
  it('刚上传、没动过：整组不画（账本只有一笔）', ...)
  it('★ 裁一刀 → 出现 2 / 2；上一步回到裁之前、下一步回裁之后（画面真的换）', ...)
  it('★ 两头都不空转：出生笔按不动"上一步"、最新笔按不动"下一步"', ...)
  it('★ 翻账本不跟对话打交道：一条消息不多、转盘一格不多（走账本，不走 onJump）', ...)
  it('正在裁剪 / 点修时收起来（判据不变）', ...)
  it('★ 退到中间再动手：后面的笔作废（clear future）', ...)
})
```

关键断言（按真机行为写）：
- 裁剪后账本 `2 / 2`；`navBtns()[0]` 可点、`navBtns()[1]` 禁用；
- 点「上一步」→ 画布宽高**对调回来**（`canvasProps.images.at(-1)` 对上裁前那张位图）；
- 点「上一步」两次 → `1 / 2`、两头翻转禁用；
- 转盘 `.strip-node` 数**不变**。

- [ ] **Step 2: 跑测试看它红**

Run: `npx vitest run src/App.test.tsx -t "上一步"`
Expected: FAIL

- [ ] **Step 3: 实现**

（a）`ledgerStep`（放在 `onJump` 附近）：

```ts
/**
 * ★ 2026-10-08（账本）：调色屏左下角那组箭头 —— 翻的是**当前这一版的账本**，
 * 不是版本（版本归修图屏的转盘管；宏观/微观的分工是用户点名的）。
 * ⚠️ 动之前先把没定稿的调色定稿（"调完马上退"退的必须是刚调的那下）。
 * ⚠️ 不碰对话、不切步骤、不花钱 —— 和翻版本同一族契约（39fb4d0）。
 */
const ledgerStep = useCallback((dir: -1 | 1) => {
  const cur = history.find(s => s.id === cursorId)
  if (!cur) return
  // 先把待办定稿，在同一拍里拿到"定稿后的它"（不能只 setHistory 等渲染）
  let base = cur
  const p = editPendingRef.current
  if (p && p.stepId === cur.id) {
    editPendingRef.current = null
    const next = { base: cur.base, params, lut }
    if (!sameEdit(p.before, next)) {
      const seq = ++editSeqRef.current
      base = pushEdit(cur, { ...p.before, seq }, next, seq)
    }
  }
  const target = dir < 0 ? undoEdit(base) : redoEdit(base)
  if (target === base) return              // 到头（按钮本来就 disabled，这是保险）
  setHistory(h => h.map(s => (s.id === cur.id ? target : s)))
  setImage(target.base)
  setParams(target.params)
  setLut(target.lut)
  // ⚠️ 落盘要认这一版（Task 8 接上 `markDirty`：退回/前进都可能换了底图）
}, [history, cursorId, params, lut])
```

（b）渲染块（:3046）换成：

```tsx
{(() => {
  const cur = history.find(s => s.id === cursorId)
  const undoLen = cur?.past.length ?? 0
  const total = cur ? ledgerTotal(cur) : 1
  if (view.kind !== 'adjust' || !image || total <= 1 || !cur) return null
  if (tool === 'crop' || tool === 'retouch') return null
  return <StepNav index={undoLen + 1} total={total}
    onPrev={() => ledgerStep(-1)} onNext={() => ledgerStep(1)} />
})()}
```

（写法照这个意思；`curIdx >= 0` 那条旧条件随之删掉。）

（c）`StepNav.tsx`：`aria-label="切换版本"` → `aria-label="调整记录"`（组件注释同步改一句话——"微观=翻当前这一版的账本"）。

- [ ] **Step 4: 跑测试**

Run: `npx vitest run src/App.test.tsx -t "上一步"` + `npm test` + `npm run typecheck`
Expected: 全绿（含 Task 4 那组依赖箭头的三条）

- [ ] **Step 5: Commit**

```bash
git add -A src/
git commit -m "feat(账本): 左下角箭头改翻账本 —— 退到中间再动手后面的笔作废；不跟对话打交道"
```

---

### Task 6: 预算驱逐接线

**Files:**
- Modify: `src/App.tsx`（`commitCrop`/`commitRetouch`/`flushEdit`/`ledgerStep` 的记账处）
- Test: `src/App.test.tsx`（一条"接线"用例）

**Interfaces:**
- Consumes: `enforceLedgerBudget`（Task 2）
- 说明：**记账后统一收口**——记账的那几个 setHistory updater 里，先 `enforceLedgerBudget` 再 `bitmapsToClose`，把两份 `toClose` 合并关掉。

- [ ] **Step 1: 写失败的测试**（接线用例）

```ts
it('★ 每一处记账都过预算闸（接线钉死：驱逐函数被叫到、返回值被关掉）', async () => {
  const spy = vi.spyOn(ledgerMod, 'enforceLedgerBudget')
  await renderApp(); await uploadPhoto(); await goNav('调色')
  await cropOnce()          // 现成的裁剪助手
  expect(spy).toHaveBeenCalled()          // 记账处过了闸
  spy.mockRestore()
})
```

（"被关掉的位图"用 `decodedBitmaps[i].close` 断言——驱逐真要触发得靠大尺寸夹具，Jsdom 里不现实；**纯逻辑由 Task 2 的单测兜底**，这里只钉"接上了"。注释里写清楚这个分工。）

- [ ] **Step 2: 跑测试看它红** → `npx vitest run src/App.test.tsx -t "预算闸"`

- [ ] **Step 3: 实现**——记账处的固定形状：

```ts
setHistory(prev => {
  const withEdit = prev.map(/* pushEdit ... */)
  const { list: next, toClose } = enforceLedgerBudget(withEdit, LEDGER_PIXEL_BUDGET)
  closeBitmaps([...toClose, ...bitmapsToClose(prev, next, { protectOriginal: true })])
  return next
})
```

四处盘点：`commitCrop`、`commitRetouch`、`flushEdit`、`ledgerStep`（`ledgerStep` 的 pushEdit 分支也要过闸——虽然那一笔多半没新位图，但账本形状一样，别搞特例）。
`pushSnapshot`（`history.ts`）**不用动**：版本挤出去时的位图回收走 `bitmapsToClose`（Task 1 已扩展）。

- [ ] **Step 4: 跑测试** → `npm test` + `npm run typecheck`

- [ ] **Step 5: Commit**

```bash
git add -A src/
git commit -m "feat(账本): 记账统一过预算闸（32MP 起；出生与当前永不丢）"
```

---

### Task 7: 服务端 `stateStepId` 协议

**Files:**
- Modify: `src/api/sessions.ts`（`SessionPatch` 加字段 + 注释）
- Modify: `server/sessions.ts`（`mergeSteps` + `handleUpdateSession`）
- Test: `server/sessions.test.ts`

**Interfaces:**
- Produces（Task 8 依赖）：`PATCH /api/sessions/:id` 接受 `stateStepId?: number`——"这趟的 `params`/`lut`/`base` 说的是**哪一步**的现在"。不带它 = 旧行为（兼容路径）。

- [ ] **Step 1: 写失败的服务端测试**（`server/sessions.test.ts` 加一组）

```ts
describe('stateStepId：状态挂在指定的那一步上', () => {
  it('params / lut 写进 stateStepId 指的那一步（不是最后一步）', async () => {
    await handleUpdateSession(id, { steps: [step(1), step(2)] }, user, deps())
    await handleUpdateSession(id, {
      stateStepId: 1, params: { ...ZERO, exposure: 30 }, steps: [step(1), step(2)],
    }, user, deps())
    const detail = handleGetSession(id, user, deps())
    expect(detail.steps[0]!.params.exposure).toBe(30)
    expect(detail.steps[1]!.params.exposure).toBe(0)     // 最后一步一个字节不动
  })

  it('★ 新文件落在 stateStepId 那一步的 image 上（替换掉旧图），不是"最后一个新步骤"', async () => {
    await handleUpdateSession(id, { base: JPEG, steps: [step(1)] }, user, deps())
    await handleUpdateSession(id, { base: JPEG2, stateStepId: 1, steps: [step(1)] }, user, deps())
    // 该步的 image 换成了新文件；旧文件仍在 files 名单里（删会话时能收走）
    const detail = handleGetSession(id, user, deps())
    expect(detail.steps[0]!.reusesPrev).toBe(false)
  })

  it('stateStepId 指的步骤不存在 → 400（新信任边界）', async () => {
    await expect(handleUpdateSession(id, { stateStepId: 999, params: ZERO, steps: [step(1)] }, user, deps()))
      .rejects.toMatchObject({ status: 400 })
  })

  it('不带 stateStepId = 旧行为照旧（params/lut 落最后一步、新文件落最后一个新步骤）', ...)
})
```

（`JPEG`/`JPEG2`/`deps()`/`step()` 用本文件现成夹具；"image 换没换"按本文件能观察到的最强判据来——文件名的精确断言比 `reusesPrev` 好，读一遍 `handleSessionStepFile` 的用法后再定。）

- [ ] **Step 2: 跑测试看它红** → `npx vitest run server/sessions.test.ts -t "stateStepId"`

- [ ] **Step 3: 实现**

（a）`src/api/sessions.ts`：

```ts
/**
 * ★ 2026-10-08（账本）：**这趟的 `params`/`lut`/`base` 说的是哪一步的"现在"**。
 * 今天客户端总会带它（状态挂在"正在编辑的那一版"上）；不带 = 旧行为（写最后一步），
 * 留着当兼容路径。⚠️ 说的必须是**合并后存在**的步骤 id，否则 400。
 */
stateStepId?: number
```

（b）`server/sessions.ts` `mergeSteps`：签名加第 6 参 `stateStepId: number | null`——

```ts
// ③ 改成：客户端没说状态挂在哪时，才按"最后一个新步骤拿新文件"（旧行为）
if (newFile && stateStepId === null) { /* 原样 */ }
// ④ 新加：说了就落在那一步上（替换 image）；那一步必须存在
if (newFile && stateStepId !== null) {
  const t = out.find(s => s.id === stateStepId)
  if (!t) throw new HttpError('BAD_REQUEST', 'stateStepId 指的步骤不存在', 400)
  t.image = newFile
}
```

⚠️ 注意"替换 image"意味着这条步骤的现有 image 文件不再被引用 —— **旧文件不许删**（`files` 只增不减，现有注释里那条"旧的那些文件不会因此被删"照旧适用）。

（c）`handleUpdateSession`：

```ts
const stateStepId = o.stateStepId === undefined ? null
  : (Number.isInteger(o.stateStepId) && (o.stateStepId as number) > 0 ? o.stateStepId as number : NaN)
if (Number.isNaN(stateStepId as number)) throw new HttpError('BAD_REQUEST', 'stateStepId 得是正整数', 400)
steps = Array.isArray(o.steps)
  ? mergeSteps(prevSteps, o.steps.slice(-MAX_STEPS), newFile, row.original, t, stateStepId)
      .map(...)   // 原样
  : prevSteps
```

然后把 params/lut 那两块的目标从"最后一步"换成"`stateStepId` 那一步（没有就还是最后一步）"：

```ts
const targetId = stateStepId ?? steps[steps.length - 1]?.id
const ti = steps.findIndex(s => s.id === targetId)
if (o.params !== undefined && ti >= 0) {
  steps[ti] = { ...steps[ti]!, params: applyDeltas(ZERO, asObject(o.params) as Partial<Adjustments>) }
}
if (o.lut !== undefined && ti >= 0) {
  steps[ti] = { ...steps[ti]!, lut: resolveLutRef(deps.db, user.id, o.lut) }
}
```

⚠️ 现有注释里"**只动最后一步**、**换一个对象**"两条窄的理由要改写：窄口从"最后一步"挪到"`stateStepId` 指名的那一步"（把"历史不许改写"和"状态可以更新"分开说，是这次协议改动的立身之本——写在注释里）。

- [ ] **Step 4: 跑服务端全部测试** → `npx vitest run server/` + `npm run typecheck`

- [ ] **Step 5: Commit**

```bash
git add src/api/sessions.ts server/sessions.ts server/sessions.test.ts
git commit -m "feat(落盘): stateStepId 协议 —— 状态挂在对话框指定的那一步上（替换 image 只走这个窄口）"
```

---

### Task 8: 客户端落盘重写（dirty + 干净底图 ← 修 bug + stateStepId）

**Files:**
- Modify: `src/App.tsx`（落盘 effect :2263-2449 重写；`lastPersistedBaseSeqRef` 退役）
- Test: `src/App.test.tsx`（翻一批 + 加"干净底图"新用例）

**Interfaces:**
- Consumes: `stateStepId`（Task 7）、`Snapshot.past/future`（Task 1）
- Produces: `dirtyRef = useRef<{ stepId: number; baseChanged: boolean } | null>(null)`、`markDirty(stepId, baseChanged): void`（合并语义：同一步的 `baseChanged` 只增不减，直到成功写回才清）

- [ ] **Step 1: 写失败的测试**

```ts
it('★（10-08 探针的 bug）落盘的底图来自**干净位图**，不是画布（画布带参数/滤镜）', async () => {
  await renderApp(); await uploadPhoto(); await goNav('调色')
  await setSlider('亮度', 60)
  await cropOnce()                      // baseSeq++、底图换版
  await waitPersist()
  const body = bodyOf(putCalls('/api/sessions/1').at(-1)!)
  // 编码的**入参**必须那一步的位图对象（夹具里 decodedBitmaps 认识它），不是画布元素
  expect(vi.mocked(thumbMod.bitmapToDataUrl).mock.calls.at(-1)![0]).toBe(decodedBitmaps.at(-1))
  expect(body.stateStepId).toBe(1)      // 状态挂在当前这一版上
})

it('★ 站在旧版本上改 → stateStepId 指旧版本（不是最后一步）', ...)
it('★ 版本跳转前先 flush：跳走那一刻，上一版的最新状态已经发出去了', ...)
it('纯跳转（没改）不发带 stateStepId 的 PUT', ...)
```

同时**翻**这些旧用例：`★ 底图换过的那趟落盘：上路的是压过的…`（:5631，"不是画布直出"的说法**反了**——现在 base 也不许从画布来）；`:5520/:5541/:6064` 那几条 `body.base` 为 undefined 的（参数步不传图——照旧成立，但底图现在跟 `stateStepId` 走，断言里的语境要重读）、`atTip` 相关的用例（`grep -n "atTip\|最新一步才送" src/App.test.tsx`）。

- [ ] **Step 2: 跑测试看它红** → `npx vitest run src/App.test.tsx -t "干净位图|stateStepId"`

- [ ] **Step 3: 实现**

（a）`markDirty`（放在落盘 effect 附近）：

```ts
/**
 * ★ 2026-10-08（账本）：**哪一版的"现在"变了** —— 落盘按它决定"存谁"。
 * 合并语义：同一步的 `baseChanged` 只增不减（先裁了一刀没发出去、又拖了滑块，
 * 那一刀不能因为后一笔标 false 就被吞掉）。成功写回后由落盘那边清。
 */
const dirtyRef = useRef<{ stepId: number; baseChanged: boolean } | null>(null)
const markDirty = useCallback((stepId: number, baseChanged: boolean) => {
  const prev = dirtyRef.current
  dirtyRef.current = { stepId, baseChanged: baseChanged || (prev?.stepId === stepId ? prev.baseChanged : false) }
}, [])
```

接线（每处一行）：
- 写回 effect 的"写回"分支里：`markDirty(cur.id, false)`；
- `commitCrop`/`commitRetouch`：`markDirty(at, true)`；
- `ledgerStep`：`markDirty(cur.id, target.base !== base.base)`（换没换底图）；
- `useGeneration` 成功路径（推新版本处）：`markDirty(新步骤 id, true)`——`messageId` 就是那个 id；
- 删消息（:2162 那句 `baseSeqRef.current++` 旁边）：`markDirty(新 tip 的 id, true)`；
- 四处整段换掉 history 的地方：`dirtyRef.current = null`（和 `editPendingRef` 同一批）。

（b）**重写落盘 effect**（:2275 起）：

```ts
// effect 体里：
const dirtyAt = dirtyRef.current
const dirtyVersion = dirtyAt ? history.find(s => s.id === dirtyAt.stepId) : undefined
const stateStepId = dirtyAt && dirtyVersion ? dirtyVersion.id : undefined
const stateParams = dirtyVersion?.params
const stateLut = dirtyVersion?.lut
// ★ 底图从**位图**编码（干净、不带参数/滤镜）—— 画布只留给封面缩略图。
//   这就是 10-08 探针抓到的 bug 的修法（spec §3）。
const baseBitmap = dirtyAt?.baseChanged && dirtyVersion ? dirtyVersion.base.bitmap : null
const el = canvasElRef.current

const run = (keepalive = false) => {
  const seq = ++persistSeqRef.current
  const sending = dirtyRef.current
  void (async () => {
    try {
      const patch: SessionPatch = { messages: messagesNow, steps: snapshot }
      if (stateStepId !== undefined && stateParams !== undefined) {
        patch.stateStepId = stateStepId
        patch.params = stateParams
        patch.lut = stateLut ?? null
      }
      if (baseBitmap) {
        patch.base = bitmapToDataUrl(baseBitmap, 0.9)
        // 封面照旧从画布抓（它=现在的观感）；画布不在就只跳过封面，不再拖累底图
        if (el) { try { patch.thumb = makeThumbnail(el, GALLERY_THUMB_MAX_SIDE) } catch (e) { console.error('封面没做出来（不影响底图落盘）', e) } }
      }
      // ...keepalive 量体那段原样...
      await updateSession(sessionId, patch, keepaliveOk)
      if (dirtyRef.current === sending && sessionIdRef.current === sessionId) dirtyRef.current = null
    } catch (e) { /* 原样的 seq 判定 + 通报 */ }
  })()
}
```

**删掉**：`atTip` 整块（含长注释里"只有站在最新一步才送"的理由——改写成"哪一版脏了送哪一版"）、`lastPersistedBaseSeqRef`（声明 :578、loadSession :1000、onPick 各处、成功分支），`changed` 判据。`baseSeqRef` **保留**（它是竞态闸门的号：生成 / 裁剪 / 说话那几处，别动）。
**保留**：防抖 800、`sending` 的"发出去之前定死"、成功才记、失败通报那几句、keepalive 量体、会话清空时 `dirtyRef.current = null`（loadSession 里替换 `lastPersistedBaseSeqRef.current = baseSeqRef.current` 那行）。

- [ ] **Step 4: 跑测试** → `npm test` + `npm run typecheck`

- [ ] **Step 5: Commit**

```bash
git add -A src/
git commit -m "fix(落盘): 底图一律从干净位图编码（修'刷新后参数翻倍'）；状态改挂 stateStepId 指的那一版"
```

---

### Task 9: 步骤小图（活着时重抓 + 恢复时离屏重画）

**Files:**
- Modify: `src/App.tsx`（缩略图 effect :2250 重写；`loadSession` 的 `thumbOf` :836 重写）
- Test: `src/App.test.tsx`（两条）

**Interfaces:**
- Consumes: `TonePipeline`（`src/render/pipeline`，`new TonePipeline(canvas)` / `setImage` / `resizeToImage` / `render(params)` / `dispose()`）
- 说明：恢复时**不带滤镜那层**（cube 是异步的）——spec §7.3 的已知边界；失败退回"底图直出"（`makeThumbnail(bitmap)`），**不许静默**。

- [ ] **Step 1: 写失败的测试**

```ts
it('★ 裁完一刀：当前那一版的转盘小图被重抓（而不是停在改前的样子）', ...)   // makeThumbnail 被再叫一次
it('★ 恢复会话时：每步小图按"底图 + 那一步的参数"重画（离屏管线；带 params 调 render）', ...)
```

（第二条在 jsdom 里把 `TonePipeline` mock 掉（现有测试台对 Canvas 的处理方式照抄），断言 `render` 收到的 params 等于那一步的参数。）

- [ ] **Step 2: 跑测试看它红**

- [ ] **Step 3: 实现**

（a）替换缩略图 effect（:2250）：

```ts
/**
 * 给"当前这一版"抓/重抓小图。
 * - 换到某一版/刚推入的新版本（thumb 还空着）→ 抓；
 * - 在某版上记账/撤销/重做 → 重抓（转盘那一格要跟得上）；
 * - ⚠️ **没定稿的拖动期间不抓**（每一帧都抓 = 一秒 60 张缩略图）。
 */
const thumbStateRef = useRef<{ id: number; base: DecodedImage; params: Adjustments; lut: LutRef | null } | null>(null)
useEffect(() => {
  const canvas = canvasElRef.current
  if (!canvas || cursorId === null) return
  const cur = history.find(s => s.id === cursorId)
  if (!cur) return
  if (editPendingRef.current) return                    // 拖动中：等定稿
  const t = thumbStateRef.current
  if (t && t.id === cur.id && t.base === cur.base && t.params === cur.params && t.lut === cur.lut) return
  try {
    thumbStateRef.current = { id: cur.id, base: cur.base, params: cur.params, lut: cur.lut }
    setHistory(h => attachThumb(h, cur.id, makeThumbnail(canvas)))
  } catch (e) { console.error('缩略图生成失败（不影响修图）', e) }
}, [history, cursorId])
```

（b）`loadSession` 的 `thumbOf` 换成离屏渲染：

```ts
// 一张一次性的离屏画布 + 管线，恢复这一趟里共用；finally 里 dispose
let offscreen: { canvas: HTMLCanvasElement; pipe: TonePipeline } | null = null
const thumbOf = (b: ImageBitmap, p: Adjustments): string => {
  try {
    if (!offscreen) {
      const c = document.createElement('canvas')
      offscreen = { canvas: c, pipe: new TonePipeline(c) }
    }
    offscreen.pipe.setImage({ bitmap: b, width: b.width, height: b.height })
    offscreen.pipe.resizeToImage()
    offscreen.pipe.render(p)          // ⚠️ 滤镜那层不在（cube 异步）—— spec §7.3 的边界
    return makeThumbnail(offscreen.canvas)
  } catch (e) {
    console.error('恢复时小图没做出来（退回底图直出）', e)
    try { return makeThumbnail(b) } catch { return '' }
  }
}
```

调用点从 `thumbOf(bitmap)` 改成 `thumbOf(bitmap, params)`（两处：`reusesPrev` 分支沿用上一步的 thumb，不动）；离屏管线在 loadSession 的收尾（成功/失败都）`dispose()`。

- [ ] **Step 4: 跑测试** → `npm test` + `npm run typecheck`

- [ ] **Step 5: Commit**

```bash
git add -A src/
git commit -m "feat(账本): 步骤小图两条路 —— 活着时记账后重抓、恢复时按底图+参数离屏重画"
```

---

### Task 10: 真机探针 + 全量验收 + 文档收尾

**Files:**
- Create: `.superpowers/probe-adjust-ledger.mjs`（不进库）
- Modify: `docs/文案规范.md`、`docs/superpowers/specs/2026-10-06-edit-tools-design.md`
- Check: `README.md`（里面若提"裁剪会切掉后面/箭头翻版本"的说法，跟着改）

- [ ] **Step 1: 写探针**（零模型花费；形状照 `.superpowers/probe-crop-no-record.mjs` 的登录+上传+裁剪；亮度测量照 `.superpowers/probe-persist-bake.mjs`）

剧本（全部断言 ✅/❌ 打印）：
1. 上传（strip = 1）→ 调色屏：**箭头不画**（账本只有一笔）；
2. 裁剪（旋转 90°）→ 完成 → 修图屏：**转盘还是 1 格**（不占格）；
3. 回调色屏：箭头出现 `2 / 2`、「下一步」禁用 → 点「上一步」→ 画布宽高 `800×1200`（退回去了）→ 对照：这就是"画面真的换了"；
4. 点「下一步」→ `1200×800`（又回来）；
5. 亮度 +60 → 等落盘（2.5s）→ 量画布平均亮度 L1 → **整页刷新** → 量 L2 → `|L1−L2| < 1.5`（★ "刷新翻倍"修复的验收——这条在修复前会差 ~20）；
6. 再跑一遍 `probe-persist-bake.mjs`（两组：裁剪组应从 20.15 的差变成 ≈0；对照组本来就 0.00）。

- [ ] **Step 2: 跑探针（真 Chrome；⚠️ 改了 server/ 的那一半要先重启 dev 才看得到）**

Run: `node .superpowers/probe-adjust-ledger.mjs` 然后 `node .superpowers/probe-persist-bake.mjs`
Expected: 全 ✅

- [ ] **Step 3: 文档收尾**
- `docs/文案规范.md`：「上一步 / 下一步」那条的出处说明改成账本的说法（组名 `aria-label="调整记录"`）；三处涉"版本"的措辞核对。
- `docs/superpowers/specs/2026-10-06-edit-tools-design.md`：2026-10-08 那条更正块下面**再更正一次**——"版本照旧进转盘"作废（裁剪/点修只进账本）。
- `README.md`：`grep -n "裁剪\|转盘\|上一步" README.md` 看有没有说反的，改了。
- `docs/superpowers/specs/2026-10-08-adjust-ledger-design.md`：如有和实现不一致处，回写实际（例如预算初值、`stateStepId` 的最终形状）。

- [ ] **Step 4: 全量**
Run: `npm test` + `npm run typecheck` + `npm run check:layout`（⚠️ 跑十几次会撞注册限流 429，别连跑）
Expected: 全绿

- [ ] **Step 5: Commit**

```bash
git add -A docs README.md
git commit -m "docs(账本): 文案规范与旧更正块收尾；探针两条全过（含'刷新翻倍'的修复验收）"
```

---

## Self-Review（写计划的人自己过的一遍）

- **Spec 覆盖**：§4 数据模型→T1/T2；§5.1 什么算一笔→T4；§5.2 记账→T2/T3；§5.3 箭头→T5；§5.4 转盘/生成→T3（不占格）+T4（flush）；§5.5 定稿点→T4；§5.6 已知口径→T3（删除/生成照旧）+T8（刷新）；§6 内存→T1（回收）+T6（预算）；§7.1 协议→T7；§7.2 客户端→T8；§7.3 恢复→T9；§9 测试与探针→各任务内 + T10；§10 文档→T10。**无缺口。**
- **占位符扫描**：Task 2 的 `pushEdit` 有一处"写着示意、别照抄"的坑——执行时按紧跟其后的正确版本写；其余无 TBD/TODO。
- **类型一致**：`EditState`（含 `seq`）T1 定义、T2 全用；`pushEdit(s, before, next, seq)` 四参在 T2/T3/T4/T5 一致；`markDirty(stepId, baseChanged)` 在 T8 定义、接线点列全；`flushEdit` 无参。
- **已知中间态**（Global Constraints 里已写明）：T3 之后、T8 之前裁剪不落盘——两段之间别切分支。
