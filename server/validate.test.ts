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

  it('★ 需要点选澄清时，兜底**不许说"先按你说的试了一下"** —— 那一支什么都没做', () => {
    // 2026-10-04 修（spec 第 1275 行早写下的毛病）：模型说"我不确定"但没给自己的
    // 回复时，兜底原来吐「我没太看明白，先按你说的试了一下。」—— 而这一路
    // 生成被拦下、参数也没动，是句假话；紧接着界面又问「在图上点一下」，
    // 两句连着读互相打架。补法：这一支给中性的一句。
    const d = parseDecision({ needs_disambiguation: true, param_deltas: {} }, '把那个去掉')
    expect(d.reply.length).toBeGreaterThan(0)
    expect(d.reply).not.toContain('试')
  })

  it('对照：普通兜底**仍然**说"试了一下"（降级那条路是真的试了）', () => {
    // 上面那条的另一半 —— 少了它，一个"把 FALLBACK_REPLY 直接删掉"的改法照样绿，
    // 而 §4.7 降级那条路（拿用户原话真的跑了一次）就丢了它该说的话。
    const d = parseDecision({ route: 'params', param_deltas: {} })
    expect(d.reply).toContain('试了一下')
  })

  it('needs_disambiguation 非布尔时一律 false（宁可少问，不要卡住）', () => {
    expect(parseDecision({ ...GOOD, needs_disambiguation: 'yes' }).needsDisambiguation).toBe(false)
    expect(parseDecision({ ...GOOD, needs_disambiguation: true }).needsDisambiguation).toBe(true)
  })

  it('★ 模型说「我不确定你指哪个」、而参数又是空的时候 —— 不许偷偷换成一次生成', () => {
    // 2026-09-30 补。这一段（`validate.ts` 那道新闸里的 `!needsDisambiguation`）
    // **删掉它原来没有任何测试变红**，后果是静默的：重新引入"**一边问一边花钱**"——
    // 模型说"我不确定你指的是哪一个"，我们却拿用户原话直接走一次付费生成，
    // 而 App.tsx 那边同时还在问用户"在图上点一下？"（那一支是**先问再做**）。
    //
    // 变异：把 `validate.ts` 里那个 `!needsDisambiguation` 去掉 → 这条红
    //      （route 变成 generate、needsDisambiguation 变成 false）。
    const d = parseDecision({ needs_disambiguation: true, param_deltas: {} }, '把那个去掉')
    expect(d.route).toBe('params')   // 零成本、可逆的那条路（inferRoute 的原话）
    expect(d.needsDisambiguation).toBe(true)
    expect(d.editPrompt).toBe('')    // 没有可生成的东西 —— 一个生成的钱都不该花
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

/**
 * ★ Task 11（2026-10-05）：说话那条路认滤镜。
 *
 * 第三参数（滤镜名单）**默认 `[]`** —— 没给清单时任何名字都不认，
 * 既有的调用点与用例一个字不改也能过（各条既有判据只是跟着放宽一格）。
 */
describe('滤镜决策', () => {
  const names = ['黄昏', '黑白']
  it('只调滤镜也算"有内容"：走 params，不落降级', () => {
    const d = parseDecision({ route: 'params', lut: { name: '黄昏', amount: 80 } }, '用黄昏滤镜', names)
    expect(d.lut).toEqual({ name: '黄昏', amount: 80 })
    expect(d.route).toBe('params')
    expect(d.degraded).toBe(false)
  })
  it('不认识的名字归 null，并留 degraded 信号', () => {
    const d = parseDecision({ route: 'params', lut: { name: '青橙' } }, '用青橙', names)
    expect(d.lut).toBeNull()
    expect(d.degraded).toBe(true)
  })
  it('名字不在清单里、但另外半件事是真的 → 信号只能靠 `dropped` 留下来', () => {
    // 补这一条的理由：上面那条（纯滤镜 + 原话）走的是 §4.7 降级，`degraded`
    // 本来就是 true —— 把 `degraded` 里的 `|| dropped` 删掉它照样绿（一个
    // 从没红过的守卫不算守卫）。这里 route=both、edit_prompt 是真的、谁都不拦，
    // 唯一能留下"滤镜那半被丢了"的就是 `dropped`。
    const d = parseDecision(
      { route: 'both', lut: { name: '青橙' }, edit_prompt: 'remove the person' },
      '把那个人去掉，顺便用青橙', names)
    expect(d.route).toBe('both')
    expect(d.lut).toBeNull()
    expect(d.degraded).toBe(true)
  })
  it('只调滤镜 + 模型啰嗦地写了个 edit_prompt → 仍然走本地那条（不许升成生成）', () => {
    // `reconcile` 的第二参数是"本地那半有没有内容"—— 只调滤镜也算有，
    // 否则这个形状会被"内容为准"升成 generate：用户只是说了句滤镜，钱白花。
    // 变异：把 reconcile 那行的 `hasParams || hasLut` 写回 `hasParams` → 这一条红。
    const d = parseDecision({
      route: 'params', lut: { name: '黄昏' }, edit_prompt: 'Apply a warm sunset look.',
    }, '用黄昏滤镜', names)
    expect(d.route).toBe('params')
    expect(d.editPrompt).toBe('')
    expect(d.lut).toEqual({ name: '黄昏', amount: 100 })
    expect(d.degraded).toBe(true)   // 丢掉过它写的那半句，信号要留
  })
  it('name 为空串 = 摘掉', () => {
    const d = parseDecision({ route: 'params', lut: { name: '' } }, '不要滤镜了', names)
    expect(d.lut).toEqual({ name: '', amount: 0 })
  })
  it('没提滤镜 = null（不动）', () => {
    expect(parseDecision({ route: 'params', param_deltas: { exposure: 10 } }, '亮一点', names).lut).toBeNull()
  })
  it('大小写和空格都能对上', () => {
    expect(parseDecision({ route: 'params', lut: { name: ' Sunset ' } }, 'x', ['Sunset']).lut)
      .toEqual({ name: 'Sunset', amount: 100 })
  })
  it('客户端没给清单时，任何名字都不认', () => {
    expect(parseDecision({ route: 'params', lut: { name: '黄昏' } }, 'x', []).lut).toBeNull()
  })
  it('滤镜 + 生成 = both（两件事都做）', () => {
    const d = parseDecision({ route: 'both', lut: { name: '黄昏' }, edit_prompt: 'remove the person' }, 'x', names)
    expect(d.route).toBe('both')
    expect(d.lut).toEqual({ name: '黄昏', amount: 100 })
  })

  /**
   * ★ 2026-10-05 终审修复：**"键根本不在"和"键在、但形状烂"是两件事**。
   *
   * 形状烂的 `lut`（裸字符串 / 没有 name / 空对象）以前和"这次没提滤镜"一样
   * 被 `dropped: false` 静默丢掉，两个后果都不报错：
   *   A 有参数：滤镜没套上、`degraded` 还停在 false —— 零痕迹，而回复可能还说"套上了"；
   *   B 没参数：掉进 §4.7 的**付费降级** —— 而"只调滤镜不花钱"正是这条路的意义。
   *
   * ⚠️ `null` 是**合法**写法（提示词里写着"这次不碰滤镜 → `lut: null`"）：它和
   *    字段缺席一样，都是"模型说了这次不碰滤镜"，**不算烂**，不许误伤。
   */
  describe('形状烂的 lut 不是"没提滤镜"', () => {
    const BAD: unknown[] = ['黄昏', { amount: 80 }, {}]

    it('A：有参数时也留信号（dropped → degraded），不再是零痕迹', () => {
      for (const bad of BAD) {
        const d = parseDecision(
          { route: 'params', param_deltas: { exposure: 10 }, lut: bad }, '亮一点，顺便用黄昏', names)
        expect(d.lut, `${JSON.stringify(bad)} 不该解出滤镜`).toBeNull()
        // 变异：把 normalizeLutChoice 里"形状烂"那两条还回 `dropped: false` → 这里红
        expect(d.degraded, `${JSON.stringify(bad)} 丢过东西，信号要留`).toBe(true)
      }
    })

    it('B：没有别的内容时**不许**落进 §4.7 的付费降级', () => {
      for (const bad of BAD) {
        const d = parseDecision({ route: 'params', lut: bad }, '用黄昏滤镜', names)
        // 模型明明说了滤镜那一半（只是形状不对）：拿用户原话去跑一次生成，等于
        // 花钱把「用黄昏滤镜」当图像指令送上去 —— 正是这条路要防的那件事。
        expect(d.route, `${JSON.stringify(bad)} 不该被升成一次生成`).toBe('params')
        expect(d.lut).toBeNull()
        expect(d.degraded).toBe(true)
      }
    })

    it('camelCase 那个别名也算"键在"（`lutChoice` 走同一条路）', () => {
      const d = parseDecision(
        { route: 'params', param_deltas: { exposure: 10 }, lutChoice: '黄昏' }, '亮一点', names)
      expect(d.lut).toBeNull()
      expect(d.degraded).toBe(true)
    })

    it('`lut: null` 与字段缺席都是正常的 —— 不许误伤', () => {
      // 多给一个参数，免得落进"什么都没解出来 → 降级"那条路（那条路本来就 degraded）
      const explicit = parseDecision(
        { route: 'params', param_deltas: { exposure: 10 }, lut: null }, '亮一点', names)
      expect(explicit.degraded).toBe(false)
      const absent = parseDecision({ route: 'params', param_deltas: { exposure: 10 } }, '亮一点', names)
      expect(absent.degraded).toBe(false)
    })
  })
})
