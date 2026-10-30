import { useCallback, useRef, useState } from 'react'
import type { RetouchScene } from '../ui/Canvas'
import { createMask, defaultBrushRadius, maskBounds, type BrushMode } from '../core/retouch'
import {
  DEFAULT_SMOOTH_STRENGTH, DEFAULT_SMOOTH_TEXTURE, defaultSmoothRadius, smoothToBitmap,
} from '../image/smooth'
import { applyBaseEdit, beginBaseEdit, discardStaleBaseEdit, type BaseEditToolDeps } from './baseEdit'

/**
 * **磨皮画笔那一簇**（★ 2026-10-17，方案二）—— 工具行那颗「磨皮」的全部行为。
 *
 * 骨架照 `useRetouch`（点修）**一字不差**：现场 = 掩码 ref + 笔刷参数；
 * 掩码放 ref 里（千万像素级的 `Uint8Array` 不进 state）；引擎在
 * `image/smooth.ts`（引导滤波）；提交走 `app/baseEdit.ts` 的共享骨架 ——
 * 和裁剪 / 点修同一套三条：**不推快照、不进转盘、不写对话**，
 * 「这一磨」记进当前这一版自己的账本（调色屏左下角「上一步」退得回去）。
 *
 * ⚠️ 和点修不同的只有两处，都是磨皮自己的：
 *   · 现场多一个 **强度**（0~100，默认 60）—— 点修的"多重"由笔刷覆盖率管，
 *     磨皮的"多重"是算法本身的旋钮；
 *   · 提交成功后**没有**"补得有点糊"那一条通报（磨皮的结果是可预期的，
 *     没有点修"周围没参考"那种兜底路径）。
 */

/** 一次磨皮的**外接框**上限（像素）。耗时随它线性涨（引导滤波是 O(面积)）——
 *  和点修 `MAX_ERASE_PIXELS` 同一档：拦在这里，用户看到的是一句"分几次磨"，
 *  而不是十几秒的假死。 */
const MAX_SMOOTH_PIXELS = 1_200_000

/** 外接框大过它才盖「正在磨」的暗罩（理由同点修的 `ERASE_VEIL_PIXELS`：
 *  小块的毫秒级计算不盖 —— 盖出来的暗罩还没画到屏幕上就撤了，读起来是界面在抽）。 */
const SMOOTH_VEIL_PIXELS = 150_000

export type SmoothDeps = BaseEditToolDeps

export function useSmooth(deps: SmoothDeps) {
  const {
    tool, image, setImage, history, setHistory, noticeBad,
    flushEdit, clearTransient, baseSeqRef, cursorIdRef, editSeqRef, markDirty, setTool,
  } = deps

  /** 磨皮的现场：null = 没在磨。`dirty` = 涂过没有（决定那颗主按钮的亮灭）。 */
  const [smooth, setSmooth] = useState<{
    radius: number; mode: BrushMode; strength: number; texture: number; dirty: boolean
  } | null>(null)
  const smoothMaskRef = useRef<Uint8Array | null>(null)
  /** 正在磨：算的那几百毫秒~几秒盖暗罩用（小块不盖，同点修）。 */
  const [smoothing, setSmoothing] = useState(false)

  /** 进磨皮：按当前底图开一张空掩码。 */
  const openSmooth = useCallback(() => {
    if (!image) return
    smoothMaskRef.current = createMask(image.width, image.height)
    setSmooth({
      radius: defaultBrushRadius(image.width, image.height),
      mode: 'paint',
      strength: DEFAULT_SMOOTH_STRENGTH,
      texture: DEFAULT_SMOOTH_TEXTURE,
      dirty: false,
    })
  }, [image])

  /** 收磨皮（取消 / 完成 / 被别的工具顶掉都走它）：掩码**当场丢掉** ——
   *  再进去是新的一张。⚠️ 换底图的那几处都要调它（尺寸对不上号那件事，
   *  理由和 `closeRetouch` 一字不差）。 */
  const closeSmooth = useCallback(() => {
    smoothMaskRef.current = null
    setSmooth(null)
  }, [])

  /** 「取消」= **什么都没发生**：掩码一丢、工具收掉。 */
  const cancelSmooth = () => { closeSmooth(); setTool(null) }

  /** 掩码第一次有墨时喊它（同 `useRetouch.markMaskDirty`，重复喊是幂等的）。 */
  const markMaskDirty = useCallback(() => {
    setSmooth(r => (r && !r.dirty ? { ...r, dirty: true } : r))
  }, [])

  /**
   * 「磨这里」——本地磨一张新底图，给「当前这一版」记一笔账。
   * 和 `commitRetouch` 一字不差的那几条都在 `app/baseEdit.ts`；这里只剩
   * 磨皮自己的：掩码、太大就拦、慢的那档盖暗罩。
   */
  const commitSmooth = useCallback(async () => {
    const scene = smooth
    const mask = smoothMaskRef.current
    if (!scene || !mask || !image) return
    if (scene.strength <= 0) return
    const bounds = maskBounds(mask, image.width, image.height)
    if (!bounds) return
    const area = (bounds.x1 - bounds.x0) * (bounds.y1 - bounds.y0)
    // 太大就拦（耗时随外接框面积涨）——**留在现场**：用户可以换小笔刷重涂，
    // 也可以把橡皮拿来削掉一块再来。
    if (area > MAX_SMOOTH_PIXELS) {
      noticeBad('这一块太大了，一次磨一小块吧 —— 分几次磨，又快又稳。')
      return
    }
    const slow = area > SMOOTH_VEIL_PIXELS
    // 「这一下冲着哪一版去的」必须在 await 之前当场读（理由在
    // `app/baseEdit.ts` 的 `beginBaseEdit`）。
    const gate = beginBaseEdit(baseSeqRef, cursorIdRef)
    setSmoothing(slow)
    try {
      // 慢的那一档：先让暗罩真的画到屏幕上再开算（理由同 `commitRetouch`）。
      if (slow) await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(() => r(null))))
      const { bitmap } = await smoothToBitmap(image.bitmap, mask, {
        strength: scene.strength,
        texture: scene.texture,
        radius: defaultSmoothRadius(image.width, image.height),
      })
      if (!discardStaleBaseEdit(baseSeqRef, cursorIdRef, gate, bitmap, {
        log: '磨皮回来时底图/位置已经变了（多半是生成落地或人跳了版本），这一下不写进去',
        notice: '磨的时候画面已经变了 —— 这一下没算数。要的话，再磨一次。',
      }, noticeBad)) {
        applyBaseEdit({
          at: gate.at, bitmap, history, setHistory, setImage,
          baseSeqRef, editSeqRef, markDirty, flushEdit, clearTransient,
        }, '这一磨')
        // ★ 同裁剪 / 点修：**不往对话区写记录** —— 磨皮是调色区里的操作，
        //   账本才是它唯一的"账"；透明进转盘之类的事更是一格都不占。
      }
      closeSmooth()
      setTool(null)
    } catch (e) {
      console.error(e)
      noticeBad('这张照片没磨成。再试一次；还不行就换一张小一点的。')
    } finally {
      setSmoothing(false)
    }
    // ⚠️ `history` 在依赖里：同 `commitRetouch`（`applyBaseEdit` 那句检查读的就是它）。
  }, [smooth, image, history, noticeBad, closeSmooth, flushEdit, clearTransient])

  /**
   * 交给 `Canvas` 的磨皮现场 —— 每次渲染现算。
   * ⚠️ 复用点修那个 `RetouchScene` 类型和 `Canvas` 的 `retouch` 那一层
   *   （涂抹层 `ui/RetouchOverlay` 本来就是"掩码 + 笔刷"的通用件）——
   *   不为磨皮再加一个同款 prop。`tool === 'smooth'` 那半是保险。
   */
  const smoothScene: RetouchScene | null = (() => {
    const mask = smoothMaskRef.current
    if (!image || !smooth || tool !== 'smooth' || !mask) return null
    return { radius: smooth.radius, mode: smooth.mode, mask, onMaskChange: markMaskDirty }
  })()

  return {
    smooth, setSmooth, smoothing, openSmooth, closeSmooth,
    cancelSmooth, markMaskDirty, commitSmooth, smoothScene,
  }
}
