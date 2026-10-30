import { useCallback, useState } from 'react'
import type { Dispatch, SetStateAction } from 'react'
import type { FrameScene } from '../ui/Canvas'
import { DEFAULT_FRAME, frameToBitmap, type FrameOptions } from '../image/frame'
import { editLayersToBitmap } from '../image/layers'
import type { EditLayer } from '../../shared/layers.ts'
import { applyBaseEdit, beginBaseEdit, discardStaleBaseEdit, type BaseEditToolDeps } from './baseEdit'

/**
 * **边框那一簇**（★ 2026-10-17）—— 工具行「边框」的全部行为。
 *
 * 现场只有一份 `FrameOptions`（样式 / 颜色 / 宽度）；预览是
 * `ui/FrameOverlay` 画的，不产位图、不耗内存。点「应用边框」时走
 * `app/baseEdit.ts` 的共享骨架：换当前这一版底图、账本记一笔、可撤销；
 * 不进转盘、不写对话、不碰 `params`。
 */
export type FrameDeps = BaseEditToolDeps & {
  layers: EditLayer[]
  setLayers: Dispatch<SetStateAction<EditLayer[]>>
}

export function useFrame(deps: FrameDeps) {
  const {
    tool, image, setImage, history, setHistory, noticeBad,
    flushEdit, clearTransient, baseSeqRef, cursorIdRef, editSeqRef, markDirty, setTool,
    layers, setLayers,
  } = deps

  const [frame, setFrame] = useState<FrameOptions | null>(null)
  const [applying, setApplying] = useState(false)

  const openFrame = useCallback(() => {
    if (!image) return
    setFrame({ ...DEFAULT_FRAME })
  }, [image])

  const closeFrame = useCallback(() => setFrame(null), [])
  const cancelFrame = () => { closeFrame(); setTool(null) }

  const commitFrame = useCallback(async () => {
    const scene = frame
    if (!scene || !image || scene.widthPct <= 0) return
    const gate = beginBaseEdit(baseSeqRef, cursorIdRef)
    setApplying(true)
    let flattened: ImageBitmap | null = null
    try {
      flattened = await editLayersToBitmap(image.bitmap, layers)
      const { bitmap } = await frameToBitmap(flattened, scene)
      if (!discardStaleBaseEdit(baseSeqRef, cursorIdRef, gate, bitmap, {
        log: '边框回来时底图/位置已经变了（多半是生成落地或人跳了版本），这一下不写进去',
        notice: '加边框的时候画面已经变了 —— 这一下没算数。要的话，再加一次。',
      }, noticeBad)) {
        applyBaseEdit({
          at: gate.at, bitmap, history, setHistory, setImage,
          baseSeqRef, editSeqRef, markDirty, flushEdit, clearTransient,
          ...(layers.length ? { layers: [], setLayers } : {}),
        }, '这个边框')
      }
      closeFrame()
      setTool(null)
    } catch (e) {
      console.error(e)
      noticeBad('这个边框没加上。再试一次；还不行就换一张小一点的。')
    } finally {
      if (flattened && flattened !== image.bitmap) flattened.close()
      setApplying(false)
    }
  }, [frame, image, layers, setLayers, history, noticeBad, closeFrame, flushEdit, clearTransient])

  const frameScene: FrameScene | null = (() => {
    if (!image || !frame || tool !== 'frame') return null
    return { options: frame }
  })()

  return {
    frame, setFrame, applying, openFrame, closeFrame, cancelFrame, commitFrame, frameScene,
  }
}
