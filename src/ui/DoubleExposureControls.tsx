import { useRef } from 'react'
import { Btn } from './kit/Btn.tsx'
import { Slider } from './kit/Slider.tsx'
import type { BlendMode } from '../image/doubleExposure'

/** 双重曝光的第二行（★ 2026-10-17）—— 边框 / 贴纸 / 叠加 / 第二张图 / 混合 / 不透明度。 */
const MODES: [BlendMode, string][] = [
  ['normal', '正常'],
  ['screen', '滤色'],
  ['multiply', '正片叠底'],
  ['overlay', '叠加'],
]

type Props = {
  name: string | null
  mode: BlendMode
  opacity: number
  applying: boolean
  onChooseFile: (file: File) => void
  onMode: (mode: BlendMode) => void
  onOpacity: (opacity: number) => void
  onCanvas: () => void
  onFrame: () => void
  onSticker: () => void
  onShape: () => void
  onDoodle: () => void
  onLight: () => void
  onDuotone: () => void
  onCancel: () => void
  onDone: () => void
}

export default function DoubleExposureControls({
  name, mode, opacity, applying, onChooseFile, onMode, onOpacity,
  onCanvas, onFrame, onSticker, onShape, onDoodle, onLight, onDuotone, onCancel, onDone,
}: Props) {
  const fileRef = useRef<HTMLInputElement>(null)
  return (
    <>
      <button type="button" className="crop-chip" onClick={onCanvas}>画布</button>
      <button type="button" className="crop-chip" onClick={onFrame}>边框</button>
      <button type="button" className="crop-chip" onClick={onSticker}>贴纸</button>
      <button type="button" className="crop-chip" onClick={onShape}>形状</button>
      <button type="button" className="crop-chip on" aria-pressed="true">叠加</button>
      <button type="button" className="crop-chip" onClick={onDoodle}>涂鸦</button>
      <button type="button" className="crop-chip" onClick={onLight}>光效</button>
      <button type="button" className="crop-chip" onClick={onDuotone}>双色调</button>
      <input
        ref={fileRef}
        type="file"
        accept="image/*,.heic,.heif"
        hidden
        onChange={e => {
          const file = e.target.files?.[0]
          if (file) onChooseFile(file)
          e.target.value = ''
        }}
      />
      <button type="button" className="crop-btn" onClick={() => fileRef.current?.click()}>
        {name ? '换一张图' : '选第二张图'}
      </button>
      {name && <span className="tool-note">{name}</span>}
      <div className="retouch-modes" role="group" aria-label="混合模式">
        {MODES.map(([m, label]) => {
          const on = mode === m
          return (
            <button
              key={m} type="button"
              className={`crop-chip${on ? ' on' : ''}`}
              aria-pressed={on}
              onClick={() => onMode(m)}
            >{label}</button>
          )
        })}
      </div>
      <Slider
        label="不透明度" value={opacity}
        min={0} max={100} step={1}
        changed={opacity !== 50}
        onChange={onOpacity}
      />
      <div className="crop-tools">
        <button type="button" className="crop-btn" onClick={onCancel}>取消</button>
        <Btn
          className="crop-done"
          disabled={!name || opacity <= 0 || applying}
          onClick={() => void onDone()}
        >应用叠加</Btn>
      </div>
    </>
  )
}
