// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, expect, it } from 'vitest'
import Histogram from './Histogram'
import type { HistogramData } from '../render/histogram'

async function mount(node: React.ReactNode) {
  const container = document.createElement('div')
  document.body.appendChild(container)
  await act(async () => { createRoot(container).render(node) })
  return container
}

const data: HistogramData = {
  r: [0, 0.4, 1, 0.2],
  g: [0.1, 0.7, 0.5, 0],
  b: [0.2, 0.1, 0.8, 0.1],
  waveform: [
    { low: 0.1, mid: 0.35, high: 0.6 },
    { low: 0.3, mid: 0.55, high: 0.9 },
    { low: 0.2, mid: 0.5, high: 0.8 },
  ],
  vectorscope: [
    { x: 0.5, y: 0.5, density: 1 },
    { x: 0.62, y: 0.44, density: 0.5 },
  ],
  shadowClip: 0.012,
  highlightClip: 0.004,
}

describe('Histogram', () => {
  it('三条通道各画一条线，暗部 / 高光溢出有读数', async () => {
    const c = await mount(<Histogram data={data} />)
    expect(c.querySelectorAll('.histogram-path')).toHaveLength(3)
    expect(c.querySelector('.histogram-r')?.getAttribute('d')).toContain('L')
    expect(c.textContent).toContain('暗部 1.2%')
    expect(c.textContent).toContain('高光 0.4%')
    expect(c.querySelectorAll('.histogram-clip.on')).toHaveLength(1)
  })

  it('可切到亮度波形和矢量示波器', async () => {
    const c = await mount(<Histogram data={data} />)
    const wave = [...c.querySelectorAll('button')]
      .find(button => button.textContent?.trim() === '波形') as HTMLButtonElement
    await act(async () => { wave.click() })
    expect(c.querySelectorAll('.histogram-path')).toHaveLength(0)
    expect(c.querySelector('.scope-wave-band')?.getAttribute('d')).toContain('Z')
    expect(c.querySelector('.scope-wave-mid')?.getAttribute('d')).toContain('L')
    expect(c.querySelector('svg')?.getAttribute('aria-label')).toBe('亮度波形')

    const vector = [...c.querySelectorAll('button')]
      .find(button => button.textContent?.trim() === '矢量') as HTMLButtonElement
    await act(async () => { vector.click() })
    expect(c.querySelectorAll('.scope-axis')).toHaveLength(2)
    expect(c.querySelectorAll('.scope-vector-point')).toHaveLength(2)
    expect(c.textContent).toContain('中心 = 中性')
  })

  it('还没有数据时不画假线，给一句等待', async () => {
    const c = await mount(<Histogram data={null} />)
    expect(c.querySelectorAll('.histogram-path')).toHaveLength(0)
    expect(c.textContent).toContain('等画面画完…')
  })
})
