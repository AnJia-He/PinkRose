import { useEffect, useRef, useState } from 'react'
import { PARAM_LABELS, RGB_CURVE_CHANNELS, type Adjustments } from '../../shared/adjustments.ts'
import {
  CHANNEL_CURVE_KEYS, CURVE_PRESETS, applyChannelCurvePreset,
  channelCurvePoints, channelCurveValueAt, paramForChannelCurveY, type CurveChannel,
} from '../core/toneCurve'

/**
 * 影调曲线（★ 2026-10-17，2026-10-18 加 RGB 通道）—— 五个控制点的拖点编辑器。
 *
 * RGB 是整体影调；红 / 绿 / 蓝是分通道曲线。横轴是原通道值、
 * 纵轴是调整后通道值。五个点固定在 0 / 25% / 50% / 75% / 100%，
 * 拖动只改纵向；黑场只能上抬、白场只能下压（见 `core/toneCurve.ts`）。
 * 点本身是键盘可到的 `role="slider"`，方向键一次走 2、按住 Shift 走 10。
 *
 * ⚠️ 曲线值始终来自 `value`（受控），组件只留"正在拖第几个点"这个临时状态。
 * ⚠️ 图形和着色器用同一组控制点常量；改这里必须同步 `render/shader.ts` 的
 *   `curveAt()`，否则画出来的线和大图会分家。
 */
const W = 260
const H = 180
const PAD = 10
const TOP = 10
const BOTTOM = 170
const SHORT_LABELS = ['黑场', '阴影', '中间调', '高光', '白场'] as const

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v))
const pointX = (i: number) => PAD + i * (W - PAD * 2) / 4
const pointY = (v: number) => BOTTOM - clamp(v, 0, 1) * (BOTTOM - TOP)

type Props = {
  value: Adjustments
  onChange: (next: Adjustments) => void
}

export default function ToneCurve({ value, onChange }: Props) {
  const svgRef = useRef<SVGSVGElement | null>(null)
  const dragRef = useRef<number | null>(null)
  const [dragging, setDragging] = useState<number | null>(null)
  const [channel, setChannel] = useState<CurveChannel>('rgb')
  const valueRef = useRef(value)
  const changeRef = useRef(onChange)
  valueRef.current = value
  changeRef.current = onChange
  const keys = CHANNEL_CURVE_KEYS[channel]
  const ys = channelCurvePoints(value, channel)
  const channelLabel = channel === 'rgb'
    ? 'RGB'
    : RGB_CURVE_CHANNELS.find(item => item.id === channel)?.label ?? channel

  /**
   * 拖点监听挂在 window 上，和 `StepStrip` 的转盘同一套理由：
   * 指针拖到圆点外面是常态，挂在 SVG 上会中途断掉；pointer capture 在
   * SVG `<g>` 上和 React 的合成事件也不稳（真机探针实测拖不动）。
   */
  useEffect(() => {
    if (dragging === null) return
    const move = (e: PointerEvent) => {
      const i = dragRef.current
      const el = svgRef.current
      if (i === null || !el) return
      const rect = el.getBoundingClientRect()
      const y = (e.clientY - rect.top) * H / rect.height
      const yv = (BOTTOM - y) / (BOTTOM - TOP)
      const key = keys[i]!
      changeRef.current({
        ...valueRef.current,
        [key]: paramForChannelCurveY(channel, i as 0 | 1 | 2 | 3 | 4, yv),
      })
    }
    const end = () => {
      dragRef.current = null
      setDragging(null)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', end)
    window.addEventListener('pointercancel', end)
    return () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', end)
      window.removeEventListener('pointercancel', end)
    }
  }, [dragging, channel, keys])

  const path = (() => {
    const parts: string[] = []
    for (let i = 0; i <= 64; i++) {
      const x = i / 64
      parts.push(`${i === 0 ? 'M' : 'L'}${pointX(x * 4).toFixed(2)},${pointY(channelCurveValueAt(value, channel, x)).toFixed(2)}`)
    }
    return parts.join(' ')
  })()

  const keyInfo = (i: number) => {
    const key = keys[i]!
    return {
      key,
      min: i === 0 ? 0 : -100,
      max: i === 4 ? 0 : 100,
    }
  }

  const resetChannel = (ch: CurveChannel) => {
    const patch: Partial<Adjustments> = {}
    for (const k of CHANNEL_CURVE_KEYS[ch]) patch[k] = 0
    onChange({ ...value, ...patch } as Adjustments)
  }

  const resetAll = () => {
    const patch: Partial<Adjustments> = {}
    for (const k of [...CHANNEL_CURVE_KEYS.rgb, ...CHANNEL_CURVE_KEYS.red,
      ...CHANNEL_CURVE_KEYS.green, ...CHANNEL_CURVE_KEYS.blue]) patch[k] = 0
    onChange({ ...value, ...patch } as Adjustments)
  }

  return (
    <div className="curve">
      <div className="curve-head">
        <span className="curve-note">往上拖变亮，往下拖变暗</span>
        <button type="button" className="curve-reset"
          onClick={() => resetChannel(channel)}>拉直</button>
        <button type="button" className="curve-reset curve-reset-all"
          onClick={resetAll}>全部</button>
      </div>
      <div className="retouch-modes" role="group" aria-label="曲线通道">
        {([
          { id: 'rgb' as const, label: 'RGB' },
          ...RGB_CURVE_CHANNELS,
        ]).map(c => {
          const on = channel === c.id
          return (
            <button
              key={c.id} type="button"
              className={`crop-chip${on ? ' on' : ''}`}
              aria-pressed={on}
              onClick={() => {
                setDragging(null)
                setChannel(c.id)
              }}
            >{c.label}</button>
          )
        })}
      </div>
      <div className="curve-presets" role="group" aria-label={`${channelLabel} 曲线预设`}>
        {CURVE_PRESETS.map(preset => (
          <button
            key={preset.id}
            type="button"
            className="crop-chip"
            onClick={() => onChange(applyChannelCurvePreset(value, channel, preset.id))}
          >
            {preset.label}
          </button>
        ))}
      </div>
      <svg
        ref={svgRef}
        className="curve-svg"
        viewBox={`0 0 ${W} ${H}`}
        role="group"
        aria-label="影调曲线"
      >
        {[0, 0.25, 0.5, 0.75, 1].map(v => (
          <g key={v} className="curve-grid">
            <line x1={pointX(v * 4)} y1={TOP} x2={pointX(v * 4)} y2={BOTTOM} />
            <line x1={PAD} y1={pointY(v)} x2={W - PAD} y2={pointY(v)} />
          </g>
        ))}
        <line className="curve-ref" x1={PAD} y1={BOTTOM} x2={W - PAD} y2={TOP} />
        <path className="curve-path" d={path} />
        {ys.map((y, i) => {
          const info = keyInfo(i)
          const active = dragging === i
          return (
            <g
              key={info.key}
              className={`curve-point${active ? ' on' : ''}`}
              role="slider"
              tabIndex={0}
              aria-label={PARAM_LABELS[info.key]}
              aria-valuemin={info.min}
              aria-valuemax={info.max}
              aria-valuenow={value[info.key]}
              onPointerDown={e => {
                e.preventDefault()
                dragRef.current = i
                setDragging(i)
              }}
              onKeyDown={e => {
                if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return
                e.preventDefault()
                const step = e.shiftKey ? 10 : 2
                const dir = e.key === 'ArrowUp' ? 1 : -1
                const next = clamp(value[info.key] + dir * step, info.min, info.max)
                onChange({ ...value, [info.key]: next })
              }}
            >
              <circle cx={pointX(i)} cy={pointY(y)} r={active ? 7.5 : 6} />
            </g>
          )
        })}
      </svg>
      <div className="curve-values">
        {SHORT_LABELS.map((label, i) => (
          <span key={label} className="curve-value">
            <span className="curve-value-label">{label}</span>
            <span className="curve-value-num">{value[keys[i]!]}</span>
          </span>
        ))}
      </div>
    </div>
  )
}
