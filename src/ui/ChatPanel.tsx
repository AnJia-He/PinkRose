import type { SuggestCard } from '../../shared/protocol.ts'

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
  onSend: (text: string) => void
  onCard: (card: SuggestCard) => void
  /** 点「回到这一步」。只在 jumpableIds 里的消息上出现。 */
  onJump: (id: number) => void
  jumpableIds: number[]
  /** 每一步的缩略图，键是消息 id。空串 = 还没生成。 */
  thumbs: Record<number, string>
  /** 图上点选这条流程开着（正等着点、或者已经点过了）—— 两个按钮就出现。 */
  marking: boolean
  /** 已经点过图了，可以确认。**点「就改这里」才真正花钱**，所以它单独一个开关。 */
  canConfirmMark: boolean
  onConfirmMark: () => void
  onCancelMark: () => void
}

export default function ChatPanel({
  messages, cards, busy, onSend, onCard, onJump, jumpableIds, thumbs,
  marking, canConfirmMark, onConfirmMark, onCancelMark,
}: Props) {
  return (
    <aside className="chat">
      <div className="chat-log">
        {messages.map(m => (
          <div key={m.id} className={`bubble ${m.role}`}>
            <div className="bubble-text">{m.text}</div>
            {m.role === 'assistant' && thumbs[m.id] && (
              <img
                className="bubble-thumb"
                src={thumbs[m.id]}
                alt="这一步的效果"
                onClick={() => jumpableIds.includes(m.id) && onJump(m.id)}
              />
            )}
            {m.role === 'assistant' && jumpableIds.includes(m.id) && (
              <button className="bubble-jump" onClick={() => onJump(m.id)}>
                回到这一步
              </button>
            )}
          </div>
        ))}
        {busy && <div className="bubble assistant pending">{busy}</div>}
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
        <input name="text" placeholder="说说想怎么改…" autoComplete="off" />
        <button type="submit" disabled={!!busy}>发送</button>
      </form>
    </aside>
  )
}
