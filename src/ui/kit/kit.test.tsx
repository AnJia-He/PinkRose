// @vitest-environment jsdom
/**
 * 零件库（`src/ui/kit/`）自己的测试。
 *
 * 这一层和 App 级那 96 条分工不同：那些测"用户能看见的行为"，
 * 这一层测**零件之间的约定** —— 一个零件被换掉时，谁先红。
 *
 * 头两条是**环境探针**，不是功能测试：Base UI 在我们的 jsdom 里跑得起来吗、
 * 图标吃不吃当前字色。它们红的时候，后面所有零件的红都没意义 ——
 * 先修环境。
 */
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, expect, it } from 'vitest'
import { Slider } from '@base-ui-components/react/slider'
import { User } from 'lucide-react'

async function mount(node: React.ReactNode) {
  const container = document.createElement('div')
  document.body.appendChild(container)
  await act(async () => { createRoot(container).render(node) })
  return container
}

describe('零件库的地基', () => {
  it('Base UI 的滑块在我们这套 jsdom 里渲染得出原生 range（键盘/读屏都挂在它身上）', async () => {
    const c = await mount(
      <Slider.Root defaultValue={20} min={-50} max={50} aria-label="亮度">
        <Slider.Control><Slider.Track><Slider.Indicator /></Slider.Track><Slider.Thumb /></Slider.Control>
      </Slider.Root>,
    )
    const input = c.querySelector('input[type="range"]') as HTMLInputElement
    expect(input).toBeTruthy()
    expect(input.getAttribute('aria-valuenow')).toBe('20')
  })

  it('lucide 图标吃当前字色（stroke=currentColor）—— 不然换主题时它们不会跟着变色', async () => {
    const c = await mount(<User size={16} />)
    const svg = c.querySelector('svg')!
    expect(svg.getAttribute('stroke')).toBe('currentColor')
  })
})
