// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ZERO } from '../../shared/adjustments.ts'
import { useLuts } from './useLuts.ts'
import { usePresets } from './usePresets.ts'

let container: HTMLDivElement
let root: Root

function Probe({ enabled }: { enabled: boolean }) {
  const luts = useLuts({ lut: null, image: null, params: ZERO, enabled })
  const presets = usePresets(enabled)
  return (
    <pre data-testid="state">{JSON.stringify({
      luts: luts.luts.length,
      lutsKnown: luts.lutsKnown,
      presets: presets.presets.length,
      presetsKnown: presets.known,
    })}</pre>
  )
}

const state = () => JSON.parse(container.querySelector('pre')!.textContent!) as {
  luts: number; lutsKnown: boolean; presets: number; presetsKnown: boolean
}

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
})

describe('个人资产清单的登录门', () => {
  it('未登录不请求 Lut / 预设；登录后拉一次；退出后清空', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.endsWith('/api/luts')) {
        return new Response(JSON.stringify({
          luts: [{ id: 1, name: '暖色', size: 2, createdAt: 0 }],
        }), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      if (url.endsWith('/api/presets')) {
        return new Response(JSON.stringify({
          presets: [{ id: 1, name: '我的', createdAt: 0 }],
        }), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      throw new Error(`unexpected ${url}`)
    })
    vi.stubGlobal('fetch', fetchMock)

    const render = async (enabled: boolean) => {
      await act(async () => {
        root.render(<Probe enabled={enabled} />)
        await new Promise(resolve => setTimeout(resolve, 0))
      })
    }

    await render(false)
    expect(fetchMock).not.toHaveBeenCalled()
    expect(state()).toEqual({ luts: 0, lutsKnown: false, presets: 0, presetsKnown: false })

    await render(true)
    expect(fetchMock.mock.calls.filter(([url]) => String(url).endsWith('/api/luts'))).toHaveLength(1)
    expect(fetchMock.mock.calls.filter(([url]) => String(url).endsWith('/api/presets'))).toHaveLength(1)
    expect(state()).toEqual({ luts: 1, lutsKnown: true, presets: 1, presetsKnown: true })

    await render(false)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(state()).toEqual({ luts: 0, lutsKnown: false, presets: 0, presetsKnown: false })
  })
})
