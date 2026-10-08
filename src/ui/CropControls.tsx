import { Btn } from './kit/Btn.tsx'
import { Slider } from './kit/Slider.tsx'
import { MAX_STRAIGHTEN, type CropSpec } from '../core/crop'

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
  { name: '4:3', value: 4 / 3 },
  { name: '3:4', value: 3 / 4 },
  { name: '16:9', value: 16 / 9 },
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
  onPickAspect: (aspect: number | null) => void
  /** 左右转 / 水平矫正共用一个 setter（`{ turns }` 或 `{ angle }`）。 */
  onTurns: (patch: { turns?: number; angle?: number }) => void
  onCancel: () => void
  onDone: () => void
}

export default function CropControls({
  image, spec, turns, aspect, onPickAspect, onTurns, onCancel, onDone,
}: Props) {
  return (
    <>
      <div className="crop-ratios" role="group" aria-label="比例">
        {cropRatios(image.width, image.height).map(r => {
          const on = aspect === r.value
          return (
            <button
              key={r.name} type="button"
              className={`crop-chip${on ? ' on' : ''}`}
              aria-pressed={on}
              onClick={() => onPickAspect(r.value)}
            >{r.name}</button>
          )
        })}
      </div>
      {/* 坐标方向：**正角度 = 照片在输出里逆时针转**（见 `image/crop.ts` 的 JSDoc）
          —— 所以「左转」是 +1 个直角。 */}
      <button type="button" className="crop-btn"
        onClick={() => onTurns({ turns: turns + 1 })}>左转</button>
      <button type="button" className="crop-btn"
        onClick={() => onTurns({ turns: turns - 1 })}>右转</button>
      <Slider
        label="水平矫正" value={spec.angle}
        min={-MAX_STRAIGHTEN} max={MAX_STRAIGHTEN} step={0.5}
        changed={spec.angle !== 0}
        onChange={angle => onTurns({ angle })}
      />
      <div className="crop-tools">
        <button type="button" className="crop-btn" onClick={onCancel}>取消</button>
        <Btn className="crop-done" onClick={() => void onDone()}>完成</Btn>
      </div>
    </>
  )
}
