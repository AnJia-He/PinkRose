import { useCallback, useEffect, useRef } from 'react'
import { createLutPreview, type LutPreview } from '../render/lutPreview.ts'

/**
 * 一块**离屏预览器**的生命周期：懒建 + 卸载时 dispose。
 *
 * "缩略图"这件事有两处要用（滤镜格子 `app/useLuts`、预设栏 `app/usePresetThumbs`），
 * 而每处都要踩同一个坑，所以写法只留这一份：
 *
 * ⚠️ **懒建 + 卸载时 dispose —— 不许改成"在 effect 里建"**：StrictMode 会把
 *    "挂载 → 卸载 → 再挂载"整个重放一遍，在 effect 里建、在 cleanup 里 dispose
 *    的话，第二次挂载拿到的是一个**已经 dispose 的实例**。它看着一切正常
 *    （对象在、方法在），要到真渲染时才露馅。守卫见 `useLutPreview.test.tsx`。
 *
 * 调用方**各拿一个实例**（不是全局单例）：两边画的尺寸和时机都不同，
 * 共用一块画布等于让它们互相踩 —— 而 WebGL 上下文多开一个是不要钱的。
 */
export function useLutPreview(): () => LutPreview {
  const preview = useRef<LutPreview | null>(null)

  useEffect(() => () => { preview.current?.dispose(); preview.current = null }, [])

  // useCallback 只是让身份稳定：调用方会在自己的 useCallback / 异步闭包里用它，
  // 身份每次渲染都变的话，那些依赖数组就白写了。
  return useCallback(() => {
    if (!preview.current) preview.current = createLutPreview()
    return preview.current
  }, [])
}
