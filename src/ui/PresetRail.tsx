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
   * 现在套着哪个 —— 由 `activePresetId(params, 有没有滤镜, 我的清单)` 算出来。
   * `null` = 用户自己调过 / 挂着滤镜，那些格子全都不亮。
   */
  activeId: string | null
  /**
   * ★ 2026-10-10（「我的预设」）：自己存的那一份清单（第二段那排）。
   * id 是 `String(服务端 id)`，和内置共用一个 id 空间。
   * **空数组 = 整个分区不画**（没存过的人看到的版面一个像素都不变）。
   */
  mine: readonly Preset[]
  onPick: (p: Preset) => void
  /** 「原图」= 参数归零 + 摘掉滤镜（和面板上那颗「重置」是同一件事） */
  onClear: () => void
}

/**
 * 一格预设（内置和「我的」**同款** —— 两段的格子就是这一份长相）。
 *
 * ⚠️ 每格是真 `<button>` + `aria-pressed`（读屏念得出选没选中、键盘走得到）；
 *    缩略图没到手时**不画空 `<img>`**（那会是一个破图图标，看着像加载失败）；
 *    选中那格是 `.on`，长相跟着面板那条 `on` 走。
 */
function PresetTile({ preset, thumb, active, onPick }: {
  preset: Preset
  thumb: string | undefined
  active: boolean
  onPick: (p: Preset) => void
}) {
  return (
    <button
      className={active ? 'rail-tile on' : 'rail-tile'}
      aria-pressed={active}
      onClick={() => onPick(preset)}
    >
      <span className="rail-shot">
        {thumb && <img className="rail-thumb" src={thumb} alt="" draggable={false} />}
      </span>
      <span className="rail-tile-name">{preset.label}</span>
    </button>
  )
}

/**
 * 预设栏的**长相**（一格一张小图的那套格子）。缩略图从外面交进来，
 * 这样它自己不碰画布 —— 和 `LutPicker` 与 `AdjustmentPanel` 同一个分层：
 * 这一层管长相，"画不画、画成什么样"在 `app/usePresetThumbs`。
 */
export function PresetGrid({ thumbs, originalThumb, activeId, mine, onPick, onClear }: GridProps) {
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
        {PRESETS.map((p) => (
          <PresetTile key={p.id} preset={p} thumb={thumbs[p.id]}
            active={activeId === p.id} onPick={onPick} />
        ))}
      </div>
      {/* ★ 2026-10-10（「我的预设」）：自己存的那一段（设计 §5.2）—— 和上面同款
          格子、同款小图，点一下走**同一条**整组赋值。**一套都没有时整个分区不画**
          （现有版面零变化）；删光了它自己收回去。 */}
      {mine.length > 0 && (
        <>
          <div className="rail-head mine">我的预设</div>
          <div className="rail-grid">
            {mine.map((p) => (
              <PresetTile key={p.id} preset={p} thumb={thumbs[p.id]}
                active={activeId === p.id} onPick={onPick} />
            ))}
          </div>
        </>
      )}
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
 * ★ 2026-10-10（「我的预设」）：`mine` = 自己存的那份清单 —— 一起交进去，
 *   缩略图 / 点亮 / 点击三条路和内置**共用同一份**（预设栏第二段）。
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
export default function PresetRail({ image, cube, mine, activeId, onPick, onClear }: {
  image: DecodedImage | null
  cube: Cube | null
  mine: readonly Preset[]
  activeId: string | null
  onPick: (p: Preset) => void
  onClear: () => void
}) {
  const { thumbs } = usePresetThumbs({ image, cube, mine })
  return (
    <PresetGrid
      thumbs={thumbs.byId}
      originalThumb={thumbs.original}
      mine={mine}
      activeId={activeId}
      onPick={onPick}
      onClear={onClear}
    />
  )
}
