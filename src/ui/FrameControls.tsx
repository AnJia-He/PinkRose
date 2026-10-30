import { Btn } from './kit/Btn.tsx'
import { Slider } from './kit/Slider.tsx'
import { DEFAULT_FRAME, type FrameOptions, type FrameStyle } from '../image/frame'

/**
 * 边框工具的第二行（★ 2026-10-17）—— 样式 / 宽度 / 颜色 / 取消 / 应用边框。
 *
 * 照片上的预览由 `ui/FrameOverlay` 画；这一行只改现场选项。应用后写进
 * 当前这一版的底图、账本记一笔、可撤销；不再回来改样式。
 */
const STYLES: [FrameStyle, string][] = [
  ['solid', '纯色'],
  ['polaroid', '拍立得'],
  ['film', '胶片'],
  ['rounded', '圆角'],
]

type Props = {
  options: FrameOptions
  applying: boolean
  onStyle: (style: FrameStyle) => void
  onWidth: (widthPct: number) => void
  onColor: (color: string) => void
  onCanvas: () => void
  onSticker: () => void
  onShape: () => void
  onDouble: () => void
  onDoodle: () => void
  onLight: () => void
  onDuotone: () => void
  onCancel: () => void
  onDone: () => void
}

export default function FrameControls({
  options, applying, onStyle, onWidth, onColor, onCanvas, onSticker, onShape, onDouble, onDoodle, onLight, onDuotone,
  onCancel, onDone,
}: Props) {
  return (
    <>
      <button type="button" className="crop-chip" onClick={onCanvas}>画布</button>
      <button type="button" className="crop-chip on" aria-pressed="true">边框</button>
      <button type="button" className="crop-chip" onClick={onSticker}>贴纸</button>
      <button type="button" className="crop-chip" onClick={onShape}>形状</button>
      <button type="button" className="crop-chip" onClick={onDouble}>叠加</button>
      <button type="button" className="crop-chip" onClick={onDoodle}>涂鸦</button>
      <button type="button" className="crop-chip" onClick={onLight}>光效</button>
      <button type="button" className="crop-chip" onClick={onDuotone}>双色调</button>
      <div className="retouch-modes" role="group" aria-label="边框样式">
        {STYLES.map(([style, name]) => {
          const on = options.style === style
          return (
            <button
              key={style} type="button"
              className={`crop-chip${on ? ' on' : ''}`}
              aria-pressed={on}
              onClick={() => onStyle(style)}
            >{name}</button>
          )
        })}
      </div>
      <Slider
        label="宽度" value={options.widthPct}
        min={0} max={20} step={0.5}
        changed={options.widthPct !== DEFAULT_FRAME.widthPct}
        onChange={onWidth}
      />
      <label className="text-color">
        <span>颜色</span>
        <input
          type="color"
          aria-label="边框颜色"
          value={options.color}
          onChange={e => onColor(e.target.value)}
        />
      </label>
      <div className="crop-tools">
        <button type="button" className="crop-btn" onClick={onCancel}>取消</button>
        <Btn
          className="crop-done"
          disabled={applying || options.widthPct <= 0}
          onClick={() => void onDone()}
        >应用边框</Btn>
      </div>
    </>
  )
}
