import { useEffect, useRef, type PointerEvent as RPointerEvent } from 'react'
import { textFontFamily, type TextOptions } from '../image/text'
import { bindWindowDrag } from './kit/windowDrag.ts'

/**
 * 照片上的**文字预览 / 拖动层**（★ 2026-10-17）。
 *
 * 它只做两件事：
 *   · 按图片像素字号 × 屏幕缩放，把多行文字摆在 `(x, y)` 这个归一化中心；
 *   · 拖动文字块时把屏幕位移换算回 0~1，喊回 App。
 *
 * ⚠️ 和裁剪框 / 涂抹层同一条：坐标基准是 `Canvas` 量出来的**照片可见矩形**
 *   （`box`），不是整个画布区 —— 放大、平移之后拖动也仍然贴在字上。
 * ⚠️ 只有文字块本身接指针：点照片别处不会把字吸过去；拖动线索挂 window，
 *   手拖出照片区也不断（`kit/windowDrag` 统一收场）。
 */
export type TextBox = { left: number; top: number; width: number; height: number }

type Props = {
  box: TextBox
  imageWidth: number
  imageHeight: number
  options: TextOptions
  onMove: (x: number, y: number) => void
  /** 已提交的文字层：只显示、不接收拖动（编辑中的那一层仍走可拖版本）。 */
  readOnly?: boolean
}

const clamp01 = (v: number) => Math.max(0, Math.min(1, v))
const rgba = (hex: string, opacity: number) => {
  const n = parseInt(hex.slice(1), 16)
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${opacity / 100})`
}

export default function TextOverlay({
  box, imageWidth, imageHeight, options, onMove, readOnly = false,
}: Props) {
  const previewRef = useRef<HTMLDivElement | null>(null)
  const stopRef = useRef<(() => void) | null>(null)

  /** 组件走掉时把还挂在 window 上的拖动收干净（同涂抹层）。 */
  useEffect(() => () => stopRef.current?.(), [])

  const lines = options.text === '' ? [] : options.text.split('\n')
  // 预览按照片在屏幕上的宽度等比缩字号；高度比例与宽度相同（盒子保持照片比例）。
  const scale = imageWidth > 0
    ? box.width / imageWidth
    : imageHeight > 0 ? box.height / imageHeight : 1
  const fontPx = options.fontPx * scale
  const lineHeight = fontPx * options.lineHeight
  const outlinePx = options.outlineWidth * scale

  const onPointerDown = (e: RPointerEvent<HTMLDivElement>) => {
    e.stopPropagation()
    e.preventDefault()
    if (e.pointerType === 'mouse' && e.button !== 0) return
    const preview = previewRef.current
    if (!preview) return
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

  if (lines.length === 0 || fontPx <= 0) return null

  return (
    <div
      className="text-layer"
      style={{ left: box.left, top: box.top, width: box.width, height: box.height }}
    >
      <div
        ref={previewRef}
        className={`text-preview${readOnly ? ' committed' : ''}`}
        role="presentation"
        style={{
          left: options.x * box.width,
          top: options.y * box.height,
          fontFamily: textFontFamily(options.font),
          fontSize: fontPx,
          lineHeight: `${lineHeight}px`,
          letterSpacing: `${options.letterSpacing * scale}px`,
          color: options.color,
          transform: `translate(-50%, -50%) rotate(${options.rotation}deg)`,
          fontWeight: options.bold ? 700 : 400,
          textAlign: options.align,
          background: options.background ? rgba(options.backgroundColor, options.backgroundOpacity) : undefined,
          borderRadius: options.background ? 6 : undefined,
          WebkitTextStroke: outlinePx > 0 ? `${outlinePx}px ${options.outlineColor}` : undefined,
          textShadow: options.shadow
            ? '0 3px 8px rgba(0, 0, 0, .68)'
            : readOnly ? undefined
              : '0 1px 3px rgba(0, 0, 0, .55), 0 0 1px rgba(0, 0, 0, .65)',
        }}
        onPointerDown={readOnly ? undefined : onPointerDown}
      >
        {lines.map((line, i) => (
          // 空行也要占住行高，否则用户敲的回车在预览里会凭空消失。
          <span className="text-preview-line" key={i}>{line || '\u00a0'}</span>
        ))}
      </div>
    </div>
  )
}
