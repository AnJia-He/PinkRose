import { useCallback, useState } from 'react'
import type { LightScene } from '../ui/Canvas'
import { DEFAULT_LIGHT, lightToBitmap, type LightOptions } from '../image/light'
import { applyBaseEdit, beginBaseEdit, discardStaleBaseEdit, type BaseEditToolDeps } from './baseEdit'

/** 光效现场（★ 2026-10-18）—— 「装饰」里的第五种模式。 */
export type LightDeps = BaseEditToolDeps

export function useLight(deps: LightDeps) {
  const {
    tool, image, setImage, history, setHistory, noticeBad,
    flushEdit, clearTransient, baseSeqRef, cursorIdRef, editSeqRef, markDirty, setTool,
  } = deps
  const [light, setLight] = useState<LightOptions | null>(null)
  const [applying, setApplying] = useState(false)

  const openLight = useCallback(() => {
    if (!image) return
    setLight({ ...DEFAULT_LIGHT })
  }, [image])
  const closeLight = useCallback(() => setLight(null), [])
  const cancelLight = () => { closeLight(); setTool(null) }

  const commitLight = useCallback(async () => {
    const scene = light
    if (!scene || !image || scene.intensity <= 0) return
    const gate = beginBaseEdit(baseSeqRef, cursorIdRef)
    setApplying(true)
    try {
      const bitmap = await lightToBitmap(image.bitmap, scene)
      if (!discardStaleBaseEdit(baseSeqRef, cursorIdRef, gate, bitmap, {
        log: '光效回来时底图/位置已经变了（多半是生成落地或人跳了版本），这一下不写进去',
        notice: '加光效的时候画面已经变了 —— 这一下没算数。要的话，再加一次。',
      }, noticeBad)) {
        applyBaseEdit({
          at: gate.at, bitmap, history, setHistory, setImage,
          baseSeqRef, editSeqRef, markDirty, flushEdit, clearTransient,
        }, '这一层光')
      }
      closeLight()
      setTool(null)
    } catch (e) {
      console.error(e)
      noticeBad('这层光没加上去。再试一次；还不行就换一张小一点的。')
    } finally {
      setApplying(false)
    }
  }, [light, image, history, noticeBad, closeLight, flushEdit, clearTransient])

  const lightScene: LightScene | null = (() => {
    if (!image || !light || tool !== 'light') return null
    return { options: light }
  })()

  return {
    light, setLight, applying, openLight, closeLight, cancelLight, commitLight, lightScene,
  }
}
