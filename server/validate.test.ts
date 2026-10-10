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

/**
 * ★ 2026-10-10：「我的预设」那条路 —— 和滤镜**完全平行**（清单上去、只回名字、
 * 前端自己对号赋值）。
 *
 * 第四参数（预设名单）**默认 `[]`** —— 没给清单时任何名字都不认，
 * 既有调用点与用例一个字不改也能过。
 */
describe('预设决策', () => {
  const names = ['黄昏旅拍', '清透日系']

  it('只套预设也算"有内容"：走 params，不落降级', () => {
    const d = parseDecision({ route: 'params', preset: { name: '黄昏旅拍' } }, '用我那套黄昏的', [], names)
    expect(d.preset).toEqual({ name: '黄昏旅拍' })
    expect(d.route).toBe('params')
    // 套预设是**本地动作**（整组参数赋值）：和只调滤镜一样，不是"没读懂" ——
    // degraded 置 true 的话前端会弹"拿不太准"那句提醒，而这次它答得完全正确。
    // 变异：把 degraded 那行里的 `!hasPreset` 去掉 → 这条红。
    expect(d.degraded).toBe(false)
  })

  it('不认识的名字归 null，并留 degraded 信号', () => {
    const d = parseDecision({ route: 'params', preset: { name: '青橙' } }, '用我那套青橙的', [], names)
    expect(d.preset).toBeNull()
    expect(d.degraded).toBe(true)
  })

  it('名字不在清单里、但另外半件事是真的 → 信号只能靠 `dropped` 留下来', () => {
    // 同滤镜那条：纯预设 + 原话会走 §4.7 降级（degraded 本来就 true），
    // 把 degraded 里的 `|| droppedPreset` 删掉它照样绿。这里 route=both、
    // edit_prompt 是真的、谁都不拦，唯一能留下"预设那半被丢了"的就是 droppedPreset。
    const d = parseDecision(
      { route: 'both', preset: { name: '青橙' }, edit_prompt: 'remove the person' },
      '把那个人去掉，顺便用青橙那套', [], names)
    expect(d.route).toBe('both')
    expect(d.preset).toBeNull()
    expect(d.degraded).toBe(true)
  })

  it('只套预设 + 模型啰嗦地写了个 edit_prompt → 仍然走本地那条（不许升成生成）', () => {
    // `reconcile` 的第二参数是"本地那半有没有内容"—— 只套预设也算有，
    // 否则这个形状会被"内容为准"升成 generate：用户只是说了句预设，钱白花。
    // 变异：把 reconcile 那行的 `hasParams || hasLut || hasPreset` 少写 preset → 红。
    const d = parseDecision({
      route: 'params', preset: { name: '黄昏旅拍' }, edit_prompt: 'Apply a warm sunset look.',
    }, '用我那套黄昏的', [], names)
    expect(d.route).toBe('params')
    expect(d.editPrompt).toBe('')
    expect(d.preset).toEqual({ name: '黄昏旅拍' })
    expect(d.degraded).toBe(true)   // 丢掉过它写的那半句，信号要留
  })

  it('没提预设 = null（不动）', () => {
    expect(parseDecision({ route: 'params', param_deltas: { exposure: 10 } }, '亮一点', [], names).preset)
      .toBeNull()
  })

  it('大小写和空格都能对上，且回的是**清单里的原名**', () => {
    // 回原名而不是模型写的那个：前端对号用的是同一把尺子（`samePresetName`），
    // 但决策里带着模型的写法（尾随空格 / 大小写）时，任何**全等**判的地方都会对不上。
    const d = parseDecision({ route: 'params', preset: { name: ' 清透日系 ' } }, 'x', [], names)
    expect(d.preset).toEqual({ name: '清透日系' })
  })

  it('大小写对号：清单里的 `Sunset`，模型写 `sunset` 也认', () => {
    expect(parseDecision({ route: 'params', preset: { name: 'sunset' } }, 'x', [], ['Sunset']).preset)
      .toEqual({ name: 'Sunset' })
  })

  it('客户端没给清单时，任何名字都不认', () => {
    expect(parseDecision({ route: 'params', preset: { name: '黄昏旅拍' } }, 'x', [], []).preset).toBeNull()
  })

  it('预设 + 生成 = both（两件事都做）', () => {
    const d = parseDecision({ route: 'both', preset: { name: '黄昏旅拍' }, edit_prompt: 'remove the person' },
      'x', [], names)
    expect(d.route).toBe('both')
    expect(d.preset).toEqual({ name: '黄昏旅拍' })
  })

  it('预设和 lut 是两个字段：同一句里各归各的，谁都不顶替谁', () => {
    // 提示词里明写了"用户说的是哪个就回哪个字段"—— 决策层这半靠的是两段
    // normalize 各自独立（共用一处的话这里会看到其中一个被另一个挤掉）。
    const d = parseDecision(
      { route: 'params', lut: { name: '黄昏', amount: 80 }, preset: { name: '清透日系' } },
      '用清透日系那套，再加黄昏滤镜', ['黄昏'], names)
    expect(d.lut).toEqual({ name: '黄昏', amount: 80 })
    expect(d.preset).toEqual({ name: '清透日系' })
    expect(d.degraded).toBe(false)
  })

  /**
   * 形状烂的 `preset` 不是"没提预设" —— 照「形状烂的 lut」那组的同一个理由：
   *   A 有参数：预设没套上、`degraded` 还停在 false —— 零痕迹，而回复可能还说"套上了"；
   *   B 没参数：掉进 §4.7 的**付费降级** —— 而"只套预设不花钱"正是这条路的意义。
   *
   * ⚠️ 和 lut 的一条**故意不同的**：`{name: ''}` 在 lut 那边是合法的"摘掉"，
   *    在预设这边不指向任何清单项 —— 归 `dropped`（预设是"把参数赋值过去"，
   *    没有"摘掉"这回事），所以它也在这一组里。
   */
  describe('形状烂的 preset 不是"没提预设"', () => {
    const BAD: unknown[] = ['黄昏旅拍', { amount: 80 }, {}, { name: 42 }, { name: '' }]

    it('A：有参数时也留信号（droppedPreset → degraded），不再是零痕迹', () => {
      for (const bad of BAD) {
        const d = parseDecision(
          { route: 'params', param_deltas: { exposure: 10 }, preset: bad }, '亮一点，顺便用黄昏那套', [], names)
        expect(d.preset, `${JSON.stringify(bad)} 不该解出预设`).toBeNull()
        // 变异：把 normalizePresetChoice 里"形状烂 / 不命中"那几条还回 `dropped: false` → 这里红
        expect(d.degraded, `${JSON.stringify(bad)} 丢过东西，信号要留`).toBe(true)
      }
    })

    it('B：没有别的内容时**不许**落进 §4.7 的付费降级', () => {
      for (const bad of BAD) {
        const d = parseDecision({ route: 'params', preset: bad }, '用我那套黄昏的', [], names)
        // 模型明明说了预设那一半（只是名字对不上）：拿用户原话去跑一次生成，
        // 等于花钱把「用我那套黄昏的」当图像指令送上去 —— 正是这条路要防的那件事。
        expect(d.route, `${JSON.stringify(bad)} 不该被升成一次生成`).toBe('params')
        expect(d.preset).toBeNull()
        expect(d.degraded).toBe(true)
      }
    })

    it('`preset: null` 与字段缺席都是正常的 —— 不许误伤', () => {
      // 多给一个参数，免得落进"什么都没解出来 → 降级"那条路（那条路本来就 degraded）
      const explicit = parseDecision(
        { route: 'params', param_deltas: { exposure: 10 }, preset: null }, '亮一点', [], names)
      expect(explicit.degraded).toBe(false)
      const absent = parseDecision({ route: 'params', param_deltas: { exposure: 10 } }, '亮一点', [], names)
      expect(absent.degraded).toBe(false)
    })
  })
})

/**
 * ★ 2026-10-06：**干净的 no-op**（读懂了、模型明说这次不用改）不再降级。
 *
 * 用户实测：对着一张照片说「你好」，模型**答得完全正确** —— 下面那坨 HELLO
 * 就是它原样吐的 JSON —— 而兜底闸把这种形状也当成"模型吐的东西一件也用不上"→
 * 前端拿"你好"当改图指令跑了一次**付费生成**，回话是驴唇不对马嘴的
 * 「我直接按你说的试了一下。」。分界线：**"读懂了说不用改" ≠ "没读懂 / 丢了东西"**。
 *
 * 修前的行为（这一组里没写"RED"标记的那几条）：gate 一开火就是抛掉模型的
 * 回答、拿用户原话去生成 —— 所以它们全部是"对照"，钉的是**边界没有外扩**。
 */
describe('干净的 no-op（打招呼那种）· 2026-10-06', () => {
  // 实测原样：chat 通道（Agnes）对「你好」答的就是这个形状
  // （`.superpowers/sdd/2026-10-05-rewind/repro-hello.mjs` 打印过）。
  const HELLO = {
    route: 'params',
    param_deltas: {
      exposure: 0, contrast: 0, highlights: 0, shadows: 0,
      saturation: 0, temperature: 0, clarity: 0, vignette: 0,
    },
    reply: '你好，照片有什么想调的吗？',
    edit_prompt: '',
    needs_disambiguation: false,
    lut: null,
  }

  it('★ 不降级：照它说的走 —— params / 增量空 / 模型那句 reply / degraded=false', () => {
    // 变异：删掉 validate.ts 里那条 `cleanNoop` 早返回 → 这条红
    // （route 变 generate、editPrompt 变"你好"、reply 变兜底那句、degraded=true）。
    const d = parseDecision(HELLO, '你好')
    expect(d.route).toBe('params')
    expect(d.paramDeltas).toEqual({})
    expect(d.editPrompt).toBe('')
    expect(d.reply).toBe('你好，照片有什么想调的吗？')
    expect(d.degraded).toBe(false)
  })

  it('没给 userText 时**保持旧行为** —— degraded=true、增量还是全 0 键（不是 `{}`）', () => {
    // cleanNoop 里的 `userText` 和下面那道闸门对称：没有用户原话时"拿原话去试"
    // 无从谈起，也就没有"照它说的走"这回事 —— 保持旧行为（degraded 打出来，滑块一个不动）。
    // ⚠️ 2026-10-06 评审补的闸：原来漏了它，和闸门自己的注释（"userText 为空时保持原样"）打架。
    // 变异：把 cleanNoop 里的 `&& userText` 去掉 → 这条红（degraded 变 false、paramDeltas 变 `{}`）。
    const d = parseDecision(HELLO)
    expect(d.route).toBe('params')
    expect(d.degraded).toBe(true)
    expect(d.paramDeltas).toEqual(HELLO.param_deltas)   // 全 0 键原样带回来
    expect(d.reply).toBe('你好，照片有什么想调的吗？')
  })

  it('`param_deltas` 没写 / 明说 null 都算"没有要改的" —— 不许误伤', () => {
    const absent = parseDecision({ route: 'params', reply: '你好呀' }, '你好')
    expect(absent.route).toBe('params')
    expect(absent.degraded).toBe(false)
    expect(absent.reply).toBe('你好呀')
    const explicitNull = parseDecision({ route: 'params', param_deltas: null, reply: '你好呀' }, '你好')
    expect(explicitNull.route).toBe('params')
    expect(explicitNull.degraded).toBe(false)
  })

  it('对照：键名是它自己编的（brightness:99999）→ 仍然降级 —— 那是丢了内容，不是 no-op', () => {
    // ⚠️ 和 route.test.ts「不听话的假模型」那条共用同一个形状，两边都钉着它。
    // 变异：把 `!droppedParams` 从 cleanNoop 里去掉 → 这条红（route 停在 params、
    // editPrompt 不见了）。
    const d = parseDecision(
      { route: 'params', paramDeltas: { brightness: 99999 }, reply: '好' }, '亮一点')
    expect(d.route).toBe('generate')
    expect(d.editPrompt).toBe('亮一点')
    expect(d.degraded).toBe(true)
  })

  it('对照：编了键名的值"像内容"（`"30"` / 对象）→ 仍然降级（说了要改、我们没接住）', () => {
    // 2026-10-06 评审 Minor：`"30"` 能当数看、对象里明摆着有东西 —— 都不是"没提"。
    // 变异：把 hasDroppedParams 未知键那一支里"字符串 / 对象"两条判据去掉 → 这条红。
    for (const v of ['30', { value: 30 }] as const) {
      const d = parseDecision(
        { route: 'params', paramDeltas: { brightness: v }, reply: '好' },
        '亮一点')
      expect(d.route, JSON.stringify(v)).toBe('generate')
      expect(d.editPrompt, JSON.stringify(v)).toBe('亮一点')
    }
  })

  it('对照：认得的键、值接不住（exposure:"30"）→ 仍然降级（写了要改，normalizeDeltas 丢了它）', () => {
    const d = parseDecision(
      { route: 'params', param_deltas: { exposure: '30' }, reply: '好的，给你调亮' }, '亮一点')
    expect(d.route).toBe('generate')
    expect(d.editPrompt).toBe('亮一点')
  })

  it('对照：整块参数形状烂（数组）→ 仍然降级（"说了、没接住" ≠ 没说）', () => {
    const d = parseDecision(
      { route: 'params', param_deltas: [30], reply: '好的' }, '亮一点')
    expect(d.route).toBe('generate')
    expect(d.editPrompt).toBe('亮一点')
  })

  it('对照：route 不在枚举里（"ask"）→ 仍然降级（实测出现过）', () => {
    // ⚠️ route **推断出来**的 'params' 不算"它说不用改" —— cleanNoop 里那个
    // `routeIsValid` 就为这一格：只看 `route === 'params'` 的话，枚举外的垃圾
    // （inferRoute 兜到 params）会被当 no-op 放行。
    const d = parseDecision({ route: 'ask', reply: '嗯' }, '亮一点')
    expect(d.route).toBe('generate')
    expect(d.editPrompt).toBe('亮一点')
    expect(d.degraded).toBe(true)
  })

  it('对照：连 reply 都没给的空壳 → 仍然降级（"说得清清楚楚"必须真说了话）', () => {
    // 空壳渲染给用户的那句是我们自己的兜底文案（「…先按你说的试了一下。」），
    // 而这一路什么都没试 —— 是句假话；维持旧降级（那条路是真的试了）。
    // 变异：把 `hasModelReply` 从 cleanNoop 里去掉 → 这条红。
    const d = parseDecision({ route: 'params', param_deltas: {} }, '亮一点')
    expect(d.route).toBe('generate')
    expect(d.editPrompt).toBe('亮一点')
  })

  it('★（取舍记录）模型自己说了句"已经帮你调亮了"、却一个改动都没给 —— 以它说的为准，不花钱兜底', () => {
    // ⚠️ 这条钉的是**明知而选的取舍**（2026-10-06 评审裁定），**不是 bug** ——
    // 别"修"回付费生成：判据上分不出"它其实想改、只是没给改动"（那要读 reply 的语义），
    // 只能以模型自述为准。代价照实说：这种形状旧代码是真的试了一次（花钱），
    // 现在安静地什么都不做，靠就是模型自己那句话撑场面。
    const d = parseDecision(
      { route: 'params', param_deltas: {}, reply: '好的，已经帮你调亮了' }, '调亮一点')
    expect(d.route).toBe('params')     // 不走 generate —— 这是取舍本身
    expect(d.paramDeltas).toEqual({})
    expect(d.degraded).toBe(false)
  })
})
