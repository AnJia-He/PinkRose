import { useCallback, useState } from 'react'
import type { Dispatch, SetStateAction } from 'react'
import type { CanvasFrameScene } from '../ui/Canvas'
import {
  canvasFrameToBitmap, DEFAULT_CANVAS_FRAME, type CanvasFrameOptions,
} from '../image/canvasFrame'
import { editLayersToBitmap } from '../image/layers'
import type { EditLayer } from '../../shared/layers.ts'
import { applyBaseEdit, beginBaseEdit, discardStaleBaseEdit, type BaseEditToolDeps } from './baseEdit'

/**
 * 「装饰 → 画布」的现场：比例 / 背景 / 边距。预览在 Canvas 上，提交时把
 * 当前底图重新排进新画布，写进当前版本账本，可撤销。
 */
export type CanvasFrameDeps = BaseEditToolDeps & {
  layers: EditLayer[]
  setLayers: Dispatch<SetStateAction<EditLayer[]>>
}

export function useCanvasFrame(deps: CanvasFrameDeps) {
  const {
    tool, image, setImage, history, setHistory, noticeBad,
    flushEdit, clearTransient, baseSeqRef, cursorIdRef, editSeqRef, markDirty, setTool,
    layers, setLayers,
  } = deps

  const [canvasFrame, setCanvasFrame] = useState<CanvasFrameOptions | null>(null)
  const [applying, setApplying] = useState(false)

  const openCanvasFrame = useCallback(() => {
    if (!image) return
    setCanvasFrame({ ...DEFAULT_CANVAS_FRAME })
  }, [image])

  const closeCanvasFrame = useCallback(() => setCanvasFrame(null), [])
  const cancelCanvasFrame = () => { closeCanvasFrame(); setTool(null) }

  const commitCanvasFrame = useCallback(async () => {
    const scene = canvasFrame
    if (!scene || !image) return
    if (scene.aspect === 'original' && scene.paddingPct <= 0) return
    const gate = beginBaseEdit(baseSeqRef, cursorIdRef)
    setApplying(true)
    let flattened: ImageBitmap | null = null
    try {
      flattened = await editLayersToBitmap(image.bitmap, layers)
      const { bitmap } = await canvasFrameToBitmap(flattened, scene)
      if (!discardStaleBaseEdit(baseSeqRef, cursorIdRef, gate, bitmap, {
        log: '画布回来时底图/位置已经变了（多半是生成落地或人跳了版本），这一下不写进去',
        notice: '做画布的时候画面已经变了 —— 这一下没算数。要的话，再做一次。',
      }, noticeBad)) {
        applyBaseEdit({
          at: gate.at, bitmap, history, setHistory, setImage,
          baseSeqRef, editSeqRef, markDirty, flushEdit, clearTransient,
          ...(layers.length ? { layers: [], setLayers } : {}),
        }, '这张画布')
      }
      closeCanvasFrame()
      setTool(null)
    } catch (e) {
      console.error(e)
      noticeBad('这张画布没做成。再试一次；还不行就换一张小一点的。')
    } finally {
      if (flattened && flattened !== image.bitmap) flattened.close()
      setApplying(false)
    }
  }, [canvasFrame, image, layers, setLayers, history, noticeBad, closeCanvasFrame, flushEdit, clearTransient])

  const canvasFrameScene: CanvasFrameScene | null = (() => {
    if (!image || !canvasFrame || tool !== 'canvas') return null
    return { options: canvasFrame }
  })()

  return {
    canvasFrame, setCanvasFrame, applying, openCanvasFrame, closeCanvasFrame,
    cancelCanvasFrame, commitCanvasFrame, canvasFrameScene,
  }
}
