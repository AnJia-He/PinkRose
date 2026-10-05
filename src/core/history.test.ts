import { describe, it, expect } from 'vitest'
import { pushSnapshot, jumpTo, bitmapsToClose, attachThumb, MAX_SNAPSHOTS, type Snapshot } from './history'
import type { DecodedImage } from '../image/decode'
import { ZERO } from '../../shared/adjustments.ts'

const fakeBitmap = (tag: string) => ({ tag }) as unknown as DecodedImage
const mk = (id: number, isOriginal = false): Snapshot => ({
  id, label: `第${id}步`, base: fakeBitmap(`b${id}`), params: ZERO, isOriginal, thumb: '',
  // 这个模块的纯函数不看滤镜（它们只排数组、关位图）—— 夹具给 null 就行，
  // 但**必须给**：`Snapshot.lut` 是必填的，那是"每个构造点都得表态"那道闸。
  lut: null,
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

describe('jumpTo', () => {
  it('回到指定一步 —— 列表截断到那一步（含）', () => {
    expect(jumpTo([mk(1, true), mk(2), mk(3), mk(4)], 2).map(s => s.id)).toEqual([1, 2])
  })

  it('回到原图', () => {
    expect(jumpTo([mk(1, true), mk(2), mk(3)], 1).map(s => s.id)).toEqual([1])
  })

  it('找不到的 id 原样返回一份拷贝，不崩', () => {
    const list = [mk(1, true), mk(2)]
    const out = jumpTo(list, 99)
    expect(out).toEqual(list)
    expect(out).not.toBe(list)
  })

  it('不修改入参', () => {
    const list = [mk(1, true), mk(2), mk(3)]
    jumpTo(list, 1)
    expect(list).toHaveLength(3)
  })
})

describe('attachThumb', () => {
  const snap = (id: number, thumb = ''): Snapshot =>
    ({ id, label: `${id}`, base: fakeBitmap(`${id}`), params: ZERO, isOriginal: id === 1, thumb, lut: null })

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
    expect(bitmapsToClose(old, jumpTo(old, 1)).map(tagOf)).toEqual(['b2', 'b3'])
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
