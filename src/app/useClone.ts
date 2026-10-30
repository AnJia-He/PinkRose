import { useCallback, useRef, useState } from 'react'
import type { DecodedImage } from '../image/decode'
import type { CloneScene } from '../ui/Canvas'
import { defaultBrushRadius } from '../core/retouch'
import { cloneToBitmap, type ClonePoint, type CloneStroke } from '../image/clone'
import { applyBaseEdit, beginBaseEdit, discardStaleBaseEdit, type BaseEditToolDeps } from './baseEdit'

/**
 * 「点修 → 克隆」现场：选一个源点，之后第一笔落点定下偏移，后续笔画都从
 * 原图副本复制。预览 / 提交统一走 `cloneToBitmap`，多笔不会互相复制已经
 * 复制过的内容；提交仍走 `baseEdit` 的新底图 / 账本。
 */
export type CloneDeps = BaseEditToolDeps

type CloneState = {
  radius: number
  source: ClonePoint | null
  offset: ClonePoint | null
  strokes: CloneStroke[]
  dirty: boolean
  picking: boolean
}

const PREVIEW_SIDE = 1400

export function useClone(deps: CloneDeps) {
  const {
    tool, image, setImage, history, setHistory, noticeBad,
    flushEdit, clearTransient, baseSeqRef, cursorIdRef, editSeqRef, markDirty, setTool,
  } = deps

  const [clone, setClone] = useState<CloneState | null>(null)
  const [preview, setPreview] = useState<DecodedImage | null>(null)
  const [applying, setApplying] = useState(false)
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
    if (old) setTimeout(() => old.bitmap.close(), 50)
  }, [])

  const openClone = useCallback(() => {
    if (!image) return
    disposePreview()
    setClone({
      radius: defaultBrushRadius(image.width, image.height),
      source: null,
      offset: null,
      strokes: [],
      dirty: false,
      picking: false,
    })
  }, [image, disposePreview])

  const closeClone = useCallback(() => {
    seqRef.current++
    disposePreview()
    setClone(null)
  }, [disposePreview])

  const cancelClone = () => { closeClone(); setTool(null) }

  const startPickSource = useCallback(() => {
    setClone(c => (c ? { ...c, picking: !c.picking } : c))
  }, [])

  const pickSource = useCallback((nx: number, ny: number) => {
    if (!image) return
    setClone(c => (c ? {
      ...c,
      source: {
        x: Math.max(0, Math.min(image.width - 1, nx * (image.width - 1))),
        y: Math.max(0, Math.min(image.height - 1, ny * (image.height - 1))),
      },
      offset: null,
      picking: false,
    } : c))
  }, [image])

  const applyStroke = useCallback(async (points: ClonePoint[]) => {
    const scene = clone
    if (!scene || !image || !scene.source || points.length === 0 || strokeBusyRef.current) return
    strokeBusyRef.current = true
    const offset = scene.offset ?? {
      x: scene.source.x - points[0]!.x,
      y: scene.source.y - points[0]!.y,
    }
    const strokes = [
      ...scene.strokes,
      { points, radius: scene.radius, offset },
    ]
    const seq = ++seqRef.current
    try {
      const out = await cloneToBitmap(image.bitmap, strokes, PREVIEW_SIDE)
      if (seq !== seqRef.current) { out.bitmap.close(); return }
      if (out.changed <= 0) return
      putPreview({ bitmap: out.bitmap, width: out.bitmap.width, height: out.bitmap.height })
      setClone(c => (c ? { ...c, strokes, offset, dirty: true } : c))
    } catch (e) {
      console.error(e)
      noticeBad('这一笔克隆没做成。再试一次；还不行就先取消。')
    } finally {
      strokeBusyRef.current = false
    }
  }, [clone, image, putPreview, noticeBad])

  const resetClone = useCallback(() => {
    seqRef.current++
    disposePreview()
    setClone(c => (c ? { ...c, strokes: [], offset: null, dirty: false } : c))
  }, [disposePreview])

  const commitClone = useCallback(async () => {
    const scene = clone
    if (!scene || !image || !scene.dirty || scene.strokes.length === 0) return
    const gate = beginBaseEdit(baseSeqRef, cursorIdRef)
    setApplying(true)
    try {
      const out = await cloneToBitmap(image.bitmap, scene.strokes)
      if (out.changed <= 0) {
        out.bitmap.close()
        noticeBad('这几笔太轻，画面没变。往源点旁边再涂一点。')
        return
      }
      if (!discardStaleBaseEdit(baseSeqRef, cursorIdRef, gate, out.bitmap, {
        log: '克隆回来时底图/位置已经变了（多半是生成落地或人跳了版本），这一下不写进去',
        notice: '克隆的时候画面已经变了 —— 这一下没算数。再涂一次。',
      }, noticeBad)) {
        applyBaseEdit({
          at: gate.at, bitmap: out.bitmap, history, setHistory, setImage,
          baseSeqRef, editSeqRef, markDirty, flushEdit, clearTransient,
        }, '这一盖')
      }
      closeClone()
      setTool(null)
    } catch (e) {
      console.error(e)
      noticeBad('这张照片的克隆没存下来。再试一次；还不行就先取消。')
    } finally {
      setApplying(false)
    }
  }, [clone, image, history, noticeBad, closeClone, flushEdit, clearTransient])

  const cloneScene: CloneScene | null = (() => {
    if (!clone || tool !== 'clone' || clone.picking) return null
    return {
      radius: clone.radius,
      source: clone.source,
      offset: clone.offset,
      onStroke: points => void applyStroke(points),
    }
  })()

  return {
    clone, setClone, preview, applying,
    openClone, closeClone, cancelClone, startPickSource, pickSource,
    resetClone, commitClone, cloneScene,
  }
}
