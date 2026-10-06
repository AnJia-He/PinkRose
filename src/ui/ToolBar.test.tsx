// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import ToolBar from './ToolBar'

let container: HTMLDivElement
let root: Root
beforeEach(() => {
  container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container)
})
afterEach(() => { act(() => root.unmount()); container.remove() })

const pick = async (label: string) => {
  const el = container.querySelector(`[aria-label="${label}"]`) as HTMLButtonElement
  await act(async () => { el.click() })
}

describe('工具行', () => {
  it('两个格子；点一下告诉上层，再点一下收回', async () => {
    const seen: (string | null)[] = []
    await act(async () => { root.render(<ToolBar active={null} onPick={t => seen.push(t)} />) })
    expect(container.querySelectorAll('.tool-cell')).toHaveLength(2)
    await pick('裁剪')
    await pick('对比')
    expect(seen).toEqual(['crop', 'compare'])
  })

  it('★ 开着工具时，第二行才出现；点当前工具是"收回"（传 null）', async () => {
    const seen: (string | null)[] = []
    const draw = (active: 'crop' | null) => act(async () => {
      root.render(<ToolBar active={active} onPick={t => seen.push(t)}>
        <span className="probe">第二行</span>
      </ToolBar>)
    })
    await draw(null)
    expect(container.querySelector('.probe')).toBeNull()      // 没开工具：第二行不在
    await draw('crop')
    expect(container.querySelector('.probe')).toBeTruthy()    // 开着：在
    await pick('裁剪')                                        // 再点一下当前那颗 = 收回
    expect(seen).toEqual([null])
  })
})
