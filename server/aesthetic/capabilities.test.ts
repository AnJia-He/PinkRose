import { describe, expect, it } from 'vitest'
import {
  CAPABILITIES,
  buildCapabilityCatalog,
  isCapabilityId,
  styleRecipe,
} from './capabilities.ts'

describe('审美能力注册表', () => {
  it('只开放已声明的能力，并保持唯一边界', () => {
    const ids = CAPABILITIES.map((item) => item.id)
    expect(new Set(ids).size).toBe(ids.length)
    expect(isCapabilityId('local.tone_color')).toBe(true)
    expect(isCapabilityId('local.arbitrary_sql')).toBe(false)
  })

  it('把费用、隐私、回退和单轮上限写进目录', () => {
    const catalog = buildCapabilityCatalog()
    expect(catalog).toContain('local.tone_color')
    expect(catalog).toContain('cost=free')
    expect(catalog).toContain('privacy=local')
    expect(catalog).toContain('generation.photo_edit')
    expect(catalog).toContain('privacy=image-to-cloud')
    expect(catalog).toContain('max=1')
  })

  it('风格配方只返回受控参数，未知配方返回 null', () => {
    expect(styleRecipe('quiet-cinema')?.deltas.contrast).toBeGreaterThan(0)
    expect(styleRecipe('made-up-recipe')).toBeNull()
  })
})
