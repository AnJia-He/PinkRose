import { useEffect, useState } from 'react'
import { listWorks, fileUrl, deleteWorks } from '../api/works'
import { errorText } from '../api/client'
import { workName, matchesQuery, type WorkMeta } from '../../shared/works.ts'
import { usePagedDays } from './kit/pagedDays.ts'
import { SelectBar } from './kit/SelectBar.tsx'
// ★ 2026-10-11（设计跟进 Task 2）：打不开时的标准件（居中一句 + 「再试一次」）。
import { ErrorState } from './kit/ErrorState.tsx'
// ★ 2026-10-10：按大小排那档里每格要写大小 —— 口径和用户管理页那个用量图
//   **同一份**（'342 MB' / '1.5 GB'），别在这儿再写一个格式化。
import { formatSize } from './AccountPage'

export function GalleryPage({ onOpen }: { onOpen: (id: number) => void }) {
  /** null = 还没拿到。**它和"没有作品"是两件事** —— 混在一起的话，
   *  还没加载完的那一瞬间会显示"还没有作品"，用户会以为东西没了。 */
  const [works, setWorks] = useState<WorkMeta[] | null>(null)
  const [failed, setFailed] = useState<string | null>(null)
  const [q, setQ] = useState('')
  /**
   * ★ 2026-10-10：**排序**。加它的来路：空间要满的时候（5 GB 配额，用户管理页
   * 会提醒），用户要来这儿找"谁最占地方" —— 按大小降序、每格把大小写出来。
   * ⚠️ 按大小**不分天**：分组的前提是时间序（同一天的聚在一起）；按大小还分天
   *   的话，"最大的那几张"会散在几十个组里，一眼扫不出来。
   */
  const [sort, setSort] = useState<'time' | 'size'>('time')
  /**
   * ★ 2026-10-10：**选择模式**（多选批删）。形状照对话列表（`SessionsPage`）：
   * 开着的这一档里每格左上角一颗勾选框、点格子 = 勾选（**不打开**详情）、
   * 底下吸一条操作条（`kit/SelectBar`，同一个组件）。
   * 删除走**批量接口** `deleteWorks`（一次往返；它自己在服务端逐条删、如实回报）。
   */
  const [selecting, setSelecting] = useState(false)
  /** 勾了哪几张。**出去就清空**；删失败时保留 —— 直接再点一次【删除】就是重试。 */
  const [selectedIds, setSelectedIds] = useState<number[]>([])
  /** 批删的就地确认开着没有（删前一律先问 —— 一张作品也是花过钱的图）。 */
  const [confirmAsk, setConfirmAsk] = useState(false)
  /** 删这一趟在飞。两颗按钮全禁用，防连点。 */
  const [deleting, setDeleting] = useState(false)
  /** 删失败。⚠️ 和 `failed` 分开：那句是"整页读不出来"（整页就是它），
   *  这一句只加在列表**上面**，名单原样不动（照 SessionsPage 的 `delFailed`）。 */
  const [delFailed, setDelFailed] = useState<string | null>(null)

  /**
   * 「再试一次」的扳机（★ 2026-10-11）：把它加一，下面那个 effect 就重跑一趟。
   *
   * ⚠️ 为什么是"重跑 effect"而不是把加载那段提成一个函数：那份 `alive` 闸
   *   （卸载后不许 setState）**只对着它自己那次 effect 的清理时机**才对得上 ——
   *   提出来之后"什么时候算过期"就得在函数里另写一套判断，两套迟早对不上。
   */
  const [reload, setReload] = useState(0)

  useEffect(() => {
    let alive = true
    listWorks().then(
      (ws) => { if (alive) setWorks(ws) },
      (e) => { if (alive) setFailed(errorText(e, '打不开作品集')) },
    )
    return () => { alive = false }
  }, [reload])

  /** 「再试一次」：清掉那句错误（屏幕当场换回"正在打开…"）、重跑加载。 */
  function retry() {
    setFailed(null)
    setReload(n => n + 1)
  }

  /** 按天分组 + 分页 + 滚到底的哨兵：和对话列表**同一套**（`kit/pagedDays`）。 */
  const { now, groups, shown, more, sentinel, resetLimit } = usePagedDays(works, q, matchesQuery)

  /** 退出选择模式（「取消」和"删完"都走它）：勾清空、确认条收掉。 */
  function exitSelect() {
    setSelecting(false)
    setSelectedIds([])
    setConfirmAsk(false)
  }
  /** 勾 / 取消勾一张（勾选框、整格两个入口都走它）。 */
  function togglePick(id: number) {
    setSelectedIds(ids => ids.includes(id) ? ids.filter(x => x !== id) : [...ids, id])
  }

  /**
   * 批量删：**一次请求**（`deleteWorks` 就是为它准备的批量接口 —— 它在服务端
   * 逐条删、如实回报 `{ deleted, missing }`，见 `server/works.ts`）。
   *
   * `missing`（服务端说"它本来就不在"）也当场清掉 —— **目标已达成**，
   * 对用户来说结果一样是"它没了"。
   *
   * ⚠️ **失败不清场**：名单原样、勾保留（直接再点一次就是重试）。服务端那边
   *   已经删掉的几张要等下次刷新才消失 —— 这是**有意的**：宁可让用户看到旧
   *   名单再点一次，也不装作"都删干净了"（这个项目最恨的那种失败：错了不报错）。
   */
  async function doBatchDelete() {
    setConfirmAsk(false)
    setDelFailed(null)
    setDeleting(true)
    try {
      const { deleted, missing } = await deleteWorks(selectedIds)
      const gone = new Set([...deleted, ...missing])
      setWorks(ws => ws?.filter(w => !gone.has(w.id)) ?? null)
      exitSelect()
    } catch {
      // ⚠️ 文案**自己造**，不走 `errorText` —— 那个让服务端的 message 优先，
      //   而服务端那句（"服务器开小差了"之类）说不出"再试一次"这条**出路**，
      //   §3.7 要的正是它（照 SessionsPage 批删那条先例）。
      setDelFailed('没删完，再试一次？')
    } finally {
      setDeleting(false)
    }
  }

  /** 按大小的那份名单（搜索照样管它 —— 名字过滤在哪一档都成立）。
   *  `filter` 先复制，`sort` 动的不是 state 里那一份。 */
  const sizeList = works
    ? works.filter(w => matchesQuery(w, q, now)).sort((a, b) => b.bytes - a.bytes)
    : []

  /** 一格作品 —— 按天分组和按大小两处共用（`showSize` 只在按大小那一档开）。 */
  function workCell(w: WorkMeta, showSize = false) {
    const name = workName(w, now)
    return (
      <div key={w.id} className="gallery-item">
        {/* ⚠️ 选择模式里点整格 = **勾选，不是打开**（微信式：那一档里没有
            "进去看看"这回事）。 */}
        <button className="gallery-cell"
          onClick={() => (selecting ? togglePick(w.id) : onOpen(w.id))}>
          {/* loading="lazy"：60 张不用一次全下载 */}
          <img className="gallery-thumb" src={fileUrl(w)} alt={name} loading="lazy" />
          <span className="gallery-name">{name}</span>
          {showSize && <span className="gallery-size">{formatSize(w.bytes)}</span>}
        </button>
        {/* ★ 选择模式里那颗勾选框。⚠️ 它**不能放进 button 里**（HTML 不允许交互
            元素套交互元素）—— 它是格子的**兄弟**，绝对定位压在图的左上角。
            系统原生那款（和对话列表同一款），颜色跟主色走。 */}
        {selecting && (
          <input type="checkbox" className="gallery-pick"
            checked={selectedIds.includes(w.id)} disabled={deleting}
            onChange={() => togglePick(w.id)}
            aria-label="选中这张作品" />
        )}
      </div>
    )
  }

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
        {/* ★ 2026-10-10：排序切换 + 「多选」。
            · 排序那颗写的是**目标**（现在是按时间的，它写「按大小」）——
              点一下就切过去，比写当前态少一层猜；
            · 选择模式开着、或者压根没有作品时两颗都收掉（不留点了没用的按钮，
              和对话列表"那一档里辅助条全收"同一条规矩）。 */}
        {!selecting && works && works.length > 0 && (
          <>
            <button className="gallery-sort"
                    onClick={() => setSort(s => (s === 'size' ? 'time' : 'size'))}>
              {sort === 'size' ? '按时间' : '按大小'}
            </button>
            <button className="gallery-multi"
                    onClick={() => {
                      setSelectedIds([])
                      setConfirmAsk(false)
                      setDelFailed(null)
                      setSelecting(true)
                    }}>多选</button>
          </>
        )}
      </header>

      {failed && (
        /* ★ 2026-10-11（设计跟进 Task 2）：错误态就是**整页那一件**（居中 +
            一颗能点的出口），不再是"左上角一行红字 + 一句空话"。
            换掉的那句话是「刷新一下页面，再试一次。」—— 它把出路全押在
            **整页刷新**上：用户在这一屏之外的东西（还没存的那张照片）会被
            一起冲掉，而我们明明可以只把这一趟请求重跑一遍。
            旧口径说"§3.7 要的是告诉用户怎么办，而刷新是用户本来就会的"——
            现在按钮替他把那句话说完了，而且是真的做了那件事。 */
        <ErrorState text={failed} onRetry={retry} />
      )}
      {/* ★ 2026-10-10：删失败那一句只加在列表**上面**，名单原样（照 SessionsPage）。 */}
      {delFailed && <p className="gallery-error">{delFailed}</p>}
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

      {sort === 'size' ? (
        /* ★ 2026-10-10 按大小：**不分天、不分页**（分页是给"按时间翻旧账"用的；
           这一档是"一眼找最大的"，一次全摆出来 —— 图本来就 lazy）。 */
        <>
          {works && sizeList.length === 0 && (
            <p className="gallery-none">没找到。换个字试试？</p>
          )}
          {sizeList.length > 0 && (
            <div className="gallery-day">
              <h2 className="gallery-day-title">按大小 · {sizeList.length} 张</h2>
              <div className="gallery-grid">
                {sizeList.map(w => workCell(w, true))}
              </div>
            </div>
          )}
        </>
      ) : (
        <>
          {works && works.length > 0 && groups.length === 0 && (
            <p className="gallery-none">没找到。换个字试试？</p>
          )}

          {shown.map(g => (
            <div key={g.day} className="gallery-day">
              {/* 标题上的张数是**这一天的全部张数**，和下面摆出来的数量一致 ——
                  这也是 visibleGroups 按天取整的理由 */}
              <h2 className="gallery-day-title">{g.label} · {g.works.length} 张</h2>
              <div className="gallery-grid">
                {g.works.map(w => workCell(w))}
              </div>
            </div>
          ))}

          {/* ⚠️ 那个圈**必须转**：没有它，用户会以为到底了（§3.5） */}
          {more && <div ref={sentinel} className="gallery-more">正在取…</div>}
          {!more && groups.length > 0 && <p className="gallery-end">没有更多了</p>}
        </>
      )}

      {/* ★ 2026-10-10：选择模式底下那条操作条（和对话列表**同一个组件** ——
          这一页只是操作对象是"张"、scope 是 `gallery`）。
          它是 `.gallery`（滚动区）的最后一个孩子 + sticky 吸底。 */}
      {selecting && (
        <SelectBar scope="gallery" count={selectedIds.length} busy={deleting} unit="张"
          askNote={confirmAsk ? `删掉选中的 ${selectedIds.length} 张？删了就找不回来了。` : null}
          onAsk={() => setConfirmAsk(true)}
          onConfirm={() => void doBatchDelete()}
          onExitAsk={() => setConfirmAsk(false)}
          onExit={exitSelect} />
      )}
    </section>
  )
}
