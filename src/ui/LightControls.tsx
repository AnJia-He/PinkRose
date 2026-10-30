import { Btn } from './kit/Btn.tsx'
import { Slider } from './kit/Slider.tsx'
import { DEFAULT_LIGHT, LIGHT_PRESETS, type LightOptions } from '../image/light'

/** 光效第二行：边框 / 贴纸 / 叠加 / 涂鸦 / 光效 + 预设 / 强度 / 取消 / 应用。 */
type Props = {
  options: LightOptions
  applying: boolean
  onChange: (patch: Partial<LightOptions>) => void
  onCanvas: () => void
  onFrame: () => void
  onSticker: () => void
  onShape: () => void
  onDouble: () => void
  onDoodle: () => void
  onDuotone: () => void
  onCancel: () => void
  onDone: () => void
}

export default function LightControls({
  options, applying, onChange, onCanvas, onFrame, onSticker, onShape, onDouble, onDoodle, onDuotone, onCancel, onDone,
}: Props) {
  return (
    <>
      <button type="button" className="crop-chip" onClick={onCanvas}>画布</button>
      <button type="button" className="crop-chip" onClick={onFrame}>边框</button>
      <button type="button" className="crop-chip" onClick={onSticker}>贴纸</button>
      <button type="button" className="crop-chip" onClick={onShape}>形状</button>
      <button type="button" className="crop-chip" onClick={onDouble}>叠加</button>
      <button type="button" className="crop-chip" onClick={onDoodle}>涂鸦</button>
      <button type="button" className="crop-chip on" aria-pressed="true">光效</button>
      <button type="button" className="crop-chip" onClick={onDuotone}>双色调</button>
      <div className="retouch-modes" role="group" aria-label="光效预设">
        {LIGHT_PRESETS.map(p => (
          <button
            key={p.id} type="button"
            className={`crop-chip${options.preset === p.id ? ' on' : ''}`}
            aria-pressed={options.preset === p.id}
            onClick={() => onChange({ preset: p.id })}
          >{p.label}</button>
        ))}
      </div>
      <Slider
        label="强度" value={options.intensity}
        min={0} max={100} step={1}
        changed={options.intensity !== DEFAULT_LIGHT.intensity}
        onChange={intensity => onChange({ intensity })}
      />
      {options.preset === 'relight' && (
        <>
          <Slider
            label="光源方向"
            value={options.angle ?? 315}
            min={0}
            max={360}
            step={1}
            neutral={315}
            changed={(options.angle ?? 315) !== 315}
            onChange={angle => onChange({ angle })}
          />
          <Slider
            label="冷暖"
            value={options.warmth ?? 0}
            min={-100}
            max={100}
            step={1}
            changed={(options.warmth ?? 0) !== 0}
            onChange={warmth => onChange({ warmth })}
          />
          <span className="tool-note">0° 上方 · 90° 右侧 · 180° 下方 · 270° 左侧</span>
        </>
      )}
      <div className="crop-tools">
        <button type="button" className="crop-btn" onClick={onCancel}>取消</button>
        <Btn
          className="crop-done"
          disabled={applying || options.intensity <= 0}
          onClick={() => void onDone()}
        >应用光效</Btn>
      </div>
    </>
  )
}
