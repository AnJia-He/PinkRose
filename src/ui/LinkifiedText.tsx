import type { ReactNode } from 'react'

type Props = {
  text: string
  /** 多选消息时关掉链接，点击气泡只负责选中。 */
  interactive?: boolean
}

const HTTP_URL = /https?:\/\/[^\s<>"']+/giu
const TRAILING_PUNCTUATION = /[.,;:!?，。；：！？、）】》]+$/u

function linkParts(text: string): ReactNode[] {
  const out: ReactNode[] = []
  let cursor = 0
  for (const match of text.matchAll(HTTP_URL)) {
    const start = match.index ?? 0
    const raw = match[0]
    const trailing = raw.match(TRAILING_PUNCTUATION)?.[0] ?? ''
    const href = trailing ? raw.slice(0, -trailing.length) : raw
    if (!href) continue
    if (start > cursor) out.push(text.slice(cursor, start))
    out.push(
      <a key={`${start}:${href}`} href={href} target="_blank" rel="noopener noreferrer">
        {href}
      </a>,
    )
    if (trailing) out.push(trailing)
    cursor = start + raw.length
  }
  if (cursor < text.length) out.push(text.slice(cursor))
  return out.length > 0 ? out : [text]
}

/** 聊天文本里的普通 http(s) 地址；不解析 HTML，也不会生成 javascript: 链接。 */
export default function LinkifiedText({ text, interactive = true }: Props) {
  return (
    <div className="linkified-text">
      {interactive ? linkParts(text) : text}
    </div>
  )
}
