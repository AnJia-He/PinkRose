import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { SuggestCard } from '../../shared/protocol.ts'
import type { LutMeta, LutRef } from '../../shared/lut.ts'
import { MoreHorizontal, Plus, RotateCw, SlidersHorizontal } from 'lucide-react'
import LutPicker from './LutPicker.tsx'

export type ChatMessage = {
  id: number
  role: 'user' | 'assistant'
  text: string
}

/**
 * ★ 2026-10-06（用户反馈：「当用户进行提问时对话区是不会自动向下滚动的」）：
 * **离底多近还算"贴着底"**（像素）。滚轮一格大约 100px —— 取 80 的意思是
 * "就差一点点"也算贴着，别因为差几个像素就不跟了。
 */
const STICK_PX = 80

type Props = {
  messages: ChatMessage[]
  cards: SuggestCard[]
  /** 非 null 时显示"正在…"气泡，并禁用发送和卡片 */
  busy: string | null
  /** 正在等建议卡片。**它不拦人** —— 只是在这一格上挂一句"正在看…"，
   *  发送键照常能按（见 App.tsx 的 SUGGEST_WAIT_MS 那段）。 */
  suggesting: boolean
  onSend: (text: string) => void
  /** 按「停止」—— 掐掉正在跑的那一次生成（见 App.tsx 的 stopGeneration）。
   *  只在 `busy` 时会出现：那一格平时是「发送」。 */
  onStop: () => void
  onCard: (card: SuggestCard) => void
  /** ★ 2026-10-03：用户**在欢迎页的对话区里先打的那句话**（没有就是空串）。
   *  它只做一件事：把它填进下面那个输入框，用户按一下发送就行 ——
   *  这也是为什么输入框是**受控之外的**（uncontrolled）：填值靠 `defaultValue` +
   *  `key`（draft 一变就重挂一次），用户打字之后 DOM 里的值不归 React 管，
   *  和这个 form 原来的写法一致。 */
  draft?: string
  /** 点「再来一版」—— 同一句话重掷一次（见 App.tsx 的 onRerun）。 */
  onRerun: (id: number) => void
  /** 哪几步**记着当初那句话**（= 能重掷的那些）。原图不在里面。 */
  rerunnable: number[]
  /**
   * 哪几条消息身后**挂着一步**（步骤 id 就是那条助手消息的 id，老约定）。
   * ★ 2026-10-06（晚）：它原来还管着「回到这一步」那颗按钮；那两颗文字提示
   *   撤掉之后，这里只剩一个用处 —— 单条删除时要判断"这条身后有没有一步"
   *   （带步骤那条删之前先问一句）。
   *   ⚠️ **屏幕上的"你在哪一步 / 回到哪一步"现在归照片区上方那圈转盘**
   *   （`ui/StepStrip`）—— 别在这儿再长回一排文字按钮。
   */
  jumpableIds: number[]
  /** 图上点选这条流程开着（正等着点、或者已经点过了）—— 两个按钮就出现。 */
  marking: boolean
  /** 已经点过图了，可以确认。**点「就改这里」才真正花钱**，所以它单独一个开关。 */
  canConfirmMark: boolean
  onConfirmMark: () => void
  onCancelMark: () => void
  /** 后面还有几步（站在最新一步时是 0）。>0 时两条确认条都要提醒"会切掉它们"。 */
  futureSteps: number
  /** 从旧步骤再改的确认条挂着没有（见 App 的 `pendingReplace`）。 */
  replacing: boolean
  onConfirmReplace: () => void
  onCancelReplace: () => void
  /** ★ 2026-10-05（滤镜，Task 9）：对话区这颗按钮用同一套格子。
   *  命名和 `AdjustmentPanel` 那边**一模一样** —— 两处是同一批东西，
   *  名字不同只会让人以为来源不同（它们其实是 App 里那同一个 `lutsApi` + `lut`）。 */
  luts: readonly LutMeta[]
  /** ★ 2026-10-05 终审修复：清单**到手了没有**（看 `LutPicker` 的 `lutsKnown`）。 */
  lutsKnown: boolean
  lut: LutRef | null
  lutThumbs: { none: string | null; byId: Record<number, string> }
  onPickLut: (lutId: number | null) => void
  onLutAmount: (amount: number) => void
  /** 打开那一刻才去要缩略图（很贵，别在收着时白画，见微调区同款注释）。 */
  onNeedLutThumbs: () => void
  /** 一个滤镜都没有时那颗「去导入」。 */
  onGoImport: () => void
  /** 清单没到手时那颗「再试一次」（重拉一次清单）。 */
  onRetryLuts: () => void
  /**
   * ★ 2026-10-06（用户原话：「在会话里的单条记录我怎么还是没有删除的按钮」）：
   * **「原图」那一步的消息 id** —— 它的消息上**不摆**「…」（它是这条会话的锚）。
   * 欢迎语和原图那一步是同一条消息（同一个 id），所以欢迎那条也没有「…」——
   * 这是对的：删了它，这一屏就没有落脚的地方了。
   * `null` = 还没有原图（没有会话 / 没有照片）。
   */
  originalId: number | null
  /**
   * 点某条消息菜单里的【删除】→ 请 App 把这条记录删掉。
   *
   * ⚠️ **带图那条不直接调它**：那一条身后挂着一整步（图 / 参数 / 滤镜），
   *   点【删除】先在**就地问一句**（上面的 `confirmingId`，照 SessionsPage /
   *   作品详情页那套"不弹窗"的规矩），点「确认删除」才走到这个回调。
   *   纯文字那条（身后没有一步）不用确认，一点就删 —— 删错一句话的代价
   *   和删掉一张花过钱的图不是一回事。
   */
  onDeleteMessage: (id: number) => void
  /**
   * ★ 2026-10-06 下午（他的第二问：「是像这样可选择性的删除吗？」——一张勾选框
   * 截图；控制器问过之后他选的是"两个都要"）：**一次删好几条**（选择模式里点
   * 「确认删除」/「删除」走到这儿）。
   *
   * 和单条那条**是同一本账**：App 里 `onDeleteMessage` 就是它删一条的特例
   * （`onDeleteMessages([id])`）—— 光标、底图号、位图回收只有一份实现。
   * ⚠️ 删前那一问仍由 ChatPanel 做（它才看得见"勾的里面有几步带图"）——
   *   走到这里就是用户已经点过「确认删除」（或者勾的全是纯文字）。
   */
  onDeleteMessages: (ids: number[]) => void
}

export default function ChatPanel({
  messages, cards, busy, suggesting, onSend, onStop, onCard, onRerun, rerunnable,
  jumpableIds, marking, canConfirmMark, onConfirmMark, onCancelMark, draft,
  futureSteps, replacing, onConfirmReplace, onCancelReplace,
  luts, lutsKnown, lut, lutThumbs, onPickLut, onLutAmount, onNeedLutThumbs, onGoImport, onRetryLuts,
  originalId, onDeleteMessage, onDeleteMessages,
}: Props) {
  // ★ 2026-10-05：**输入框那颗加号**（用户截图 + 原话「我觉得在对话框那边设一个
  //   加号，然后点击加号里面有滤镜以及以后添加的功能」）。
  //
  //   两级开关：`toolsOpen` 是加号自己（那一行工具），`lutOpen` 是「滤镜」这个
  //   **工具本身**的格子。分成两级是用户点名要的形状 —— 加号的意思是"这儿还有
  //   别的东西"，以后加新工具就往那一行排，不用再动输入框。
  //   两个都默认收着：它摆在输入框上面，句句话都摊开着一整排格子太吵。
  const [toolsOpen, setToolsOpen] = useState(false)
  const [lutOpen, setLutOpen] = useState(false)

  /**
   * ★ 2026-10-06：正在问"要删这条记录吗"的是哪一条（null = 没在问）。
   *
   * 只有**带图那条**（身后有一步）会走到这儿 —— 它删掉的是花过钱的一整步
   * （图 / 参数 / 滤镜都挂在上面），所以先就地问一句；纯文字那条点 ✕ 直接删。
   * **就地确认，不弹系统框**（和 SessionsPage / 作品详情页同一条产品规矩：
   * 这个界面上没有弹窗文化）。一次只问一条：这个数就是全部状态。
   */
  const [confirmingId, setConfirmingId] = useState<number | null>(null)

  /**
   * ★ 2026-10-06：**哪一条的「…」菜单开着**（null = 都收着）。
   *
   * 「…」是那条菜单**唯一**的开关（再点一下收起，和输入框那颗加号同一个逻辑）；
   * 一个数装全部状态 = 一次只开一条 —— 两条菜单并排挂着的话，"点删除"删的是
   * 哪一条会变得要猜。菜单里现在是【多选】【删除】两项（危险的那项排最后），
   * 以后再加也是往这一条里排，不用在消息末尾越堆越多。
   *
   * ★★ 2026-10-06（更晚，用户截图报的：「**我正常点击省略号，选项却是在下面**」）。
   *
   * 那个"下面"是**滚动区外面**：菜单是**就地展开**的（`.msg` 的孩子、排在
   * 操作行下面），所以点**最后一条**消息的「…」时它会长到 `.chat-log` 的下沿之外
   * —— 真机量过：菜单 65×75.5、**伸出滚动区 68px**。屏幕上看到的是"按钮亮了、
   * 菜单没出来"（要自己往下滚才看得见），正是他截的那张图。
   *
   * 修法见下面那条 `useLayoutEffect`（开的那一帧把它带进视野）。
   * ⚠️ **不做成"没地方就朝上弹"**：就地展开是要长高的，翻上去会把那颗「…」
   *   连同气泡一起往下推 76px —— 用户刚点的按钮自己跑掉，比滚动更糟。
   * ⚠️ 只有一条菜单会同时存在（`menuId` 一次只装一个 id），所以一个 ref 就够。
   */
  const [menuId, setMenuId] = useState<number | null>(null)

  /**
   * ★ 2026-10-06 下午：**选择模式**（多选批删）。开着的那一档里：
   *   · 每条消息旁一个勾选框（「原图」那条没有 —— 它是锚）、别的按钮全收；
   *   · 输入框让位给操作条「已选 N 条 ｜ 删除 ｜ 取消」。
   * 进去的路只有一条：某条消息菜单里的【多选】（豆包 / 微信都是这个进法）。
   * ⚠️ `busy` 时进不来（那颗「…」是灰的）—— 所以这一档里不必再防"生成中"，
   *   发号的那条路（输入框、卡片）也整体不渲染了。
   */
  const [selecting, setSelecting] = useState(false)
  /** 勾了哪几条（消息 id）。**出去就清空** —— 再进来是新一轮，不带着上次的勾。 */
  const [selectedIds, setSelectedIds] = useState<number[]>([])
  /** 批量删除的**就地确认**开着没有（勾里有带图的步骤才会走到它）。 */
  const [batchAsk, setBatchAsk] = useState(false)

  /** 勾 / 取消勾一条（勾选框、气泡两个入口都走它）。 */
  function togglePick(id: number) {
    setSelectedIds(ids => ids.includes(id) ? ids.filter(x => x !== id) : [...ids, id])
  }
  /** 退出选择模式（「取消」和"删完"都走它）：勾清空、确认条收掉。 */
  function exitSelect() {
    setSelecting(false)
    setSelectedIds([])
    setBatchAsk(false)
  }
  /** 勾的里面有几步是**带图的**（就是确认那句里"几张生成过的图"那个数）。 */
  const stepCount = selectedIds.filter(id => jumpableIds.includes(id)).length
  /** 点【删除】：勾里有带图的步骤 → 先问一句；全是纯文字 → 直接删（同单条规矩）。 */
  function askBatchDelete() {
    if (selectedIds.length === 0) return
    if (stepCount > 0) { setBatchAsk(true); return }
    doBatchDelete()
  }
  function doBatchDelete() {
    onDeleteMessages(selectedIds)
    exitSelect()
  }

  /**
   * 这一栏**开着**的时候去要缩略图（很贵：每个滤镜各画一张当前照片）。
   *
   * ⚠️ 和微调面板里那条**同一条**（那边 2026-10-05 真机抓到过一次）：光在
   *    "点开那一刻"叫一次是不够的 —— 清单**晚到一步**（用户在「滤镜」那页导完
   *    直接过来）时，那一次一条都画不出来，而**再没有东西会叫第二次**：
   *    用户看到的是一栏开着、格子全是灰方块，永远不变。
   * ⚠️ 清单是空的时不叫：那种时候这一栏显示的是「还没有导入过滤镜。」
   *    （或者「清单还没到手」），一张缩略图都用不上。
   */
  /**
   * ★ 2026-10-06：对话区**跟着新消息往下走**（用户反馈：「当用户进行提问时对话区
   * 是不会自动向下滚动的」—— 这套从来没写过）。语义照主流聊天产品那一套：
   *   · **贴着底**时新内容出现 → 跟着滚（下面那条 effect 盯着 messages / busy：
   *     自己的话、「正在思考…」、回复，一样都不落）；
   *   · **翻上去读历史**时不把人拽下来（`atBottomRef` 由 scroll 事件维护，
   *     离底 < `STICK_PX` 才算"贴着"）—— 生成要十几秒，翻旧账是常事；
   *   · **自己按发送** = 表态要看最新的 → 无条件重新贴底（见下面表单的 onSubmit）。
   *
   * ⚠️ 是**直接赋值** `scrollTop`、不是 `scrollTo({ behavior: 'smooth' })`：
   *   内容会连着变好几次（用户的话 → 「正在…」那条 → 回复），平滑动画互相打断
   *   只会停在半路。也没有 `scroll-behavior: smooth`（CSS 里全局都没有）。
   */
  const logRef = useRef<HTMLDivElement | null>(null)
  /** 现在贴着底吗。初始 `true` —— 一进来 / 刚接回来一条会话，看的就该是最新的。 */
  const atBottomRef = useRef(true)
  // 监听滚动，维护"贴着底没有"。⚠️ `passive`：滚动是高频事件，不写的话
  // 浏览器要等这个处理器（哪怕它不 preventDefault）才能滚，白白卡一帧。
  useEffect(() => {
    const el = logRef.current
    if (!el) return
    const onScroll = () => {
      atBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < STICK_PX
    }
    el.addEventListener('scroll', onScroll, { passive: true })
    return () => el.removeEventListener('scroll', onScroll)
  }, [])
  /** 内容变了就贴一次。
   *  ★ 2026-10-06（晚）：`thumbs` / `generating` 从依赖里撤了 —— 图不再
   *    挂进对话区（它们现在住在照片区上方那条时间轴上），这一栏的高度
   *    只随**话**变（自己的话、「正在…」那条、回复）。 */
  useEffect(() => {
    const el = logRef.current
    if (el && atBottomRef.current) el.scrollTop = el.scrollHeight
  }, [messages, busy])

  /**
   * ★★ 2026-10-06：「…」菜单开的那一帧，把它**带进视野**（理由是上面 `menuId`
   * 那段——最后一条消息的菜单会伸出 `.chat-log` 下沿之外，实测 68px）。
   *
   * ⚠️ 三个约束，别改：
   *   · `useLayoutEffect` 不是 `useEffect` —— 后者在**画完之后**才跑，
   *     会先看见一帧"菜单被裁掉"再跳一下；
   *   · **只滚够用的那一点**（`over`），已经在视野里就是 0、一动不动；
   *   · 用 `getBoundingClientRect` + 直接写 `log.scrollTop`，**不用
   *     `scrollIntoView`** —— 两个理由：它会把**外面**的祖先（整页）也一起滚，
   *     而我们只该动这一格；jsdom 里也压根没有这个方法（测试会当场炸）。
   *     替成 rect 之后在 jsdom 里天然是空操作（两个 rect 全 0 → 差值 0）。
   * ⚠️ 为什么"滚一下"真的滚得动：菜单是**在流的**，它一渲染 `.chat-log` 的
   *   scrollHeight 就长了这 76px —— 有得滚，才谈得上滚出来。
   */
  const menuElRef = useRef<HTMLDivElement | null>(null)
  useLayoutEffect(() => {
    if (menuId === null) return
    const log = logRef.current, menu = menuElRef.current
    if (!log || !menu) return
    const over = menu.getBoundingClientRect().bottom - log.getBoundingClientRect().bottom
    // ⚠️ `Math.ceil` 不是洁癖：`scrollTop` 会被浏览器落成整数，差 0.4px 的话
    //    那一加等于没动 —— 菜单底边就永远差那么一丁点露在滚动区外面
    //    （真机上量到过 `伸出 0.42px`）。多滚 1px 的代价是零。
    if (over > 0) log.scrollTop += Math.ceil(over)
  }, [menuId])

  useEffect(() => {
    if (lutOpen && luts.length > 0) onNeedLutThumbs()
  }, [lutOpen, luts])
  return (
    <aside className="chat">
      <div className="chat-log" ref={logRef}>
        {messages.map(m => {
          // ★ 2026-10-06（晚）：**对话区里不再有照片**（用户原话：「对话区不留下
          //   照片了，改成像我这样的…上方是可左右滚动的历史记录照片类似于 git
          //   吧也就是回到那一步，下方对应记录的图片」）——每一步的画面现在挂在
          //   **照片区上方那条时间轴上**（`ui/StepStrip`：点哪一格就回到那一步，
          //   下面的大图跟着换），气泡只装**话**。
          //
          //   ⚠️ 记一笔它从前长什么样，免得有人照旧描述改回去：2026-10-05 到
          //     今天的形状是"一条回复分两块，文字在上、小图在下"（用户当时点名
          //     要的），今天第二块整块撤掉 —— `.bubble-thumb` / `.shot-skeleton`
          //     两条 CSS 跟着退役。**别把图挂回来**：挂回来的话屏幕上同一张画面
          //     有两处出处，"回到这一步"也会有两个入口。
          // ★ 2026-10-06：这一条身后有没有"一步"？（步骤 id 就是那条助手消息的
          //   id，老约定。）有 → 点 ✕ 要先问一句；没有 → 纯文字，一点就删。
          const isStep = jumpableIds.includes(m.id)
          // 「原图」那条（= 欢迎语，同一条消息）不摆 ✕ —— 它是这条会话的锚。
          const delable = m.id !== originalId
          /**
           * ★ 2026-10-06（更晚，用户原话：「**不用每个对话下面都有省略号，可以
           * 一段对话里有一个了，一问一答就是一段对话**」）：**「…」一轮只有一颗**，
           * 挂在**助手那句回复**上（一轮的末尾），用户自己那句话不摆 ——
           * 豆包也是这么放的（操作挂在回答底下）。
           *
           * ⚠️ 和 `delable` **是两个判据，别合并**：`delable` 管的是"这条能不能
           *   删"（批选里每一条都还勾得动、删得掉），`hasMenu` 只管"末尾摆不摆
           *   那颗「…」"。合并的话，用户那句话在**批选**里也会跟着变得不可选 ——
           *   而"一轮只有一颗「…」"不该顺手把批量删除也削掉一块。
           * ⚠️ 代价（用户点名要的）：**单删一句自己说的话**从此只能走批选
           *   （「…」→【多选】→ 勾上它 → 删除）。
           */
          const hasMenu = delable && m.role === 'assistant'
          return (
            <div key={m.id} className={`msg ${m.role}`}>
              {/* ① 话。
                  ⚠️ 选择模式里点它 = 勾选（微信式的大点击面；那一档里没有
                  文字要读——真要读字就不会开着选择模式），别的入口照旧。 */}
              <div className={`bubble ${m.role}${selecting && delable ? ' pickable' : ''}`}
                onClick={selecting && delable ? () => togglePick(m.id) : undefined}>
                <div className="bubble-text">{m.text}</div>
              </div>
              {/* ② 末尾那一排：再来一版 / 「…」。
                  ★ 2026-10-06：它不再套在 `.shot` 里了 —— 这一排是**每一轮
                  末尾**都有的（用户要的豆包式：「放个这个图标在每段对话的最后」）。
                  ★ 2026-10-06（更晚）：**一轮只有一颗「…」**，而且只挂在**助手
                  那句回复**上（`hasMenu`，理由见上面那段）—— 用户自己那句话
                  整排都不出现。「原图」那条**一颗都没有**（它不是可重掷的那一步，
                  也是这条会话的锚）。间距由 `.msg` 自己的 gap 管。
                  ★ 2026-10-06（晚）：这一排原来领头的是「回到这一步 / 你在这里」
                  —— 用户指着它说「**那这些文字提示就可以不要了**」（转盘上已经
                  写着"你在哪、回到哪一版"）。两颗一起撤了，`onJump` / `currentId`
                  两个 prop 也跟着删；**"在哪一步"这件事从此只有转盘一个出处**。
                  ★ 2026-10-06 下午：**选择模式里这一排整个让位给一颗勾选框** ——
                  平时那些按钮一个不留（选东西的时候没有别的可点，「再来一版」
                  更是花钱的，不能混在里面）。
                  ⚠️ 勾选框走的是 `delable`（**每条非原图的消息都有**，包括用户
                  自己那句）—— 和上面 `hasMenu` 那条规矩是两码事。 */}
              {selecting ? delable && (
                <div className="bubble-actions">
                  {/* ⚠️ 原生 checkbox 就够了：系统画的勾选框比自绘的有辨识度
                      （用户给的截图里就是它），颜色跟着主色走（CSS 里那行
                      `accent-color`），无障碍是免费的。 */}
                  <input type="checkbox" className="msg-pick"
                    checked={selectedIds.includes(m.id)} disabled={!!busy}
                    onChange={() => togglePick(m.id)}
                    aria-label="选中这条记录" />
                </div>
              ) : (rerunnable.includes(m.id) || hasMenu) && (
                <div className="bubble-actions">
                  {/* 「再来一版」= 同一句话重掷一次。**它不是"回到这一步"那类提示**
                      —— 它是一件真事：拿着当初那句话再花一次钱重跑（见 App 的
                      `onRerun`），所以"提示不要了"那一次把它留下了。
                      ⚠️ 忙的时候禁用：再掷一次就是两次生成同时在跑，钱是两倍
                      （当年那条注释里"「回到这一步」不禁用是有意的"那半句
                      随那颗按钮一起作废了 —— 现在这一排就它一颗是花钱的）。
                      ★ 2026-10-01：箭头以前是 CSS 的 `content: '↻'`，
                      现在是 lucide 图标。**仍然是装饰**（`aria-hidden`）：
                      图标是 svg，进不了 textContent，所以按文字找按钮的地方
                      和读屏软件看到的都只有「再来一版」这四个字。 */}
                  {rerunnable.includes(m.id) && (
                    <button className="bubble-rerun" disabled={!!busy} onClick={() => onRerun(m.id)}>
                      <RotateCw size={13} aria-hidden="true" />
                      再来一版
                    </button>
                  )}
                  {/* ★ 2026-10-06：「…」——**一直看得见**（不搞悬停才浮出来那套：
                      他这次会提，就是因为上一种入口是悬停才出现的，找不到），
                      但灰灰小小的，不跟内容抢眼。点开**就地展开**菜单，不弹浮层
                      （全站规矩）。永远排在最后一个（豆包也是主操作在前、
                      「…」收尾）。
                      ★ 判据是 `hasMenu` **不是** `delable`：**一轮只有这一颗**
                      （挂在助手那条回复上，见上面那段）—— 写成 `delable` 的话
                      用户自己那句话末尾也会长出一颗（用户 2026-10-06 更晚点名
                      不要的，就是那个）。
                      ⚠️ `aria-label` 是读屏和"按标签找元素"的唯一依据（图标键和
                      左栏「个人设置」同一条规矩）；`aria-expanded` 报开合。
                      ⚠️ `busy` 时禁用（和「就改这里」同款）：忙的时候删等于在一次
                      生成还在飞的时候动账本（App 的 `onDeleteMessage` 里还有一道
                      真闸门）。
                      ⚠️ 确认条开着时这颗收掉（`confirmingId !== m.id`）—— 那条
                      已经在问同一个问题了，两颗并存会像"删除按钮点了没反应"。 */}
                  {hasMenu && confirmingId !== m.id && (
                    <button className="msg-more" aria-label="更多操作"
                      aria-expanded={menuId === m.id} disabled={!!busy}
                      onClick={() => setMenuId(cur => (cur === m.id ? null : m.id))}>
                      {/* 图标不进 textContent（svg 天生如此）—— 按文字找按钮的
                          地方和读屏软件看到的都只有 `aria-label` 那个名字。 */}
                      <MoreHorizontal size={15} aria-hidden="true" />
                    </button>
                  )}
                </div>
              )}
              {/* ★ 2026-10-06：「…」点开的**菜单**（就地展开，不弹浮层 —— 和全站
                  "没有弹窗文化"同一条规矩；再点一下「…」收起，和输入框那颗加号
                  同一个开关逻辑）。两项：【多选】进选择模式、【删除】删这一条
                  （**危险的那一项排最后** —— 菜单的通用规矩，手机桌面都是这么排的）。
                  ⚠️ 点【删除】分两路：带图那条转成下面的就地确认（`confirmingId`），
                  纯文字那条直接请 App 删（见 `onDeleteMessage` 那段 props 注释）。 */}
              {menuId === m.id && (
                <div className="msg-menu" ref={menuElRef}>
                  <button className="msg-menu-pick" disabled={!!busy}
                    onClick={() => {
                      setMenuId(null)
                      setSelectedIds([])
                      setBatchAsk(false)
                      setSelecting(true)
                    }}>多选</button>
                  <button className="msg-menu-del" disabled={!!busy}
                    onClick={() => {
                      setMenuId(null)
                      if (isStep) setConfirmingId(m.id)
                      else onDeleteMessage(m.id)
                    }}>删除</button>
                </div>
              )}
              {/* ★ 2026-10-06：带图那条的**就地确认**（只有这一支会走到这儿 ——
                  纯文字那条菜单里点【删除】直接删，见上面那条菜单）。
                  形状照作品详情页那条 `.detail-confirm`：一句话 + 两颗按钮，
                  **不弹窗**（和 SessionsPage 那条"就地确认"是同一条**规矩**）。
                  ⚠️ 文案的出处是 `src/ui/LutSettings.tsx`（滤镜删除确认块）——
                  `删了就找不回来了。` / `确认删除` 从那儿**逐字**抄来；两颗里
                  只有「确认删除」穿危险色 —— 它们都很短、长得又像，点错一次
                  东西就没了，颜色是唯一还分得开的地方（评审 Minor 更正：
                  原来这条注释写的是 SessionsPage，那边其实是「删掉这条？」那套）。
                  ⚠️ 两颗都跟卡片一样挂 `busy`（和「就改这里」同款）。 */}
              {confirmingId === m.id && (
                <div className="msg-confirm">
                  <span>删了就找不回来了。</span>
                  <button className="msg-confirm-del" disabled={!!busy}
                    onClick={() => { setConfirmingId(null); onDeleteMessage(m.id) }}>
                    确认删除
                  </button>
                  <button disabled={!!busy} onClick={() => setConfirmingId(null)}>
                    算了
                  </button>
                </div>
              )}
            </div>
          )
        })}
        {busy && (
          <div className="msg assistant">
            {/* ★ 2026-10-06（用户原话：「要让用户知道你在干嘛」）：文字后面
                三颗**跳动的点**（打字指示器那种），替掉了原来那个 12px 的小
                转圈 —— 三颗错开的点读起来是"还在说"、转圈读起来是"还在装"，
                而这条气泡说的正是"我还在想 / 还在改"。
                ⚠️ `aria-hidden`：它只是动静，句子本身已经把话说完了。 */}
            <div className="bubble assistant pending">
              {busy}
              <span className="pending-dots" aria-hidden="true"><i></i><i></i><i></i></span>
            </div>
            {/* ★ 2026-10-06（晚）：这里原来摆着"图要出现的位置"那块占位
                （`.shot-skeleton`）—— 图撤出对话区之后它整块搬去了
                **照片区上方那条时间轴**（`StepStrip` 的 `.strip-pending`，
                生成中挂在站的那一格后面）。**别在这儿挂回来**：同一件事
                （"图马上要出现了"）有两处出处的话，一处停着不动就像坏了。 */}
          </div>
        )}
      </div>

      {/* spec §6.3 的歧义兜底：请用户在图上点一下，点完**确认了才花钱**
          （一次生成约 12,900 tokens，点错了不该亏钱）。
          ⚠️ 选择模式里所有辅助条一起收（点选 / 继续改 / 卡片 / 正在看…）——
          选东西的时候它们要么是干扰、要么会**当场花钱**（卡片点一下就是一次生成）。
          状态不丢：退出选择模式后照原样回来。 */}
      {!selecting && marking && (
        <div className="cards">
          {/* ★ 2026-10-05：从旧步骤点选时，这条条子**顺带**把"会切掉后面"说出来
              —— 它本来就要点「就改这里」才花钱，不多要一次点击（设计 §4.5）。 */}
          {futureSteps > 0 && (
            <span className="cards-note">
              {`后面还有 ${futureSteps} 步，从这改会把它们去掉。`}
            </span>
          )}
          {/* 还没点之前不出现「就改这里」：那个按钮此刻点了什么也不会发生，
              而"不留一个点了没用的按钮"是这个项目的老规矩。
              ⚠️ 两个都跟卡片一样挂 busy：正忙的时候点下去什么也不会发生
              （confirmMark 自己也有闸门），而"点了没反应"比"点不动"更让人懵。 */}
          {canConfirmMark && (
            <button className="card" onClick={onConfirmMark} disabled={!!busy}>就改这里</button>
          )}
          <button className="card" onClick={onCancelMark} disabled={!!busy}>不用了</button>
        </div>
      )}

      {/* ★ 2026-10-05（设计 §4.5）：从旧步骤再改之前先问一句 —— 那几步是
          花过钱的，这个项目一直不静默丢东西。形状照抄点选那条（`.cards`）。 */}
      {!selecting && replacing && (
        <div className="cards">
          <span className="cards-note">
            {`后面还有 ${futureSteps} 步，从这改会把它们去掉。`}
          </span>
          <button className="card" onClick={onConfirmReplace} disabled={!!busy}>继续改</button>
          <button className="card" onClick={onCancelReplace} disabled={!!busy}>算了</button>
        </div>
      )}

      {!selecting && cards.length > 0 && (
        <div className="cards">
          {cards.map(c => (
            <button
              key={`${c.label}-${c.route}`}
              className="card"
              disabled={!!busy}
              onClick={() => onCard(c)}
            >
              {c.label}
            </button>
          ))}
        </div>
      )}

      {/* 卡片还在路上。**这一句不拦人**：发送键是亮的、话随时可以说，
          它只是把"我在看"这件事说出来 —— 不说的话，上传完到卡片出现之间
          这一格是空的，用户不知道是在等还是坏了。
          ⚠️ 卡片一到就"换成"卡片（不是并存）：两句话说的是同一件事，
          一起出现会像两个东西。 */}
      {!selecting && suggesting && cards.length === 0 && !marking && (
        <div className="cards">
          <span className="cards-now">正在看这张照片能改什么…</span>
        </div>
      )}

      {/* ★ 2026-10-05：加号底下的**工具行**（用户：「点击加号里面有滤镜以及以后
          添加的功能」）。目前只有「滤镜」一项 —— 以后加工具就往这一行排，
          输入框那一行不用再动。

          就地展开、不弹浮层：这一屏没有弹窗文化（和调色面板同一条规矩）。
          它和下面的格子是**两级**：这一行是"有哪些工具"，下面才是工具本身。 */}
      {!selecting && toolsOpen && (
        <div className="chat-tools">
          <button className={lut ? 'chat-tool on' : 'chat-tool'} aria-expanded={lutOpen}
            onClick={() => setLutOpen((o) => !o)}>
            <SlidersHorizontal size={14} strokeWidth={1.5} aria-hidden="true" />
            Lut
          </button>
        </div>
      )}
      {/* 点开是**和微调区同一套格子**（同一个组件，两处长得一样 —— 用户当场
          拍板"两个都要"）。说话那条路走 §7（模型认得名字），这一颗是**不用说话**
          那条路。 */}
      {!selecting && lutOpen && (
        <div className="chat-lut">
          <LutPicker luts={luts} lutsKnown={lutsKnown} value={lut} thumbs={lutThumbs.byId}
            noneThumb={lutThumbs.none} onPick={onPickLut} onAmount={onLutAmount}
            onGoImport={onGoImport} onRetryLuts={onRetryLuts} />
        </div>
      )}

      {/* ★ 2026-10-06 下午：**选择模式底下那条操作条**（输入框在这一档让位 ——
          发不了话：想聊先退出，这比"发出去了但心里没底"清楚，卡片那条花钱的
          路也一起收了，见上面）。
          两副面孔：平时「已选 N 条 ｜ 删除 ｜ 取消」；点【删除】而勾里有带图的
          步骤时，就地变成那一问（`batchAsk`）—— 全站"不弹窗"的规矩，
          和 `.msg-confirm` 是同一条。 */}
      {selecting && (
        <div className="chat-select">
          {batchAsk ? (
            <>
              <span className="chat-select-note">
                {`选中的 ${selectedIds.length} 条里有 ${stepCount} 张生成过的图，删了就找不回来了。`}
              </span>
              {/* 两颗里只有「确认删除」穿危险色 —— 文案都很短、长得又像，
                  点错一次东西就没了，颜色是唯一还分得开的地方（`.danger`，
                  和 SessionsPage 的「删掉」同一条规矩）。 */}
              <button className="chat-select-del danger"
                disabled={!!busy || selectedIds.length === 0}
                onClick={doBatchDelete}>确认删除</button>
              <button className="chat-select-cancel" disabled={!!busy}
                onClick={() => setBatchAsk(false)}>算了</button>
            </>
          ) : (
            <>
              <span className="chat-select-count">{`已选 ${selectedIds.length} 条`}</span>
              {/* 一条都没勾 = 点了什么也不会发生 → 直接禁用它（不留点了没反应的
                  按钮）。⚠️ `busy` 那道闸门 App 里还有真的（和「再来一版」同一条）。 */}
              <button className="chat-select-del"
                disabled={!!busy || selectedIds.length === 0}
                onClick={askBatchDelete}>删除</button>
              <button className="chat-select-cancel" disabled={!!busy}
                onClick={exitSelect}>取消</button>
            </>
          )}
        </div>
      )}

      {!selecting && (
      <form
        className="chat-input"
        onSubmit={e => {
          e.preventDefault()
          const input = e.currentTarget.elements.namedItem('text') as HTMLInputElement
          const v = input.value.trim()
          if (!v || busy) return
          input.value = ''
          // ★ 2026-10-06：发送 = 表态"我要看最新的" —— 就算刚才翻在上面读历史，
          // 这一下也贴回底（下面那条"内容变了才跟"的规矩管不到这一步）。
          atBottomRef.current = true
          onSend(v)
        }}
      >
        {/* ★ 2026-10-05：**加号**（用户：「在对话框那边设一个加号，然后点击加号
            里面有滤镜以及以后添加的功能」）。

            ⚠️ 它是**图标键**，所以那两行标记不是可选的：`aria-label` 是读屏和
            "按标签找元素"的唯一依据（测试按 `.chat-plus` 找它），`aria-expanded`
            报的是"里面那行开着没有"。
            ⚠️ `type="button"`：在 form 里不写就会被当成提交键 —— 按一下加号
            等于把消息发出去。
            ⚠️ 再点一下要**连展开的工具一起收**：加号是这一摊**唯一**的开关，
            只收自己的话，那排格子会留在原地而**没有关它的地方**。
            ⚠️ 里面正用着滤镜时点一下 `.on`：少了它，"这张图套着滤镜"在修图
            这一屏就**没有任何地方显示**了（原来那颗常驻的「滤镜」还担着这件事）。 */}
        <button type="button" className={lut ? 'chat-plus on' : 'chat-plus'}
          aria-label="更多工具" aria-expanded={toolsOpen}
          onClick={() => setToolsOpen((o) => { if (o) setLutOpen(false); return !o })}>
          <Plus size={16} strokeWidth={2} aria-hidden="true" />
        </button>
        {/* ⚠️ 2026-10-01：这一格**故意没过 `<Field>`** —— 它没有标签也没有注解，
            而 `.chat-input input` 身上那条 `flex: 1` 是它撑满那一行的全部依据，
            包一层就得把 `flex` 挪到外层 div 上（这一条在手机上特别容易挤坏）。
            可访问的名字直接给在输入框上：`placeholder` 只是提示，读屏软件不保证念它。

            ⚠️ 它**必须继续叫 `name="text"` 且待在这个 `<form>` 里** ——
            上面那段取值用它（`elements.namedItem('text')`），
            `App.test.tsx` 里的 `say()` 辅助也按 `form.chat-input` + `input[name="text"]` 找它。 */}
        {/* ⚠️ `key` 挂的是 draft：它变了（用户在欢迎页打了话、又选了一张新照片）
            就重挂一次输入框，`defaultValue` 才会重新生效。用户自己打字不会触发
            重挂（那期间根本没有重渲染），所以不会打到一半被清掉。 */}
        <input name="text" defaultValue={draft} key={draft ?? ''}
               placeholder="说说想怎么改…" autoComplete="off"
               aria-label="说说想怎么改" />
        {/* ★ 2026-09-30：这一格**平时是「发送」，生成中是「停止」**。
            为什么值得专门做一个按钮（而不是让发送键继续 disabled 着）：
            生成要十几秒，而在这十几秒里用户原来**没有任何出口** ——
            屏幕上只有一个按不动的「发送」和一句"正在改…大约 10 秒"。
            AI 产品在这个位置放的都是「停止」（ChatGPT / Claude / Gemini 全体，
            组件库那边是 Ant Design X 的 Sender `loading` 态）。

            ⚠️ 用 `type="button"`：同一个 form 里，`type="submit"` 会让它
            在按下的同时把表单提交一遍（那就变成"停止"顺手又发了一次）。
            ⚠️ 它**不 disabled** —— 一个按不动的"停止"比没有更让人着急。 */}
        {busy
          ? <button type="button" className="stop" onClick={onStop}>停止</button>
          : <button type="submit">发送</button>}
      </form>
      )}
    </aside>
  )
}
