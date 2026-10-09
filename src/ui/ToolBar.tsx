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
import { Crop, Eraser, SquareSplitHorizontal } from 'lucide-react'

export type ToolId = 'crop' | 'retouch' | 'compare'

/**
 * ★ 2026-10-09（用户原话：「给这些也找到合适的图标组件」—— 对着这排工具说的，
 * 和 10-08 调色面板组头那次是同一句话）：三颗工具各配一个图标。
 * 选型照 `Nav.tsx` 顶部那三条规矩来：
 *   · **一个图标认一件事**：
 *     裁剪 = `Crop`（两把角尺那条经典剪裁标记，没有第二个候选）、
 *     点修 = `Eraser`（这一趟的动词就是"擦"—— 第二行的「橡皮」和主按钮
 *       「擦掉这里」都是它；⚠️ 别换 `WandSparkles`，那是「修图」说话改图的
 *       概念，全站不许两个概念共用一个图标）、
 *     对比 = `SquareSplitHorizontal`（**一张图被竖线劈成左右两半** —— 和「对比」
 *       真开起来的样子一模一样，见 `CompareSplit` 那条左右分屏）。
 *   · **同一个概念全站同一个图标**：这三颗现在各用各处一次，没有第二处。
 *   · **线宽显式写 1.5**（尺子守卫扫 `src/ui` 下所有 tsx，不写就是 lucide
 *     默认的 2）。
 * ⚠️ 尺寸 14 跟这一屏的既有口径走（面板组头 / 对话加号里那一行都是 14；
 *   13px 的字配 14px 的图标 —— 图标比文字那行盒矮，撑高这一格的还是文字，
 *   工具行的高度不变，`styles.css` 那条 `.tool-cell` 里记着同一笔账）。
 * ⚠️ 图标是**装饰**：`aria-hidden` 必写 —— 名字是旁边那两个字，读屏和
 *   "按 `aria-label` 找按钮"的测试（`ToolBar.test.tsx`）都不该被 svg 搅到。
 */
const CELLS: { id: ToolId; name: string; icon: React.ReactNode }[] = [
  { id: 'crop', name: '裁剪', icon: <Crop size={14} strokeWidth={1.5} aria-hidden="true" /> },
  { id: 'retouch', name: '点修', icon: <Eraser size={14} strokeWidth={1.5} aria-hidden="true" /> },
  { id: 'compare', name: '对比', icon: <SquareSplitHorizontal size={14} strokeWidth={1.5} aria-hidden="true" /> },
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
          >{c.icon}{c.name}</button>
        ))}
      </div>
      {props.active && props.children ? (
        <div className="tool-row-second">{props.children}</div>
      ) : null}
    </div>
  )
}
