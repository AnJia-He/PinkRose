import { PARAM_KEYS, PARAM_MIN, PARAM_MAX } from '../shared/adjustments.ts'
import type { ParamDeltas, Route, RouteDecision } from '../shared/protocol.ts'

const ROUTES: readonly Route[] = ['params', 'generate', 'both']

/** 降级时 prompt 的字符上限。 */
const FALLBACK_PROMPT_MAX = 200

const FALLBACK_REPLY = '我没太看明白，先按你说的试了一下。'

/**
 * 需要"点一下澄清"那条路上的兜底 —— **不能**用上面那句。
 *
 * ★ 2026-10-04 修（spec `2026-09-24-accounts-and-gallery-design.md` 第 1275 行
 *   早就写下了这个毛病和补法，一直没动）：那一支是**先问再做** —— 生成被拦下、
 *   参数也没动，"先按你说的试了一下"是**假话**；而且它会紧挨着界面下一句
 *   「在图上点一下要改的地方？」出现，两句连着读互相打架。
 * ⚠️ 上面那句**一个字都不许改**：§4.7 的降级那条路正在用它（那条路是真的试了）。
 */
const FALLBACK_REPLY_ASK = '我没太看明白。'

export function inferRoute(hasParams: boolean, hasEdit: boolean): Route {
  if (hasParams && hasEdit) return 'both'
  if (hasEdit) return 'generate'
  // 都没有也走 params：那是零成本、可逆的一条路。
  // 走生成会花掉 12,900 tokens 去执行一个我们没读懂的需求。
  return 'params'
}

/**
 * 把模型给的增量规整成可信的 ParamDeltas。
 *
 * 四件事：只留合法键、丢掉非有限值、取整、钳到 [-100,100]。
 * 外加一条启发式——见下面 hasUnitScaleMistake。
 */
export function normalizeDeltas(v: unknown): ParamDeltas {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return {}
  const src = v as Record<string, unknown>
  const raw: Record<string, number> = {}
  for (const k of PARAM_KEYS) {
    const x = src[k]
    if (typeof x !== 'number' || !Number.isFinite(x)) continue
    raw[k] = x
  }

  // 量纲纠正。实测：prompt 里没写死范围时，kimi-k3 会输出 0.4 / 0.05
  // 这类值——它自己把量纲当成了 [-1, 1]。
  //
  // 判据故意保守：**所有非零值的绝对值都 <= 1**。真实的 [-100,100] 增量
  // 不可能全部落在 ±1 里，所以这个条件下几乎必然是量纲错，而不是
  // "用户真的只想微调 0.4 个单位"（0.4 个单位在 100 分制里没有意义）。
  const nonZero = Object.values(raw).filter(x => x !== 0)
  const unitMistake = nonZero.length > 0 && nonZero.every(x => Math.abs(x) <= 1)

  const out: ParamDeltas = {}
  for (const [k, x] of Object.entries(raw)) {
    const scaled = unitMistake ? x * 100 : x
    out[k as keyof ParamDeltas] = Math.max(PARAM_MIN, Math.min(PARAM_MAX, Math.round(scaled)))
  }
  return out
}

/**
 * 从模型的原始输出解出决策。**永远不抛错**——所有异常路径都收敛成
 * 一个可用的 RouteDecision。调用方不需要 try/catch。
 */
export function parseDecision(raw: unknown, userText = ''): RouteDecision {
  const obj = coerceToObject(raw)
  // 解析不了时**用用户的原话**当 prompt，绝不能用模型吐出来的那坨东西。
  // 实测过后果：模型返回被截断的 JSON，降级分支拿它当编辑指令送进图像模型，
  // 结果把背景里的人换成了一个写实的陌生男人——用户看到的是莫名其妙的改动。
  // 第二参数可选：不传时退回旧行为，Task 4 的既有测试因此保持不变。
  if (!obj) return fallbackDecision(userText || (typeof raw === 'string' ? raw : ''))

  const paramDeltas = normalizeDeltas(obj.param_deltas ?? obj.paramDeltas)
  // 只看"有没有真正要动的参数"。
  // 原来这里还有个 `|| Object.keys(paramDeltas).length > 0`，是**死分支**：
  // 有任何非零值必然就有键，后一个条件完全覆盖前一个。而它会改变行为——
  // {route:'params', param_deltas:{exposure:0}, edit_prompt:'...'} 会因为
  // hasParams 被误判成 true 而让 reconcile 不触发，于是一句**非空的**
  // edit_prompt 被静默丢掉，degraded 还停在 false。
  const hasParams = Object.values(paramDeltas).some(v => v !== 0)

  const editPrompt = typeof obj.edit_prompt === 'string' ? obj.edit_prompt.trim()
    : typeof obj.editPrompt === 'string' ? obj.editPrompt.trim()
    : ''
  const hasEdit = editPrompt.length > 0

  const rawRoute = obj.route
  const routeIsValid = typeof rawRoute === 'string' && (ROUTES as readonly string[]).includes(rawRoute)
  const route = routeIsValid ? (rawRoute as Route) : inferRoute(hasParams, hasEdit)

  // 先算它，因为兜底文案要按它分岔（见 FALLBACK_REPLY_ASK 那段）
  const needsDisambiguation = obj.needs_disambiguation === true || obj.needsDisambiguation === true
  const reply = typeof obj.reply === 'string' && obj.reply.trim()
    ? obj.reply.trim()
    : (needsDisambiguation ? FALLBACK_REPLY_ASK : FALLBACK_REPLY)

  // degraded 的语义是"这次的结果不是模型老实给的"：
  //   - route 不在枚举里（实测出现过 "ask"），说明它没守格式
  //   - 或者根本没有可用的 edit_prompt 却要生成（那是在硬凑）
  //   - 声明 params 却又写了 edit_prompt：那半我们**不采纳**（见 reconcile），
  //     丢掉过模型写的东西就得留信号，否则这类啰嗦会一直看不见
  const degraded = !routeIsValid ||
    ((route === 'generate' || route === 'both') && !hasEdit) ||
    (route === 'params' && !hasParams) ||
    (route === 'params' && hasEdit)

  // 声明的路由和实际内容对不上时，以**内容**为准：
  // 说 params 却给了 edit_prompt 却没有 deltas，那就是一次生成。
  const effectiveRoute = reconcile(route, hasParams, hasEdit)

  // ★ §7.2（2026-09-30）：「模型吐出来的东西**一件也用不上**」时，别停在这儿 —— 走 §4.7 的降级。
  //
  // 走到这一格的形状是"解出了一个对象，但里面没有一件能用的东西"：route 不在枚举里、
  // 参数被 normalizeDeltas 全丢掉、也没有 edit_prompt。实测的两个：
  //   `<route>params</route><params>{"brightness":20}</params>`  —— 回错格式
  //   `{"route":"params","paramDeltas":{"brightness":99999}}`     —— 键名是它自己编的
  // 两样都说明**我们没读懂它这次输出** —— 那和上面"根本解析不出对象"是同一种失败，
  // 就该走同一条路（用用户的原话，而不是模型吐的那坨东西）。
  //
  // 不这么做会怎样（上面两条实测）：决策停在 route='params' + 空 deltas → 前端
  // 一个滑块都不动、一次生成都不发，用户等来的是模型自己那句「好」或兜底那句
  // 「先按你说的试了一下」—— **什么都没做，还说了句假话**。降级至少真的试了一次。
  //
  // ⚠️ `userText` 为空时**保持原样**（既有测试钉着的旧行为，别顺手改掉）：
  // §4.7 的降级就是"拿用户的原话去试"，没有原话就没有可试的东西 ——
  // `fallbackDecision('')` 给的 prompt 是空的，前端 runGenerate 第一行就 return，纯空转。
  // 两种结局都是"什么都没发生"，那就照旧留给零成本、可逆的那条路，只把 degraded 打出来。
  //
  // ⚠️ 模型自己说"我不确定你指的是哪一个"时也不动：前端那一支是**先问再做**，
  // 换成一次生成等于一边问一边花钱（理由写在 App.tsx 的 applyDecision 里）。
  if (!hasParams && !hasEdit && !needsDisambiguation && userText) return fallbackDecision(userText)

  return {
    route: effectiveRoute,
    paramDeltas,
    reply,
    // 走 params 时前端**根本不会读** editPrompt（App.tsx 只在 generate/both 时调
    // runGenerate）。留着它是个雷：下一个人看到响应里有个非空 prompt，会以为
    // "有半句没被用上"，然后把它接回去 —— 那正是今天修掉的那个 bug。
    // 不采纳就清空，让"route=params ⟹ editPrompt 是空的"成为一条读得出来的规矩。
    editPrompt: effectiveRoute === 'generate' || effectiveRoute === 'both' ? editPrompt : '',
    needsDisambiguation,
    degraded: degraded || effectiveRoute !== route,
  }
}

/** 声明与内容冲突时以内容为准，避免把一次真实的生成请求吞掉。 */
function reconcile(route: Route, hasParams: boolean, hasEdit: boolean): Route {
  if (route === 'params' && !hasParams && hasEdit) return 'generate'
  if (route === 'generate' && !hasEdit && hasParams) return 'params'
  // 'both' 但没有 edit_prompt 时降成 params：剩下的只有调色那一半。
  // 留在 'both' 会让前端去跑一次空的生成（runGenerate 第一行就 return），
  // 等于决策声称"要生成"却什么都没发生。degraded 已经为 true，不丢信号。
  if (route === 'both' && !hasEdit && hasParams) return 'params'
  // ⚠️ **声明 params 且真给了 deltas → 就听它的，别因为多出一个 edit_prompt 升成 both。**
  //
  // 2026-09-29 实测：模型对纯调色请求给的是
  //   {"route":"params","param_deltas":{"exposure":40},
  //    "edit_prompt":"Increase overall brightness by raising exposure by 40, ..."}
  // —— route 说得很对，deltas 也给对了，它只是**啰嗦**，把同一件事用英文又写了一遍。
  // 而下面那条「两半都有 → both」的通用规则判不出"啰嗦"和"第二件事"的区别，一律升成 both。
  //
  // 后果是量过的：同一件事做两遍（本地调一次 + 云端再调一次），一张暖调日落被压成
  // 刺眼的电光蓝，红色通道 81.8 → 50.2（掉 38%），还多花 18.4 秒和一次云端调用 ——
  // 而本地滑块做同一件事只要 423 毫秒、0 次网络。6 条纯调色里 4 条踩这个。
  //
  // 代价（**明知而选**）：万一模型声明 params 却在 edit_prompt 里说了另一件事
  // （比如"去掉后面那个人"），那半句会被丢掉。这个形状实测两轮一次都没出现过 ——
  // 模型真要结构性改动时，route 写的就是 generate。两害相权，选实测常发生的那个。
  // 丢的时候 degraded=true 会留信号，而且 ROUTER_SYSTEM 里现在明写了
  // "走 params 时 edit_prompt 必须是空字符串"。
  if (route === 'params' && hasParams) return 'params'
  // 通用规则：**内容两半都有，那就是 both**，不管模型声明的是哪个。
  //
  // 这一条原来被写成了两条特例分支，于是分两次各漏一条：
  // 先漏"声明 params 但两半都有"，补了"声明 generate 但两半都有"，还是漏。
  // 漏的根源不是粗心，是**把通用规则拆成了特例列表**——补格子的修法本身有问题。
  //
  // 漏掉它的后果：前端只在 route 是 generate/both 时才调 runGenerate，
  // 用户说的那半句会被静默丢掉，而 degraded 还是 false——连"出过问题"的信号都没有。
  if (hasParams && hasEdit) return 'both'
  return route
}

/**
 * 把字符串（可能是 JSON，可能带 ``` 围栏，可能前后有废话）剥成对象。
 * 解析不了返回 null。
 *
 * **suggest.ts 也用这个**——两处都在跟同一个不听话的模型要 JSON，
 * 复制一份等于让同一类解析 bug 有两个地方要修。
 */
export function coerceToObject(raw: unknown): Record<string, unknown> | null {
  if (typeof raw === 'object' && raw !== null && !Array.isArray(raw)) {
    return raw as Record<string, unknown>
  }
  if (typeof raw !== 'string') return null
  let t = raw.trim()
  if (t.startsWith('```')) {
    t = t.replace(/^```[a-zA-Z]*\s*/, '').replace(/```\s*$/, '').trim()
  }
  try {
    const j = JSON.parse(t)
    return typeof j === 'object' && j !== null && !Array.isArray(j) ? j as Record<string, unknown> : null
  } catch {
    // 还有一招：从第一个 { 到最后一个 }。模型常会前后加一句人话。
    const i = t.indexOf('{')
    const k = t.lastIndexOf('}')
    if (i >= 0 && k > i) {
      try {
        const j = JSON.parse(t.slice(i, k + 1))
        return typeof j === 'object' && j !== null && !Array.isArray(j) ? j as Record<string, unknown> : null
      } catch { return null }
    }
    return null
  }
}

/**
 * 降级决策（spec §4.7）：LLM 路由失败时，把用户原话当 prompt 直接走生成，
 * **不给用户看报错**。
 *
 * 注意这条路会花掉约 12,900 tokens。spec 明确要求这么做，本计划照办，
 * 但响应里带 degraded=true 让前端能区分。若上线后观察到额度异常，
 * 第一个该改的就是这里。
 */
export function fallbackDecision(text: string): RouteDecision {
  const editPrompt = text.trim().slice(0, FALLBACK_PROMPT_MAX)
  return {
    route: 'generate',
    paramDeltas: {},
    reply: '我直接按你说的试了一下。',
    editPrompt,
    needsDisambiguation: false,
    degraded: true,
  }
}

export { ROUTES }
