import { useState } from 'react'
import { Btn } from './kit/Btn.tsx'
import { Slider } from './kit/Slider.tsx'
import { MAX_STRAIGHTEN, type CropGuide, type CropSpec } from '../core/crop'

/**
 * 裁剪的第二行（★ 2026-10-06 加、2026-10-08 从 `App.tsx` 拆出来，DOM 一个字没改）：
 * 比例 / 左右转 / 水平矫正 / 取消 / 完成 —— spec §3.1 点名的这几样。
 * 它由 `App` 塞进 `ui/ToolBar` 的 `children`（那条"没有 children 就不画第二行"
 * 的判据在那边；**两个工具的第二行要收在一条三目里**，别写成两个并排的 `&&` ——
 * 理由见 App 里那段 ⚠️⚠️）。
 *
 * ⚠️ 比例档住在一排小药丸里；「水平矫正」用的是调色面板**同一个**滑块零件
 * （`ui/kit/Slider`：轨道 + 拇指 + 读屏一口气都有，双击还能回 0）；它在这一行的
 * 宽度由 CSS 给。
 */
export type CropRatio = { name: string; value: number | null }

/**
 * 第二行那一排比例（spec §3.1 点名的六个）。
 * ⚠️ 「原始」是**这张照片**自己的比例 —— 它得等照片到手才算得出来，
 *    所以这是个函数、不是模块级常量。
 * ⚠️ 判"哪一档亮着"用的是**全等**比较（`aspect === r.value`）：挑过哪一档
 *    存的就是那个数，`原始` 存的是 `imgW/imgH` 本身，对得上。
 */
const cropRatios = (imgW: number, imgH: number): CropRatio[] => [
  { name: '自由', value: null },
  { name: '1:1', value: 1 },
  { name: '4:5', value: 4 / 5 },
  { name: '3:4', value: 3 / 4 },
  { name: '9:16', value: 9 / 16 },
  { name: '16:9', value: 16 / 9 },
  { name: '3:2', value: 3 / 2 },
  { name: '2:3', value: 2 / 3 },
  { name: '4:3', value: 4 / 3 },
  { name: '原始', value: imgW / imgH },
]

type Props = {
  /** 手上这张照片（只读宽高 —— 比例档里的「原始」按它算）。 */
  image: { width: number; height: number }
  spec: CropSpec
  /** 整转（90° 的倍数）。 */
  turns: number
  /** 当前挑的比例档（`null` = 自由）。 */
  aspect: number | null
  grid?: boolean
  guide?: CropGuide
  onPickAspect: (aspect: number | null) => void
  onFlip: (axis: 'h' | 'v') => void
  onGrid: () => void
  /** 自动找地平线；找不到由上层负责说一句。 */
  onAutoStraighten?: () => void
  /** 主体感知构图：保持当前比例和框大小，把框移到主体上。 */
  onSmartCompose?: () => void
  smartComposing?: boolean
  /** 左右转 / 水平矫正共用一个 setter（`{ turns }` 或 `{ angle }`）。 */
  onTurns: (patch: { turns?: number; angle?: number }) => void
  onPerspective?: () => void
  onOutpaint?: () => void
  onUpscale?: () => void
  upscaling?: boolean
  canUpscale?: boolean
  upscaleTarget?: { width: number; height: number } | null
  upscaleFactor?: number
  onUpscaleFactor?: (factor: number) => void
  onCancel: () => void
  onDone: () => void
}

export default function CropControls({
  image, spec, turns, aspect, grid, guide, onPickAspect, onFlip, onGrid, onAutoStraighten, onTurns,
  onSmartCompose, smartComposing = false,
  onPerspective, onOutpaint, onUpscale, upscaling = false, canUpscale = true,
  upscaleTarget, upscaleFactor = 2, onUpscaleFactor, onCancel, onDone,
}: Props) {
  const [customOpen, setCustomOpen] = useState(false)
  const [customW, setCustomW] = useState(4)
  const [customH, setCustomH] = useState(5)
  const activeGuide = guide ?? (grid ? 'thirds' : 'off')
  const guideLabel = activeGuide === 'thirds' ? '三分'
    : activeGuide === 'golden' ? '黄金分割'
      : activeGuide === 'diagonal' ? '对角线'
        : '网格'

  const pickCustom = () => {
    setCustomOpen(true)
  }
  const changeCustom = (axis: 'w' | 'h', raw: string) => {
    const value = Math.max(0, Math.min(100, Number(raw) || 0))
    if (axis === 'w') setCustomW(value)
    else setCustomH(value)
  }
  const applyCustom = () => {
    if (customW > 0 && customH > 0) onPickAspect(customW / customH)
  }

  return (
    <>
      {onPerspective && (
        <button type="button" className="crop-chip" onClick={onPerspective}>透视</button>
      )}
      {onOutpaint && (
        <button type="button" className="crop-chip" onClick={onOutpaint}>AI 扩图</button>
      )}
      {onUpscale && onUpscaleFactor && (
        <div className="retouch-modes" role="group" aria-label="放大倍数">
          {[2, 4].map(factor => (
            <button
              key={factor}
              type="button"
              className={`crop-chip${upscaleFactor === factor ? ' on' : ''}`}
              aria-pressed={upscaleFactor === factor}
              onClick={() => onUpscaleFactor(factor)}
            >{factor}×</button>
          ))}
        </div>
      )}
      {onUpscale && (
        <button
          type="button"
          className="crop-chip"
          disabled={upscaling || !canUpscale}
          title={canUpscale && upscaleTarget
            ? `本机放大到 ${upscaleTarget.width}×${upscaleTarget.height}，不调用模型`
            : '这张图已经接近本机放大上限'}
          onClick={onUpscale}
        >{upscaling ? '放大中…' : '超清放大'}</button>
      )}
      <div className="crop-ratios" role="group" aria-label="比例">
        {cropRatios(image.width, image.height).map(r => {
          const on = !customOpen && aspect === r.value
          return (
            <button
              key={r.name} type="button"
              className={`crop-chip${on ? ' on' : ''}`}
              aria-pressed={on}
              onClick={() => { setCustomOpen(false); onPickAspect(r.value) }}
            >{r.name}</button>
          )
        })}
        <button
          type="button"
          className={`crop-chip${customOpen ? ' on' : ''}`}
          aria-pressed={customOpen}
          onClick={pickCustom}
        >自定义</button>
      </div>
      {customOpen && (
        <label className="crop-custom">
          <input
            aria-label="自定义比例宽" type="number" inputMode="decimal"
            min={1} max={100} step={1} value={customW}
            onChange={e => changeCustom('w', e.target.value)}
          />
          <span>:</span>
          <input
            aria-label="自定义比例高" type="number" inputMode="decimal"
            min={1} max={100} step={1} value={customH}
            onChange={e => changeCustom('h', e.target.value)}
          />
          <button type="button" className="crop-chip" onClick={applyCustom}>
            应用比例
          </button>
        </label>
      )}
      {/* 坐标方向：**正角度 = 照片在输出里逆时针转**（见 `image/crop.ts` 的 JSDoc）
          —— 所以「左转」是 +1 个直角。 */}
      <button type="button" className="crop-btn"
        onClick={() => onTurns({ turns: turns + 1 })}>左转</button>
      <button type="button" className="crop-btn"
        onClick={() => onTurns({ turns: turns - 1 })}>右转</button>
      {onAutoStraighten && (
        <button type="button" className="crop-chip" onClick={onAutoStraighten}>
          自动水平
        </button>
      )}
      {onSmartCompose && (
        <button
          type="button"
          className="crop-chip"
          disabled={smartComposing}
          onClick={onSmartCompose}
        >{smartComposing ? '识别中…' : '智能构图'}</button>
      )}
      <Slider
        label="水平矫正" value={spec.angle}
        min={-MAX_STRAIGHTEN} max={MAX_STRAIGHTEN} step={0.5}
        changed={spec.angle !== 0}
        onChange={angle => onTurns({ angle })}
      />
      <button type="button" className={`crop-chip${spec.flipH ? ' on' : ''}`}
        aria-pressed={!!spec.flipH} onClick={() => onFlip('h')}>水平翻转</button>
      <button type="button" className={`crop-chip${spec.flipV ? ' on' : ''}`}
        aria-pressed={!!spec.flipV} onClick={() => onFlip('v')}>垂直翻转</button>
      <button type="button" className={`crop-chip${activeGuide !== 'off' ? ' on' : ''}`}
        aria-pressed={activeGuide !== 'off'} onClick={onGrid}>{guideLabel}</button>
      <div className="crop-tools">
        <button type="button" className="crop-btn" onClick={onCancel}>取消</button>
        <Btn className="crop-done" onClick={() => void onDone()}>完成</Btn>
      </div>
    </>
  )
}
