import { Btn } from './kit/Btn.tsx'
import { Slider } from './kit/Slider.tsx'
import { DEFAULT_DOODLE } from '../image/doodle'
import type { DoodleState } from '../app/useDoodle'

/**
 * 涂鸦的第二行（★ 2026-10-18）—— 边框 / 贴纸 / 叠加 / 涂鸦 /
 * 颜色 / 笔刷 / 不透明度 / 撤销 / 清空 / 取消 / 应用涂鸦。
 */
type Props = {
  doodle: DoodleState
  applying: boolean
  onChange: (patch: Partial<DoodleState>) => void
  onUndo: () => void
  onClear: () => void
  onCanvas: () => void
  onFrame: () => void
  onSticker: () => void
  onShape: () => void
  onDouble: () => void
  onLight: () => void
  onDuotone: () => void
  onCancel: () => void
  onDone: () => void
}

export default function DoodleControls({
  doodle, applying, onChange, onUndo, onClear,
  onCanvas, onFrame, onSticker, onShape, onDouble, onLight, onDuotone, onCancel, onDone,
}: Props) {
  return (
    <>
      <button type="button" className="crop-chip" onClick={onCanvas}>画布</button>
      <button type="button" className="crop-chip" onClick={onFrame}>边框</button>
      <button type="button" className="crop-chip" onClick={onSticker}>贴纸</button>
      <button type="button" className="crop-chip" onClick={onShape}>形状</button>
      <button type="button" className="crop-chip" onClick={onDouble}>叠加</button>
      <button type="button" className="crop-chip on" aria-pressed="true">涂鸦</button>
      <button type="button" className="crop-chip" onClick={onLight}>光效</button>
      <button type="button" className="crop-chip" onClick={onDuotone}>双色调</button>
      <label className="text-color">
        <span>颜色</span>
        <input
          type="color" aria-label="涂鸦颜色"
          value={doodle.color}
          onChange={e => onChange({ color: e.target.value })}
        />
      </label>
      <Slider
        label="笔刷" value={doodle.sizePct}
        min={1} max={20} step={1}
        changed={doodle.sizePct !== DEFAULT_DOODLE.sizePct}
        onChange={sizePct => onChange({ sizePct })}
      />
      <Slider
        label="不透明度" value={doodle.opacity}
        min={10} max={100} step={1}
        changed={doodle.opacity !== DEFAULT_DOODLE.opacity}
        onChange={opacity => onChange({ opacity })}
      />
      <button type="button" className="crop-btn" onClick={onUndo}
              disabled={applying || doodle.strokes.length === 0}>撤销一笔</button>
      <button type="button" className="crop-btn" onClick={onClear}
              disabled={applying || doodle.strokes.length === 0}>清空</button>
      <div className="crop-tools">
        <button type="button" className="crop-btn" onClick={onCancel}>取消</button>
        <Btn
          className="crop-done"
          disabled={applying || doodle.strokes.length === 0}
          onClick={() => void onDone()}
        >应用涂鸦</Btn>
      </div>
    </>
  )
}
