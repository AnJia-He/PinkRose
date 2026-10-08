import { Btn } from './kit/Btn.tsx'
import { Slider } from './kit/Slider.tsx'
import { defaultBrushRadius, maxBrushRadius, type BrushMode } from '../core/retouch'

/**
 * 点修的第二行（★ 2026-10-07 加、2026-10-08 从 `App.tsx` 拆出来，DOM 一个字没改）：
 * 画笔 / 橡皮 / 笔刷粗细 / 取消 / 「擦掉这里」（spec §3.2：先涂地方，再擦）。
 *
 * ⚠️ **「擦掉这里」就是完成**（这一擦给当前这一版记一笔账）—— 没有单独的"完成"
 * 按钮，一个动作一趟。
 * ⚠️ 它是**禁用**到涂过为止的（`dirty`）—— 空掩码提交等于什么都没发生，不如别让
 * 它可按。
 */
const MODES: [BrushMode, string][] = [['paint', '画笔'], ['erase', '橡皮']]

type Props = {
  /** 手上这张照片（只读宽高 —— 笔刷半径的默认值 / 上限按它算）。 */
  image: { width: number; height: number }
  mode: BrushMode
  radius: number
  /** 涂过没有 —— 决定「擦掉这里」的亮灭。 */
  dirty: boolean
  /** 正在擦（算的那几百毫秒~几秒盖暗罩）：这一档主按钮也不许再按。 */
  erasing: boolean
  onMode: (mode: BrushMode) => void
  onRadius: (radius: number) => void
  onCancel: () => void
  onDone: () => void
}

export default function RetouchControls({
  image, mode, radius, dirty, erasing, onMode, onRadius, onCancel, onDone,
}: Props) {
  return (
    <>
      <div className="retouch-modes" role="group" aria-label="笔触">
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
        min={4} max={maxBrushRadius(image.width, image.height)} step={1}
        changed={radius !== defaultBrushRadius(image.width, image.height)}
        onChange={onRadius}
      />
      <div className="crop-tools">
        <button type="button" className="crop-btn" onClick={onCancel}>取消</button>
        <Btn
          className="crop-done"
          disabled={!dirty || erasing}
          onClick={() => void onDone()}
        >擦掉这里</Btn>
      </div>
    </>
  )
}
