import { useCallback, useState } from 'react'
import type { DuotoneScene } from '../ui/Canvas'
import { DEFAULT_DUOTONE, duotoneToBitmap, type DuotoneOptions } from '../image/duotone'
import { applyBaseEdit, beginBaseEdit, discardStaleBaseEdit, type BaseEditToolDeps } from './baseEdit'

/** 双色调现场（★ 2026-10-19）—— 「装饰」里的第六种模式。 */
export type DuotoneDeps = BaseEditToolDeps

export function useDuotone(deps: DuotoneDeps) {
  const {
    tool, image, setImage, history, setHistory, noticeBad,
    flushEdit, clearTransient, baseSeqRef, cursorIdRef, editSeqRef, markDirty, setTool,
  } = deps
  const [duotone, setDuotone] = useState<DuotoneOptions | null>(null)
  const [applying, setApplying] = useState(false)

  const openDuotone = useCallback(() => {
    if (!image) return
    setDuotone({ ...DEFAULT_DUOTONE })
  }, [image])
  const closeDuotone = useCallback(() => setDuotone(null), [])
  const cancelDuotone = () => { closeDuotone(); setTool(null) }

  const commitDuotone = useCallback(async () => {
    const scene = duotone
    if (!scene || !image || scene.intensity <= 0) return
    const gate = beginBaseEdit(baseSeqRef, cursorIdRef)
    setApplying(true)
    try {
      const bitmap = await duotoneToBitmap(image.bitmap, scene)
      if (!discardStaleBaseEdit(baseSeqRef, cursorIdRef, gate, bitmap, {
        log: '双色调回来时底图/位置已经变了（多半是生成落地或人跳了版本），这一下不写进去',
        notice: '加双色调的时候画面已经变了 —— 这一下没算数。要的话，再加一次。',
      }, noticeBad)) {
        applyBaseEdit({
          at: gate.at, bitmap, history, setHistory, setImage,
          baseSeqRef, editSeqRef, markDirty, flushEdit, clearTransient,
        }, '这一层双色调')
      }
      closeDuotone()
      setTool(null)
    } catch (e) {
      console.error(e)
      noticeBad('这层双色调没加上去。再试一次；还不行就换一张小一点的。')
    } finally {
      setApplying(false)
    }
  }, [duotone, image, history, noticeBad, closeDuotone, flushEdit, clearTransient])

  const duotoneScene: DuotoneScene | null = (() => {
    if (!image || !duotone || tool !== 'duotone') return null
    return { options: duotone }
  })()

  return {
    duotone, setDuotone, applying, openDuotone, closeDuotone,
    cancelDuotone, commitDuotone, duotoneScene,
  }
}
