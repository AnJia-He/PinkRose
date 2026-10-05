import { Slider } from './kit/Slider.tsx'
import type { LutMeta, LutRef } from '../../shared/lut.ts'

type Props = {
  luts: readonly LutMeta[]
  value: LutRef | null
  /** id → 缩略图 dataURL。缺的那格画占位（一块灰底 + 名字），别画空 img */
  thumbs: Readonly<Record<number, string>>
  /** 「不用」那一格的缩略图（= 当前照片没套滤镜的样子） */
  noneThumb: string | null
  onPick: (lutId: number | null) => void
  onAmount: (amount: number) => void
  /** 一个滤镜都没有时那颗「去导入」 */
  onGoImport: () => void
}

/**
 * 滤镜格子 —— **微调区和对话区共用这一个组件**（和"主按钮只有一份"同一条规矩：
 * 两处各写一套的后果是它们迟早长得不一样）。
 *
 * 它**只管格子本体**：开合状态、什么时候去要缩略图，由两个宿主各自管
 * （微调区是折叠的一栏、对话区是一颗按钮，两者的开合语义本来就不同）。
 *
 * ⚠️ 每格是一个真 `<button>` + `aria-pressed`：读屏念得出"选中没有"，
 * 键盘也走得到 —— 别改成 div + onClick。
 */
export default function LutPicker({ luts, value, thumbs, noneThumb, onPick, onAmount, onGoImport }: Props) {
  if (luts.length === 0) {
    return (
      <div className="lut-picker">
        <p className="lut-empty">还没有导入过滤镜。</p>
        <button className="lut-import-go" onClick={onGoImport}>去导入</button>
      </div>
    )
  }
  return (
    <div className="lut-picker">
      <div className="lut-grid">
        <button
          className={value === null ? 'lut-tile on' : 'lut-tile'}
          aria-pressed={value === null}
          onClick={() => onPick(null)}
        >
          {noneThumb && <img className="lut-thumb" src={noneThumb} alt="" draggable={false} />}
          <span className="lut-tile-name">不用</span>
        </button>
        {luts.map((l) => {
          const on = value?.lutId === l.id
          const thumb = thumbs[l.id]
          return (
            <button key={l.id} className={on ? 'lut-tile on' : 'lut-tile'}
              aria-pressed={on} onClick={() => onPick(l.id)}>
              {thumb && <img className="lut-thumb" src={thumb} alt="" draggable={false} />}
              <span className="lut-tile-name">{l.name}</span>
            </button>
          )
        })}
      </div>
      {value && (
        <Slider label="强度" value={value.amount} min={0} max={100}
          changed={value.amount !== 100} onChange={onAmount} />
      )}
    </div>
  )
}
