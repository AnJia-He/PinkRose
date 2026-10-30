import { useCallback, useRef, useState } from 'react'
import type { DecodedImage } from '../image/decode'
import type { LiquifyScene } from '../ui/Canvas'
import { makeCanvas } from '../core/canvas'
import {
  applyLiquifyStroke, defaultLiquifyRadius, LIQUIFY_DEFAULT_STRENGTH,
  type LiquifyMode,
} from '../image/liquify'
import type { LiquifyDrag } from '../ui/LiquifyOverlay'
import { applyBaseEdit, beginBaseEdit, discardStaleBaseEdit, type BaseEditToolDeps } from './baseEdit'

/**
 * **液化那一簇**（★ 2026-10-17）—— 从「局部」工具切进来的子模式。
 *
 * 工作副本是**一块离屏画布**：每松手一笔，只重采样笔刷覆盖的那一块，
 * 再把整张工作画布生成一张预览位图交给 Canvas。预览位图归这一簇所有，
 * 关闭 / 重置 / 提交时统一释放；提交成功后走 `app/baseEdit.ts` 记账，
 * 和裁剪 / 点修 / 磨皮 / 文字 / 边框同一条关系：只改当前这一版、可撤销。
 */
export type LiquifyDeps = BaseEditToolDeps

export function useLiquify(deps: LiquifyDeps) {
  const {
    tool, image, setImage, history, setHistory, noticeBad,
    flushEdit, clearTransient, baseSeqRef, cursorIdRef, editSeqRef, markDirty, setTool,
  } = deps

  const [liquify, setLiquify] = useState<{
    radius: number
    mode: LiquifyMode
    strength: number
    dirty: boolean
  } | null>(null)
  const [preview, setPreview] = useState<DecodedImage | null>(null)
  const [applying, setApplying] = useState(false)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const previewRef = useRef<DecodedImage | null>(null)
  const seqRef = useRef(0)
  const strokeBusyRef = useRef(false)

  const disposePreview = useCallback(() => {
    const old = previewRef.current
    previewRef.current = null
    setPreview(null)
    if (old) old.bitmap.close()
  }, [])

  const putPreview = useCallback((next: DecodedImage) => {
    const old = previewRef.current
    previewRef.current = next
    setPreview(next)
    // 让 React 先切到新位图再关旧的（同一帧里关掉可能闪一下）。
    if (old) setTimeout(() => old.bitmap.close(), 50)
  }, [])

  const openLiquify = useCallback(() => {
    if (!image) return
    try {
      const { canvas, ctx } = makeCanvas(
        image.width, image.height, '液化不了', { willReadFrequently: true },
      )
      ctx.drawImage(image.bitmap, 0, 0)
      canvasRef.current = canvas
      disposePreview()
      setLiquify({
        radius: defaultLiquifyRadius(image.width, image.height),
        mode: 'push',
        strength: LIQUIFY_DEFAULT_STRENGTH,
        dirty: false,
      })
    } catch (e) {
      console.error(e)
      noticeBad('这张照片开不了液化。换一张小一点的试试。')
    }
  }, [image, noticeBad, disposePreview])

  const closeLiquify = useCallback(() => {
    canvasRef.current = null
    seqRef.current++
    disposePreview()
    setLiquify(null)
  }, [disposePreview])

  const cancelLiquify = () => { closeLiquify(); setTool(null) }

  const applyStroke = useCallback(async (stroke: LiquifyDrag) => {
    const canvas = canvasRef.current
    const scene = liquify
    if (!canvas || !scene || strokeBusyRef.current) return
    strokeBusyRef.current = true
    try {
      const result = applyLiquifyStroke(canvas, {
        ...stroke, radius: scene.radius, strength: scene.strength, mode: scene.mode,
      })
      if (result.changed <= 0) return
      const seq = ++seqRef.current
      const bitmap = await createImageBitmap(canvas)
      if (seq !== seqRef.current) { bitmap.close(); return }
      putPreview({ bitmap, width: canvas.width, height: canvas.height })
      setLiquify(r => (r ? { ...r, dirty: true } : r))
    } catch (e) {
      console.error(e)
      noticeBad('这一笔液化没做成。再试一次；还不行就撤销后换小一点的笔刷。')
    } finally {
      strokeBusyRef.current = false
    }
  }, [liquify, noticeBad, putPreview])

  const resetLiquify = useCallback(() => {
    const canvas = canvasRef.current
    if (!canvas || !image) return
    const ctx = canvas.getContext('2d', { willReadFrequently: true })
    if (!ctx) return
    ctx.clearRect(0, 0, canvas.width, canvas.height)
    ctx.drawImage(image.bitmap, 0, 0)
    seqRef.current++
    disposePreview()
    setLiquify(r => (r ? { ...r, dirty: false } : r))
  }, [image, disposePreview])

  const commitLiquify = useCallback(async () => {
    const scene = liquify
    const canvas = canvasRef.current
    if (!scene || !canvas || !image || !scene.dirty || scene.strength <= 0) return
    const gate = beginBaseEdit(baseSeqRef, cursorIdRef)
    setApplying(true)
    try {
      const bitmap = await createImageBitmap(canvas)
      if (!discardStaleBaseEdit(baseSeqRef, cursorIdRef, gate, bitmap, {
        log: '液化回来时底图/位置已经变了（多半是生成落地或人跳了版本），这一下不写进去',
        notice: '液化的时候画面已经变了 —— 这一下没算数。要的话，再试一次。',
      }, noticeBad)) {
        applyBaseEdit({
          at: gate.at, bitmap, history, setHistory, setImage,
          baseSeqRef, editSeqRef, markDirty, flushEdit, clearTransient,
        }, '这一笔液化')
      }
      closeLiquify()
      setTool(null)
    } catch (e) {
      console.error(e)
      noticeBad('这张照片的液化没存下来。再试一次；还不行就换一张小一点的。')
    } finally {
      setApplying(false)
    }
  }, [liquify, image, history, noticeBad, closeLiquify, flushEdit, clearTransient])

  const liquifyScene: LiquifyScene | null = (() => {
    if (!image || !liquify || tool !== 'liquify') return null
    return { radius: liquify.radius, mode: liquify.mode, onStroke: stroke => void applyStroke(stroke) }
  })()

  return {
    liquify, setLiquify, preview, applying,
    openLiquify, closeLiquify, cancelLiquify, resetLiquify, commitLiquify, liquifyScene,
  }
}
