/**
 * **可回改局部层的派生底图**（★ 2026-10-19）。
 *
 * `image` 永远是干净底图；这里按层序把局部效果算到一张**新的**位图上，
 * 给画布和工具用。层一变就重算，旧位图当场关掉。
 *
 * ⚠️ 派生是异步的（解掩码 + `createImageBitmap`）。准备期间 `effectiveImage`
 *   退回首图；`App` 用 `preparing` 挡住"这时候去开底图工具"——否则工具会拿
 *   不含局部效果的底图做出一版，`setBaseImage` 又会清掉局部层，效果就丢了。
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import type { DecodedImage } from '../image/decode'
import type { EditLayer } from '../../shared/layers.ts'
import { applyLocalLayers, isLocalLayer, preloadLocalMasks } from '../image/localLayer'

type Derived = { source: ImageBitmap; bitmap: ImageBitmap }

/**
 * 同一层对象只发一个稳定的序号（`layers` 每次文字/形状改动都会换数组，
 * 但局部层对象是原样带过去的）。层的内容一旦改，代码总是换一个新对象 ——
 * 所以身份就够，不用每次拿 2 MB 的掩码做哈希。
 */
const layerKeys = new WeakMap<object, number>()
let nextLayerKey = 0

function localKey(layers: readonly EditLayer[]): string {
  return layers.filter(isLocalLayer).map(layer => {
    let key = layerKeys.get(layer)
    if (key === undefined) {
      key = ++nextLayerKey
      layerKeys.set(layer, key)
    }
    return `${layer.id}=${key}`
  }).join('|')
}

export function useLocalLayers(
  image: DecodedImage | null, layers: readonly EditLayer[],
): {
  effectiveImage: DecodedImage | null
  preparing: boolean
  error: string | null
} {
  // ⚠️ 依赖用**内容签名**而不是 `layers` 数组身份：改文字 / 形状时 `layers`
  //   会换一个新数组，但局部层一个字节都没变 —— 不该为重算局部效果卡一下。
  const signature = useMemo(() => localKey(layers), [layers])
  const [derived, setDerived] = useState<Derived | null>(null)
  const [preparing, setPreparing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const seqRef = useRef(0)
  const derivedRef = useRef<Derived | null>(null)

  useEffect(() => {
    const seq = ++seqRef.current
    const put = (next: Derived | null) => {
      const old = derivedRef.current
      derivedRef.current = next
      setDerived(next)
      if (old && old !== next) old.bitmap.close()
    }
    const local = layers.filter(isLocalLayer)
    if (!image || local.length === 0) {
      put(null)
      setPreparing(false)
      setError(null)
      return
    }
    setPreparing(true)
    setError(null)
    void (async () => {
      try {
        await preloadLocalMasks(local)
        const bitmap = await applyLocalLayers(image.bitmap, local)
        if (!bitmap) {
          // 全部局部层都被关掉了（或没有可算的层）：派生图要撤掉，
          // 否则画布还会挂着上一张带效果的旧图 —— 眼睛看起来"没反应"。
          if (seq === seqRef.current) put(null)
          return
        }
        if (seq !== seqRef.current) {
          bitmap.close()
          return
        }
        put({ source: image.bitmap, bitmap })
      } catch (e) {
        console.error('可回改局部层没算出来', e)
        if (seq !== seqRef.current) return
        setError('这个局部层这次没算出来，先按底图显示。')
      } finally {
        if (seq === seqRef.current) setPreparing(false)
      }
    })()
  }, [image, signature])

  useEffect(() => () => {
    const cur = derivedRef.current
    derivedRef.current = null
    cur?.bitmap.close()
  }, [])

  const effectiveImage = useMemo(() => {
    if (image && derived && derived.source === image.bitmap) {
      return {
        bitmap: derived.bitmap,
        width: derived.bitmap.width,
        height: derived.bitmap.height,
      }
    }
    return image
  }, [image, derived])

  return { effectiveImage, preparing, error }
}
