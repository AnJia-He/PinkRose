import type { SuggestCard } from '../../shared/protocol'

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
}

export default function ChatPanel({
  messages, cards, busy, onSend, onCard, onJump, jumpableIds,
}: Props) {
  return (
    <aside className="chat">
      <div className="chat-log">
        {messages.map(m => (
          <div key={m.id} className={`bubble ${m.role}`}>
            <div className="bubble-text">{m.text}</div>
            {m.role === 'assistant' && jumpableIds.includes(m.id) && (
              <button className="bubble-jump" onClick={() => onJump(m.id)}>
                回到这一步
              </button>
            )}
          </div>
        ))}
        {busy && <div className="bubble assistant pending">{busy}</div>}
      </div>

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
