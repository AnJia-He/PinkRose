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
export function useLuts({ lut, image, params: _params, onError }: {
  lut: LutRef | null
  image: DecodedImage | null
  params: Adjustments
  /**
   * ★ 2026-10-05 终审修复：出事时**说给用户听**的那一句（App 传 `noticeBad` 进来）。
   *
   * 为什么必须有这个口子：这个 hook 里的失败原来只有一行 `console.error` ——
   * 最典型的后果是"格子亮着（状态说选中了）、画面不变、一句话都不说"。
   * 可选：不传就只留 console（测试和别的调用点不必被迫接一个通报）。
   */
  onError?: (msg: string) => void
}) {
  const [luts, setLuts] = useState<LutMeta[]>([])
  /**
   * 清单**真的从服务端拿到过一次**没有。
   *
   * ⚠️ 它和 `luts.length === 0` 是**两件事**：还没到手 / 取不到时，
   *    「还没有导入过滤镜。」是一句**关于用户资产的假话**（他的滤镜还在服务端上）。
   *    只有拿到过空清单，那句才是事实（`LutSettings` 的四态、`AccountPage`
   *    的 `lutCount !== null` 都是同一个道理，见 `LutPicker` 的 `lutsKnown`）。
   */
  const [lutsKnown, setLutsKnown] = useState(false)
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

  /**
   * `onError` 的影子。⚠️ **刻意不进任何依赖数组**：它是"出事那一刻读一下"的东西
   * （调用方写了个内联箭头就等于每次渲染换个身份，把那两条 effect 全带着重跑）。
   */
  const onErrorRef = useRef(onError)
  useEffect(() => { onErrorRef.current = onError }, [onError])

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

  /**
   * 拉一遍清单。
   *
   * ★ 2026-10-05 终审修复：失败时回 **`null`**，**不回空数组**。
   *   空数组在调用方那边和"服务端说清单是空的"长得一模一样：`refreshLuts` 会据此
   *   把用户手上正用着的滤镜当成"刚被删掉了"清掉（还告诉他一句假话）—— 而
   *   `GET /api/luts` 挂在离线 / 5xx / 后端刚重启时都成立，用户其实什么都没删。
   *   `null` 的意思只有一个：**这次没问出来，什么都不许照**。
   */
  const reload = useCallback(async (): Promise<LutMeta[] | null> => {
    try {
      const { luts: list } = await listLuts()
      setLuts(list)
      setLutsKnown(true)
      return list
    } catch (e) {
      console.error('滤镜清单没取回来：', e)
      return null
    }
  }, [])

  // 登录后拉一次清单（App 挂载时）
  useEffect(() => { void reload() }, [reload])

  // 当前滤镜换了 → 取它的 cube（认不出来的当"没有"）
  useEffect(() => {
    const seq = ++cubeSeq.current
    if (lutId === null) { setCube(null); return }
    void loadCube(lutId).then((c) => {
      if (seq !== cubeSeq.current) return
      setCube(c)
      // ★ 2026-10-05 终审修复：取不到要**说得出口**。不说的话用户看到的是
      //   "格子亮着、画面不变、一句话都没有" —— 而再点同一格也不会重试
      //   （这条 effect 的依赖是 `lutId`，没变），得换一个滤镜才动。
      if (c === null) onErrorRef.current?.('那个滤镜没取回来 —— 换一个试试，或者刷新一下。')
    })
  }, [lutId, loadCube])

  // 换照片 → 缩略图作废（下次打开格子重画；这里的 `image` 刻意进依赖）
  useEffect(() => {
    thumbSeq.current++
    setThumbs({ none: null, byId: {} })
  }, [image])

  /**
   * 打开格子时叫一次：把还没有的缩略图补齐。
   * ⚠️ 每个滤镜**先把 cube 取到手**再画 —— 没取到就不画那一格（格子会显示占位）。
   *
   * ★ 2026-10-05 终审：**边画边给**（原来是所有格子全画完才发唯一一次
   *   `setThumbs`）。一次发的后果：打开「滤镜」这一栏先看到的是一整屏**灰方块**
   *   —— 30 个滤镜要等好几秒，每一格都像"加载失败"。现在 `setImage` 一回来就把
   *   「不用」那一格 + **手上已经有的**缩略图先发出去（重开这一栏时上回画好的
   *   直接摆出来，不再空屏），之后每画好一格补发一格。
   *
   * ⚠️ 两件事别动：
   *   · `seq !== thumbSeq.current` 的作废判据（每格等回来的地方都查一次 ——
   *     换照片 / 关掉这一栏时这条协程必须停得住，见上面 `thumbSeq` 那段）；
   *   · 每次都用**函数式更新拿最新的 `prev`** 拼：闭包里那份 `byId` 是发车
   *     那一刻的旧值，拿它拼会把路途中已经补上的格子抹掉。
   *   签名照旧是同步的 `void`，**不许改成 async 返回 Promise** —— 三个调用点
   *   （App 两处、面板一处）都按"叫一声就走"用，不该跟着改。
   */
  const ensureThumbs = useCallback((imageNow: DecodedImage | null, paramsNow: Adjustments) => {
    if (!imageNow) return
    const seq = ++thumbSeq.current
    const p = ensurePreview()
    void (async () => {
      await p.setImage(imageNow)
      if (seq !== thumbSeq.current) return
      const none = p.render(paramsNow, null)
      // 第一发：「不用」那一格 + 已经有的（`prev.byId` 原样带着）
      setThumbs((prev) => ({ ...prev, none }))
      for (const l of luts) {
        const c = await loadCube(l.id)
        if (seq !== thumbSeq.current) return
        const t = c ? p.render(paramsNow, c) : null
        if (!t) continue
        setThumbs((prev) => ({ ...prev, byId: { ...prev.byId, [l.id]: t } }))
      }
    })().catch((e) => console.error('滤镜缩略图没画出来：', e))
  }, [luts, loadCube])

  return { luts, lutsKnown, cube, thumbs, ensureThumbs, reload }
}
