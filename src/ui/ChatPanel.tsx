import { useEffect, useState } from 'react'
import type { SuggestCard } from '../../shared/protocol.ts'
import type { LutMeta, LutRef } from '../../shared/lut.ts'
import { MoreHorizontal, Plus, RotateCw, SlidersHorizontal, Undo2 } from 'lucide-react'
import LutPicker from './LutPicker.tsx'

export type ChatMessage = {
  id: number
  role: 'user' | 'assistant'
  text: string
}

type Props = {
  messages: ChatMessage[]
  cards: SuggestCard[]
  /** 非 null 时显示"正在…"气泡，并禁用发送和卡片 */
  busy: string | null
  /**
   * ★ 2026-10-06（用户原话：「而且中途思考要有一些加载动作比如正在思考，要让
   * 用户知道你在干嘛」）：这一趟是不是**真的在生成**（判据在 App：
   * `busy === BUSY_GENERATING`）。为真时在气泡下面摆一块图位的占位块，
   * 图到了原地换成真图 —— 「正在思考…」那 1.5 秒、上传/切会话那几句都不摆。
   */
  generating: boolean
  /**
   * ★ 2026-10-06（评审 Minor）：**底图的宽 / 高比**（`image.width /
   * image.height`）—— 占位块按它定高，换真图时纵向也不跳（照片竖着横着
   * 都有，写死一个比例只能压中一半）。可选：不传就退回 CSS 里那条 4:3。
   */
  aspectRatio?: number
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
  /** 点「回到这一步」。只在 jumpableIds 里的消息上出现。 */
  onJump: (id: number) => void
  /** 点「再来一版」—— 同一句话重掷一次（见 App.tsx 的 onRerun）。 */
  onRerun: (id: number) => void
  /** 哪几步**记着当初那句话**（= 能重掷的那些）。原图不在里面。 */
  rerunnable: number[]
  jumpableIds: number[]
  /** 每一步的缩略图，键是消息 id。空串 = 还没生成。 */
  thumbs: Record<number, string>
  /** 图上点选这条流程开着（正等着点、或者已经点过了）—— 两个按钮就出现。 */
  marking: boolean
  /** 已经点过图了，可以确认。**点「就改这里」才真正花钱**，所以它单独一个开关。 */
  canConfirmMark: boolean
  onConfirmMark: () => void
  onCancelMark: () => void
  /**
   * ★ 2026-10-05：现在站在哪一步 —— 那一步上的「回到这一步」换成「你在这里」
   *   （设计 §6.1）。`null`（还没有会话）时谁都不标。
   */
  currentId: number | null
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
}

export default function ChatPanel({
  messages, cards, busy, generating, aspectRatio, suggesting, onSend, onStop, onCard, onJump, onRerun, rerunnable,
  jumpableIds, thumbs, marking, canConfirmMark, onConfirmMark, onCancelMark, draft,
  currentId, futureSteps, replacing, onConfirmReplace, onCancelReplace,
  luts, lutsKnown, lut, lutThumbs, onPickLut, onLutAmount, onNeedLutThumbs, onGoImport, onRetryLuts,
  originalId, onDeleteMessage,
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
   * 哪一条会变得要猜。
   *
   * 菜单目前只有【删除】一项。做成菜单而不是直接摆一颗删除键（豆包的样子，
   * 也是他看了豆包截图之后点名的形状）：以后要加的每一条消息上的动作，都往
   * 这一条里排，不用在消息末尾越堆越多。
   */
  const [menuId, setMenuId] = useState<number | null>(null)

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
  useEffect(() => {
    if (lutOpen && luts.length > 0) onNeedLutThumbs()
  }, [lutOpen, luts])
  return (
    <aside className="chat">
      <div className="chat-log">
        {messages.map(m => {
          // ★ 2026-10-05：一条回复**分两块**（用户原话：「对话区 ai 的回答文字跟
          //   图片分成两部分，文字在上，图片在下分为两个」）。
          //
          //   以前文字、小图、两颗按钮挤在**同一个气泡框**里 —— 读起来像"一段
          //   带插图的句子"，可它们本来是两件事：**他跟我说的那句话** /
          //   **我交给他的那张图**。所以现在上面一块是话、下面一块是东西。
          //   ⚠️ 两块里**只要有一块要出现，第二块就得在**（小图可能还没生成完
          //      —— `thumbs[id]` 是空串那阵子，按钮不能跟着一起消失）。
          const shot = m.role === 'assistant' && !!thumbs[m.id]
          const acts = m.role === 'assistant' &&
            (jumpableIds.includes(m.id) || rerunnable.includes(m.id))
          // ★ 2026-10-06：这一条身后有没有"一步"？（步骤 id 就是那条助手消息的
          //   id，老约定。）有 → 点 ✕ 要先问一句；没有 → 纯文字，一点就删。
          const isStep = jumpableIds.includes(m.id)
          // 「原图」那条（= 欢迎语，同一条消息）不摆 ✕ —— 它是这条会话的锚。
          const delable = m.id !== originalId
          return (
            <div key={m.id} className={`msg ${m.role}`}>
              {/* ① 上面那一块：话 */}
              <div className={`bubble ${m.role}`}>
                <div className="bubble-text">{m.text}</div>
              </div>
              {/* ② 那一步的画面（`thumbs` 还没生成完 = 空串时，这块整个不摆） */}
              {shot && (
                <img
                  className="bubble-thumb"
                  src={thumbs[m.id]}
                  alt="这一步的效果"
                  onClick={() => jumpableIds.includes(m.id) && onJump(m.id)}
                />
              )}
              {/* ③ 末尾那一排：回到这一步 / 再来一版 / 「…」。
                  ★ 2026-10-06：它不再套在 `.shot` 里了 —— 这一排现在是**每段都有**
                  的（用户要的豆包式：「放个这个图标在每段对话的最后」）：纯文字
                  那条只有「…」一颗；「原图」那条没有「…」（它是这条会话的锚），
                  但站着的那格「你在这里」照旧。间距由 `.msg` 自己的 gap 管。 */}
              {(acts || delable) && (
                <div className="bubble-actions">
                  {/* ★ 2026-10-05：站在的那一步**不是一颗按钮**，是一个位置标记
                      （设计 §6.1）。在最新一步上，那颗「回到这一步」本来就是
                      点了没反应的按钮 —— 换成它顺手把那个毛病修掉，而且任何
                      时刻"我在哪"都有答案。span 不是 button：读屏和"按文字找
                      按钮"的地方都能分清。 */}
                  {jumpableIds.includes(m.id) && (
                    m.id === currentId
                      ? <span className="bubble-current" aria-current="step">你在这里</span>
                      : <button className="bubble-jump" onClick={() => onJump(m.id)}>
                          <Undo2 size={13} aria-hidden="true" />
                          回到这一步
                        </button>
                  )}
                  {/* 「再来一版」= 同一句话重掷一次。**和「回到这一步」并排但不同**：
                      一个是回去，一个是回去**并且立刻重来**（靠 ↶ / ↻ 区分）。
                      ⚠️ 它是这两颗里**唯一**要禁用的那颗 —— 忙的时候再掷一次
                      就是两次生成同时在跑，钱是两倍（「回到这一步」不禁用是有意的，
                      见 App.tsx 的 onJump 那段）。
                      ★ 2026-10-01：两个箭头以前是 CSS 的 `content: '↶' / '↻'`，
                      现在是 lucide 图标。**仍然是装饰**（`aria-hidden`）：
                      图标是 svg，进不了 textContent，所以按文字找按钮的地方
                      和读屏软件看到的都还只有「回到这一步」/「再来一版」这五个字。 */}
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
                      ⚠️ `aria-label` 是读屏和"按标签找元素"的唯一依据（图标键和
                      左栏「个人设置」同一条规矩）；`aria-expanded` 报开合。
                      ⚠️ `busy` 时禁用（和「就改这里」同款）：忙的时候删等于在一次
                      生成还在飞的时候动账本（App 的 `onDeleteMessage` 里还有一道
                      真闸门）。
                      ⚠️ 确认条开着时这颗收掉（`confirmingId !== m.id`）—— 那条
                      已经在问同一个问题了，两颗并存会像"删除按钮点了没反应"。 */}
                  {delable && confirmingId !== m.id && (
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
                  同一个开关逻辑）。目前一项【删除】；以后消息上的动作都往这条里排。
                  ⚠️ 点【删除】分两路：带图那条转成下面的就地确认（`confirmingId`），
                  纯文字那条直接请 App 删（见 `onDeleteMessage` 那段 props 注释）。 */}
              {menuId === m.id && (
                <div className="msg-menu">
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
            {/* ★ 2026-10-06：**图要出现的位置先摆一块占位**（骨架屏，图到了
                原地换掉、不跳）。⚠️ 只在生成时摆 —— 「正在思考…」那会儿还
                不知道要不要生成。
                ⚠️ 不套 `.shot`：那一层是给"图 + 按钮"用的，而这里的间距已经由
                `.msg` 自己的 gap 管了（和真缩略图那块是同一个数，见 CSS）。
                ★ `aspectRatio` 内联（评审 Minor）：占位块和真缩略图**同一个
                宽高比**，竖图横图都不跳；没传时退回 CSS 里那条 4:3。 */}
            {generating && (
              <div className="shot-skeleton" aria-hidden="true"
                style={aspectRatio ? { aspectRatio } : undefined} />
            )}
          </div>
        )}
      </div>

      {/* spec §6.3 的歧义兜底：请用户在图上点一下，点完**确认了才花钱**
          （一次生成约 12,900 tokens，点错了不该亏钱）。 */}
      {marking && (
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
      {replacing && (
        <div className="cards">
          <span className="cards-note">
            {`后面还有 ${futureSteps} 步，从这改会把它们去掉。`}
          </span>
          <button className="card" onClick={onConfirmReplace} disabled={!!busy}>继续改</button>
          <button className="card" onClick={onCancelReplace} disabled={!!busy}>算了</button>
        </div>
      )}

      {cards.length > 0 && (
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
      {suggesting && cards.length === 0 && !marking && (
        <div className="cards">
          <span className="cards-now">正在看这张照片能改什么…</span>
        </div>
      )}

      {/* ★ 2026-10-05：加号底下的**工具行**（用户：「点击加号里面有滤镜以及以后
          添加的功能」）。目前只有「滤镜」一项 —— 以后加工具就往这一行排，
          输入框那一行不用再动。

          就地展开、不弹浮层：这一屏没有弹窗文化（和调色面板同一条规矩）。
          它和下面的格子是**两级**：这一行是"有哪些工具"，下面才是工具本身。 */}
      {toolsOpen && (
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
      {lutOpen && (
        <div className="chat-lut">
          <LutPicker luts={luts} lutsKnown={lutsKnown} value={lut} thumbs={lutThumbs.byId}
            noneThumb={lutThumbs.none} onPick={onPickLut} onAmount={onLutAmount}
            onGoImport={onGoImport} onRetryLuts={onRetryLuts} />
        </div>
      )}

      <form
        className="chat-input"
        onSubmit={e => {
          e.preventDefault()
          const input = e.currentTarget.elements.namedItem('text') as HTMLInputElement
          const v = input.value.trim()
          if (!v || busy) return
          input.value = ''
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
    </aside>
  )
}
