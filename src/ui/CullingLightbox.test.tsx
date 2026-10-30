// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { WorkMeta } from '../../shared/works.ts'
import CullingLightbox from './CullingLightbox'

const work = (id: number, name: string, rating = 0): WorkMeta => ({
  id,
  alias: name,
  createdAt: id,
  updatedAt: id,
  bytes: 0,
  hasThumb: false,
  rating,
  flag: 0,
})

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

async function mount(index = 0) {
  const works = [work(1, '甲', 2), work(2, '乙', 4), work(3, '丙')]
  const onIndex = vi.fn()
  const onRate = vi.fn()
  const onFlag = vi.fn()
  const onColor = vi.fn()
  const onOpen = vi.fn()
  const onClose = vi.fn()
  await act(async () => {
    root.render(
      <CullingLightbox
        works={works}
        index={index}
        now={0}
        onIndex={onIndex}
        onRate={onRate}
        onFlag={onFlag}
        onColor={onColor}
        onOpen={onOpen}
        onClose={onClose}
      />,
    )
  })
  return { works, onIndex, onRate, onFlag, onColor, onOpen, onClose }
}

const key = (value: string) => act(async () => {
  window.dispatchEvent(new KeyboardEvent('keydown', { key: value, bubbles: true }))
})

describe('CullingLightbox', () => {
  it('方向键切上一张 / 下一张，并给出当前序列位置', async () => {
    const c = await mount(1)
    expect(container.textContent).toContain('乙')
    expect(container.textContent).toContain('2 / 3')
    await key('ArrowLeft')
    await key('ArrowRight')
    expect(c.onIndex.mock.calls).toEqual([[0], [2]])
  })

  it('0–5 直接评分，E 打开编辑，Esc 关闭', async () => {
    const c = await mount(0)
    await key('5')
    await key('0')
    await key('p')
    await key('x')
    await key('u')
    await key('6')
    await key('e')
    await key('Escape')
    expect(c.onRate.mock.calls).toEqual([[c.works[0], 5], [c.works[0], 0]])
    expect(c.onFlag.mock.calls).toEqual([[c.works[0], 1], [c.works[0], -1], [c.works[0], 0]])
    expect(c.onColor).toHaveBeenCalledWith(c.works[0], 'red')
    expect(c.onOpen).toHaveBeenCalledWith(1)
    expect(c.onClose).toHaveBeenCalledTimes(1)
  })

  it('颜色标签按钮设置，再点同一色清除', async () => {
    const c = await mount(0)
    const red = container.querySelector('[aria-label="标红色"]') as HTMLButtonElement
    expect(red).toBeTruthy()
    await act(async () => { red.click() })
    expect(c.onColor).toHaveBeenLastCalledWith(c.works[0], 'red')

    const next = [c.works[0]!, c.works[1]!, c.works[2]!]
    next[0] = { ...next[0]!, color: 'red' }
    await act(async () => {
      root.render(
        <CullingLightbox
          works={next}
          index={0}
          now={0}
          onIndex={c.onIndex}
          onRate={c.onRate}
          onFlag={c.onFlag}
          onColor={c.onColor}
          onOpen={c.onOpen}
          onClose={c.onClose}
        />,
      )
    })
    const active = container.querySelector('[aria-label="标红色"]') as HTMLButtonElement
    expect(active.getAttribute('aria-pressed')).toBe('true')
    await act(async () => { active.click() })
    expect(c.onColor).toHaveBeenLastCalledWith(next[0], 'none')
  })

  it('输入框里的 0–5 不抢评分快捷键', async () => {
    const c = await mount(0)
    const input = document.createElement('input')
    document.body.appendChild(input)
    input.focus()
    input.dispatchEvent(new KeyboardEvent('keydown', { key: '5', bubbles: true }))
    expect(c.onRate).not.toHaveBeenCalled()
    input.remove()
  })

  it('Z 键与双击都在适应窗口 / 1:1 之间切换', async () => {
    await mount(0)
    const stage = () => container.querySelector('.cull-stage') as HTMLElement
    expect(stage().classList.contains('zoomed')).toBe(false)
    await key('z')
    expect(stage().classList.contains('zoomed')).toBe(true)
    expect(container.querySelector('.cull-zoom')?.textContent).toBe('适应')
    await act(async () => {
      stage().dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
    })
    expect(stage().classList.contains('zoomed')).toBe(false)
    expect(container.querySelector('.cull-zoom')?.textContent).toBe('1:1')
  })

  it('C 进入对比，分割线和 [ / ] 换对比图', async () => {
    await mount(0)
    await key('c')
    expect(container.querySelector('.cull-compare')).toBeTruthy()
    const compareImages = [...container.querySelectorAll('.cull-compare img')] as HTMLImageElement[]
    expect(compareImages).toHaveLength(2)
    const split = container.querySelector('.cull-compare-split') as HTMLInputElement
    expect(split.value).toBe('50')
    const before = compareImages[1]!.getAttribute('src')

    await key(']')
    const after = [...container.querySelectorAll('.cull-compare img')][1]!.getAttribute('src')
    expect(after).not.toBe(before)

    const splitNow = container.querySelector('.cull-compare-split') as HTMLInputElement
    const splitSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
    await act(async () => {
      splitSetter.call(splitNow, '25')
      splitNow.dispatchEvent(new Event('input', { bubbles: true }))
      splitNow.dispatchEvent(new Event('change', { bubbles: true }))
    })
    expect(splitNow.value).toBe('25')
    await key('c')
    expect(container.querySelector('.cull-compare')).toBeNull()
  })
})
