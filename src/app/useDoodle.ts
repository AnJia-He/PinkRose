import { useCallback, useState } from 'react'
import type { DoodleScene } from '../ui/Canvas'
import { DEFAULT_DOODLE, doodleToBitmap, type DoodleStroke } from '../image/doodle'
import { applyBaseEdit, beginBaseEdit, discardStaleBaseEdit, type BaseEditToolDeps } from './baseEdit'

/** 涂鸦现场（★ 2026-10-18）—— 「装饰」里的第四种模式。 */
export type DoodleDeps = BaseEditToolDeps

export type DoodleState = {
  strokes: DoodleStroke[]
  color: string
  sizePct: number
  opacity: number
}

export function useDoodle(deps: DoodleDeps) {
  const {
    tool, image, setImage, history, setHistory, noticeBad,
    flushEdit, clearTransient, baseSeqRef, cursorIdRef, editSeqRef, markDirty, setTool,
  } = deps
  const [doodle, setDoodle] = useState<DoodleState | null>(null)
  const [applying, setApplying] = useState(false)

  const openDoodle = useCallback(() => {
    if (!image) return
    setDoodle({ strokes: [], ...DEFAULT_DOODLE })
  }, [image])
  const closeDoodle = useCallback(() => setDoodle(null), [])
  const cancelDoodle = () => { closeDoodle(); setTool(null) }

  const addStroke = useCallback((stroke: DoodleStroke) => {
    setDoodle(d => (d ? { ...d, strokes: [...d.strokes, stroke] } : d))
  }, [])
  const undoStroke = useCallback(() => {
    setDoodle(d => (d ? { ...d, strokes: d.strokes.slice(0, -1) } : d))
  }, [])
  const clearStrokes = useCallback(() => {
    setDoodle(d => (d ? { ...d, strokes: [] } : d))
  }, [])

  const commitDoodle = useCallback(async () => {
    const scene = doodle
    if (!scene || !image || scene.strokes.length === 0) return
    const gate = beginBaseEdit(baseSeqRef, cursorIdRef)
    setApplying(true)
    try {
      const bitmap = await doodleToBitmap(image.bitmap, scene.strokes)
      if (!discardStaleBaseEdit(baseSeqRef, cursorIdRef, gate, bitmap, {
        log: '涂鸦回来时底图/位置已经变了（多半是生成落地或人跳了版本），这一下不写进去',
        notice: '涂鸦的时候画面已经变了 —— 这一下没算数。要的话，再画一次。',
      }, noticeBad)) {
        applyBaseEdit({
          at: gate.at, bitmap, history, setHistory, setImage,
          baseSeqRef, editSeqRef, markDirty, flushEdit, clearTransient,
        }, '这一笔涂鸦')
      }
      closeDoodle()
      setTool(null)
    } catch (e) {
      console.error(e)
      noticeBad('这张涂鸦没画上去。再试一次；还不行就换一张小一点的。')
    } finally {
      setApplying(false)
    }
  }, [doodle, image, history, noticeBad, closeDoodle, flushEdit, clearTransient])

  const doodleScene: DoodleScene | null = (() => {
    if (!image || !doodle || tool !== 'doodle') return null
    return {
      strokes: doodle.strokes,
      color: doodle.color,
      sizePct: doodle.sizePct,
      opacity: doodle.opacity,
      onStroke: addStroke,
    }
  })()

  return {
    doodle, setDoodle, applying, openDoodle, closeDoodle, cancelDoodle,
    addStroke, undoStroke, clearStrokes, commitDoodle, doodleScene,
  }
}
