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
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createRoot } from 'react-dom/client'
import { describe, expect, it } from 'vitest'
import { Slider as BaseSlider } from '@base-ui-components/react/slider'
import { User } from 'lucide-react'
import { Field, TextInput } from './Field.tsx'
import { Slider } from './Slider.tsx'
import { Btn, BtnLink } from './Btn.tsx'
import ChatPanel from '../ChatPanel.tsx'
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
      <BaseSlider.Root defaultValue={20} min={-50} max={50} aria-label="亮度">
        <BaseSlider.Control><BaseSlider.Track><BaseSlider.Indicator /></BaseSlider.Track><BaseSlider.Thumb /></BaseSlider.Control>
      </BaseSlider.Root>,
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

describe('<Slider>：键盘能改值，读屏能念出这是哪一条', () => {
  it('右方向键 = +1，回调拿到的是**新值**', async () => {
    const seen: number[] = []
    const c = await mount(
      <Slider label="亮度" value={0} min={-100} max={100} onChange={v => seen.push(v)} />,
    )
    const input = c.querySelector('input[type="range"]') as HTMLInputElement
    expect(input.getAttribute('aria-valuenow')).toBe('0')
    // ⚠️ **必须先聚焦**：Base UI 的滑块只在拇指是"活动的那一个"时才吃方向键
    //    （真实用户就是 Tab 到它上面，那一下就是聚焦）。少了 focus 这一步，
    //    事件派发出去没有任何反应 —— 而且不报错，很容易被当成"键盘坏了"。
    await act(async () => { input.focus() })
    await act(async () => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))
      await new Promise(r => setTimeout(r, 0))
    })
    expect(seen.at(-1)).toBe(1)
  })

  it('外面仍然是 `<label className="slider">` —— CSS 和 `AdjustmentPanel.test.ts` 都按它认人', async () => {
    const c = await mount(<Slider label="亮度" value={3} min={-100} max={100} onChange={() => {}} />)
    const box = c.querySelector('label.slider') as HTMLElement
    expect(box).toBeTruthy()
    expect(box.querySelector('.slider-label')?.textContent).toBe('亮度')
    expect(box.querySelector('.slider-value')?.textContent).toBe('3')
  })

  it('那个数字只是**给眼睛看的**，不许混进可读名字（输入框自己会报 aria-valuenow）', async () => {
    const c = await mount(<Slider label="亮度" value={3} min={-100} max={100} onChange={() => {}} />)
    const value = c.querySelector('.slider-value') as HTMLElement
    expect(value.getAttribute('aria-hidden')).toBe('true')
  })
})

describe('图标（2026-10-01 统一走 lucide）', () => {
  /* ⚠️ 这条守的是**当初不用字符画记号的那个理由**：记号一旦进了 textContent，
     读屏软件会念它，而"按文字找这颗按钮"的地方（`ModelSettings.test.tsx` 的
     `inPart`、`App.test.tsx` 里那几个 clickTop/goNav）就会认不出来。
     svg 天生不进 textContent —— 所以换成图标之后这条**更稳**了，但要有人钉着。 */
  it('「回到这一步」里的箭头是 svg，按钮的文字还是那五个字', async () => {
    const c = await mount(
      <ChatPanel
        messages={[{ id: 1, role: 'assistant', text: '好，这就去掉。' }]}
        cards={[]} busy={null} suggesting={false} thumbs={{}}
        // ★ 2026-10-06：ChatPanel 又多了 `generating`（生成中图位的占位块，
        //   见 App.tsx）—— 同样给全，少一个 `tsc` 就红。
        generating={false}
        rerunnable={[1]} jumpableIds={[1]} marking={false} canConfirmMark={false}
        onSend={() => {}} onStop={() => {}} onCard={() => {}} onJump={() => {}}
        onRerun={() => {}} onConfirmMark={() => {}} onCancelMark={() => {}}
        currentId={null} futureSteps={0} replacing={false}
        onConfirmReplace={() => {}} onCancelReplace={() => {}}
        // ★ 2026-10-06：又多了两个（单条记录的删除，见 ChatPanel.tsx）——
        //   同样给全，少一个 `tsc` 就红。`originalId={null}` = 这一条不是原图，
        //   ✕ 会照常渲染（这条用例只验箭头图标，不影响）。
        originalId={null} onDeleteMessage={() => {}}
        // ★ 2026-10-05（滤镜，Task 9）：ChatPanel 多了"对话区那颗按钮"那批 props。
        //   这一条只验箭头图标，给一份最简的空清单就够 —— 但要给全，
        //   少一个 `tsc` 就红（vitest 自己不做类型检查）。
        // ★ 2026-10-05 终审修复又多了两个（`lutsKnown` / `onRetryLuts`，同上）。
        luts={[]} lutsKnown lut={null} lutThumbs={{ none: null, byId: {} }}
        onPickLut={() => {}} onLutAmount={() => {}} onNeedLutThumbs={() => {}} onGoImport={() => {}}
        onRetryLuts={() => {}}
      />,
    )
    const jump = c.querySelector('.bubble-jump') as HTMLButtonElement
    expect(jump.querySelector('svg')).toBeTruthy()
    expect(jump.textContent?.trim()).toBe('回到这一步')
    expect(jump.textContent).not.toContain('↶')
  })
})

describe('<Btn> / <BtnLink>：主按钮只有一份长相', () => {
  it('`<button>` 和 `<a>` 两种载体穿的是同一套；链接那种仍然带得动 download', async () => {
    const c = await mount(
      <div>
        <Btn className="x">保存</Btn>
        <BtnLink className="y" href="/file" download="a.jpg">下载到我的电脑</BtnLink>
      </div>,
    )
    expect((c.querySelector('button') as HTMLElement).className).toContain('btn-primary')
    const a = c.querySelector('a') as HTMLAnchorElement
    expect(a.className).toContain('btn-primary')
    // ⚠️ 各处的老类名必须原样留着 —— 它们是测试和 CSS 的锚点
    expect(a.className).toContain('y')
    expect(a.getAttribute('href')).toBe('/file')
    expect(a.getAttribute('download')).toBe('a.jpg')
  })

  it('不写 `type` 时是 `button`，不是 `submit` —— 表单里那一下会把表单交上去', async () => {
    const c = await mount(<Btn>取消</Btn>)
    expect((c.querySelector('button') as HTMLButtonElement).type).toBe('button')
  })
})

describe('没有标签的那几格', () => {
  /* ⚠️ 这三格**故意没过 `<Field>`**（它们没有标签、没有注解，包一层反而要把
     `flex` 从输入框挪到外层，白折腾）。它们的风险是另一头的：
     **只有 placeholder，没有可访问的名字** —— 所以下面钉的是那三条名字，
     不是"用了什么标签"。原因写在各自文件里那一小段注释里。

     ⚠️ 读源码这条路**不能用 `new URL(相对路径, import.meta.url)`**：
     jsdom 环境里它拼出来不是 file:// 协议，`readFileSync` 会报
     "The URL must be of scheme file"。按**项目根**拼（vitest 就是在那儿跑的）。 */
  const srcOf = (name: string) => readFileSync(join(process.cwd(), 'src/ui', name), 'utf8')

  it('搜索 / 改名 / 对话三格各自带着可访问名字（placeholder 不算名字）', () => {
    const checks = [
      ['GalleryPage.tsx', 'aria-label="找一张作品"'],
      ['WorkDetailPage.tsx', 'aria-label="作品名字"'],
      ['ChatPanel.tsx', 'aria-label="说说想怎么改"'],
    ] as const
    for (const [file, needle] of checks) {
      expect(srcOf(file), file).toContain(needle)
    }
  })

  it('模型设置那四格走 `<Field>` —— 别再手写第二套 <label htmlFor>', () => {
    const src = srcOf('ModelSettings.tsx')
    expect(src).toContain('<Field')
    expect(src).not.toMatch(/<label htmlFor=/)
    // ⚠️ id 是 ModelSettings.test.tsx 里 `field(id)` 的锚点，四格一个都不能少
    for (const id of ['model-alias', 'model-url', 'model-name', 'model-key']) {
      expect(src, id).toContain(`id="${id}"`)
    }
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
