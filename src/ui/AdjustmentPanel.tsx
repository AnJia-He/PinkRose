import { PARAM_KEYS, PARAM_LABELS, isChanged, type Adjustments, PARAM_MIN, PARAM_MAX } from '../../shared/adjustments.ts'
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

      {/* 八条滑块**自己一层**，分栏只发生在这里；面板本身仍是"头 / 预设 / 滑块组"
          的竖列。
          ⚠️ 原来分栏直接写在 `.panel` 上，靠 CSS 里一份"谁横跨全宽"的类名清单
          （`.panel-head, .presets { grid-column: 1 / -1 }`）撑着 —— 那份清单在
          **另一个文件**里，于是往面板里加任何东西（一句提示、第二组按钮）都会
          **静静地掉进某一栏**：组件结构变了不报错，只有肉眼能发现。 */}
      <div className="panel-sliders">
        {PARAM_KEYS.map(k => (
          // 动过的那一条挂个 `on`，样式靠它把标签和数字点亮（见 styles.css 的
          // `.slider.on`）。**这是纯装饰**：值本身还是 value[k] 这**一个**来源，
          // 不存在"记号和数据对不上"。写法跟 Uploader 那个 `.over` 同款。
          // ⚠️ "动过没有"的判据来自 shared/adjustments 的 `isChanged` ——
          //    作品详情页那张表问的是同一件事，两处**必须同一个判据**。
          <label key={k} className={`slider${isChanged(value, k) ? ' on' : ''}`}>
            <span className="slider-label">{PARAM_LABELS[k]}</span>
            <input
              type="range"
              min={PARAM_MIN}
              max={PARAM_MAX}
              step={1}
              value={value[k]}
              onChange={e => set(k, Number(e.target.value))}
            />
            <span className="slider-value">{value[k]}</span>
          </label>
        ))}
      </div>
    </aside>
  )
}
