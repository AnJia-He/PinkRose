import { describe, it, expect } from 'vitest'
import { aspectOk, checkModelSize } from './size.ts'

/**
 * 这一组是 Task 1 欠下的债：`aspectOk` 与 `checkModelSize` 是 spec §4.3 那两条
 * **真金白银试出来的硬约束**的可执行形式 —— 尺寸不对，上游直接 400，而 400
 * 是不可重试的。所以断言必须真的咬得住：每条规则都断言它自己那句原因，
 * 因为 `checkModelSize` 的返回值契约就是「不合规的原因」，而这句话会原样
 * 出现在给用户的 400 响应体里。
 */

describe('aspectOk', () => {
  it('正好 3:1 通过 —— 上限是「不超过」，不是「小于」', () => {
    expect(aspectOk(1536, 512)).toBe(true)   // 1536 / 512 === 3
    expect(aspectOk(512, 1536)).toBe(true)
  })

  it('3:1 多一点点就不通过', () => {
    expect(aspectOk(1568, 512)).toBe(false)  // 1568 / 512 === 3.0625
    expect(aspectOk(512, 1568)).toBe(false)
  })

  it('横竖两个方向都按长边/短边算 —— 竖图 4:1 同样不通过', () => {
    // 写成 w/h <= 3 的实现，在竖图上会给出 true（512/2048 = 0.25），这条就会红
    expect(aspectOk(512, 2048)).toBe(false)
    expect(aspectOk(2048, 512)).toBe(false)
  })

  it('常见比例通过', () => {
    expect(aspectOk(1024, 1024)).toBe(true)
    expect(aspectOk(2048, 1536)).toBe(true)
  })
})

describe('checkModelSize', () => {
  it('合规尺寸返回 null', () => {
    expect(checkModelSize(1024, 768)).toBeNull()
    expect(checkModelSize(512, 512)).toBeNull()       // 下边界
    expect(checkModelSize(4096, 4096)).toBeNull()     // 上边界
    expect(checkModelSize(512, 1536)).toBeNull()      // 正好 3:1 合规
    // 真实照片 real_1027.jpg 是 1200x800：fitWithin(1200, 800, 2048) 原样返回，
    // 再 align32 得 1216x800 —— 这不是随便取的数，前端送的就是它
    expect(checkModelSize(1216, 800)).toBeNull()
  })

  it('不强制 MAX_DIMENSION 那条策略 —— 4096 是 API 的上限，不是我们的', () => {
    // 长边 2048 是前端 prepareForModel 的策略（省 token），后端只守 API 的硬约束。
    // 把 checkModelSize 改成也管 2048，这条会红。
    expect(checkModelSize(4096, 2048)).toBeNull()
  })

  it('宽高不是 32 的倍数 -> 拒', () => {
    // 1000x768 过了范围（512~4096）、过了宽高比（1.30）：只有倍数这一条能拒它
    expect(checkModelSize(1000, 768)).toBe('宽高必须是 32 的倍数')
    expect(checkModelSize(1024, 1000)).toBe('宽高必须是 32 的倍数')
    // 1040 % 32 === 16，但 1040 % 16 === 0：把检查弱化成 16 的倍数时，
    // 上面两条照样绿，只有这一条会红 —— 它钉的是"32 这个数本身"。
    expect(checkModelSize(1040, 768)).toBe('宽高必须是 32 的倍数')
  })

  it('小于 512 -> 拒', () => {
    expect(checkModelSize(256, 768)).toBe('宽高不能小于 512')
    expect(checkModelSize(1024, 256)).toBe('宽高不能小于 512')
  })

  it('大于 4096 -> 拒', () => {
    expect(checkModelSize(4128, 768)).toBe('宽高不能大于 4096')
    expect(checkModelSize(1024, 4128)).toBe('宽高不能大于 4096')
  })

  it('宽高比超过 3:1 -> 拒', () => {
    // 2048x512 是 4:1：倍数与范围两条都过，只有宽高比能拒它
    expect(checkModelSize(2048, 512)).toBe('宽高比不能超过 3:1')
    expect(checkModelSize(512, 2048)).toBe('宽高比不能超过 3:1')
  })

  it('非整数 -> 拒，报的是「整数」这条而不是被倍数规则顺带兜掉', () => {
    // 1024.5 也过不了 32 的倍数（余 0.5），所以只有断言到具体那句原因，
    // 才能证明「整数」这条规则本身还在
    expect(checkModelSize(1024.5, 768)).toBe('宽高必须是整数')
    expect(checkModelSize(1024, 768.5)).toBe('宽高必须是整数')
  })
})
