import { useEffect, useState } from 'react'
import type { Adjustments } from '../../shared/adjustments.ts'
import type { Cube } from '../../shared/lut.ts'
import { exportLookCube, LUT_EXPORT_SIZE } from '../export/lutExport'

/**
 * 「当前外观 → .cube」（★ 2026-10-20）。
 *
 * 两段式：先生成、再下载。生成要等 WebGL 把 33³ 色卡跑完，如果直接在同一次
 * 点击里异步下载，Safari 可能把下载当成"不是用户手势"拦掉；拆成第二颗按钮
 * 后，下载那一拍是新鲜手势，苹果端也稳。
 */
type Props = {
  params: Adjustments
  cube: Cube | null
  lutAmount: number
  filenameStem?: string | null
}

type State =
  | { s: 'idle' }
  | { s: 'working' }
  | { s: 'ready'; blob: Blob; name: string }
  | { s: 'error'; message: string }

function stemOf(value: string | null | undefined): string {
  const base = (value ?? '').replace(/^.*[\\/]/, '').replace(/\.[^.]+$/, '').trim()
  return (base || 'pinkrose')
    .replace(/[\\/:*?"<>|]+/g, '-')
    .replace(/\s+/g, ' ')
    .slice(0, 60)
}

export default function LutExporter({ params, cube, lutAmount, filenameStem }: Props) {
  const [state, setState] = useState<State>({ s: 'idle' })
  // 参数、当前 Lut 或强度一变，旧 blob 就不再代表"当前外观"。
  const signature = JSON.stringify([params, cube?.title ?? '', cube?.size ?? 0, lutAmount])
  useEffect(() => { setState({ s: 'idle' }) }, [signature])

  const generate = async () => {
    if (state.s === 'working') return
    setState({ s: 'working' })
    try {
      const text = await exportLookCube(params, cube, lutAmount, 'PinkRose look', LUT_EXPORT_SIZE)
      setState({
        s: 'ready',
        blob: new Blob([text], { type: 'text/plain' }),
        name: `${stemOf(filenameStem)}-look.cube`,
      })
    } catch (error) {
      console.error('LUT 生成失败', error)
      setState({ s: 'error', message: '这台浏览器没生成出 LUT；换 Chrome / Safari 再试一次。' })
    }
  }

  const download = () => {
    if (state.s !== 'ready') return
    const url = URL.createObjectURL(state.blob)
    const a = document.createElement('a')
    a.href = url
    a.download = state.name
    a.rel = 'noopener'
    a.click()
    setTimeout(() => URL.revokeObjectURL(url), 1_000)
  }

  return (
    <div className="look-export">
      <div className="look-export-head">
        <span className="look-export-title">导出当前外观</span>
        <span className="look-export-note">.cube · 33³</span>
      </div>
      <p className="look-export-hint">
        颜色、曲线、HSL、分离色调和当前 Lut 会烘焙；局部、镜头、美颜和空间效果不进 LUT。
      </p>
      <div className="look-export-actions">
        {state.s === 'ready' ? (
          <>
            <button type="button" className="crop-chip" onClick={generate}>重新生成</button>
            <button type="button" className="crop-chip" onClick={download}>下载 .cube</button>
          </>
        ) : (
          <button
            type="button"
            className="crop-chip"
            disabled={state.s === 'working'}
            onClick={() => void generate()}
          >{state.s === 'working' ? '正在生成…' : state.s === 'error' ? '再试一次' : '生成 .cube'}</button>
        )}
        {state.s === 'ready' && (
          <span className="look-export-note">
            {Math.max(1, Math.round(state.blob.size / 1024))} KB
          </span>
        )}
      </div>
      {state.s === 'error' && <p className="look-export-error" role="alert">{state.message}</p>}
    </div>
  )
}
