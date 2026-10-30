import { Btn } from './kit/Btn.tsx'
import { Slider } from './kit/Slider.tsx'
import { defaultBrushRadius, maxBrushRadius, type BrushMode } from '../core/retouch'
import { DEFAULT_SMOOTH_STRENGTH, DEFAULT_SMOOTH_TEXTURE } from '../image/smooth'

/**
 * 磨皮的第二行（★ 2026-10-17，方案二）—— 画笔 / 橡皮 / 笔刷粗细 / **强度** /
 * 取消 / 「磨这里」。长相和交互与 `ui/RetouchControls`（点修）同一套：
 * 先涂地方，再按主按钮；「磨这里」就是完成，一个动作一趟，没有单独的"完成"。
 *
 * ⚠️ 和点修唯一多出来的一根是「强度」（0~100）：点修的算法没有强度这个旋钮
 *   （涂层盖多实由笔刷覆盖率管），磨皮有 —— 同一块地方涂好后，磨多重由它定。
 *   强度 0 时主按钮**不许按**（磨了等于没磨，不如别让它按）。
 * ⚠️ 主按钮禁用条件 = 没涂过（`dirty`）**或** 正在磨（`smoothing`）**或**
 *   强度 0 —— 三个都是"按了没意义"。
 */
const MODES: [BrushMode, string][] = [['paint', '画笔'], ['erase', '橡皮']]

type Props = {
  /** 手上这张照片（只读宽高 —— 笔刷半径的默认值 / 上限按它算）。 */
  image: { width: number; height: number }
  mode: BrushMode
  radius: number
  strength: number
  /** 纹理保留 0–100：0 最平滑，100 等于不磨。 */
  texture: number
  /** 涂过没有 —— 决定「磨这里」的亮灭。 */
  dirty: boolean
  /** 正在磨（算的那几百毫秒~几秒盖暗罩）：这一档主按钮也不许再按。 */
  smoothing: boolean
  onMode: (mode: BrushMode) => void
  onRadius: (radius: number) => void
  onStrength: (strength: number) => void
  onTexture: (texture: number) => void
  onCancel: () => void
  onDone: () => void
}

export default function SmoothControls({
  image, mode, radius, strength, texture, dirty, smoothing,
  onMode, onRadius, onStrength, onTexture, onCancel, onDone,
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
      <Slider
        label="强度" value={strength}
        min={0} max={100} step={1}
        changed={strength !== DEFAULT_SMOOTH_STRENGTH}
        onChange={onStrength}
      />
      <Slider
        label="纹理" value={texture}
        min={0} max={100} step={1}
        changed={texture !== DEFAULT_SMOOTH_TEXTURE}
        onChange={onTexture}
      />
      <div className="crop-tools">
        <button type="button" className="crop-btn" onClick={onCancel}>取消</button>
        <Btn
          className="crop-done"
          disabled={!dirty || smoothing || strength <= 0 || texture >= 100}
          onClick={() => void onDone()}
        >磨这里</Btn>
      </div>
    </>
  )
}
