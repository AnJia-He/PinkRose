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
import { Field, TextInput } from './Field.tsx'
import { LoginPage } from '../LoginPage.tsx'

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

describe('<Field>：一格表单的三条约定', () => {
  it('label 用 for 指向输入框 —— 点字能聚焦到框', async () => {
    const c = await mount(
      <Field className="demo-field" label="名字" hint="两到二十个字">
        <TextInput name="who" defaultValue="" />
      </Field>,
    )
    const input = c.querySelector('input') as HTMLInputElement
    const label = c.querySelector('label') as HTMLLabelElement
    expect(label.getAttribute('for')).toBe(input.id)
    expect(input.id).toBeTruthy()
  })

  it('注解用 aria-describedby 挂在输入框上 —— 读屏的人会念到它', async () => {
    const c = await mount(
      <Field className="demo-field" label="名字" hint="两到二十个字">
        <TextInput name="who" defaultValue="" />
      </Field>,
    )
    const input = c.querySelector('input') as HTMLInputElement
    const hint = c.querySelector('p') as HTMLParagraphElement
    expect(hint.textContent).toBe('两到二十个字')
    expect(input.getAttribute('aria-describedby')).toBe(hint.id)
  })

  it('我们给的类名落在最外层 —— 测试和 CSS 都按它认人', async () => {
    const c = await mount(
      <Field className="demo-field" label="名字">
        <TextInput name="who" defaultValue="" />
      </Field>,
    )
    const box = c.querySelector('.demo-field') as HTMLElement
    expect(box).toBeTruthy()
    expect(box.querySelector('input')).toBeTruthy()
  })
})

describe('登录页三格换过来之后', () => {
  it('每一格都是 for/id 显式配对（不是靠"把输入框包进 label"隐式关联）', async () => {
    const c = await mount(<LoginPage onDone={async () => {}} />)
    for (const name of ['username', 'password']) {
      const input = c.querySelector(`.login-field input[name="${name}"]`) as HTMLInputElement
      expect(input, `${name} 那一格还在不在`).toBeTruthy()
      const label = c.querySelector(`.login-field label[for="${input.id}"]`)
      expect(label, `${name} 那一格的 label 有没有用 for 指过去`).toBeTruthy()
    }
  })

  it('密码那一格：眼睛仍然在同一个 .login-pw 里，而且不是 label 的子元素', async () => {
    const c = await mount(<LoginPage onDone={async () => {}} />)
    const eye = c.querySelector('.login-pw .login-eye') as HTMLButtonElement
    expect(eye).toBeTruthy()
    // 按钮是 labelable 元素，包进 label 会污染输入框的可读名字（见 LoginPage 那段注释）
    expect(eye.closest('label')).toBeNull()
    expect(c.querySelector('.login-pw input[name="password"]')).toBeTruthy()
  })
})
