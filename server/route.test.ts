import { describe, it, expect, vi } from 'vitest'
import { handleRoute } from './route.ts'
import { SenseNovaClient } from './sn.ts'
import { SerialQueue } from './queue.ts'
import { ROUTER_SYSTEM } from './prompt.ts'
import { fallbackDecision } from './validate.ts'
import { ZERO } from '../shared/adjustments.ts'
import type { Config } from './config.ts'

const cfg: Config = {
  // ★ 2026-10-03：两条通道分开之后各有自己的默认连接（chat 走 Agnes、image 走商汤）。
  //   这个文件走的是**chat 那一路**，所以看的是 `cfg.chat`。
  chat: { apiKey: 'sk-test', baseUrl: 'https://x.cn/v1', model: 'v' },
  image: { apiKey: 'sk-img', baseUrl: 'https://img.example.cn/v1', model: 'm' },
  port: 0,
  dbPath: ':memory:',
  // 这两个是 Config 上的必填字段（起服务要它），这个文件既不碰账号也不碰图
  photoDir: 'unused',
  lutDir: 'unused',
  sessionSecret: 'test-secret',
}

// sn.ts 收窄之后，客户端吃的是「一条连接 + 一个模型名」，不再是整份 Config（Task 6）。
// cfg 本身照旧按 Config 用，这里只是把这一条连接显式拼出来 —— 走的是 chat 那一路。
const conn = { apiKey: cfg.chat.apiKey, baseUrl: cfg.chat.baseUrl, modelId: cfg.chat.model }

const IMG = 'data:image/jpeg;base64,AAAA'
const body = { imageDataUrl: IMG, text: '天太灰了', params: ZERO }

function clientReplying(content: string | null, status = 200) {
  const calls: any[] = []
  const impl = (async (_u: any, init: any) => {
    calls.push(JSON.parse(init.body))
    if (status !== 200) return new Response('{"error":{"message":"x"}}', { status })
    return new Response(JSON.stringify({ choices: [{ message: { content } }] }),
      { status: 200, headers: { 'content-type': 'application/json' } })
  }) as unknown as typeof fetch
  return { client: new SenseNovaClient(conn, impl), calls }
}

const deps = (client: SenseNovaClient) => ({ client, queue: new SerialQueue({ sleep: async () => {} }) })

describe('handleRoute', () => {
  it('把模型的 JSON 解成决策', async () => {
    const { client, calls } = clientReplying(JSON.stringify({
      route: 'params', param_deltas: { exposure: 25 },
      reply: '亮了点。', edit_prompt: '', needs_disambiguation: false,
    }))
    const res = await handleRoute(body, deps(client))
    expect(res.decision.route).toBe('params')
    expect(res.decision.paramDeltas).toEqual({ exposure: 25 })
    expect(res.decision.degraded).toBe(false)

    // 请求里带了图、用户的话、当前参数，且系统提示是 ROUTER_SYSTEM
    const sent = calls[0]
    expect(sent.model).toBe('v')
    const userParts = sent.messages[1].content
    expect(userParts[0].image_url.url).toBe(IMG)
    expect(userParts[1].text).toContain('天太灰了')
    // 必须**钉住整句**：`toContain('param_deltas')` 那种弱断言区分不出
    // ROUTER_SYSTEM 和 SUGGEST_SYSTEM——后者也含这个词（实测：把系统提示
    // 换成 SUGGEST_SYSTEM，弱断言照样绿）。
    expect(sent.messages[0].content).toBe(ROUTER_SYSTEM)
  })

  it('degraded 时把模型的原始输出打出来 —— 这个信号原来算完就扔，bug 就是这么藏住的', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      // 2026-09-29 实测原样：声明 params、deltas 也给对了，只是啰嗦地又写了一遍 edit_prompt。
      const { client } = clientReplying(JSON.stringify({
        route: 'params',
        param_deltas: { exposure: 40 },
        reply: '好的，给你调亮一些',
        edit_prompt: 'Increase overall brightness by raising exposure by 40',
        needs_disambiguation: false,
      }))
      const res = await handleRoute(body, deps(client))
      expect(res.decision.degraded).toBe(true)

      const said = warn.mock.calls.map(c => c.map(String).join(' ')).join('\n')
      expect(said).toContain('degraded')
      // **原始输出必须留下来。** 只写"降级了"等于没写：这个 bug 之所以藏了几天，
      // 就是因为 `degraded` 算完就扔，谁也不知道模型到底吐了什么。
      // 有了原文，"声明 params 却又写 edit_prompt"这个形状一眼看得出来。
      expect(said).toContain('Increase overall brightness')
    } finally {
      warn.mockRestore()
    }
  })

  it('LLM 抛错时返回降级决策，不是 500', async () => {
    const { client } = clientReplying(null, 500)
    const res = await handleRoute(body, deps(client))
    expect(res.decision.degraded).toBe(true)
    expect(res.decision.route).toBe('generate')
    expect(res.decision.editPrompt).toBe('天太灰了')
  })

  // 名字与断言都改准了：模型吐垃圾时，parseDecision 的内部收敛和 handleRoute
  // 的 catch **都会**给出 degraded: true，所以单看 degraded 区分不出两条降级路径
  // （实测：把 parseDecision(content) 换成 parseDecision(JSON.parse(content))，
  // 弱版本照样绿）。
  //
  // 原来这条靠"两条路径的 editPrompt 不同"来区分二者（走 catch 是用户原话，
  // 走容错解析器是模型原文）。**那个区分力本来就不该存在**：spec §4.7 要求
  // 降级时一律用用户原话当 prompt，两条路径收敛到同一个结果才是对的。
  // 旧实现把模型吐出来的那坨东西（实测是一段被截断的 JSON）当编辑指令送进
  // 图像模型，把背景里的人换成了一个写实的陌生男人——用户看到莫名其妙的改动。
  /**
   * ★ 用户原话那条需求的另一半（「用户自己接入模型接不通给他提示不就好了」）。
   *
   * Task 10 让 `/api/edit` 那条路会说了；这条路原来还闷着 —— catch 把**所有**
   * SnError 都吞进降级，于是**对话的钥匙填错了**：用户说一句话 → 路由静默失败 →
   * 原文直接走一次付费生成 → 用户永远不知道自己的钥匙是坏的，**每说一句白花一次**。
   *
   * §4.7 那条规矩不变（路由失败不能让用户看见报错），只是"钥匙根本不对"这件事
   * 不该再瞒着：`reply` 本来就会显示给用户，改的是**它说的话**。
   */
  it('★ 对话键被上游拒（401）→ 回复说出真话（钥匙），不再是那句与原因无关的兜底', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const { client } = clientReplying(null, 401)
      const res = await handleRoute(body, deps(client))

      // 真话：说的就是这次失败的真正原因
      expect(res.decision.reply).toContain('钥匙')
      expect(res.decision.reply).toContain('检查一下')
      // ⚠️ 这句是**唯一**该换掉的一句：绝不能把"我没看明白"当成原因 ——
      //   它根本没机会看（请求被上游挡在门外了）。
      expect(res.decision.reply).not.toBe(fallbackDecision(body.text).reply)

      // 降级本身一个字都没变（§4.7）：照样是"原文当 prompt 走生成"
      expect(res.decision.route).toBe('generate')
      expect(res.decision.editPrompt).toBe('天太灰了')
      expect(res.decision.degraded).toBe(true)
    } finally {
      warn.mockRestore()
    }
  })

  /**
   * ★ 上一条的**反面**，也是"范围守住了"的证据。
   *
   * 只改钥匙被拒这一种。超时 / 限流 / 格式烂仍然是原来那句 ——
   * 那些失败里"我们没读懂"或者"上游没空"才是真的，而且 §4.7 明说
   * **路由失败不能让用户看见报错**，别顺手把这条规矩拆了。
   *
   * 变异：把 route.ts 里那个 `e.code === 'UPSTREAM_AUTH'` 的判据去掉
   * （变成"凡是 SnError 都说钥匙"）→ 这条红。
   */
  it('★ 限流（429）时仍然是原来那句降级文案 —— 只认钥匙被拒，别的一律不碰', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const { client } = clientReplying(null, 429)
      const res = await handleRoute(body, deps(client))

      expect(res.decision.reply).toBe('我直接按你说的试了一下。')
      // 降级那三件照旧，一个字都没动
      expect(res.decision.route).toBe('generate')
      expect(res.decision.editPrompt).toBe('天太灰了')
    } finally {
      warn.mockRestore()
    }
  })

  it('模型吐垃圾时，走的是降级且 prompt 是用户原话（不是模型吐的垃圾）', async () => {
    // 这条在**旧代码下必红**：旧实现把模型的原始输出当 prompt 送进了图像模型。
    const { client } = clientReplying('这不是 JSON')
    const res = await handleRoute({ ...body, text: '天太灰了' }, deps(client))
    expect(res.decision.degraded).toBe(true)
    expect(res.decision.editPrompt).toBe('天太灰了')
  })

  it('缺 text 抛 BAD_REQUEST', async () => {
    const { client } = clientReplying('{}')
    await expect(handleRoute({ ...body, text: '' }, deps(client))).rejects.toMatchObject({ code: 'BAD_REQUEST' })
    await expect(handleRoute({ ...body, text: '   ' }, deps(client))).rejects.toMatchObject({ code: 'BAD_REQUEST' })
  })

  it('缺图抛 BAD_REQUEST', async () => {
    const { client } = clientReplying('{}')
    await expect(handleRoute({ ...body, imageDataUrl: '' }, deps(client))).rejects.toMatchObject({ code: 'BAD_REQUEST' })
  })

  it('图不是 data URL 就拒掉 —— 别把任意字符串当图送上去', async () => {
    const { client } = clientReplying('{}')
    await expect(handleRoute({ ...body, imageDataUrl: 'https://example.com/x.jpg' }, deps(client)))
      .rejects.toMatchObject({ code: 'BAD_REQUEST' })
  })

  it('超长输入被截断，不是原样送给模型', async () => {
    const { client, calls } = clientReplying('{"route":"params","param_deltas":{"exposure":5}}')
    await handleRoute({ ...body, text: '啊'.repeat(3000) }, deps(client))
    const text: string = calls[0].messages[1].content[1].text
    // 钉住的是"截断到 MAX_USER_TEXT 个字符"这件事本身，而不只是"比原来短"——
    // `toBeLessThan(3000)` 那种写法在 MAX_USER_TEXT 被改成 2500 时照样绿。
    expect(text).toContain('啊'.repeat(500))
    expect(text).not.toContain('啊'.repeat(501))
  })

  /**
   * ★ §7.2「骨架必须接得住零件抖」。
   *
   * 用户可能接一个很便宜、很笨的模型。真模型今天听话，
   * **不代表用户接的那个听话** —— 而产品不能因为换个模型就崩。
   *
   * 每一条断言的是三件事：
   *   一、不抛（handleRoute 照样回一个决策）；
   *   二、★ **明说是降级**（degraded）—— 不能假装那是模型的本意（§4.7 那次教训）；
   *   三、降级之后仍然是一条**走得通的路**：原文当 prompt 走生成，不是"什么也没发生"。
   */
  describe('★ 不听话的假模型（§7.2）', () => {
    const CASES = [
      ['回垃圾', '嗯嗯这个照片挺好的呀，蓝天白云真好看～'],
      ['回一半', '{"route":"params","paramDeltas":{"bright'],
      ['回错格式', '<route>params</route><params>{"brightness":20}</params>'],
      ['回空', ''],
      ['回个数组', '[{"route":"generate"}]'],
      // ⚠️ 这条原来叫「字段全对但值离谱」——**名不副实**（Task 10 审查发现）。
      // `brightness` **不是**那八个合法键之一，它变红靠的是"整块 delta 被
      // normalizeDeltas 丢掉"，**不是**"值被钳制"。真·钳制见下面那条单独用例。
      // 名字要描述它真正在测的东西：模型自己编了一个键名。
      ['键名是它自己编的', '{"route":"params","paramDeltas":{"brightness":99999},"reply":"好"}'],
    ] as const

    for (const [name, output] of CASES) {
      it(`${name} → 不崩，而且降级说得明明白白`, async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
        try {
          const { client } = clientReplying(output)
          const r = await handleRoute(body, deps(client))
          // 一、不抛
          expect(r.decision).toBeTruthy()
          // 二、★ 必须**明说是降级**（degraded），不能假装那是模型的本意
          //     —— 09-29 那个"同一件事做两遍"的 bug 就是因为这个信号没人看（§4.7）
          expect(r.decision.degraded).toBe(true)
          // 三、降级之后仍然是一条**能走的路**：原文当 prompt 走生成
          expect(r.decision.route).toBe('generate')
          expect(r.decision.editPrompt).toBe('天太灰了')
        } finally {
          warn.mockRestore()
        }
      })
    }

    /**
     * ★ 真·值钳制的那一条（上面「键名是它自己编的」的对偶）。
     *
     * 上面那条变红靠的是"整块 delta 被丢"，跟钳制**没有关系**；这条才是
     * "模型给的键都对、只是值离谱"那个形状的**端到端**证据。
     * 钳制本身钉在 `server/validate.test.ts`（normalizeDeltas 那一组），
     * 这里要的是它一路穿过 handleRoute 之后**真的到了上游**。
     *
     * 变异：把 `normalizeDeltas` 里那个 `Math.max(PARAM_MIN, Math.min(PARAM_MAX, ...))`
     * 去掉 → 这里看到的是 99999，红。
     */
    it('★ 值离谱（exposure:99999）→ 钳到 100，而且是模型老实答的（degraded=false）', async () => {
      const { client } = clientReplying(
        '{"route":"params","paramDeltas":{"exposure":99999},"reply":"好"}')
      const r = await handleRoute(body, deps(client))

      expect(r.decision.route).toBe('params')
      expect(r.decision.paramDeltas.exposure).toBe(100)
      // 这条**必须**是 false：钳制是我们规整模型的输出，不是"没读懂它" ——
      // 把这一格混成降级的话，前端会走生成那条花钱的路（§7.2 的整个意义）。
      expect(r.decision.degraded).toBe(false)
    })

    it('★ 降级的日志里带原始输出 —— 只写"降级了"查不出模型到底吐了什么', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      try {
        const { client } = clientReplying('{"route":"params","paramDeltas":{"bright')
        await handleRoute(body, deps(client))
        const said = warn.mock.calls.map(c => c.map(String).join(' ')).join('\n')
        expect(said).toContain('degraded')
        // 原文必须留下来：只写"降级了"等于没写 —— 模型到底吐了什么，
        // 是靠这一句查出来的（§4.7 那个 bug 藏了几天就是因为没留原文）。
        expect(said).toContain('paramDeltas')
      } finally {
        warn.mockRestore()
      }
    })
  })

  it('params 字段缺失或不是对象时按全零处理，是对象时走钳制', async () => {
    // 这条原来只有两个 `resolves.toBeTruthy()`——而 handleRoute 在任何情况下
    // 都返回对象，所以那两个断言对它们命名的事**恒真**（变异探针实测：把
    // normalizeParams 换成 `return v as Adjustments`，两行照样绿）。
    // 改成断言**真正发出去的内容**。
    const { client, calls } = clientReplying('{"route":"params","param_deltas":{"exposure":5}}')

    await handleRoute({ imageDataUrl: IMG, text: '亮一点' }, deps(client))
    expect(calls[0].messages[1].content[1].text).toContain('用户当前未做任何调整')

    await handleRoute({ ...body, params: 'nope' }, deps(client))
    expect(calls[1].messages[1].content[1].text).toContain('用户当前未做任何调整')

    // 关键的一条：上游收到的必须是**钳到 100 之后**的值。
    // normalizeParams 若被改成原样透传，这里会看到 +999。
    await handleRoute({ ...body, params: { exposure: 999 } }, deps(client))
    expect(calls[2].messages[1].content[1].text).toContain('亮度 +100')
  })

  /**
   * ★ Task 11（2026-10-05）：说话那条路认滤镜 —— 清单进提示词、模型给的名字对号。
   *
   * 三条各守一个静默失效点：清单没裁（模型拿到几百条/空名字）、清单没上路
   * （模型根本不知道用户导过什么）、名单没传给 parseDecision（模型答对了也白答）。
   */
  it('★ 清单进用户消息：名字按规矩裁（trim / 30 字 / 丢空名与坏 id / 最多 30 条）', async () => {
    const { client, calls } = clientReplying('{"route":"params","param_deltas":{"exposure":5}}')
    await handleRoute({
      ...body,
      luts: [
        { id: 1, name: '  黄昏  ' },                 // 首尾空格：服务端裁掉
        { id: 2, name: '' },                         // 空名字：丢掉
        { id: 3, name: 'x'.repeat(40) },             // 超 30 字：截断
        { id: 0, name: '坏 id' },                    // id 不是正整数：丢掉
        { id: 4.5, name: '小数 id' },                // 同上
        { id: 5, name: '黑白' },
        ...Array.from({ length: 34 }, (_, i) => ({ id: 100 + i, name: `滤镜${i}` })),
      ],
    }, deps(client))

    const sent: string = calls[0].messages[1].content[1].text
    expect(sent).toContain('用户导入的滤镜有：黄昏、')
    expect(sent).toContain('x'.repeat(30))
    expect(sent).not.toContain('x'.repeat(31))     // 截到 30 字，不是原样透传
    expect(sent).not.toContain('坏 id')
    expect(sent).not.toContain('小数 id')
    // 最多 30 条：裁完剩 37 条（黄昏 / x… / 黑白 / 滤镜0…33），第 31 条起不许出现
    // （滤镜26 是第 30 条、滤镜27 是第 31 条 —— 边界钉在名字上，不数逗号）
    expect(sent).toContain('滤镜26')
    expect(sent).not.toContain('滤镜27')
  })

  it('★ 当前用的那个滤镜进用户消息；形状不对的一律当"没有滤镜"', async () => {
    // 只给名字不够：模型还得知道用户**已经**套着哪个（和 describeParams 同一条
    // 理由 —— 不告诉它，它会按"还没套"来写回复）。`body.lut` 要过 `normalizeLutRef`：
    // 坏形状（id 不是正整数）清成"没有"，不许原样写进提示词。
    const { client, calls } = clientReplying('{"route":"params","param_deltas":{"exposure":5}}')
    const luts = [{ id: 1, name: '黄昏' }]
    await handleRoute({ ...body, luts, lut: { lutId: 1, amount: 80 } }, deps(client))
    expect(calls[0].messages[1].content[1].text).toContain('用户当前已用滤镜：黄昏（强度 80）。')

    await handleRoute({ ...body, luts, lut: { lutId: 0, amount: 80 } }, deps(client))
    expect(calls[1].messages[1].content[1].text).not.toContain('用户当前已用滤镜')

    await handleRoute({ ...body, luts, lut: 'nope' }, deps(client))
    expect(calls[2].messages[1].content[1].text).not.toContain('用户当前已用滤镜')
  })

  it('★ 模型回的名字在清单里 → 决策带上它（端到端）；清单外的名字 → null + degraded', async () => {
    const { client } = clientReplying(JSON.stringify({
      route: 'params', lut: { name: ' 黄昏 ' }, reply: '好。',
    }))
    const r = await handleRoute({ ...body, luts: [{ id: 1, name: '黄昏' }] }, deps(client))
    expect(r.decision.lut).toEqual({ name: '黄昏', amount: 100 })

    // 模型给了个我们没有的东西：归 null（= 不动），degraded 把信号留下。
    // ⚠️ warn 要静音：这条会走 §4.7 的降级，handleRoute 会打一行原始输出。
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const { client: c2 } = clientReplying(JSON.stringify({
        route: 'params', lut: { name: '青橙' }, reply: '好。',
      }))
      const r2 = await handleRoute({ ...body, luts: [{ id: 1, name: '黄昏' }] }, deps(c2))
      expect(r2.decision.lut).toBeNull()
      expect(r2.decision.degraded).toBe(true)
    } finally {
      warn.mockRestore()
    }
  })

  /**
   * ★ 2026-10-10：「我的预设」那条路 —— 和滤镜**完全平行**（清单上去、只回名字）。
   *
   * 三条各守一个静默失效点：清单没裁（模型拿到几百条 / 空名字）、`params` 没钳
   * （模型拿到伪造的离谱数字）、名单没传给 `parseDecision`（模型答对了也白答）。
   */
  it('★ 预设清单进用户消息：名字 trim / 截 30 字 / 丢空名，params 收的是钳过的值', async () => {
    const { client, calls } = clientReplying('{"route":"params","param_deltas":{"exposure":5}}')
    await handleRoute({
      ...body,
      presets: [
        { name: '  黄昏旅拍  ', params: { exposure: 999, contrast: 12 } },  // trim + params 钳制
        { name: '', params: { exposure: 30 } },                             // 空名字：丢掉
        { name: 'x'.repeat(40), params: {} },                               // 超 30 字：截断
      ],
    }, deps(client))

    const sent: string = calls[0].messages[1].content[1].text
    expect(sent).toContain('用户保存的调色预设有：')
    // params 是**钳过之后**的：伪造的 999 到模型手里必须是 100（同 normalizeParams 那条）。
    expect(sent).toContain('「黄昏旅拍」= {亮度 +100, 对比度 +12}')
    expect(sent).toContain('x'.repeat(30))
    expect(sent).not.toContain('x'.repeat(31))     // 截到 30 字，不是原样透传
    // 空名字是**整条丢掉**，不留一格「」占位（把 route.ts 的 `if (!name) continue`
    // 删掉这条就红 —— 标题里"丢空名"三个字得有断言兜着）。
    expect(sent).not.toContain('「」')
  })

  it('★ 40 套 → 发给模型的只有 30 套（不是 30 就红）', async () => {
    // 设计 §6.1：条数上限 30 的截断在**服务端**做 —— 请求可以伪造，前端的截不算数。
    // 30 这个数来自 `MAX_PRESETS`（和存储上限同一个常量）。
    const { client, calls } = clientReplying('{"route":"params","param_deltas":{"exposure":5}}')
    await handleRoute({
      ...body,
      presets: Array.from({ length: 40 }, (_, i) => ({
        name: `套装${String(i + 1).padStart(2, '0')}`, params: {},
      })),
    }, deps(client))

    const sent: string = calls[0].messages[1].content[1].text
    // 边界钉在名字上（不数逗号）：第 30 套在、第 31 套起不许出现
    expect(sent).toContain('套装30')
    expect(sent).not.toContain('套装31')
  })

  it('★ 模型回的预设名在清单里 → 决策带上它（端到端）；清单外的名字 → null + degraded', async () => {
    const presets = [{ name: '黄昏旅拍', params: { ...ZERO, contrast: 12 } }]

    const { client } = clientReplying(JSON.stringify({
      route: 'params', preset: { name: ' 黄昏旅拍 ' }, reply: '好。',
    }))
    const r = await handleRoute({ ...body, presets }, deps(client))
    // 回的是**清单里的原名**（空格被 trim 掉）
    expect(r.decision.preset).toEqual({ name: '黄昏旅拍' })
    expect(r.decision.degraded).toBe(false)

    // 模型给了个用户没有的东西：归 null（= 不动），degraded 把信号留下。
    // ⚠️ warn 要静音：这条会打降级那行原始输出。
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const { client: c2 } = clientReplying(JSON.stringify({
        route: 'params', preset: { name: '青橙' }, reply: '好。',
      }))
      const r2 = await handleRoute({ ...body, presets }, deps(c2))
      expect(r2.decision.preset).toBeNull()
      expect(r2.decision.degraded).toBe(true)
    } finally {
      warn.mockRestore()
    }
  })
})
