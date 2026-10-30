import { describe, expect, it } from 'vitest'
import {
  CAPTION_MAX_CHARS, captionAt, clampCaption, normalizeCaptionText, wrapCaption,
  type VideoCaption,
} from './captions'

const measure = {
  font: '',
  measureText: (text: string) => ({ width: text.length * 10 }) as TextMetrics,
  fillText: () => {},
}

function caption(patch: Partial<VideoCaption> = {}): VideoCaption {
  return {
    id: 'c1', text: '你好', startMs: 0, endMs: 1000,
    position: 'bottom', size: 'm', color: '#ffffff', ...patch,
  }
}

describe('字幕文字', () => {
  it('压掉多余空白并按上限截断', () => {
    expect(normalizeCaptionText('  你好   世界  ')).toBe('你好 世界')
    expect(normalizeCaptionText('a'.repeat(CAPTION_MAX_CHARS + 10)))
      .toHaveLength(CAPTION_MAX_CHARS)
  })

  it('折行：中文逐字，英文按词，不把单词劈开', () => {
    expect(wrapCaption(measure, 'hello world 你好', 50))
      .toEqual(['hello', 'world', '你好'])
    expect(wrapCaption(measure, '你好世界', 20)).toEqual(['你好', '世界'])
    expect(wrapCaption(measure, '  ', 100)).toEqual([''])
  })
})

describe('字幕时间轴', () => {
  it('只显示区间内的那一条，重叠时后加的盖住先加的', () => {
    const a = caption({ text: 'A', startMs: 0, endMs: 1000 })
    const b = caption({ id: 'c2', text: 'B', startMs: 500, endMs: 1500 })
    expect(captionAt([a], 200)?.text).toBe('A')
    expect(captionAt([a], 1000)).toBeNull()
    expect(captionAt([a, b], 800)?.text).toBe('B')
  })

  it('夹进全片长度：起点不越界、至少显示 0.3 秒', () => {
    expect(clampCaption(caption({ startMs: 900, endMs: 5000 }), 1000))
      .toMatchObject({ startMs: 700, endMs: 1000 })
    expect(clampCaption(caption({ startMs: -50, endMs: 100 }), 1000))
      .toMatchObject({ startMs: 0, endMs: 300 })
  })
})
