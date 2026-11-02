import { PARAM_KEYS, PARAM_MAX, PARAM_MIN } from '../../shared/adjustments.ts'
import { sameLutName } from '../../shared/lut.ts'
import { samePresetName } from '../../shared/preset.ts'
import type {
  LutDecision,
  ParamDeltas,
  PresetDecision,
  RouteDecision,
} from '../../shared/protocol.ts'
import { cleanReplyText } from '../replyGuide.ts'
import { coerceToObject, inferRoute, normalizeDeltas } from '../validate.ts'
import {
  CAPABILITIES,
  isCapabilityId,
  styleRecipe,
  type CapabilityId,
} from './capabilities.ts'

export type DirectorIntent = 'edit' | 'advise' | 'hybrid' | 'chat'
export type DirectionIntensity = 'subtle' | 'balanced' | 'bold'

export type DirectorAssessment = {
  scene: string
  subject: string
  strength: string
  primaryIssue: string
  protect: string[]
}

export type DirectorAction =
  | {
    capability: 'local.tone_color' | 'local.portrait' | 'local.geometry' | 'local.lens_focus'
    paramDeltas: ParamDeltas
    reason: string
  }
  | { capability: 'local.style_recipe'; recipe: string; reason: string }
  | { capability: 'local.user_preset'; preset: string; reason: string }
  | { capability: 'local.lut'; lut: LutDecision; reason: string }
  | { capability: 'generation.photo_edit'; editPrompt: string; reason: string }
  | { capability: 'workflow.idea_brief'; reason: string }
  | { capability: 'provider.web_search'; reason: string }

export type DirectorPlan = {
  intent: DirectorIntent
  assessment: DirectorAssessment
  direction: { name: string; intensity: DirectionIntensity }
  actions: DirectorAction[]
  alternatives: { title: string; effect: string; tradeoff: string }[]
  reply: string
  needsDisambiguation: boolean
  degraded: boolean
}

export type ParsedDirectorPlan = {
  plan: DirectorPlan
  legacy: boolean
  dropped: boolean
}

type ParseOptions = {
  lutNames: readonly string[]
  presetNames: readonly string[]
  userText: string
}

const LOCAL_PARAM_CAPABILITIES = new Set<CapabilityId>([
  'local.tone_color',
  'local.portrait',
  'local.geometry',
  'local.lens_focus',
])

const INTENTS = new Set<DirectorIntent>(['edit', 'advise', 'hybrid', 'chat'])
const INTENSITIES = new Set<DirectionIntensity>(['subtle', 'balanced', 'bold'])
const MAX_EDIT_PROMPT = 1_200

export function parseDirectorPlan(raw: unknown, options: ParseOptions): ParsedDirectorPlan {
  const obj = coerceToObject(raw)
  if (!obj) {
    return {
      plan: emptyDirectorPlan('chat', ''),
      legacy: false,
      dropped: true,
    }
  }

  const hasActions = Array.isArray(obj.actions)
  const legacy = !hasActions && (
    obj.route !== undefined
    || obj.param_deltas !== undefined
    || obj.paramDeltas !== undefined
    || obj.edit_prompt !== undefined
    || obj.editPrompt !== undefined
  )
  const rawActions: unknown[] = hasActions
    ? obj.actions as unknown[]
    : legacy ? legacyActions(obj) : []

  let dropped = false
  const counts = new Map<string, number>()
  const actions: DirectorAction[] = []
  for (const item of rawActions) {
    const action = normalizeAction(item, options)
    if (!action) {
      dropped = true
      continue
    }
    const descriptor = CAPABILITIES.find((entry) => entry.id === action.capability)
    const count = counts.get(action.capability) ?? 0
    if (!descriptor || count >= descriptor.maxPerTurn) {
      dropped = true
      continue
    }
    counts.set(action.capability, count + 1)
    actions.push(action)
  }

  const plan: DirectorPlan = {
    intent: normalizeIntent(obj.intent, actions),
    assessment: normalizeAssessment(obj.assessment),
    direction: normalizeDirection(obj.direction),
    actions,
    alternatives: normalizeAlternatives(obj.alternatives),
    reply: typeof obj.reply === 'string' ? cleanReplyText(obj.reply) : '',
    needsDisambiguation: obj.needs_disambiguation === true || obj.needsDisambiguation === true,
    degraded: dropped,
  }

  if (!plan.reply && actions.length === 0) dropped = true
  plan.degraded = dropped
  return { plan, legacy, dropped }
}

export function compileDirectorPlan(plan: DirectorPlan): RouteDecision {
  let params: ParamDeltas = {}
  let editPrompt = ''
  let lut: LutDecision | null = null
  let preset: PresetDecision | null = null
  let dropped = plan.degraded

  for (const action of plan.actions) {
    switch (action.capability) {
      case 'generation.photo_edit':
        if (editPrompt) {
          dropped = true
          continue
        }
        editPrompt = action.editPrompt
        break
      case 'local.style_recipe': {
        const recipe = styleRecipe(action.recipe)
        if (!recipe) {
          dropped = true
          continue
        }
        params = mergeDeltas(params, scaleDeltas(recipe.deltas, recipeScale(plan.direction.intensity)))
        break
      }
      case 'local.user_preset':
        preset = { name: action.preset }
        break
      case 'local.lut':
        lut = action.lut
        break
      case 'workflow.idea_brief':
      case 'provider.web_search':
        break
      default:
        params = mergeDeltas(params, action.paramDeltas)
    }
  }

  const hasParams = Object.values(params).some((value) => value !== 0)
  const hasLocal = hasParams || preset !== null || lut !== null
  const hasEdit = editPrompt.length > 0
  const route = inferRoute(hasLocal, hasEdit)

  return {
    route,
    paramDeltas: params,
    reply: plan.reply || fallbackReplyForPlan(plan, hasLocal, hasEdit),
    editPrompt: route === 'generate' || route === 'both' ? editPrompt : '',
    needsDisambiguation: plan.needsDisambiguation,
    degraded: dropped,
    lut,
    preset,
  }
}

function legacyActions(obj: Record<string, unknown>): unknown[] {
  const actions: unknown[] = []
  const params = normalizeDeltas(obj.param_deltas ?? obj.paramDeltas)
  if (Object.values(params).some((value) => value !== 0)) {
    actions.push({ capability: 'local.tone_color', param_deltas: params })
  }
  if (obj.lut !== null && obj.lut !== undefined) {
    actions.push({ capability: 'local.lut', lut: obj.lut })
  }
  if (typeof obj.preset === 'object' && obj.preset !== null) {
    actions.push({ capability: 'local.user_preset', preset: obj.preset })
  }

  const editPrompt = typeof obj.edit_prompt === 'string'
    ? obj.edit_prompt.trim()
    : typeof obj.editPrompt === 'string' ? obj.editPrompt.trim() : ''
  const route = obj.route
  if ((route === 'generate' || route === 'both') && editPrompt) {
    actions.push({ capability: 'generation.photo_edit', edit_prompt: editPrompt })
  }
  return actions
}

function normalizeAction(item: unknown, options: ParseOptions): DirectorAction | null {
  if (typeof item !== 'object' || item === null || Array.isArray(item)) return null
  const action = item as Record<string, unknown>
  if (typeof action.capability !== 'string' || !isCapabilityId(action.capability)) return null
  const capability = action.capability
  const reason = typeof action.reason === 'string' ? action.reason.trim().slice(0, 160) : ''

  if (LOCAL_PARAM_CAPABILITIES.has(capability)) {
    const paramDeltas = normalizeDeltas(action.param_deltas ?? action.paramDeltas)
    const localCapability = capability as
      'local.tone_color' | 'local.portrait' | 'local.geometry' | 'local.lens_focus'
    return Object.values(paramDeltas).some((value) => value !== 0)
      ? { capability: localCapability, paramDeltas, reason }
      : null
  }

  if (capability === 'local.style_recipe') {
    const recipe = typeof action.recipe === 'string' ? action.recipe.trim() : ''
    return styleRecipe(recipe) ? { capability, recipe, reason } : null
  }

  if (capability === 'local.user_preset') {
    const requested = typeof action.preset === 'string'
      ? action.preset.trim()
      : presetName(action.preset)
    const hit = requested
      ? options.presetNames.find((name) => samePresetName(name, requested))
      : null
    return hit ? { capability, preset: hit, reason } : null
  }

  if (capability === 'local.lut') {
    const value = typeof action.lut === 'object' && action.lut !== null
      ? action.lut as Record<string, unknown>
      : action
    const requested = typeof value.name === 'string' ? value.name.trim() : ''
    if (requested === '') {
      return action.remove === true || action.lut === ''
        ? { capability, lut: { name: '', amount: 0 }, reason }
        : null
    }
    const hit = options.lutNames.find((name) => sameLutName(name, requested))
    if (!hit) return null
    const rawAmount = Number(value.amount)
    const amount = Number.isFinite(rawAmount)
      ? Math.max(0, Math.min(100, Math.round(rawAmount)))
      : 100
    return { capability, lut: { name: hit, amount }, reason }
  }

  if (capability === 'generation.photo_edit') {
    const editPrompt = typeof action.edit_prompt === 'string'
      ? action.edit_prompt
      : typeof action.editPrompt === 'string' ? action.editPrompt : ''
    const clean = editPrompt.replace(/\s+/g, ' ').trim().slice(0, MAX_EDIT_PROMPT)
    return clean ? { capability, editPrompt: clean, reason } : null
  }

  if (capability === 'workflow.idea_brief' || capability === 'provider.web_search') {
    return { capability, reason }
  }

  return null
}

function presetName(value: unknown): string {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return ''
  const name = (value as Record<string, unknown>).name
  return typeof name === 'string' ? name.trim() : ''
}

function mergeDeltas(left: ParamDeltas, right: ParamDeltas): ParamDeltas {
  const out: ParamDeltas = {}
  for (const key of PARAM_KEYS) {
    const value = Math.round((left[key] ?? 0) + (right[key] ?? 0))
    if (value === 0) continue
    out[key] = Math.max(PARAM_MIN, Math.min(PARAM_MAX, value))
  }
  return out
}

function scaleDeltas(deltas: ParamDeltas, scale: number): ParamDeltas {
  const out: ParamDeltas = {}
  for (const key of PARAM_KEYS) {
    const value = deltas[key]
    if (typeof value !== 'number' || value === 0) continue
    out[key] = Math.round(value * scale)
  }
  return out
}

function recipeScale(intensity: DirectorPlan['direction']['intensity']): number {
  if (intensity === 'subtle') return 0.65
  if (intensity === 'bold') return 1.25
  return 1
}

function normalizeIntent(raw: unknown, actions: readonly DirectorAction[]): DirectorIntent {
  if (typeof raw === 'string' && INTENTS.has(raw as DirectorIntent)) {
    return raw as DirectorIntent
  }
  const hasLocal = actions.some((action) =>
    action.capability.startsWith('local.'))
  const hasGeneration = actions.some((action) =>
    action.capability === 'generation.photo_edit')
  if (hasLocal && hasGeneration) return 'hybrid'
  if (hasGeneration) return 'edit'
  if (hasLocal) return 'edit'
  return 'chat'
}

function normalizeAssessment(raw: unknown): DirectorAssessment {
  const value = typeof raw === 'object' && raw !== null && !Array.isArray(raw)
    ? raw as Record<string, unknown>
    : {}
  const protect = Array.isArray(value.protect)
    ? value.protect.flatMap((item) => {
      if (typeof item !== 'string') return []
      const text = item.trim().slice(0, 60)
      return text ? [text] : []
    }).slice(0, 8)
    : []
  return {
    scene: text(value.scene, 80),
    subject: text(value.subject, 80),
    strength: text(value.strength, 160),
    primaryIssue: text(value.primary_issue ?? value.primaryIssue, 160),
    protect,
  }
}

function normalizeDirection(raw: unknown): { name: string; intensity: DirectionIntensity } {
  const value = typeof raw === 'object' && raw !== null && !Array.isArray(raw)
    ? raw as Record<string, unknown>
    : {}
  const intensity = typeof value.intensity === 'string' && INTENSITIES.has(value.intensity as DirectionIntensity)
    ? value.intensity as DirectionIntensity
    : 'balanced'
  return { name: text(value.name, 80), intensity }
}

function normalizeAlternatives(raw: unknown): DirectorPlan['alternatives'] {
  if (!Array.isArray(raw)) return []
  return raw.flatMap((item) => {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) return []
    const value = item as Record<string, unknown>
    const title = text(value.title, 40)
    const effect = text(value.effect, 100)
    const tradeoff = text(value.tradeoff, 100)
    return title && effect
      ? [{ title, effect, tradeoff }]
      : []
  }).slice(0, 2)
}

function text(value: unknown, max: number): string {
  return typeof value === 'string'
    ? value.replace(/\s+/g, ' ').trim().slice(0, max)
    : ''
}

function emptyDirectorPlan(intent: DirectorIntent, reply: string): DirectorPlan {
  return {
    intent,
    assessment: { scene: '', subject: '', strength: '', primaryIssue: '', protect: [] },
    direction: { name: '', intensity: 'balanced' },
    actions: [],
    alternatives: [],
    reply,
    needsDisambiguation: false,
    degraded: true,
  }
}

function fallbackReplyForPlan(
  plan: DirectorPlan,
  hasLocal: boolean,
  hasGeneration: boolean,
): string {
  if (plan.needsDisambiguation) {
    return '我还不确定你指的是哪个位置；先在图上点一下，我就照着那里改。'
  }
  if (hasGeneration) return '我按你说的把这一处单独改了，画面其余部分保持原样。'
  if (hasLocal) return '先按画面里最需要的地方收了一点，原来的主次留着。'
  if (plan.intent === 'advise') {
    return '这张先不用急着大改，可以先从画面主次和光线关系里选一个方向。'
  }
  return '在的，这张照片想看哪方面？想直接修，还是先聊聊方向？'
}
