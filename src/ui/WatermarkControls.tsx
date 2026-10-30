import { useState } from 'react'
import { ImagePlus } from 'lucide-react'
import {
  DEFAULT_WATERMARK,
  type WatermarkLogo,
  type WatermarkOptions,
} from '../image/watermark'
import { TEXT_FONTS, type TextFontId } from '../../shared/text'
import { Slider } from './kit/Slider'

type Props = {
  idPrefix: string
  options: WatermarkOptions
  logo: WatermarkLogo | null
  compact?: boolean
  disabled?: boolean
  onChange: (next: WatermarkOptions) => void
  onLogo: (file: File | null) => Promise<void> | void
}

export default function WatermarkControls({
  idPrefix, options, logo, compact = false, disabled = false, onChange, onLogo,
}: Props) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const kind = options.kind ?? 'text'
  const tile = options.tile === true

  async function chooseLogo(file: File | null) {
    setError(null)
    setBusy(true)
    try {
      await onLogo(file)
    } catch (e) {
      setError(e instanceof Error ? e.message : '这张 Logo 打不开，换一张试试')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className={`watermark-controls${compact ? ' compact' : ''}`}>
      <div className="watermark-choice-row" role="group" aria-label="水印类型">
        <label className={`watermark-choice${kind === 'text' ? ' on' : ''}`}>
          <input
            type="radio"
            name={`${idPrefix}-watermark-kind`}
            value="text"
            checked={kind === 'text'}
            disabled={disabled}
            onChange={() => onChange({ ...options, kind: 'text' })}
          />
          文字
        </label>
        <label className={`watermark-choice${kind === 'logo' ? ' on' : ''}`}>
          <input
            type="radio"
            name={`${idPrefix}-watermark-kind`}
            value="logo"
            checked={kind === 'logo'}
            disabled={disabled}
            onChange={() => onChange({ ...options, kind: 'logo' })}
          />
          图片 Logo
        </label>
      </div>

      {kind === 'text' ? (
        <>
          <input
            className="watermark-text"
            name={`${idPrefix}-watermark-text`}
            value={options.text}
            placeholder="比如：PinkRose"
            aria-label="水印文字"
            disabled={disabled}
            onChange={e => onChange({ ...options, text: e.target.value })}
          />
          <label className="watermark-position">
            <span>字体</span>
            <select
              name={`${idPrefix}-watermark-font`}
              aria-label="水印字体"
              value={options.font ?? 'sans'}
              disabled={disabled}
              onChange={e => onChange({
                ...options,
                font: e.target.value as TextFontId,
              })}
            >
              {TEXT_FONTS.map(font => (
                <option key={font.id} value={font.id}>{font.label}</option>
              ))}
            </select>
          </label>
        </>
      ) : (
        <div className="watermark-logo-row">
          <label className="watermark-logo-pick">
            <input
              type="file"
              accept="image/png,image/jpeg,image/webp"
              aria-label="选择 Logo 图片"
              disabled={disabled || busy}
              onChange={(e) => {
                const file = e.target.files?.[0]
                e.target.value = ''
                if (file) void chooseLogo(file)
              }}
            />
            <ImagePlus size={15} strokeWidth={1.5} aria-hidden="true" />
            {busy ? '正在读取…' : logo?.name ?? '选择 Logo'}
          </label>
          {logo && (
            <label className="watermark-logo-clear">
              <input
                type="checkbox"
                disabled={disabled || busy}
                onChange={() => void chooseLogo(null)}
              />
              清除
            </label>
          )}
        </div>
      )}

      <div className="watermark-choice-row" role="group" aria-label="水印排布">
        <label className={`watermark-choice${!tile ? ' on' : ''}`}>
          <input
            type="radio"
            name={`${idPrefix}-watermark-tile`}
            value="single"
            checked={!tile}
            disabled={disabled}
            onChange={() => onChange({ ...options, tile: false })}
          />
          单个
        </label>
        <label className={`watermark-choice${tile ? ' on' : ''}`}>
          <input
            type="radio"
            name={`${idPrefix}-watermark-tile`}
            value="tile"
            checked={tile}
            disabled={disabled}
            onChange={() => onChange({ ...options, tile: true })}
          />
          平铺
        </label>
      </div>

      {!tile && (
        <label className="watermark-position">
          <span>位置</span>
          <select
            name={`${idPrefix}-watermark-position`}
            value={options.position}
            disabled={disabled}
            onChange={e => onChange({
              ...options,
              position: e.target.value as WatermarkOptions['position'],
            })}
          >
            <option value="bottom-right">右下</option>
            <option value="bottom-left">左下</option>
            <option value="top-right">右上</option>
            <option value="top-left">左上</option>
            <option value="center">居中</option>
          </select>
        </label>
      )}

      <div className="watermark-sliders">
        <Slider
          label="不透明度"
          value={options.opacity}
          min={10}
          max={100}
          step={1}
          changed={options.opacity !== DEFAULT_WATERMARK.opacity}
          onChange={opacity => onChange({ ...options, opacity })}
        />
        {kind === 'text' ? (
          <Slider
            label="字号"
            value={options.sizePct}
            min={1}
            max={12}
            step={1}
            changed={options.sizePct !== DEFAULT_WATERMARK.sizePct}
            onChange={sizePct => onChange({ ...options, sizePct })}
          />
        ) : (
          <Slider
            label="Logo 大小"
            value={options.logoSizePct ?? 18}
            min={5}
            max={40}
            step={1}
            changed={(options.logoSizePct ?? 18) !== DEFAULT_WATERMARK.logoSizePct}
            onChange={logoSizePct => onChange({ ...options, logoSizePct })}
          />
        )}
      </div>

      {kind === 'text' && (
        <label className="watermark-color">
          <span>颜色</span>
          <input
            type="color"
            name={`${idPrefix}-watermark-color`}
            value={options.color}
            disabled={disabled}
            onChange={e => onChange({ ...options, color: e.target.value })}
          />
        </label>
      )}
      {error && <p className="watermark-error" role="alert">{error}</p>}
      {kind === 'logo' && !logo && !error && (
        <p className="watermark-hint">选一张 PNG / JPG / WebP，透明背景的 PNG 效果最好。</p>
      )}
    </div>
  )
}
