import { Btn } from './kit/Btn.tsx'
import { Slider } from './kit/Slider.tsx'
import {
  DEFAULT_DUOTONE, DUOTONE_PRESETS, type DuotoneOptions,
} from '../image/duotone'

/**
 * 双色调第二行：装饰的六种模式 + 预设 / 暗部色 / 亮部色 / 强度 / 取消 / 应用。
 * 和光效同一套结构；颜色用原生取色器，移动端会调起系统色板。
 */
type Props = {
  options: DuotoneOptions
  applying: boolean
  onChange: (patch: Partial<DuotoneOptions>) => void
  onCanvas: () => void
  onFrame: () => void
  onSticker: () => void
  onShape: () => void
  onDouble: () => void
  onDoodle: () => void
  onLight: () => void
  onCancel: () => void
  onDone: () => void
}

export default function DuotoneControls({
  options, applying, onChange, onCanvas, onFrame, onSticker,
  onShape, onDouble, onDoodle, onLight, onCancel, onDone,
}: Props) {
  return (
    <>
      <button type="button" className="crop-chip" onClick={onCanvas}>画布</button>
      <button type="button" className="crop-chip" onClick={onFrame}>边框</button>
      <button type="button" className="crop-chip" onClick={onSticker}>贴纸</button>
      <button type="button" className="crop-chip" onClick={onShape}>形状</button>
      <button type="button" className="crop-chip" onClick={onDouble}>叠加</button>
      <button type="button" className="crop-chip" onClick={onDoodle}>涂鸦</button>
      <button type="button" className="crop-chip" onClick={onLight}>光效</button>
      <button type="button" className="crop-chip on" aria-pressed="true">双色调</button>
      <div className="retouch-modes" role="group" aria-label="双色调预设">
        {DUOTONE_PRESETS.map(preset => (
          <button
            key={preset.id} type="button"
            className={`crop-chip${options.shadow === preset.shadow
              && options.highlight === preset.highlight ? ' on' : ''}`}
            aria-pressed={options.shadow === preset.shadow
              && options.highlight === preset.highlight}
            onClick={() => onChange({
              preset: preset.id,
              shadow: preset.shadow,
              highlight: preset.highlight,
            })}
          >{preset.label}</button>
        ))}
      </div>
      <div className="duotone-colors">
        <label className="duotone-color">
          <span>暗部</span>
          <input
            type="color"
            aria-label="暗部颜色"
            value={options.shadow}
            onChange={event => onChange({
              preset: options.preset, shadow: event.target.value,
            })}
          />
        </label>
        <label className="duotone-color">
          <span>亮部</span>
          <input
            type="color"
            aria-label="亮部颜色"
            value={options.highlight}
            onChange={event => onChange({
              preset: options.preset, highlight: event.target.value,
            })}
          />
        </label>
      </div>
      <Slider
        label="强度" value={options.intensity}
        min={0} max={100} step={1}
        changed={options.intensity !== DEFAULT_DUOTONE.intensity}
        onChange={intensity => onChange({ intensity })}
      />
      <div className="crop-tools">
        <button type="button" className="crop-btn" onClick={onCancel}>取消</button>
        <Btn
          className="crop-done"
          disabled={applying || options.intensity <= 0}
          onClick={() => void onDone()}
        >应用双色调</Btn>
      </div>
    </>
  )
}
