import { useCallback, useEffect, useRef, useState } from 'react'
import type { DecodedImage } from '../image/decode'
import type { FaceBox } from '../core/faceDetect'
import { detectFaceInBitmap, detectFacesInBitmap } from '../image/faceDetect'
import { faceShapeToBitmap } from '../image/faceShape'
import { faceLightToBitmap } from '../image/faceLight'
import { skinToneToBitmap } from '../image/skinTone'
import { makeupToBitmap, type LipShadeId } from '../image/makeup'
import { faceMask } from '../image/faceMask'
import { DEFAULT_SMOOTH_TEXTURE, smoothToBitmap } from '../image/smooth'
import { blemishToBitmap } from '../image/blemish'
import { resizeBitmap } from '../image/resize'
import { applyBaseEdit, beginBaseEdit, discardStaleBaseEdit, type BaseEditToolDeps } from './baseEdit'

/**
 * 「人像」工具：本地肤色估计出正脸框，再用滑杆做瘦脸 / 大眼 / 瘦鼻 / 下巴 / 瘦身，
 * 以及面部补光 / 口红 / 腮红。
 *
 * 滑杆先在一张长边 ≤1400 的预览图上出效果（120ms 防抖），点「应用人像」
 * 才按原尺寸重算并写进当前这一版底图。和裁剪 / 液化同一条账本关系：
 * 只改当前版本、可撤销、不推转盘格、不写对话、不花模型额度。
 */
export type PortraitDeps = BaseEditToolDeps

export type PortraitState = {
  face: FaceBox | null
  faces: FaceBox[]
  faceIndex: number
  detecting: boolean
  manualPicking: boolean
  slim: number
  head: number
  crown: number
  eyes: number
  nose: number
  chin: number
  smile: number
  body: number
  legs: number
  neck: number
  doubleChin: number
  shoulder: number
  blemish: boolean
  /** 已检测过、但这张脸没有可修的小暗点；用于给用户一个明确的空结果。 */
  blemishEmpty: boolean
  smooth: number
  light: number
  whiten: number
  rosy: number
  lip: number
  blush: number
  lipShade: LipShadeId
  dirty: boolean
}

const PREVIEW_SIDE = 1400
const PREVIEW_DEBOUNCE_MS = 120

function portraitSeed(manualPicking = false): PortraitState {
  return {
    face: null, faces: [], faceIndex: 0,
    detecting: !manualPicking, manualPicking,
    slim: 0, head: 0, crown: 0, eyes: 0, nose: 0, chin: 0,
    smile: 0, body: 0, legs: 0, neck: 0, doubleChin: 0, shoulder: 0,
    blemish: false, blemishEmpty: false, smooth: 0, light: 0,
    whiten: 0, rosy: 0,
    lip: 0, blush: 0, lipShade: 'rose', dirty: false,
  }
}

class PortraitCancelled extends Error {}

type PortraitRun = {
  bitmap: ImageBitmap
  faces: FaceBox[]
  changed: number
  blemishEmpty: boolean
  ownsBitmap: boolean
}

function scaledFace(face: FaceBox, scale: number): FaceBox {
  return {
    x: face.x * scale,
    y: face.y * scale,
    w: face.w * scale,
    h: face.h * scale,
    confidence: face.confidence,
  }
}

/**
 * 「全部脸」的像素流水线。
 *
 * 全身关系（瘦颈 / 双下巴 / 直角肩 / 瘦身 / 长腿）只在主脸执行一次；
 * 其余脸只做脸局部塑形，避免同一具身体被重复拉伸。磨皮先把所有脸框合成
 * 一张并集蒙版再一次磨，肤色 / 补光 / 妆容则逐脸执行。
 */
async function applyPortraitFaces(
  source: ImageBitmap,
  sourceFaces: FaceBox[],
  p: PortraitState,
  maxSide: number,
  stillCurrent: () => boolean,
): Promise<PortraitRun> {
  const ensure = () => {
    if (!stillCurrent()) throw new PortraitCancelled('portrait preview superseded')
  }
  const ensureResult = async <T extends { bitmap: ImageBitmap }>(made: T): Promise<T> => {
    try {
      ensure()
    } catch (e) {
      made.bitmap.close()
      throw e
    }
    return made
  }

  let current = source
  let ownsBitmap = false
  let faces = sourceFaces
  const scale = Math.min(1, maxSide / Math.max(1, Math.max(source.width, source.height)))
  if (scale < 1) {
    current = await resizeBitmap(
      source,
      Math.max(1, Math.round(source.width * scale)),
      Math.max(1, Math.round(source.height * scale)),
    )
    ownsBitmap = true
    faces = sourceFaces.map(face => scaledFace(face, scale))
    try {
      ensure()
    } catch (e) {
      current.close()
      throw e
    }
  }

  const replace = (next: ImageBitmap) => {
    if (ownsBitmap) current.close()
    current = next
    ownsBitmap = true
  }
  const hasFullShape = p.slim > 0 || p.head > 0 || p.crown > 0 || p.eyes > 0
    || p.nose > 0 || p.chin > 0 || p.smile > 0 || p.body > 0 || p.legs > 0
    || p.neck > 0 || p.doubleChin > 0 || p.shoulder > 0
  const hasLocalShape = p.slim > 0 || p.head > 0 || p.crown > 0 || p.eyes > 0
    || p.nose > 0 || p.chin > 0 || p.smile > 0
  let changed = 0
  let blemishEmpty = p.blemish

  try {
    if (hasFullShape) {
      const first = await ensureResult(await faceShapeToBitmap(current, faces[0]!, {
        slim: p.slim, head: p.head, crown: p.crown, eyes: p.eyes, nose: p.nose,
        chin: p.chin, smile: p.smile, body: p.body, legs: p.legs, neck: p.neck,
        doubleChin: p.doubleChin, shoulder: p.shoulder,
      }))
      if (first.changed > 0) {
        replace(first.bitmap)
        faces[0] = first.face
        changed += first.changed
      } else {
        first.bitmap.close()
      }
      if (hasLocalShape) {
        for (let i = 1; i < faces.length; i++) {
          const made = await ensureResult(await faceShapeToBitmap(current, faces[i]!, {
            slim: p.slim, head: p.head, crown: p.crown, eyes: p.eyes, nose: p.nose,
            chin: p.chin, smile: p.smile,
          }))
          if (made.changed > 0) {
            replace(made.bitmap)
            faces[i] = made.face
            changed += made.changed
          } else {
            made.bitmap.close()
          }
        }
      }
    }
    if (p.smooth > 0) {
      const mask = new Uint8Array(current.width * current.height)
      for (const face of faces) {
        const one = faceMask(current.width, current.height, face)
        for (let i = 0; i < mask.length; i++) {
          if (one[i]! > mask[i]!) mask[i] = one[i]!
        }
      }
      const made = await ensureResult(await smoothToBitmap(current, mask, {
        strength: p.smooth,
        texture: DEFAULT_SMOOTH_TEXTURE,
      }))
      if (made.covered > 0) {
        replace(made.bitmap)
        changed += made.covered
      } else {
        made.bitmap.close()
      }
    }
    if (p.blemish) {
      let found = false
      for (const face of faces) {
        const made = await ensureResult(await blemishToBitmap(current, face, { strength: 70 }))
        if (made.spots > 0) {
          found = true
          replace(made.bitmap)
          changed += made.healed
        } else {
          made.bitmap.close()
        }
      }
      blemishEmpty = !found
    }
    if (p.light > 0) {
      for (let i = 0; i < faces.length; i++) {
        const made = await ensureResult(await faceLightToBitmap(current, faces[i]!, {
          strength: p.light,
        }))
        if (made.changed > 0) {
          replace(made.bitmap)
          faces[i] = made.face
          changed += made.changed
        } else {
          made.bitmap.close()
        }
      }
    }
    if (p.whiten > 0 || p.rosy > 0) {
      for (let i = 0; i < faces.length; i++) {
        const made = await ensureResult(await skinToneToBitmap(current, faces[i]!, {
          whiten: p.whiten, rosy: p.rosy,
        }))
        if (made.changed > 0) {
          replace(made.bitmap)
          faces[i] = made.face
          changed += made.changed
        } else {
          made.bitmap.close()
        }
      }
    }
    if (p.lip > 0 || p.blush > 0) {
      for (let i = 0; i < faces.length; i++) {
        const made = await ensureResult(await makeupToBitmap(current, faces[i]!, {
          lip: p.lip, blush: p.blush, lipShade: p.lipShade,
        }))
        if (made.changed > 0) {
          replace(made.bitmap)
          faces[i] = made.face
          changed += made.changed
        } else {
          made.bitmap.close()
        }
      }
    }
    return { bitmap: current, faces, changed, blemishEmpty, ownsBitmap }
  } catch (e) {
    if (ownsBitmap) current.close()
    throw e
  }
}

export function usePortrait(deps: PortraitDeps) {
  const {
    tool, image, setImage, history, setHistory, noticeBad,
    flushEdit, clearTransient, baseSeqRef, cursorIdRef, editSeqRef, markDirty, setTool,
  } = deps

  const [portrait, setPortrait] = useState<PortraitState | null>(null)
  const [preview, setPreview] = useState<DecodedImage | null>(null)
  const [previewFaces, setPreviewFaces] = useState<FaceBox[]>([])
  const [applying, setApplying] = useState(false)
  const previewRef = useRef<DecodedImage | null>(null)
  const openSeqRef = useRef(0)
  const previewSeqRef = useRef(0)

  const disposePreview = useCallback(() => {
    const old = previewRef.current
    previewRef.current = null
    setPreview(null)
    setPreviewFaces([])
    if (old) old.bitmap.close()
  }, [])

  const putPreview = useCallback((next: DecodedImage, faces: FaceBox[]) => {
    const old = previewRef.current
    previewRef.current = next
    setPreview(next)
    setPreviewFaces(faces)
    if (old) setTimeout(() => old.bitmap.close(), 50)
  }, [])

  const openPortrait = useCallback(async () => {
    if (!image) return
    const seq = ++openSeqRef.current
    setPortrait(portraitSeed())
    try {
      // 先找一组合影候选；旧单脸检测仍作兜底，避免多脸筛选口径误伤
      // 只有一张、但占比特殊的正脸。
      let faces = await detectFacesInBitmap(image.bitmap, 6)
      if (faces.length === 0) {
        const face = await detectFaceInBitmap(image.bitmap)
        if (face) faces = [face]
      }
      if (seq !== openSeqRef.current) return
      if (faces.length === 0) {
        setPortrait(portraitSeed(true))
        return
      }
      setPortrait({
        ...portraitSeed(),
        face: faces[0]!, faces, faceIndex: 0, detecting: false,
      })
    } catch (e) {
      console.error(e)
      if (seq !== openSeqRef.current) return
      setPortrait(portraitSeed(true))
      noticeBad('自动找脸没成功。可以在照片上手动拖一个脸框。')
    }
  }, [image, noticeBad, setTool])

  const closePortrait = useCallback(() => {
    openSeqRef.current++
    previewSeqRef.current++
    disposePreview()
    setPortrait(null)
  }, [disposePreview])

  const cancelPortrait = () => { closePortrait(); setTool(null) }

  const resetPortrait = useCallback(() => {
    previewSeqRef.current++
    disposePreview()
    setPortrait(p => (p ? {
      ...p, slim: 0, head: 0, crown: 0, eyes: 0, nose: 0, chin: 0,
      smile: 0, body: 0, legs: 0, neck: 0, doubleChin: 0, shoulder: 0,
      blemish: false, blemishEmpty: false, smooth: 0, light: 0,
      whiten: 0, rosy: 0,
      lip: 0, blush: 0, dirty: false,
    } : p))
  }, [disposePreview])

  /**
   * 合影里换一张脸。滑杆值保留，切过去后按新脸框重新预览；旧预览先作废，
   * 避免一张慢图回来后贴到另一张脸上。提交仍然只改当前选中的这张脸。
   */
  const selectPortraitFace = useCallback((index: number) => {
    previewSeqRef.current++
    disposePreview()
    setPortrait(p => {
      if (!p || index === p.faceIndex) return p
      if (index !== -1 && (index < 0 || index >= p.faces.length)) return p
      return {
        ...p,
        face: p.faces[index === -1 ? 0 : index]!,
        faceIndex: index,
        manualPicking: false,
        dirty: false,
        blemishEmpty: false,
      }
    })
  }, [disposePreview])

  const startManualFace = useCallback(() => {
    previewSeqRef.current++
    disposePreview()
    setPortrait(p => (p ? {
      ...p,
      face: null, faces: [], faceIndex: 0,
      detecting: false, manualPicking: true,
      dirty: false, blemishEmpty: false,
    } : p))
  }, [disposePreview])

  const pickManualFace = useCallback((face: FaceBox) => {
    previewSeqRef.current++
    disposePreview()
    setPortrait(p => (p ? {
      ...p,
      face, faces: [face], faceIndex: 0,
      detecting: false, manualPicking: false,
      dirty: false, blemishEmpty: false,
    } : p))
  }, [disposePreview])

  const slim = portrait?.slim ?? 0
  const head = portrait?.head ?? 0
  const crown = portrait?.crown ?? 0
  const eyes = portrait?.eyes ?? 0
  const nose = portrait?.nose ?? 0
  const chin = portrait?.chin ?? 0
  const smile = portrait?.smile ?? 0
  const body = portrait?.body ?? 0
  const legs = portrait?.legs ?? 0
  const neck = portrait?.neck ?? 0
  const doubleChin = portrait?.doubleChin ?? 0
  const shoulder = portrait?.shoulder ?? 0
  const blemish = portrait?.blemish ?? false
  const smooth = portrait?.smooth ?? 0
  const light = portrait?.light ?? 0
  const whiten = portrait?.whiten ?? 0
  const rosy = portrait?.rosy ?? 0
  const lip = portrait?.lip ?? 0
  const blush = portrait?.blush ?? 0
  const lipShade = portrait?.lipShade ?? 'rose'
  const face = portrait?.face ?? null
  const detectedFaces = portrait?.faces
  const faceIndex = portrait?.faceIndex ?? 0
  const detecting = portrait?.detecting ?? false

  // 滑杆防抖预览。每次变化都换一个序号，晚回来的旧结果直接丢掉。
  // ⚠️ 依赖只列数值和脸框：把整个 `portrait` 放进来，下面置 dirty 会触发
  //    自己再跑一遍，形成无限预览循环。
  useEffect(() => {
    if (!portrait || detecting || !face || !image || tool !== 'portrait') return
    if (portrait.faceIndex < 0) return
    if (!blemish && slim <= 0 && head <= 0 && crown <= 0 && eyes <= 0 && nose <= 0
      && chin <= 0 && smile <= 0 && body <= 0 && legs <= 0 && neck <= 0 && doubleChin <= 0
      && shoulder <= 0
      && smooth <= 0 && light <= 0
      && whiten <= 0 && rosy <= 0
      && lip <= 0 && blush <= 0) {
      previewSeqRef.current++
      disposePreview()
      setPortrait(p => (p && (p.dirty || p.blemishEmpty)
        ? { ...p, dirty: false, blemishEmpty: false }
        : p))
      return
    }
    const seq = ++previewSeqRef.current
    const timer = setTimeout(() => {
      void (async () => {
        try {
          const shape = await faceShapeToBitmap(
            image.bitmap, face, {
              slim, head, crown, eyes, nose, chin, smile, body, legs, neck, doubleChin, shoulder,
            }, PREVIEW_SIDE,
          )
          if (seq !== previewSeqRef.current) { shape.bitmap.close(); return }
          let bitmap = shape.bitmap
          let outFace = shape.face
          let changed = shape.changed
          if (smooth > 0) {
            const mask = faceMask(bitmap.width, bitmap.height, outFace)
            let smoothed: Awaited<ReturnType<typeof smoothToBitmap>>
            try {
              smoothed = await smoothToBitmap(bitmap, mask, {
                strength: smooth,
                texture: DEFAULT_SMOOTH_TEXTURE,
              })
            } catch (e) {
              bitmap.close()
              throw e
            }
            if (seq !== previewSeqRef.current) {
              smoothed.bitmap.close()
              bitmap.close()
              return
            }
            bitmap.close()
            bitmap = smoothed.bitmap
            changed += smoothed.covered
          }
          if (blemish) {
            let made: Awaited<ReturnType<typeof blemishToBitmap>>
            try {
              made = await blemishToBitmap(bitmap, outFace, { strength: 70 })
            } catch (e) {
              bitmap.close()
              throw e
            }
            if (seq !== previewSeqRef.current) {
              made.bitmap.close()
              bitmap.close()
              return
            }
            setPortrait(p => (p ? { ...p, blemishEmpty: made.spots === 0 } : p))
            if (made.spots > 0) {
              bitmap.close()
              bitmap = made.bitmap
              changed += made.healed
            } else {
              made.bitmap.close()
            }
          }
          if (light > 0) {
            let lit: Awaited<ReturnType<typeof faceLightToBitmap>>
            try {
              lit = await faceLightToBitmap(bitmap, outFace, { strength: light }, PREVIEW_SIDE)
            } catch (e) {
              bitmap.close()
              throw e
            }
            if (seq !== previewSeqRef.current) {
              lit.bitmap.close()
              bitmap.close()
              return
            }
            bitmap.close()
            bitmap = lit.bitmap
            outFace = lit.face
            changed += lit.changed
          }
          if (whiten > 0 || rosy > 0) {
            let toned: Awaited<ReturnType<typeof skinToneToBitmap>>
            try {
              toned = await skinToneToBitmap(
                bitmap, outFace, { whiten, rosy }, PREVIEW_SIDE,
              )
            } catch (e) {
              bitmap.close()
              throw e
            }
            if (seq !== previewSeqRef.current) {
              toned.bitmap.close()
              bitmap.close()
              return
            }
            if (toned.changed > 0) {
              bitmap.close()
              bitmap = toned.bitmap
              outFace = toned.face
              changed += toned.changed
            } else {
              toned.bitmap.close()
            }
          }
          if (lip > 0 || blush > 0) {
            let made: Awaited<ReturnType<typeof makeupToBitmap>>
            try {
              made = await makeupToBitmap(
                bitmap, outFace, { lip, blush, lipShade }, PREVIEW_SIDE,
              )
            } catch (e) {
              bitmap.close()
              throw e
            }
            if (seq !== previewSeqRef.current) {
              made.bitmap.close()
              bitmap.close()
              return
            }
            if (made.changed > 0) {
              bitmap.close()
              bitmap = made.bitmap
              outFace = made.face
              changed += made.changed
            } else {
              made.bitmap.close()
            }
          }
          if (changed <= 0) { bitmap.close(); return }
          putPreview({ bitmap, width: bitmap.width, height: bitmap.height }, [outFace])
          setPortrait(p => (p ? { ...p, dirty: true } : p))
        } catch (e) {
          if (seq !== previewSeqRef.current) return
          console.error(e)
          noticeBad('人像预览没算出来。再拖一次；还不行就先取消。')
        }
      })()
    }, PREVIEW_DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [slim, head, crown, eyes, nose, chin, smile, body, legs, neck, doubleChin, shoulder, blemish, smooth, light, whiten, rosy, lip, blush, lipShade, face, detecting, image, tool,
    disposePreview, putPreview, noticeBad])

  // 「全部脸」预览：同一组滑杆只在主脸做一次全身关系，其余脸只做脸局部。
  useEffect(() => {
    if (!portrait || detecting || !image || tool !== 'portrait') return
    if (portrait.faceIndex !== -1 || !detectedFaces?.length) return
    if (!blemish && slim <= 0 && head <= 0 && crown <= 0 && eyes <= 0 && nose <= 0
      && chin <= 0 && smile <= 0 && body <= 0 && legs <= 0 && neck <= 0 && doubleChin <= 0
      && shoulder <= 0
      && smooth <= 0 && light <= 0
      && whiten <= 0 && rosy <= 0
      && lip <= 0 && blush <= 0) {
      previewSeqRef.current++
      disposePreview()
      setPortrait(p => (p && (p.dirty || p.blemishEmpty)
        ? { ...p, dirty: false, blemishEmpty: false }
        : p))
      return
    }
    const seq = ++previewSeqRef.current
    const timer = setTimeout(() => {
      void (async () => {
        try {
          const made = await applyPortraitFaces(
            image.bitmap, detectedFaces, portrait, PREVIEW_SIDE,
            () => seq === previewSeqRef.current,
          )
          if (seq !== previewSeqRef.current) {
            if (made.ownsBitmap) made.bitmap.close()
            return
          }
          if (made.changed <= 0) {
            if (made.ownsBitmap) made.bitmap.close()
            setPortrait(p => (p ? { ...p, blemishEmpty: made.blemishEmpty } : p))
            return
          }
          putPreview(
            { bitmap: made.bitmap, width: made.bitmap.width, height: made.bitmap.height },
            made.faces,
          )
          setPortrait(p => (p ? {
            ...p, dirty: true, blemishEmpty: made.blemishEmpty,
          } : p))
        } catch (e) {
          if (e instanceof PortraitCancelled || seq !== previewSeqRef.current) return
          console.error(e)
          noticeBad('合影人像预览没算出来。再拖一次；还不行就先取消。')
        }
      })()
    }, PREVIEW_DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [slim, head, crown, eyes, nose, chin, smile, body, legs, neck, doubleChin,
    shoulder, blemish, smooth, light, whiten, rosy, lip, blush, lipShade,
    detectedFaces, faceIndex, detecting, image, tool,
    disposePreview, putPreview, noticeBad])

  const commitPortrait = useCallback(async () => {
    const scene = portrait
    if (!scene || !scene.face || !image || scene.detecting) return
    if (!scene.blemish && scene.slim <= 0 && scene.head <= 0 && scene.crown <= 0
      && scene.eyes <= 0 && scene.nose <= 0
      && scene.chin <= 0 && scene.smile <= 0 && scene.body <= 0 && scene.legs <= 0
      && scene.neck <= 0 && scene.doubleChin <= 0 && scene.shoulder <= 0
      && scene.smooth <= 0 && scene.light <= 0
      && scene.whiten <= 0 && scene.rosy <= 0
      && scene.lip <= 0 && scene.blush <= 0) return
    const gate = beginBaseEdit(baseSeqRef, cursorIdRef)
    setApplying(true)
    try {
      if (scene.faceIndex === -1) {
        const made = await applyPortraitFaces(
          image.bitmap, scene.faces, scene, Number.POSITIVE_INFINITY, () => true,
        )
        if (made.changed <= 0) {
          if (made.ownsBitmap) made.bitmap.close()
          noticeBad(scene.blemish && made.blemishEmpty
            ? '没找到明显的小斑点；可以用点修手动擦。'
            : '这一组强度太轻，画面没变。往右再拉一点试试。')
          return
        }
        if (!discardStaleBaseEdit(baseSeqRef, cursorIdRef, gate, made.bitmap, {
          log: '合影人像回来时底图/位置已经变了，这一下不写进去',
          notice: '塑形的时候画面已经变了 —— 这一下没算数。要的话，再塑一次。',
        }, noticeBad)) {
          applyBaseEdit({
            at: gate.at, bitmap: made.bitmap, history, setHistory, setImage,
            baseSeqRef, editSeqRef, markDirty, flushEdit, clearTransient,
          }, scene.faces.length > 1 ? `这一塑（${scene.faces.length} 张脸）` : '这一塑')
        }
        closePortrait()
        setTool(null)
        return
      }
      const hasShape = scene.slim > 0 || scene.head > 0 || scene.crown > 0
        || scene.eyes > 0 || scene.nose > 0
        || scene.chin > 0 || scene.smile > 0 || scene.body > 0 || scene.legs > 0
        || scene.neck > 0 || scene.doubleChin > 0 || scene.shoulder > 0
      const hasBlemish = scene.blemish
      const hasSmooth = scene.smooth > 0
      const hasLight = scene.light > 0
      const hasTone = scene.whiten > 0 || scene.rosy > 0
      const hasMakeup = scene.lip > 0 || scene.blush > 0
      let bitmap: ImageBitmap | null = null
      let outFace = scene.face
      let changed = 0
      let blemishFound = false
      if (hasShape) {
        const shape = await faceShapeToBitmap(image.bitmap, scene.face, {
          slim: scene.slim, head: scene.head, crown: scene.crown, eyes: scene.eyes, nose: scene.nose,
          chin: scene.chin, smile: scene.smile, body: scene.body, legs: scene.legs,
          neck: scene.neck, doubleChin: scene.doubleChin, shoulder: scene.shoulder,
        })
        bitmap = shape.bitmap
        outFace = shape.face
        changed = shape.changed
      }
      if (hasSmooth) {
        const base = bitmap ?? image.bitmap
        const mask = faceMask(base.width, base.height, outFace)
        let smoothed: Awaited<ReturnType<typeof smoothToBitmap>>
        try {
          smoothed = await smoothToBitmap(base, mask, {
            strength: scene.smooth,
            texture: DEFAULT_SMOOTH_TEXTURE,
          })
        } catch (e) {
          bitmap?.close()
          throw e
        }
        if (bitmap) bitmap.close()
        bitmap = smoothed.bitmap
        changed += smoothed.covered
      }
      if (hasBlemish) {
        let made: Awaited<ReturnType<typeof blemishToBitmap>>
        try {
          made = await blemishToBitmap(bitmap ?? image.bitmap, outFace, { strength: 70 })
        } catch (e) {
          bitmap?.close()
          throw e
        }
        if (made.spots > 0) {
          if (bitmap) bitmap.close()
          bitmap = made.bitmap
          blemishFound = true
          changed += made.healed
        } else {
          made.bitmap.close()
        }
      }
      if (hasLight) {
        let lit: Awaited<ReturnType<typeof faceLightToBitmap>>
        try {
          lit = await faceLightToBitmap(bitmap ?? image.bitmap, outFace, {
            strength: scene.light,
          })
        } catch (e) {
          bitmap?.close()
          throw e
        }
        if (bitmap) bitmap.close()
        bitmap = lit.bitmap
        outFace = lit.face
        changed += lit.changed
      }
      if (hasTone) {
        let toned: Awaited<ReturnType<typeof skinToneToBitmap>>
        try {
          toned = await skinToneToBitmap(bitmap ?? image.bitmap, outFace, {
            whiten: scene.whiten, rosy: scene.rosy,
          })
        } catch (e) {
          bitmap?.close()
          throw e
        }
        if (toned.changed > 0) {
          if (bitmap) bitmap.close()
          bitmap = toned.bitmap
          outFace = toned.face
          changed += toned.changed
        } else {
          toned.bitmap.close()
        }
      }
      if (hasMakeup) {
        let made: Awaited<ReturnType<typeof makeupToBitmap>>
        try {
          made = await makeupToBitmap(bitmap ?? image.bitmap, outFace, {
            lip: scene.lip, blush: scene.blush, lipShade: scene.lipShade,
          })
        } catch (e) {
          bitmap?.close()
          throw e
        }
        if (bitmap) bitmap.close()
        bitmap = made.bitmap
        outFace = made.face
        changed += made.changed
      }
      if (!bitmap || changed <= 0) {
        bitmap?.close()
        noticeBad(hasBlemish && !blemishFound
          ? '没找到明显的小斑点；可以用点修手动擦。'
          : '这一组强度太轻，画面没变。往右再拉一点试试。')
        return
      }
      if (!discardStaleBaseEdit(baseSeqRef, cursorIdRef, gate, bitmap, {
        log: '人像塑形回来时底图/位置已经变了（多半是生成落地或人跳了版本），这一下不写进去',
        notice: '塑形的时候画面已经变了 —— 这一下没算数。要的话，再塑一次。',
      }, noticeBad)) {
        applyBaseEdit({
          at: gate.at, bitmap, history, setHistory, setImage,
          baseSeqRef, editSeqRef, markDirty, flushEdit, clearTransient,
        }, '这一塑')
      }
      closePortrait()
      setTool(null)
    } catch (e) {
      console.error(e)
      noticeBad('这张照片的人像塑形没算完。再试一次；还不行就先取消。')
    } finally {
      setApplying(false)
    }
  }, [portrait, image, history, noticeBad, closePortrait, flushEdit, clearTransient])

  const faceScene = (() => {
    if (tool !== 'portrait' || !portrait?.face || portrait.manualPicking) return null
    const shown = preview
      ? (previewFaces.length ? previewFaces : [portrait.face])
      : portrait.faceIndex === -1
        ? portrait.faces
        : [portrait.face]
    return {
      face: shown[0] ?? portrait.face,
      faces: shown,
      all: portrait.faceIndex === -1,
      selected: portrait.faceIndex,
      onPickFace: portrait.faceIndex === -1 || portrait.faces.length > 1
        ? selectPortraitFace
        : undefined,
    }
  })()
  const facePickScene = portrait?.manualPicking ? { onPick: pickManualFace } : null

  return {
    portrait, setPortrait, preview, applying,
    openPortrait, closePortrait, cancelPortrait, resetPortrait,
    selectPortraitFace, startManualFace, pickManualFace, facePickScene,
    retryAutoFace: openPortrait, commitPortrait, faceScene,
  }
}
