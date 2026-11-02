import { describe, expect, it } from 'vitest'
import {
  AESTHETIC_SKILLS,
  buildAestheticSkillGuide,
  selectAestheticSkills,
} from './skills.ts'

describe('审美场景 Skill', () => {
  it('每个 Skill 都有唯一 id、版本和明确边界', () => {
    const ids = AESTHETIC_SKILLS.map((skill) => skill.id)
    expect(new Set(ids).size).toBe(ids.length)
    expect(AESTHETIC_SKILLS.every((skill) => skill.version >= 1)).toBe(true)
    expect(AESTHETIC_SKILLS.every((skill) => skill.guidance.length > 20)).toBe(true)
  })

  it('人像和夜景同时出现时只装最多两个最相关规则', () => {
    const selected = selectAestheticSkills('这张夜景人像把脸修自然一点')
    expect(selected.map((skill) => skill.id)).toContain('portrait')
    expect(selected.map((skill) => skill.id)).toContain('street-night')
    expect(selected).toHaveLength(2)
  })

  it('没有场景线索时不强行套某一种风格', () => {
    expect(selectAestheticSkills('再亮一点')).toEqual([])
    expect(buildAestheticSkillGuide('再亮一点')).toBe('')
  })

  it('注入的规则带版本身份，方便后续独立升级', () => {
    const guide = buildAestheticSkillGuide('帮我把这张产品图修干净')
    expect(guide).toContain('【本轮审美重点】')
    expect(guide).toContain('product-food@1')
    expect(guide).toContain('材质')
  })
})
