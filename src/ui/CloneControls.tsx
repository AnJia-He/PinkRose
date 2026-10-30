import { Btn } from './kit/Btn.tsx'
import { Slider } from './kit/Slider.tsx'
import { defaultBrushRadius, maxBrushRadius } from '../core/retouch'

/**
 * 「点修 → 克隆」第二行：修补 / 选源点 / 笔刷 / 重来 / 取消 / 应用克隆。
 * 第一笔落点与源点的差就是后续所有笔画的复制方向。
 */
type Props = {
  image: { width: number; height: number }
  radius: number
  hasSource: boolean
  picking: boolean
  dirty: boolean
  applying: boolean
  onPickSource: () => void
  onRadius: (radius: number) => void
  onReset: () => void
  onBack: () => void
  onCancel: () => void
  onDone: () => void
}

export default function CloneControls({
  image, radius, hasSource, picking, dirty, applying,
  onPickSource, onRadius, onReset, onBack, onCancel, onDone,
}: Props) {
  return (
    <>
      <button type="button" className="crop-chip" onClick={onBack}>修补</button>
      <button
        type="button"
        className={`crop-chip${picking ? ' on' : ''}`}
        aria-pressed={picking}
        onClick={onPickSource}
      >{hasSource ? '换源点' : '选源点'}</button>
      <span className="tool-note">
        {picking ? '点一下要复制的源点' : hasSource ? '在目标处涂抹；第一笔定下复制方向' : '先选源点'}
      </span>
      <Slider
        label="笔刷" value={radius}
        min={4} max={maxBrushRadius(image.width, image.height)} step={1}
        changed={radius !== defaultBrushRadius(image.width, image.height)}
        onChange={onRadius}
      />
      <button type="button" className="crop-btn" onClick={onReset} disabled={!dirty}>
        重来
      </button>
      <div className="crop-tools">
        <button type="button" className="crop-btn" onClick={onCancel}>取消</button>
        <Btn
          className="crop-done"
          disabled={!hasSource || !dirty || applying}
          onClick={() => void onDone()}
        >应用克隆</Btn>
      </div>
    </>
  )
}
