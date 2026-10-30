import { Pipette } from 'lucide-react'
import { HSL_BANDS, PARAM_RANGE, isChanged, type Adjustments } from '../../shared/adjustments.ts'
import type { HslBandId } from '../core/hslPick'
import { Slider } from './kit/Slider.tsx'

/**
 * HSL 分色（★ 2026-10-17）—— 八条色带，每条三根轴。
 *
 * 面板一次只摆**选中色带**的三根滑块：24 根平铺会把面板拉成一条瀑布，
 * 而用户真正在做的动作是"选颜色 → 调它"。色带按钮是纯选择器，值始终
 * 来自 `value` 这一个来源（和 `AdjustmentPanel` 的受控约定一致）。
 *
 * ⚠️ 色点用的是**内容色**（红/橙/黄/绿/青/蓝/紫/洋红）——和色轮、渐变轨
 * 同一类有意例外：它表达的就是那个颜色本身，换成主题令牌就不表达意思了。
 */
const BAND_COLORS: Record<(typeof HSL_BANDS)[number]['id'], string> = {
  red: '#ff4d4d',
  orange: '#ff9f1a',
  yellow: '#ffd93d',
  green: '#4caf50',
  cyan: '#22c1c3',
  blue: '#2f7cf6',
  purple: '#8a5cf6',
  magenta: '#e5399a',
}

type Props = {
  value: Adjustments
  onChange: (next: Adjustments) => void
  bandId: HslBandId
  onBand: (id: HslBandId) => void
  /** 正在等用户点照片取色。 */
  picking?: boolean
  onPick?: () => void
}

export default function HslControls({
  value, onChange, bandId, onBand, picking = false, onPick,
}: Props) {
  const band = HSL_BANDS.find(b => b.id === bandId) ?? HSL_BANDS[0]
  const [hueKey, satKey, lumKey] = band.keys
  const setKey = (key: keyof Adjustments, v: number) => onChange({ ...value, [key]: v })

  return (
    <div className="hsl">
      <div className="hsl-bands" role="group" aria-label="HSL 色带">
        {HSL_BANDS.map(b => {
          const on = b.id === bandId
          return (
            <button
              key={b.id}
              type="button"
              className={`hsl-band${on ? ' on' : ''}`}
              aria-pressed={on}
              aria-label={`${b.label}色`}
              onClick={() => onBand(b.id)}
            >
              <span className="hsl-dot" style={{ background: BAND_COLORS[b.id] }} aria-hidden="true" />
              {b.label}
            </button>
          )
        })}
      </div>
      <Slider
        label="色相"
        value={value[hueKey]}
        min={PARAM_RANGE[hueKey][0]}
        max={PARAM_RANGE[hueKey][1]}
        changed={isChanged(value, hueKey)}
        onChange={v => setKey(hueKey, v)}
      />
      <Slider
        label="饱和度"
        value={value[satKey]}
        min={PARAM_RANGE[satKey][0]}
        max={PARAM_RANGE[satKey][1]}
        changed={isChanged(value, satKey)}
        onChange={v => setKey(satKey, v)}
      />
      <Slider
        label="明度"
        value={value[lumKey]}
        min={PARAM_RANGE[lumKey][0]}
        max={PARAM_RANGE[lumKey][1]}
        changed={isChanged(value, lumKey)}
        onChange={v => setKey(lumKey, v)}
      />
      {onPick && (
        <button
          type="button"
          className={`wb-picker${picking ? ' on' : ''}`}
          aria-pressed={picking}
          onClick={onPick}
        >
          <Pipette size={14} strokeWidth={1.5} aria-hidden="true" />
          从照片取色
        </button>
      )}
    </div>
  )
}
