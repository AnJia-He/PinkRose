import { useRef } from 'react'
import { Btn } from './kit/Btn.tsx'
import { Slider } from './kit/Slider.tsx'
import { defaultBrushRadius, maxBrushRadius, type BrushMode } from '../core/retouch'
import type { BackgroundKind } from '../image/backgroundReplace'

/**
 * 「点修 → 抠图」的第二行（★ 2026-10-17）。
 * 智能主体 / 点背景二选一填掩码，画笔修边；背景可以透明，也可以直接换成
 * 纯色、虚化或用户自己的图片。
 */
const MODES: [BrushMode, string][] = [['paint', '画笔'], ['erase', '橡皮']]

type Props = {
  image: { width: number; height: number }
  mode: BrushMode
  radius: number
  dirty: boolean
  applying: boolean
  tolerance: number
  picking: boolean
  selecting: boolean
  backgroundKind: BackgroundKind
  backgroundColor: string
  backgroundName: string | null
  backgroundScale: number
  backgroundX: number
  backgroundY: number
  backgroundFlip: boolean
  onMode: (mode: BrushMode) => void
  onRadius: (radius: number) => void
  onTolerance: (tolerance: number) => void
  onAutoSelect: () => void
  onPickBackground: () => void
  onBackgroundKind: (kind: BackgroundKind) => void
  onBackgroundColor: (color: string) => void
  onChooseBackground: (file: File) => void
  onBackgroundScale: (value: number) => void
  onBackgroundX: (value: number) => void
  onBackgroundY: (value: number) => void
  onBackgroundFlip: () => void
  onBack: () => void
  onCancel: () => void
  onDone: () => void
}

export default function TransparentControls({
  image, mode, radius, dirty, applying,
  tolerance, picking, selecting,
  backgroundKind, backgroundColor, backgroundName,
  backgroundScale, backgroundX, backgroundY, backgroundFlip,
  onMode, onRadius, onTolerance, onAutoSelect, onPickBackground,
  onBackgroundKind, onBackgroundColor, onChooseBackground,
  onBackgroundScale, onBackgroundX, onBackgroundY, onBackgroundFlip,
  onBack, onCancel, onDone,
}: Props) {
  const fileRef = useRef<HTMLInputElement>(null)
  const canTransform = backgroundKind.startsWith('sky-') || backgroundKind === 'image'
  return (
    <>
      <button type="button" className="crop-chip" onClick={onBack}>修补</button>
      <button
        type="button"
        className="crop-chip"
        disabled={selecting}
        onClick={onAutoSelect}
      >智能主体</button>
      <button
        type="button"
        className={`crop-chip${picking ? ' on' : ''}`}
        aria-pressed={picking}
        disabled={selecting}
        onClick={onPickBackground}
      >点背景</button>
      <div className="retouch-modes" role="group" aria-label="笔触">
        {MODES.map(([m, name]) => {
          const on = mode === m
          return (
            <button
              key={m} type="button"
              className={`crop-chip${on ? ' on' : ''}`}
              aria-pressed={on}
              onClick={() => onMode(m)}
            >{name}</button>
          )
        })}
      </div>
      <Slider
        label="笔刷" value={radius}
        min={4} max={maxBrushRadius(image.width, image.height)} step={1}
        changed={radius !== defaultBrushRadius(image.width, image.height)}
        onChange={onRadius}
      />
      <Slider
        label="容差" value={tolerance}
        min={0} max={100} step={1}
        changed={tolerance !== 24}
        onChange={onTolerance}
      />
      <label className="bg-select">
        <span>背景</span>
        <select
          aria-label="背景"
          value={backgroundKind}
          disabled={selecting}
          onChange={e => onBackgroundKind(e.target.value as BackgroundKind)}
        >
          <option value="transparent">透明底</option>
          <option value="white">白底</option>
          <option value="blue">证件蓝</option>
          <option value="gray">浅灰</option>
          <option value="blur">虚化原背景</option>
          <option value="sky-blue">晴空</option>
          <option value="sky-sunset">日落</option>
          <option value="sky-dusk">暮色</option>
          <option value="color">自定义颜色</option>
          <option value="image">自定义图片</option>
        </select>
      </label>
      {backgroundKind === 'color' && (
        <label className="bg-custom-color">
          <span>颜色</span>
          <input
            type="color"
            aria-label="背景颜色"
            value={backgroundColor}
            onChange={e => onBackgroundColor(e.target.value)}
          />
        </label>
      )}
      {backgroundKind === 'image' && (
        <>
          <input
            ref={fileRef}
            type="file"
        accept="image/*,.heic,.heif"
            hidden
            onChange={e => {
              const file = e.target.files?.[0]
              if (file) onChooseBackground(file)
              e.target.value = ''
            }}
          />
          <button
            type="button"
            className="crop-btn"
            disabled={selecting}
            onClick={() => fileRef.current?.click()}
          >{backgroundName ? '换一张背景' : '选背景图'}</button>
          {backgroundName && <span className="tool-note">{backgroundName}</span>}
        </>
      )}
      {canTransform && (
        <>
          <Slider
            label="缩放" value={backgroundScale}
            min={100} max={180} step={1}
            changed={backgroundScale !== 100}
            onChange={onBackgroundScale}
          />
          <Slider
            label="左右" value={backgroundX}
            min={-100} max={100} step={1}
            changed={backgroundX !== 0}
            onChange={onBackgroundX}
          />
          <Slider
            label="上下" value={backgroundY}
            min={-100} max={100} step={1}
            changed={backgroundY !== 0}
            onChange={onBackgroundY}
          />
          <button
            type="button"
            className={`crop-chip${backgroundFlip ? ' on' : ''}`}
            aria-pressed={backgroundFlip}
            onClick={onBackgroundFlip}
          >翻转</button>
          {backgroundScale <= 100 && (
            <span className="tool-note">先把「缩放」调大，左右 / 上下才有余量</span>
          )}
        </>
      )}
      <div className="crop-tools">
        <button type="button" className="crop-btn" onClick={onCancel}>取消</button>
        <Btn
          className="crop-done"
          disabled={!dirty || applying || selecting
            || (backgroundKind === 'image' && !backgroundName)}
          onClick={() => void onDone()}
        >{backgroundKind === 'transparent' ? '擦成透明' : '换背景'}</Btn>
      </div>
    </>
  )
}
