// @vitest-environment jsdom
/**
 * `kit/Slider` 的三件套（2026-10-04，「调色」专业面板那一轮）：
 * **双击复零 / 点数字改值 / 渐变轨**。
 *
 * ⚠️ 驱动方式和 `kit.test.tsx` 同款（`createRoot` + `act`），**不是**
 * `@testing-library/react` —— 这个项目没有那个依赖（零新增依赖是规矩）。
 * 三条手法各自有一个助手，坑写在各自的注释里，改测试之前先读那几段：
 * 双击/单击靠 `dispatchEvent` 冒泡到 React 根、打字靠原型上的 value setter
 * 绕 React 的 tracker。少了任何一条，表现都是**不报错、只是没反应**。
 */
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, expect, it, vi } from 'vitest'
import { Slider } from './Slider.tsx'

async function mount(node: React.ReactNode) {
  const container = document.createElement('div')
  document.body.appendChild(container)
  await act(async () => { createRoot(container).render(node) })
  return container
}

/** 派一个事件 + 让 React 把状态刷完（`setTimeout(0)` 和 kit.test.tsx 里那一招同款）。 */
async function fire(el: Element, event: Event) {
  await act(async () => {
    el.dispatchEvent(event)
    await new Promise(r => setTimeout(r, 0))
  })
}

const click = (el: Element) => fire(el, new MouseEvent('click', { bubbles: true }))
/** 双击走**原生 dblclick**（React 的 `onDoubleClick` 就是它），bubbles 不能少。 */
const dblclick = (el: Element) => fire(el, new MouseEvent('dblclick', { bubbles: true }))
const key = (el: Element, k: string) => fire(el, new KeyboardEvent('keydown', { key: k, bubbles: true }))

/** 往受控输入框里打字：直接写 `el.value` 会被 React 的 tracker 当成"没变"而吞掉，
 *  得用**原型上的 setter** 绕过去再派一个 `input`（`App.test.tsx` 的 `type()` 同款）。 */
async function type(el: HTMLInputElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(el, value)
    el.dispatchEvent(new Event('input', { bubbles: true }))
    await new Promise(r => setTimeout(r, 0))
  })
}

describe('Slider 三件套', () => {
  it('双击滑块本体 → onChange(neutral)（默认 0）', async () => {
    const onChange = vi.fn()
    const c = await mount(<Slider label="亮度" value={30} min={-100} max={100} onChange={onChange} />)
    await dblclick(c.querySelector('.slider-control')!)
    expect(onChange).toHaveBeenCalledWith(0)
  })

  it('双击 → 回到传进来的 neutral（色相带这类用得上）', async () => {
    const onChange = vi.fn()
    const c = await mount(
      <Slider label="亮部颜色" value={180} min={0} max={360} neutral={30} onChange={onChange} />)
    await dblclick(c.querySelector('.slider-control')!)
    expect(onChange).toHaveBeenCalledWith(30)
  })

  it('点数字 → 输入 42 回车 → onChange(42)', async () => {
    const onChange = vi.fn()
    const c = await mount(<Slider label="亮度" value={0} min={-100} max={100} onChange={onChange} />)
    await click(c.querySelector('.slider-value')!)
    const input = c.querySelector('input.slider-edit') as HTMLInputElement
    expect(input).toBeTruthy()
    await type(input, '42')
    await key(input, 'Enter')
    expect(onChange).toHaveBeenCalledWith(42)
  })

  it('超范围钳到边界；非法输入当取消（不调 onChange）', async () => {
    const onChange = vi.fn()
    const c = await mount(<Slider label="亮度" value={0} min={-100} max={100} onChange={onChange} />)
    await click(c.querySelector('.slider-value')!)
    let input = c.querySelector('input.slider-edit') as HTMLInputElement
    await type(input, '999')
    await key(input, 'Enter')
    expect(onChange).toHaveBeenLastCalledWith(100)
    await click(c.querySelector('.slider-value')!)
    input = c.querySelector('input.slider-edit') as HTMLInputElement
    await type(input, 'abc')
    await key(input, 'Enter')
    expect(onChange).toHaveBeenCalledTimes(1)   // 只有上面那次
  })

  it('Esc 取消，不改值', async () => {
    const onChange = vi.fn()
    const c = await mount(<Slider label="亮度" value={0} min={-100} max={100} onChange={onChange} />)
    await click(c.querySelector('.slider-value')!)
    const input = c.querySelector('input.slider-edit') as HTMLInputElement
    await type(input, '55')
    await key(input, 'Escape')
    expect(onChange).not.toHaveBeenCalled()
  })

  it('gradient 传到轨道上（渐变轨靠它）', async () => {
    const c = await mount(
      <Slider label="色温" value={0} min={-100} max={100} gradient="linear-gradient(90deg,#00f,#ff0)" onChange={() => {}} />)
    const track = c.querySelector('.slider-track') as HTMLElement
    expect(track.getAttribute('style') ?? '').toContain('linear-gradient')
  })
})

/* ⚠️ 下面这几条是自查时补的（上面六条来自计划，一个字没动）：
   计划正文写明的两条硬约束没有对应的钉子 —— 补上，免得下一个人把它们挪走。 */
describe('Slider 三件套 · 约束的钉子', () => {
  it('gradient 给了就**不画填充段**（它和渐变叠在一起，读出来的颜色是错的）', async () => {
    const c = await mount(
      <Slider label="色温" value={0} min={-100} max={100} gradient="linear-gradient(90deg,#00f,#ff0)" onChange={() => {}} />)
    expect(c.querySelector('.slider-indicator')).toBeNull()
    // 对照：不给渐变时填充段照常在（不然上面那条可能只是"整个组件都没画"）
    const plain = await mount(<Slider label="亮度" value={0} min={-100} max={100} onChange={() => {}} />)
    expect(plain.querySelector('.slider-indicator')).toBeTruthy()
  })

  it('双击复零挂在 `.slider-control` 上，不是最外层 label —— 双击数字那格不该顺带回零', async () => {
    const onChange = vi.fn()
    const c = await mount(<Slider label="亮度" value={30} min={-100} max={100} onChange={onChange} />)
    await dblclick(c.querySelector('.slider-value')!)
    expect(onChange).not.toHaveBeenCalled()
  })

  it('失焦也算提交（点了别处，这笔输入不该丢）', async () => {
    const onChange = vi.fn()
    const c = await mount(<Slider label="亮度" value={0} min={-100} max={100} onChange={onChange} />)
    await click(c.querySelector('.slider-value')!)
    const input = c.querySelector('input.slider-edit') as HTMLInputElement
    await type(input, '42')
    // ⚠️ React 17 起 `onBlur` 走的是原生的 **focusout**（它才冒泡），派 `blur` 收不到
    await fire(input, new FocusEvent('focusout', { bubbles: true }))
    expect(onChange).toHaveBeenCalledWith(42)
  })

  /* ⚠️ 下面这条钉的是**真浏览器里才看得见**的那场事故（2026-10-04 实测）：
     数字住在一个 `<label>` 里，点它等于点标签 —— 浏览器的默认行为会把焦点
     交给标签的控件（藏在拇指里的 range）。编辑框是点下去才挂出来、刚拿到焦点
     就被默认行为抢走 → 吃到 blur → 被 `onBlur={commit}` 当成交付、一闪就关
     （实测事件序：focusin slider-edit → focusout → focusin INPUT → click INPUT）。
     修法是拦掉那两下的默认行为。jsdom **不跑**标签的默认行为，复现不了事故本身，
     所以这里退一步钉住**修法**（事件是不是被判了 preventDefault）——
     谁把那两行删掉，这条会红。 */
  it('点数字那一下必须 preventDefault（拦掉 label 的默认行为，不然编辑框会被抢焦点顶掉）', async () => {
    const c = await mount(<Slider label="亮度" value={30} min={-100} max={100} onChange={() => {}} />)
    const span = c.querySelector('.slider-value')!
    const down = new MouseEvent('mousedown', { bubbles: true, cancelable: true })
    await fire(span, down)
    expect(down.defaultPrevented).toBe(true)
    const up = new MouseEvent('click', { bubbles: true, cancelable: true })
    await fire(span, up)
    expect(up.defaultPrevented).toBe(true)
  })
})
