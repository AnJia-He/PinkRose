import { PARAM_KEYS, PARAM_MIN, PARAM_MAX } from '../src/core/adjustments.ts'
import type { ParamDeltas, Route, RouteDecision } from '../shared/protocol.ts'

const ROUTES: readonly Route[] = ['params', 'generate', 'both']

/** 降级时 prompt 的字符上限。 */
const FALLBACK_PROMPT_MAX = 200

const FALLBACK_REPLY = '我没太看明白，先按你说的试了一下。'

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

  const reply = typeof obj.reply === 'string' && obj.reply.trim() ? obj.reply.trim() : FALLBACK_REPLY

  // degraded 的语义是"这次的结果不是模型老实给的"：
  //   - route 不在枚举里（实测出现过 "ask"），说明它没守格式
  //   - 或者根本没有可用的 edit_prompt 却要生成（那是在硬凑）
  const degraded = !routeIsValid ||
    ((route === 'generate' || route === 'both') && !hasEdit) ||
    (route === 'params' && !hasParams)

  // 声明的路由和实际内容对不上时，以**内容**为准：
  // 说 params 却给了 edit_prompt 却没有 deltas，那就是一次生成。
  const effectiveRoute = reconcile(route, hasParams, hasEdit)

  return {
    route: effectiveRoute,
    paramDeltas,
    reply,
    editPrompt,
    needsDisambiguation: obj.needs_disambiguation === true || obj.needsDisambiguation === true,
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
  // 模型的声明与内容冲突时以内容为准。上面三条是前三种组合，
  // 这条是它们的对称项，原来漏了：声明 generate 但又吐了 deltas 且有 edit_prompt，
  // 那就是一次 both（调色 + 生成）。
  // 漏掉它：前端只在 route 是 params/both 时应用 deltas，于是用户说的调色那半句
  // 被静默丢掉，而 degraded 还是 false——连"出过问题"的信号都没有。
  if (route === 'generate' && hasParams && hasEdit) return 'both'
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
