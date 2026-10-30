import { useCallback, useState } from 'react'
import type { Dispatch, SetStateAction } from 'react'
import type { PerspectiveScene } from '../ui/Canvas'
import {
  defaultPerspectiveQuad, type PerspectiveQuad,
} from '../core/perspective'
import { perspectiveToBitmap } from '../image/perspective'
import { detectAutoPerspective } from '../image/autoPerspective'
import { editLayersToBitmap } from '../image/layers'
import type { EditLayer } from '../../shared/layers.ts'
import { applyBaseEdit, beginBaseEdit, discardStaleBaseEdit, type BaseEditToolDeps } from './baseEdit'

/** 四角自由透视现场（★ 2026-10-17）—— 「裁剪」里的子模式。 */
export type PerspectiveDeps = BaseEditToolDeps & {
  layers: EditLayer[]
  setLayers: Dispatch<SetStateAction<EditLayer[]>>
}

export function usePerspective(deps: PerspectiveDeps) {
  const {
    tool, image, setImage, history, setHistory, noticeBad,
    flushEdit, clearTransient, baseSeqRef, cursorIdRef, editSeqRef, markDirty, setTool,
    layers, setLayers,
  } = deps
  const [perspective, setPerspective] = useState<{ quad: PerspectiveQuad; dirty: boolean } | null>(null)
  const [applying, setApplying] = useState(false)
  const [autoDetecting, setAutoDetecting] = useState(false)

  const openPerspective = useCallback(() => {
    if (!image) return
    setPerspective({ quad: defaultPerspectiveQuad(), dirty: false })
  }, [image])

  const closePerspective = useCallback(() => setPerspective(null), [])
  const cancelPerspective = () => { closePerspective(); setTool(null) }

  const setQuad = useCallback((quad: PerspectiveQuad) => {
    setPerspective(p => (p ? { ...p, quad, dirty: true } : p))
  }, [])

  const resetPerspective = useCallback(() => {
    setPerspective(p => (p ? { ...p, quad: defaultPerspectiveQuad(), dirty: false } : p))
  }, [])

  /**
   * 自动找左右竖边，只把检测结果填进四个角。是否应用仍由用户按
   * 「应用透视」决定；没找到可信线条时明确说一句，不拿默认四角冒充成功。
   */
  const autoPerspective = useCallback(async () => {
    if (!perspective || !image) return
    const baseSeq = baseSeqRef.current
    const cursorId = cursorIdRef.current
    setAutoDetecting(true)
    try {
      const quad = await detectAutoPerspective(image.bitmap)
      if (baseSeqRef.current !== baseSeq || cursorIdRef.current !== cursorId) return
      if (!quad) {
        noticeBad('没找到明显的左右竖线，拖四个角对准建筑或屏幕边缘。')
        return
      }
      setQuad(quad)
    } catch (e) {
      console.error(e)
      noticeBad('这张照片的自动透视没算出来，拖四个角对准边缘试试。')
    } finally {
      setAutoDetecting(false)
    }
  }, [perspective, image, baseSeqRef, cursorIdRef, noticeBad, setQuad])

  const commitPerspective = useCallback(async () => {
    const scene = perspective
    if (!scene || !image || !scene.dirty) return
    const gate = beginBaseEdit(baseSeqRef, cursorIdRef)
    setApplying(true)
    let flattened: ImageBitmap | null = null
    try {
      // 透视要逐像素反采样，先让暗罩真的画出来再开算。
      await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(() => r(null))))
      flattened = await editLayersToBitmap(image.bitmap, layers)
      const bitmap = await perspectiveToBitmap(flattened, scene.quad)
      if (!discardStaleBaseEdit(baseSeqRef, cursorIdRef, gate, bitmap, {
        log: '透视回来时底图/位置已经变了（多半是生成落地或人跳了版本），这一下不写进去',
        notice: '透视的时候画面已经变了 —— 这一下没算数。要的话，再调一次。',
      }, noticeBad)) {
        applyBaseEdit({
          at: gate.at, bitmap, history, setHistory, setImage,
          baseSeqRef, editSeqRef, markDirty, flushEdit, clearTransient,
          ...(layers.length ? { layers: [], setLayers } : {}),
        }, '这一正')
      }
      closePerspective()
      setTool(null)
    } catch (e) {
      console.error(e)
      noticeBad('这张照片没校正成。再试一次；还不行就换一张小一点的。')
    } finally {
      if (flattened && flattened !== image.bitmap) flattened.close()
      setApplying(false)
    }
  }, [perspective, image, layers, setLayers, history, noticeBad, closePerspective, flushEdit, clearTransient])

  const perspectiveScene: PerspectiveScene | null = (() => {
    if (!image || !perspective || tool !== 'perspective') return null
    return { quad: perspective.quad, onChange: setQuad }
  })()

  return {
    perspective, setPerspective, applying, openPerspective, closePerspective,
    autoDetecting, autoPerspective, cancelPerspective, resetPerspective,
    commitPerspective, perspectiveScene,
  }
}
