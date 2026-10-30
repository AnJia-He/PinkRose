// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import CropControls from './CropControls'

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

function renderControls(
  onPickAspect: (value: number | null) => void,
  extra: { onSmartCompose?: () => void; smartComposing?: boolean } = {},
) {
  return act(async () => {
    root.render(
      <CropControls
        image={{ width: 1200, height: 800 }}
        spec={{ rect: { x: 0, y: 0, w: 1, h: 1 }, angle: 0 }}
        turns={0}
        aspect={null}
        grid={false}
        onPickAspect={onPickAspect}
        onSmartCompose={extra.onSmartCompose}
        smartComposing={extra.smartComposing}
        onFlip={() => {}}
        onGrid={() => {}}
        onTurns={() => {}}
        onCancel={() => {}}
        onDone={() => {}}
      />,
    )
  })
}

const button = (text: string) => [...container.querySelectorAll('button')]
  .find(b => (b.textContent ?? '').trim() === text) as HTMLButtonElement

const setNumber = async (label: string, value: string) => {
  const input = container.querySelector(`[aria-label="${label}"]`) as HTMLInputElement
  expect(input, `缺输入框：${label}`).toBeTruthy()
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
  await act(async () => {
    setter.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

describe('裁剪比例', () => {
  it('补齐竖版社交比例，并让自定义宽高参与裁剪', async () => {
    const picked: (number | null)[] = []
    await renderControls(v => picked.push(v))

    act(() => button('4:5').click())
    expect(picked.at(-1)).toBeCloseTo(4 / 5, 10)
    act(() => button('9:16').click())
    expect(picked.at(-1)).toBeCloseTo(9 / 16, 10)
    act(() => button('3:2').click())
    expect(picked.at(-1)).toBeCloseTo(3 / 2, 10)

    act(() => button('自定义').click())
    const before = picked.length
    await setNumber('自定义比例宽', '5')
    await setNumber('自定义比例高', '4')
    expect(picked).toHaveLength(before)
    act(() => button('应用比例').click())
    expect(picked.at(-1)).toBeCloseTo(5 / 4, 10)
  })

  it('自定义输入 0 或空值时不把比例打崩', async () => {
    const picked: (number | null)[] = []
    await renderControls(v => picked.push(v))
    act(() => button('1:1').click())
    act(() => button('自定义').click())
    const before = picked.length
    await setNumber('自定义比例宽', '0')
    act(() => button('应用比例').click())
    expect(picked).toHaveLength(before)
  })
})

describe('智能构图', () => {
  it('点「智能构图」只触发构图，不在控件层偷偷改比例或提交', async () => {
    const picked: (number | null)[] = []
    let composed = 0
    await renderControls(v => picked.push(v), { onSmartCompose: () => { composed++ } })

    act(() => button('智能构图').click())
    expect(composed).toBe(1)
    expect(picked).toHaveLength(0)
  })

  it('正在识别主体时按钮禁用并显示进度文字', async () => {
    await renderControls(() => {}, { onSmartCompose: () => {}, smartComposing: true })
    const busy = button('识别中…')
    expect(busy).toBeTruthy()
    expect(busy.disabled).toBe(true)
  })
})
