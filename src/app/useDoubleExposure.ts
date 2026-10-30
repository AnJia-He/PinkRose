import { useCallback, useState } from 'react'
import type { DoubleExposureScene } from '../ui/Canvas'
import { decodeImageFile } from '../image/decode'
import {
  DEFAULT_DOUBLE_EXPOSURE, doubleExposureToBitmap, makeDoubleExposurePreview,
  type BlendMode,
} from '../image/doubleExposure'
import { applyBaseEdit, beginBaseEdit, discardStaleBaseEdit, type BaseEditToolDeps } from './baseEdit'

/** 双重曝光现场（★ 2026-10-17）—— 「装饰」里的第三种模式。 */
export type DoubleExposureDeps = BaseEditToolDeps

type Scene = {
  bitmap: ImageBitmap
  preview: string
  name: string
  mode: BlendMode
  opacity: number
}

export function useDoubleExposure(deps: DoubleExposureDeps) {
  const {
    tool, image, setImage, history, setHistory, noticeBad,
    flushEdit, clearTransient, baseSeqRef, cursorIdRef, editSeqRef, markDirty, setTool,
  } = deps
  const [double, setDouble] = useState<Scene | null>(null)
  const [applying, setApplying] = useState(false)

  const closeDouble = useCallback(() => {
    setDouble(d => {
      d?.bitmap.close()
      return null
    })
  }, [])
  const cancelDouble = () => { closeDouble(); setTool(null) }

  const chooseDouble = useCallback(async (file: File) => {
    if (!image) return
    try {
      const decoded = await decodeImageFile(file)
      setDouble(old => {
        old?.bitmap.close()
        return {
          bitmap: decoded.bitmap,
          preview: makeDoubleExposurePreview(image.width, image.height, decoded.bitmap),
          name: file.name,
          ...DEFAULT_DOUBLE_EXPOSURE,
        }
      })
    } catch (e) {
      console.error(e)
      noticeBad('第二张图打不开，换一张试试。')
    }
  }, [image, noticeBad])

  const commitDouble = useCallback(async () => {
    const scene = double
    if (!scene || !image || scene.opacity <= 0) return
    const gate = beginBaseEdit(baseSeqRef, cursorIdRef)
    setApplying(true)
    try {
      const bitmap = await doubleExposureToBitmap(image.bitmap, scene.bitmap, {
        mode: scene.mode, opacity: scene.opacity,
      })
      if (!discardStaleBaseEdit(baseSeqRef, cursorIdRef, gate, bitmap, {
        log: '叠加回来时底图/位置已经变了（多半是生成落地或人跳了版本），这一下不写进去',
        notice: '叠加的时候画面已经变了 —— 这一下没算数。要的话，再叠一次。',
      }, noticeBad)) {
        applyBaseEdit({
          at: gate.at, bitmap, history, setHistory, setImage,
          baseSeqRef, editSeqRef, markDirty, flushEdit, clearTransient,
        }, '这一叠')
      }
      closeDouble()
      setTool(null)
    } catch (e) {
      console.error(e)
      noticeBad('这两张图没叠成。再试一次；还不行就换小一点的图。')
    } finally {
      setApplying(false)
    }
  }, [double, image, history, noticeBad, closeDouble, flushEdit, clearTransient])

  const doubleScene: DoubleExposureScene | null = (() => {
    if (!double || tool !== 'double') return null
    return { preview: double.preview, mode: double.mode, opacity: double.opacity }
  })()

  return {
    double, setDouble, applying, closeDouble, cancelDouble, chooseDouble,
    commitDouble, doubleScene,
  }
}
