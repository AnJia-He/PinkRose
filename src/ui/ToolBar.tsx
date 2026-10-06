/**
 * 调色屏照片上方那条**工具行**（★ 2026-10-06）。
 * 长相和历史转盘那条带子（`.strip`）是同一套：`--raised` 实心底 + 一道 `--line`。
 * 它**不认识任何具体工具** —— 只把"谁开着"喊出去，第二行由调用方塞进 children。
 */
export type ToolId = 'crop' | 'compare'

const CELLS: { id: ToolId; name: string }[] = [
  { id: 'crop', name: '裁剪' },
  { id: 'compare', name: '对比' },
]

export default function ToolBar(props: {
  active: ToolId | null
  onPick: (t: ToolId | null) => void
  children?: React.ReactNode
}) {
  return (
    <div className="tool-row">
      <div className="tool-row-main">
        {CELLS.map(c => (
          <button
            key={c.id} type="button" aria-label={c.name}
            className={`tool-cell${props.active === c.id ? ' on' : ''}`}
            // 再点一下当前这颗 = 收回（和左栏那些格子的手感一致）
            onClick={() => props.onPick(props.active === c.id ? null : c.id)}
          >{c.name}</button>
        ))}
      </div>
      {props.active && <div className="tool-row-second">{props.children}</div>}
    </div>
  )
}
