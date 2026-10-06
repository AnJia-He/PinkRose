import { Slider } from './kit/Slider.tsx'
import type { LutMeta, LutRef } from '../../shared/lut.ts'

type Props = {
  luts: readonly LutMeta[]
  /**
   * ★ 2026-10-05 终审修复：清单**到手了没有**。
   *
   * ⚠️ 它和 `luts.length === 0` 是两件事 —— 拿"还没到手"当"你没有"说的就是
   *    「还没有导入过滤镜。」那句**假话**（用户的滤镜明明还在服务端上）。
   *    同功能的另外两处（`LutSettings` 的四态、`AccountPage` 的「模型」那一行）
   *    都做对了，只有用户最常看见的这一处没有。必填（给个默认 true 就是把这个
   *    编译期闸降级：将来谁少传一个 prop，空态又回来撒谎，而没有任何东西会红）。
   */
  lutsKnown: boolean
  value: LutRef | null
  /** id → 缩略图 dataURL。缺的那格画占位（一块灰底 + 名字），别画空 img */
  thumbs: Readonly<Record<number, string>>
  /** 「不用」那一格的缩略图（= 当前照片没套滤镜的样子） */
  noneThumb: string | null
  onPick: (lutId: number | null) => void
  onAmount: (amount: number) => void
  /** 一个滤镜都没有时那颗「去导入」 */
  onGoImport: () => void
  /** 清单没到手时那颗「再试一次」（重拉一次清单）—— 没有它就是一个死胡同。 */
  onRetryLuts: () => void
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
export default function LutPicker({
  luts, lutsKnown, value, thumbs, noneThumb, onPick, onAmount, onGoImport, onRetryLuts,
}: Props) {
  if (luts.length === 0) {
    // ① 还没到手 / 取不到：一句**中性**的话 + 一个重试的口子。
    //    「还没有导入过滤镜。」在这儿是假话（见 `lutsKnown` 那段），
    //    而"去导入"也不对 —— 用户该做的不是再导一个，是先把清单拿回来。
    if (!lutsKnown) {
      return (
        <div className="lut-picker">
          <p className="lut-empty">Lut 清单还没到手。</p>
          <button className="lut-import-go" onClick={onRetryLuts}>再试一次</button>
        </div>
      )
    }
    // ② 服务端**真的回了空清单**：这才是说这句话、给这条路的时候。
    return (
      <div className="lut-picker">
        <p className="lut-empty">还没有导入过 Lut。</p>
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
