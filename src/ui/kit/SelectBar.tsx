/**
 * 「选择模式底下那条操作条」—— 对话区和对话列表**同一条**（2026-10-09 收口）。
 *
 * 两副面孔（全站"不弹窗"的规矩）：平时 `已选 N 条 ｜ 删除 ｜ 取消`；
 * 点了【删除】之后就地问一句，那一问变成 `确认删除 ｜ 算了`。
 *
 * ⚠️ **两颗里只有「确认删除」穿危险色**（`.danger`）：它俩文案都短、长得又像，
 *   点错一次东西就没了，颜色是唯一还分得开的地方。
 * ⚠️ 一条都没勾 = 点了什么也不会发生 → **直接禁用**（不留点了没反应的按钮）。
 * ⚠️ `scope` 决定类名前缀（`chat-` / `sessions-`）：两页的样式是**两套**，
 *   这里共用的只是形状。改这些类名要连带看 `check:layout` 那些探针。
 *
 * ⚠️ **`onAsk` 不是"必弹那一问"**：对话区那一侧会先看勾里有没有带图的步骤
 *   （有才问，没有直接删）—— 那是它自己 `askBatchDelete` 的事，这里只管把
 *   点按转出去。`askNote` 是不是 `null` 才决定长哪一副面孔。
 */
export function SelectBar({
  scope, count, busy, askNote, onAsk, onConfirm, onExitAsk, onExit,
}: {
  /** 类名前缀：`'chat'` → `.chat-select`，`'sessions'` → `.sessions-select`。 */
  scope: 'chat' | 'sessions'
  /** 勾了几条（`0` 时两颗按钮都禁用）。 */
  count: number
  /** 正在删 —— 两颗按钮一起禁用。 */
  busy: boolean
  /** 第二副面孔的正文；`null` = 停在第一副（`已选 N 条 ｜ 删除 ｜ 取消`）。 */
  askNote: string | null
  /** 点「删除」（要不要先问一句由调用方定）。 */
  onAsk: () => void
  /** 点「确认删除」。 */
  onConfirm: () => void
  /** 点「算了」。 */
  onExitAsk: () => void
  /** 点「取消」= 退出选择模式。 */
  onExit: () => void
}) {
  const cls = `${scope}-select`
  return (
    <div className={cls}>
      {askNote !== null ? (
        <>
          <span className={`${cls}-note`}>{askNote}</span>
          <button className={`${cls}-del danger`}
            disabled={busy || count === 0}
            onClick={onConfirm}>确认删除</button>
          <button className={`${cls}-cancel`} disabled={busy}
            onClick={onExitAsk}>算了</button>
        </>
      ) : (
        <>
          <span className={`${cls}-count`}>{`已选 ${count} 条`}</span>
          <button className={`${cls}-del`}
            disabled={busy || count === 0}
            onClick={onAsk}>删除</button>
          <button className={`${cls}-cancel`} disabled={busy}
            onClick={onExit}>取消</button>
        </>
      )}
    </div>
  )
}
