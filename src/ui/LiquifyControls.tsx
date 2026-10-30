import { Btn } from './kit/Btn.tsx'
import { Slider } from './kit/Slider.tsx'
import {
  defaultLiquifyRadius, LIQUIFY_DEFAULT_STRENGTH, maxLiquifyRadius,
  type LiquifyMode,
} from '../image/liquify'

/**
 * 液化的第二行（★ 2026-10-17）—— 调色 / 推移 / 收拢 / 笔刷 / 强度 / 重来 / 取消 / 应用液化。
 *
 * 「调色」切回同一个「局部」工具里的四项局部调色；「推移」沿拖动方向推像素，
 * 「收拢」把笔下的像素往笔触中心收（瘦脸最常用）。液化先在工作副本上连续改，
 * 点「应用液化」才写进当前底图。
 */
const MODES: [LiquifyMode, string][] = [['push', '推移'], ['pinch', '收拢']]

type Props = {
  image: { width: number; height: number }
  mode: LiquifyMode
  radius: number
  strength: number
  dirty: boolean
  applying: boolean
  onMode: (mode: LiquifyMode) => void
  onRadius: (radius: number) => void
  onStrength: (strength: number) => void
  onReset: () => void
  onTone: () => void
  onCancel: () => void
  onDone: () => void
}

export default function LiquifyControls({
  image, mode, radius, strength, dirty, applying,
  onMode, onRadius, onStrength, onReset, onTone, onCancel, onDone,
}: Props) {
  return (
    <>
      <button type="button" className="crop-chip" onClick={onTone}>调色</button>
      <div className="retouch-modes" role="group" aria-label="液化笔触">
        {MODES.map(([m, name]) => {
          const on = mode === m
          return (
            <button
              key={m} type="button"
              className={`crop-chip${on ? ' on' : ''}`}
              aria-pressed={on}
              onClick={() => onMode(m)}
            >{name}</button>
          )
        })}
      </div>
      <Slider
        label="笔刷" value={radius}
        min={4} max={maxLiquifyRadius(image.width, image.height)} step={1}
        changed={radius !== defaultLiquifyRadius(image.width, image.height)}
        onChange={onRadius}
      />
      <Slider
        label="强度" value={strength}
        min={0} max={100} step={1}
        changed={strength !== LIQUIFY_DEFAULT_STRENGTH}
        onChange={onStrength}
      />
      <button type="button" className="crop-btn" onClick={onReset} disabled={!dirty}>
        重来
      </button>
      <div className="crop-tools">
        <button type="button" className="crop-btn" onClick={onCancel}>取消</button>
        <Btn
          className="crop-done"
          disabled={!dirty || applying || strength <= 0}
          onClick={() => void onDone()}
        >应用液化</Btn>
      </div>
    </>
  )
}
