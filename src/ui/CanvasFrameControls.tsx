import { Btn } from './kit/Btn.tsx'
import { Slider } from './kit/Slider.tsx'
import {
  DEFAULT_CANVAS_FRAME, type CanvasFrameAspect, type CanvasFrameBackground,
  type CanvasFrameOptions, CANVAS_FRAME_PADDING_MAX,
} from '../image/canvasFrame'

/**
 * 「装饰 → 画布」的第二行：比例 / 背景 / 边距 / 颜色，以及装饰内的五个
 * 兄弟模式。预览在 Canvas，应用后写进当前底图。
 */
const ASPECTS: [CanvasFrameAspect, string][] = [
  ['original', '原图'], ['1:1', '1:1'], ['4:5', '4:5'],
  ['3:4', '3:4'], ['9:16', '9:16'], ['16:9', '16:9'],
]
const BACKGROUNDS: [CanvasFrameBackground, string][] = [
  ['color', '纯色'], ['blur', '模糊'], ['transparent', '透明'],
]

type Props = {
  options: CanvasFrameOptions
  applying: boolean
  onChange: (patch: Partial<CanvasFrameOptions>) => void
  onFrame: () => void
  onSticker: () => void
  onShape: () => void
  onDouble: () => void
  onDoodle: () => void
  onLight: () => void
  onDuotone: () => void
  onCancel: () => void
  onDone: () => void
}

export default function CanvasFrameControls({
  options, applying, onChange, onFrame, onSticker, onShape, onDouble, onDoodle, onLight, onDuotone,
  onCancel, onDone,
}: Props) {
  const unchanged = options.aspect === 'original' && options.paddingPct <= 0
  return (
    <>
      <button type="button" className="crop-chip on" aria-pressed="true">画布</button>
      <button type="button" className="crop-chip" onClick={onFrame}>边框</button>
      <button type="button" className="crop-chip" onClick={onSticker}>贴纸</button>
      <button type="button" className="crop-chip" onClick={onShape}>形状</button>
      <button type="button" className="crop-chip" onClick={onDouble}>叠加</button>
      <button type="button" className="crop-chip" onClick={onDoodle}>涂鸦</button>
      <button type="button" className="crop-chip" onClick={onLight}>光效</button>
      <button type="button" className="crop-chip" onClick={onDuotone}>双色调</button>
      <div className="retouch-modes" role="group" aria-label="画布比例">
        {ASPECTS.map(([value, label]) => {
          const on = options.aspect === value
          return (
            <button
              key={value} type="button"
              className={`crop-chip${on ? ' on' : ''}`}
              aria-pressed={on}
              onClick={() => onChange({ aspect: value })}
            >{label}</button>
          )
        })}
      </div>
      <div className="retouch-modes" role="group" aria-label="画布背景">
        {BACKGROUNDS.map(([value, label]) => {
          const on = options.background === value
          return (
            <button
              key={value} type="button"
              className={`crop-chip${on ? ' on' : ''}`}
              aria-pressed={on}
              onClick={() => onChange({ background: value })}
            >{label}</button>
          )
        })}
      </div>
      <Slider
        label="边距" value={options.paddingPct}
        min={0} max={CANVAS_FRAME_PADDING_MAX} step={1}
        changed={options.paddingPct !== DEFAULT_CANVAS_FRAME.paddingPct}
        onChange={paddingPct => onChange({ paddingPct })}
      />
      {options.background !== 'transparent' && (
        <label className="text-color">
          <span>颜色</span>
          <input
            type="color" aria-label="画布颜色"
            value={options.color}
            onChange={e => onChange({ color: e.target.value })}
          />
        </label>
      )}
      <div className="crop-tools">
        <button type="button" className="crop-btn" onClick={onCancel}>取消</button>
        <Btn
          className="crop-done"
          disabled={applying || unchanged}
          onClick={() => void onDone()}
        >应用画布</Btn>
      </div>
    </>
  )
}
