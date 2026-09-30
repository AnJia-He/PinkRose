// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'
import LandingPage from './LandingPage'

/**
 * 落地页（2026-09-30 从 `create-image/落地页/mock4.html` 搬进仓库）。
 *
 * 这一份守的是**搬迁本身有没有搬丢东西** —— 版面和文案是照着那份样页抄的，
 * 抄漏一处（少 import 一张图、少一段文字）浏览器不会报任何错，
 * 只是页面上静静地少一块。所以这里的判据尽量按**内容**断，不按结构断。
 *
 * ⚠️ 排版和观感这里一概量不到（jsdom 没有排版引擎，getBoundingClientRect
 * 全返回 0）—— 那种事归 `scripts/check-mobile-layout.mjs` 和真浏览器。
 */
let container: HTMLDivElement
let root: Root
const onEnter = vi.fn()

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  onEnter.mockClear()
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  // 这一页会往 documentElement 上挂一个类（见下面那条测试），别让它漏给下一个用例
  document.documentElement.classList.remove('lp-on')
})

async function render() {
  await act(async () => { root.render(<LandingPage onEnter={onEnter} />) })
}

describe('落地页', () => {
  it('开场那句话在 —— 和 App 首屏、和样页是同一句', async () => {
    await render()
    expect(container.querySelector('h1')?.textContent).toContain('说句话，')
    expect(container.querySelector('h1')?.textContent).toContain('照片就修好了')
    // 三个锚点小节都在（导航里那三个链接指向它们）
    for (const id of ['product', 'compare', 'how']) {
      expect(container.querySelector(`#${id}`), `少了 #${id}`).toBeTruthy()
    }
  })

  it('★ 导航那三个链接都真的指向存在的小节 —— 死锚点不报错，只会点了没反应', async () => {
    // 导航文案是**会变的**（2026-09-30 用户就改过一轮：要「专业一点」但
    // 「也不要太专业」），所以这里**不钉那三个词**，钉的是它们的**契约** ——
    // 每一个都指向一个真的存在的小节 id。
    // 少了这一条：谁改文案时顺手把 href 敲错，页面照样渲染、控制台一声不吭，
    // 只是用户点了那个链接**什么都不发生**（浏览器对不存在的锚点就是不动）。
    await render()
    const links = [...container.querySelectorAll<HTMLAnchorElement>('.lp-nav nav a')]
    expect(links.length).toBe(3)
    for (const a of links) {
      const href = a.getAttribute('href') ?? ''
      expect(href.startsWith('#'), `「${a.textContent}」不是个页内锚点`).toBe(true)
      expect(container.querySelector(href), `「${a.textContent}」指向的 ${href} 不存在`).toBeTruthy()
    }
  })

  it('★ 十张图一张都不能少 —— 少一张那一块就是空的，而浏览器不会报错', async () => {
    // 变异：把任意一行 `import xx from '../assets/landing/...'` 删掉 → 那条红。
    // 这条守的正是搬迁里最容易静默出错的一步：图是**新的文件名**（压过一道、
    // 改了英文名），少 import 一张的表现是页面上缺一块，不是报错。
    await render()
    const imgs = [...container.querySelectorAll<HTMLImageElement>('img')]
    // 13 个位置：标志 + 开场背景 + 产品两张 + 对开两张 + 方图那格 + 底部照片带六张
    expect(imgs.length).toBe(13)
    for (const img of imgs) {
      expect(img.getAttribute('src'), '有张图没挂上 src').toBeTruthy()
    }
    // ⚠️ **去重之后是 11**：海边公路那张两处用（开场大图 + 照片带最后一张）、
    //    夜市那张也两处（方图那格 + 照片带）。这一条防的是
    //    "复制粘贴时把某一处指到了同一张图上" —— 那样总数照样对，但页面上
    //    会有一张重复、少一张。
    expect(new Set(imgs.map(i => i.getAttribute('src'))).size).toBe(11)
  })

  it('★ 「免费试用」走的是 onEnter，不是让浏览器整页跳走', async () => {
    // 它是个 `<a href="/app">`：中键 / 右键"在新标签打开"照旧能用，
    // 但**左键点**的时候要被拦住走 SPA —— 不拦的话整页重新加载，
    // 用户从落地页进 App 会白屏闪一下。
    await render()
    const cta = container.querySelector('.lp-btn-accent') as HTMLAnchorElement
    expect(cta.getAttribute('href')).toBe('/app')   // 右击复制链接拿到的是这个
    await act(async () => {
      cta.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    })
    expect(onEnter).toHaveBeenCalledTimes(1)
  })

  it('顶栏那个「登录」也去 App', async () => {
    await render()
    const login = container.querySelector('.lp-login') as HTMLAnchorElement
    expect(login.getAttribute('href')).toBe('/app')
    await act(async () => {
      login.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    })
    expect(onEnter).toHaveBeenCalledTimes(1)
  })

  it('对开滑块能拖 —— 拖它改的是那个 CSS 变量', async () => {
    await render()
    const box = container.querySelector('.lp-ba') as HTMLElement
    expect(box.style.getPropertyValue('--lp-p')).toBe('52%')   // 样页的初值
    const range = container.querySelector('.lp-ba input[type=range]') as HTMLInputElement

    // ⚠️ **不能直接 `range.value = '80'`。** React 在受控输入上挂了一个
    //    "值跟踪器"，直接赋值会被它记成"值没变"，于是 `onChange` 根本不触发
    //    —— 测试会看到"拖了没反应"，而真实浏览器里拖是好的（那里走的是
    //    用户的输入事件，不是 JS 赋值）。要绕过跟踪器就得走原生 setter。
    const nativeSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
    await act(async () => {
      nativeSetter.call(range, '80')
      range.dispatchEvent(new Event('input', { bubbles: true }))
    })
    expect(box.style.getPropertyValue('--lp-p')).toBe('80%')
  })

  it('★ 待在这一页时，挂到 `html` 上的那个类是活的 —— 离开就摘掉', async () => {
    // `body` 的底色、`color-scheme`、文档滚动条这三样是文档级的，
    // 写在 `.lp` 里面管不到它们（App 那边是深色）。没挂这个类的话，
    // 浅色的落地页上会挂着一条深灰滚动条，Windows 上很显眼。
    await render()
    expect(document.documentElement.classList.contains('lp-on')).toBe(true)
    act(() => root.unmount())
    expect(document.documentElement.classList.contains('lp-on')).toBe(false)
    // 卸载之后再挂一个根，好让 afterEach 那次 unmount 不出错
    root = createRoot(container)
  })

  it('★ 没有 IntersectionObserver 的环境里，内容**照样看得见**', async () => {
    // 进场动画的默认状态是 `opacity: 0`。少了 Reveal 里那条兜底，
    // 这种环境下整页是一张白纸 —— 而页面上每个字其实都在 DOM 里，
    // 所以别的东西（比如"文字在不在"）一条都测不出来。
    const saved = (window as unknown as { IntersectionObserver?: unknown }).IntersectionObserver
    // @ts-expect-error 故意删掉它，演"老浏览器 / 被 polyfill 掉的环境"
    delete window.IntersectionObserver
    try {
      await render()
      const rises = [...container.querySelectorAll('.lp-rise')]
      expect(rises.length).toBeGreaterThan(5)
      for (const el of rises) expect(el.classList.contains('lp-in')).toBe(true)
    } finally {
      if (saved) (window as unknown as { IntersectionObserver?: unknown }).IntersectionObserver = saved
    }
  })
})
