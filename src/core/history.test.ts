import { describe, it, expect } from 'vitest'
import { pushSnapshot, cutAfter, bitmapsToClose, attachThumb, MAX_SNAPSHOTS, type Snapshot } from './history'
import type { EditState } from './ledger'
import type { DecodedImage } from '../image/decode'
import { ZERO } from '../../shared/adjustments.ts'

const fakeBitmap = (tag: string) => ({ tag }) as unknown as DecodedImage
const mk = (id: number, isOriginal = false): Snapshot => ({
  id, label: `第${id}步`, base: fakeBitmap(`b${id}`), params: ZERO, isOriginal, thumb: '',
  // 这个模块的纯函数不看滤镜（它们只排数组、关位图）—— 夹具给 null 就行，
  // 但**必须给**：`Snapshot.lut` 是必填的，那是"每个构造点都得表态"那道闸。
  lut: null,
  // 账本（2026-10-08）同理：必填，默认空账本。要账本的用例自己造（见底下那组）。
  past: [], future: [],
})
const tagOf = (b: DecodedImage) => (b as unknown as { tag: string }).tag

describe('pushSnapshot', () => {
  it('追加到末尾', () => {
    expect(pushSnapshot([mk(1, true)], mk(2)).map(s => s.id)).toEqual([1, 2])
  })

  it('超过上限时丢掉最老的**非原图**快照 —— 原图永远留着', () => {
    let list: Snapshot[] = [mk(0, true)]
    for (let i = 1; i <= MAX_SNAPSHOTS + 3; i++) list = pushSnapshot(list, mk(i))
    expect(list).toHaveLength(MAX_SNAPSHOTS)
    expect(list[0].isOriginal).toBe(true)
    expect(list[list.length - 1].id).toBe(MAX_SNAPSHOTS + 3)
  })

  it('不修改入参', () => {
    const before = [mk(1, true)]
    pushSnapshot(before, mk(2))
    expect(before).toHaveLength(1)
  })
})

describe('cutAfter', () => {
  it('回到指定一步 —— 列表截断到那一步（含）', () => {
    expect(cutAfter([mk(1, true), mk(2), mk(3), mk(4)], 2).map(s => s.id)).toEqual([1, 2])
  })

  it('回到原图', () => {
    expect(cutAfter([mk(1, true), mk(2), mk(3)], 1).map(s => s.id)).toEqual([1])
  })

  it('找不到的 id 原样返回一份拷贝，不崩', () => {
    const list = [mk(1, true), mk(2)]
    const out = cutAfter(list, 99)
    expect(out).toEqual(list)
    expect(out).not.toBe(list)
  })

  it('不修改入参', () => {
    const list = [mk(1, true), mk(2), mk(3)]
    cutAfter(list, 1)
    expect(list).toHaveLength(3)
  })
})

describe('attachThumb', () => {
  const snap = (id: number, thumb = ''): Snapshot =>
    ({ id, label: `${id}`, base: fakeBitmap(`${id}`), params: ZERO, isOriginal: id === 1, thumb, lut: null,
       past: [], future: [] })

  it('把缩略图挂到指定那一步上', () => {
    const list = [snap(1), snap(2), snap(3)]
    const next = attachThumb(list, 2, 'data:image/jpeg;base64,AAA')
    expect(next[1].thumb).toBe('data:image/jpeg;base64,AAA')
    // 别的不能动 —— 挂错行等于给用户看错图
    expect(next[0].thumb).toBe('')
    expect(next[2].thumb).toBe('')
  })

  it('不改入参', () => {
    // 这个项目里出现过一次「函数悄悄改了传进来的数组」。
    // 纯函数是这个模块存在的意义，必须钉住。
    const list = [snap(1)]
    attachThumb(list, 1, 'x')
    expect(list[0].thumb).toBe('')
  })

  it('找不到那个 id 时原样返回一份拷贝', () => {
    const list = [snap(1)]
    const next = attachThumb(list, 99, 'x')
    expect(next).toEqual(list)
    expect(next).not.toBe(list)
  })
})

describe('bitmapsToClose', () => {
  it('跳回去之后，被截掉的位图要释放 —— 它们占的是 GPU 内存', () => {
    const old = [mk(1, true), mk(2), mk(3)]
    expect(bitmapsToClose(old, cutAfter(old, 1)).map(tagOf)).toEqual(['b2', 'b3'])
  })

  it('还在新列表里的位图一个都不能关 —— 关了画布直接空白', () => {
    const old = [mk(1, true), mk(2)]
    expect(bitmapsToClose(old, [...old, mk(3)])).toHaveLength(0)
  })

  it('protectOriginal 时原图不关 —— "回到原图"还要用它', () => {
    const old = [mk(1, true), mk(2)]
    // 注意 fixture：after 里**不能**包含原图。否则 keep 集合已经保护了它，
    // protectOriginal 就无事可做——旧 fixture 正是这样，带不带 opts 返回值相同，
    // 断言恒红且区分不了任何东西（node 探针实测过）。
    expect(bitmapsToClose(old, [old[1]], { protectOriginal: true })).toHaveLength(0)
    // 对照：关掉保护就该关它。没有这一条，第一条也可能因为别的原因恒 0。
    expect(bitmapsToClose(old, [old[1]]).map(tagOf)).toEqual(['b1'])
  })

  it('两个列表相同时没有要关的', () => {
    const list = [mk(1, true), mk(2)]
    expect(bitmapsToClose(list, list)).toHaveLength(0)
  })
})

describe('bitmapsToClose（账本）', () => {
  // ★ 2026-10-08（调色区账本）：一版名下活着的位图 = 当前位置 + 账本里每一笔。
  // 夹具照本文件的写法：一笔用 `entry` 造，一版用 `ledgerSnap` 造。
  const entry = (base: DecodedImage, seq = 1): EditState => ({ base, params: ZERO, lut: null, seq })
  const ledgerSnap = (o: {
    id: number; base: DecodedImage; isOriginal?: boolean
    past?: EditState[]; future?: EditState[]
  }): Snapshot => ({
    id: o.id, label: `第${o.id}步`, base: o.base, params: ZERO, lut: null,
    isOriginal: o.isOriginal ?? false, thumb: '',
    past: o.past ?? [], future: o.future ?? [],
  })

  it('★ 位图回收要认账本：某一步被切掉时，它 past/future 里的位图一起还回去', () => {
    // 账本里的位图也要被认出来 —— 漏一个就是 GPU 内存泄漏
    const a = fakeBitmap('a'), b = fakeBitmap('b'), c = fakeBitmap('c')
    const s1 = ledgerSnap({ id: 1, base: a, past: [entry(b)], future: [] })
    const s2 = ledgerSnap({ id: 2, base: c, past: [], future: [] })
    expect(bitmapsToClose([s1, s2], [s2]).sort()).toEqual([a, b].sort())
  })

  it('★ 账本里的位图还被别的笔引用着就不许关（共享对象只关一次）', () => {
    const a = fakeBitmap('a'), b = fakeBitmap('b')
    const s1 = ledgerSnap({ id: 1, base: a, past: [entry(b)], future: [] })
    const s2 = ledgerSnap({ id: 2, base: b, past: [], future: [] })   // 同一张 b 也被 s2 用着
    expect(bitmapsToClose([s1, s2], [s2])).toEqual([a])
  })

  it('★ protectOriginal 跳过的是**整个账本**：原图那一版的 past/future 也不关', () => {
    const a = fakeBitmap('a'), b = fakeBitmap('b'), c = fakeBitmap('c')
    const orig = ledgerSnap({ id: 1, isOriginal: true, base: a, past: [entry(b)], future: [] })
    const s2 = ledgerSnap({ id: 2, base: c })
    // fixture 照旧规矩：after 里**不能**包含原图 —— 否则 keep 集合已经兜住了，
    // protectOriginal 就无事可做，这条断言区分不了任何东西。
    expect(bitmapsToClose([orig, s2], [s2], { protectOriginal: true })).toEqual([])
    // 对照：不保护时 a 和 b 都要关。没有这一条，上面那条可能因为别的原因恒过。
    expect(bitmapsToClose([orig, s2], [s2]).sort()).toEqual([a, b].sort())
  })

  it('★ 同一张底图落在两条账里、又都没人引用 —— 也只报一次（关两次靠 close 幂等兜着，但契约是"只关一次"）', () => {
    const a = fakeBitmap('a'), b = fakeBitmap('b'), c = fakeBitmap('c')
    const s1 = ledgerSnap({ id: 1, base: a, past: [entry(b)], future: [] })
    const s2 = ledgerSnap({ id: 2, base: c, past: [entry(b)], future: [] })
    // after 空 —— keep 保护不了谁，去重全靠 seen。（上面那条用例拦的是 keep 侧，
    // 拦不住"seen 被删掉"这个变异 —— 需要这一条才算真守卫。）
    expect(bitmapsToClose([s1, s2], [])).toEqual([a, b, c])
  })
})
