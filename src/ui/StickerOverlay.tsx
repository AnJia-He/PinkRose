import { useEffect, useRef, type PointerEvent as RPointerEvent } from 'react'
import { STICKER_PATHS, type StickerOptions } from '../image/sticker'
import { bindWindowDrag } from './kit/windowDrag.ts'

/**
 * 照片上的**贴纸预览 / 拖动层**（★ 2026-10-17）。
 *
 * 预览和成片共用 `image/sticker.ts` 的 SVG path。贴纸大小按照片短边百分比算，
 * 所以拖动、缩放窗口后看起来还是同一张贴纸。
 */
export type StickerBox = { left: number; top: number; width: number; height: number }

type Props = {
  box: StickerBox
  options: StickerOptions
  customPreview?: string | null
  onMove: (x: number, y: number) => void
  /** 已提交的贴纸层：只显示、不接收拖动。 */
  readOnly?: boolean
}

const clamp01 = (v: number) => Math.max(0, Math.min(1, v))

export default function StickerOverlay({
  box, options, customPreview, onMove, readOnly = false,
}: Props) {
  const stopRef = useRef<(() => void) | null>(null)
  const stickerRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => () => stopRef.current?.(), [])

  const onPointerDown = (e: RPointerEvent<HTMLDivElement>) => {
    e.stopPropagation()
    e.preventDefault()
    if (e.pointerType === 'mouse' && e.button !== 0) return
    if (!stickerRef.current) return
    stopRef.current?.()
    const startX = options.x
    const startY = options.y
    const fromX = e.clientX
    const fromY = e.clientY
    const onDrag = (ev: PointerEvent) => {
      if (box.width <= 0 || box.height <= 0) return
      onMove(
        clamp01(startX + (ev.clientX - fromX) / box.width),
        clamp01(startY + (ev.clientY - fromY) / box.height),
      )
    }
    const d = bindWindowDrag(onDrag, () => { stopRef.current = null })
    stopRef.current = d.stop
  }

  const size = Math.max(8, Math.min(box.width, box.height) * options.sizePct / 100)
  if (options.source === 'image' && !customPreview) return null
  return (
    <div
      className={`sticker-layer${readOnly ? ' committed' : ''}`}
      style={{ left: box.left, top: box.top, width: box.width, height: box.height }}
    >
      <div
        ref={stickerRef}
        className="sticker-preview"
        style={{
          left: options.x * box.width,
          top: options.y * box.height,
          width: size, height: size,
          opacity: options.opacity / 100,
          mixBlendMode: options.blend,
          overflow: options.source === 'image' && options.fit === 'cover' ? 'hidden' : undefined,
          transform: `translate(-50%, -50%) rotate(${options.rotation}deg)`
            + `${options.flipH ? ' scaleX(-1)' : ''}${options.flipV ? ' scaleY(-1)' : ''}`,
        }}
        onPointerDown={readOnly ? undefined : onPointerDown}
      >
        {options.source === 'image' ? (
          <img
            className="sticker-preview-image"
            src={customPreview ?? ''}
            alt=""
            aria-hidden="true"
            draggable={false}
            style={{ objectFit: options.fit }}
          />
        ) : (
          <svg viewBox="0 0 1 1" preserveAspectRatio="none" aria-hidden="true">
            <path d={STICKER_PATHS[options.shape]} fill={options.color} />
          </svg>
        )}
      </div>
    </div>
  )
}
