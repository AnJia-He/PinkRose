import { isPrivateHostname } from './hostGuard.ts'
import { readTextCapped } from './http.ts'

export type WebSearchResult = {
  title: string
  url: string
  domain: string
  snippet: string
}

export interface WebSearchClient {
  search(query: string, limit?: number): Promise<WebSearchResult[]>
}

export type WebSearchOutcome =
  | { status: 'ready'; query: string; results: WebSearchResult[] }
  | { status: 'empty'; query: string }
  | { status: 'unavailable'; query: string }

const SEARCH_MAX_BYTES = 2 * 1024 * 1024
const SEARCH_TIMEOUT_MS = 12_000

function cleanText(value: string): string {
  return value
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCodePoint(Number(n)))
    .replace(/\s+/g, ' ')
    .trim()
}

function safeResultUrl(raw: string): URL | null {
  try {
    const url = new URL(raw)
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null
    if (url.username || url.password) return null
    if (isPrivateHostname(url.hostname)) return null
    return url
  } catch {
    return null
  }
}

function xmlTag(item: string, tag: string): string {
  const match = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, 'iu').exec(item)
  if (!match) return ''
  return cleanText(match[1]!.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/gu, '$1'))
}

function parseBingRss(xml: string, limit: number): WebSearchResult[] {
  const out: WebSearchResult[] = []
  const seen = new Set<string>()
  for (const match of xml.matchAll(/<item>([\s\S]*?)<\/item>/giu)) {
    const item = match[1]!
    const url = safeResultUrl(xmlTag(item, 'link'))
    const title = xmlTag(item, 'title')
    if (!url || !title) continue
    const normalized = `${url.origin}${url.pathname}${url.search}`
    if (seen.has(normalized)) continue
    seen.add(normalized)
    out.push({
      title,
      url: normalized,
      domain: url.hostname.replace(/^www\./i, ''),
      snippet: xmlTag(item, 'description').slice(0, 500),
    })
    if (out.length >= limit) break
  }
  return out
}

async function fetchBingDocument(url: string, fetcher: typeof fetch): Promise<string> {
  let current = url
  let res: Response | null = null
  for (let hop = 0; hop < 4; hop++) {
    res = await fetcher(current, {
      method: 'GET',
      // Bing 会按地区跳到 cn.bing.com；每一跳都只允许留在 Bing 域名内。
      redirect: 'manual',
      signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS),
      headers: {
        accept: 'application/rss+xml,text/html;q=0.9,application/xhtml+xml;q=0.8',
        'accept-language': 'zh-CN,zh;q=0.9,en;q=0.6',
        'user-agent': 'Mozilla/5.0 PinkRose/1.0 web-search',
      },
    })
    if (res.status < 300 || res.status >= 400) break
    const location = res.headers.get('location')
    void res.body?.cancel().catch(() => {})
    if (!location) break
    const next = new URL(location, current)
    if (next.hostname !== 'bing.com' && !next.hostname.endsWith('.bing.com')) {
      throw new Error('搜索服务跳到了非预期地址')
    }
    current = next.href
  }
  if (!res || res.status >= 300 && res.status < 400) throw new Error('搜索服务重定向异常')
  if (!res.ok) throw new Error(`搜索服务返回 HTTP ${res.status}`)
  return readTextCapped(res, SEARCH_MAX_BYTES)
}

/**
 * 默认搜索源用 Bing 的公开 RSS，失败或为空时回退到网页结果，不依赖用户配置 key。
 * 只读取标题、摘要和链接；不抓取第三方页面正文，也不执行搜索结果里的任何指令。
 */
export async function searchBing(
  query: string,
  options: { limit?: number; fetchImpl?: typeof fetch } = {},
): Promise<WebSearchResult[]> {
  const q = query.replace(/\s+/g, ' ').trim().slice(0, 200)
  if (q.length < 2) return []
  const limit = Math.max(1, Math.min(8, Math.floor(options.limit ?? 5)))
  const fetcher = options.fetchImpl ?? fetch
  const rssUrl =
    `https://www.bing.com/search?format=rss&q=${encodeURIComponent(q)}&setlang=zh-Hans&cc=CN`
  try {
    const rss = await fetchBingDocument(rssUrl, fetcher)
    const parsed = parseBingRss(rss, limit)
    if (parsed.length > 0) return parsed
  } catch {
    // RSS 被拦截或结构变化时继续走网页结果，不让整次搜索直接失败。
  }

  const htmlUrl =
    `https://www.bing.com/search?q=${encodeURIComponent(q)}&setlang=zh-Hans&cc=CN`
  const html = await fetchBingDocument(htmlUrl, fetcher)

  const links = [...html.matchAll(
    /<h2[^>]*>[\s\S]*?<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<\/h2>/gi,
  )]
  const snippets = [...html.matchAll(
    /<p[^>]*class="[^"]*b_(?:lineclamp|algoSlug)[^"]*"[^>]*>([\s\S]*?)<\/p>/gi,
  )]
  const out: WebSearchResult[] = []
  const seen = new Set<string>()

  for (let i = 0; i < links.length && out.length < limit; i++) {
    const url = safeResultUrl(cleanText(links[i]![1]!))
    if (!url) continue
    const title = cleanText(links[i]![2]!)
    if (!title) continue
    const normalized = `${url.origin}${url.pathname}${url.search}`
    if (seen.has(normalized)) continue
    seen.add(normalized)
    out.push({
      title,
      url: normalized,
      domain: url.hostname.replace(/^www\./i, ''),
      snippet: cleanText(snippets[i]?.[1] ?? '').slice(0, 500),
    })
  }
  return out
}
