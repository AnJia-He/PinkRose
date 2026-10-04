import { useEffect, useMemo, useRef, useState } from 'react'
import { Btn } from './kit/Btn.tsx'
import { listSessions, deleteSession, updateSession, sessionThumbUrl } from '../api/sessions'
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
export function SessionsPage({ onOpen, onNew, onDeleted }: {
  onOpen: (id: number) => void
  onNew: () => void
  /**
   * 删成功之后把 id 交回去。
   *
   * ⚠️ **这一页自己不知道"现在正在改的是哪条"**，也不知道 App 手上有多少东西挂在
   *   那条会话上（照片、对话、每一步的快照）。删掉**正在改的那条**时，那些东西
   *   必须跟着走 —— 不听这一声的话，`sessionId` 会一直指着一条已经不存在的会话，
   *   用户之后再改什么都打在 404 上（屏幕上只有一句"刚才那一步没存下来"），
   *   刷新一看全没。所以这一声是**必须**的，不是可选的礼节。
   *   要不要动、动什么，由 App 判（它才知道删的是不是手上那条）。
   */
  onDeleted: (id: number) => void
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
  /** 正在改名字的是哪一条。**手势和作品详情页那颗「改名」同一套**：
   *  回车 / 点走保存，Esc 取消（见 `WorkDetailPage.doRename`）。 */
  const [renaming, setRenaming] = useState<number | null>(null)
  /** 改名失败。⚠️ 和 `delFailed` 同一套：列表上面加一句，**名单原样不动** */
  const [renameFailed, setRenameFailed] = useState<string | null>(null)
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
      // ★ 删**成功之后**才告诉外面（失败那次什么都没发生，更不该去动 App 手上的活儿）
      onDeleted(id)
    } catch (e) {
      // 说"不行"的地方都要说"那怎么办"（§3.7）——"再试一次"就是那句出路
      setDelFailed(e instanceof Error ? e.message : '没删掉，再试一次？')
    }
  }

  /**
   * 改名。**和作品详情页那颗「改名」同一条形状**（`WorkDetailPage.doRename`）：
   * 先退出编辑态；显示名没变就什么都不发；空串 = 清空（服务端存成 null，
   * 显示回退到照片名 /「还没说话」）。
   *
   * ⚠️ 保存有两条路（回车走 `onKeyDown`、点走别处走 `onBlur`），所以"只发一次"
   *    靠的是**回车后输入框被卸载、浏览器不补 blur**（作品页顶了四天的那条，
   *    测试用"请求计数 === 1"把这份不确定变成当场可观察）。
   * ⚠️ 替换那一行用的是**服务端回来的 meta**：`updatedAt` 也在里面（缩略图 URL
   *    的 `v` 靠它）；而且"只改名字"那一趟服务端**不动 `updatedAt`**（列表按它
   *    排序分组，改名不该让这条跳到"今天"，见 `server/sessions.ts` 的 `titleOnly`）
   *    —— 拿回什么存什么，别自己造时间。
   */
  async function doRename(id: number, raw: string) {
    setRenaming(null)
    setRenameFailed(null)
    const next = raw.trim()
    const cur = rows?.find((r) => r.id === id)
    // 显示名没变就什么都不发。⚠️ 比的是**显示名**（`sessionTitle`，可能是回退
    // 出来的照片名），不是 `title` 字段 —— 比字段的话，一条"还没起过名"的会话
    // 会被这趟"没改的改名"**静默实化**（title 从 null 变成照片名）。
    if (cur && next === sessionTitle(cur)) return
    try {
      const meta = await updateSession(id, { title: next })
      setRows((rs) => rs?.map((r) => (r.id === id ? meta : r)) ?? null)
    } catch (e) {
      // 同上：失败了列表原样，只在上面加一句
      setRenameFailed(e instanceof Error ? e.message : '没改成，再试一次')
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
        <div className="sessions-empty empty-state">
          {/* 空态那两句话的分工照作品页：主句说现状，下面那句（或者那颗按钮）说"那怎么办"（§3.7） */}
          <p className="sessions-empty-title empty-state-title">还没改过照片。</p>
          <Btn onClick={onNew}>去改一张</Btn>
        </div>
      </section>
    )
  }
  return (
    <section className="sessions">
      {delFailed && <p className="gallery-error">{delFailed}</p>}
      {renameFailed && <p className="gallery-error">{renameFailed}</p>}
      {shown.map(g => (
        <div key={g.day} className="sessions-day">
          {/* 标题上的条数是**这一天的全部条数**，和下面摆出来的数量一致 ——
              这也是 visibleGroups 按天取整的理由 */}
          <h2 className="gallery-day-title">{g.label} · {g.works.length} 条</h2>
          {g.works.map(s => (
            <div key={s.id} className={
              renaming === s.id ? 'session-row renaming'
                : confirming === s.id ? 'session-row confirming' : 'session-row'}>
              <button className="session-open" onClick={() => onOpen(s.id)}>
                {/* `alt` 给名字：图上没字，读屏软件只能靠它 */}
                <img className="session-thumb" src={sessionThumbUrl(s.id, s.updatedAt)}
                     alt={sessionTitle(s)} loading="lazy" />
                <span className="session-name">{sessionTitle(s)}</span>
                <span className="session-steps">{s.stepCount} 步</span>
              </button>
              {renaming === s.id ? (
                /* 改名 —— 和作品详情页那颗同名按钮**同一套手势**：回车 / 点走保存、
                   Esc 取消，没有「好/取消」按钮。预填**显示名**（非受控），清空提交
                   = 回退；`placeholder` 就是那时候露出来的"会变回这个名字"。 */
                <input
                  className="session-rename"
                  autoFocus
                  defaultValue={sessionTitle(s)}
                  placeholder={sessionTitle(s)}
                  maxLength={60}
                  aria-label="对话名字"
                  onBlur={(e) => void doRename(s.id, e.target.value)}
                  onKeyDown={(e) => {
                    // ⚠️ `isComposing`：中文输入法**选词**也是回车 —— 不挡的话
                    //    用户打个"海边"选词，名字会半截存成"海"（一声不吭）。
                    if (e.key === 'Enter' && !e.nativeEvent.isComposing)
                      void doRename(s.id, (e.target as HTMLInputElement).value)
                    if (e.key === 'Escape') setRenaming(null)
                  }} />
              ) : confirming === s.id ? (
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
                <>
                  {/* ⚠️ 「改名」挂 `.session-act` 而**不是** `.session-del`：后者的
                      悬停是红色的（危险的语言），改名不危险。见 styles.css。 */}
                  <button className="session-act"
                          onClick={() => { setRenameFailed(null); setRenaming(s.id) }}>改名</button>
                  <button className="session-del"
                          onClick={() => { setConfirming(s.id); setDelFailed(null) }}>删除</button>
                </>
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
