import { useCallback, useRef, useState } from 'react'
import type { RetouchScene } from '../ui/Canvas'
import { createMask, defaultBrushRadius, maskBounds, type BrushMode } from '../core/retouch'
import { transparentToBitmap } from '../image/transparency'
import { selectBackgroundToMask, selectSubjectToMask } from '../image/backgroundSelect'
import {
  replaceBackgroundToBitmap, resolveBackgroundFill,
  type BackgroundKind,
} from '../image/backgroundReplace'
import { decodeImageFile } from '../image/decode'
import { applyBaseEdit, beginBaseEdit, discardStaleBaseEdit, type BaseEditToolDeps } from './baseEdit'

/**
 * **透明擦除（抠图）现场**（★ 2026-10-17）—— 「点修 → 抠图」。
 *
 * 和磨皮 / 局部同一套掩码与账本；不同只在提交：把掩码覆盖到的像素 alpha
 * 按覆盖率往下压，产出带透明通道的新底图。
 */
const MAX_PIXELS = 1_200_000
const VEIL_PIXELS = 150_000

export type TransparentDeps = BaseEditToolDeps

export function useTransparent(deps: TransparentDeps) {
  const {
    tool, image, setImage, history, setHistory, noticeBad,
    flushEdit, clearTransient, baseSeqRef, cursorIdRef, editSeqRef, markDirty, setTool,
  } = deps

  const [transparent, setTransparent] = useState<{
    radius: number; mode: BrushMode; dirty: boolean
    tolerance: number; picking: boolean; selecting: boolean
    backgroundKind: BackgroundKind; backgroundColor: string; backgroundName: string | null
    backgroundScale: number; backgroundX: number; backgroundY: number; backgroundFlip: boolean
  } | null>(null)
  const maskRef = useRef<Uint8Array | null>(null)
  const backgroundRef = useRef<ImageBitmap | null>(null)
  const [applying, setApplying] = useState(false)

  const closeBackgroundImage = useCallback(() => {
    backgroundRef.current?.close()
    backgroundRef.current = null
  }, [])

  const openTransparent = useCallback(() => {
    if (!image) return
    maskRef.current = createMask(image.width, image.height)
    setTransparent({
      radius: defaultBrushRadius(image.width, image.height),
      mode: 'paint',
      dirty: false,
      tolerance: 24,
      picking: false,
      selecting: false,
      backgroundKind: 'transparent',
      backgroundColor: '#f2c7b8',
      backgroundName: null,
      backgroundScale: 100,
      backgroundX: 0,
      backgroundY: 0,
      backgroundFlip: false,
    })
  }, [image])

  const closeTransparent = useCallback(() => {
    maskRef.current = null
    closeBackgroundImage()
    setTransparent(null)
  }, [closeBackgroundImage])

  const cancelTransparent = () => { closeTransparent(); setTool(null) }

  const markMaskDirty = useCallback(() => {
    setTransparent(r => (r && !r.dirty ? { ...r, dirty: true } : r))
  }, [])

  const startPickBackground = useCallback(() => {
    setTransparent(r => (r && !r.selecting ? { ...r, picking: !r.picking } : r))
  }, [])

  const pickBackground = useCallback(async (x: number, y: number) => {
    const scene = transparent
    const mask = maskRef.current
    if (!scene || !mask || !image) return
    setTransparent(r => (r ? { ...r, picking: false, selecting: true } : r))
    try {
      const result = await selectBackgroundToMask(image.bitmap, mask, x, y, scene.tolerance)
      if (result.covered === 0) {
        noticeBad('这块背景没选出东西，把容差调大一点，再点一次背景。')
        return
      }
      setTransparent(r => (r ? { ...r, dirty: true } : r))
    } catch (e) {
      console.error(e)
      noticeBad('这块背景没选成。再点一次；还不行就先用画笔涂。')
    } finally {
      setTransparent(r => (r ? { ...r, selecting: false } : r))
    }
  }, [transparent, image, noticeBad])

  /**
   * 本地估主体。识别会覆盖当前掩码，因此失败时把掩码清空并留在现场，
   * 让用户改用「点背景」或画笔，而不是拿一张半成品去换背景。
   */
  const autoSelectSubject = useCallback(async () => {
    const scene = transparent
    const mask = maskRef.current
    if (!scene || !mask || !image || scene.selecting || scene.picking) return
    setTransparent(r => (r ? { ...r, selecting: true, picking: false } : r))
    try {
      const result = await selectSubjectToMask(image.bitmap, mask)
      if (result.subjectRatio < 0.02 || result.subjectRatio > 0.95) {
        mask.fill(0)
        setTransparent(r => (r ? { ...r, selecting: false, dirty: false } : r))
        noticeBad(
          result.subjectRatio < 0.02
            ? '没认出主体。换一张背景更干净的照片，或者点一下背景、用手动画笔选。'
            : '整张图都被认成主体了。点一下背景，再用手动画笔补。',
        )
        return
      }
      setTransparent(r => (r ? { ...r, selecting: false, dirty: true } : r))
    } catch (e) {
      console.error(e)
      mask.fill(0)
      setTransparent(r => (r ? { ...r, selecting: false, dirty: false } : r))
      noticeBad('这次没认出主体。再试一次；还不行就点背景或用手动画笔选。')
    }
  }, [transparent, image, noticeBad])

  const setBackgroundKind = useCallback((kind: BackgroundKind) => {
    setTransparent(r => (r ? { ...r, backgroundKind: kind, picking: false } : r))
  }, [])

  const setBackgroundColor = useCallback((backgroundColor: string) => {
    setTransparent(r => (r ? { ...r, backgroundKind: 'color', backgroundColor } : r))
  }, [])

  const setBackgroundScale = useCallback((backgroundScale: number) => {
    setTransparent(r => (r ? { ...r, backgroundScale } : r))
  }, [])

  const setBackgroundX = useCallback((backgroundX: number) => {
    setTransparent(r => (r ? { ...r, backgroundX } : r))
  }, [])

  const setBackgroundY = useCallback((backgroundY: number) => {
    setTransparent(r => (r ? { ...r, backgroundY } : r))
  }, [])

  const toggleBackgroundFlip = useCallback(() => {
    setTransparent(r => (r ? { ...r, backgroundFlip: !r.backgroundFlip } : r))
  }, [])

  const chooseBackground = useCallback(async (file: File) => {
    if (!transparent || transparent.selecting || applying) return
    setTransparent(r => (r ? { ...r, selecting: true } : r))
    try {
      const decoded = await decodeImageFile(file)
      closeBackgroundImage()
      backgroundRef.current = decoded.bitmap
      setTransparent(r => (r ? {
        ...r, selecting: false, backgroundKind: 'image', backgroundName: file.name,
      } : r))
    } catch (e) {
      console.error(e)
      setTransparent(r => (r ? { ...r, selecting: false } : r))
      noticeBad('这张背景图打不开，换一张试试。')
    }
  }, [transparent, applying, closeBackgroundImage, noticeBad])

  const commitTransparent = useCallback(async () => {
    const scene = transparent
    const mask = maskRef.current
    if (!scene || !mask || !image) return
    const bounds = maskBounds(mask, image.width, image.height)
    if (!bounds) return
    const fill = resolveBackgroundFill(
      scene.backgroundKind, scene.backgroundColor, backgroundRef.current,
      {
        scale: scene.backgroundScale / 100,
        x: scene.backgroundX / 100,
        y: scene.backgroundY / 100,
        flip: scene.backgroundFlip,
      },
    )
    if (scene.backgroundKind === 'image' && !fill) return
    const area = (bounds.x1 - bounds.x0) * (bounds.y1 - bounds.y0)
    if (area > MAX_PIXELS) {
      noticeBad('这一块太大了，一次抠一小块吧 —— 分几次抠，又快又稳。')
      return
    }
    const slow = area > VEIL_PIXELS
    const gate = beginBaseEdit(baseSeqRef, cursorIdRef)
    setApplying(slow)
    try {
      if (slow) await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(() => r(null))))
      const { bitmap } = fill
        ? await replaceBackgroundToBitmap(image.bitmap, mask, fill)
        : await transparentToBitmap(image.bitmap, mask)
      if (!discardStaleBaseEdit(baseSeqRef, cursorIdRef, gate, bitmap, {
        log: '抠图回来时底图/位置已经变了（多半是生成落地或人跳了版本），这一下不写进去',
        notice: '抠的时候画面已经变了 —— 这一下没算数。要的话，再抠一次。',
      }, noticeBad)) {
        applyBaseEdit({
          at: gate.at, bitmap, history, setHistory, setImage,
          baseSeqRef, editSeqRef, markDirty, flushEdit, clearTransient,
        }, '这一抠')
      }
      closeTransparent()
      setTool(null)
    } catch (e) {
      console.error(e)
      noticeBad('这张照片没抠成。再试一次；还不行就换一张小一点的。')
    } finally {
      setApplying(false)
    }
  }, [transparent, image, history, noticeBad, closeTransparent, flushEdit, clearTransient])

  const transparentScene: RetouchScene | null = (() => {
    const mask = maskRef.current
    if (!image || !transparent || tool !== 'transparent' || !mask
      || transparent.picking || transparent.selecting) return null
    return { radius: transparent.radius, mode: transparent.mode, mask, onMaskChange: markMaskDirty }
  })()

  return {
    transparent, setTransparent, applying, openTransparent, closeTransparent,
    cancelTransparent, markMaskDirty, startPickBackground, pickBackground,
    autoSelectSubject, setBackgroundKind, setBackgroundColor,
    setBackgroundScale, setBackgroundX, setBackgroundY, toggleBackgroundFlip,
    chooseBackground,
    commitTransparent, transparentScene,
  }
}
