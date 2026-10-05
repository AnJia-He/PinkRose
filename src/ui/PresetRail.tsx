import { PRESETS, ORIGINAL_ID, type Preset } from '../core/presets'
import { usePresetThumbs } from '../app/usePresetThumbs'
import type { Cube } from '../../shared/lut.ts'
import type { DecodedImage } from '../image/decode'

type GridProps = {
  /** id → 缩略图 dataURL（缺的那格只剩名字） */
  thumbs: Readonly<Record<string, string>>
  /** 「原图」那一格的缩略图（= 这张照片什么都没套的样子） */
  originalThumb: string | null
  /**
   * 现在套着哪个 —— 由 `activePresetId(params, 有没有滤镜)` 算出来。
   * `null` = 用户自己调过 / 挂着滤镜，那一排全都不亮。
   */
  activeId: string | null
  onPick: (p: Preset) => void
  /** 「原图」= 参数归零 + 摘掉滤镜（和面板上那颗「重置」是同一件事） */
  onClear: () => void
}

/**
 * 预设栏的**长相**（一格一张小图的那套格子）。缩略图从外面交进来，
 * 这样它自己不碰画布 —— 和 `LutPicker` 与 `AdjustmentPanel` 同一个分层：
 * 这一层管长相，"画不画、画成什么样"在 `app/usePresetThumbs`。
 */
export function PresetGrid({ thumbs, originalThumb, activeId, onPick, onClear }: GridProps) {
  return (
    <aside className="rail" aria-label="预设">
      <div className="rail-head">预设</div>
      <div className="rail-grid">
        {/* 「原图」在最前 —— 和剪映那一排的「无」同一个位置、同一个意思：
            先有一个"什么都不要"的出口，后面才是各种风格。 */}
        <button
          className={activeId === ORIGINAL_ID ? 'rail-tile on' : 'rail-tile'}
          aria-pressed={activeId === ORIGINAL_ID}
          onClick={onClear}
        >
          <span className="rail-shot">
            {originalThumb && <img className="rail-thumb" src={originalThumb} alt="" draggable={false} />}
          </span>
          <span className="rail-tile-name">原图</span>
        </button>
        {PRESETS.map((p) => {
          const on = activeId === p.id
          const thumb = thumbs[p.id]
          return (
            <button
              key={p.id}
              className={on ? 'rail-tile on' : 'rail-tile'}
              aria-pressed={on}
              onClick={() => onPick(p)}
            >
              <span className="rail-shot">
                {thumb && <img className="rail-thumb" src={thumb} alt="" draggable={false} />}
              </span>
              <span className="rail-tile-name">{p.label}</span>
            </button>
          )
        })}
      </div>
    </aside>
  )
}

/**
 * 预设栏 —— 照片**左边**那条一格一张小图的竖栏（★ 2026-10-05）。
 *
 * 用户要的是「像剪映一样」：不是一串名字，而是**每格都用自己的照片画出来**的
 * 效果小图，点一下直接套上。所以他交进来的是**照片和当前滤镜**，
 * 那十三张小图由这一栏自己去画（`app/usePresetThumbs`）。
 *
 * ⚠️ 画图的活挂在**这个组件**上（而不是 App 顶上）是有意的：`App` 那边每一屏
 *    都挂着，而这一栏**只在调色屏存在** —— 挂在 App 上等于在对话页、作品页也
 *    白画十三张。这也正是"离屏画布多开一块不要钱"那个前提的用法。
 *
 * ⚠️ 三件事和 `LutPicker`（滤镜格子）**故意长得一样**，改的时候别只改一边：
 *   · 每格是真 `<button>` + `aria-pressed`（读屏念得出选没选中、键盘走得到）；
 *   · 缩略图没到手时**不画空 `<img>`**（那会是一个破图图标，看着像加载失败）；
 *   · 选中那格是 `.on`，长相跟着面板那条 `on` 走。
 */
export default function PresetRail({ image, cube, activeId, onPick, onClear }: {
  image: DecodedImage | null
  cube: Cube | null
  activeId: string | null
  onPick: (p: Preset) => void
  onClear: () => void
}) {
  const { thumbs } = usePresetThumbs({ image, cube })
  return (
    <PresetGrid
      thumbs={thumbs.byId}
      originalThumb={thumbs.original}
      activeId={activeId}
      onPick={onPick}
      onClear={onClear}
    />
  )
}
