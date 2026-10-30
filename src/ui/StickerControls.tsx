import { useRef } from 'react'
import { Btn } from './kit/Btn.tsx'
import { Slider } from './kit/Slider.tsx'
import { DEFAULT_STICKER, type StickerOptions, type StickerShape } from '../image/sticker'
import { BLEND_MODES } from '../image/blend'
import type { StickerLayer } from '../../shared/layers.ts'

/**
 * 贴纸的第二行（★ 2026-10-17）—— 边框 / 十二种贴纸 /
 * 大小 / 旋转 / 颜色 / 取消 / 应用贴纸。拖照片上的贴纸挪位置。
 */
const SHAPES: [StickerShape, string][] = [
  ['star', '星'],
  ['heart', '心'],
  ['sparkle', '闪光'],
  ['arrow', '箭头'],
  ['speech', '对话框'],
  ['flower', '花'],
  ['cloud', '云'],
  ['crown', '皇冠'],
  ['music', '音符'],
  ['lightning', '闪电'],
  ['check', '对勾'],
  ['sun', '太阳'],
]

type Props = {
  options: StickerOptions
  applying: boolean
  layers: StickerLayer[]
  editingId: string | null
  hasCustom: boolean
  customName: string | null
  onChange: (patch: Partial<StickerOptions>) => void
  onNew: () => void
  onEdit: (id: string) => void
  onDelete: (id: string) => void
  onChooseFile: (file: File) => void
  onCanvas: () => void
  onFrame: () => void
  onShape: () => void
  onDouble: () => void
  onDoodle: () => void
  onLight: () => void
  onDuotone: () => void
  onCancel: () => void
  onDone: () => void
}

export default function StickerControls({
  options, applying, layers, editingId, hasCustom, customName, onChange, onNew, onEdit, onDelete, onChooseFile,
  onCanvas, onFrame, onShape, onDouble, onDoodle, onLight, onDuotone, onCancel, onDone,
}: Props) {
  const fileRef = useRef<HTMLInputElement>(null)
  return (
    <>
      <button type="button" className="crop-chip" onClick={onCanvas}>画布</button>
      <button type="button" className="crop-chip" onClick={onFrame}>边框</button>
      <button type="button" className="crop-chip" onClick={onShape}>形状</button>
      <button type="button" className="crop-chip" onClick={onDouble}>叠加</button>
      <button type="button" className="crop-chip" onClick={onDoodle}>涂鸦</button>
      <button type="button" className="crop-chip" onClick={onLight}>光效</button>
      <button type="button" className="crop-chip" onClick={onDuotone}>双色调</button>
      {layers.length > 0 && (
        <div className="retouch-modes" role="group" aria-label="已有贴纸层">
          {layers.map(layer => (
            <button
              key={layer.id}
              type="button"
              className={`crop-chip${editingId === layer.id ? ' on' : ''}`}
              aria-pressed={editingId === layer.id}
              title="点击改这张贴纸"
              onClick={() => onEdit(layer.id)}
            >
              {layer.options.source === 'image' ? '我的图'
                : SHAPES.find(([shape]) => shape === layer.options.shape)?.[1] ?? '贴纸'}
            </button>
          ))}
          <button type="button" className="crop-chip" onClick={onNew}>＋ 新贴纸</button>
        </div>
      )}
      <div className="retouch-modes" role="group" aria-label="贴纸来源">
        <button
          type="button"
          className={`crop-chip${options.source === 'shape' ? ' on' : ''}`}
          aria-pressed={options.source === 'shape'}
          onClick={() => onChange({ source: 'shape' })}
        >图形</button>
        <button
          type="button"
          className={`crop-chip${options.source === 'image' ? ' on' : ''}`}
          aria-pressed={options.source === 'image'}
          onClick={() => hasCustom ? onChange({ source: 'image' }) : fileRef.current?.click()}
        >我的图</button>
        {options.source === 'image' && (
          <button type="button" className="crop-chip" onClick={() => fileRef.current?.click()}>
            换图
          </button>
        )}
      </div>
      <input
        ref={fileRef}
        type="file"
        className="sticker-file"
        accept="image/*,.heic,.heif"
        aria-label="选贴纸图片"
        onChange={e => {
          const file = e.target.files?.[0]
          if (file) onChooseFile(file)
          e.target.value = ''
        }}
      />
      {options.source === 'shape' ? (
        <div className="retouch-modes" role="group" aria-label="贴纸形状">
          {SHAPES.map(([shape, name]) => {
            const on = options.shape === shape
            return (
              <button
                key={shape} type="button"
                className={`crop-chip${on ? ' on' : ''}`}
                aria-pressed={on}
                onClick={() => onChange({ shape })}
              >{name}</button>
            )
          })}
        </div>
      ) : (
        <span className="text-hint">{customName ?? '选一张 PNG / WebP 图片'}</span>
      )}
      <Slider
        label="大小" value={options.sizePct}
        min={2} max={60} step={1}
        changed={options.sizePct !== DEFAULT_STICKER.sizePct}
        onChange={sizePct => onChange({ sizePct })}
      />
      <Slider
        label="旋转" value={options.rotation}
        min={-180} max={180} step={1}
        neutral={0}
        changed={options.rotation !== 0}
        onChange={rotation => onChange({ rotation })}
      />
      <Slider
        label="不透明度" value={options.opacity}
        min={0} max={100} step={1}
        changed={options.opacity !== DEFAULT_STICKER.opacity}
        onChange={opacity => onChange({ opacity })}
      />
      <div className="retouch-modes" role="group" aria-label="混合模式">
        {BLEND_MODES.map(mode => {
          const on = options.blend === mode.id
          return (
            <button
              key={mode.id} type="button"
              className={`crop-chip${on ? ' on' : ''}`}
              aria-pressed={on}
              onClick={() => onChange({ blend: mode.id })}
            >{mode.label}</button>
          )
        })}
      </div>
      {options.source === 'image' && (
        <>
          <div className="retouch-modes" role="group" aria-label="图片填充">
            {(['contain', 'cover'] as const).map(fit => (
              <button
                key={fit} type="button"
                className={`crop-chip${options.fit === fit ? ' on' : ''}`}
                aria-pressed={options.fit === fit}
                onClick={() => onChange({ fit })}
              >{fit === 'contain' ? '完整' : '填满'}</button>
            ))}
          </div>
          <div className="retouch-modes" role="group" aria-label="图片翻转">
            <button
              type="button"
              className={`crop-chip${options.flipH ? ' on' : ''}`}
              aria-pressed={options.flipH}
              onClick={() => onChange({ flipH: !options.flipH })}
            >水平翻转</button>
            <button
              type="button"
              className={`crop-chip${options.flipV ? ' on' : ''}`}
              aria-pressed={options.flipV}
              onClick={() => onChange({ flipV: !options.flipV })}
            >垂直翻转</button>
          </div>
        </>
      )}
      {options.source === 'shape' && (
        <label className="text-color">
          <span>颜色</span>
          <input
            type="color" aria-label="贴纸颜色"
            value={options.color}
            onChange={e => onChange({ color: e.target.value })}
          />
        </label>
      )}
      <div className="crop-tools">
        <button type="button" className="crop-btn" onClick={onCancel}>取消</button>
        {editingId && (
          <button type="button" className="crop-btn" onClick={() => onDelete(editingId)}>
            删除这层
          </button>
        )}
        <Btn
          className="crop-done"
          disabled={applying || options.opacity <= 0 || (options.source === 'image' && !hasCustom)}
          onClick={() => void onDone()}
        >{editingId ? '更新贴纸' : '应用贴纸'}</Btn>
      </div>
    </>
  )
}
