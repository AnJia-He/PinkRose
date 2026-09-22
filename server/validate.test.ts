import { describe, it, expect } from 'vitest'
import { parseDecision, fallbackDecision, normalizeDeltas, inferRoute } from './validate.ts'

const GOOD = {
  route: 'both',
  param_deltas: { exposure: 30, shadows: 20 },
  reply: '天有点灰，我提了下亮度；后面那个人也清掉了。',
  edit_prompt: 'Remove the person behind the subject.',
  needs_disambiguation: false,
}

describe('normalizeDeltas', () => {
  it('只留八个合法键，未知键丢弃', () => {
    expect(normalizeDeltas({ exposure: 10, sharpness: 50, foo: 1 })).toEqual({ exposure: 10 })
  })

  it('非有限值丢弃（NaN / Infinity / 字符串 / null）', () => {
    expect(normalizeDeltas({ exposure: NaN, contrast: Infinity, shadows: '30', highlights: null }))
      .toEqual({})
  })

  it('超范围钳到 [-100,100]', () => {
    expect(normalizeDeltas({ exposure: 250, contrast: -999 })).toEqual({ exposure: 100, contrast: -100 })
  })

  it('小数取整', () => {
    expect(normalizeDeltas({ exposure: 12.7, contrast: -3.2 })).toEqual({ exposure: 13, contrast: -3 })
  })

  it('全部非零值的绝对值都 <= 1 时，判定为量纲搞错，整体乘 100', () => {
    // 实测 kimi-k3 在没写死量纲时会输出 0.4 / 0.05 这类值
    expect(normalizeDeltas({ exposure: 0.4, temperature: 0.05 }))
      .toEqual({ exposure: 40, temperature: 5 })
  })

  it('混合量纲时不放大 —— 40 和 0.5 同时出现，说明 0.5 是它真想表达 0.5', () => {
    expect(normalizeDeltas({ exposure: 40, contrast: 0.5 })).toEqual({ exposure: 40, contrast: 1 })
  })

  it('全零不算量纲错误', () => {
    expect(normalizeDeltas({ exposure: 0, contrast: 0 })).toEqual({ exposure: 0, contrast: 0 })
  })

  it('不是对象就返回空', () => {
    expect(normalizeDeltas(null)).toEqual({})
    expect(normalizeDeltas([1, 2])).toEqual({})
    expect(normalizeDeltas('nope')).toEqual({})
  })

  it('布尔值不算数字 —— true 不该被当成 1', () => {
    expect(normalizeDeltas({ exposure: true })).toEqual({})
  })
})

describe('inferRoute', () => {
  it('两者都有 -> both；只有一个 -> 那个；都没有 -> params', () => {
    expect(inferRoute(true, true)).toBe('both')
    expect(inferRoute(true, false)).toBe('params')
    expect(inferRoute(false, true)).toBe('generate')
    expect(inferRoute(false, false)).toBe('params')
  })
})

describe('parseDecision', () => {
  it('合法对象原样映射', () => {
    const d = parseDecision(GOOD)
    expect(d.route).toBe('both')
    expect(d.paramDeltas).toEqual({ exposure: 30, shadows: 20 })
    expect(d.reply).toBe(GOOD.reply)
    expect(d.editPrompt).toBe(GOOD.edit_prompt)
    expect(d.needsDisambiguation).toBe(false)
    expect(d.degraded).toBe(false)
  })

  it('接受 JSON 字符串', () => {
    expect(parseDecision(JSON.stringify(GOOD)).route).toBe('both')
  })

  it('接受被 ```json 围栏包住的字符串', () => {
    expect(parseDecision('```json\n' + JSON.stringify(GOOD) + '\n```').route).toBe('both')
  })

  it('接受前后带废话的字符串 —— 从第一个 { 到最后一个 }', () => {
    expect(parseDecision('好的：\n' + JSON.stringify(GOOD) + '\n以上。').route).toBe('both')
  })

  it('route 是枚举外的值时按内容推断（实测会吐 "ask"）', () => {
    const d = parseDecision({ ...GOOD, route: 'ask' })
    expect(d.route).toBe('both')
    expect(d.degraded).toBe(true)   // 推断过就说明模型没守规矩，标记出来
  })

  it('route 是枚举外的值且只有 deltas 时 -> params', () => {
    const d = parseDecision({ route: 'ask', param_deltas: { exposure: 20 } })
    expect(d.route).toBe('params')
  })

  it('reply 缺失时给兜底文案，不是空字符串', () => {
    const d = parseDecision({ route: 'params', param_deltas: { exposure: 10 } })
    expect(d.reply.length).toBeGreaterThan(0)
  })

  it('reply 是数字这种非字符串也兜底', () => {
    expect(parseDecision({ ...GOOD, reply: 123 }).reply.length).toBeGreaterThan(0)
  })

  it('needs_disambiguation 非布尔时一律 false（宁可少问，不要卡住）', () => {
    expect(parseDecision({ ...GOOD, needs_disambiguation: 'yes' }).needsDisambiguation).toBe(false)
    expect(parseDecision({ ...GOOD, needs_disambiguation: true }).needsDisambiguation).toBe(true)
  })

  it('完全解析不了时走降级', () => {
    const d = parseDecision('这不是 JSON')
    expect(d.degraded).toBe(true)
    expect(d.route).toBe('generate')
  })

  it('deltas 全为空且没有 edit_prompt 时走 params，并标记 degraded', () => {
    // "走 params 但什么也没动"和"走 generate 但 prompt 是空的"都是空操作
    // （前端的 runGenerate 第一行就是 if (!editPrompt) return）。
    // 那就不如走零成本、可逆的那条路，同时用 degraded 说清"这次模型给的没用"。
    const d = parseDecision({ route: 'params', param_deltas: {} })
    expect(d.route).toBe('params')
    expect(d.degraded).toBe(true)
  })

  it('用 camelCase 的输出也认 —— 模型可能不听话', () => {
    const d = parseDecision({ route: 'params', paramDeltas: { exposure: 15 }, reply: '好' })
    expect(d.paramDeltas).toEqual({ exposure: 15 })
  })
})

describe('fallbackDecision', () => {
  it('走生成，原文当 prompt（spec §4.7）', () => {
    const d = fallbackDecision('天太灰了')
    expect(d.route).toBe('generate')
    expect(d.editPrompt).toBe('天太灰了')
    expect(d.degraded).toBe(true)
    expect(d.paramDeltas).toEqual({})
  })

  it('超长输入被截断 —— prompt 有长度上限，别把整段话塞进去', () => {
    expect(fallbackDecision('啊'.repeat(500)).editPrompt.length).toBeLessThanOrEqual(200)
  })
})
