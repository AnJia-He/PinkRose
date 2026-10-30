// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useLocalLayers } from './useLocalLayers'
import type { DecodedImage } from '../image/decode'
import type { EditLayer } from '../../shared/layers.ts'

const mocks = vi.hoisted(() => ({
  applyLocalLayers: vi.fn(),
  preloadLocalMasks: vi.fn(async () => {}),
  isLocalLayer: (layer: { kind: string }) => layer.kind === 'local',
}))

vi.mock('../image/localLayer', () => mocks)

let container: HTMLDivElement
let root: Root
beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  mocks.applyLocalLayers.mockReset()
  mocks.preloadLocalMasks.mockClear()
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

const raw = { id: 'raw', close: () => {} }
const image = { bitmap: raw, width: 100, height: 100 } as unknown as DecodedImage
const local = {
  kind: 'local' as const,
  id: 'l1',
  mask: 'data:image/png;base64,AA',
  maskWidth: 100,
  maskHeight: 100,
  feather: 0,
  options: { effect: 'tone' as const, exposure: 20 },
}

function Probe({ layers }: { layers: EditLayer[] }) {
  const { effectiveImage, preparing } = useLocalLayers(image, layers)
  return (
    <div
      data-bitmap={(effectiveImage?.bitmap as unknown as { id: string }).id}
      data-preparing={String(preparing)}
    />
  )
}

const bitmapId = () => container.querySelector('div')?.getAttribute('data-bitmap')
const preparing = () => container.querySelector('div')?.getAttribute('data-preparing')

describe('useLocalLayers', () => {
  it('有局部层时用派生图；全部隐藏时撤掉旧派生图、回到干净底图', async () => {
    const derived = { id: 'derived', close: vi.fn() }
    mocks.applyLocalLayers.mockResolvedValueOnce(derived)
    await act(async () => {
      root.render(<Probe layers={[local]} />)
      await new Promise(r => setTimeout(r, 0))
    })
    expect(bitmapId()).toBe('derived')
    expect(preparing()).toBe('false')

    // 换成 hidden 的新对象（和 App 的 toggleLayer 同一个形状）
    mocks.applyLocalLayers.mockResolvedValueOnce(null)
    await act(async () => {
      root.render(<Probe layers={[{ ...local, visible: false }]} />)
      await new Promise(r => setTimeout(r, 0))
    })
    expect(bitmapId(), '全部隐藏后不许继续拿旧派生图').toBe('raw')
    expect(derived.close).toHaveBeenCalledTimes(1)
    expect(preparing()).toBe('false')
  })
})
