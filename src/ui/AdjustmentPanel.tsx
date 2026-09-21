import { PARAM_KEYS, type Adjustments, PARAM_MIN, PARAM_MAX } from '../core/adjustments'
import { PRESETS } from '../core/presets'

const LABELS: Record<keyof Adjustments, string> = {
  exposure: '曝光',
  contrast: '对比度',
  highlights: '高光',
  shadows: '阴影',
  saturation: '饱和度',
  temperature: '色温',
  clarity: '清晰度',
  vignette: '暗角',
}

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
          <span className="slider-label">{LABELS[k]}</span>
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
    </aside>
  )
}
