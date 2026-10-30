import { describe, expect, it } from 'vitest'
import { AI_PRESETS, aiPreset } from './aiPresets'

describe('AI_PRESETS 的新市场能力', () => {
  it('画质增强：只修清晰度、噪点和小瑕疵，保身份与构图', () => {
    const p = aiPreset('enhance')
    expect(AI_PRESETS.some(x => x.id === 'enhance')).toBe(true)
    expect(p.prompt).toContain('Enhance image quality')
    expect(p.prompt).toContain('compression artifacts')
    expect(p.prompt).toContain('facial identity')
    expect(p.prompt).toContain('no added objects')
  })

  it('黑白上色：自然上色，保老照片细节和人物身份', () => {
    const p = aiPreset('colorize')
    expect(AI_PRESETS.some(x => x.id === 'colorize')).toBe(true)
    expect(p.prompt).toContain('Colorize this black-and-white')
    expect(p.prompt).toContain('natural colors')
    expect(p.prompt).toContain('same person')
    expect(p.prompt).toContain('no added objects')
  })

  it('AI studio keeps identity and only replaces the background', () => {
    const p = aiPreset('studio')
    expect(p.label).toBe('AI 写真')
    expect(p.prompt).toContain('studio portrait')
    expect(p.prompt).toContain('facial identity')
    expect(p.prompt).toContain('replace only the background')
    expect(p.prompt).toContain('no extra people')
  })

  it('AI outfit keeps the face and changes only the suit', () => {
    const p = aiPreset('outfit')
    expect(p.label).toBe('AI 换装')
    expect(p.prompt).toContain('navy business suit')
    expect(p.prompt).toContain('facial identity')
    expect(p.prompt).toContain('do not change the face')
    expect(p.prompt).toContain('text or watermark')
  })

  it('去水印：只清叠加水印和文字，保留人物、物体与背景', () => {
    const p = aiPreset('dewatermark')
    expect(p.label).toBe('去水印')
    expect(p.prompt).toContain('watermarks')
    expect(p.prompt).toContain('overlaid text')
    expect(p.prompt).toContain('completely unchanged')
    expect(p.prompt).toContain('no new text')
  })

  it('AI 发型：只换发型，保留脸、服装、背景和光线', () => {
    const p = aiPreset('hair')
    expect(p.label).toBe('AI 发型')
    expect(p.prompt).toContain('shoulder-length layered cut')
    expect(p.prompt).toContain('facial identity')
    expect(p.prompt).toContain('do not change the face')
    expect(p.prompt).toContain('add new people')
  })

  it('AI 换背景四套：只改背景，保留主体与边缘', () => {
    for (const id of ['beach', 'city-night', 'snow', 'product-white'] as const) {
      const p = aiPreset(id)
      expect(p.prompt).toContain('Replace only the background')
      expect(p.prompt).toContain('no extra')
      expect(p.prompt).toContain('text or watermark')
    }
    expect(aiPreset('beach').prompt).toContain('facial identity')
    expect(aiPreset('product-white').prompt).toContain('product shape')
  })
})
