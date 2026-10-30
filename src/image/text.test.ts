import { describe, it, expect } from 'vitest'
import {
  normalizeTextOptions, textFontFamily, textLayout, TEXT_STYLES,
} from './text.ts'

describe('text', () => {
  it('文字选项：位置夹 0~1、字号夹 12~400、只认 #rrggbb 颜色', () => {
    const a = normalizeTextOptions({ text: '  你好  ', x: -1, y: 2, fontPx: 9999, color: 'red' })
    expect(a.text).toBe('  你好  ')
    expect(a.x).toBe(0)
    expect(a.y).toBe(1)
    expect(a.fontPx).toBe(400)
    expect(a.color).toBe('#ffffff')
    expect(a.font).toBe('sans')
    expect(normalizeTextOptions({ color: '#a1b2c3' }).color).toBe('#a1b2c3')
    expect(normalizeTextOptions({ font: 'serif' }).font).toBe('serif')
    expect(normalizeTextOptions({ font: 'nope' as never }).font).toBe('sans')
  })

  it('多行文字按字号 1.2 倍行距、以 (x,y) 为中心排开', () => {
    const opts = normalizeTextOptions({ text: '上\n下', x: 0.5, y: 0.5, fontPx: 100 })
    const layout = textLayout(opts, 1000, 800)
    expect(layout.lineHeight).toBe(120)
    expect(layout.lines).toHaveLength(2)
    expect(layout.lines[0]).toMatchObject({ text: '上', x: 500, y: 340 })
    expect(layout.lines[1]).toMatchObject({ text: '下', x: 500, y: 460 })
  })

  it('自定义行距真的改变多行文字的上下位置', () => {
    const opts = normalizeTextOptions({
      text: '上\n下', x: 0.5, y: 0.5, fontPx: 100, lineHeight: 1.6,
    })
    const layout = textLayout(opts, 1000, 800)
    expect(layout.lineHeight).toBe(160)
    expect(layout.lines[0]!.y).toBe(320)
    expect(layout.lines[1]!.y).toBe(480)
  })

  it('空文字布局成零行', () => {
    expect(textLayout(normalizeTextOptions({ text: '' }), 100, 100).lines).toEqual([])
  })

  it('文字样式：对齐 / 加粗 / 描边 / 阴影 / 底色都夹到安全值', () => {
    const a = normalizeTextOptions({
      align: 'nope' as never, bold: true,
      outlineWidth: 999, outlineColor: 'red',
      shadow: true, background: true,
      backgroundColor: '#112233', backgroundOpacity: -5,
    })
    expect(a.align).toBe('center')
    expect(a.bold).toBe(true)
    expect(a.outlineWidth).toBe(20)
    expect(a.outlineColor).toBe('#000000')
    expect(a.shadow).toBe(true)
    expect(a.background).toBe(true)
    expect(a.backgroundColor).toBe('#112233')
    expect(a.backgroundOpacity).toBe(0)
  })

  it('文字旋转：默认 0，超出 -180~180 时夹回边界', () => {
    expect(normalizeTextOptions({}).rotation).toBe(0)
    expect(normalizeTextOptions({ rotation: 30 }).rotation).toBe(30)
    expect(normalizeTextOptions({ rotation: 999 }).rotation).toBe(180)
    expect(normalizeTextOptions({ rotation: -999 }).rotation).toBe(-180)
  })

  it('文字排版：行距和字距有安全默认值并夹回范围', () => {
    const d = normalizeTextOptions({})
    expect(d.lineHeight).toBe(1.2)
    expect(d.letterSpacing).toBe(0)
    expect(normalizeTextOptions({ lineHeight: 0.1, letterSpacing: -999 })).toMatchObject({
      lineHeight: 0.8, letterSpacing: -20,
    })
    expect(normalizeTextOptions({ lineHeight: 9, letterSpacing: 999 })).toMatchObject({
      lineHeight: 2, letterSpacing: 40,
    })
  })

  it('字体族按平台落到系统字体，模板会切到宋体 / 楷体', () => {
    expect(textFontFamily('sans')).toContain('PingFang SC')
    expect(textFontFamily('serif')).toContain('Songti SC')
    expect(textFontFamily('kai')).toContain('Kaiti SC')
    expect(textFontFamily('mono')).toContain('monospace')
    const patchOf = (id: string) =>
      TEXT_STYLES.find(s => s.id === id)!.patch as { font?: string }
    expect(patchOf('film').font).toBe('serif')
    expect(patchOf('magazine').font).toBe('serif')
    expect(patchOf('note').font).toBe('kai')
  })
})
