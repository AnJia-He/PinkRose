import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import LinkifiedText from './LinkifiedText.tsx'

describe('消息里的来源链接', () => {
  it('把 http(s) 地址渲染成新窗口打开的安全链接，并保留中文标点', () => {
    const html = renderToStaticMarkup(createElement(LinkifiedText, {
      text: '来源：https://example.com/a。',
    }))

    expect(html).toContain('来源：<a')
    expect(html).toContain('href="https://example.com/a"')
    expect(html).toContain('target="_blank"')
    expect(html).toContain('rel="noopener noreferrer"')
    expect(html).toContain('。</div>')
  })

  it('只识别 http(s)，不会把 javascript: 变成可点链接', () => {
    const html = renderToStaticMarkup(createElement(LinkifiedText, {
      text: 'javascript:alert(1) 和 https://example.com/a?x=1',
    }))

    expect(html).not.toContain('href="javascript:')
    expect(html).toContain('href="https://example.com/a?x=1"')
  })

  it('选择消息时退回纯文本，避免点气泡选中却误开链接', () => {
    const html = renderToStaticMarkup(createElement(LinkifiedText, {
      text: '来源：https://example.com/a',
      interactive: false,
    }))

    expect(html).toBe('<div class="linkified-text">来源：https://example.com/a</div>')
  })
})
