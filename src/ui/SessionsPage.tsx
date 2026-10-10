import { useEffect, useState } from 'react'
import { MoreHorizontal } from 'lucide-react'
import { Btn } from './kit/Btn.tsx'
import { RenameInput } from './kit/RenameInput.tsx'
import { usePagedDays } from './kit/pagedDays.ts'
import { SelectBar } from './kit/SelectBar.tsx'
import { listSessions, deleteSession, updateSession, sessionThumbUrl } from '../api/sessions'
import { errorText } from '../api/client'
import { sessionTitle, sessionMatchesQuery, type SessionMeta } from '../../shared/sessions.ts'

/**
 * 对话列表：**过程**的家（§6.1）。
 *
 * 「修图」是现在这一次，「作品」是结果，这一页是"我改过哪些" —— 三样是三件事。
 *
 * ⚠️ 分组和分页**复用作品页那一套**（`groupByDay` + `visibleGroups`）：
 *    复制一份出来的话，同一天会在两页里显示成两个名字，而且没人会同时看着两页。
 */
export function SessionsPage({ onOpen, onNew, onDeleted, generating }: {
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
  /**
   * ★ 2026-10-10：**现在有一版还在算**（App 里是 `busy === BUSY_GENERATING`）。
   *
   * 用它做**切会话前的事前拦截**：那十几秒里点另一条行的话，生成的结果回来时
   * 底图已经换了、会被丢弃（钱白花）—— 先问一句"还在算的那一版，现在切走就
   * 不要了"，用户知情了再走。没在算时一个字都不多问。
   */
  generating: boolean
}) {
  /** null = 还没拿到。**它和"一条都没有"是两件事** —— 混在一起的话，
   *  还没加载完的那一瞬间会显示"还没改过照片"，用户会以为东西没了。 */
  const [rows, setRows] = useState<SessionMeta[] | null>(null)
  /**
   * ★ 2026-10-07：**搜索框里那几个字**。加它的来路是"同一类页面两个规矩" ——
   * 作品页一直能搜（按名字/日期），这一页不能。八家 AI 产品的会话列表里六家
   * 也都有搜索（ChatGPT/Gemini 还搜全文），所以这一格是补齐，不是发明。
   * 匹配规则在 `sessionMatchesQuery`（名字，或者那一天的日期）。
   */
  const [q, setQ] = useState('')
  /** 拉列表失败。**整页就是它** —— 名单都没有，"列表还在不在"无从谈起。 */
  const [failed, setFailed] = useState<string | null>(null)
  /**
   * 删失败。⚠️ **和 `failed` 分开**（计划里原本共用一个，这里改了）：
   * 共用的后果是删一条失败会把**整页换成一行字** —— 名单明明还在手里，
   * 用户看到的却是"我的对话全没了"，一次网络抖动就能吓人一跳。
   * 所以这一条是列表**上面**加一句，列表原样不动。
   */
  const [delFailed, setDelFailed] = useState<string | null>(null)
  /** 正在问"这条要删掉吗"的是哪一条。**就地确认，不弹系统框**（这个产品的规矩） */
  const [confirming, setConfirming] = useState<number | null>(null)
  /** 正在改名字的是哪一条。**手势和作品详情页那颗「改名」同一套**：
   *  回车 / 点走保存，Esc 取消（见 `WorkDetailPage.doRename`）。 */
  const [renaming, setRenaming] = useState<number | null>(null)
  /** 改名失败。⚠️ 和 `delFailed` 同一套：列表上面加一句，**名单原样不动** */
  const [renameFailed, setRenameFailed] = useState<string | null>(null)
  /**
   * ★ 2026-10-06 下午：**哪一行的「…」菜单开着**（null = 都收着）。
   *
   * 用户原话：「我看豆包是这种做法，放个这个图标在每段对话的最后，点击这个
   * 符号后里面有删除选项」—— 原来行尾并排两颗裸按钮（改名 / 删除），现在收进
   * 这一条菜单里。一个数装全部状态 = 一次只开一条（两条菜单并排挂着的话，
   * 点「删除」删的是哪一条会变得要猜）；再点一下「…」收起。
   */
  const [menuId, setMenuId] = useState<number | null>(null)

  /**
   * ★ 2026-10-06 下午：**选择模式**（多选批删）。开着的这一档里：每行一个勾选框
   * （点行 = 勾选、**不打开会话**）、行尾的「…」全收、底下吸着一条操作条。
   * 进去的路只有一条：某行菜单里的【多选】。
   */
  const [selecting, setSelecting] = useState(false)
  /** 勾了哪几条。**出去就清空**；部分失败时剩下的就是"还没删掉的那些"。 */
  const [selectedIds, setSelectedIds] = useState<number[]>([])
  /** 批量删除的**就地确认**开着没有（删前一律先问 —— 一条会话比一句话重得多）。 */
  const [confirmAsk, setConfirmAsk] = useState(false)
  /** 批删的循环正在跑（逐条 await）。跑着的时候按钮全禁用 —— 防连点。 */
  const [deleting, setDeleting] = useState(false)
  /**
   * ★ 2026-10-10：**"生成中切走"的就地确认**问的是哪一条（null = 没问）。
   * 和 `confirming`（"删掉这条？"）同一个形状：一次只问一条、就地展开、不弹窗。
   */
  const [cutaway, setCutaway] = useState<number | null>(null)

  /** 退出选择模式（「取消」和"全删成功"都走它）：勾清空、确认条收掉。 */
  function exitSelect() {
    setSelecting(false)
    setSelectedIds([])
    setConfirmAsk(false)
  }
  /** 勾 / 取消勾一条（勾选框、整行两个入口都走它）。 */
  function togglePick(id: number) {
    setSelectedIds(ids => ids.includes(id) ? ids.filter(x => x !== id) : [...ids, id])
  }

  /**
   * 批量删：**逐条调现成的 `deleteSession`**（服务端零改动 —— 和单条那条走的是
   * 同一个接口，删目录 / 连着缩略图一起收拾那套它自己会做）。
   *
   * ⚠️ **部分失败不清场**：删成功的当场从名单里拿掉，没删掉的**留在列表和勾里**，
   *   上面加一句"有 N 条没删掉"—— 用户直接再点一次【删除】就是重试。
   *   全军覆没装作没事、或"没删掉却装作删掉了"，都是这个项目最恨的那类失败
   *   （错了不报错，只是悄悄丢东西）。
   */
  async function doBatchDelete() {
    setConfirmAsk(false)
    setDelFailed(null)
    setDeleting(true)
    const failed: number[] = []
    for (const id of selectedIds) {
      try {
        await deleteSession(id)
        // 当场从名单里拿掉（和单条那条一个道理：等下次刷新才消失，用户会以为没删掉）
        setRows(rs => rs?.filter((r) => r.id !== id) ?? null)
        // 每成功一条喊一声 —— App 靠它判断"删的是不是手上那条"
        onDeleted(id)
        setSelectedIds(ids => ids.filter((x) => x !== id))
      } catch {
        failed.push(id)
      }
    }
    setDeleting(false)
    if (failed.length > 0) {
      setDelFailed(`有 ${failed.length} 条没删掉，再试一次？`)
      return
    }
    exitSelect()
  }
  useEffect(() => {
    let alive = true
    listSessions().then(
      (rs) => { if (alive) setRows(rs) },
      (e) => { if (alive) setFailed(errorText(e, '打不开对话列表')) },
    )
    return () => { alive = false }
  }, [])

  /** 按天分组 + 分页 + 滚到底的哨兵：和作品页**同一套**（`kit/pagedDays`）。
   *  （"现在"那份只喂给分组，这一页自己不用，所以不解构出来。） */
  const { groups, shown, more, sentinel, resetLimit } = usePagedDays(rows, q, sessionMatchesQuery)

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
      setDelFailed(errorText(e, '没删掉，再试一次？'))
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
      setRenameFailed(errorText(e, '没改成，再试一次'))
    }
  }

  // ⚠️ 四种状态**都包在 `.sessions` 里**（照 GalleryPage：它那个 `.gallery` 也是
  //    四种状态都在里面）—— 那一层既是"自己滚"的那一格，也是空态居中所要的宽度。
  //    不包的话，空态是 `.shell` 的一个 flex 孩子，宽度按内容收缩，会**贴到左上角**去，
  //    和作品页那个居中的空态长得不一样。
  /* ★ 2026-10-07：页头（标题 + 搜索框）。**四种状态里都在**（照作品页：那边的
     标题和搜索框也是常驻的）—— 最要紧的是"没找到"那一档：搜索框得自己留着，
     不然用户搜错一个字就只能刷新页面。窄屏上它会折成两行（`.gallery-head` 是
     `flex-wrap: wrap`），和作品页同一副样子。
     ⚠️ 类名走的是**作品页那一套**（`.gallery-head/title/search`，这一页本来就在
     复用 `.gallery-day-title` / `.gallery-error` / `.gallery-hint`）：同一种组件
     全站一份长相，两页各写一份迟早会长歪。 */
  const head = (
    <header className="gallery-head">
      <h1 className="gallery-title">我的对话</h1>
      <input className="gallery-search" value={q}
             placeholder="找一条…（名字，或者 9月25 这样的日期）"
             aria-label="找一条对话"
             onChange={e => { setQ(e.target.value); resetLimit() }} />
    </header>
  )

  if (failed) {
    return (
      <section className="sessions">
        {head}
        <p className="gallery-error">{failed}</p>
        {/* §3.7：说"不行"的地方，都要同时告诉他"那怎么办"。这一页**不新造按钮**，
            和作品页一样："刷新一下"是用户本来就有的那条出路。 */}
        <p className="gallery-hint">刷新一下页面，再试一次。</p>
      </section>
    )
  }
  // ★ 还没拿到（null）和拿到了但是没有（[]）**要分开说**
  if (rows === null) {
    return <section className="sessions">{head}<p className="gallery-loading">正在取…</p></section>
  }
  if (rows.length === 0) {
    return (
      <section className="sessions">
        {head}
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
      {head}
      {delFailed && <p className="gallery-error">{delFailed}</p>}
      {renameFailed && <p className="gallery-error">{renameFailed}</p>}
      {/* 搜索没命中。⚠️ 这里**不用再判 `q` 非空**：这一档里 `rows` 至少有一条，
          没有查询词时它必然分到某一天里 —— 走到这儿就说明是搜出来的空。 */}
      {groups.length === 0 && <p className="gallery-none">没找到。换个字试试？</p>}
      {shown.map(g => (
        <div key={g.day} className="sessions-day">
          {/* 标题上的条数是**这一天的全部条数**，和下面摆出来的数量一致 ——
              这也是 visibleGroups 按天取整的理由 */}
          <h2 className="gallery-day-title">{g.label} · {g.works.length} 条</h2>
          {g.works.map(s => (
            /* 行和它下面那颗「…」开出来的菜单是**一对**：菜单是行的兄弟节点
               （`.session-row` 是 flex 单行，菜单塞进去会被挤成一行里的第四格）。 */
            <div key={s.id} className="session-block">
              <div className={
                (renaming === s.id ? 'session-row renaming'
                  : confirming === s.id ? 'session-row confirming'
                    : cutaway === s.id ? 'session-row cutaway' : 'session-row')
                + (menuId === s.id ? ' menu-open' : '')}>
                {/* ★ 2026-10-06 下午：选择模式里行首那颗勾选框（用户给的那张
                    截图里就在这个位置）。系统原生那款，颜色跟主色走。 */}
                {selecting && (
                  <input type="checkbox" className="session-pick"
                    checked={selectedIds.includes(s.id)} disabled={deleting}
                    onChange={() => togglePick(s.id)}
                    aria-label="选中这段对话" />
                )}
                {/* ⚠️ 选择模式里点整行 = **勾选，不是打开**（微信式：那一档里
                    没有"进去看看"这回事）。
                    ★ 2026-10-10：**生成中点行也不直接切** —— 就地问一句
                    （那一版还在算，切走它就作废、钱白花；见 `generating`）。 */}
                <button className="session-open"
                        onClick={() => (selecting
                          ? togglePick(s.id)
                          : generating ? setCutaway(s.id) : onOpen(s.id))}>
                  {/* `alt` 给名字：图上没字，读屏软件只能靠它 */}
                  <img className="session-thumb" src={sessionThumbUrl(s.id, s.updatedAt)}
                       alt={sessionTitle(s)} loading="lazy" />
                  <span className="session-name">{sessionTitle(s)}</span>
                  <span className="session-steps">{s.stepCount} 步</span>
                </button>
                {!selecting && (renaming === s.id ? (
                  /* 改名 —— 手势（回车 / 点走保存、Esc 取消）在 `kit/RenameInput` 里，
                     作品详情页那颗「改名」和对话栏顶上那颗铅笔**是同一套**。
                     预填**显示名**（非受控），清空提交 = 回退；`placeholder` 就是
                     那时候露出来的"会变回这个名字"。 */
                  <RenameInput
                    className="session-rename"
                    defaultValue={sessionTitle(s)}
                    placeholder={sessionTitle(s)}
                    maxLength={60}
                    ariaLabel="对话名字"
                    onCommit={(v) => void doRename(s.id, v)}
                    onCancel={() => setRenaming(null)} />
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
                ) : cutaway === s.id ? (
                  /* ★ 2026-10-10：生成中切走的**事前拦截**（就地确认，照上面那套
                     的形状）。「切过去」是**普通样式不是危险色** —— 它不删东西，
                     只是"这次生成白算了"（用户刚被告知过）。 */
                  <>
                    <span className="session-ask">还在算的那一版，现在切走就不要了。</span>
                    <button className="session-del" onClick={() => onOpen(s.id)}>切过去</button>
                    <button className="session-del" onClick={() => setCutaway(null)}>再等等</button>
                  </>
                ) : (
                  /* ★ 2026-10-06 下午：行尾就这一颗「…」（原来并排的「改名」
                     「删除」收进了它点开的菜单）。图标键 —— `aria-label` 是读屏
                     和"按标签找元素"的唯一依据；`aria-expanded` 报开合。 */
                  <button className="session-more" aria-label="更多操作"
                    aria-expanded={menuId === s.id}
                    onClick={() => setMenuId(cur => (cur === s.id ? null : s.id))}>
                    <MoreHorizontal size={15} strokeWidth={1.5} aria-hidden="true" />
                  </button>
                ))}
              </div>
              {/* ★ 菜单（就地展开、不弹浮层；长相和对话区那条 `.msg-menu` 故意一样） */}
              {menuId === s.id && (
                <div className="session-menu">
                  <button className="session-menu-act"
                          onClick={() => { setMenuId(null); setRenameFailed(null); setRenaming(s.id) }}>改名</button>
                  {/* ★ 2026-10-06 下午：进选择模式（【删除】还是排最后 —— 危险的那项
                      永远在最下面，手机桌面都是这么排的）。 */}
                  <button className="session-menu-act"
                          onClick={() => {
                            setMenuId(null)
                            setSelectedIds([])
                            setConfirmAsk(false)
                            setSelecting(true)
                          }}>多选</button>
                  <button className="session-menu-del"
                          onClick={() => { setMenuId(null); setConfirming(s.id); setDelFailed(null) }}>删除</button>
                </div>
              )}
            </div>
          ))}
        </div>
      ))}

      {/* ⚠️ 那个圈**必须转**：没有它，用户会以为到底了（§3.5） */}
      {more && <div ref={sentinel} className="sessions-more">正在取…</div>}
      {!more && groups.length > 0 && <p className="sessions-end">没有更多了</p>}

      {/* ★ 2026-10-06 下午：**选择模式底下那条操作条**。它是滚动区的最后一个
          孩子 + `position: sticky; bottom: 0` —— 不管滚到哪儿它都吸在视野底下
          （勾了一段滚下去找按钮的事不该发生），滚到底就归位。
          两副面孔和"只有确认那颗穿危险色"的规矩在 `kit/SelectBar` 里
          （和对话区那条同一份）。 */}
      {selecting && (
        <SelectBar scope="sessions" count={selectedIds.length} busy={deleting}
          askNote={confirmAsk ? `删掉选中的 ${selectedIds.length} 条？删了就找不回来了。` : null}
          onAsk={() => setConfirmAsk(true)}
          onConfirm={() => void doBatchDelete()}
          onExitAsk={() => setConfirmAsk(false)}
          onExit={exitSelect} />
      )}
    </section>
  )
}
