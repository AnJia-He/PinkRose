import { ChevronLeft, ChevronRight } from 'lucide-react'

/**
 * 调色屏左下角那组**「上一步 / 下一步」**（★ 2026-10-08 用户原话：
 * 「给调色界面添加上一步下一步的箭头回溯按钮，但是这个是不跟对话区联动的
 * —— 相当于一个宏观一个微观」）。
 *
 * 它和修图屏那圈历史转盘（`ui/StepStrip`）**是同一件事的两种看法**：
 *   · 转盘 = **宏观** —— 一眼看全所有版本，点哪格去哪格（还能拖）；
 *   · 这一组 = **微观** —— 沿顺序一次翻一版，顺带告诉你"第几版 / 共几版"。
 * 两个屏各用一块地方，共用**同一份**"现在看哪一版"（App 的 `cursorId`）——
 * 不另开第二条线（两个"当前版本"会立刻互相打架）。
 *
 * ⚠️ **它不认识 `history`、也不认识 `onJump`** —— 只收"现在第几版 / 共几版
 *    + 两个动作"，谁翻、翻到哪由 App 那层决定（和 `StepStrip` 同一条分工）。
 *   所以"翻版本不删任何东西、不碰对话"那套契约在它身上没有可违反的地方。
 *
 * ⚠️ **两头禁用、不空转**：第一版时「上一步」按不动、最后一版时「下一步」
 *   按不动 —— 全站"不留一个点了没反应的按钮"那条（禁用色也不另写，
 *   全局 `button:where(:disabled)` 管着）。
 * ⚠️ 两颗都是**图标键**：`aria-label` / `title` 必须留 —— 名字只在标签上
 *   （和「个人设置」那颗同一条规矩；测试和探针按 `.step-nav-btn` 找它们）。
 */
export default function StepNav(props: {
  /** 现在是第几版（**1 起数**：`index = 0` 的那版是 1）。 */
  index: number
  total: number
  onPrev: () => void
  onNext: () => void
}) {
  return (
    <div className="step-nav" role="group" aria-label="切换版本">
      <button type="button" className="step-nav-btn" aria-label="上一步" title="上一步"
        disabled={props.index <= 1} onClick={props.onPrev}>
        <ChevronLeft size={15} strokeWidth={1.5} aria-hidden="true" />
      </button>
      <span className="step-nav-count">{`${props.index} / ${props.total}`}</span>
      <button type="button" className="step-nav-btn" aria-label="下一步" title="下一步"
        disabled={props.index >= props.total} onClick={props.onNext}>
        <ChevronRight size={15} strokeWidth={1.5} aria-hidden="true" />
      </button>
    </div>
  )
}
