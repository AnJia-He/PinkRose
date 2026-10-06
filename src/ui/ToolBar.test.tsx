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

  it('★ 没有 children 就不画第二行（「对比」是个开关，没有自己的控件）', async () => {
    // ★ 2026-10-06（对比）：空着的第二行不是"什么都不占" —— 它有自己的内边距和
    //   一道线（约 37px），而它坐在照片上方：**开着对比时照片会整张跳一下**。
    //   那正好打在"放大着比细节"这个用法上（spec §3.3），所以没有控件就不画。
    await act(async () => { root.render(<ToolBar active="compare" onPick={() => {}} />) })
    expect(container.querySelector('.tool-row-second'), '没有 children 就不该有第二行').toBeNull()
  })
})
