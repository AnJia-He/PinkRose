/**
 * 一条滑块（调色面板里那八条）。
 *
 * ⚠️ **换它换掉的是两套手写的伪元素**：`::-webkit-slider-runnable-track` /
 * `::-webkit-slider-thumb` 和 `::-moz-range-track` / `::-moz-range-thumb` ——
 * 那两套的注释自己写着"少一套就在某个浏览器上退回原生样子"。现在轨道和拇指
 * 都是我们自己画的普通 div，**一套 CSS 通吃**。
 *
 * ⚠️ 换之前这八条**一条 ARIA 都没有**：没有 `aria-valuenow`、没有名字。
 * 现在它们各自是一个原生 `<input type="range">`（Base UI 把它藏在拇指里），
 * 键盘、读屏、表单语义全是现成的 —— 那正是引这个库的理由。
 *
 * ⚠️ 外面仍然是 `<label className="slider">`（不是 Base UI 的 Label）：
 * `.slider` / `.slider.on` / `.slider-value` 这几条 CSS 和
 * `AdjustmentPanel.test.ts` 都按它认人，而这一层本来就是"网格里的一行"，
 * 属于版面不属于控件。
 *
 * ★ 2026-10-04（「调色」专业面板那一轮）加的三件套，各自有上面那段注释压不住的坑，
 *   写在它们各自的位置旁边：**双击复零**（挂在 `.slider-control` 上，不是最外层
 *   label）、**点数字改值**（那个 `<input>` 只对鼠标用户开放，理由见数字那格）、
 *   **渐变轨**（给了渐变就不画填充段）。
 */
import { useState } from 'react'
import { Slider as BaseSlider } from '@base-ui-components/react/slider'

export function Slider(props: {
  label: string
  value: number
  min: number
  max: number
  step?: number
  /** 动过的那一条挂 `.on`（标签和数字点亮）。**纯装饰**，判据由调用方给 */
  changed?: boolean
  /** ★ 双击回到哪（默认 0）。色相带/色温这类"中性点不是 0"的用得上 */
  neutral?: number
  /** ★ 一条 CSS 渐变串（色温、色彩平衡三轴、色相带）。给了就**不画填充段** —— 理由见 Track 那段 */
  gradient?: string
  onChange: (v: number) => void
}) {
  // 「点数字改值」的编辑态：null = 显示数字；字符串 = 正在输入。
  // ⚠️ **故意存字符串**：`''`、`'-'` 这些打字的中间状态不是合法数字，
  //    转成 number 会在打第二个字符时就丢掉用户刚敲的东西。
  const [editing, setEditing] = useState<string | null>(null)

  /** 提交编辑框里那笔输入。
   *  · 非法（Number 出来不是有限数，如 `abc`）**当取消** —— 不调 onChange；
   *  · 超范围**钳到边界**（拖滑块本来也只能到边界，手动输入不该是例外）。 */
  function commit() {
    const v = Number(editing)
    if (Number.isFinite(v)) props.onChange(Math.max(props.min, Math.min(props.max, v)))
    setEditing(null)
  }

  return (
    <label className={`slider${props.changed ? ' on' : ''}`}>
      <span className="slider-label">{props.label}</span>
      <BaseSlider.Root
        value={props.value}
        min={props.min}
        max={props.max}
        step={props.step ?? 1}
        onValueChange={(v) => props.onChange(v as number)}
      >
        {/* ⚠️ **双击复零挂在这里，不是最外层 `<label>` 上**：标签里还住着数字那格，
            挂 label 上就会把"双击数字"也算成复零 —— 而点数字是**另一件事**
            （进编辑态改值）。挂 control 上，双击的是轨道/圆点才算。 */}
        <BaseSlider.Control
          className="slider-control"
          onDoubleClick={() => props.onChange(props.neutral ?? 0)}
        >
          <BaseSlider.Track
            className="slider-track"
            /* ★ 2026-10-04：渐变轨（色温/色彩平衡/色相带用）。
               ⚠️ 给了渐变就**不画填充段**（下面的 Indicator），这不是洁癖：
               Indicator 是"从左端量到当前值"的一截色块，而渐变轨的意思是
               **轨道上每个位置各自对应一个色相/色温** —— 两条叠在一起，
               眼睛读出来的颜色是错的。 */
            style={props.gradient ? { background: props.gradient } : undefined}
          >
            {props.gradient ? null : <BaseSlider.Indicator className="slider-indicator" />}
          </BaseSlider.Track>
          <BaseSlider.Thumb className="slider-thumb" />
        </BaseSlider.Control>
      </BaseSlider.Root>
      {/* ★ 2026-10-04：点一下下面那格数字 → 变输入框（回车/失焦提交，Esc 取消）。
          这个编辑框是**给鼠标用户的快捷输入**（点数字敲个数）；**键盘用户的通路
          是方向键微调** —— 那条本来就可达、还带 aria-valuenow，而这个框只有
          "先用鼠标点开"才会出现。所以它没有 a11y 名字是**有意**的，别当漏了。

          ⚠️ 那个 `aria-hidden` 从换成 Base UI 起就在，理由没有变：这个数字是
          **画给眼睛看的**，而"现在多少"已经由输入框自己的 `aria-valuenow` 报给
          读屏了。不藏起来的话，外面那个 `<label>` 的文本会把数字也算进**可读
          名字** —— 读屏的人听到的是「亮度3」这种名字里带数值的东西，而数值本来
          就会随拖动一直变。编辑态换成 `<input>` 之后这条不变量照旧（编辑框不是
          读屏通路，键盘用户走方向键）。 */}
      {editing === null ? (
        <span
          className="slider-value"
          aria-hidden="true"
          /* ⚠️ 下面这两下 `preventDefault` 是**真浏览器里试出来的**（2026-10-04），
             别删、也别以为多余 —— jsdom 看不见这场事故：
             数字住在一个 `<label>` 里，浏览器的默认行为是"点标签 = 把焦点交给
             标签的控件"，而控件是藏在拇指里的那个 range。编辑框是**点下去才挂
             出来**的：挂出来那一刻它拿到焦点，紧接着 label 的默认行为（转发
             click 给 range → 聚焦它）晚一步把焦点抢走 —— 于是刚挂出来的编辑框
             吃到一个 blur，被 `onBlur={commit}` 当成交付、立刻收起。
             表现就是"点了数字，编辑框一闪就关"（真浏览器实测：focusin slider-edit
             → focusout slider-edit → focusin INPUT → click INPUT）。
            拦掉 mousedown 和 click 的默认行为，这场抢焦点就不会发生。 */
          onMouseDown={(e) => e.preventDefault()}
          onClick={(e) => {
            e.preventDefault()
            setEditing(String(props.value))
          }}
        >{props.value}</span>
      ) : (
        <input
          className="slider-edit"
          autoFocus
          value={editing}
          onChange={(e) => setEditing(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commit()
            else if (e.key === 'Escape') setEditing(null)
          }}
          onBlur={commit}
        />
      )}
    </label>
  )
}
