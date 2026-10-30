import { useCallback, useRef, useState, type Dispatch, type SetStateAction } from 'react'
import type { ShapeScene } from '../ui/Canvas'
import { DEFAULT_SHAPE, normalizeShapeOptions, type ShapeOptions } from '../image/shape'
import type { EditLayer, ShapeLayer } from '../../shared/layers.ts'
import { applyLayersEdit, type BaseEditToolDeps } from './baseEdit'

/**
 * **形状那一簇**（★ 2026-10-19 改成可回改形状层）。
 *
 * 和文字层同一套：形状不再烤进底图，而是作为 `{ kind:'shape', id, options }`
 * 进当前这一版的 `layers`。点已有形状可以回来改类型 / 颜色 / 线宽 / 填充 /
 * 位置，也可以单独删除；导出时才合成进成片。
 *
 * 裁剪 / 透视 / 扩画布 / 边框 / 放大这些几何操作会先把层合并再动像素，
 * 避免尺寸变化后形状跑位（撤销时层一起回来）。
 */
export type ShapeDeps = BaseEditToolDeps & {
  layers: EditLayer[]
  setLayers: Dispatch<SetStateAction<EditLayer[]>>
}

export function useShape(deps: ShapeDeps) {
  const {
    tool, image, history, setHistory, flushEdit,
    cursorIdRef, editSeqRef, markDirty, setTool,
    layers, setLayers,
  } = deps

  const [shape, setShape] = useState<ShapeOptions | null>(null)
  const [editingId, setEditingId] = useState<string | null>(null)
  const idRef = useRef(0)
  const nextLayerId = () => `shape-${Date.now().toString(36)}-${++idRef.current}`

  const openShape = useCallback(() => {
    if (!image) return
    setEditingId(null)
    setShape({ ...DEFAULT_SHAPE })
  }, [image])

  /** 从已有形状层回来改。 */
  const editShape = useCallback((id: string) => {
    const layer = layers.find((item): item is ShapeLayer =>
      item.id === id && item.kind === 'shape')
    if (!layer) return
    setEditingId(id)
    setShape({ ...layer.options })
  }, [layers])

  const newShape = useCallback(() => {
    setEditingId(null)
    setShape({ ...DEFAULT_SHAPE })
  }, [])

  const closeShape = useCallback(() => {
    setShape(null)
    setEditingId(null)
  }, [])

  const cancelShape = () => { closeShape(); setTool(null) }

  const commitShape = useCallback(() => {
    const options = shape
    if (!options || !image || options.opacity <= 0) return
    const normalized = normalizeShapeOptions(options)
    const previous = editingId ? layers.find(layer => layer.id === editingId) : undefined
    const hidden = previous?.visible === false
    const next = editingId
      ? layers.map(layer => layer.id === editingId && layer.kind === 'shape'
        ? {
          kind: 'shape' as const, id: editingId, options: normalized,
          ...(hidden ? { visible: false } : {}),
        } : layer)
      : [...layers, { kind: 'shape' as const, id: nextLayerId(), options: normalized }]
    applyLayersEdit({
      at: cursorIdRef.current, history, setHistory, editSeqRef, markDirty, flushEdit,
    }, next, '形状')
    setLayers(next)
    closeShape()
    setTool(null)
  }, [shape, image, editingId, layers, history, setHistory, editSeqRef, markDirty, flushEdit, closeShape, setLayers, setTool])

  const deleteShape = useCallback((id: string) => {
    if (!layers.some(layer => layer.id === id && layer.kind === 'shape')) return
    const next = layers.filter(layer => layer.id !== id)
    applyLayersEdit({
      at: cursorIdRef.current, history, setHistory, editSeqRef, markDirty, flushEdit,
    }, next, '形状')
    setLayers(next)
    if (editingId === id) {
      setEditingId(null)
      setShape({ ...DEFAULT_SHAPE })
    }
  }, [layers, editingId, history, setHistory, editSeqRef, markDirty, flushEdit, setLayers])

  const shapeScene: ShapeScene | null = (() => {
    if (!image || !shape || tool !== 'shape') return null
    return {
      options: shape,
      onChange: patch => setShape(s => (s ? { ...s, ...patch } : s)),
    }
  })()

  return {
    shape, setShape, applying: false, editingId, layers,
    openShape, newShape, editShape, closeShape, cancelShape,
    commitShape, deleteShape, shapeScene,
  }
}
