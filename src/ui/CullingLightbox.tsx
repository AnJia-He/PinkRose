import { useEffect, useRef, useState } from 'react'
import { ChevronLeft, ChevronRight, X } from 'lucide-react'
import { fullUrl } from '../api/works'
import {
  workName, WORK_COLORS, WORK_COLOR_LABELS, type WorkColor, type WorkMeta,
} from '../../shared/works.ts'
import RatingStars from './RatingStars'

type Props = {
  works: readonly WorkMeta[]
  index: number
  now: number
  onIndex: (index: number) => void
  onRate: (work: WorkMeta, rating: number) => void
  onFlag: (work: WorkMeta, flag: WorkMeta['flag']) => void
  onColor: (work: WorkMeta, color: WorkColor) => void
  onOpen: (id: number) => void
  onClose: () => void
  /** 从图库“对比选中两张”进入时直接打开对比层。 */
  initialCompare?: boolean
}

/**
 * Full-screen culling view. Arrow keys move, 0–5 rate, E opens the editor.
 * The focus stays inside the dialog so culling never leaks keystrokes to the page.
 */
export default function CullingLightbox({
  works, index, now, onIndex, onRate, onFlag, onColor, onOpen, onClose,
  initialCompare = false,
}: Props) {
  const dialogRef = useRef<HTMLDivElement>(null)
  const closeRef = useRef<HTMLButtonElement>(null)
  const stageRef = useRef<HTMLDivElement>(null)
  const [zoomed, setZoomed] = useState(false)
  const [compare, setCompare] = useState(initialCompare)
  const [compareOffset, setCompareOffset] = useState(1)
  const [compareSplit, setCompareSplit] = useState(50)
  const current = works[index]
  const compareWork = works.length > 1
    ? works[(index + compareOffset) % works.length] ?? null
    : null

  const centerStage = () => {
    const stage = stageRef.current
    if (!stage || !zoomed) return
    stage.scrollLeft = (stage.scrollWidth - stage.clientWidth) / 2
    stage.scrollTop = (stage.scrollHeight - stage.clientHeight) / 2
  }

  useEffect(() => {
    if (!zoomed) return
    const frame = requestAnimationFrame(centerStage)
    return () => cancelAnimationFrame(frame)
  }, [zoomed, current?.id])

  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null
    closeRef.current?.focus()
    return () => previous?.focus()
  }, [])

  useEffect(() => {
    if (!current) return
    const onKey = (e: KeyboardEvent) => {
      const target = e.target instanceof Element ? e.target : null
      if (target?.closest('input, textarea, select, [contenteditable="true"]')) return
      if (e.metaKey || e.ctrlKey || e.altKey) return

      if (e.key === 'Escape') {
        e.preventDefault()
        onClose()
      } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
        e.preventDefault()
        if (index > 0) onIndex(index - 1)
      } else if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
        e.preventDefault()
        if (index < works.length - 1) onIndex(index + 1)
      } else if (/^[0-5]$/.test(e.key)) {
        e.preventDefault()
        onRate(current, Number(e.key))
      } else if (/^[6-9]$/.test(e.key)) {
        e.preventDefault()
        const color = ({ '6': 'red', '7': 'yellow', '8': 'green', '9': 'blue' } as const)[
          e.key as '6' | '7' | '8' | '9'
        ]
        onColor(current, (current.color ?? 'none') === color ? 'none' : color)
      } else if (e.key === 'p' || e.key === 'P') {
        e.preventDefault()
        onFlag(current, current.flag === 1 ? 0 : 1)
      } else if (e.key === 'x' || e.key === 'X') {
        e.preventDefault()
        onFlag(current, current.flag === -1 ? 0 : -1)
      } else if (e.key === 'u' || e.key === 'U') {
        e.preventDefault()
        onFlag(current, 0)
      } else if (e.key === 'z' || e.key === 'Z') {
        e.preventDefault()
        setZoomed(value => !value)
      } else if (e.key === 'c' || e.key === 'C') {
        e.preventDefault()
        if (works.length > 1) {
          setCompare(value => !value)
          setZoomed(false)
        }
      } else if (compare && (e.key === '[' || e.key === ']')) {
        e.preventDefault()
        const step = e.key === ']' ? 1 : -1
        setCompareOffset(value => {
          const next = value + step
          if (next <= 0) return works.length - 1
          if (next >= works.length) return 1
          return next
        })
      } else if (e.key === 'e' || e.key === 'E') {
        e.preventDefault()
        onOpen(current.id)
      } else if (e.key === 'Tab') {
        const nodes = [...(dialogRef.current?.querySelectorAll<HTMLElement>(
          'button:not(:disabled), [href], [tabindex]:not([tabindex="-1"])',
        ) ?? [])]
        if (nodes.length === 0) return
        const first = nodes[0]!
        const last = nodes[nodes.length - 1]!
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault()
          last.focus()
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault()
          first.focus()
        }
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [current, index, works.length, compare, onIndex, onRate, onFlag, onColor, onOpen, onClose])

  if (!current) return null
  const name = workName(current, now)

  return (
    <div
      ref={dialogRef}
      className="cull-lightbox"
      role="dialog"
      aria-modal="true"
      aria-label={`全屏看片：${name}`}
      aria-keyshortcuts="ArrowLeft ArrowRight 0 1 2 3 4 5 6 7 8 9 P X U Z C [ ] E Escape"
    >
      <header className="cull-head">
        <div className="cull-title">
          <strong>{name}</strong>
          <span aria-live="polite">{index + 1} / {works.length}</span>
        </div>
        <div className="cull-actions">
          <button
            type="button"
            className={`cull-compare-toggle${compare ? ' on' : ''}`}
            aria-pressed={compare}
            disabled={works.length < 2}
            title={compare ? '关闭对比（C）' : '和下一张对比（C）'}
            onClick={() => {
              setCompare(value => !value)
              setZoomed(false)
            }}
          >
            对比
          </button>
          <button
            type="button"
            className={`cull-zoom${zoomed ? ' on' : ''}`}
            aria-pressed={zoomed}
            title={zoomed ? '适应窗口（Z）' : '查看 1:1 像素（Z）'}
            onClick={() => setZoomed(value => !value)}
          >
            {zoomed ? '适应' : '1:1'}
          </button>
          <button
            ref={closeRef}
            type="button"
            className="cull-close"
            aria-label="关闭全屏看片"
            onClick={onClose}
          >
            <X size={18} strokeWidth={1.5} aria-hidden="true" />
          </button>
        </div>
      </header>

      <button
        type="button"
        className="cull-nav cull-prev"
        aria-label="上一张"
        disabled={index === 0}
        onClick={() => onIndex(index - 1)}
      >
        <ChevronLeft size={26} strokeWidth={1.5} aria-hidden="true" />
      </button>
      <div
        ref={stageRef}
        className={`cull-stage${zoomed ? ' zoomed' : ''}${compare ? ' comparing' : ''}`}
        onDoubleClick={() => { if (!compare) setZoomed(value => !value) }}
      >
        {compare && compareWork ? (
          <div className="cull-compare">
            <img
              className="cull-image cull-compare-base"
              src={fullUrl(current)}
              alt={name}
              draggable={false}
            />
            <div
              className="cull-compare-top"
              style={{ clipPath: `inset(0 0 0 ${compareSplit}%)` }}
            >
              <img
                className="cull-image"
                src={fullUrl(compareWork)}
                alt={workName(compareWork, now)}
                draggable={false}
              />
            </div>
            <span className="cull-compare-label left">{name}</span>
            <span className="cull-compare-label right">{workName(compareWork, now)}</span>
            <input
              className="cull-compare-split"
              type="range"
              min={0}
              max={100}
              value={compareSplit}
              aria-label="对比分割位置"
              onChange={e => setCompareSplit(Number(e.target.value))}
            />
          </div>
        ) : (
          <img
            className="cull-image"
            src={fullUrl(current)}
            alt={name}
            draggable={false}
            onLoad={() => { if (zoomed) requestAnimationFrame(centerStage) }}
          />
        )}
      </div>
      <button
        type="button"
        className="cull-nav cull-next"
        aria-label="下一张"
        disabled={index === works.length - 1}
        onClick={() => onIndex(index + 1)}
      >
        <ChevronRight size={26} strokeWidth={1.5} aria-hidden="true" />
      </button>

      <footer className="cull-foot">
        <div className="cull-rating">
          <RatingStars
            value={current.rating}
            label="当前作品星级"
            onChange={rating => onRate(current, rating)}
          />
          <div className="cull-flags" role="group" aria-label="选片标记">
            <button
              type="button"
              className={`cull-flag pick${current.flag === 1 ? ' on' : ''}`}
              aria-pressed={current.flag === 1}
              title="保留（P）"
              onClick={() => onFlag(current, current.flag === 1 ? 0 : 1)}
            >
              保留
            </button>
            <button
              type="button"
              className={`cull-flag reject${current.flag === -1 ? ' on' : ''}`}
              aria-pressed={current.flag === -1}
              title="排除（X）"
              onClick={() => onFlag(current, current.flag === -1 ? 0 : -1)}
            >
              排除
            </button>
          </div>
          <div className="cull-colors" role="group" aria-label="颜色标签">
            {WORK_COLORS.filter(color => color !== 'none').map(color => {
              const active = (current.color ?? 'none') === color
              return (
                <button
                  key={color}
                  type="button"
                  className={`cull-color color-${color}${active ? ' on' : ''}`}
                  aria-label={`标${WORK_COLOR_LABELS[color]}色`}
                  aria-pressed={active}
                  title={`标${WORK_COLOR_LABELS[color]}色`}
                  onClick={() => onColor(current, active ? 'none' : color)}
                >
                  <span aria-hidden="true" />
                </button>
              )
            })}
            <button
              type="button"
              className="cull-color-clear"
              disabled={(current.color ?? 'none') === 'none'}
              onClick={() => onColor(current, 'none')}
            >清除</button>
          </div>
          <span className="cull-hint">← → 切换 · 0–5 评分 · 6–9 色标 · P/X 标记 · C 对比 · Z 1:1 · E 编辑</span>
        </div>
        <button type="button" className="cull-edit" onClick={() => onOpen(current.id)}>
          打开编辑
        </button>
      </footer>
    </div>
  )
}
