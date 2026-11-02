import { describe, expect, it, vi } from 'vitest'
import { searchBing } from './webSearch.ts'

const HTML = `
  <li class="b_algo"><h2><a href="https://example.com/a?x=1">Sony <strong>A7 IV</strong></a></h2>
    <p class="b_lineclamp4">发布信息 &amp; 参数摘要</p></li>
  <li class="b_algo"><h2><a href="https://example.com/a?x=1">重复结果</a></h2>
    <p class="b_lineclamp4">重复</p></li>
  <li class="b_algo"><h2><a href="http://127.0.0.1/private">内网地址</a></h2>
    <p class="b_lineclamp4">不该出现</p></li>
  <li class="b_algo"><h2><a href="https://www.sony.com.cn/products/camera">索尼官网</a></h2>
    <p class="b_algoSlug">相机产品页面</p></li>
`
const RSS = `<?xml version="1.0" encoding="utf-8"?>
<rss version="2.0"><channel>
  <item>
    <title>索尼 Alpha 7 V</title>
    <link>https://www.sony.com.cn/products/camera?a=1&amp;b=2</link>
    <description><![CDATA[官方发布信息 &amp; 规格摘要]]></description>
  </item>
  <item>
    <title>内网结果</title>
    <link>http://127.0.0.1/private</link>
    <description>不该出现</description>
  </item>
</channel></rss>`
const EMPTY_RSS = '<?xml version="1.0"?><rss version="2.0"><channel/></rss>'

describe('Bing 搜索解析', () => {
  it('优先解析 RSS，清理 XML / HTML 实体并过滤内网链接', async () => {
    const fetchImpl = vi.fn(async (input: Parameters<typeof fetch>[0]) => {
      expect(String(input)).toContain('format=rss')
      return new Response(RSS, { status: 200, headers: { 'content-type': 'application/rss+xml' } })
    }) as unknown as typeof fetch
    const results = await searchBing('Sony A7 V', { limit: 5, fetchImpl })

    expect(results).toEqual([
      {
        title: '索尼 Alpha 7 V',
        url: 'https://www.sony.com.cn/products/camera?a=1&b=2',
        domain: 'sony.com.cn',
        snippet: '官方发布信息 & 规格摘要',
      },
    ])
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('RSS 为空时回退 HTML，并继续清理、去重和过滤', async () => {
    const fetchImpl = vi.fn(async (input: Parameters<typeof fetch>[0]) => {
      if (String(input).includes('format=rss')) {
        return new Response(EMPTY_RSS, { status: 200, headers: { 'content-type': 'application/rss+xml' } })
      }
      return new Response(HTML, { status: 200, headers: { 'content-type': 'text/html' } })
    }) as unknown as typeof fetch
    const results = await searchBing('Sony A7 IV', { limit: 5, fetchImpl })

    expect(results).toEqual([
      {
        title: 'Sony A7 IV',
        url: 'https://example.com/a?x=1',
        domain: 'example.com',
        snippet: '发布信息 & 参数摘要',
      },
      {
        title: '索尼官网',
        url: 'https://www.sony.com.cn/products/camera',
        domain: 'sony.com.cn',
        snippet: '相机产品页面',
      },
    ])
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  it('限制条数，并把非 2xx 当成不可用', async () => {
    const ok = vi.fn(async (input: Parameters<typeof fetch>[0]) =>
      new Response(String(input).includes('format=rss') ? EMPTY_RSS : HTML, { status: 200 }),
    ) as unknown as typeof fetch
    expect(await searchBing('相机', { limit: 1, fetchImpl: ok })).toHaveLength(1)

    const bad = vi.fn(async () => new Response('busy', { status: 503 })) as unknown as typeof fetch
    await expect(searchBing('相机', { fetchImpl: bad })).rejects.toThrow('HTTP 503')
  })

  it('手动跟随 Bing 地区跳转，但不允许跳到其他域名', async () => {
    let n = 0
    const regional = vi.fn(async (input: Parameters<typeof fetch>[0]) => {
      n++
      if (n === 1 && String(input).includes('format=rss')) return new Response('', {
        status: 302,
        headers: { location: 'https://cn.bing.com/search?q=camera&format=rss' },
      })
      if (String(input).includes('format=rss')) return new Response(EMPTY_RSS, { status: 200 })
      return new Response(HTML, { status: 200 })
    }) as unknown as typeof fetch
    expect(await searchBing('camera', { fetchImpl: regional })).toHaveLength(2)
    expect(regional).toHaveBeenCalledTimes(3)

    const evil = vi.fn(async () => new Response('', {
      status: 302,
      headers: { location: 'http://127.0.0.1/private' },
    })) as unknown as typeof fetch
    await expect(searchBing('camera', { fetchImpl: evil })).rejects.toThrow('非预期地址')
  })
})
