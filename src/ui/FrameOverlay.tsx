import { frameFractions, type FrameOptions } from '../image/frame'

/**
 * 照片上的**相框预览**（★ 2026-10-17）。
 *
 * 它只画四条边，不碰像素；比例来自 `image/frame.ts` 的 `frameFractions`，
 * 和「应用边框」时写进底图的那一套公式是同一份。胶片样式额外用重复渐变
 * 画出上下两排齿孔。
 *
 * ⚠️ 圆角样式在预览里只能近似（照片当前还是方的）；成片会真的裁圆角。
 * 这是预览层的已知边界，用户点「应用边框」后看到的是准确的。
 */
export default function FrameOverlay(props: {
  box: { left: number; top: number; width: number; height: number }
  imageWidth: number
  imageHeight: number
  options: FrameOptions
}) {
  const { box, imageWidth, imageHeight, options } = props
  const f = frameFractions(imageWidth, imageHeight, options)
  const pct = (v: number) => `${v * 100}%`
  const barBg = options.style === 'film'
    ? `repeating-linear-gradient(90deg, ${options.color} 0 76%, #f4f1e8 76% 82%)`
    : options.color
  const side = {
    position: 'absolute' as const,
    background: barBg,
  }
  return (
    <div
      className="frame-preview"
      style={{ left: box.left, top: box.top, width: box.width, height: box.height }}
      aria-hidden="true"
    >
      <div style={{ ...side, left: 0, top: 0, width: '100%', height: pct(f.top) }} />
      <div style={{ ...side, left: 0, bottom: 0, width: '100%', height: pct(f.bottom) }} />
      <div style={{ ...side, left: 0, top: 0, height: '100%', width: pct(f.left) }} />
      <div style={{ ...side, right: 0, top: 0, height: '100%', width: pct(f.right) }} />
      {options.style === 'rounded' && f.radius > 0 && (
        <div
          className="frame-preview-round"
          style={{
            left: pct(f.left), top: pct(f.top),
            right: pct(f.right), bottom: pct(f.bottom),
            borderRadius: f.radius * Math.min(box.width, box.height),
          }}
        />
      )}
    </div>
  )
}
