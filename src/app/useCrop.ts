import { useCallback, useState } from 'react'
import type { Dispatch, SetStateAction } from 'react'
import type { CropScene } from '../ui/Canvas'
import type { EditLayer } from '../../shared/layers.ts'
import { cropToBitmap } from '../image/crop'
import { editLayersToBitmap } from '../image/layers'
import { detectStraighten } from '../image/straighten'
import { detectSubjectBox } from '../image/smartCrop'
import {
  clampRect, effectiveAngle, fitAspect, inscribedRect, rectFromSize,
  rotatedBounds, nextCropGuide, MAX_STRAIGHTEN,
  type CropGuide, type CropRect, type CropSpec,
} from '../core/crop'
import { smartCropRect } from '../core/smartCrop'
import { applyBaseEdit, beginBaseEdit, discardStaleBaseEdit, type BaseEditToolDeps } from './baseEdit'

/**
 * **裁剪那一簇**（★ 2026-10-06 立、2026-10-08 从 `App.tsx` 搬出来）——
 * 工具行第一颗「裁剪」的全部行为。
 *
 *  几何算式全在 `core/crop.ts`（外框 / 内接矩形 / 比例 / 输出尺寸），
 *  框的手势在 `ui/CropOverlay`，落到像素上在 `image/crop.ts`。
 *  这一层只干三件事：**记住现场**、**把该重算的算出来**、
 *  **完成时给「当前这一版」记一笔账**（★ 10-08 账本：不再推新的一步）。
 *
 * ⚠️ 和点修共用"在当前这一版底图上动一刀"的骨架（`app/baseEdit.ts`）——
 *   `commitCrop` 里只剩裁剪自己的：坏掉的像素活儿 + 两句话 + 收现场。
 */
/**
 * 入参 = `BaseEditToolDeps` —— 裁剪和点修**同一张单子**（2026-10-09 收到
 * `baseEdit.ts` 里去了）；"现场只在 `tool === 'crop'` 时交出去"那条注在那边。
 */
export type CropDeps = BaseEditToolDeps & {
  layers: EditLayer[]
  setLayers: Dispatch<SetStateAction<EditLayer[]>>
}

/**
 * 某个角度下**默认的那个框**：居中的最大内接矩形（不碰空角），
 * 再按比例档收一下（"装得下为前提"那件事交给 `core/crop` 的 `fitAspect`）。
 *
 * ★ 2026-10-06（跨任务裁定）：**角度一变，框就重置成它** —— 这是
 *   `core/crop.ts` 文件头那条硬规矩的落点。之后用户拖来拖去的过程中，
 *   框还会被 `CropOverlay` 夹在**内接区**里（同一块地方，见那边的注释）——
 *   两处合起来，"永远不裁出空白角"才成立。
 */
function defaultCropRect(
  imgW: number, imgH: number, angleDeg: number, aspect: number | null,
): CropRect {
  return rectFromSize(
    fitAspect(inscribedRect(imgW, imgH, angleDeg), aspect),
    rotatedBounds(imgW, imgH, angleDeg),
  )
}

export function useCrop(deps: CropDeps) {
  const {
    tool, image, setImage, history, setHistory, noticeBad,
    flushEdit, clearTransient, baseSeqRef, cursorIdRef, editSeqRef, markDirty, setTool,
    layers, setLayers,
  } = deps

  /** 裁剪的现场：null = 没在裁。`turns` 是整转（90° 的倍数），`spec.angle` 是矫正角。 */
  const [crop, setCrop] = useState<{
    spec: CropSpec; turns: number; aspect: number | null; guide: CropGuide
  } | null>(null)
  const [smartComposing, setSmartComposing] = useState(false)

  /** 进裁剪：按当前底图算"默认的那个框"（居中的最大内接矩形）。 */
  const openCrop = useCallback(() => {
    if (!image) return
    setCrop({
      spec: { rect: defaultCropRect(image.width, image.height, 0, null), angle: 0 },
      turns: 0, aspect: null, guide: 'off',
    })
  }, [image])

  /** 收裁剪现场（**不碰工具**那格）—— 工具行切走时用（`pickTool` 里那句）。 */
  const closeCrop = useCallback(() => setCrop(null), [])

  /** 框动了（`CropOverlay` 拖出来的归一化矩形）。 */
  const setCropRect = useCallback((rect: CropRect) => {
    setCrop(c => (c ? { ...c, spec: { ...c.spec, rect } } : c))
  }, [])

  /**
   * **角度变了**（左转 / 右转 / 水平矫正滑杆）→ 框**重置成居中的最大内接矩形**
   * （再按比例档收一下，见 `defaultCropRect`）。
   * 这是 `core/crop.ts` 文件头那条硬规矩：一转就有空角，框得先收回来 ——
   * 之后用户再拖，`CropOverlay` 也在同一块内接区里夹着它。
   */
  const setCropAngle = useCallback((patch: { turns?: number; angle?: number }) => {
    setCrop(c => {
      if (!c || !image) return c
      const turns = patch.turns ?? c.turns
      const angle = patch.angle ?? c.spec.angle
      const eff = effectiveAngle({ rect: c.spec.rect, angle }, turns)
      return {
        ...c, turns,
        spec: { ...c.spec, angle, rect: defaultCropRect(image.width, image.height, eff, c.aspect) },
      }
    })
  }, [image])

  /**
   * 换个比例档：把**现在这个框**按新比例收一下（`fitAspect` 只缩不放），
   * 心还是原来那个心，收完再夹回内接区里 ——
   * 挑个比例不该把框甩到别的地方去，也不该悄悄把它放大。
   */
  const pickCropAspect = useCallback((aspect: number | null) => {
    setCrop(c => {
      if (!c || !image) return c
      const eff = effectiveAngle(c.spec, c.turns)
      const bounds = rotatedBounds(image.width, image.height, eff)
      const inner = rectFromSize(inscribedRect(image.width, image.height, eff), bounds)
      const px = fitAspect({ w: c.spec.rect.w * bounds.w, h: c.spec.rect.h * bounds.h }, aspect)
      const w = px.w / bounds.w
      const h = px.h / bounds.h
      const cx = c.spec.rect.x + c.spec.rect.w / 2
      const cy = c.spec.rect.y + c.spec.rect.h / 2
      return {
        ...c, aspect,
        spec: {
          ...c.spec,
          rect: clampRect({
            x: Math.min(inner.x + inner.w - w, Math.max(inner.x, cx - w / 2)),
            y: Math.min(inner.y + inner.h - h, Math.max(inner.y, cy - h / 2)),
            w, h,
          }),
        },
      }
    })
  }, [image])

  /** 水平 / 垂直翻转：只改朝向，不改框和输出尺寸。 */
  const toggleCropFlip = useCallback((axis: 'h' | 'v') => {
    setCrop(c => {
      if (!c) return c
      return {
        ...c,
        spec: axis === 'h'
          ? { ...c.spec, flipH: !c.spec.flipH }
          : { ...c.spec, flipV: !c.spec.flipV },
      }
    })
  }, [])

  /** 构图参考线：只影响预览，不写像素。 */
  const toggleCropGrid = useCallback(() => {
    setCrop(c => (c ? { ...c, guide: nextCropGuide(c.guide) } : c))
  }, [])

  /**
   * 自动水平：量当前底图，找到可信的地平线就把「水平矫正」拨过去。
   *
   * 只改预览参数（`spec.angle`），不写像素；用户还能继续拖滑杆、取消。
   * 找不到 / 算不出来时**明确说一句**，不假装已经扶正。
   * 取 0.5° 档 —— 和滑杆的 step 一致，落下去的数字看得懂。
   */
  const autoStraighten = useCallback(() => {
    if (!crop || !image) return
    try {
      const detected = detectStraighten(image.bitmap)
      if (detected === null) {
        noticeBad('没找到明显的水平线，手动拖一下「水平矫正」。')
        return
      }
      const angle = Math.round(
        Math.max(-MAX_STRAIGHTEN, Math.min(MAX_STRAIGHTEN, detected)) * 2,
      ) / 2
      setCropAngle({ angle })
    } catch (e) {
      console.error(e)
      noticeBad('这张照片的自动水平没算出来，手动拖一下「水平矫正」。')
    }
  }, [crop, image, noticeBad, setCropAngle])

  /**
   * 智能构图：先选一个比例，再在底图上找主体，把现有框平移到主体上。
   *
   * 只改预览框，不写像素、不提交。识别期间用户可以继续拖框；框的计算放在
   * updater 里，回来时用的是最新现场。底图版本变了就作废这一趟。
   */
  const smartCompose = useCallback(async () => {
    if (!crop || !image) return
    if (crop.aspect === null) {
      noticeBad('先选一个画面比例，再用智能构图。')
      return
    }
    const seq = baseSeqRef.current
    setSmartComposing(true)
    try {
      const subject = await detectSubjectBox(image.bitmap)
      if (baseSeqRef.current !== seq) return
      if (!subject) {
        noticeBad('没认出主体，手动拖一下裁剪框。')
        return
      }
      setCrop(c => {
        if (!c) return c
        const eff = effectiveAngle(c.spec, c.turns)
        const bounds = rotatedBounds(image.width, image.height, eff)
        const inner = rectFromSize(inscribedRect(image.width, image.height, eff), bounds)
        const rect = smartCropRect(
          c.spec.rect, inner, image.width, image.height, eff, subject,
        )
        return { ...c, spec: { ...c.spec, rect } }
      })
    } catch (e) {
      console.error(e)
      noticeBad('这张照片的智能构图没算出来，手动拖一下裁剪框。')
    } finally {
      setSmartComposing(false)
    }
  }, [crop, image, baseSeqRef, noticeBad])

  /** 「取消」= **什么都没发生**（spec §3.1）：框、角度、工具一起收掉。 */
  const cancelCrop = () => { setCrop(null); setTool(null) }

  /**
   * 「完成」——**这个工具的全部意义**：本地裁一张新的底图，给「当前这一版」
   * **记一笔账**。不花钱、不占额度、**不动参数**（spec §3.1：调好的滑块原样跟着走）。
   *
   * ★★ 2026-10-08（调色区账本，用户定死的关系）：裁剪是**调色区里的操作**，
   *   只改「当前这一版」—— 不推新快照（转盘不加格）、不切未来（后面几版原样
   *   留着）、不挪光标、不碰对话。它的"账"是这一版自己的账本：`pushEdit` 把
   *   "裁之前"压进 `past`（spec §5.2），退这一刀走调色屏左下角那组箭头
   *   （`undoEdit`，接线在 Task 4）。
   */
  const commitCrop = useCallback(async () => {
    if (!crop || !image) return
    // ★ 终审 I1：这一刀是冲着**哪一版底图**去的。`await cropToBitmap` 那几百毫秒里
    //   生成完全可能落地（推 `baseSeqRef`、换底图、推一步）—— 不认这一版的话，
    //   这一刀会记到**已经不在屏上的那一版**上，`setImage` 再把它从画面上盖掉：
    //   钱花了、东西没了、一句错都不报。
    //   和 `useGeneration` 那道 `seqAtStart` 闸门同一族，方向相反：那边守
    //   "结果回来时画面换了"，这边守"裁到一半画面换了"。
    //   ⚠️ 连点两下「完成」也被它挡住：第二下进函数时读到的还是第一次推之前的
    //   序号，它回来时一样对不上 —— 不用另写一个"正在裁"的 ref。
    //   「两个记号必须在 `await` 之前当场读」那条长注释搬进了
    //   `app/baseEdit.ts` 的 `beginBaseEdit` —— 裁剪 / 点修共用那一份。
    const gate = beginBaseEdit(baseSeqRef, cursorIdRef)
    let flattened: ImageBitmap | null = null
    try {
      // 裁剪会改画布尺寸 / 坐标系；文字层先在原图坐标里合并，再一起裁。
      // 这样字不会在裁剪后跑到别的位置；要改字可以撤销这一刀。
      flattened = await editLayersToBitmap(image.bitmap, layers)
      const bitmap = await cropToBitmap(flattened, crop.spec, crop.turns)
      // ★ 回来先对**两样**：底图版本 + 站的位置（`cursorIdRef` 是 10-08 加的
      //   那一半）—— 对不上就说明这段等待里画面变了（生成落地 / 切走 / 换了张
      //   照片 / 人跳了版本）。这一刀要么是从一张**已经不在屏上的**底图上裁出来
      //   的，要么会被记到**别人那一版**上（光标指着 A、画面却是 B 裁出来的
      //   样子），写进去都是静默事故。
      if (!discardStaleBaseEdit(baseSeqRef, cursorIdRef, gate, bitmap, {
        log: '裁剪回来时底图/位置已经变了（多半是生成落地或人跳了版本），这一刀不写进去',
        notice: '裁的时候画面已经变了 —— 这一刀没算数。要的话，再裁一次。',
      }, noticeBad)) {
        applyBaseEdit({
          at: gate.at, bitmap, history, setHistory, setImage,
          baseSeqRef, editSeqRef, markDirty, flushEdit, clearTransient,
          ...(layers.length ? { layers: [], setLayers } : {}),
        }, '这一刀')
      }
      // ★★ 2026-10-08（用户定死的关系）：「裁剪」是**调色区里的操作** —— 它的"账"
      //   是**当前这一版自己的账本**（`past` / `future`；调色屏左下角那组箭头
      //   翻的就是它），**不是对话区的一条记录、也不再是转盘上的一格**。
      //   用户原话：「而不是调色区调整一份我对话区记录一份，那用户调整细节
      //   点多了不得几十个回溯点」——细调多了的话，对话区会堆出几十条操作记录。
      //   原来这里落过一句「裁好了。」、也在转盘上加过一格，都撤了。
      // ⚠️ 成功和**作废**都收现场（原来那两处各写了一遍 `setCrop(null); setTool(null)`）；
      //    「裁不动」那条（下面 catch）**不收** —— 用户还要再试一次。
      setCrop(null)
      setTool(null)
    } catch (e) {
      console.error(e)
      // 裁不动时**说清楚**，别让屏幕上什么都没有：多半是这张图太大，这个浏览器
      // 开不出够大的画布（`cropToBitmap` 那两条失败路径）。
      noticeBad('这张照片没裁成。再试一次；还不行就换一张小一点的。')
    } finally {
      if (flattened && flattened !== image.bitmap) flattened.close()
    }
    // ⚠️ `history` 在依赖里：`applyBaseEdit` 里那句"那一版还在不在"的检查读的
    //   就是它（读到的才写进依赖）。`clearTransient` 是 `useCallback([])` 的
    //   稳定身份 —— 照"读到的就写进依赖"一起列上。
    //   （`setImage` / 那几个 ref / `markDirty` / `setTool` 都是**身份稳定**的
    //   家伙什，照原样不列 —— ★ 2026-10-08 搬进 hook 时**一字未改**。）
  }, [crop, image, layers, setLayers, history, noticeBad, flushEdit, clearTransient])

  /**
   * 交给 `Canvas` 的裁剪现场 —— 每次渲染现算。
   * ⚠️ 换算只有这一处：**归一化比 = 像素比 × 外框高 / 外框宽**
   *   （框是相对外框归一化的，而比例档说的是像素；外框宽高不等时两者不同）。
   */
  const cropScene: CropScene | null = (() => {
    // `tool === 'crop'` 那半是保险：现场和工具是同一个动作里一起设的，
    // 谁也不该单独留在屏上。
    if (!image || !crop || tool !== 'crop') return null
    const angle = effectiveAngle(crop.spec, crop.turns)
    const bounds = rotatedBounds(image.width, image.height, angle)
    return {
      rect: crop.spec.rect,
      onRect: setCropRect,
      aspect: crop.aspect === null ? null : crop.aspect * bounds.h / bounds.w,
      inner: rectFromSize(inscribedRect(image.width, image.height, angle), bounds),
      angle,
      flipH: !!crop.spec.flipH,
      flipV: !!crop.spec.flipV,
      grid: crop.guide !== 'off',
      guide: crop.guide,
    }
  })()

  return {
    crop, openCrop, closeCrop, setCropRect, setCropAngle, pickCropAspect,
    toggleCropFlip, toggleCropGrid, autoStraighten, smartCompose, smartComposing,
    cancelCrop, commitCrop, cropScene,
  }
}
