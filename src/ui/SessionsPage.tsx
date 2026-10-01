import { useEffect, useMemo, useRef, useState } from 'react'
import { listSessions, deleteSession, sessionThumbUrl } from '../api/sessions'
import { groupByDay } from '../../shared/works.ts'
import { visibleGroups } from '../core/gallery'
import { sessionTitle, type SessionMeta } from '../../shared/sessions.ts'

/** 一次摆多少条。和作品页同一个数（§3.5：「先摆 60 张，够铺满一屏多一点」） */
const PAGE = 60

/**
 * 对话列表：**过程**的家（§6.1）。
 *
 * 「修图」是现在这一次，「作品」是结果，这一页是"我改过哪些" —— 三样是三件事。
 *
 * ⚠️ 分组和分页**复用作品页那一套**（`groupByDay` + `visibleGroups`）：
 *    复制一份出来的话，同一天会在两页里显示成两个名字，而且没人会同时看着两页。
 */
export function SessionsPage({ onOpen, onNew }: {
  onOpen: (id: number) => void
  onNew: () => void
}) {
  /** null = 还没拿到。**它和"一条都没有"是两件事** —— 混在一起的话，
   *  还没加载完的那一瞬间会显示"还没改过照片"，用户会以为东西没了。 */
  const [rows, setRows] = useState<SessionMeta[] | null>(null)
  /** 拉列表失败。**整页就是它** —— 名单都没有，"列表还在不在"无从谈起。 */
  const [failed, setFailed] = useState<string | null>(null)
  /**
   * 删失败。⚠️ **和 `failed` 分开**（计划里原本共用一个，这里改了）：
   * 共用的后果是删一条失败会把**整页换成一行字** —— 名单明明还在手里，
   * 用户看到的却是"我的对话全没了"，一次网络抖动就能吓人一跳。
   * 所以这一条是列表**上面**加一句，列表原样不动。
   */
  const [delFailed, setDelFailed] = useState<string | null>(null)
  const [limit, setLimit] = useState(PAGE)
  /** 正在问"这条要删掉吗"的是哪一条。**就地确认，不弹系统框**（这个产品的规矩） */
  const [confirming, setConfirming] = useState<number | null>(null)
  /** 「现在」只取一次：显示名要判断"是不是今年"，一次会话里不会跨年 */
  const now = useMemo(() => Date.now(), [])

  useEffect(() => {
    let alive = true
    listSessions().then(
      (rs) => { if (alive) setRows(rs) },
      (e) => { if (alive) setFailed(e instanceof Error ? e.message : '打不开对话列表') },
    )
    return () => { alive = false }
  }, [])

  const groups = useMemo(() => (rows ? groupByDay(rows, now) : []), [rows, now])
  const shown = useMemo(() => visibleGroups(groups, limit), [groups, limit])
  const more = shown.length < groups.length

  /** 滚到底就把下 60 条接上。和作品页那个哨兵一模一样（含"按天取整"那条规矩）。 */
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

  async function doDelete(id: number) {
    setConfirming(null)
    setDelFailed(null)
    try {
      await deleteSession(id)
      // 当场从名单里拿掉。等下次刷新才消失的话，用户会以为没删掉。
      setRows((rs) => rs?.filter((r) => r.id !== id) ?? null)
    } catch (e) {
      // 说"不行"的地方都要说"那怎么办"（§3.7）——"再试一次"就是那句出路
      setDelFailed(e instanceof Error ? e.message : '没删掉，再试一次？')
    }
  }

  // ⚠️ 四种状态**都包在 `.sessions` 里**（照 GalleryPage：它那个 `.gallery` 也是
  //    四种状态都在里面）—— 那一层既是"自己滚"的那一格，也是空态居中所要的宽度。
  //    不包的话，空态是 `.shell` 的一个 flex 孩子，宽度按内容收缩，会**贴到左上角**去，
  //    和作品页那个居中的空态长得不一样。
  if (failed) {
    return (
      <section className="sessions">
        <p className="gallery-error">{failed}</p>
        {/* §3.7：说"不行"的地方，都要同时告诉他"那怎么办"。这一页**不新造按钮**，
            和作品页一样："刷新一下"是用户本来就有的那条出路。 */}
        <p className="gallery-hint">刷新一下页面，再试一次。</p>
      </section>
    )
  }
  // ★ 还没拿到（null）和拿到了但是没有（[]）**要分开说**
  if (rows === null) {
    return <section className="sessions"><p className="gallery-loading">正在取…</p></section>
  }
  if (rows.length === 0) {
    return (
      <section className="sessions">
        <div className="sessions-empty">
          {/* 空态那两句话的分工照作品页：主句说现状，下面那句（或者那颗按钮）说"那怎么办"（§3.7） */}
          <p className="sessions-empty-title">还没改过照片。</p>
          <button className="btn-primary" onClick={onNew}>去改一张</button>
        </div>
      </section>
    )
  }
  return (
    <section className="sessions">
      {delFailed && <p className="gallery-error">{delFailed}</p>}
      {shown.map(g => (
        <div key={g.day} className="sessions-day">
          {/* 标题上的条数是**这一天的全部条数**，和下面摆出来的数量一致 ——
              这也是 visibleGroups 按天取整的理由 */}
          <h2 className="gallery-day-title">{g.label} · {g.works.length} 条</h2>
          {g.works.map(s => (
            <div key={s.id} className={confirming === s.id ? 'session-row confirming' : 'session-row'}>
              <button className="session-open" onClick={() => onOpen(s.id)}>
                {/* `alt` 给名字：图上没字，读屏软件只能靠它 */}
                <img className="session-thumb" src={sessionThumbUrl(s.id, s.updatedAt)}
                     alt={sessionTitle(s)} loading="lazy" />
                <span className="session-name">{sessionTitle(s)}</span>
                <span className="session-steps">{s.stepCount} 步</span>
              </button>
              {confirming === s.id ? (
                <>
                  <span className="session-ask">删掉这条？</span>
                  {/* ⚠️ 「删掉」要自己的类（`danger`），**别靠 DOM 位置选**：
                      它上面还有个 `display:none` 的 `.session-open`（还是第一个
                      `button` 兄弟），`:first-of-type` 之类的选择器选不中它 ——
                      选不中的后果是**它和「取消」长得一模一样**，而文案都短、
                      点错一次东西就没了。见 styles.css 里那条 `.session-del.danger`。 */}
                  <button className="session-del danger" onClick={() => void doDelete(s.id)}>删掉</button>
                  <button className="session-del" onClick={() => setConfirming(null)}>取消</button>
                </>
              ) : (
                <button className="session-del"
                        onClick={() => { setConfirming(s.id); setDelFailed(null) }}>删除</button>
              )}
            </div>
          ))}
        </div>
      ))}

      {/* ⚠️ 那个圈**必须转**：没有它，用户会以为到底了（§3.5） */}
      {more && <div ref={sentinel} className="sessions-more">正在取…</div>}
      {!more && groups.length > 0 && <p className="sessions-end">没有更多了</p>}
    </section>
  )
}
