import { useCallback, useEffect, useRef, useState } from 'react'
import { listLuts, lutFileText } from '../api/luts.ts'
import { parseCube, type Cube, type LutMeta, type LutRef } from '../../shared/lut.ts'
import { createLutPreview, type LutPreview } from '../render/lutPreview.ts'
import type { DecodedImage } from '../image/decode'
import type { Adjustments } from '../../shared/adjustments.ts'

/**
 * 滤镜的客户端状态：**清单、当前那个的 cube、缩略图**。
 *
 * 三件事住在一起的理由：它们都挂在"清单 + 当前选中的 id"上，分开写就会出现
 * "清单刷新了、cube 还是旧的"这种半新半旧的状态。
 *
 * ⚠️ `params` 收下、这一版却**一个字都没用**（所以名字带下划线 —— `noUnusedParameters`
 *    要求的，同 `render/lutPreview.ts` 的 `_dstW/_dstH`）：缩略图要的那一份是
 *    `ensureThumbs(image, params)` **现传**的（打开格子那一刻的参数），走函数参数
 *    而不是这个入口。留着它是接口那一半（"这个 hook 知道当事人手上是什么参数"），
 *    别当成笔误删掉。
 */
export function useLuts({ lut, image, params: _params }: {
  lut: LutRef | null
  image: DecodedImage | null
  params: Adjustments
}) {
  const [luts, setLuts] = useState<LutMeta[]>([])
  const [cube, setCube] = useState<Cube | null>(null)
  const [thumbs, setThumbs] = useState<{ none: string | null; byId: Record<number, string> }>(
    { none: null, byId: {} })

  /** id → 解析好的 cube。取过一次就不再取（清单小、每个几十 KB~几 MB，够放） */
  const cubes = useRef(new Map<number, Cube>())
  const preview = useRef<LutPreview | null>(null)
  const lutId = lut?.lutId ?? null
  // 两条"这一趟还算不算数"的序号：切滤镜 / 换照片时各自作废前面的异步
  const cubeSeq = useRef(0)
  const thumbSeq = useRef(0)

  // ⚠️ 懒建 + 卸载时 dispose：**StrictMode 会把挂载重放一遍**，在 effect 里
  //    建、在 cleanup 里 dispose 的话，第二次挂载拿到的是一个已经 dispose 的实例。
  const ensurePreview = (): LutPreview => {
    if (!preview.current) preview.current = createLutPreview()
    return preview.current
  }
  useEffect(() => () => { preview.current?.dispose(); preview.current = null }, [])

  const loadCube = useCallback(async (id: number): Promise<Cube | null> => {
    const hit = cubes.current.get(id)
    if (hit) return hit
    try {
      const c = parseCube(await lutFileText(id))
      cubes.current.set(id, c)
      return c
    } catch (e) {
      console.error('滤镜取不回来或者读不出来：', e)
      return null
    }
  }, [])

  const reload = useCallback(async (): Promise<LutMeta[]> => {
    try {
      const { luts: list } = await listLuts()
      setLuts(list)
      return list
    } catch (e) {
      console.error('滤镜清单没取回来：', e)
      return []
    }
  }, [])

  // 登录后拉一次清单（App 挂载时）
  useEffect(() => { void reload() }, [reload])

  // 当前滤镜换了 → 取它的 cube（认不出来的当"没有"）
  useEffect(() => {
    const seq = ++cubeSeq.current
    if (lutId === null) { setCube(null); return }
    void loadCube(lutId).then((c) => { if (seq === cubeSeq.current) setCube(c) })
  }, [lutId, loadCube])

  // 换照片 → 缩略图作废（下次打开格子重画；这里的 `image` 刻意进依赖）
  useEffect(() => {
    thumbSeq.current++
    setThumbs({ none: null, byId: {} })
  }, [image])

  /**
   * 打开格子时叫一次：把还没有的缩略图补齐。
   * ⚠️ 每个滤镜**先把 cube 取到手**再画 —— 没取到就不画那一格（格子会显示占位）。
   */
  const ensureThumbs = useCallback((imageNow: DecodedImage | null, paramsNow: Adjustments) => {
    if (!imageNow) return
    const seq = ++thumbSeq.current
    const p = ensurePreview()
    void (async () => {
      await p.setImage(imageNow)
      if (seq !== thumbSeq.current) return
      const none = p.render(paramsNow, null)
      const byId: Record<number, string> = {}
      for (const l of luts) {
        const c = await loadCube(l.id)
        if (seq !== thumbSeq.current) return
        const t = c ? p.render(paramsNow, c) : null
        if (t) byId[l.id] = t
      }
      setThumbs({ none, byId })
    })().catch((e) => console.error('滤镜缩略图没画出来：', e))
  }, [luts, loadCube])

  return { luts, cube, thumbs, ensureThumbs, reload }
}
