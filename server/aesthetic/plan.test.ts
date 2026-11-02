import { describe, expect, it } from 'vitest'
import { compileDirectorPlan, parseDirectorPlan } from './plan.ts'

const options = { lutNames: [], presetNames: [], userText: '后面的人去掉，人物亮一点' }

describe('创作计划解析', () => {
  it('合并本地动作并把图片生成保持为单次', () => {
    const parsed = parseDirectorPlan({
      intent: 'hybrid',
      assessment: {
        scene: '海边人像',
        subject: '人物',
        strength: '逆光把人物包住了',
        primary_issue: '人物暗、背景抢视线',
        protect: ['身份', '黄昏'],
      },
      direction: { name: '安静自然', intensity: 'subtle' },
      actions: [
        { capability: 'local.tone_color', param_deltas: { exposure: 12, highlights: -8 } },
        { capability: 'local.portrait', param_deltas: { skinSmooth: 14 } },
        {
          capability: 'generation.photo_edit',
          edit_prompt: 'Remove only the distant tourists from the background.',
        },
      ],
      alternatives: [],
      reply: '我把人物提亮，背景的人清掉，黄昏留着。',
    }, options)

    expect(parsed.dropped).toBe(false)
    const decision = compileDirectorPlan(parsed.plan)
    expect(decision.route).toBe('both')
    expect(decision.paramDeltas).toEqual({ exposure: 12, highlights: -8, skinSmooth: 14 })
    expect(decision.editPrompt).toContain('distant tourists')
  })

  it('只给建议时编译为零动作，不偷偷生成', () => {
    const parsed = parseDirectorPlan({
      intent: 'advise',
      assessment: {
        scene: '街拍',
        subject: '人物',
        strength: '光线有故事',
        primary_issue: '背景杂',
        protect: ['主体'],
      },
      direction: { name: '克制纪实', intensity: 'subtle' },
      actions: [],
      alternatives: [
        { title: '保留街景', effect: '只提亮主体', tradeoff: '背景仍然热闹' },
      ],
      reply: '这张的现场感成立；可以只提亮人物，或者压暗背景再冷一点。',
    }, { ...options, userText: '不知道该怎么修' })

    const decision = compileDirectorPlan(parsed.plan)
    expect(decision.route).toBe('params')
    expect(decision.paramDeltas).toEqual({})
    expect(decision.editPrompt).toBe('')
  })

  it('兼容旧版 route 输出，不因升级协议让修图失效', () => {
    const parsed = parseDirectorPlan({
      route: 'params',
      param_deltas: { temperature: 8 },
      reply: '暖一点，肤色不跟着发黄。',
      edit_prompt: '',
    }, { ...options, userText: '暖一点' })

    expect(parsed.legacy).toBe(true)
    expect(compileDirectorPlan(parsed.plan).paramDeltas).toEqual({ temperature: 8 })
  })

  it('未知能力和清单外名称被丢弃，并留下 degraded', () => {
    const parsed = parseDirectorPlan({
      intent: 'edit',
      actions: [
        { capability: 'local.magic_paint', param_deltas: { exposure: 99 } },
        { capability: 'local.user_preset', preset: '不存在' },
      ],
      reply: '好。',
    }, { ...options, presetNames: ['黄昏'], userText: '用黄昏预设' })

    expect(parsed.dropped).toBe(true)
    expect(compileDirectorPlan(parsed.plan).degraded).toBe(true)
  })

  it('受控配方和用户 Lut 会合并进同一份本地决策', () => {
    const parsed = parseDirectorPlan({
      intent: 'edit',
      actions: [
        { capability: 'local.style_recipe', recipe: 'quiet-cinema' },
        { capability: 'local.lut', lut: { name: 'dusk', amount: 65 } },
      ],
      reply: '电影感收一点，黄昏 Lut 留着。',
    }, { ...options, lutNames: ['dusk'], userText: '电影一点，用黄昏滤镜' })
    const decision = compileDirectorPlan(parsed.plan)
    expect(decision.route).toBe('params')
    expect(decision.paramDeltas.contrast).toBe(12)
    expect(decision.lut).toEqual({ name: 'dusk', amount: 65 })
  })

  it('第二轮图片生成会被丢弃，只保留一次', () => {
    const parsed = parseDirectorPlan({
      intent: 'hybrid',
      actions: [
        { capability: 'generation.photo_edit', edit_prompt: 'Remove the bin.' },
        { capability: 'generation.photo_edit', edit_prompt: 'Replace the sky.' },
      ],
      reply: '把杂物清掉。',
    }, options)
    const decision = compileDirectorPlan(parsed.plan)
    expect(decision.route).toBe('generate')
    expect(decision.editPrompt).toBe('Remove the bin.')
    expect(decision.degraded).toBe(true)
  })
})
