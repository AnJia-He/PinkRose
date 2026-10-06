/**
 * 调色屏照片上方那条**工具行**（★ 2026-10-06）。
 * 长相和历史转盘那条带子（`.strip`）是同一套：`--raised` 实心底 + 一道 `--line`。
 * 它**不认识任何具体工具** —— 只把"谁开着"喊出去，第二行由调用方塞进 children。
 *
 * ⚠️ **没有 children 就不画第二行**（★ 2026-10-06 晚加的，为「对比」）。空着的
 *   第二行不是"什么都不占"：它有自己的内边距和一道线（约 37px），而它坐在照片
 *   上方 —— 开着「对比」时照片会**整张跳一下**，那正好打在"放大着比细节"这个
 *   用法上（spec §3.3 要的是两张图同步缩放）。「对比」是个开关、没有自己的控件，
 *   所以它不传 children。
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
      {props.active && props.children ? (
        <div className="tool-row-second">{props.children}</div>
      ) : null}
    </div>
  )
}
