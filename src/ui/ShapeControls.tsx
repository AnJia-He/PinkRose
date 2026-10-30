import { Btn } from './kit/Btn.tsx'
import { Slider } from './kit/Slider.tsx'
import {
  DEFAULT_SHAPE, SHAPE_RADIUS_MAX, SHAPE_STROKE_MAX, SHAPE_STROKE_MIN,
  type ShapeKind, type ShapeOptions,
} from '../image/shape'
import { BLEND_MODES } from '../image/blend'
import type { ShapeLayer } from '../../shared/layers.ts'

/**
 * 形状工具的第二行（★ 2026-10-19）。
 *
 * 装饰组里的第八个模式；和贴纸 / 边框 / 涂鸦走同一条 baseEdit 骨架。
 * 直接拖照片是画形状，下面这些滑杆只改现场，点了「应用形状」才写进底图。
 */
const KINDS: [ShapeKind, string][] = [
  ['rect', '矩形'], ['ellipse', '椭圆'], ['line', '直线'], ['arrow', '箭头'],
]

type Props = {
  options: ShapeOptions
  applying: boolean
  layers: ShapeLayer[]
  editingId: string | null
  onChange: (patch: Partial<ShapeOptions>) => void
  onNew: () => void
  onEdit: (id: string) => void
  onDelete: (id: string) => void
  onCanvas: () => void
  onFrame: () => void
  onSticker: () => void
  onDouble: () => void
  onDoodle: () => void
  onLight: () => void
  onDuotone: () => void
  onCancel: () => void
  onDone: () => void
}

export default function ShapeControls({
  options, applying, layers, editingId, onChange, onNew, onEdit, onDelete,
  onCanvas, onFrame, onSticker, onDouble, onDoodle,
  onLight, onDuotone, onCancel, onDone,
}: Props) {
  const fillable = options.kind === 'rect' || options.kind === 'ellipse'
  return (
    <>
      <button type="button" className="crop-chip" onClick={onCanvas}>画布</button>
      <button type="button" className="crop-chip" onClick={onFrame}>边框</button>
      <button type="button" className="crop-chip" onClick={onSticker}>贴纸</button>
      <button type="button" className="crop-chip on" aria-pressed="true">形状</button>
      <button type="button" className="crop-chip" onClick={onDouble}>叠加</button>
      <button type="button" className="crop-chip" onClick={onDoodle}>涂鸦</button>
      <button type="button" className="crop-chip" onClick={onLight}>光效</button>
      <button type="button" className="crop-chip" onClick={onDuotone}>双色调</button>
      {layers.length > 0 && (
        <div className="retouch-modes" role="group" aria-label="已有形状层">
          {layers.map(layer => (
            <button
              key={layer.id}
              type="button"
              className={`crop-chip${editingId === layer.id ? ' on' : ''}`}
              aria-pressed={editingId === layer.id}
              title="点击改这个形状"
              onClick={() => onEdit(layer.id)}
            >
              {KINDS.find(([kind]) => kind === layer.options.kind)?.[1] ?? '形状'}
            </button>
          ))}
          <button type="button" className="crop-chip" onClick={onNew}>＋ 新形状</button>
        </div>
      )}
      <div className="retouch-modes" role="group" aria-label="形状类型">
        {KINDS.map(([kind, label]) => {
          const on = options.kind === kind
          return (
            <button
              key={kind} type="button"
              className={`crop-chip${on ? ' on' : ''}`}
              aria-pressed={on}
              onClick={() => onChange({ kind })}
            >{label}</button>
          )
        })}
      </div>
      <Slider
        label="线宽" value={options.strokePct}
        min={SHAPE_STROKE_MIN} max={SHAPE_STROKE_MAX} step={0.1}
        neutral={DEFAULT_SHAPE.strokePct}
        changed={options.strokePct !== DEFAULT_SHAPE.strokePct}
        onChange={strokePct => onChange({ strokePct })}
      />
      {options.kind === 'rect' && (
        <Slider
          label="圆角" value={options.radiusPct}
          min={0} max={SHAPE_RADIUS_MAX} step={0.5}
          neutral={0}
          changed={options.radiusPct !== 0}
          onChange={radiusPct => onChange({ radiusPct })}
        />
      )}
      <Slider
        label="不透明度" value={options.opacity}
        min={0} max={100} step={1}
        changed={options.opacity !== DEFAULT_SHAPE.opacity}
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
      <label className="text-color">
        <span>颜色</span>
        <input
          type="color" aria-label="形状颜色"
          value={options.color}
          onChange={e => onChange({ color: e.target.value })}
        />
      </label>
      {fillable && (
        <div className="retouch-modes" role="group" aria-label="形状填充">
          <button
            type="button"
            className={`crop-chip${options.fill ? ' on' : ''}`}
            aria-pressed={options.fill}
            onClick={() => onChange({ fill: !options.fill })}
          >填充</button>
        </div>
      )}
      {fillable && options.fill && (
        <>
          <Slider
            label="填充度" value={options.fillOpacity}
            min={0} max={100} step={1}
            changed={options.fillOpacity !== DEFAULT_SHAPE.fillOpacity}
            onChange={fillOpacity => onChange({ fillOpacity })}
          />
          <label className="text-color">
            <span>填充色</span>
            <input
              type="color" aria-label="形状填充颜色"
              value={options.fillColor}
              onChange={e => onChange({ fillColor: e.target.value })}
            />
          </label>
        </>
      )}
      <span className="text-hint">在照片上拖出形状；线宽和圆角按照片短边缩放</span>
      <div className="crop-tools">
        <button type="button" className="crop-btn" onClick={onCancel}>取消</button>
        {editingId && (
          <button type="button" className="crop-btn" onClick={() => onDelete(editingId)}>
            删除这层
          </button>
        )}
        <Btn
          className="crop-done"
          disabled={applying || options.opacity <= 0}
          onClick={() => void onDone()}
        >{editingId ? '更新形状' : '应用形状'}</Btn>
      </div>
    </>
  )
}
