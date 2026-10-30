/**
 * **统一图层面板**（★ 2026-10-19）。
 *
 * 只摆当前这一版的 `layers`：文字 / 形状 / 贴纸在上面，局部层在下面。
 * 每行做四件事：显示 / 隐藏、点名字回来改、上移 / 下移、删除。
 *
 * ⚠️ 顺序的语义：
 *   · **叠图层**（文字 / 形状 / 贴纸）：数组越靠后 = 盖得越上面；
 *   · **局部层**：数组越靠后 = 越晚算，效果盖在更早的局部层上；
 *   · 两组之间不会互相插队 —— 局部层永远作用在底图上，叠图层永远盖在它上面。
 *   面板显示时两组各自**倒序**（最上面一行 = 画面上最上面那层）。
 *
 * ⚠️ 这是纯展示层：所有改动都通过回调交给 App（账本、落盘都在那边）。
 */
import { useState } from 'react'
import {
  Brush, ChevronDown, ChevronUp, Eye, EyeOff, Layers, Square, Sticker, Trash2, Type,
} from 'lucide-react'
import {
  isLayerVisible, type EditLayer, type ShapeLayer, type StickerLayer, type TextLayer,
} from '../../shared/layers.ts'
import type { LocalLayer } from '../../shared/local.ts'

type Props = {
  layers: readonly EditLayer[]
  onToggle: (id: string) => void
  onMove: (id: string, dir: 'up' | 'down') => void
  onDelete: (id: string) => void
  onEdit: (id: string) => void
}

const SHAPE_NAMES: Record<ShapeLayer['options']['kind'], string> = {
  rect: '矩形', ellipse: '椭圆', line: '直线', arrow: '箭头',
}

const STICKER_NAMES: Record<StickerLayer['options']['shape'], string> = {
  star: '星星', heart: '爱心', sparkle: '闪光', arrow: '箭头', speech: '对话框',
  flower: '花', cloud: '云', crown: '皇冠', music: '音符', lightning: '闪电',
  check: '对勾', sun: '太阳',
}

function short(text: string, max = 12): string {
  const chars = Array.from(text)
  return chars.length > max ? `${chars.slice(0, max).join('')}…` : text
}

function textLabel(layer: TextLayer): string {
  return `文字 · ${short(layer.options.text)}`
}

function layerLabel(layer: EditLayer, localIndex: number): string {
  if (layer.kind === 'text') return textLabel(layer)
  if (layer.kind === 'shape') return `形状 · ${SHAPE_NAMES[layer.options.kind]}`
  if (layer.kind === 'sticker') {
    return layer.options.source === 'image'
      ? '贴纸 · 自定义图片'
      : `贴纸 · ${STICKER_NAMES[layer.options.shape]}`
  }
  return `局部层 ${localIndex + 1}`
}

function iconFor(layer: EditLayer) {
  if (layer.kind === 'text') return <Type size={14} strokeWidth={1.5} aria-hidden="true" />
  if (layer.kind === 'shape') return <Square size={14} strokeWidth={1.5} aria-hidden="true" />
  if (layer.kind === 'sticker') return <Sticker size={14} strokeWidth={1.5} aria-hidden="true" />
  return <Brush size={14} strokeWidth={1.5} aria-hidden="true" />
}

type Row = {
  layer: EditLayer
  label: string
  index: number
  count: number
}

export default function LayerPanel({ layers, onToggle, onMove, onDelete, onEdit }: Props) {
  const [open, setOpen] = useState(true)
  if (layers.length === 0) return null

  const overlays = layers.filter(layer => layer.kind !== 'local')
  const locals = layers.filter((layer): layer is LocalLayer => layer.kind === 'local')
  const rows: Row[] = [
    ...overlays.map((layer, index): Row => ({
      layer, label: layerLabel(layer, 0), index, count: overlays.length,
    })).reverse(),
    ...locals.map((layer, index): Row => ({
      layer, label: layerLabel(layer, index), index, count: locals.length,
    })).reverse(),
  ]

  return (
    <section className="panel-group layer-panel">
      <button
        className="panel-group-head"
        aria-expanded={open}
        onClick={() => setOpen(value => !value)}
      >
        <span className="panel-group-title">
          <Layers size={14} strokeWidth={1.5} aria-hidden="true" />
          图层
          <span className="layer-count">{layers.length}</span>
        </span>
        <ChevronDown
          size={14} strokeWidth={1.5}
          className={open ? 'chev' : 'chev folded'} aria-hidden="true"
        />
      </button>
      {open && (
        <div className="panel-group-body">
          <ul className="layer-list" aria-label="图层列表">
            {rows.map(({ layer, label, index, count }) => {
              const visible = isLayerVisible(layer)
              return (
                <li key={layer.id} className={`layer-row${visible ? '' : ' off'}`}>
                  <button
                    type="button"
                    className="layer-eye"
                    aria-label={`${visible ? '隐藏' : '显示'}${label}`}
                    aria-pressed={visible}
                    onClick={() => onToggle(layer.id)}
                  >
                    {visible
                      ? <Eye size={14} strokeWidth={1.5} aria-hidden="true" />
                      : <EyeOff size={14} strokeWidth={1.5} aria-hidden="true" />}
                  </button>
                  <span className="layer-icon">{iconFor(layer)}</span>
                  <button
                    type="button"
                    className="layer-name"
                    title="点一下回来改"
                    onClick={() => onEdit(layer.id)}
                  >{label}</button>
                  <div className="layer-actions">
                    <button
                      type="button" aria-label={`上移${label}`}
                      disabled={index >= count - 1}
                      onClick={() => onMove(layer.id, 'up')}
                    ><ChevronUp size={14} strokeWidth={1.5} aria-hidden="true" /></button>
                    <button
                      type="button" aria-label={`下移${label}`}
                      disabled={index <= 0}
                      onClick={() => onMove(layer.id, 'down')}
                    ><ChevronDown size={14} strokeWidth={1.5} aria-hidden="true" /></button>
                    <button
                      type="button" aria-label={`删除${label}`}
                      onClick={() => onDelete(layer.id)}
                    ><Trash2 size={14} strokeWidth={1.5} aria-hidden="true" /></button>
                  </div>
                </li>
              )
            })}
          </ul>
          <p className="layer-hint">
            局部层作用在照片上；文字 / 形状 / 贴纸盖在它上面。关掉眼睛只是暂时不画，层还在。
          </p>
        </div>
      )}
    </section>
  )
}
