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

  it('解析失败时用传进来的用户原话当 prompt，而不是模型输出', () => {
    expect(parseDecision('这不是 JSON', '天太灰了').editPrompt).toBe('天太灰了')
    // 不传第二个参数时退回旧行为（既有测试依赖这个）
    expect(parseDecision('这不是 JSON').editPrompt).toBe('这不是 JSON')
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

  it('route 说 params 但带了非空 edit_prompt、参数又全零时，以内容为准走生成', () => {
    // 这是 hasParams 判据里那个死分支会咬人的地方：若它被误判成 true，
    // reconcile 的分支不触发，这句非空的 edit_prompt 就被静默丢掉了。
    const d = parseDecision({
      route: 'params',
      param_deltas: { exposure: 0 },
      edit_prompt: 'Remove the person behind the subject.',
    })
    expect(d.route).toBe('generate')
    expect(d.editPrompt).toContain('Remove the person')
  })

  it('param_deltas 全是零值（不是空对象）时，degraded 也要是 true', () => {
    // 和「空对象」那条是同一件事隔了一层：都等于"什么都没动"
    const d = parseDecision({ route: 'params', param_deltas: { exposure: 0 } })
    expect(d.route).toBe('params')
    expect(d.degraded).toBe(true)
  })

  it('route 说 both 但没有 edit_prompt 时降成 params', () => {
    const d = parseDecision({ route: 'both', param_deltas: { exposure: 20 } })
    expect(d.route).toBe('params')
    expect(d.paramDeltas).toEqual({ exposure: 20 })
    expect(d.degraded).toBe(true)
  })

  it('route 说 generate 但既吐了 deltas 又给了 edit_prompt 时，以内容为准走 both', () => {
    // 通用规则（`hasParams && hasEdit → both`）的一个格子：声明 generate，内容却是两半都有。
    // 不修的话前端 App.tsx 只在 route 是 params/both 时才应用 deltas，
    // 用户说的调色那半句被静默丢掉，而 degraded 还是 false——连信号都没有。
    const d = parseDecision({
      route: 'generate',
      param_deltas: { exposure: 30 },
      edit_prompt: 'Remove the person behind the subject.',
    })
    expect(d.route).toBe('both')
    expect(d.paramDeltas).toEqual({ exposure: 30 })
    expect(d.degraded).toBe(true)   // 改过道 = 模型没守自己的声明
  })

  it('声明 params 又用 edit_prompt 把同一件事复述一遍 —— 听声明的，不要升成 both', () => {
    // **2026-09-29 实测原样**（模型对「亮一点」的真实输出）：
    //   {"route":"params","param_deltas":{"exposure":40},
    //    "edit_prompt":"Increase overall brightness by raising exposure by 40, ..."}
    // route 说得很对，deltas 也给对了 —— 它只是**啰嗦**，把同一件事用英文又写了一遍。
    //
    // 下面那条「通用规则（两半都有 → both）」判不出"啰嗦"和"第二件事"的区别，
    // 一律升成 both。后果实测过：同一件事做两遍（本地调一次 + 云端再调一次），
    // 一张暖调日落被压成刺眼的电光蓝，红色通道 81.8 → 50.2（掉 38%），
    // 而且多花 18.4 秒和一次云端 —— 本地滑块做同一件事只要 423 毫秒、0 次网络。
    const d = parseDecision({
      route: 'params',
      param_deltas: { exposure: 40 },
      reply: '好的，给你调亮一些',
      edit_prompt: 'Increase overall brightness by raising exposure by 40, keep all other elements unchanged',
      needs_disambiguation: false,
    })
    expect(d.route).toBe('params')
    expect(d.paramDeltas).toEqual({ exposure: 40 })
    expect(d.editPrompt).toBe('')   // 不采纳的那一半，别留在响应里当雷
    expect(d.degraded).toBe(true)   // 丢掉过模型写的东西，得留信号
  })

  it('route 说 params 但 edit_prompt 说的是另一件事 —— 还是听声明的，那半句会丢', () => {
    // ⚠️ **这条断言 2026-09-29 被反过来过。知道代价才改的，理由如下。**
    //
    // 原来它断言 'both'，理由是"别把用户说的'去掉那个人'静默丢掉"。
    // 但 reconcile **判不出"第二件事"和"同一件事说两遍"的区别**，只能一律升成 both。
    // 而实测下来：
    //   · 它要防的形状（声明 params + prompt 说结构改动）—— 两轮测试里**一次都没出现**
    //   · 它误伤的形状（声明 params + prompt 是 deltas 的英文复述）—— **6 条纯调色里 4 条**
    // 误伤的代价是量过的：同一件事做两遍，红色通道掉 38%，多花 18.4 秒和一次云端。
    //
    // 所以反过来选：**信模型自己写的 route**。上面那条测试钉的是常发生的那个形状，
    // 这条钉的是我们明知而付出的代价 —— 并排放着，谁改回去都会有一条红。
    //
    // 丢掉的那半不是"静默"：degraded=true 会留信号（见断言），
    // 而且 ROUTER_SYSTEM 现在明写了"走 params 时 edit_prompt 必须是空字符串"——
    // 这个形状现在是**违约**，不是正常输出。
    const d = parseDecision({
      route: 'params',
      param_deltas: { exposure: 30 },
      edit_prompt: 'Remove the person behind the subject.',
    })
    expect(d.route).toBe('params')
    expect(d.editPrompt).toBe('')
    expect(d.degraded).toBe(true)   // 丢掉过模型写的东西，信号不能丢
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
