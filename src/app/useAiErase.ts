import { useCallback, useEffect, useRef, useState } from 'react'
import type { RetouchScene } from '../ui/Canvas'
import { createMask, defaultBrushRadius, maskBounds, type BrushMode } from '../core/retouch'
import {
  AI_ERASE_PROMPT, buildInpaintInput, compositeInpaint, inpaintAreaTooLarge, planInpaintCrop,
  localEditPrompt,
} from '../image/aiErase'
import { errorText, isAbort, isUnauthorized, postEdit } from '../api/client'
import {
  applyBaseEdit, beginBaseEdit, discardStaleBaseEdit, type BaseEditToolDeps,
} from './baseEdit'

/**
 * 「点修 → AI 消除」那一整条。
 *
 * 本地只负责选区、裁切和回贴；真正去掉物体的是云端改图模型，所以：
 * - 入口会明确说“会消耗生成额度”；
 * - 只把选区周围的一块方图送去，不重画整张；
 * - 回图只贴回掩码里，掩码外保持原图；
 * - 选得太大、没涂、正在生成时都不发请求。
 *
 * 提交走和裁剪 / 点修同一套 `baseEdit.ts` 骨架：改当前这一版的底图，
 * 记一笔账，可撤销，不占版本转盘。
 */
export type AiEraseDeps = BaseEditToolDeps & {
  /** 别的生成 / 打开照片正在进行时，不能抢占付费队列。 */
  blocked: boolean
  noticeOk: (text: string) => void
  /** 票中途失效时由 App 送回登录页。 */
  onUnauthorized: () => void
}

export function useAiErase(deps: AiEraseDeps) {
  const {
    tool, image, setImage, history, setHistory, noticeBad, noticeOk,
    flushEdit, clearTransient, baseSeqRef, cursorIdRef, editSeqRef, markDirty,
    setTool, blocked, onUnauthorized,
  } = deps

  const [scene, setScene] = useState<{
    radius: number; mode: BrushMode; dirty: boolean; prompt: string
  } | null>(null)
  const maskRef = useRef<Uint8Array | null>(null)
  const abortRef = useRef<AbortController | null>(null)
  const [applying, setApplying] = useState(false)

  const closeAiErase = useCallback(() => {
    abortRef.current?.abort()
    abortRef.current = null
    maskRef.current = null
    setScene(null)
  }, [])

  const openAiErase = useCallback(() => {
    if (!image || blocked) return
    maskRef.current = createMask(image.width, image.height)
    setScene({
      radius: defaultBrushRadius(image.width, image.height),
      mode: 'paint',
      dirty: false,
      prompt: '',
    })
  }, [image, blocked])

  const cancelAiErase = useCallback(() => {
    closeAiErase()
    setTool(null)
  }, [closeAiErase, setTool])

  const markMaskDirty = useCallback(() => {
    setScene(s => (s && !s.dirty ? { ...s, dirty: true } : s))
  }, [])

  const commitAiErase = useCallback(async () => {
    const current = scene
    const mask = maskRef.current
    if (!current || !mask || !image || applying || blocked) return

    const bounds = maskBounds(mask, image.width, image.height)
    if (!bounds) return
    const customPrompt = current.prompt.trim()
    if (inpaintAreaTooLarge(image.width, image.height, bounds)) {
      noticeBad('这一块太大了，一次消一小块 —— 分几次消，边缘会更自然。')
      return
    }

    // 和裁剪 / 点修同一条：await 之前当场记下“冲的是哪一版”。
    const gate = beginBaseEdit(baseSeqRef, cursorIdRef)
    const ac = new AbortController()
    abortRef.current = ac
    setApplying(true)
    try {
      const plan = planInpaintCrop(image.width, image.height, bounds)
      const input = await buildInpaintInput(image.bitmap, mask, plan)
      const out = await postEdit({
        imageDataUrl: input.imageDataUrl,
        editPrompt: customPrompt ? localEditPrompt(customPrompt) : AI_ERASE_PROMPT,
        width: input.size.width,
        height: input.size.height,
      }, ac.signal)
      const blob = await (await fetch(out.imageDataUrl)).blob()
      const generated = await createImageBitmap(blob)
      let bitmap: ImageBitmap
      try {
        bitmap = await compositeInpaint(image.bitmap, generated, mask, plan)
      } finally {
        generated.close()
      }
      if (discardStaleBaseEdit(baseSeqRef, cursorIdRef, gate, bitmap, {
        log: 'AI 消除回来时底图 / 位置已经变了，这一下不写进去',
        notice: '消除回来时画面已经变了 —— 这一下没算进去。要的话，再消一次。',
      }, noticeBad)) {
        closeAiErase()
        setTool(null)
        return
      }
      applyBaseEdit({
        at: gate.at, bitmap, history, setHistory, setImage,
        baseSeqRef, editSeqRef, markDirty, flushEdit, clearTransient,
      }, '这一下 AI 消除')
      closeAiErase()
      setTool(null)
      noticeOk(customPrompt
        ? '选中的地方改好了。想反悔就点「上一步」。'
        : '消除了。想反悔就点「上一步」。')
    } catch (e) {
      if (isUnauthorized(e)) {
        closeAiErase()
        onUnauthorized()
        return
      }
      if (isAbort(e)) {
        noticeBad('停了。')
      } else {
        console.error(e)
        noticeBad(errorText(e, '这次没消掉，再试一次；还不行就换一张小一点的。'))
      }
    } finally {
      abortRef.current = null
      setApplying(false)
    }
  }, [
    scene, image, applying, blocked, noticeBad, noticeOk, baseSeqRef, cursorIdRef,
    history, setHistory, setImage, editSeqRef, markDirty, flushEdit, clearTransient,
    closeAiErase, setTool, onUnauthorized,
  ])

  useEffect(() => () => { abortRef.current?.abort() }, [])

  const aiEraseScene: RetouchScene | null = (() => {
    const mask = maskRef.current
    if (!image || !scene || tool !== 'aiErase' || !mask) return null
    return { radius: scene.radius, mode: scene.mode, mask, onMaskChange: markMaskDirty }
  })()

  return {
    aiErase: scene, setAiErase: setScene, applying, blocked,
    openAiErase, closeAiErase, cancelAiErase, markMaskDirty,
    commitAiErase, aiEraseScene,
  }
}
