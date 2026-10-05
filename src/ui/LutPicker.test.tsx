// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, expect, it } from 'vitest'
import LutPicker from './LutPicker.tsx'
import type { LutMeta } from '../../shared/lut.ts'

// ⚠️ 挂载方式照 `src/ui/kit/kit.test.tsx` 那个 `mount`（act 从 'react' 进，
//    不用 react-dom/test-utils，也不引 @testing-library —— 这个仓库零新增依赖）
async function mount(node: React.ReactNode) {
  const container = document.createElement('div')
  document.body.appendChild(container)
  await act(async () => { createRoot(container).render(node) })
  return container
}

const LUTS: LutMeta[] = [
  { id: 1, name: '黄昏', size: 2, bytes: 100, createdAt: 0 },
  { id: 2, name: '黑白', size: 2, bytes: 100, createdAt: 0 },
]
const noop = () => {}

describe('滤镜格子', () => {
  it('每格一个按钮，第一格是「不用」；选中的那格 aria-pressed', async () => {
    const c = await mount(<LutPicker luts={LUTS} value={{ lutId: 2, amount: 80 }}
      thumbs={{ 1: 'data:,a', 2: 'data:,b' }} noneThumb="data:,n"
      onPick={noop} onAmount={noop} onGoImport={noop} />)
    const tiles = [...c.querySelectorAll('.lut-tile')]
    expect(tiles.map((t) => t.textContent)).toEqual(['不用', '黄昏', '黑白'])
    expect(tiles[0]!.getAttribute('aria-pressed')).toBe('false')
    expect(tiles[2]!.getAttribute('aria-pressed')).toBe('true')
  })

  it('没缩略图时画占位（不画空 img）', async () => {
    const c = await mount(<LutPicker luts={LUTS} value={null} thumbs={{}}
      noneThumb={null} onPick={noop} onAmount={noop} onGoImport={noop} />)
    expect(c.querySelectorAll('.lut-tile img')).toHaveLength(0)
  })

  it('强度滑块只在选中时出现；点「不用」回调 null', async () => {
    let picked: number | null | undefined
    const c = await mount(<LutPicker luts={LUTS} value={{ lutId: 1, amount: 60 }} thumbs={{}}
      noneThumb={null} onPick={(id) => { picked = id }} onAmount={noop} onGoImport={noop} />)
    expect(c.querySelector('input[type="range"]')).not.toBeNull()
    await act(async () => { (c.querySelectorAll('.lut-tile')[0] as HTMLButtonElement).click() })
    expect(picked).toBeNull()
  })

  it('没选中时没有强度滑块', async () => {
    const c = await mount(<LutPicker luts={LUTS} value={null} thumbs={{}}
      noneThumb={null} onPick={noop} onAmount={noop} onGoImport={noop} />)
    expect(c.querySelector('input[type="range"]')).toBeNull()
  })

  it('一个滤镜都没有：一句话 + 一颗「去导入」', async () => {
    let went = false
    const c = await mount(<LutPicker luts={[]} value={null} thumbs={{}} noneThumb={null}
      onPick={noop} onAmount={noop} onGoImport={() => { went = true }} />)
    expect(c.textContent).toContain('还没有导入过滤镜')
    await act(async () => { (c.querySelector('button') as HTMLButtonElement).click() })
    expect(went).toBe(true)
  })
})
