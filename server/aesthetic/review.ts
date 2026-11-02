import type { ParamDeltas, RouteDecision } from '../../shared/protocol.ts'
import type { DirectorAction, DirectorPlan } from './plan.ts'

const SOFT_CUE = /轻一点|轻些|自然一点|自然些|别太重|不要过度|收着点/iu
const STRONG_CUE = /强一点|重一点|明显一点|拉满|最大|狠一点/iu

const SOFT_CAPS = {
  skinSmooth: 20,
  saturation: 16,
  vibrance: 16,
  clarity: 18,
  hdr: 22,
  glow: 20,
  sharpen: 20,
  vignette: 16,
} as const

const DEFAULT_SKIN_SMOOTH_CAP = 35
const DEFAULT_COLOR_TOTAL = 40
const SOFT_COLOR_TOTAL = 28

const FORBIDDEN =
  /(?:Agent|Skill|MCP|Plugin|插件|能力注册表|能力编号|上下文|压缩|摘要|记忆|检索失败|搜索失败|置信度|近似|参数)/iu
const PROMISE = /(?:完美|看不出来|不会被发现|保证一致)/iu

export function reviewDirectorPlan(
  plan: DirectorPlan,
  userText: string,
): { plan: DirectorPlan; blocked: boolean; changed: boolean } {
  if (plan.intent === 'advise') {
    const blocked = plan.actions.length > 0
    return {
      plan: { ...plan, actions: [], degraded: plan.degraded || blocked },
      blocked,
      changed: blocked,
    }
  }

  const strong = STRONG_CUE.test(userText)
  const soft = SOFT_CUE.test(userText)
  let blocked = false
  let changed = false
  let seenGeneration = false
  const actions: DirectorAction[] = []
  for (const action of plan.actions) {
    if (action.capability === 'generation.photo_edit') {
      if (seenGeneration) {
        blocked = true
        continue
      }
      seenGeneration = true
      actions.push(action)
      continue
    }
    if (!('paramDeltas' in action)) {
      actions.push(action)
      continue
    }

    const before = JSON.stringify(action.paramDeltas)
    const paramDeltas = soft
      ? capDeltas(action.paramDeltas, SOFT_CAPS, SOFT_COLOR_TOTAL)
      : strong
        ? action.paramDeltas
        : defaultSafeDeltas(action.paramDeltas)
    if (JSON.stringify(paramDeltas) !== before) changed = true
    actions.push({ ...action, paramDeltas })
  }

  const normalized = capCombinedColor(actions, soft ? SOFT_COLOR_TOTAL : strong ? null : DEFAULT_COLOR_TOTAL)
  if (normalized.changed) changed = true
  return {
    plan: {
      ...plan,
      actions: normalized.actions,
      degraded: plan.degraded || blocked,
    },
    blocked,
    changed,
  }
}

export function guardVisibleReply(
  plan: DirectorPlan,
  decision: RouteDecision,
): { reply: string; blocked: boolean } {
  if (!FORBIDDEN.test(plan.reply) && !PROMISE.test(plan.reply)) {
    return { reply: plan.reply, blocked: false }
  }

  const strength = safeText(plan.assessment.strength, '画面的主次')
  const preserve = safeText(plan.assessment.protect[0], '主体和原来的氛围')
  const direction = safeText(plan.direction.name, '自然')
  const changed = decision.route === 'generate' || decision.route === 'both'
    || decision.preset !== null || decision.lut !== null
    || Object.values(decision.paramDeltas).some((value) => value !== 0)
  const reply = changed
    ? `${strength}先保留；我按${direction}的方向收了一版，${preserve}没有跟着改。`
    : `先不急着大改，${strength}可以保留；从${direction}开始更稳。`
  return { reply, blocked: true }
}

function safeText(value: string | undefined, fallback: string): string {
  const clean = value?.replace(/\s+/g, ' ').trim() ?? ''
  return clean && !FORBIDDEN.test(clean) && !PROMISE.test(clean) ? clean : fallback
}

function capDeltas(
  deltas: ParamDeltas,
  caps: Partial<Record<keyof ParamDeltas, number>>,
  colorTotal: number,
): ParamDeltas {
  const out: ParamDeltas = { ...deltas }
  for (const [rawKey, cap] of Object.entries(caps)) {
    const key = rawKey as keyof ParamDeltas
    const value = out[key]
    if (typeof value !== 'number') continue
    out[key] = Math.max(-cap!, Math.min(cap!, value))
  }
  scalePositiveColor(out, colorTotal)
  return stripZeros(out)
}

function defaultSafeDeltas(deltas: ParamDeltas): ParamDeltas {
  const out: ParamDeltas = { ...deltas }
  if ((out.skinSmooth ?? 0) > DEFAULT_SKIN_SMOOTH_CAP) {
    out.skinSmooth = DEFAULT_SKIN_SMOOTH_CAP
  }
  scalePositiveColor(out, DEFAULT_COLOR_TOTAL)
  return stripZeros(out)
}

function scalePositiveColor(deltas: ParamDeltas, total: number): void {
  const saturation = deltas.saturation ?? 0
  const vibrance = deltas.vibrance ?? 0
  const positive = Math.max(0, saturation) + Math.max(0, vibrance)
  if (positive <= total) return
  const scale = total / positive
  if (saturation > 0) deltas.saturation = Math.round(saturation * scale)
  if (vibrance > 0) deltas.vibrance = Math.round(vibrance * scale)
}

function capCombinedColor(
  actions: readonly DirectorAction[],
  total: number | null,
): { actions: DirectorAction[]; changed: boolean } {
  if (total === null) return { actions: [...actions], changed: false }
  let saturation = 0
  let vibrance = 0
  for (const action of actions) {
    if (!('paramDeltas' in action)) continue
    saturation += Math.max(0, action.paramDeltas.saturation ?? 0)
    vibrance += Math.max(0, action.paramDeltas.vibrance ?? 0)
  }
  const positive = saturation + vibrance
  if (positive <= total) return { actions: [...actions], changed: false }
  const scale = total / positive
  return {
    actions: actions.map((action) => {
      if (!('paramDeltas' in action)) return action
      const paramDeltas: ParamDeltas = { ...action.paramDeltas }
      if ((paramDeltas.saturation ?? 0) > 0) {
        paramDeltas.saturation = Math.round(paramDeltas.saturation! * scale)
      }
      if ((paramDeltas.vibrance ?? 0) > 0) {
        paramDeltas.vibrance = Math.round(paramDeltas.vibrance! * scale)
      }
      return { ...action, paramDeltas: stripZeros(paramDeltas) }
    }),
    changed: true,
  }
}

function stripZeros(deltas: ParamDeltas): ParamDeltas {
  return Object.fromEntries(
    Object.entries(deltas).filter(([, value]) => value !== 0),
  ) as ParamDeltas
}
