import { useCallback, useMemo, useState } from 'react'
import type { Dispatch, SetStateAction } from 'react'
import type { RenderLimit } from '../render/limits'
import { probeLimit } from '../render/limits'
import {
  DEFAULT_UPSCALE_FACTOR, upscaleTarget, upscaleToBitmap,
} from '../image/upscale'
import { editLayersToBitmap } from '../image/layers'
import type { EditLayer } from '../../shared/layers.ts'
import {
  applyBaseEdit, beginBaseEdit, discardStaleBaseEdit,
  type BaseEditToolDeps,
} from './baseEdit'

const FALLBACK_LIMIT: RenderLimit = { maxSide: 4096, maxArea: null }

export type UpscaleDeps = BaseEditToolDeps & {
  noticeOk: (text: string) => void
  layers: EditLayer[]
  setLayers: Dispatch<SetStateAction<EditLayer[]>>
}

export function useUpscale(deps: UpscaleDeps) {
  const {
    image, setImage, history, setHistory, noticeBad, noticeOk,
    flushEdit, clearTransient, baseSeqRef, cursorIdRef, editSeqRef, markDirty,
    layers, setLayers,
  } = deps
  const [upscaling, setUpscaling] = useState(false)
  const [factor, setFactor] = useState(DEFAULT_UPSCALE_FACTOR)
  const limit = useMemo(() => probeLimit() ?? FALLBACK_LIMIT, [])
  const target = useMemo(
    () => (image ? upscaleTarget(image.width, image.height, limit, factor) : null),
    [image, limit, factor],
  )

  const upscale = useCallback(async (): Promise<boolean> => {
    if (!image || !target || upscaling) return false
    const gate = beginBaseEdit(baseSeqRef, cursorIdRef)
    setUpscaling(true)
    let flattened: ImageBitmap | null = null
    try {
      flattened = await editLayersToBitmap(image.bitmap, layers)
      const bitmap = await upscaleToBitmap(flattened, target.width, target.height)
      if (!discardStaleBaseEdit(baseSeqRef, cursorIdRef, gate, bitmap, {
        log: '超清放大回来时底图/位置已经变了，这一版不写进去',
        notice: '放大的时候画面已经变了 —— 这一次没算数。要的话，再放一次。',
      }, noticeBad)) {
        applyBaseEdit({
          at: gate.at, bitmap, history, setHistory, setImage,
          baseSeqRef, editSeqRef, markDirty, flushEdit, clearTransient,
          ...(layers.length ? { layers: [], setLayers } : {}),
        }, '这一次超清放大')
        noticeOk(`已放大到 ${target.width}×${target.height}。`)
        return true
      }
    } catch (e) {
      console.error(e)
      noticeBad('这张图没放大成。先缩一点，或者换一个浏览器再试。')
    } finally {
      if (flattened && flattened !== image.bitmap) flattened.close()
      setUpscaling(false)
    }
    return false
  }, [
    image, target, upscaling, layers, setLayers, history, noticeBad, noticeOk,
    flushEdit, clearTransient, markDirty,
  ])

  return { upscaling, canUpscale: !!target, target, factor, setFactor, upscale }
}
