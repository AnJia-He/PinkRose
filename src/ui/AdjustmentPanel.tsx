import { PARAM_KEYS, PARAM_LABELS, type Adjustments, PARAM_MIN, PARAM_MAX } from '../../shared/adjustments.ts'
import { PRESETS } from '../core/presets'

type Props = {
  value: Adjustments
  onChange: (next: Adjustments) => void
  onReset: () => void
}

export default function AdjustmentPanel({ value, onChange, onReset }: Props) {
  const set = (k: keyof Adjustments, v: number) => onChange({ ...value, [k]: v })

  return (
    <aside className="panel">
      <div className="panel-head">
        <span>微调</span>
        <button onClick={onReset}>重置</button>
      </div>

      <div className="presets">
        {PRESETS.map(p => (
          // 展开拷贝：PRESETS 是模块级共享对象，直接传引用会让拖滑块改坏预设
          <button key={p.id} onClick={() => onChange({ ...p.adjustments })}>
            {p.label}
          </button>
        ))}
      </div>

      {PARAM_KEYS.map(k => (
        <label key={k} className="slider">
          <span className="slider-label">{PARAM_LABELS[k]}</span>
          <input
            type="range"
            min={PARAM_MIN}
            max={PARAM_MAX}
            step={1}
            value={value[k]}
            // 动过的滑块挂个记号 —— 样式靠 `input[data-on]` 把它那条的标签和
            // 数字点亮（见 styles.css 的 .slider-value）。**这是纯装饰**：
            // 值本身还是 value[k] 那一个来源，不存在"记号和数据对不上"。
            // 传 undefined 而不是 false：写 false 会渲染成 data-on="false"，
            // 而 `[data-on]` 属性选择器**只看属性在不在**，照样会点亮。
            data-on={value[k] !== 0 ? '' : undefined}
            onChange={e => set(k, Number(e.target.value))}
          />
          <span className="slider-value">{value[k]}</span>
        </label>
      ))}
    </aside>
  )
}
