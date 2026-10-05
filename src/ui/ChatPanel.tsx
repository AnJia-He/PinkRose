import { useEffect, useState } from 'react'
import type { SuggestCard } from '../../shared/protocol.ts'
import type { LutMeta, LutRef } from '../../shared/lut.ts'
import { Plus, RotateCw, SlidersHorizontal, Undo2 } from 'lucide-react'
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
}

export default function ChatPanel({
  messages, cards, busy, suggesting, onSend, onStop, onCard, onJump, onRerun, rerunnable,
  jumpableIds, thumbs, marking, canConfirmMark, onConfirmMark, onCancelMark, draft,
  luts, lutsKnown, lut, lutThumbs, onPickLut, onLutAmount, onNeedLutThumbs, onGoImport, onRetryLuts,
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
          return (
            <div key={m.id} className={`msg ${m.role}`}>
              {/* ① 上面那一块：话 */}
              <div className={`bubble ${m.role}`}>
                <div className="bubble-text">{m.text}</div>
              </div>
              {/* ② 下面那一块：那一步的画面 + 挂在它下面的两颗按钮 */}
              {(shot || acts) && (
                <div className="shot">
                  {shot && (
                    <img
                      className="bubble-thumb"
                      src={thumbs[m.id]}
                      alt="这一步的效果"
                      onClick={() => jumpableIds.includes(m.id) && onJump(m.id)}
                    />
                  )}
                  {acts && (
                    <div className="bubble-actions">
                      {jumpableIds.includes(m.id) && (
                        <button className="bubble-jump" onClick={() => onJump(m.id)}>
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
                    </div>
                  )}
                </div>
              )}
            </div>
          )
        })}
        {busy && (
          <div className="msg assistant">
            <div className="bubble assistant pending">{busy}</div>
          </div>
        )}
      </div>

      {/* spec §6.3 的歧义兜底：请用户在图上点一下，点完**确认了才花钱**
          （一次生成约 12,900 tokens，点错了不该亏钱）。 */}
      {marking && (
        <div className="cards">
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
