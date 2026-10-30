import { describe, expect, it } from 'vitest'
import {
  enforceLedgerBudget, jumpLedger, ledgerIndex, ledgerLabels, ledgerTotal,
  pushEdit, redoEdit, sameEdit, undoEdit,
  LEDGER_PIXEL_BUDGET, type EditState,
} from './ledger'
import type { Snapshot } from './history'
import { ZERO } from '../../shared/adjustments.ts'

// 夹具说明：位图只要"是个对象、有宽高"就够了 —— 这些纯函数不看 GPU 资源，
// 只认**对象身份**（同一张）和**像素数**（`width × height`）。`tag` 是给断言
// 读的标签，出事时能一眼看出丢的是哪一张。
const img = (w: number, h: number, tag = '') => ({ bitmap: { tag }, width: w, height: h }) as any
const st = (base: any, params = ZERO, lut: any = null, seq = 1, label = '调整'): EditState =>
  ({ base, params, lut, seq, label })
const snap = (o: Partial<Snapshot> = {}): Snapshot => ({
  id: 1, label: 'x', editLabel: '原图', base: img(100, 100), params: ZERO, lut: null,
  isOriginal: false, thumb: '', past: [], future: [], ...o,
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

  it('★ 每一笔带名字；跳转时名字跟着位置走，future 里的那一笔不丢', () => {
    const a = img(10, 10), b = img(20, 20)
    const s0 = snap({ base: a, editLabel: '原图' })
    const s1 = pushEdit(s0, st(a, ZERO, null, 1, '原图'), {
      base: b, params: ZERO, lut: null, label: '裁剪',
    }, 1)
    expect(ledgerLabels(s1)).toEqual(['原图', '裁剪'])
    const back = undoEdit(s1)
    expect(ledgerLabels(back)).toEqual(['原图', '裁剪'])
    expect(back.editLabel).toBe('原图')
    const jump = jumpLedger(s1, 1)
    expect(jump.base).toBe(a)
    expect(jump.editLabel).toBe('原图')
    expect(jump.future).toHaveLength(1)
    expect(jump.future[0]!.label).toBe('裁剪')
    expect(jumpLedger(s1, 99)).toBe(s1)
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

  /**
   * ★ 2026-10-10（用户原话：「调色界面的回溯应该是[不]重复记忆的状态，刚才我试了
   *   一下两个滤镜重复切换记录了4个应该只算两个才对」）：**账本记的是"画面"，
   *   不是"操作流水"** —— 回到账本上已经有的那个画面 = 把位置挪过去，不新增一笔。
   *
   * 变异：把下面那两段 `findIndex` 拿掉 → 每切一次涨一笔（3 → 4 → 5…），
   *   也就是用户看到的那个"切几次记几条"；`App.adjust.test.tsx` 里那条同题
   *   用例也一起红。
   */
  it('★ 回到账本上已经记过的一笔：位置挪过去，不再记一笔', () => {
    const b = img(10, 10)
    const H = { lutId: 1, amount: 100 }      // 黄昏
    const Q = { lutId: 2, amount: 100 }      // 青橙
    const s0 = snap({ base: b })                                       // 出生：不用滤镜
    const s1 = pushEdit(s0, st(b), { base: b, params: ZERO, lut: H }, 1)
    const s2 = pushEdit(s1, st(b, ZERO, H, 2), { base: b, params: ZERO, lut: Q }, 2)
    expect(ledgerTotal(s2)).toBe(3)                                    // 出生 + 黄昏 + 青橙

    // ① 切回**上一笔**（黄昏）：位置退回去，一条不加
    const s3 = pushEdit(s2, st(b, ZERO, Q, 3), { base: b, params: ZERO, lut: H }, 3)
    expect(ledgerTotal(s3), '同一条不许记第二遍').toBe(3)
    expect(ledgerIndex(s3), '人站在"黄昏"那一笔上').toBe(2)
    expect(s3.lut).toBe(H)
    expect(s3.future.map(f => f.lut), '让出来的那一笔进 future —— 「下一步」还回得去').toEqual([Q])
    expect(s2.past, '纯函数：入参一个字都不动').toHaveLength(2)
    expect(s3).not.toBe(s2)

    // ② 再切回青橙：它现在在 future 里 —— 同样只挪位置
    const s4 = pushEdit(s3, st(b, ZERO, H, 4), { base: b, params: ZERO, lut: Q }, 4)
    expect(ledgerTotal(s4)).toBe(3)
    expect(ledgerIndex(s4)).toBe(3)
    expect(s4.lut).toBe(Q)

    // ③ 切回**出生那一笔**（「不用」，隔着两笔）：一路退到底，中间两笔都在 future 里
    const s5 = pushEdit(s4, st(b, ZERO, Q, 5), { base: b, params: ZERO, lut: null }, 5)
    expect(ledgerTotal(s5)).toBe(3)
    expect(ledgerIndex(s5)).toBe(1)
    expect(s5.lut).toBe(null)
    expect(s5.future.map(f => f.lut)).toEqual([H, Q])

    // ④ 参数回到老值也一样（不只滤镜）——同一个画面的另一个来源
    const s6 = pushEdit(snap({ base: b }), st(b), { base: b, params: { ...ZERO, exposure: 30 }, lut: null }, 1)
    const s7 = pushEdit(s6, st(b, { ...ZERO, exposure: 30 }, null, 2), { base: b, params: ZERO, lut: null }, 2)
    expect(ledgerTotal(s7)).toBe(2)
    expect(ledgerIndex(s7)).toBe(1)
  })

  it('认画面认的是**同一张底图**：换上来的新底图哪怕尺寸一样也各算各的（裁剪那条路永远不合并）', () => {
    // ⚠️ 这条是上一条的**边界**：`sameEdit` 的 base **认对象身份** —— 裁第二刀得到的
    //   是一张**新位图**，哪怕宽高和上一张一模一样，也不许被当成"回到某一笔"。
    //   改成比值 / 比宽高的话，就是"裁第二刀不记账"（画面照换、账本不动，静默）。
    const a = img(10, 10); const b = img(10, 10); const c = img(10, 10)
    const s1 = pushEdit(snap({ base: a }), st(a), { base: b, params: ZERO, lut: null }, 1)
    expect(ledgerTotal(s1)).toBe(2)
    const s2 = pushEdit(s1, st(b, ZERO, null, 2), { base: c, params: ZERO, lut: null }, 2)
    expect(ledgerTotal(s2), '新底图 = 新的一笔，不跟上一笔合并').toBe(3)
    expect(ledgerIndex(s2)).toBe(3)
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
