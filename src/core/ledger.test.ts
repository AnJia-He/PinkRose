import { describe, expect, it } from 'vitest'
import {
  enforceLedgerBudget, ledgerIndex, ledgerTotal, pushEdit, redoEdit, sameEdit, undoEdit,
  LEDGER_PIXEL_BUDGET, type EditState,
} from './ledger'
import type { Snapshot } from './history'
import { ZERO } from '../../shared/adjustments.ts'

// 夹具说明：位图只要"是个对象、有宽高"就够了 —— 这些纯函数不看 GPU 资源，
// 只认**对象身份**（同一张）和**像素数**（`width × height`）。`tag` 是给断言
// 读的标签，出事时能一眼看出丢的是哪一张。
const img = (w: number, h: number, tag = '') => ({ bitmap: { tag }, width: w, height: h }) as any
const st = (base: any, params = ZERO, lut: any = null, seq = 1): EditState => ({ base, params, lut, seq })
const snap = (o: Partial<Snapshot> = {}): Snapshot => ({
  id: 1, label: 'x', base: img(100, 100), params: ZERO, lut: null, isOriginal: false, thumb: '', past: [], future: [], ...o,
})

describe('账本：记账 / 撤销 / 重做', () => {
  it('记一笔：把 before 压进 past、清空 future、当前位置变 next', () => {
    const s0 = snap({ future: [st(img(9, 9))] })
    // ⚠️ seq 由**调用方**发号、写在 before 上；第 4 个参数不参与改写（见 `pushEdit`
    //    的注释：它只是"逼每个记账点表态发过号"的强制位）—— 所以这里给 before 的
    //    号是 7，断言它原样进账。
    //    brief 原稿这里写的是 `st(s0.base)`（seq 取默认 1）却断言 `toBe(7)`，两个
    //    约定打架，是原稿写岔了；按实现那份约定改成把 7 放进 before。
    const before = st(s0.base, ZERO, null, 7)
    const s1 = pushEdit(s0, before, { base: img(50, 50), params: ZERO, lut: null }, 7)
    expect(s1.past).toHaveLength(1)
    expect(s1.past[0]!.base).toBe(s0.base)
    expect(s1.future).toEqual([])
    expect(s1.base).toMatchObject({ width: 50 })
    expect(s1.past[0]!.seq).toBe(7)
    // ★ 纯函数：入参一个字都不能动。这不是形式主义 —— 快照到处都是 `{...s}` 浅
    //   展开，`past`/`future` 是**共享的数组引用**，这里原地 `push` 一次，
    //   别的那一版账本会跟着变（而且是静默的）。变异检查就靠这几行抓。
    expect(s1).not.toBe(s0)
    expect(s0.past).toHaveLength(0)
    expect(s0.future).toHaveLength(1)
  })

  it('上一步 / 下一步：来回走，画面状态跟着换；两头都是"返回同一引用"', () => {
    const a = img(10, 10); const b = img(20, 20)
    const s0 = snap({ base: a })
    const s1 = pushEdit(s0, st(a), { base: b, params: ZERO, lut: null }, 1)
    const back = undoEdit(s1)
    expect(back.base).toBe(a)
    expect(back.future).toHaveLength(1)
    expect(back.future[0]!.base).toBe(b)
    expect(s1.past).toHaveLength(1)     // 撤销不许原地 pop 掉源快照的账（纯函数）
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
    // lut 的**强度**变一点也算变（净零判断漏了它 = 拖了滤镜强度却记不出这一笔）
    expect(sameEdit(
      { base: b, params: ZERO, lut: { lutId: 1, amount: 50 } },
      { base: b, params: ZERO, lut: { lutId: 1, amount: 51 } })).toBe(false)
    // 一边有滤镜一边没有
    expect(sameEdit({ base: b, params: ZERO, lut: { lutId: 1, amount: 50 } }, { base: b, params: ZERO, lut: null })).toBe(false)
    // base **认对象**：两个 1×1 长得一样，但不是同一张 —— 换过底图就是换过
    expect(sameEdit({ base: b, params: ZERO, lut: null }, { base: img(1, 1), params: ZERO, lut: null })).toBe(false)
  })
})

describe('预算驱逐', () => {
  it('超预算：丢最早的非出生笔（按 seq），出生笔和当前位置不动', () => {
    const birth = st(img(4000, 4000, 'birth'), ZERO, null, 1)          // 16MP，被钉住
    const e1 = st(img(4000, 4000, 'e1'), ZERO, null, 2)                // 16MP，最早 → 先丢
    const others = img(1000, 1000, 'cur')                              // 1MP（当前位置）
    const s = snap({ base: others, past: [birth, e1], future: [] })
    const out = enforceLedgerBudget([s], 20_000_000)                   // 16+16 = 32MP → 丢 e1 后 16MP
    expect(out.list[0]!.past.map(p => p.base)).toEqual([birth.base])
    expect(out.toClose).toEqual([e1.base])
    expect(out.list[0]!.base).toBe(others)                             // 当前位置不动
  })

  it('按 seq **跨版本**挑最老的那一整笔丢，别的版本一根汗毛不动', () => {
    // ⚠️ brief 原稿这条的两个期望值写反了：fixture 里 b1 的 seq 是 2、b2 是 3，
    //    按 spec §6「丢最早的非出生笔」该丢 b1，原稿却断言 b2 被丢 —— 和上一条
    //    用例的注释（"最早 → 先丢"）自相矛盾。fixture 原样保留，期望值按 spec 改。
    const shared = img(400, 400, 'shared')                             // 0.16MP（s2 的当前位置）
    const big1 = st(img(4000, 4000, 'b1'), ZERO, null, 2)
    const big2 = st(img(4000, 4000, 'b2'), ZERO, null, 3)
    const s1 = snap({ id: 1, base: img(10, 10), past: [st(img(1, 1), ZERO, null, 1), big1], future: [] })
    const s2 = snap({ id: 2, base: shared, past: [st(img(1, 1), ZERO, null, 1), big2], future: [] })
    const out = enforceLedgerBudget([s1, s2], 20_000_000)              // 16+16 = 32MP → 丢一笔后 16MP
    expect(out.list[0]!.past.map(p => p.seq)).toEqual([1])             // b1（seq 2，全局最老）被丢、出生留
    expect(out.list[1]!.past.map(p => p.seq)).toEqual([1, 3])          // b2 那版原样
    expect(out.toClose).toEqual([big1.base])                           // 没人引用的那一笔才关
  })

  it('丢的是"整笔"：future 里的笔也排队；还在别处引用的位图不 close', () => {
    // 三条一起钉：
    //  ① 丢一笔 = 账上那一整笔消失（不是只把位图放掉、留个空壳）；
    //  ② future 里的笔和 past 里的一样在排队 —— seq 全局单调，跨 past/future 比大小；
    //  ③ 被丢的位图只要**还被别处引用着**（这里是 s2 的当前位置）就一张都不能关 ——
    //     关了就是闪黑；真没人引用的那一笔才进 toClose。
    const a = img(4000, 4000, 'a')                                     // 16MP：全局最老的可驱逐笔
    const b = img(4000, 4000, 'b')                                     // 16MP：排在 future 里
    const c = img(4000, 4000, 'c')                                     // 16MP：最晚入账，留下
    const s1 = snap({ id: 1, base: img(10, 10), past: [st(img(1, 1), ZERO, null, 1), st(a, ZERO, null, 2)], future: [] })
    const s2 = snap({ id: 2, base: a, past: [st(img(1, 1), ZERO, null, 1)], future: [st(b, ZERO, null, 3), st(c, ZERO, null, 4)] })
    const out = enforceLedgerBudget([s1, s2], 20_000_000)              // 16×3 = 48MP → 丢两笔后 16MP
    expect(out.list[0]!.past.map(p => p.seq)).toEqual([1])             // ① 整笔丢：s1 那笔没了、出生留
    expect(out.list[1]!.future.map(f => f.seq)).toEqual([4])           // ② future 也排队：seq 3 被丢、seq 4 留下
    expect(out.list[1]!.base).toBe(a)                                  // 当前位置永不丢
    expect(out.toClose).toEqual([b])                                   // ③ a 还被 s2 的当前位置用着 → 不关；b 没人引用 → 关
  })

  it('★ 同一张底图落在两条账里、又都被丢 —— toClose 只报一次', () => {
    // brief 的 fixture 拦不住"把 toClose 的去重 Set 删掉"这个变异：要同一张位图
    // 被丢两次才会露出来。契约和 `history.ts` 的 `bitmapsToClose` 一致 ——
    // "同一对象只关一次"（关两次靠 close() 幂等兜着，但不能靠它兜）。
    const dup = img(4000, 4000, 'dup')                                 // 16MP
    const big = img(4000, 4000, 'big')                                 // 16MP
    const s1 = snap({ id: 1, base: img(10, 10), past: [st(img(1, 1), ZERO, null, 1), st(dup, ZERO, null, 2)], future: [] })
    const s2 = snap({ id: 2, base: img(10, 10), past: [st(img(1, 1), ZERO, null, 1), st(dup, ZERO, null, 3)], future: [st(big, ZERO, null, 4)] })
    // 计数按对象去重：dup 只算一次 → 16+16 = 32MP > 20MP → 两笔 dup 先后被丢，停
    const out = enforceLedgerBudget([s1, s2], 20_000_000)
    expect(out.toClose).toEqual([dup])
  })

  it('预算内：一笔都不丢（元素引用不动、没有要关的）', () => {
    const s = snap()
    const out = enforceLedgerBudget([s], LEDGER_PIXEL_BUDGET)
    expect(out.list).toHaveLength(1)
    expect(out.list[0]).toBe(s)        // 元素引用不动
    expect(out.toClose).toEqual([])
  })
})
