import { useState } from 'react'
import {
  OUTPAINT_ASPECTS, type OutpaintAspect,
} from '../export/outpaint'
import { Btn } from './kit/Btn'

type Props = {
  image: { width: number; height: number }
  busy: boolean
  canGenerate: boolean
  onBack: () => void
  onCancel: () => void
  onGenerate: (aspect: OutpaintAspect) => void
}

export default function OutpaintControls({
  image, busy, canGenerate, onBack, onCancel, onGenerate,
}: Props) {
  const [aspect, setAspect] = useState<OutpaintAspect>('1:1')
  return (
    <>
      <button type="button" className="crop-chip" onClick={onBack}>返回裁剪</button>
      <div className="crop-ratios" role="group" aria-label="扩图比例">
        {OUTPAINT_ASPECTS.map(value => (
          <button
            key={value}
            type="button"
            className={`crop-chip${aspect === value ? ' on' : ''}`}
            aria-pressed={aspect === value}
            disabled={busy}
            onClick={() => setAspect(value)}
          >{value}</button>
        ))}
      </div>
      <span className="tool-note">
        当前 {image.width}×{image.height} · 目标 {aspect} · 模型长边 ≤ 2048 ·
        约 10 秒；生成后是新的一版，可撤销
      </span>
      {!canGenerate && !busy && (
        <span className="tool-note">先回到最新一版再扩图</span>
      )}
      <div className="crop-tools">
        <button type="button" className="crop-btn" onClick={onCancel} disabled={busy}>
          取消
        </button>
        <Btn
          className="crop-done"
          disabled={busy || !canGenerate}
          onClick={() => onGenerate(aspect)}
        >
          {busy ? '正在扩图…' : '生成扩图'}
        </Btn>
      </div>
    </>
  )
}
