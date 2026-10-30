import { useState } from 'react'
import type { HistogramData } from '../render/histogram'

/**
 * 调色面板顶部的实时直方图（★ 2026-10-18）。
 *
 * 数据来自 `TonePipeline.readHistogram()`：同一套着色器在 128×128 离屏缓冲
 * 上的渲染结果。三根线是 R / G / B 的归一化分布；下面两行是暗部 / 高光
 * 溢出比例（三通道同时贴边才算）。
 */
const W = 240
const H = 58
const PAD = 2
type ScopeMode = 'histogram' | 'waveform' | 'vectorscope'

const MODES: [ScopeMode, string][] = [
  ['histogram', '直方图'], ['waveform', '波形'], ['vectorscope', '矢量'],
]

const yOf = (value: number) =>
  H - PAD - Math.max(0, Math.min(1, value)) * (H - PAD * 2)

function line(values: number[]): string {
  if (values.length === 0) return ''
  const step = (W - PAD * 2) / Math.max(1, values.length - 1)
  return values.map((v, i) => {
    const x = PAD + i * step
    const y = yOf(v)
    return `${i === 0 ? 'M' : 'L'}${x.toFixed(2)},${y.toFixed(2)}`
  }).join(' ')
}

function waveLine(
  rows: HistogramData['waveform'], pick: (row: HistogramData['waveform'][number]) => number,
): string {
  if (rows.length === 0) return ''
  const step = (W - PAD * 2) / Math.max(1, rows.length - 1)
  return rows.map((row, i) => {
    const x = PAD + i * step
    return `${i === 0 ? 'M' : 'L'}${x.toFixed(2)},${yOf(pick(row)).toFixed(2)}`
  }).join(' ')
}

function waveBand(rows: HistogramData['waveform']): string {
  if (rows.length === 0) return ''
  const step = (W - PAD * 2) / Math.max(1, rows.length - 1)
  const top = rows.map((row, i) =>
    `${i === 0 ? 'M' : 'L'}${(PAD + i * step).toFixed(2)},${yOf(row.high).toFixed(2)}`).join(' ')
  const bottom = [...rows].reverse().map((row, i) => {
    const index = rows.length - 1 - i
    return `L${(PAD + index * step).toFixed(2)},${yOf(row.low).toFixed(2)}`
  }).join(' ')
  return `${top} ${bottom} Z`
}

const pct = (v: number) => `${(v * 100).toFixed(1)}%`

export default function Histogram({ data }: { data?: HistogramData | null }) {
  const [mode, setMode] = useState<ScopeMode>('histogram')
  const has = !!data && data.r.length > 0
  const hasWave = !!data && data.waveform.length > 0
  const hasVector = !!data && data.vectorscope.length > 0
  const title = mode === 'histogram' ? 'RGB 直方图'
    : mode === 'waveform' ? '亮度波形' : '矢量示波器'
  return (
    <figure className="histogram" aria-label="直方图">
      <div className="scope-modes" role="group" aria-label="示波器模式">
        {MODES.map(([value, name]) => (
          <button
            key={value} type="button"
            className={`scope-mode${mode === value ? ' on' : ''}`}
            aria-pressed={mode === value}
            onClick={() => setMode(value)}
          >{name}</button>
        ))}
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={title}>
        <title>{title}</title>
        <line className="histogram-baseline" x1={PAD} y1={H - PAD} x2={W - PAD} y2={H - PAD} />
        {has && mode === 'histogram' && (
          <>
            <path className="histogram-path histogram-r" d={line(data!.r)} />
            <path className="histogram-path histogram-g" d={line(data!.g)} />
            <path className="histogram-path histogram-b" d={line(data!.b)} />
          </>
        )}
        {has && mode === 'waveform' && hasWave && (
          <>
            <path className="scope-wave-band" d={waveBand(data!.waveform)} />
            <path className="scope-wave-mid" d={waveLine(data!.waveform, row => row.mid)} />
          </>
        )}
        {has && mode === 'vectorscope' && hasVector && (
          <>
            <line className="scope-axis" x1={W / 2} y1={PAD} x2={W / 2} y2={H - PAD} />
            <line className="scope-axis" x1={PAD} y1={H / 2} x2={W - PAD} y2={H / 2} />
            {data!.vectorscope.map((point, index) => (
              <circle
                key={index}
                className="scope-vector-point"
                cx={PAD + point.x * (W - PAD * 2)}
                cy={PAD + (1 - point.y) * (H - PAD * 2)}
                r={0.8 + point.density * 2.2}
                opacity={0.18 + point.density * 0.7}
              />
            ))}
          </>
        )}
        {!has && (
          <text className="histogram-empty" x={W / 2} y={H / 2} textAnchor="middle">
            等画面画完…
          </text>
        )}
        {has && mode === 'waveform' && !hasWave && (
          <text className="histogram-empty" x={W / 2} y={H / 2} textAnchor="middle">
            等画面画完…
          </text>
        )}
      </svg>
      <div className="histogram-legend">
        <span className={data && data.shadowClip > 0.005 ? 'histogram-clip on' : 'histogram-clip'}>
          暗部 {data ? pct(data.shadowClip) : '—'}
        </span>
        <span className={data && data.highlightClip > 0.005 ? 'histogram-clip on' : 'histogram-clip'}>
          高光 {data ? pct(data.highlightClip) : '—'}
        </span>
        <span className="scope-note">
          {mode === 'histogram' ? 'RGB' : mode === 'waveform' ? '亮度分布' : '中心 = 中性'}
        </span>
      </div>
    </figure>
  )
}
