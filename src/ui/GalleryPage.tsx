import { useEffect, useMemo, useRef, useState } from 'react'
import { listWorks, fileUrl } from '../api/works'
import { workName, matchesQuery, groupByDay, type WorkMeta } from '../../shared/works.ts'
import { visibleGroups } from '../core/gallery'

/** 一次摆多少张（§3.5：「先摆 60 张，够铺满一屏多一点」） */
const PAGE = 60

export function GalleryPage({ onOpen }: { onOpen: (id: number) => void }) {
  /** null = 还没拿到。**它和"没有作品"是两件事** —— 混在一起的话，
   *  还没加载完的那一瞬间会显示"还没有作品"，用户会以为东西没了。 */
  const [works, setWorks] = useState<WorkMeta[] | null>(null)
  const [failed, setFailed] = useState<string | null>(null)
  const [q, setQ] = useState('')
  const [limit, setLimit] = useState(PAGE)
  /** 「现在」只取一次：显示名要判断"是不是今年"，一次会话里不会跨年 */
  const now = useMemo(() => Date.now(), [])

  useEffect(() => {
    let alive = true
    listWorks().then(
      (ws) => { if (alive) setWorks(ws) },
      (e) => { if (alive) setFailed(e instanceof Error ? e.message : '打不开作品集') },
    )
    return () => { alive = false }
  }, [])

  const groups = useMemo(
    () => (works ? groupByDay(works.filter(w => matchesQuery(w, q, now)), now) : []),
    [works, q, now])
  const shown = useMemo(() => visibleGroups(groups, limit), [groups, limit])
  const more = shown.length < groups.length

  /** 滚到底就把下一次的 60 张接上。 */
  const sentinel = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    const el = sentinel.current
    if (!el) return
    const io = new IntersectionObserver((es) => {
      if (es.some(e => e.isIntersecting)) setLimit(n => n + PAGE)
    })
    io.observe(el)
    return () => io.disconnect()
  }, [more])

  return (
    <section className="gallery">
      <header className="gallery-head">
        <h1 className="gallery-title">我的作品</h1>
        <input className="gallery-search" value={q} placeholder="找一张…（名字，或者 9月25 这样的日期）"
               onChange={e => { setQ(e.target.value); setLimit(PAGE) }} />
      </header>

      {failed && (
        <>
          <p className="gallery-error">{failed}</p>
          {/* §3.7：说"不行"的地方，都要同时告诉他"那怎么办"。这一页不新造按钮 ——
              重试逻辑是 Task 12 的事，而"刷新一下页面"是用户本来就有的出路。 */}
          <p className="gallery-hint">刷新一下页面，再试一次。</p>
        </>
      )}
      {!works && !failed && <p className="gallery-loading">正在打开…</p>}

      {works && works.length === 0 && (
        <div className="gallery-empty">
          <p>还没有作品。</p>
          {/* §3.7：告诉用户"不行"的地方，都要同时告诉他"那怎么办" */}
          <p className="gallery-hint">左边点「修图」，做一张试试。</p>
        </div>
      )}

      {works && works.length > 0 && groups.length === 0 && (
        <p className="gallery-none">没找到。换个字试试？</p>
      )}

      {shown.map(g => (
        <div key={g.day} className="gallery-day">
          {/* 标题上的张数是**这一天的全部张数**，和下面摆出来的数量一致 ——
              这也是 visibleGroups 按天取整的理由 */}
          <h2 className="gallery-day-title">{g.label} · {g.works.length} 张</h2>
          <div className="gallery-grid">
            {g.works.map(w => {
              const name = workName(w, now)
              return (
                <button key={w.id} className="gallery-cell" onClick={() => onOpen(w.id)}>
                  {/* loading="lazy"：60 张不用一次全下载 */}
                  <img className="gallery-thumb" src={fileUrl(w)} alt={name} loading="lazy" />
                  <span className="gallery-name">{name}</span>
                </button>
              )
            })}
          </div>
        </div>
      ))}

      {/* ⚠️ 那个圈**必须转**：没有它，用户会以为到底了（§3.5） */}
      {more && <div ref={sentinel} className="gallery-more">正在取…</div>}
      {!more && groups.length > 0 && <p className="gallery-end">没有更多了</p>}
    </section>
  )
}
