import { useEffect, useRef, useState } from 'react'
import { PRESETS, type Preset } from '../core/presets.ts'
import { ZERO } from '../../shared/adjustments.ts'
import { useLutPreview } from './useLutPreview.ts'
import type { Cube } from '../../shared/lut.ts'
import type { DecodedImage } from '../image/decode'

export type PresetThumbs = {
  /** 「原图」那一格（全零、不挂滤镜） */
  original: string | null
  /** 预设 id → dataURL */
  byId: Record<string, string>
}

/**
 * 预设栏那一排小图：**用当前这张照片、每个预设画一张**（★ 2026-10-05）。
 *
 * 画的是"点下去会发生什么"：`render(预设自己的参数, 当前滤镜)` ——
 * 所以依赖里**没有 `params`**：用户拖滑块，这一排不该重画（他拖的是当前这张，
 * 不是那十二个风格）。这条和滤镜格子那边**正好相反**，别照着抄错
 * （那边画的是"当前参数 + 每个滤镜"，见 `useLuts.ensureThumbs`）。
 *
 * 三条和用户直接有关的取舍：
 *   · **边画边给**：每画好一张就补一格。十三个格子一起等的话，进来先看到的
 *     是一屏灰方块，每一格都像"加载失败"（滤镜那栏踩过这个，见 `useLuts`）。
 *   · **换照片要立刻清空**，换滤镜**不清**：前者清晚了屏幕上挂的是**上一张照片**
 *     的小图（性质不对）；后者清了就是整排闪一下再长出来，而旧的那几张只是
 *     "还没换上滤镜"，留着更稳。
 *   · **作废**：前一趟没跑完就换了照片/滤镜时，那一趟的结果一个字都不许写进
 *     状态（`seq` 守卫）。少了它，屏幕上是"一半旧照片一半新照片"的小图，
 *     而**看着一切正常**（滤镜那栏同一条守卫，别删）。
 *
 * ★ 2026-10-10（「我的预设」）：`mine` = 用户自己存的那一份清单 —— 画的活一个字
 *   没变，只是循环从 `PRESETS` 扩成 `[...PRESETS, ...mine]`（预设栏第二段）。
 */
export function usePresetThumbs({ image, cube, mine }: {
  image: DecodedImage | null
  cube: Cube | null
  /** ★ 2026-10-10：自己存的那份清单（id 是 `String(服务端 id)`，和内置同一个空间） */
  mine: readonly Preset[]
}): { thumbs: PresetThumbs } {
  const [thumbs, setThumbs] = useState<PresetThumbs>({ original: null, byId: {} })
  const ensurePreview = useLutPreview()
  const seq = useRef(0)
  /** 上一趟画的是哪张照片 —— 判"要不要立刻清空"（换滤镜时不清） */
  const lastImage = useRef<DecodedImage | null>(null)

  useEffect(() => {
    const s = ++seq.current
    if (!image) {
      lastImage.current = null
      setThumbs({ original: null, byId: {} })
      return
    }
    if (lastImage.current !== image) {
      lastImage.current = image
      setThumbs({ original: null, byId: {} })
    }
    const p = ensurePreview()
    void (async () => {
      await p.setImage(image)
      if (s !== seq.current) return
      const original = p.render(ZERO, null)
      if (s !== seq.current) return
      setThumbs(prev => ({ ...prev, original }))
      for (const preset of [...PRESETS, ...mine]) {
        const t = p.render(preset.adjustments, cube)
        if (s !== seq.current) return
        if (!t) continue
        setThumbs(prev => ({ ...prev, byId: { ...prev.byId, [preset.id]: t } }))
      }
    })().catch((e) => console.error('预设缩略图没画出来：', e))
    // ⚠️ `mine` 在依赖数组里：**存/删一套那一刻，那一格跟着长/消**（整排重画一遍）。
    //    拖滑块照旧不重画 —— `params` 故意不在依赖里（这一排画的是每个预设自己的
    //    参数 + 当前滤镜，见文件头）。所以**调用方必须给稳定的引用**（App 那边用
    //    `useMemo` 包）：每次渲染一个新数组 = 这个 effect 每渲染跑一趟 =
    //    `setThumbs` 每渲染写一次 = React 报 "Maximum update depth exceeded"。
  }, [image, cube, ensurePreview, mine])

  return { thumbs }
}
