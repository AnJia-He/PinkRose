import { describe, expect, it } from 'vitest'
import { outpaintPrompt, outpaintReply, outpaintSize } from './outpaint.ts'

describe('AI 扩图', () => {
  it('按目标比例扩到最小包围画布', () => {
    expect(outpaintSize(1200, 800, '1:1')).toEqual({ width: 1200, height: 1200 })
    expect(outpaintSize(1200, 800, '4:5')).toEqual({ width: 1200, height: 1500 })
    expect(outpaintSize(1200, 800, '16:9')).toEqual({ width: 1422, height: 800 })
  })

  it('提示词明确要求保留原画面、只补边缘', () => {
    const prompt = outpaintPrompt('1:1')
    expect(prompt).toContain('1:1 canvas')
    expect(prompt).toContain('Keep the original central photo exactly as it is')
    expect(prompt).toContain('Do not crop, zoom or move')
    expect(prompt).toContain('Do not add text, logos, frames')
  })

  it('回复里说清这一版的比例', () => {
    expect(outpaintReply('3:4')).toContain('3:4')
  })
})
