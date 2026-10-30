import { useCallback, useRef, useState, type Dispatch, type SetStateAction } from 'react'
import type { StickerScene } from '../ui/Canvas'
import {
  DEFAULT_STICKER, normalizeStickerOptions,
  cacheStickerImage, stickerBitmapToDataUrl,
  type StickerOptions,
} from '../image/sticker'
import { decodeImageFile } from '../image/decode'
import type { EditLayer, StickerLayer } from '../../shared/layers.ts'
import { applyLayersEdit, type BaseEditToolDeps } from './baseEdit'

/**
 * **贴纸那一簇**（★ 2026-10-17；2026-10-19 改成可回改贴纸层）。
 *
 * 内置矢量贴纸和自定义图片贴纸都进 `layers`：
 *   · 内置图形只存 `StickerOptions`；
 *   · 自定义图片多存一份 512px 内的透明 PNG data URL（`image`），
 *     导出 / 封面时从运行时缓存取位图。
 *
 * 裁剪 / 透视 / 扩画布 / 边框 / 放大这些几何操作会先合并所有层再动像素。
 */
export type StickerDeps = BaseEditToolDeps & {
  layers: EditLayer[]
  setLayers: Dispatch<SetStateAction<EditLayer[]>>
}

const clamp01 = (v: number) => Math.max(0, Math.min(1, v))

export function useSticker(deps: StickerDeps) {
  const {
    tool, image, history, setHistory, noticeBad,
    flushEdit, cursorIdRef, editSeqRef, markDirty, setTool,
    layers, setLayers,
  } = deps

  const [sticker, setSticker] = useState<StickerOptions | null>(null)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [customPreview, setCustomPreview] = useState<string | null>(null)
  const [customName, setCustomName] = useState<string | null>(null)
  const idRef = useRef(0)
  const nextLayerId = () => `sticker-${Date.now().toString(36)}-${++idRef.current}`

  const openSticker = useCallback(() => {
    if (!image) return
    setEditingId(null)
    setCustomPreview(null)
    setCustomName(null)
    setSticker({ ...DEFAULT_STICKER })
  }, [image])

  const editSticker = useCallback((id: string) => {
    const layer = layers.find((item): item is StickerLayer =>
      item.id === id && item.kind === 'sticker')
    if (!layer) return
    setEditingId(id)
    setCustomPreview(layer.image ?? null)
    setCustomName(layer.image ? '已存的自定义贴纸' : null)
    setSticker({ ...layer.options })
  }, [layers])

  const newSticker = useCallback(() => {
    setEditingId(null)
    setCustomPreview(null)
    setCustomName(null)
    setSticker({ ...DEFAULT_STICKER })
  }, [])

  const closeSticker = useCallback(() => {
    setSticker(null)
    setEditingId(null)
    setCustomPreview(null)
    setCustomName(null)
  }, [])
  const cancelSticker = () => { closeSticker(); setTool(null) }

  const moveSticker = useCallback((x: number, y: number) => {
    setSticker(s => (s ? { ...s, x: clamp01(x), y: clamp01(y) } : s))
  }, [])

  const chooseCustom = useCallback(async (file: File) => {
    try {
      const decoded = await decodeImageFile(file)
      const dataUrl = stickerBitmapToDataUrl(decoded.bitmap, 512)
      cacheStickerImage(dataUrl, decoded.bitmap)
      setCustomPreview(dataUrl)
      setCustomName(file.name)
      setSticker(s => (s ? { ...s, source: 'image' } : s))
    } catch (e) {
      console.error(e)
      noticeBad('这张贴纸图打不开。换一张 PNG / WebP 试试。')
    }
  }, [noticeBad])

  const commitSticker = useCallback(() => {
    const scene = sticker
    if (!scene || !image || scene.opacity <= 0) return
    const options = normalizeStickerOptions(scene)
    if (options.source === 'image' && !customPreview) return
    const previous = editingId ? layers.find(item => item.id === editingId) : undefined
    const layer: StickerLayer = {
      kind: 'sticker',
      id: editingId ?? nextLayerId(),
      options,
      image: options.source === 'image' ? customPreview : null,
      ...(previous?.visible === false ? { visible: false } : {}),
    }
    const next = editingId
      ? layers.map(item => item.id === editingId && item.kind === 'sticker' ? layer : item)
      : [...layers, layer]
    applyLayersEdit({
      at: cursorIdRef.current, history, setHistory, editSeqRef, markDirty, flushEdit,
    }, next, '贴纸')
    setLayers(next)
    closeSticker()
    setTool(null)
  }, [sticker, image, customPreview, editingId, layers, history, setHistory, editSeqRef, markDirty, flushEdit, closeSticker, setLayers, setTool])

  const deleteSticker = useCallback((id: string) => {
    if (!layers.some(item => item.id === id && item.kind === 'sticker')) return
    const next = layers.filter(item => item.id !== id)
    applyLayersEdit({
      at: cursorIdRef.current, history, setHistory, editSeqRef, markDirty, flushEdit,
    }, next, '贴纸')
    setLayers(next)
    if (editingId === id) {
      setEditingId(null)
      setCustomPreview(null)
      setCustomName(null)
      setSticker({ ...DEFAULT_STICKER })
    }
  }, [layers, editingId, history, setHistory, editSeqRef, markDirty, flushEdit, setLayers])

  const stickerScene: StickerScene | null = (() => {
    if (!image || !sticker || tool !== 'sticker') return null
    return {
      options: sticker, onMove: moveSticker,
      customPreview,
    }
  })()

  return {
    sticker, setSticker, applying: false, editingId, customPreview, customName,
    openSticker, newSticker, editSticker, closeSticker, cancelSticker, moveSticker,
    chooseCustom, commitSticker, deleteSticker, stickerScene,
  }
}
