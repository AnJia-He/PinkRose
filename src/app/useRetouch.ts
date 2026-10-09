import { useCallback, useRef, useState } from 'react'
import type { RetouchScene } from '../ui/Canvas'
import { createMask, defaultBrushRadius, maskBounds, type BrushMode } from '../core/retouch'
import { eraseToBitmap } from '../image/erase'
import { applyBaseEdit, beginBaseEdit, discardStaleBaseEdit, type BaseEditToolDeps } from './baseEdit'

/**
 * **点修（消除笔）那一簇**（★ 2026-10-07 立、2026-10-08 从 `App.tsx` 搬出来）——
 * 工具行第二颗「点修」的全部行为。
 *
 *  现场 = **掩码**（图片像素的缓冲区，`ui/RetouchOverlay` 往里盖章）+ 笔刷参数。
 *  掩码放 ref 里（千万像素级的 `Uint8Array` 不进 state）；state 只留
 *  笔刷 / 模式 / 「有没有涂过」—— 后者让「擦掉这里」亮起来。
 *  引擎在 `image/heal.ts`（移植自 Compositor 的 `HealPixels.c`）。
 *
 * ⚠️ 和裁剪共用"在当前这一版底图上动一刀"的骨架（`app/baseEdit.ts`）。
 */
/**
 * 入参 = `BaseEditToolDeps` —— 点修和裁剪**同一张单子**（2026-10-09 收到
 * `baseEdit.ts` 里去了）；"现场只在 `tool === 'retouch'` 时交出去"那条注在那边。
 */
export type RetouchDeps = BaseEditToolDeps

/**
 * 一次擦除的**外接框**上限（像素）。耗时随它线性涨 —— 真照片探针实测
 * （`.superpowers/scratch/retouch-probe/`）：18 万像素 ≈ 1.7s、110 万 ≈ 4.1s。
 * 拦在这里，用户看到的是一句"分几次擦"，而不是十几秒的假死。
 */
const MAX_ERASE_PIXELS = 1_200_000

/**
 * 外接框大过它才盖「正在擦」的暗罩（约合 0.3s 起步）。
 * 小斑块是毫秒级 —— 盖出来的暗罩还没画到屏幕上就撤了，一闪一暗读起来是界面在抽
 * （和 `busy` 那条"只有生成这一段才盖"同一个理由）。
 */
const ERASE_VEIL_PIXELS = 150_000

export function useRetouch(deps: RetouchDeps) {
  const {
    tool, image, setImage, history, setHistory, noticeBad,
    flushEdit, clearTransient, baseSeqRef, cursorIdRef, editSeqRef, markDirty, setTool,
  } = deps

  /** 点修的现场：null = 没在点修。`dirty` = 涂过没有（决定那颗主按钮的亮灭）。 */
  const [retouch, setRetouch] = useState<{ radius: number; mode: BrushMode; dirty: boolean } | null>(null)
  const retouchMaskRef = useRef<Uint8Array | null>(null)
  /** 正在擦：算的那几百毫秒~几秒盖暗罩用（小斑块不盖，见 `ERASE_VEIL_PIXELS`）。 */
  const [erasing, setErasing] = useState(false)

  /** 进点修：按当前底图开一张空掩码。 */
  const openRetouch = useCallback(() => {
    if (!image) return
    retouchMaskRef.current = createMask(image.width, image.height)
    setRetouch({ radius: defaultBrushRadius(image.width, image.height), mode: 'paint', dirty: false })
  }, [image])

  /** 收点修（取消 / 完成 / 被别的工具顶掉都走它）：掩码**当场丢掉** ——
   *  再进去是新的一张（和裁剪"现场不会回来"同一条：工具是走一趟，不是常驻编辑器）。
   *  ⚠️ **换底图的那几处都要调它**（`onPick` / `loadSession` / `resetEditor` /
   *  裁剪完）：掩码的尺寸就是上一张照片的尺寸，留着要么对不上号、要么落点全错。 */
  const closeRetouch = useCallback(() => {
    retouchMaskRef.current = null
    setRetouch(null)
  }, [])

  /** 「取消」= **什么都没发生**（和 `cancelCrop` 同一句话）：掩码一丢、工具收掉。 */
  const cancelRetouch = () => { closeRetouch(); setTool(null) }

  /** 掩码第一次有墨时喊它。同一次涂抹里反复喊是**幂等**的（已经在 dirty 就原样返回，
   *  不白渲染）。 */
  const markMaskDirty = useCallback(() => {
    setRetouch(r => (r && !r.dirty ? { ...r, dirty: true } : r))
  }, [])

  /**
   * 「擦掉这里」——这个工具的全部意义：本地擦一张新底图，给「当前这一版」
   * **记一笔账**。
   *
   * 和 `commitCrop` **一字不差**的那几条（每一条都各有一笔账，别抄漏）——
   * ★ 2026-10-08：那几条已经是**同一份代码**了，全在 `app/baseEdit.ts`
   * （两个记号当场读、双对账作废、`pushEdit` 把"擦之前"压进 `past`、
   * `baseSeqRef++`、清"上一条照片的临时状态"、位图回收）；这里只剩点修
   * **自己**的：掩码、太大就拦、慢的那档盖暗罩、补糊了要说一句。
   * 两边都**不推新快照、不挪光标、不进转盘**（10-08 账本）。
   */
  const commitRetouch = useCallback(async () => {
    const scene = retouch
    const mask = retouchMaskRef.current
    if (!scene || !mask || !image) return
    const bounds = maskBounds(mask, image.width, image.height)
    if (!bounds) return
    const area = (bounds.x1 - bounds.x0) * (bounds.y1 - bounds.y0)
    // 太大就拦（耗时随外接框面积涨，见 `MAX_ERASE_PIXELS`）——**留在现场**：
    // 用户可以换小笔刷重涂，也可以把橡皮拿来削掉一块再来。
    if (area > MAX_ERASE_PIXELS) {
      noticeBad('这一块太大了，一次擦一小块吧 —— 分几次擦，又快又干净。')
      return
    }
    const slow = area > ERASE_VEIL_PIXELS
    // 和 `commitCrop` 同一条规矩：「这一下冲着哪一版去的」必须在 await 之前当场读
    //（updater 不保证当场跑，理由在 `app/baseEdit.ts` 的 `beginBaseEdit`）。
    const gate = beginBaseEdit(baseSeqRef, cursorIdRef)
    setErasing(slow)
    try {
      // 慢的那一档：先让暗罩**真的画到屏幕上**再开算（计算是同步的、会冻住
      // 渲染 —— 不隔两帧的话暗罩要等算完才出现，恰好是最需要它的时候）。
      if (slow) await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(() => r(null))))
      const { bitmap, usedSource } = await eraseToBitmap(image.bitmap, mask)
      if (!discardStaleBaseEdit(baseSeqRef, cursorIdRef, gate, bitmap, {
        log: '擦除回来时底图/位置已经变了（多半是生成落地或人跳了版本），这一下不写进去',
        notice: '擦的时候画面已经变了 —— 这一下没算数。要的话，再擦一次。',
      }, noticeBad)) {
        applyBaseEdit({
          at: gate.at, bitmap, history, setHistory, setImage,
          baseSeqRef, editSeqRef, markDirty, flushEdit, clearTransient,
        }, '这一擦')
        // ★★ 2026-10-08（同 `commitCrop`）：**不往对话区写记录** —— 擦除是
        //   调色区里的操作，账本才是它唯一的"账"（原来这里落过「擦干净了。」）。
        // ⚠️ 但**兜底那条路（周围没参考）补出来是糊的**这件事得说出来 —— 不说
        //   用户会以为工具坏了。走**顶上那条通报**（"这件事得跟你说一声"那条，
        //   说完可以收走），一句话都不进对话区。
        if (!usedSource) noticeBad('擦掉了（这块周围没什么好参考的，补得有点糊）。')
      }
      closeRetouch()
      setTool(null)
    } catch (e) {
      console.error(e)
      noticeBad('这张照片没擦成。再试一次；还不行就换一张小一点的。')
    } finally {
      setErasing(false)
    }
    // ⚠️ `history` 在依赖里：同 `commitCrop`（`applyBaseEdit` 那句检查读的就是它）。
  }, [retouch, image, history, noticeBad, closeRetouch, flushEdit, clearTransient])

  /**
   * 交给 `Canvas` 的点修现场 —— 每次渲染现算。
   * ⚠️ `tool === 'retouch'` 那半是保险：现场和工具是同一个动作里一起设的。
   */
  const retouchScene: RetouchScene | null = (() => {
    const mask = retouchMaskRef.current
    if (!image || !retouch || tool !== 'retouch' || !mask) return null
    return { radius: retouch.radius, mode: retouch.mode, mask, onMaskChange: markMaskDirty }
  })()

  return {
    retouch, setRetouch, erasing, openRetouch, closeRetouch,
    cancelRetouch, markMaskDirty, commitRetouch, retouchScene,
  }
}
