import { useEffect, useState } from 'react'
import { listWorks, fileUrl } from '../api/works'
import { errorText } from '../api/client'
import { workName, matchesQuery, type WorkMeta } from '../../shared/works.ts'
import { usePagedDays } from './kit/pagedDays.ts'

export function GalleryPage({ onOpen }: { onOpen: (id: number) => void }) {
  /** null = 还没拿到。**它和"没有作品"是两件事** —— 混在一起的话，
   *  还没加载完的那一瞬间会显示"还没有作品"，用户会以为东西没了。 */
  const [works, setWorks] = useState<WorkMeta[] | null>(null)
  const [failed, setFailed] = useState<string | null>(null)
  const [q, setQ] = useState('')

  useEffect(() => {
    let alive = true
    listWorks().then(
      (ws) => { if (alive) setWorks(ws) },
      (e) => { if (alive) setFailed(errorText(e, '打不开作品集')) },
    )
    return () => { alive = false }
  }, [])

  /** 按天分组 + 分页 + 滚到底的哨兵：和对话列表**同一套**（`kit/pagedDays`）。 */
  const { now, groups, shown, more, sentinel, resetLimit } = usePagedDays(works, q, matchesQuery)

  return (
    <section className="gallery">
      <header className="gallery-head">
        <h1 className="gallery-title">我的作品</h1>
        {/* ⚠️ 2026-10-01：这一格**故意没过 `<Field>`**。它没有标签、没有注解、也没有
            错误提示，包一层只为了给它一个名字的话，`.gallery-search` 身上那条
            `flex: 1` 就得从输入框挪到外层那个 div 上（`.gallery-head` 是 flex 行，
            孩子换人了整行就得重量）—— 换不到任何东西。
            可访问的名字**直接给在输入框上**：placeholder 只是提示，读屏软件不保证念它。 */}
        <input className="gallery-search" value={q} placeholder="找一张…（名字，或者 9月25 这样的日期）"
               aria-label="找一张作品"
               onChange={e => { setQ(e.target.value); resetLimit() }} />
      </header>

      {failed && (
        <>
          <p className="gallery-error">{failed}</p>
          {/* §3.7：说"不行"的地方，都要同时告诉他"那怎么办"。这一页**不新造按钮**，
              **"刷新一下页面"是用户本来就有的出路**，这句话就是把那条出路说出口。
              （2026-09-25 改：原来写的是"重试逻辑是 Task 12 的事" —— 那是假的。
                Task 12 交出去的是**详情页**，没有给作品页加重试；而且这一轮明确决定
                **不造重试按钮**：作品页的出路到今天就是"刷新一下"。那句假话会把下一个
                读的人往两个方向引 —— 要么以为已经有重试了，要么以为 Task 12 欠着它。） */}
          <p className="gallery-hint">刷新一下页面，再试一次。</p>
        </>
      )}
      {!works && !failed && <p className="gallery-loading">正在打开…</p>}

      {works && works.length === 0 && (
        <div className="gallery-empty">
          {/* ⚠️ 那个类名不是多余的：主句和下面那句小字**必须拉开档次**（CSS 里
              那句"整屏看上去只是'没加载出来'"就是为它写的），而按 `p:first-child`
              那种 DOM 位置去选，谁在前面加一句就当场错位。 */}
          <p className="gallery-empty-title">还没有作品。</p>
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
