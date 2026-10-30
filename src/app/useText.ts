import { useCallback, useRef, useState, type Dispatch, type SetStateAction } from 'react'
import type { TextScene } from '../ui/Canvas'
import {
  DEFAULT_TEXT, normalizeTextOptions,
  type TextOptions,
} from '../image/text'
import type { EditLayer, TextLayer } from '../../shared/layers.ts'
import { applyLayersEdit, type BaseEditToolDeps } from './baseEdit'

/**
 * **文字那一簇**（★ 2026-10-19 改成可回改的文字层）。
 *
 * 现场仍然是 `TextOptions`；但提交不再把字烤进底图，而是把一整层
 * `{ id, options }` 放进当前这一版的 `layers` 里：
 *   · 位置 / 字号 / 颜色 / 字体随时可以回来改；
 *   · 文字层和 `params` / 滤镜一样按版本记进账本，`上一步 / 下一步` 能还原；
 *   · 会话的 `steps[].layers` 落盘，刷新后还能继续编辑；
 *   · 导出时才把文字层真正画进成片（`useDelivery`）。
 *
 * ⚠️ 层是**有序**的：后加的在上层。编辑按 `id` 替换，不按下标 ——
 *   删除一层不会让另一层的编辑跑到别人头上。
 */
export type TextDeps = BaseEditToolDeps & {
  layers: EditLayer[]
  setLayers: Dispatch<SetStateAction<EditLayer[]>>
}

const clamp01 = (v: number) => Math.max(0, Math.min(1, v))

export function useText(deps: TextDeps) {
  const {
    tool, image, history, setHistory, flushEdit,
    cursorIdRef, editSeqRef, markDirty, setTool,
    layers, setLayers,
  } = deps

  const [text, setText] = useState<TextOptions | null>(null)
  const [editingId, setEditingId] = useState<string | null>(null)
  const idRef = useRef(0)

  const nextLayerId = () => `text-${Date.now().toString(36)}-${++idRef.current}`

  /** 进文字：默认新起一层；已有层从下面的列表里点进来改。 */
  const openText = useCallback(() => {
    if (!image) return
    setEditingId(null)
    setText({ ...DEFAULT_TEXT })
  }, [image])

  /** 编辑已有层：把它的选项装回现场。 */
  const editText = useCallback((id: string) => {
    const layer = layers.find((item): item is TextLayer =>
      item.id === id && item.kind === 'text')
    if (!layer) return
    setEditingId(id)
    setText({ ...layer.options })
  }, [layers])

  /** 从已有层切回新文字。 */
  const newText = useCallback(() => {
    setEditingId(null)
    setText({ ...DEFAULT_TEXT })
  }, [])

  const closeText = useCallback(() => {
    setText(null)
    setEditingId(null)
  }, [])

  /** 「取消」= 现场扔掉，已经提交的层一个字节不动。 */
  const cancelText = () => { closeText(); setTool(null) }

  const moveText = useCallback((x: number, y: number) => {
    setText(r => (r ? { ...r, x: clamp01(x), y: clamp01(y) } : r))
  }, [])

  /** 提交：新增或替换一层，账本记一笔；底图不变。 */
  const commitText = useCallback(() => {
    if (!text || !image || text.text.trim() === '') return
    const options = normalizeTextOptions(text)
    const previous = editingId ? layers.find(layer => layer.id === editingId) : undefined
    const hidden = previous?.visible === false
    const next = editingId
      ? layers.map(layer => layer.id === editingId && layer.kind === 'text'
        ? {
          kind: 'text' as const, id: editingId, options,
          ...(hidden ? { visible: false } : {}),
        } : layer)
      : [...layers, { kind: 'text' as const, id: nextLayerId(), options }]
    applyLayersEdit({
      at: cursorIdRef.current, history, setHistory, editSeqRef, markDirty, flushEdit,
    }, next, '文字')
    setLayers(next)
    closeText()
    setTool(null)
  }, [text, image, editingId, layers, history, setHistory, editSeqRef, markDirty, flushEdit, closeText, setLayers, setTool])

  /** 删除一层：也记一笔，可以撤销。 */
  const deleteText = useCallback((id: string) => {
    if (!layers.some(layer => layer.id === id && layer.kind !== 'shape')) return
    const next = layers.filter(layer => layer.id !== id)
    applyLayersEdit({
      at: cursorIdRef.current, history, setHistory, editSeqRef, markDirty, flushEdit,
    }, next, '文字')
    setLayers(next)
    if (editingId === id) {
      setEditingId(null)
      setText({ ...DEFAULT_TEXT })
    }
  }, [layers, editingId, history, setHistory, editSeqRef, markDirty, flushEdit, setLayers])

  /** 交给 `Canvas` 的现场 —— 只在文字工具开着时非 null。 */
  const textScene: TextScene | null = (() => {
    if (!image || !text || tool !== 'text') return null
    return { options: text, onMove: moveText }
  })()

  return {
    text, setText, editingId, layers, writing: false,
    openText, newText, editText, closeText, cancelText, moveText,
    commitText, deleteText, textScene,
  }
}
