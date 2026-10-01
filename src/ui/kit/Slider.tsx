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
 */
import { Slider as BaseSlider } from '@base-ui-components/react/slider'

export function Slider(props: {
  label: string
  value: number
  min: number
  max: number
  step?: number
  /** 动过的那一条挂 `.on`（标签和数字点亮）。**纯装饰**，判据由调用方给 */
  changed?: boolean
  onChange: (v: number) => void
}) {
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
        <BaseSlider.Control className="slider-control">
          <BaseSlider.Track className="slider-track">
            <BaseSlider.Indicator className="slider-indicator" />
          </BaseSlider.Track>
          <BaseSlider.Thumb className="slider-thumb" />
        </BaseSlider.Control>
      </BaseSlider.Root>
      {/* ⚠️ `aria-hidden`：这个数字是**画给眼睛看的**，而"现在多少"已经由输入框
          自己的 `aria-valuenow` 报给读屏了。不藏起来的话，外面那个 `<label>`
          的文本会把数字也算进**可读名字** —— 读屏的人听到的是「亮度3」这种
          名字里带数值的东西，而数值本来就会随拖动一直变。 */}
      <span className="slider-value" aria-hidden="true">{props.value}</span>
    </label>
  )
}
