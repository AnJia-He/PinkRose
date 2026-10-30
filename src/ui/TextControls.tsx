import { Btn } from './kit/Btn.tsx'
import { Slider } from './kit/Slider.tsx'
import {
  DEFAULT_TEXT, TEXT_FONT_MAX, TEXT_FONT_MIN, TEXT_OUTLINE_MAX, TEXT_STYLES, type TextOptions,
  TEXT_FONTS, TEXT_LETTER_SPACING_MAX, TEXT_LETTER_SPACING_MIN,
  TEXT_LINE_HEIGHT_MAX, TEXT_LINE_HEIGHT_MIN, type TextLayer,
} from '../image/text'

/**
 * 文字工具的第二行（★ 2026-10-17）—— 内容 / 字号 / 颜色 / 取消 / 「加上文字」。
 *
 * 文字现在是**可回改的文字层**（★ 2026-10-19）：点上面那排已有层即可重新编辑，
 * 「＋ 新文字」再加一层；位置仍然直接拖照片上的字。主按钮只拦两件事：
 * 内容为空、正在落地。
 */
type Props = {
  image: { width: number; height: number }
  options: TextOptions
  writing: boolean
  /** 当前这一版已有的文字层（★ 2026-10-19）。 */
  layers: TextLayer[]
  /** 正在编辑哪一层；null = 新起一层。 */
  editingId: string | null
  onChange: (patch: Partial<TextOptions>) => void
  onNew: () => void
  onEdit: (id: string) => void
  onDelete: (id: string) => void
  onCancel: () => void
  onDone: () => void
}

export default function TextControls({
  image, options, writing, layers, editingId, onChange, onNew, onEdit, onDelete, onCancel, onDone,
}: Props) {
  const shortSide = Math.max(1, Math.min(image.width, image.height))
  const align = (value: TextOptions['align']) => {
    const name = value === 'left' ? '左' : value === 'right' ? '右' : '中'
    return (
      <button
        key={value} type="button"
        className={`crop-chip${options.align === value ? ' on' : ''}`}
        aria-pressed={options.align === value}
        onClick={() => onChange({ align: value })}
      >{name}</button>
    )
  }
  return (
    <div className="text-controls">
      {layers.length > 0 && (
        <div className="text-style-group" role="group" aria-label="已有文字层">
          {layers.map(layer => (
            <button
              key={layer.id}
              type="button"
              className={`crop-chip${editingId === layer.id ? ' on' : ''}`}
              aria-pressed={editingId === layer.id}
              title="点击改这一层"
              onClick={() => onEdit(layer.id)}
            >
              {layer.options.text.trim().replace(/\s+/g, ' ').slice(0, 12)}
            </button>
          ))}
          <button type="button" className="crop-chip" onClick={onNew}>＋ 新文字</button>
        </div>
      )}
      <textarea
        className="text-input"
        aria-label="文字内容"
        placeholder="输入想写的字（可换行）"
        rows={2}
        value={options.text}
        onChange={e => onChange({ text: e.target.value })}
      />
      <div className="text-style-group" role="group" aria-label="文字模板">
        {TEXT_STYLES.map(s => (
          <button
            key={s.id} type="button" className="crop-chip"
            title={`套用「${s.label}」样式`}
            onClick={() => onChange({
              ...s.patch,
              fontPx: Math.max(TEXT_FONT_MIN, Math.min(TEXT_FONT_MAX, Math.round(shortSide * s.fontRatio))),
            })}
          >{s.label}</button>
        ))}
      </div>
      <div className="text-style-group" role="group" aria-label="字体">
        {TEXT_FONTS.map(f => (
          <button
            key={f.id} type="button"
            className={`crop-chip${options.font === f.id ? ' on' : ''}`}
            aria-pressed={options.font === f.id}
            onClick={() => onChange({ font: f.id })}
          >{f.label}</button>
        ))}
      </div>
      <Slider
        label="字号" value={options.fontPx}
        min={TEXT_FONT_MIN} max={TEXT_FONT_MAX} step={1}
        changed={options.fontPx !== DEFAULT_TEXT.fontPx}
        onChange={fontPx => onChange({ fontPx })}
      />
      <Slider
        label="旋转" value={options.rotation}
        min={-180} max={180} step={1}
        changed={options.rotation !== DEFAULT_TEXT.rotation}
        onChange={rotation => onChange({ rotation })}
      />
      <Slider
        label="行距" value={options.lineHeight}
        min={TEXT_LINE_HEIGHT_MIN} max={TEXT_LINE_HEIGHT_MAX} step={0.05}
        changed={options.lineHeight !== DEFAULT_TEXT.lineHeight}
        onChange={lineHeight => onChange({ lineHeight })}
      />
      <Slider
        label="字距" value={options.letterSpacing}
        min={TEXT_LETTER_SPACING_MIN} max={TEXT_LETTER_SPACING_MAX} step={1}
        neutral={0}
        changed={options.letterSpacing !== DEFAULT_TEXT.letterSpacing}
        onChange={letterSpacing => onChange({ letterSpacing })}
      />
      <label className="text-color">
        <span>颜色</span>
        <input
          type="color"
          aria-label="文字颜色"
          value={options.color}
          onChange={e => onChange({ color: e.target.value })}
        />
      </label>
      <div className="text-style-group" role="group" aria-label="文字对齐">
        {(['left', 'center', 'right'] as const).map(align)}
      </div>
      <div className="text-style-group">
        <button
          type="button" className={`crop-chip${options.bold ? ' on' : ''}`}
          aria-pressed={options.bold} onClick={() => onChange({ bold: !options.bold })}
        >加粗</button>
        <button
          type="button" className={`crop-chip${options.shadow ? ' on' : ''}`}
          aria-pressed={options.shadow} onClick={() => onChange({ shadow: !options.shadow })}
        >阴影</button>
        <button
          type="button" className={`crop-chip${options.outlineWidth > 0 ? ' on' : ''}`}
          aria-pressed={options.outlineWidth > 0}
          onClick={() => onChange({ outlineWidth: options.outlineWidth > 0 ? 0 : 3 })}
        >描边</button>
        <button
          type="button" className={`crop-chip${options.background ? ' on' : ''}`}
          aria-pressed={options.background}
          onClick={() => onChange({ background: !options.background })}
        >底色</button>
      </div>
      {options.outlineWidth > 0 && (
        <div className="text-style-group">
          <Slider
            label="描边" value={options.outlineWidth}
            min={1} max={TEXT_OUTLINE_MAX} step={1}
            changed={options.outlineWidth !== 3}
            onChange={outlineWidth => onChange({ outlineWidth })}
          />
          <label className="text-color">
            <span>描边色</span>
            <input
              type="color" aria-label="描边颜色"
              value={options.outlineColor}
              onChange={e => onChange({ outlineColor: e.target.value })}
            />
          </label>
        </div>
      )}
      {options.background && (
        <div className="text-style-group">
          <Slider
            label="底色" value={options.backgroundOpacity}
            min={0} max={100} step={1}
            changed={options.backgroundOpacity !== DEFAULT_TEXT.backgroundOpacity}
            onChange={backgroundOpacity => onChange({ backgroundOpacity })}
          />
          <label className="text-color">
            <span>底色</span>
            <input
              type="color" aria-label="底色颜色"
              value={options.backgroundColor}
              onChange={e => onChange({ backgroundColor: e.target.value })}
            />
          </label>
        </div>
      )}
      <span className="text-hint">拖动照片上的字可以挪位置</span>
      <div className="crop-tools">
        <button type="button" className="crop-btn" onClick={onCancel}>取消</button>
        {editingId && (
          <button type="button" className="crop-btn" onClick={() => onDelete(editingId)}>
            删除这层
          </button>
        )}
        <Btn
          className="crop-done"
          disabled={options.text.trim() === '' || writing}
          onClick={() => void onDone()}
        >{editingId ? '更新文字' : '加上文字'}</Btn>
      </div>
    </div>
  )
}
