import { useEffect, useState } from 'react'
import { ErrorState } from './kit/ErrorState.tsx'
import { getSharedWork, sharedImageUrl } from '../api/works'
import { errorText } from '../api/client'
import { dayLabel, type SharedWork } from '../../shared/works.ts'

/**
 * **公开分享页**（★ 2026-10-19）。
 *
 * 只读：token 就是能力，不需要登录。页面上只有作品本身、用户起的名字和日期
 * —— 没有配方、没有账号、没有硬盘文件名。作品主人在详情页停止分享之后，
 * 同一个 token 立刻 404。
 */
export default function SharedWorkPage({
  token, onHome,
}: {
  token: string
  /** 回落地页（访客可以顺手开始修自己的照片）。 */
  onHome: () => void
}) {
  const [work, setWork] = useState<SharedWork | null>(null)
  const [failed, setFailed] = useState<string | null>(null)
  const [reload, setReload] = useState(0)

  useEffect(() => {
    let alive = true
    setWork(null)
    setFailed(null)
    getSharedWork(token).then(
      (w) => { if (alive) setWork(w) },
      (e) => { if (alive) setFailed(errorText(e, '这个分享链接打不开')) },
    )
    return () => { alive = false }
  }, [token, reload])

  useEffect(() => {
    const prev = document.title
    document.title = 'PinkRose · 分享作品'
    return () => { document.title = prev }
  }, [])

  if (failed) {
    return (
      <main className="shared-page">
        <ErrorState text={failed} retryLabel="再试一次" onRetry={() => setReload(n => n + 1)} />
        <button type="button" className="shared-cta" onClick={onHome}>去 PinkRose 看看</button>
      </main>
    )
  }
  if (!work) {
    return <main className="shared-page"><p className="shared-loading">正在打开分享的作品…</p></main>
  }

  const name = work.alias?.trim() || '一张 PinkRose 作品'
  const date = dayLabel(work.updatedAt, Date.now())
  return (
    <main className="shared-page">
      <header className="shared-head">
        <span className="shared-brand">PinkRose</span>
        <button type="button" className="shared-cta" onClick={onHome}>也修一张</button>
      </header>
      <figure className="shared-figure">
        <img
          className="shared-image"
          src={sharedImageUrl(token, work.updatedAt)}
          alt={name}
        />
      </figure>
      <section className="shared-meta">
        <h1>{name}</h1>
        <p>{date} · 用 PinkRose 修好的照片</p>
        <button type="button" className="shared-primary" onClick={onHome}>
          用 PinkRose 修自己的照片
        </button>
      </section>
    </main>
  )
}
