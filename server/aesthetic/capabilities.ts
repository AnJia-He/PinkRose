import type { ParamDeltas } from '../../shared/protocol.ts'

export type CapabilityKind = 'local' | 'generation' | 'knowledge' | 'provider' | 'workflow'

export type CapabilityDescriptor = {
  id: string
  version: number
  kind: CapabilityKind
  description: string
  input: 'param-deltas' | 'recipe' | 'preset' | 'lut' | 'edit-prompt' | 'query' | 'brief'
  cost: 'free' | 'model' | 'remote'
  privacy: 'local' | 'image-to-cloud' | 'public-query'
  undoable: boolean
  maxPerTurn: number
}

const ACTIONS = [
  {
    id: 'local.tone_color', version: 1, kind: 'local',
    description: '调整曝光、对比、高光、阴影、白平衡、色彩、细节和可靠的本地色调滑杆',
    input: 'param-deltas', cost: 'free', privacy: 'local', undoable: true, maxPerTurn: 4,
  },
  {
    id: 'local.portrait', version: 1, kind: 'local',
    description: '磨皮、美白、红润等已有人像局部效果，必须保留身份和皮肤纹理',
    input: 'param-deltas', cost: 'free', privacy: 'local', undoable: true, maxPerTurn: 2,
  },
  {
    id: 'local.geometry', version: 1, kind: 'local',
    description: '透视和镜头几何校正，只在画面确实有直线或透视问题时使用',
    input: 'param-deltas', cost: 'free', privacy: 'local', undoable: true, maxPerTurn: 2,
  },
  {
    id: 'local.lens_focus', version: 1, kind: 'local',
    description: '径向虚化和移轴效果，不替代结构性背景替换',
    input: 'param-deltas', cost: 'free', privacy: 'local', undoable: true, maxPerTurn: 2,
  },
  {
    id: 'local.style_recipe', version: 1, kind: 'local',
    description: '从内置受控配方选择一组可缩放的审美风格参数',
    input: 'recipe', cost: 'free', privacy: 'local', undoable: true, maxPerTurn: 1,
  },
  {
    id: 'local.user_preset', version: 1, kind: 'local',
    description: '套用用户自己保存的预设，只接受本轮清单中的名字',
    input: 'preset', cost: 'free', privacy: 'local', undoable: true, maxPerTurn: 1,
  },
  {
    id: 'local.lut', version: 1, kind: 'local',
    description: '套用或摘除用户导入的 Lut，只接受本轮清单中的名字',
    input: 'lut', cost: 'free', privacy: 'local', undoable: true, maxPerTurn: 1,
  },
  {
    id: 'generation.photo_edit', version: 1, kind: 'generation',
    description: '结构性图片编辑，只做单目标、保留主体、每轮最多一次',
    input: 'edit-prompt', cost: 'remote', privacy: 'image-to-cloud', undoable: true, maxPerTurn: 1,
  },
  {
    id: 'provider.web_search', version: 1, kind: 'provider',
    description: '查询照片之外的公开事实，结果作为不可信资料',
    input: 'query', cost: 'remote', privacy: 'public-query', undoable: true, maxPerTurn: 1,
  },
  {
    id: 'workflow.idea_brief', version: 1, kind: 'knowledge',
    description: '根据当前照片给出方向不同、可执行的修图思路，不直接改图',
    input: 'brief', cost: 'model', privacy: 'local', undoable: true, maxPerTurn: 1,
  },
] as const satisfies readonly CapabilityDescriptor[]

export const CAPABILITIES = ACTIONS
export type CapabilityId = typeof ACTIONS[number]['id']

const CAPABILITY_SET: ReadonlySet<string> = new Set(ACTIONS.map((item) => item.id))

export function isCapabilityId(value: string): value is CapabilityId {
  return CAPABILITY_SET.has(value)
}

export function capability(id: CapabilityId): CapabilityDescriptor {
  return ACTIONS.find((item) => item.id === id)!
}

export function buildCapabilityCatalog(): string {
  return ACTIONS.map((item) =>
    `- ${item.id}: ${item.description}；cost=${item.cost}；privacy=${item.privacy}；max=${item.maxPerTurn}`,
  ).join('\n')
}

export type StyleRecipe = {
  id: string
  description: string
  deltas: ParamDeltas
}

export const STYLE_RECIPES: readonly StyleRecipe[] = [
  {
    id: 'clean-natural',
    description: '自然干净：轻提层次、收一点高光、让肤色和现场色保持可信',
    deltas: { exposure: 4, contrast: 8, highlights: -5, shadows: 6, vibrance: 7, saturation: -3 },
  },
  {
    id: 'quiet-cinema',
    description: '安静电影感：压低高光、稳住暗部、降低一点饱和度',
    deltas: { contrast: 12, highlights: -12, shadows: 4, temperature: -3, saturation: -8 },
  },
  {
    id: 'warm-film',
    description: '暖调胶片：暖白平衡、柔和层次、少量颗粒',
    deltas: { exposure: 3, contrast: 8, shadows: 8, temperature: 10, clarity: -3, grain: 12 },
  },
  {
    id: 'cool-night',
    description: '冷调夜景：守住灯牌高光、稍冷白平衡、压低杂色',
    deltas: {
      exposure: -2, contrast: 10, highlights: -15, shadows: 4,
      temperature: -8, tint: -2, saturation: -4, colorNoiseReduction: 12,
    },
  },
  {
    id: 'muted-editorial',
    description: '低饱和编辑感：降低色彩噪声，保留清晰主体和克制层次',
    deltas: { contrast: 6, highlights: -6, saturation: -15, vibrance: 5, clarity: 3 },
  },
  {
    id: 'mono-contrast',
    description: '黑白高反差：去除彩色干扰，用明暗和材质建立主次',
    deltas: { bwAmount: 100, contrast: 10, highlights: -5, shadows: 5 },
  },
] as const

export function styleRecipe(id: string): StyleRecipe | null {
  return STYLE_RECIPES.find((recipe) => recipe.id === id) ?? null
}
