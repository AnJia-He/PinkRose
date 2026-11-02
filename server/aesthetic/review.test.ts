import { describe, expect, it } from 'vitest'
import { compileDirectorPlan, type DirectorPlan } from './plan.ts'
import { guardVisibleReply, reviewDirectorPlan } from './review.ts'

function basePlan(over: Partial<DirectorPlan> = {}): DirectorPlan {
  return {
    intent: 'edit',
    assessment: {
      scene: '海边人像',
      subject: '人物',
      strength: '人物和黄昏的关系成立',
      primaryIssue: '人物略暗',
      protect: ['人物', '黄昏'],
    },
    direction: { name: '自然安静', intensity: 'balanced' },
    actions: [],
    alternatives: [],
    reply: '人物提亮一点，黄昏留着。',
    needsDisambiguation: false,
    degraded: false,
    ...over,
  }
}

describe('审美计划复核', () => {
  it('只给建议时删掉任何生成动作', () => {
    const result = reviewDirectorPlan(basePlan({
      intent: 'advise',
      actions: [{
        capability: 'generation.photo_edit',
        editPrompt: 'Replace the sky.',
        reason: '',
      }],
    }), '先别改，告诉我怎么修')

    expect(result.plan.actions).toHaveLength(0)
    expect(result.blocked).toBe(true)
    expect(result.changed).toBe(true)
  })

  it('用户说轻一点时，磨皮和色彩强度一起收口', () => {
    const result = reviewDirectorPlan(basePlan({
      actions: [
        {
          capability: 'local.portrait',
          paramDeltas: { skinSmooth: 70 },
          reason: '',
        },
        {
          capability: 'local.tone_color',
          paramDeltas: { saturation: 40, vibrance: 30 },
          reason: '',
        },
      ],
    }), '自然一点，轻一点')

    expect(result.blocked).toBe(false)
    expect(result.changed).toBe(true)
    const decision = compileDirectorPlan(result.plan)
    expect(decision.paramDeltas.skinSmooth).toBeLessThanOrEqual(20)
    expect(
      (decision.paramDeltas.saturation ?? 0) + (decision.paramDeltas.vibrance ?? 0),
    ).toBeLessThanOrEqual(28)
  })

  it('普通强度也不会把磨皮和饱和叠成塑料感', () => {
    const result = reviewDirectorPlan(basePlan({
      actions: [
        {
          capability: 'local.portrait',
          paramDeltas: { skinSmooth: 80 },
          reason: '',
        },
        {
          capability: 'local.tone_color',
          paramDeltas: { saturation: 50, vibrance: 50 },
          reason: '',
        },
      ],
    }), '修得好看一点')
    const decision = compileDirectorPlan(result.plan)
    expect(decision.paramDeltas.skinSmooth).toBeLessThanOrEqual(35)
    expect(
      (decision.paramDeltas.saturation ?? 0) + (decision.paramDeltas.vibrance ?? 0),
    ).toBeLessThanOrEqual(40)
  })

  it('用户明确要求强效果时不为审美复核丢掉其强度', () => {
    const result = reviewDirectorPlan(basePlan({
      actions: [{
        capability: 'local.portrait',
        paramDeltas: { skinSmooth: 55 },
        reason: '',
      }],
    }), '磨皮明显一点，强一点')
    const decision = compileDirectorPlan(result.plan)
    expect(decision.paramDeltas.skinSmooth).toBe(55)
    expect(result.blocked).toBe(false)
    expect(result.changed).toBe(false)
  })

  it('内部词和失败说明不会进入用户可见回复', () => {
    const plan = basePlan({
      reply: 'MCP 搜索失败，上下文压缩也完成了。',
      actions: [{
        capability: 'local.tone_color',
        paramDeltas: { exposure: 8 },
        reason: '',
      }],
    })
    const decision = compileDirectorPlan(plan)
    const guarded = guardVisibleReply(plan, decision)
    expect(guarded.blocked).toBe(true)
    expect(guarded.reply).not.toMatch(/MCP|搜索失败|压缩|Agent|Skill|Plugin/iu)
    expect(guarded.reply).toContain('人物')
  })
})
