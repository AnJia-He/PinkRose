// @vitest-environment jsdom
/**
 * App 级的验收测试 —— **列表与导航那一簇**：作品页 / 详情页 / 保存 / 对话列表 / 门面 / 左栏。
 * （2026-10-09 从 App.test.tsx 拆出来的之一；脚手架在 `test/appHarness.tsx`。）
 *
 * ⚠️ 第一个 import（`test/appHarness`）**必须是它**：那堆 `vi.mock` 是
 *   在那个模块被求值时注册的，排在它后面加载的模块才拿得到假的。
 */
import { HUANGHUN, WORK, bodyOf, canvasProps, clickByText, container, decision, fetchMock, goNav, jsonResponse, lutSection, makeSession, openLutPanel, renderApp, reopenApp, say, scrollToEnd, tileNamed, typeIn, uploadPhoto, withPresets, withSessions, withWorks } from './test/appHarness'
import { act } from 'react'
import { ZERO } from '../shared/adjustments.ts'
import * as api from './api/client'
import * as saveMod from './export/save'
import * as thumbMod from './core/thumbnail'
import * as lutsMod from './api/luts'
import * as photoInfo from './core/photoInfo.ts'
vi.mock('./core/photoInfo.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./core/photoInfo.ts')>()
  return { ...actual, readLensInfo: vi.fn() }
})
// ★ 2026-10-10：按大小排那一格上要显示大小 —— 口径和用户管理页那个用量图
//   同一份（断言也用同一个函数，免得两边各写各的格式）。
import { formatSize } from './ui/AccountPage'
import { beforeEach, describe, expect, it, vi } from 'vitest'

beforeEach(() => {
  vi.mocked(photoInfo.readLensInfo).mockResolvedValue({
    make: null, model: null, lens: null,
    focalMm: null, focal35mm: null, hasExif: false, takenAt: null,
  })
})

describe('左栏导航：切界面不丢工作', () => {
  it('★ 切到作品再切回来，改到一半的东西一点没丢', async () => {
    await renderApp()
    await uploadPhoto()
    vi.mocked(api.postRoute).mockResolvedValueOnce(
      decision({ route: 'params', paramDeltas: { exposure: 20 }, reply: '亮了一点。' }))
    await say('亮一点')

    await goNav('作品')
    // ⚠️ 这条**守不住任何东西**：传过照片之后 `input[type=file]` 本来就不在 DOM 里
    //   （Uploader 只在还没有图的时候渲染）—— 实测把它想守的那件事拆坏，它一声不吭。
    //   配得上「修图界面确实让位了」这句话的是**下面那条**。
    expect(container.querySelector('input[type="file"]')).toBeNull()   // 修图界面确实让位了
    expect(container.querySelector('.workspace')).toBeNull()
    expect(location.pathname).toBe('/app/works')

    await goNav('修图')
    // ★ 四样都还在：说过的话、那张底、那个画布、**用户拖过的滑块**
    expect(container.textContent).toContain('亮一点')
    expect(container.querySelector('canvas')).toBeTruthy()
    expect(canvasProps.images.at(-1)).toBeTruthy()
    // ★ 第四样是后补的：上面三样都只盯着"东西还在不在"，盯不住**值**还在不在。
    //   在 go 里顺手 setParams(ZERO)，这条测试**照样绿**（实测）—— 而用户回来一看
    //   颜色全没了。§3.2 那句承诺有两半，"界面没被拆"只是第一半。
    expect(canvasProps.props.at(-1)?.params.exposure).toBe(20)
  })

  it('★ 浏览器后退 / 前进 —— 界面跟着地址走，不是只跟着那两个按钮走', async () => {
    // 按钮只是**改地址的其中一条路**。用户按的是浏览器后退键时，
    // 地址变了而 `view` 不动 —— 屏幕上是修图页、地址栏是 /app/works，
    // 再点一下就走到别的地方去了。popstate 就是接住这一半的。
    //
    // 这里手动 pushState + 派发 popstate 来演"后退"：真正的 history.back()
    // 在 jsdom 里是异步排队的一步，而这条要断言的**只是那个监听的契约** ——
    // 它读的就是 `location.pathname`，所以把地址摆好、把事件递进去就够。
    await renderApp()
    await uploadPhoto()
    expect(container.querySelector('.workspace')).toBeTruthy()   // 起点：修图页

    history.pushState(null, '', '/app/works')
    await act(async () => {
      window.dispatchEvent(new PopStateEvent('popstate'))
      await new Promise(r => setTimeout(r, 0))
    })
    // 真的切了 —— 用 .gallery 正面确认是**作品页那一支**，不是"两边都没了"
    // （Task 11 之前这儿是 .placeholder，作品页换成真组件之后它就是 .gallery）
    expect(container.querySelector('.gallery')).toBeTruthy()
    expect(container.querySelector('.workspace')).toBeNull()

    // 再按一次前进（或者后退），回到修图页 —— 两个方向都得跟
    history.pushState(null, '', '/app')
    await act(async () => {
      window.dispatchEvent(new PopStateEvent('popstate'))
      await new Promise(r => setTimeout(r, 0))
    })
    expect(container.querySelector('.workspace')).toBeTruthy()
    expect(container.querySelector('.gallery')).toBeNull()
  })

  it('★ 已经在作品页再点一次「作品」—— 不该多推一条历史（后退要退一次，不是退两次）', async () => {
    await renderApp()
    const before = history.length
    await goNav('作品')
    // 先证明这把尺子量得出东西：真推了一条，length 就该 +1。
    // 少了这一句，下面那句"没变"可能是**假绿** —— 尺子自己不动的话，
    // 它什么都证明不了（这条测试自己踩的就是"看着在守、其实守不住"那个坑）。
    expect(history.length).toBe(before + 1)

    await goNav('作品')                 // 人还在作品页，又点了一次同一个地方
    expect(history.length).toBe(before + 1)   // 一条都不该多
    expect(location.pathname).toBe('/app/works')
  })

  it('★ 刷新页面 / 从网址直接进来 —— 一打开就该在原处，不是每次都回修图页', async () => {
    // 地址栏是**可以被直接打开的**：用户收藏了 /app/works，或者按了 F5。
    // 少了这条，`useState(() => viewFromPath(location.pathname))` 换成常量
    // `{ kind: 'edit' }` 全套测试照样绿 —— 而"刷新能回到原处"正是它存在的理由。
    // （地址在 beforeEach 里已经被摆回 '/app' 了，所以这一步是"用户此刻打开的是这条"。）
    history.replaceState(null, '', '/app/works')
    await renderApp()
    expect(container.querySelector('.gallery')).toBeTruthy()   // 落在作品页
    expect(container.querySelector('.workspace')).toBeNull()       // 不是修图页
    expect(container.querySelector('.nav-item.on')?.textContent).toBe('作品')
  })

  it('★ 「调色」是左栏里的一支 —— 点它面板开着、对话让位（2026-10-04）', async () => {
    // 用户原话：「那个微调照片的放在导航栏单列出来」（他说的「微调」是 09-30
    // 改名前的旧词，同一件事 —— 见《文案规范》里「调色」那一条）。
    //
    // 它原来住在**顶栏**，和「下载 / 保存 / 新的一张」挤一排。搬家有两层理由：
    //   ① 那三颗是**把图拿走**，它是**改这张图** —— 本来就不该是一排的东西；
    //   ② 顶栏**只在有照片的时候才存在**（2026-10-03 定的），于是照片一撤，
    //      "手动调色"这件事在界面上连名字都没有了。
    await renderApp()
    await uploadPhoto()
    // 先在修图页说一句 —— 待会儿要用它证明"切走再切回来，工作没丢"
    vi.mocked(api.postRoute).mockResolvedValueOnce(
      decision({ route: 'params', paramDeltas: { exposure: 20 }, reply: '亮了一点。' }))
    await say('亮一点')
    expect(container.querySelector('.panel')).toBeNull()   // 起点：收着的（修图页）

    await goNav('调色')
    expect(container.querySelector('.panel')).toBeTruthy()
    expect(location.pathname).toBe('/app/adjust')
    // ⚠️ 亮的**只有一颗**。这条守的是"它是一支导航、不是一颗开关"：
    //    做成开关（view 不动、只翻一个 showPanel state）的话，「修图」会跟着
    //    一起亮 —— 而左栏那颗亮点回答的是"我在哪"，它不能同时有两个答案。
    expect([...container.querySelectorAll('.nav-item.on')].map(b => b.textContent))
      .toEqual(['调色'])
    // ★ **这一屏没有对话区**（用户 2026-10-04 看完第一版补的那句：
    //   「调色就是对图片微调的界面区不是对话区」）。第一版把对话栏留在了右边 ——
    //   于是这一屏读起来仍然是"对话页底下多了条东西"，而他要的是**两个区**：
    //   修图页 = 对话区（说话改），调色这一屏 = 微调区（拖滑块改）。
    //   ⚠️ 判据钉在**这里**而不是 CSS 里（窄屏原来有一条 `.app:has(> .panel)
    //   .chat{display:none}` 就是干这件事的，现在删了）—— jsdom 不套样式表，
    //   写成 CSS 的话这条断言量不到任何东西；而且"不渲染"是结构上的，
    //   比"渲染了再藏起来"硬。
    expect(container.querySelector('.workspace')).toBeTruthy()   // 舞台还在
    expect(container.querySelector('.chat')).toBeNull()          // 对话不在了
    expect(container.querySelector('form.chat-input')).toBeNull()

    // ★ **点「修图」= 回到对话区**：面板收起来、对话栏回来，而且**那句话还在**。
    // 面板自己没有关闭钮，这是唯一的关法 —— 所以它得真的关得上。
    // ⚠️ 后半句（话还在）是这条测试里唯一能抓住"顺手把 messages 清了"的地方：
    //    §1 那句承诺是"切界面不丢工作"，而"这一屏不显示对话"和"把对话删了"
    //    在屏幕上**长得一模一样**。
    //
    // ⚠️ **"按 F5 面板还开着"这条不在这里测**（原来这儿有个 `root.render()`
    //    第二次的写法，那是**假绿**：同一个实例不重跑 `useState` 的初始化器，
    //    `view` 还是老的，量到的根本不是"从网址进来"）。jsdom 里也做不到 ——
    //    重挂之后照片是内存里的、没地方恢复，面板本来就该是收着的。
    //    真 F5 归 `.superpowers/scratch/audit/adjust_flow.py`（真浏览器、
    //    真 reload，那条断言就在里面）。这一条只管"导航切来切去"。
    await goNav('修图')
    expect(container.querySelector('.panel')).toBeNull()
    expect(location.pathname).toBe('/app')
    expect(container.querySelector('.nav-item.on')?.textContent).toBe('修图')
    expect(container.querySelector('.chat')).toBeTruthy()
    expect(container.textContent).toContain('亮一点')
    expect(canvasProps.props.at(-1)?.params.exposure).toBe(20)
  })

  it('★ 「调色」那一格**一直在** —— 没照片时变的是照片那块地方（2026-10-04）', async () => {
    // 用户原话（当天第三遍，把我上一版否了）：
    //   「**调色要一直在导航栏**，没有图片的时候显示图片的地方提示还没有照片不就好了？
    //    但是微调的按钮要**一直在**，你这也要靠我？」
    //
    // 我上一版做的是"没有照片就把那一格藏起来"（理由还写得挺像回事：照顶栏那三颗
    // 的规矩，"关于这张照片的东西，照片在才有"）。他一句话点破 —— **想窄了**：
    //   顶栏那三颗是「**对这张照片做什么**」（分享 / 保存 / 新的一张）；
    //   左栏这一列是「**这里有哪几件事**」。
    // 一件事在不在，不该随手上有没有照片变；**该换的是"没东西可看"那块地方**。
    await renderApp()
    // ⚠️ 「个人设置」那颗现在是**人物图标**（2026-10-04 用户：「个人设置改为人物图标」），
    //   它没有文字 —— 名字只在 `aria-label` 上。所以这里读的是"标签优先、文字兜底"。
    //   少了前一半，这一格会**静默读成空串**（断言红在最后一项，看着像少了一颗按钮）。
    const 格子 = () => [...container.querySelectorAll('.nav-item')]
      .map(b => b.getAttribute('aria-label') || b.textContent)
    // ★ 2026-10-05：**「滤镜」进了左栏**（用户：「把滤镜导入放到导航里吧，然后我没看到
    //   怎么去调用 lut 文件」——他找不到那个页面，也找不到"调用"的地方）。
    //   位置紧挨着「调色」：导入/管理滤镜是**为这张照片**做的事，和修图/调色同一组
    //   （后面那两支说的是别的照片）。
    expect(格子()).toEqual(['修图', '调色', 'Lut', '对话', '作品', '产品介绍', '个人设置'])

    await goNav('调色')
    expect(location.pathname).toBe('/app/adjust')
    expect(container.querySelector('.nav-item.on')?.textContent).toBe('调色')
    // ★ **照片那块地方**说的是「还没有照片。」+ 一条出路（§3.7 那个句式：
    //   主句说现状，按钮说"那怎么办"）——和对话列表那条空态是同一个长相。
    expect(container.querySelector('.empty-state-title')?.textContent).toBe('还没有照片。')
    expect(container.querySelector('.empty-state button')?.textContent).toBe('选一张照片')
    // ⚠️ **而且不是欢迎页**：那一屏是"登录之后看到的第一张脸"（标志 + 那句话 +
    //   背景那颗图片球），要介绍这个产品是什么。合并回去就退回了用户撞上的那一版
    //   ——他点「调色」，看到的和「修图」一模一样，**看着就像没反应**。
    expect(container.querySelector('.welcome')).toBeNull()
    expect(container.querySelector('.globe')).toBeNull()
    // 没照片时滑块也没得拖（它们是作用在照片上的），所以面板不出现
    expect(container.querySelector('.panel')).toBeNull()

    // ★ 从**这一屏**选一张照片 → 落回的就是这一屏（调色），面板跟着开。
    //   不需要任何跳转：`onPick` 本来就不动 view。
    await uploadPhoto()
    expect(container.querySelector('.empty-state')).toBeNull()
    expect(container.querySelector('.panel')).toBeTruthy()
    expect(container.querySelector('.nav-item.on')?.textContent).toBe('调色')

    // ★ 另一头：**同一件事在「修图」那一边仍是欢迎页** —— 两屏没照片时给的东西
    //   **不一样**，这正是用户要的那个形状（一块地方说现状，不是一个入口消失）。
    //   ⚠️ 换 root 重挂（本文件里"重开一次页面"的惯用写法）：`root.render()` 第二次
    //   不重跑 `useState` 的初始化器，同一个实例还留着老 view 和那张照片。
    history.replaceState(null, '', '/app')
    await reopenApp()
    expect(container.querySelector('.welcome')).toBeTruthy()
    expect(container.querySelector('.empty-state')).toBeNull()
    expect(格子()).toContain('调色')      // 而那一格**还在**
  })

  it('★ 当前那一支带 aria-current="page"（含人物图标那颗）—— 读屏软件能听见"你在哪"', async () => {
    // ★ 2026-10-11（设计跟进 T5，spec §二 #6）。亮点（`.on`）是给眼睛的，
    //   `aria-current="page"` 是给读屏的 —— 少了它，读屏用户在一列七颗里
    //   听不出自己正站在哪一支上。
    await renderApp()
    const 当前项 = () => [...container.querySelectorAll('.nav-item[aria-current="page"]')]
      .map(b => b.getAttribute('aria-label') || (b.textContent ?? '').trim())
    expect(当前项()).toEqual(['修图'])                 // 起点：修图页

    await goNav('作品')
    expect(当前项()).toEqual(['作品'])                 // 跟着走，而且只有一个答案

    // 「个人设置」那颗是人物图标（没有可见文字，名字只在 aria-label 上）——
    // 它站在用户管理那一页上时也得有 aria-current
    const me = [...container.querySelectorAll('.nav button')]
      .find(b => b.getAttribute('aria-label') === '个人设置') as HTMLButtonElement
    expect(me).toBeTruthy()
    await act(async () => { me.click(); await new Promise(r => setTimeout(r, 0)) })
    expect(container.querySelector('.account')).toBeTruthy()   // 前提：真的到了那一页
    expect(当前项()).toEqual(['个人设置'])
    // ⚠️ 「产品介绍」是"出门"、不是 App 里的第六支 —— 它**不该**有 aria-current
    //   （上面 `当前项()` 的三次断言合起来就在守这一条：出门那一趟不在 ITEMS 里）。
    // 变异：把 `aria-current` 从 ITEMS 循环或人物那颗上删掉 → 这一条红
  })
})

describe('回门面：左栏那颗「产品介绍」', () => {
  it('★ 点「产品介绍」→ 真的到得了落地页，没被那条自动跳转撵回来', async () => {
    await renderApp()
    expect(container.querySelector('.stage')).toBeTruthy()   // 起点：修图页

    await goNav('产品介绍')
    // 正面确认是**落地页那一支**（不是"两边都没有"）：用那一页自己的外壳
    expect(container.querySelector('.lp')).toBeTruthy()
    expect(container.querySelector('.lp-hero h1')?.textContent).toContain('说句话')
    expect(location.pathname).toBe('/')
    expect(location.search).toBe('?home=1')

    // ⚠️ 自动跳转那条是 effect（异步）—— 再让出一轮，它要是没让路，上面那三句
    //    里最后两句会红：地址会被改回 /app、落地页会被卸掉。少了这一轮，
    //    "刚渲染出来还没跳"那一瞬间也可能让这条测试假绿。
    await act(async () => { await new Promise(r => setTimeout(r, 0)) })
    expect(container.querySelector('.lp')).toBeTruthy()
    expect(location.pathname).toBe('/')
  })

  it('★ 那个参数得留在**网址里** —— 收藏 / F5 回来还站在门面上', async () => {
    // 守的是"特意来看"这件事记在网址上、不是内存里一个开关（见 view.ts 的
    // FRONT_PAGE）。换成内存开关的话，看完门面顺手按一下 F5 就被踢回 App ——
    // 而刷新是这一步里最自然的动作。
    history.replaceState(null, '', '/?home=1')
    await renderApp()
    await act(async () => { await new Promise(r => setTimeout(r, 0)) })
    expect(container.querySelector('.lp')).toBeTruthy()
    expect(location.pathname).toBe('/')
  })

  it('★ 从门面进了 App 再按后退 —— 人回到门面上，不是又被打回 /app', async () => {
    // 这条钉的是"判据读**此刻地址栏里**那个参数"（`location.search`）。
    // 把它改成"点「产品介绍」那一下记在 `view` 上的一个标记"，日常用起来一模一样 ——
    // 只有按后退时不一样：那一步没有点击，标记是空的，人明明按了后退却被
    // 自动跳转送回 App。**这条测试是唯一能咬住它的地方。**
    await renderApp()
    await goNav('产品介绍')
    expect(container.querySelector('.lp')).toBeTruthy()

    // 演一次"从门面点「免费开始」进了 App"（先把地址摆好，再递 popstate ——
    // 和上面「浏览器后退 / 前进」那条同一种演法）
    history.replaceState(null, '', '/app')
    await act(async () => {
      window.dispatchEvent(new PopStateEvent('popstate'))
      await new Promise(r => setTimeout(r, 0))
    })
    expect(container.querySelector('.lp')).toBeNull()

    // 按后退：地址回到**带着参数**的那一条
    history.replaceState(null, '', '/?home=1')
    await act(async () => {
      window.dispatchEvent(new PopStateEvent('popstate'))
      await new Promise(r => setTimeout(r, 0))
    })
    expect(container.querySelector('.lp')).toBeTruthy()
    expect(location.pathname).toBe('/')
  })

  it('★ 没有那个参数时老规矩照旧：登录着的人打开 `/` 就被送去 App（而且**不压历史**）', async () => {
    // 那条自动跳转是 2026-09-30 定的：营销页是给访客看的，回访的人每次打开
    // 都撞上它是打扰。加了「产品介绍」之后它不能被顺手删掉。
    const before = history.length
    history.replaceState(null, '', '/')
    await renderApp()
    await act(async () => { await new Promise(r => setTimeout(r, 0)) })

    expect(container.querySelector('.lp')).toBeNull()
    expect(location.pathname).toBe('/app')
    // ⚠️ 得是 **replace**：压一条的话历史栈里会留下一条 `/`，用户一按后退
    //    又回到门面、又被打回来 —— 按几次都出不去。
    expect(history.length).toBe(before)
  })
})

/**
 * ★ 2026-10-11（设计跟进 Task 2）：**认不出的网址**落在「没找到这一页」。
 *
 * 在那之前它冒充首页（`viewFromPath` 兜底回 landing，见 `ui/view.ts`）——
 * 地址栏里明明是一条打错的网址，屏幕却成了营销页，用户以为"这产品就这样"。
 * 现在给一页**诚实的找不到**：地址栏一个字不改写、两颗按钮各自能去对地方。
 */
describe('★（10-11）认不出的网址：一页诚实的找不到', () => {
  it('认不出的网址落在「没找到这一页」，地址栏保持原样，两颗按钮各自能去对地方', async () => {
    history.replaceState(null, '', '/totally/bogus')
    await renderApp()
    // ⚠️ 那条自动跳转（登录着的人打开 `/` 会被送去 App）是个 effect ——
    //   再让一轮；它要是没让路，下面那句"地址没变"会红。
    await act(async () => { await new Promise(r => setTimeout(r, 0)) })

    expect(container.querySelector('.notfound')).toBeTruthy()
    expect(container.textContent).toContain('没找到这一页')
    expect(container.textContent).toContain('地址可能打错了')
    // ★ 地址栏**保持原样**：这条网址就是用户手里那条（收藏夹里那条 / 别人发来的
    //   那条）—— 改写了，用户手里那条坏链接就变成一个"看着没问题"的地址了。
    expect(location.pathname).toBe('/totally/bogus')

    // 一号按钮「回到修图」= 回工作台（登录着的人的正事）
    await clickByText('回到修图')
    expect(container.querySelector('.app')).toBeTruthy()     // 修图那一屏回来了
    expect(container.querySelector('.notfound')).toBeNull()
    expect(location.pathname).toBe('/app')

    // 再站回那条坏网址（后退 / 重新打开一次），这回走二号按钮「看产品介绍」：
    // 它走**门面那一套**（`onGo({kind:'landing'})` → `FRONT_PAGE`，和 Nav 那颗
    // 「产品介绍」同一条路）。自己拼一个 `/` 的话，登录着的人会被自动跳转立刻
    // 撵回来 —— 那颗按钮等于"点了没反应"。
    history.replaceState(null, '', '/totally/bogus')
    await act(async () => {
      window.dispatchEvent(new PopStateEvent('popstate'))
      await new Promise(r => setTimeout(r, 0))
    })
    expect(container.querySelector('.notfound')).toBeTruthy()
    await clickByText('看产品介绍')
    expect(container.querySelector('.lp')).toBeTruthy()
    expect(location.search).toBe('?home=1')
    await act(async () => { await new Promise(r => setTimeout(r, 0)) })
    expect(container.querySelector('.lp')).toBeTruthy()   // 没被自动跳转撵回来
  })
})

describe('作品页：先摆 60 张、按天分组、名字就是时间', () => {

  /**
   * 500 张作品，**一天一张**（隔两天排 —— 有夏令时的时区里差一天可能落回同一个"天"）。
   *
   * ⚠️ 为什么不是"1 毫秒一张"那种写法（那样 500 张全在同一天）：§3.5 的规矩是
   * **按天取整、不在一天中间截断**（「9月25日 · 200 张」而下面只摆了 60 张 =
   * 用户会以为丢了 140 张），所以**同一天**的 500 张本来就该全摆出来 —— 用那种
   * 数据量到的会是 500。§10 那句「500 条 → 首屏不能一次全渲染」只有在**跨天**
   * 时才成立。
   */
  const manyWorks = () => Array.from(
    { length: 500 }, (_, i) => WORK(i + 1, 1_700_000_000_000 - i * 2 * 86_400_000))

  /**
   * 往搜索框里打字 —— ★ 2026-10-07 提到**模块层**了（原来住在这一个 describe 里，
   * 而对话列表那一组也要打字搜）。实现和理由在下面 `typeIn` 那一段。
   */

  it('★ 作品页：先摆 60 张，不是 500 张一起渲染', async () => {
    // §10 点名的：造 500 条 → 首屏不能一次全渲染，不然屏幕会卡
    withWorks(manyWorks())
    await renderApp()
    await goNav('作品')

    expect(container.querySelectorAll('.gallery-cell').length).toBeLessThanOrEqual(60)
    expect(container.textContent).not.toContain('没有更多了')   // 还有没摆的，所以圈还在转
  })

  it('★ 滚到底 → 再接 60 张（那个圈不能只是画出来的）', async () => {
    // §3.5 原话：「**那个圈必须转。** 没有它，用户会以为**到底了**，而不是"还在加载"」。
    // 所以这条要的不只是"圈在屏幕上"，而是**它真的接上了后面那些天** ——
    // 圈转着、却再也接不上东西，比没有圈更糟：用户会一直等下去。
    withWorks(manyWorks())
    await renderApp()
    await goNav('作品')
    expect(container.querySelectorAll('.gallery-cell')).toHaveLength(60)

    await act(async () => {
      scrollToEnd()
      await new Promise(r => setTimeout(r, 0))
    })
    expect(container.querySelectorAll('.gallery-cell')).toHaveLength(120)
  })

  it('★ 搜「9月25」能找到那天做的图 —— 没起名时名字就是时间（§3.5）', async () => {
    const day = new Date('2026-09-25T14:30:00').getTime()
    withWorks([WORK(1, day), WORK(2, new Date('2026-08-01T10:00:00').getTime())])
    await renderApp()
    await goNav('作品')

    const box = container.querySelector('.gallery-search') as HTMLInputElement
    await typeIn(box, '9月25')
    expect(container.querySelectorAll('.gallery-cell').length).toBe(1)
  })

  it('★ 作品页能按原文件名、相机和镜头搜索', async () => {
    withWorks([{
      ...WORK(1, new Date('2026-10-20T10:00:00').getTime(), '海边'),
      sourceName: 'IMG_1234.JPG',
      cameraMake: 'SONY',
      cameraModel: 'ILCE-7CM2',
      lensModel: 'FE 50mm F1.4 GM',
    }])
    await renderApp()
    await goNav('作品')

    const box = container.querySelector('.gallery-search') as HTMLInputElement
    await typeIn(box, 'img_1234')
    expect(container.querySelectorAll('.gallery-cell')).toHaveLength(1)
    await typeIn(box, 'ilce-7cm2')
    expect(container.querySelectorAll('.gallery-cell')).toHaveLength(1)
    await typeIn(box, '50mm f1.4')
    expect(container.querySelectorAll('.gallery-cell')).toHaveLength(1)
    await typeIn(box, 'nikon')
    expect(container.querySelectorAll('.gallery-cell')).toHaveLength(0)
  })

  it('★ 作品卡片可打星；再点同一颗清回 0 星', async () => {
    const now = Date.now()
    withWorks([WORK(1, now, '海边那张')])
    const inner = fetchMock.getMockImplementation()!
    const patches: unknown[] = []
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === '/api/works/1' && init?.method === 'PATCH') {
        const body = JSON.parse(String(init.body)) as { rating: number }
        patches.push(body)
        return jsonResponse({ ...WORK(1, now, '海边那张'), rating: body.rating })
      }
      return inner(url, init)
    })
    await renderApp()
    await goNav('作品')

    const star = container.querySelector(
      '[aria-label="海边那张 星级 4 星"]',
    ) as HTMLButtonElement
    expect(star).toBeTruthy()
    await act(async () => { star.click(); await new Promise(r => setTimeout(r, 0)) })
    await vi.waitFor(() => expect(patches[0]).toEqual({ rating: 4 }))
    expect(star.getAttribute('aria-pressed')).toBe('true')

    await act(async () => { star.click(); await new Promise(r => setTimeout(r, 0)) })
    await vi.waitFor(() => expect(patches[1]).toEqual({ rating: 0 }))
    expect(star.getAttribute('aria-pressed')).toBe('false')
  })

  it('★ 按星级筛选：只看 4 星以上', async () => {
    const now = Date.now()
    withWorks([
      { ...WORK(1, now, '五星'), rating: 5 },
      { ...WORK(2, now, '三星'), rating: 3 },
      { ...WORK(3, now, '未评分'), rating: 0 },
    ])
    await renderApp()
    await goNav('作品')

    const select = container.querySelector(
      'select[aria-label="按星级筛选"]',
    ) as HTMLSelectElement
    expect(select).toBeTruthy()
    const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!
    await act(async () => {
      setter.call(select, '4')
      select.dispatchEvent(new Event('change', { bubbles: true }))
      await new Promise(r => setTimeout(r, 0))
    })
    expect(container.querySelectorAll('.gallery-cell')).toHaveLength(1)
    expect(container.textContent).toContain('五星')
    expect(container.textContent).not.toContain('三星')
  })

  it('★ 按选片标记筛选：保留 / 排除各自只看一桶', async () => {
    const now = Date.now()
    withWorks([
      { ...WORK(1, now, '留着'), flag: 1 },
      { ...WORK(2, now - 1_000, '排除'), flag: -1 },
      { ...WORK(3, now - 2_000, '未标记'), flag: 0 },
    ])
    await renderApp()
    await goNav('作品')

    expect(container.querySelector('.gallery-flag.pick')?.textContent).toBe('保留')
    expect(container.querySelector('.gallery-flag.reject')?.textContent).toBe('排除')
    const select = container.querySelector(
      'select[aria-label="按标记筛选"]',
    ) as HTMLSelectElement
    const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!
    await act(async () => {
      setter.call(select, 'pick')
      select.dispatchEvent(new Event('change', { bubbles: true }))
      await new Promise(r => setTimeout(r, 0))
    })
    const cells = [...container.querySelectorAll('.gallery-cell')]
    expect(cells).toHaveLength(1)
    expect(cells.map(cell => cell.textContent).join('')).not.toContain('排除')
    expect(container.textContent).toContain('留着')
  })

  it('★ 颜色标签会显示在卡片上，并能按颜色筛选', async () => {
    const now = Date.now()
    withWorks([
      { ...WORK(1, now, '红标'), color: 'red' },
      { ...WORK(2, now - 1_000, '蓝标'), color: 'blue' },
      { ...WORK(3, now - 2_000, '无标色'), color: 'none' },
    ])
    await renderApp()
    await goNav('作品')

    expect(container.querySelector('.gallery-color.color-red')?.getAttribute('aria-label'))
      .toBe('颜色标签：红')
    const select = container.querySelector(
      'select[aria-label="按颜色筛选"]',
    ) as HTMLSelectElement
    const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!
    await act(async () => {
      setter.call(select, 'red')
      select.dispatchEvent(new Event('change', { bubbles: true }))
      await new Promise(r => setTimeout(r, 0))
    })
    expect(container.querySelectorAll('.gallery-cell')).toHaveLength(1)
    expect(container.textContent).toContain('红标')
    expect(container.textContent).not.toContain('蓝标')
  })

  it('★ 按机身和镜头筛选作品', async () => {
    const now = Date.now()
    withWorks([
      {
        ...WORK(1, now, '索尼'),
        cameraMake: 'SONY',
        cameraModel: 'ILCE-7CM2',
        lensModel: 'FE 50mm F1.4 GM',
      },
      {
        ...WORK(2, now - 1_000, '佳能'),
        cameraMake: 'Canon',
        cameraModel: 'EOS R5',
        lensModel: 'RF 24-70mm F2.8 L',
      },
      WORK(3, now - 2_000, '没有器材信息'),
    ])
    await renderApp()
    await goNav('作品')

    const gear = container.querySelector(
      'select[aria-label="按器材筛选"]',
    ) as HTMLSelectElement
    expect(gear).toBeTruthy()
    const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!

    await act(async () => {
      setter.call(gear, 'camera:SONY ILCE-7CM2')
      gear.dispatchEvent(new Event('change', { bubbles: true }))
      await new Promise(r => setTimeout(r, 0))
    })
    expect(container.querySelectorAll('.gallery-cell')).toHaveLength(1)
    expect(container.textContent).toContain('索尼')
    expect(container.textContent).not.toContain('佳能')

    await act(async () => {
      setter.call(gear, 'lens:FE 50mm F1.4 GM')
      gear.dispatchEvent(new Event('change', { bubbles: true }))
      await new Promise(r => setTimeout(r, 0))
    })
    expect(container.querySelectorAll('.gallery-cell')).toHaveLength(1)
    expect(container.textContent).toContain('索尼')

    await act(async () => {
      setter.call(gear, 'all')
      gear.dispatchEvent(new Event('change', { bubbles: true }))
      await new Promise(r => setTimeout(r, 0))
    })
    expect(container.querySelectorAll('.gallery-cell')).toHaveLength(3)
  })

  it('★ 按拍摄时间分组：EXIF 日期优先，切回编辑时间不留状态', async () => {
    const edited1 = new Date('2026-09-25T10:00:00').getTime()
    const edited2 = new Date('2026-09-24T10:00:00').getTime()
    const edited3 = new Date('2026-09-21T10:00:00').getTime()
    withWorks([
      {
        ...WORK(1, edited1, '甲'),
        capturedAt: new Date('2026-09-20T08:00:00').getTime(),
      },
      {
        ...WORK(2, edited2, '乙'),
        capturedAt: new Date('2026-09-20T08:00:03').getTime(),
      },
      {
        ...WORK(3, edited3, '丙'),
        capturedAt: new Date('2026-09-22T09:00:00').getTime(),
      },
    ])
    await renderApp()
    await goNav('作品')

    expect([...container.querySelectorAll('.gallery-day-title')].map(el => el.textContent))
      .toEqual(['9月25日 · 1 张', '9月24日 · 1 张', '9月21日 · 1 张'])

    await clickByText('按拍摄')
    expect([...container.querySelectorAll('.gallery-day-title')].map(el => el.textContent))
      .toEqual(['拍摄于 9月22日 · 1 张', '拍摄于 9月20日 · 2 张'])
    const shotOrder = [...container.querySelectorAll('.gallery-cell')].map(el => el.textContent ?? '')
    expect(shotOrder[0]).toContain('丙')
    expect(shotOrder.slice(1).join(' ')).toContain('甲')
    expect(shotOrder.slice(1).join(' ')).toContain('乙')

    await clickByText('按编辑')
    expect([...container.querySelectorAll('.gallery-day-title')].map(el => el.textContent))
      .toEqual(['9月25日 · 1 张', '9月24日 · 1 张', '9月21日 · 1 张'])
  })

  it('★ 连拍组：5 张相邻作品先收起，展开后每张仍可查看和评分', async () => {
    const base = new Date('2026-10-21T08:15:00').getTime()
    withWorks([
      { ...WORK(1, base, '连拍 1'), createdAt: base },
      { ...WORK(2, base + 300, '连拍 2'), createdAt: base + 300 },
      { ...WORK(3, base + 600, '连拍 3'), createdAt: base + 600, rating: 4 },
      { ...WORK(4, base + 900, '连拍 4'), createdAt: base + 900, rating: 5 },
      { ...WORK(5, base + 1_200, '连拍 5'), createdAt: base + 1_200 },
    ])
    await renderApp()
    await goNav('作品')

    const trigger = container.querySelector('.gallery-stack-trigger') as HTMLButtonElement
    expect(trigger).toBeTruthy()
    expect(trigger.getAttribute('aria-expanded')).toBe('false')
    expect(container.querySelectorAll('.gallery-cell')).toHaveLength(0)
    expect(container.textContent).toContain('5 张')

    await act(async () => {
      trigger.click()
      await new Promise(r => setTimeout(r, 0))
    })

    expect(trigger.getAttribute('aria-expanded')).toBe('true')
    expect(container.querySelectorAll('.gallery-stack-expanded .gallery-cell')).toHaveLength(5)
    expect(container.querySelector('[aria-label="连拍 4 星级 4 星"]')).toBeTruthy()
  })

  it('★ 连拍组可以直接整组多选，批量入口拿到的是全部真实作品', async () => {
    const base = new Date('2026-10-21T09:15:00').getTime()
    withWorks(Array.from({ length: 5 }, (_, i) => ({
      ...WORK(i + 1, base + i * 300, `连拍 ${i + 1}`),
      createdAt: base + i * 300,
    })))
    await renderApp()
    await goNav('作品')

    await clickByText('多选整组')

    expect(container.querySelectorAll('input[aria-label="选中这张作品"]:checked')).toHaveLength(5)
    expect(container.textContent).toContain('已选 5 张')
  })

  it('★ 连拍组可以关掉：作品墙立刻回到一张一格，再开回来仍能折叠', async () => {
    const base = new Date('2026-10-21T10:15:00').getTime()
    withWorks(Array.from({ length: 5 }, (_, i) => ({
      ...WORK(i + 1, base + i * 300, `连拍 ${i + 1}`),
      createdAt: base + i * 300,
    })))
    await renderApp()
    await goNav('作品')

    const toggle = container.querySelector(
      'button[aria-label="展开所有连拍组"]',
    ) as HTMLButtonElement
    expect(toggle).toBeTruthy()
    expect(toggle.getAttribute('aria-pressed')).toBe('true')

    await act(async () => {
      toggle.click()
      await new Promise(r => setTimeout(r, 0))
    })

    expect(toggle.getAttribute('aria-pressed')).toBe('false')
    expect(container.querySelectorAll('.gallery-stack')).toHaveLength(0)
    expect(container.querySelectorAll('.gallery-cell')).toHaveLength(5)

    await act(async () => {
      toggle.click()
      await new Promise(r => setTimeout(r, 0))
    })
    expect(container.querySelectorAll('.gallery-stack')).toHaveLength(1)
  })

  it('★ 连拍组一键整组挑最好：进入多选并只留下推荐张', async () => {
    const base = new Date('2026-10-21T11:15:00').getTime()
    withWorks(Array.from({ length: 5 }, (_, i) => ({
      ...WORK(i + 1, base + i * 300, `连拍 ${i + 1}`),
      createdAt: base + i * 300,
    })))
    const metrics: Record<string, object> = {
      '1': { sharpness: 100, exposure: 0.7, clipping: 0.04, meanLuma: 0.4 },
      '2': { sharpness: 220, exposure: 0.75, clipping: 0.03, meanLuma: 0.42 },
      '3': { sharpness: 840, exposure: 0.9, clipping: 0.02, meanLuma: 0.48 },
      '4': { sharpness: 1_500, exposure: 0.97, clipping: 0.005, meanLuma: 0.51 },
      '5': { sharpness: 1_100, exposure: 0.35, clipping: 0.2, meanLuma: 0.12 },
    }
    const inner = fetchMock.getMockImplementation()!
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      const match = url.match(/^\/api\/works\/(\d+)\/thumb\?/)
      if (match) {
        return {
          ok: true,
          status: 200,
          blob: async () => new Blob([JSON.stringify(metrics[match[1]!])], {
            type: 'application/json',
          }),
        } as Response
      }
      return inner(url, init)
    })
    await renderApp()
    await goNav('作品')

    await clickByText('整组挑最好')

    await vi.waitFor(() => {
      expect(container.textContent).toContain('推荐「连拍 4」')
      expect(container.textContent).toContain('本机评分')
    })
    const checked = [...container.querySelectorAll<HTMLInputElement>(
      'input[aria-label="选中这张作品"]:checked',
    )]
    expect(checked).toHaveLength(1)
    expect(checked[0]!.closest('.gallery-item')?.textContent).toContain('连拍 4')
  })

  it('★ 多选后批量标色：一次请求改所有选中作品', async () => {
    const now = Date.now()
    withWorks([
      { ...WORK(1, now, '一'), color: 'none' },
      { ...WORK(2, now, '二'), color: 'none' },
      { ...WORK(3, now, '三'), color: 'none' },
    ])
    const inner = fetchMock.getMockImplementation()!
    const calls: { ids: number[]; color: string }[] = []
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === '/api/works/color' && init?.method === 'POST') {
        const body = JSON.parse(String(init.body)) as { ids: number[]; color: string }
        calls.push(body)
        return jsonResponse({ colored: body.ids, missing: [] })
      }
      return inner(url, init)
    })
    await renderApp()
    await goNav('作品')
    await clickByText('多选')

    const cells = [...container.querySelectorAll<HTMLButtonElement>('.gallery-cell')]
    await act(async () => { cells[0]!.click(); cells[1]!.click() })
    const select = container.querySelector(
      'select[aria-label="批量颜色标签"]',
    ) as HTMLSelectElement
    const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!
    await act(async () => {
      setter.call(select, 'green')
      select.dispatchEvent(new Event('change', { bubbles: true }))
      await new Promise(r => setTimeout(r, 0))
    })

    await vi.waitFor(() => expect(calls[0]).toEqual({ ids: [1, 2], color: 'green' }))
    expect(container.textContent).toContain('已给 2 张标绿色')
  })

  it('★ 相册：新建、把多选作品加进去，再按相册筛选', async () => {
    const now = Date.now()
    const a = WORK(1, now, '一')
    const b = WORK(2, now - 1_000, '二')
    withWorks([a, b])
    const inner = fetchMock.getMockImplementation()!
    let albums: { id: number; name: string; createdAt: number; workCount: number }[] = []
    const members = new Set<number>()
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === '/api/albums' && (init?.method ?? 'GET') === 'GET') {
        return jsonResponse({ albums })
      }
      if (url === '/api/albums' && init?.method === 'POST') {
        const { name } = JSON.parse(String(init.body)) as { name: string }
        const album = { id: 1, name, createdAt: now, workCount: 0 }
        albums = [album]
        return jsonResponse({ album })
      }
      if (url === '/api/albums/1/works' && init?.method === 'POST') {
        const { ids } = JSON.parse(String(init.body)) as { ids: number[] }
        ids.forEach(id => members.add(id))
        albums = albums.map(album => ({ ...album, workCount: members.size }))
        return jsonResponse({ added: ids, missing: [] })
      }
      if (url === '/api/works?album=1') {
        return jsonResponse({ works: [a, b].filter(work => members.has(work.id)) })
      }
      return inner(url, init)
    })
    await renderApp()
    await goNav('作品')

    await clickByText('新建相册')
    const input = container.querySelector('[aria-label="新相册名"]') as HTMLInputElement
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
    await act(async () => {
      setter.call(input, '旅行')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => {
      input.closest('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
      await new Promise(r => setTimeout(r, 0))
    })
    await vi.waitFor(() => expect(container.textContent).toContain('已创建相册「旅行」'))

    await clickByText('多选')
    const cells = [...container.querySelectorAll<HTMLButtonElement>('.gallery-cell')]
    await act(async () => { cells[0]!.click(); cells[1]!.click() })
    const pickAlbum = container.querySelector('select[aria-label="加入相册"]') as HTMLSelectElement
    const selectSetter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!
    await act(async () => {
      selectSetter.call(pickAlbum, '1')
      pickAlbum.dispatchEvent(new Event('change', { bubbles: true }))
      await new Promise(r => setTimeout(r, 0))
    })
    await vi.waitFor(() => expect(container.textContent).toContain('已把 2 张加入「旅行」'))

    const cancel = container.querySelector('.gallery-select-cancel') as HTMLButtonElement
    await act(async () => { cancel.click(); await new Promise(r => setTimeout(r, 0)) })
    const filter = container.querySelector('select[aria-label="按相册筛选"]') as HTMLSelectElement
    await act(async () => {
      selectSetter.call(filter, '1')
      filter.dispatchEvent(new Event('change', { bubbles: true }))
      await new Promise(r => setTimeout(r, 0))
    })
    await vi.waitFor(() => expect(container.querySelectorAll('.gallery-cell')).toHaveLength(2))
  })

  it('★ 多选后批量打星：一次请求改所有选中作品', async () => {
    const now = Date.now()
    withWorks([
      { ...WORK(1, now, '一'), rating: 0 },
      { ...WORK(2, now, '二'), rating: 0 },
      { ...WORK(3, now, '三'), rating: 0 },
    ])
    const inner = fetchMock.getMockImplementation()!
    const calls: { ids: number[]; rating: number }[] = []
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === '/api/works/rate' && init?.method === 'POST') {
        const body = JSON.parse(String(init.body)) as { ids: number[]; rating: number }
        calls.push(body)
        return jsonResponse({ rated: body.ids, missing: [] })
      }
      return inner(url, init)
    })
    await renderApp()
    await goNav('作品')
    await clickByText('多选')

    const cells = [...container.querySelectorAll<HTMLButtonElement>('.gallery-cell')]
    await act(async () => { cells[0]!.click(); cells[1]!.click() })
    const star = container.querySelector(
      '[aria-label="批量星级 4 星"]',
    ) as HTMLButtonElement
    expect(star).toBeTruthy()
    await act(async () => { star.click(); await new Promise(r => setTimeout(r, 0)) })

    await vi.waitFor(() => expect(calls[0]).toEqual({ ids: [1, 2], rating: 4 }))
    expect(star.getAttribute('aria-pressed')).toBe('true')
    expect(container.textContent).toContain('已给 2 张打 4 星')
  })

  it('★ 找相似：本地比较缩略图后一起选中相近照片', async () => {
    const now = Date.now()
    withWorks([
      { ...WORK(101, now, '连拍一'), color: 'none' },
      { ...WORK(102, now - 1_000, '连拍二'), color: 'none' },
      { ...WORK(103, now - 2_000, '别的构图'), color: 'none' },
    ])
    const inner = fetchMock.getMockImplementation()!
    const hashes: Record<string, string> = {
      '101': '0000000000000000',
      '102': '0000000000000000',
      '103': 'ffffffffffffffff',
    }
    const reads: string[] = []
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      const match = url.match(/^\/api\/works\/(\d+)\/thumb\?/)
      if (match) {
        reads.push(url)
        return {
          ok: true,
          status: 200,
          blob: async () => new Blob([hashes[match[1]!]!], { type: 'image/jpeg' }),
        } as Response
      }
      return inner(url, init)
    })
    await renderApp()
    await goNav('作品')
    await clickByText('多选')
    const cells = [...container.querySelectorAll<HTMLButtonElement>('.gallery-cell')]
    await act(async () => { cells[0]!.click() })
    const similar = container.querySelector(
      '[aria-label="找相似照片"]',
    ) as HTMLButtonElement
    expect(similar.disabled).toBe(false)
    await act(async () => {
      similar.click()
      await new Promise(r => setTimeout(r, 0))
    })
    await vi.waitFor(() => {
      expect(container.textContent).toContain('找到 1 张相近照片')
    })
    expect(container.querySelectorAll('input[aria-label="选中这张作品"]:checked')).toHaveLength(2)
    expect(reads).toHaveLength(3)
    expect(reads.every(url => url.includes('/thumb?'))).toBe(true)
  })

  it('★ 挑最好：比较清晰度与曝光后只选中推荐的一张', async () => {
    const now = Date.now()
    withWorks([
      { ...WORK(201, now, '模糊那张') },
      { ...WORK(202, now - 1_000, '清晰那张') },
      { ...WORK(203, now - 2_000, '曝光偏了') },
    ])
    const inner = fetchMock.getMockImplementation()!
    const metrics: Record<string, object> = {
      '201': { sharpness: 120, exposure: 0.8, clipping: 0.01, meanLuma: 0.5 },
      '202': { sharpness: 1200, exposure: 0.95, clipping: 0.005, meanLuma: 0.52 },
      '203': { sharpness: 800, exposure: 0.2, clipping: 0.25, meanLuma: 0.1 },
    }
    const reads: string[] = []
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      const match = url.match(/^\/api\/works\/(\d+)\/thumb\?/)
      if (match) {
        reads.push(url)
        return {
          ok: true,
          status: 200,
          blob: async () => new Blob([JSON.stringify(metrics[match[1]!])], {
            type: 'application/json',
          }),
        } as Response
      }
      return inner(url, init)
    })
    await renderApp()
    await goNav('作品')
    await clickByText('多选')
    const cells = [...container.querySelectorAll<HTMLButtonElement>('.gallery-cell')]
    await act(async () => { cells[0]!.click(); cells[1]!.click(); cells[2]!.click() })
    const best = container.querySelector(
      '[aria-label="从选中里挑最好"]',
    ) as HTMLButtonElement
    expect(best.disabled).toBe(false)
    await act(async () => {
      best.click()
      await new Promise(r => setTimeout(r, 0))
    })
    await vi.waitFor(() => {
      expect(container.textContent).toContain('推荐「清晰那张」')
    })
    const checked = [...container.querySelectorAll<HTMLInputElement>(
      'input[aria-label="选中这张作品"]:checked',
    )]
    expect(checked).toHaveLength(1)
    expect(checked[0]!.closest('.gallery-item')?.textContent).toContain('清晰那张')
    expect(reads).toHaveLength(3)
    expect(reads.every(url => url.includes('/thumb?'))).toBe(true)
  })

  it('★ 智能复查：本机分析选中作品，只写保留 / 复查标记，不删除', async () => {
    const now = Date.now()
    withWorks([
      WORK(301, now, '清晰那张'),
      WORK(302, now - 1_000, '模糊那张'),
      WORK(303, now - 2_000, '曝光偏了'),
    ])
    const metrics: Record<string, object> = {
      '301': { sharpness: 1_200, exposure: 0.95, clipping: 0.005, meanLuma: 0.52 },
      '302': { sharpness: 600, exposure: 0.8, clipping: 0.01, meanLuma: 0.5 },
      '303': { sharpness: 800, exposure: 0.2, clipping: 0.25, meanLuma: 0.1 },
    }
    const flagPosts: { items: { id: number; flag: number }[] }[] = []
    const inner = fetchMock.getMockImplementation()!
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      const thumb = url.match(/^\/api\/works\/(\d+)\/thumb\?/)
      if (thumb) {
        return {
          ok: true,
          status: 200,
          blob: async () => new Blob([JSON.stringify(metrics[thumb[1]!])], {
            type: 'application/json',
          }),
        } as Response
      }
      if (url === '/api/works/flag' && init?.method === 'POST') {
        const body = JSON.parse(String(init.body)) as {
          items: { id: number; flag: number }[]
        }
        flagPosts.push(body)
        return jsonResponse({
          flagged: body.items.map(item => item.id),
          missing: [],
        })
      }
      return inner(url, init)
    })
    await renderApp()
    await goNav('作品')
    await clickByText('多选')
    const cells = [...container.querySelectorAll<HTMLButtonElement>('.gallery-cell')]
    await act(async () => {
      cells[0]!.click()
      cells[1]!.click()
      cells[2]!.click()
      await new Promise(r => setTimeout(r, 0))
    })

    await clickByText('智能复查')

    await vi.waitFor(() => {
      expect(container.textContent).toContain('2 张建议保留')
      expect(container.textContent).toContain('1 张建议复查')
    })
    expect(flagPosts).toHaveLength(1)
    expect(flagPosts[0]!.items).toEqual([
      { id: 301, flag: 1 },
      { id: 302, flag: 1 },
      { id: 303, flag: -1 },
    ])
    expect(fetchMock.mock.calls.some(([url, init]) => (
      url === '/api/works/delete' && init?.method === 'POST'
    ))).toBe(false)
  })

  it('★ 全屏看片：方向键切换，数字键直接评分，Esc 退出', async () => {
    const now = Date.now()
    withWorks([
      WORK(1, now, '甲'),
      WORK(2, now - 1_000, '乙'),
      WORK(3, now - 2_000, '丙'),
    ])
    const inner = fetchMock.getMockImplementation()!
    let rated: unknown = null
    let flagged: unknown = null
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === '/api/works/2' && init?.method === 'PATCH') {
        const body = JSON.parse(String(init.body)) as { rating?: number; flag?: number }
        if (body.flag !== undefined) {
          flagged = body
          return jsonResponse({ ...WORK(2, now - 1_000, '乙'), flag: body.flag })
        }
        rated = body
        return jsonResponse({ ...WORK(2, now - 1_000, '乙'), rating: body.rating })
      }
      return inner(url, init)
    })
    await renderApp()
    await goNav('作品')

    await act(async () => {
      (container.querySelector('[aria-label="全屏看 甲"]') as HTMLButtonElement).click()
    })
    expect(container.querySelector('.cull-lightbox')).toBeTruthy()
    expect(container.textContent).toContain('1 / 3')

    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight' }))
      await new Promise(r => setTimeout(r, 0))
    })
    expect(container.textContent).toContain('乙')
    expect(container.textContent).toContain('2 / 3')

    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'p' }))
      await new Promise(r => setTimeout(r, 0))
    })
    await vi.waitFor(() => expect(flagged).toEqual({ flag: 1 }))

    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: '5' }))
      await new Promise(r => setTimeout(r, 0))
    })
    await vi.waitFor(() => expect(rated).toEqual({ rating: 5 }))

    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    })
    expect(container.querySelector('.cull-lightbox')).toBeNull()
  })

  it('一张作品都没有时，说的是一句有出路的话，不是白屏', async () => {
    withWorks([])
    await renderApp()
    await goNav('作品')
    expect(container.querySelector('.gallery')).toBeTruthy()
    expect(container.textContent).toContain('还没有作品')
    // ★ 2026-10-11（设计跟进 T5）：出路从"指方位的一句话"（「左边点「修图」，
    //   做一张试试。」）换成和对话列表空态**同款**的一颗按钮 —— 窄屏上左栏
    //   在底下，"左边"指的是错的方向；一颗真能点的按钮不受版面影响。
    //   ⚠️ 旧那句话连**类名**一起退役（`.gallery-hint` 在这页上不再有落点）。
    expect(container.querySelector('.gallery-hint')).toBeNull()
    const go = [...container.querySelectorAll('button')]
      .find(b => (b.textContent ?? '').trim() === '去改一张') as HTMLButtonElement | undefined
    expect(go, '空态里没有那颗「去改一张」—— 用户看到"还没有作品"之后没有下一步').toBeTruthy()

    await act(async () => { go!.click(); await new Promise(r => setTimeout(r, 0)) })
    // 真的把人送到了"能改图"的地方（作品页整个让位、落到修图页的上传前那一屏）
    expect(location.pathname).toBe('/app')
    expect(container.querySelector('.gallery')).toBeNull()
    expect(container.querySelector('.welcome')).toBeTruthy()
  })

  it('零作品时先收起高级创作工具，需要时再展开', async () => {
    withWorks([])
    await renderApp()
    await goNav('作品')

    const workbench = container.querySelector('.gallery-workbench') as HTMLElement
    const toggle = container.querySelector('.gallery-tools-toggle') as HTMLButtonElement
    expect(toggle).toBeTruthy()
    expect(toggle.textContent).toContain('创作工具')
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    expect(workbench.classList.contains('empty-collapsed')).toBe(true)

    await act(async () => {
      toggle.click()
      await new Promise(r => setTimeout(r, 0))
    })
    expect(toggle.getAttribute('aria-expanded')).toBe('true')
    expect(workbench.classList.contains('empty-collapsed')).toBe(false)
    expect(workbench.textContent).toContain('批量处理')
  })

  it('作品页打不开：居中的一句 + 一颗「再试一次」，点了就重新 fetch（第一次 500、第二次成功）', async () => {
    // ★ 2026-10-11：错误态从"左上角红字 + 一句劝人刷新"改成**和空态同一副样子**
    //   （居中一句 + 一颗按钮）。那颗按钮不是装样子：它把这一页**同一个请求**
    //   原样再跑一遍 —— 「刷新一下页面，再试一次。」那句整个退役（它把"那怎么办"
    //   推给浏览器，而这一页自己给得起出路）。
    let listGets = 0
    const inner = fetchMock.getMockImplementation()!
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === '/api/works' && (init?.method ?? 'GET') === 'GET') {
        listGets += 1
        if (listGets === 1) {
          return jsonResponse({ error: { code: 'INTERNAL', message: 'SENTINEL-列表读不出来' } }, 500)
        }
        return jsonResponse({ works: [WORK(1, 1_700_000_000_000)] })
      }
      return inner(url, init)
    })
    await renderApp()
    await goNav('作品')

    // 居中的那一件：`.empty-state` 是空态那一组长相（`text-align: center` 在它身上），
    // `.error-state` 是这一族里的"打不开"（18vh 那口气也照空态）。
    const err = container.querySelector('.error-state.empty-state')
    expect(err?.textContent ?? '').toContain('SENTINEL-列表读不出来')
    // ★ 退役的那句**一个字都不许再出现**（`?? ''`：元素在不在都要红成一句人话）
    expect(container.textContent).not.toContain('刷新一下页面')

    await clickByText('再试一次')
    // **真的重新发了一次**（只把红字收掉、底下一动不动的话，这句当场红）
    expect(listGets).toBe(2)
    // 第二次成了 → 名单摆出来，错误态整个让位
    expect(container.querySelectorAll('.gallery-cell')).toHaveLength(1)
    expect(container.querySelector('.error-state')).toBeNull()
  })

  it('搜不到时说的是"没找到"＋换个字试试 —— 和"一张都没有"不是同一件事', async () => {
    const day = new Date('2026-09-25T14:30:00').getTime()
    withWorks([WORK(1, day)])
    await renderApp()
    await goNav('作品')

    const box = container.querySelector('.gallery-search') as HTMLInputElement
    await typeIn(box, '根本没有的字')
    const none = container.querySelector('.gallery-none')
    // `?? ''`：元素整个不在了的时候，要红成 `expected '' to contain …`，
    // 而不是 vitest 那句"参数组合非法"—— 后者看不见是谁在守什么。
    expect(none?.textContent ?? '').toContain('没找到')
    expect(none?.textContent ?? '').toContain('换个字')
    // "筛掉了"和"一张都没有"是两件事 —— 说错了用户会以为东西丢了
    expect(container.querySelector('.gallery-empty')).toBeNull()
  })

  it('★ 选中两张作品可一键进入左右对比', async () => {
    const now = Date.now()
    withWorks([WORK(1, now, '甲'), WORK(2, now - 1_000, '乙'), WORK(3, now - 2_000, '丙')])
    await renderApp()
    await goNav('作品')
    await clickByText('多选')

    const cells = [...container.querySelectorAll<HTMLButtonElement>('.gallery-cell')]
    await act(async () => {
      cells[0]!.click()
      cells[1]!.click()
      await new Promise(r => setTimeout(r, 0))
    })
    const compare = container.querySelector(
      '[aria-label="对比选中的两张"]',
    ) as HTMLButtonElement
    expect(compare).toBeTruthy()
    expect(compare.disabled).toBe(false)

    await act(async () => {
      compare.click()
      await new Promise(r => setTimeout(r, 0))
    })

    expect(container.querySelector('.cull-lightbox')).toBeTruthy()
    expect(container.querySelector('.cull-stage.comparing')).toBeTruthy()
    expect(container.querySelector('.cull-compare-base')?.getAttribute('alt')).toBe('甲')
    expect(container.querySelector('.cull-compare-top img')?.getAttribute('alt')).toBe('乙')
  })
})

/**
 * ★ 2026-10-10：作品页的**多选批删** + **按大小排**（A 路调研点名"全仓最便宜的一笔"：
 * 后端 `deleteWorks` + 测试一直全齐、零调用方，缺的只是这屏勾选框）。
 * 形状照对话列表那一套（`SessionsPage` 的选择模式 + `kit/SelectBar`），
 * 但删除走**批量接口**（一次往返；它自己会"逐条删、如实回报"）。
 */
describe('★（10-10）作品页：多选批删 + 按大小排', () => {
  const T1 = 1_700_000_000_000
  const T2 = T1 - 86_400_000
  const T3 = T2 - 86_400_000

  /**
   * 盖上"批量删"那条路（`POST /api/works/delete`）—— 照 `withWorks` 那条的形状
   * （只加不改，别的请求走原来的实现）。返回体就是服务端的形状
   * `{ deleted, missing }`（§3.5 的"如实回报"）；请求体里的 ids 记下来给断言用。
   */
  function withDeleteWorks(reply: unknown, status = 200) {
    const calls: number[][] = []
    const inner = fetchMock.getMockImplementation()!
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === '/api/works/delete') {
        calls.push((JSON.parse(String(init?.body)) as { ids: number[] }).ids)
        return jsonResponse(reply, status)
      }
      return inner(url, init)
    })
    return calls
  }

  /** 进选择模式 + 勾上第 n 张（0 起）。 */
  async function pickWorks(...indexes: number[]) {
    await clickByText('多选')
    const picks = [...container.querySelectorAll('.gallery-pick')] as HTMLInputElement[]
    await act(async () => {
      for (const i of indexes) picks[i]!.click()
      await new Promise(r => setTimeout(r, 0))
    })
  }

  it('★ 勾两张 → 删除 → 确认：一次请求删掉它们，名单里当场没了', async () => {
    withWorks([WORK(1, T1, '甲'), WORK(2, T2, '乙'), WORK(3, T3, '丙')])
    const delCalls = withDeleteWorks({ deleted: [1, 3], missing: [] })
    await renderApp()
    await goNav('作品')

    await pickWorks(0, 2)                        // 勾「甲」和「丙」
    expect(container.textContent).toContain('已选 2 张')

    await clickByText('删除')                    // 先问一句（和对话列表同一条规矩）
    expect(container.textContent).toContain('删掉选中的 2 张？')
    await clickByText('确认删除')

    expect(delCalls).toEqual([[1, 3]])           // 一次请求带上两个 id（批量接口）
    // 名单里**当场**没了：等下次刷新才消失的话，用户会以为没删掉
    const cells = [...container.querySelectorAll('.gallery-cell')].map(c => c.textContent ?? '')
    expect(cells).toHaveLength(1)
    expect(cells[0]).toContain('乙')
    // 删完退出选择模式（勾选框和操作条一起收）
    expect(container.querySelector('.gallery-pick')).toBeNull()
    expect(container.querySelector('.gallery-select')).toBeNull()
  })

  it('★ 服务端说"本来就不在"的（missing）也当场清掉 —— 结果一样是"它没了"', async () => {
    withWorks([WORK(1, T1, '甲'), WORK(2, T2, '乙')])
    withDeleteWorks({ deleted: [1], missing: [2] })
    await renderApp()
    await goNav('作品')

    await pickWorks(0, 1)
    await clickByText('删除')
    await clickByText('确认删除')

    // 两张都从名单里走（missing 是"目标已达成"——它本来就不在了）
    expect(container.querySelectorAll('.gallery-cell')).toHaveLength(0)
  })

  it('★ 删失败：名单原样、勾还在、上面加一句"再试一次"（不清场）', async () => {
    withWorks([WORK(1, T1, '甲'), WORK(2, T2, '乙')])
    withDeleteWorks({ error: { code: 'INTERNAL', message: 'SENTINEL-删不动' } }, 500)
    await renderApp()
    await goNav('作品')

    await pickWorks(0, 1)
    await clickByText('删除')
    await clickByText('确认删除')

    expect(container.querySelectorAll('.gallery-cell')).toHaveLength(2)  // 名单一个字节没动
    expect(container.textContent).toContain('再试一次')                  // 有出路（§3.7）
    expect(container.textContent).toContain('已选 2 张')                 // 勾还在 —— 直接再点一次就是重试
  })

  it('★ 选择模式里点格子 = 勾选，不进详情页（微信式）', async () => {
    withWorks([WORK(1, T1, '甲')])
    await renderApp()
    await goNav('作品')

    await clickByText('多选')
    await act(async () => {
      (container.querySelector('.gallery-cell') as HTMLElement).click()
      await new Promise(r => setTimeout(r, 0))
    })

    expect(location.pathname).toBe('/app/works')      // 没跳详情
    expect(container.textContent).toContain('已选 1 张')
  })

  it('★ 按大小排：最大的排最前、每格带上大小；切回"按时间"还是分组那副样子', async () => {
    withWorks([
      { ...WORK(1, T1, '小的'), bytes: 500 },
      { ...WORK(2, T2, '大的'), bytes: 9_000_000 },
      { ...WORK(3, T3, '中的'), bytes: 2_000 },
    ])
    await renderApp()
    await goNav('作品')
    // 默认按时间：最新的「小的」在最前
    expect((container.querySelector('.gallery-cell')?.textContent ?? '')).toContain('小的')

    await clickByText('按大小')
    const cells = [...container.querySelectorAll('.gallery-cell')]
    expect(cells[0]!.textContent).toContain('大的')
    expect(cells[1]!.textContent).toContain('中的')
    expect(cells[2]!.textContent).toContain('小的')
    // 大小写在格子上（口径和用户管理页那个用量图**同一份** formatSize）
    expect(container.textContent).toContain(formatSize(9_000_000))
    // 按大小模式下不分天（分组的前提是时间序）
    expect(container.textContent).toContain('按大小 · 3 张')

    await clickByText('按时间')
    expect(container.textContent).not.toContain(formatSize(9_000_000))   // 大小不常驻
    expect((container.querySelectorAll('.gallery-day-title')).length).toBeGreaterThan(1)  // 分组回来了
  })
})

describe('作品详情页：这张图怎么来的', () => {
  /** 打开第 1 张作品的详情页。 */
  async function openWork(recipe?: unknown) {
    const inner = fetchMock.getMockImplementation()!
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === '/api/works') return jsonResponse({ works: [WORK(1, 1_700_000_000_000)] })
      if (url === '/api/works/1' && (init?.method ?? 'GET') === 'GET') {
        return jsonResponse({
          id: 1, alias: null, createdAt: 1_700_000_000_000, updatedAt: 1_700_000_000_000,
          bytes: 100, hasThumb: true, rating: 0, flag: 0,
          recipe: recipe ?? { params: { ...ZERO, exposure: 20, contrast: 5 }, edits: ['把后面那个人去掉'] },
        })
      }
      return inner(url, init)
    })
    await renderApp()
    await goNav('作品')
    await act(async () => {
      (container.querySelector('.gallery-cell') as HTMLButtonElement).click()
      await new Promise(r => setTimeout(r, 0))
    })
  }

  it('★ 配方是两栏，而且 AI 那栏**没有**「套用」按钮', async () => {
    await openWork()
    const boxes = [...container.querySelectorAll('.recipe-box')]
    expect(boxes.map(b => b.querySelector('h3')?.textContent)).toEqual(['调色', '用 AI 做的'])
    expect(boxes[0]!.textContent).toContain('亮度')          // §3.5.2：不是「曝光」
    expect(boxes[0]!.textContent).toContain('+20')
    // ★ 调色那栏的按钮数是个**产品事实**，所以按名字列出来（不是数个数）：
    //   原来这里写的是 `toBe(1)`（"调色那栏有「套用」"）—— 2026-10-10 加了
    //   「把这套存成预设」（§5.4）之后它红了一瞬，那是**该红**：多一颗按钮
    //   就该有人看一眼是谁加的、摆对地方没有。列名字的写法连"换了一颗"也挡得住。
    expect([...boxes[0]!.querySelectorAll('button')].map(b => (b.textContent ?? '').trim()))
      .toEqual(['把这套调色套用到我正在改的图', '把这套存成预设'])
    // ★ AI 那栏一个按钮都没有 —— 给了就是骗人（§3.5.1）
    expect(boxes[1]!.querySelectorAll('button').length).toBe(0)
    expect(boxes[1]!.textContent).toContain('把后面那个人去掉')
    // ★ M8：两栏下面的**小字**也是设计的一部分（§3.5.1 那张图里就画着它们），
    //   和 `h3` 一样钉住。"配方能带走、经历带不走"这件事**全靠这两句话讲给用户听** ——
    //   只钉 h3 挡不住谁把第二栏的小字改成"这一套也能套到别的图上"（那就成了骗人：
    //   「把后面那个人去掉」换一张照片就是另一回事）。
    //   变异：各自改一句 → 各自那一条红（两条是互为反面的半句，谁被改都会当场露出来）。
    expect(boxes[0]?.querySelector('.recipe-note')?.textContent).toContain('能套到别的图上')
    expect(boxes[1]?.querySelector('.recipe-note')?.textContent).toContain('套不到别的图上')
    // ★ **详情页和作品页得叫同一个名字**（§3.5：「名字」只有一份，搜日期才等于按日期搜）。
    //   夹具是 2023-11（见 `openWork`）、今年是 2026，所以 `dayLabel` **一定**会补上年份。
    //   变异：把 `workName(work, now)` 改回 `workName(work, work.updatedAt)` → 这一条红，
    //   而其余**六条**一声不吭 —— 这正是它当初会漏掉的原因。（"六条"随这个 describe
    //   的条数走：写这句话时是 4 条 → 补了「套用真的生效」和「打不开这一张」之后是 6 条
    //   → 终审 C1 补了「大图和下载都是原图」之后是 7 条。）
    expect(container.querySelector('.detail-name')!.textContent).toContain('2023年')
  })

  it('★ 大图和「下载到我的电脑」拿到的都得是**原图**，不是 160px 缩略图（终审 C1）', async () => {
    // ★ 这一页原来两处都调 `fileUrl()` —— 而它在 `hasThumb` 时回 `/thumb`，缩略图
    //   是个小图（当时是 ≤160px 的 `THUMB_MAX_SIDE`，2026-09-25 起作品页那张改成
    //   ≤480px 的 `GALLERY_THUMB_MAX_SIDE` —— 但不管多大，它都不是原图），
    //   且每次保存都顺手带一张，**几乎总是存在**。
    //   于是「点开一张 → 看大图」（§3.5）看到的是一张小图；而「下载到我的电脑」下到的
    //   也是同一张 —— 那正是 §3.4 拿掉"保存自动下载"之后，用户把**原图**拿出
    //   服务器的唯一一个动作（§3.5 的「先下载到本地再删，东西就不会丢」全押在它上面）。
    //   夹具的 updatedAt 是 1_700_000_000_000，所以 `?v=` 也一起钉住：少掉版本号，
    //   浏览器会给长缓存里的**上一版**（替换过之后 id 不变）。
    await openWork()
    // ⚠️ 按**类名**找（结构），两条都带 `?.` —— 元素不在时红成
    //   `expected undefined to ...`，而不是 `Cannot read properties of undefined`。
    const img = container.querySelector('.detail-image') as HTMLImageElement | null
    expect(img?.getAttribute('src')).toMatch(/^\/api\/works\/1\/file\?v=1700000000000$/)

    const dl = container.querySelector('.detail-download') as HTMLAnchorElement | null
    // 变异：两处改回 `fileUrl(work)` → 上面这两条红（拿到的会是 `/thumb`）
    expect(dl?.getAttribute('href')).toMatch(/^\/api\/works\/1\/file\?v=1700000000000$/)
    // M2：`<a download>` 必须**带值**。不带值时浏览器拿 URL 末段当文件名 —— 现在是
    // `file`，下下来是个没有扩展名、手机相册认不出的东西（编辑页那条是 `p_xxx.jpg`）。
    // 变异：把 `download={downloadName(work)}` 换回裸的 `download` → 这一条红
    // （`getAttribute('download')` 回的是空串）；把 `downloadName` 里的
    // `buildFilename` 去掉 → 下一条红。
    expect(dl?.getAttribute('download') ?? '').toMatch(/\.jpg$/)
    expect(dl?.getAttribute('download') ?? '').not.toBe('file')
    // ★ 2026-10-11（设计跟进 T4）：「把图拿到手」这一个动作**全站只有一个名字** ——
    //   按钮上的字从「下载到我的电脑」收成朴素的「下载」（顶栏那一格也是它）。
    //   变异：改回任意旧叫法 → 这一条红。
    expect((dl?.textContent ?? '').trim()).toBe('下载')
  })

  it('★ 改个中文名，网址一动不动（§3.5.1）', async () => {
    await openWork()
    const before = location.pathname + location.search
    const inner = fetchMock.getMockImplementation()!
    let patches = 0
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === '/api/works/1' && init?.method === 'PATCH') {
        patches += 1
        return jsonResponse({
          id: 1, alias: '海边那张', createdAt: 0, updatedAt: 0, bytes: 0,
          hasThumb: true, rating: 0, flag: 0,
        })
      }
      return inner(url, init)
    })

    // ⚠️ 按**类名**找，不按文案找 —— 和「套用」那条同一条规矩：
    //   原来是 `[...buttons].find(b => b.textContent.includes('改名'))!`，
    //   按钮不在时红的是 `Cannot read properties of undefined (reading 'click')` ——
    //   那是"**测试自己**坏了"的语气，可实际发生的是"那个按钮没了"。
    const btn = container.querySelector('.detail-rename') as HTMLButtonElement | null
    expect(btn?.textContent ?? '').toContain('改名')      // 文案单独一条钉住
    await act(async () => { btn?.click(); await new Promise(r => setTimeout(r, 0)) })
    const box = container.querySelector('.rename-input') as HTMLInputElement | null
    expect(box).toBeTruthy()      // 点完得真的进到"改名中"，不然下面崩在 null 上、红得看不懂
    box!.value = '海边那张'
    await act(async () => {
      box!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
      await new Promise(r => setTimeout(r, 0))
    })

    expect(container.textContent).toContain('海边那张')   // 名字变了……
    expect(location.pathname + location.search).toBe(before)   // ★ ……网址一点没变
    // ★ **改名请求只能发一次。** 两条保存路径（回车走 `onKeyDown`、点走别处走 `onBlur`）
    //   都会调用 `doRename`；而回车会把输入框收掉 —— **输入框是在"有焦点"的状态下被卸载的**。
    //   浏览器这时候会不会补一个 blur/focusout，各家实现不一致，jsdom 和真浏览器也可能不同。
    //   补了就是**两次 PATCH**，第二次用的还是 rename 之前那个 `work` 闭包。
    //   这条断言把那个不确定性变成**当场可观察**的：真发两次，这里就红。
    expect(patches).toBe(1)
  })

  it('★ 没有图的时候「套用调色」是禁用的，而且说了为什么（裁定 ⑤）', async () => {
    await openWork()   // 注意：这里**没有** uploadPhoto()，所以修图页还是空的
    // ⚠️ 按**类名**找，不按文案找：`.recipe-apply` 是结构，文案是文案。
    //   原来是 `[...buttons].find(b => b.textContent.includes('套用到'))!` ——
    //   元素不在时 `.find` 回 undefined，红出来的是
    //   `Cannot read properties of undefined (reading 'disabled')`，那是
    //   "**测试自己**坏了"的语气；可实际发生的事是"那个按钮没了"。
    //   带上 `?.` 之后，这条会红成 `expected undefined to be true` —— 谁在守什么一眼看得见
    //   （同一套写法见「搜不到时」那条的 `none?.textContent ?? ''`）。
    const apply = container.querySelector('.recipe-apply') as HTMLButtonElement | null
    expect(apply?.disabled).toBe(true)
    // 文案单独一条钉住：改措辞仍然会被看见，但红得干净 ——
    // "少了个类名（结构变了）"和"改了句话（措辞变了）"从此分得开。
    expect(apply?.textContent ?? '').toContain('套用到')
    expect(container.textContent).toContain('先回修图页传一张照片')
  })

  it('★ 套用真的生效：配方跟着人回到修图页，画布上就是那一套', async () => {
    // ★ 这一条补的是一个**真实缺口**：brief 的四条只测了"没图时禁用"，
    //   而这一页存在的**理由**就是"把那套调色带走"（§3.5.1）—— 那件事本身零覆盖
    //   （Task 12 收尾时唯一的证据是一把用完就删的真浏览器探针）。
    //   链路：传图（`canApply` 为真）→ 作品页 → 详情页 → 点「套用」→ **落在修图页**
    //   且**画布收到的 params 就是配方里那套**（不是 ZERO、也不是上一步的旧值）。
    await renderApp()
    await uploadPhoto()          // 先让修图页有图 —— 没有这一步按钮就该是灰的
    await openWork()             // 它自己会再 renderApp 一次（同一棵树，状态不动）+ 切到作品页

    const apply = container.querySelector('.recipe-apply') as HTMLButtonElement | null
    expect(apply?.disabled).toBe(false)     // 有图了就能套（和上一条互为反面）
    await act(async () => {
      apply!.click()
      await new Promise(r => setTimeout(r, 0))
    })

    // 人确实回到了修图页：配方那一页整个不在了，修图界面回来了
    expect(container.querySelector('.recipe-box')).toBeNull()
    expect(container.querySelector('.workspace')).toBeTruthy()
    expect(location.pathname).toBe('/app')
    // ★ 下半句才是重点：画布上真的是配方里那套。
    //   变异：App.tsx 的 `setParams(p)` → `setParams(ZERO)` → 只有这一条红
    //   （上面三句照样绿 —— 导航那半件事不受影响）。
    expect(canvasProps.props.at(-1)?.params).toEqual({ ...ZERO, exposure: 20, contrast: 5 })
  })

  it('详情页 404：说「这张作品不在了。」+「回作品」按钮 —— 不再出现「刷新一下页面」', async () => {
    // ★ 2026-10-11：404 和"网络抖了一下"是**两件事**。404 是**它没了** ——
    //   劝人再试一次是骗人（再点一百次也回不来），出路是回列表。
    //   ⚠️ 判据看 **HTTP 状态**，夹具照线上真实的形状：`server/works.ts` 扔的是
    //   `new HttpError('BAD_REQUEST', '没有这张作品', 404)` —— body 里的 code 是
    //   `BAD_REQUEST`（`AppErrorCode` 里根本没有"找不到"这一档），
    //   "它不在"这个事实**只在状态行上**（见 `api/client.ts` 的 `ApiError.status`）。
    const inner = fetchMock.getMockImplementation()!
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === '/api/works') return jsonResponse({ works: [WORK(1, 1_700_000_000_000)] })
      if (url === '/api/works/1' && (init?.method ?? 'GET') === 'GET') {
        return jsonResponse({ error: { code: 'BAD_REQUEST', message: '没有这张作品' } }, 404)
      }
      return inner(url, init)
    })
    await renderApp()
    await goNav('作品')
    await act(async () => {
      (container.querySelector('.gallery-cell') as HTMLButtonElement).click()
      await new Promise(r => setTimeout(r, 0))
    })

    expect(container.querySelector('.error-state')?.textContent ?? '').toContain('这张作品不在了。')
    // ★ 退役的那句**一个字都不许再出现**（和作品页同一天改的口径）
    expect(container.textContent).not.toContain('刷新一下页面')
    // 出路是一颗**按得到的按钮**：回作品列表（`onBack`），不是一句劝
    await clickByText('回作品')
    expect(container.querySelector('.gallery')).toBeTruthy()
    expect(location.pathname).toBe('/app/works')
  })

  it('详情页网络错（非 404）：保留重试按钮 + 同一句话', async () => {
    // 和上面那条**互为反面**：不是 404 的失败不许说"它没了" ——
    //   那可能只是抖了一下，出路就是再试一次（同一个请求原样重跑）。
    //   两句话都由服务端那句（走 `errorText`）兜着：500 时原样显示。
    let gets = 0
    const inner = fetchMock.getMockImplementation()!
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === '/api/works') return jsonResponse({ works: [WORK(1, 1_700_000_000_000)] })
      if (url === '/api/works/1' && (init?.method ?? 'GET') === 'GET') {
        gets += 1
        if (gets === 1) {
          return jsonResponse({ error: { code: 'INTERNAL', message: 'SENTINEL-打不开这一张' } }, 500)
        }
        return jsonResponse({
          id: 1, alias: null, createdAt: 1_700_000_000_000, updatedAt: 1_700_000_000_000,
          bytes: 100, hasThumb: true, rating: 0, flag: 0,
          recipe: { params: { ...ZERO, exposure: 20 }, edits: [] },
        })
      }
      return inner(url, init)
    })
    await renderApp()
    await goNav('作品')
    await act(async () => {
      (container.querySelector('.gallery-cell') as HTMLButtonElement).click()
      await new Promise(r => setTimeout(r, 0))
    })

    // 服务端说的那句话原样在屏幕上（没有被换成「这张作品不在了。」那句）
    const err = container.querySelector('.error-state')
    expect(err?.textContent ?? '').toContain('SENTINEL-打不开这一张')
    expect(err?.textContent ?? '').not.toContain('不在了')

    await clickByText('再试一次')
    expect(gets).toBe(2)                       // 真的重新发了一次
    expect(container.querySelector('.detail-image')).toBeTruthy()
    expect(container.querySelector('.error-state')).toBeNull()
  })

  it('删除确认只说「删了就找不回来了」', async () => {
    await openWork()
    // ⚠️ 同样按**类名**找（见上面「套用」「改名」两条）：`.find(...)!` 那种写法在
    //   按钮不在时崩成 `Cannot read properties of undefined (reading 'click')`。
    const del = container.querySelector('.detail-delete') as HTMLButtonElement | null
    expect(del?.textContent ?? '').toContain('删除')      // 文案单独一条钉住
    await act(async () => { del?.click(); await new Promise(r => setTimeout(r, 0)) })

    // ⚠️ **只扫确认框那一段，不是整个 container。** 整屏里本来就站着别处一大片字
    //   （大图、几颗按钮、下面那张配方表）—— 拿整屏去跑 `not.toContain('你电脑')`，
    //   赌的是**别处**文案恰好不含这两个词，不是在校验确认框说了什么。
    //   ★ 2026-10-11：这段原来举的例子是当时那颗「下载到我的电脑」（它就挨着
    //   确认框；后来随「下载」统一改了名）—— 例子过时、道理不变：两种写法今天
    //   都能过，靠的正是"别处恰好没有这两个词"，而不是这条断言真的钉住了什么。
    const confirm = container.querySelector('.detail-confirm')
    expect(confirm).toBeTruthy()   // 点完得真的弹出确认 —— 没弹时下面几句会崩在 null 上，红得看不懂
    expect(confirm!.textContent).toContain('删了就找不回来了')
    // ★ 不许说"你电脑上那份还在" —— 服务器**不可能**知道用户本地有没有那张图
    //   （他可能下载过、可能没下载、也可能下载完又删了）。宁可少安慰一句，不能骗人（§3.5）
    expect(confirm!.textContent).not.toContain('你电脑')
    expect(confirm!.textContent).not.toContain('下载的')
  })

  it('★ 老作品的配方只有八根：表里只列真改过的那一行，一个 undefined 都不许有', async () => {
    // 2026-10-04「专业面板」那一轮 Task 6（预检裁定的 Step 2b）—— 会话那条支线的孪生。
    //
    // 作品是 2026-10-04 之前存的：`recipe.params` 里**只有那八根**，新加的那七条
    // （自然饱和度 / 色彩平衡三轴 / 分离色调）在那种行里根本不存在，取出来是
    // `undefined`。而这张表是按 `isChanged` 列的，判据是 `a[k] !== 0` ——
    // `undefined !== 0` 为真，于是**七条新参数全被判成"改过"**，每一行渲染出
    // 一个「自然饱和度 undefined」。真改过的那一行淹没在七行幽灵里，
    // 而那些字用户根本读不懂（这一页要回答的是"这张图是怎么来的"）。
    //
    // ⚠️ 夹具里的键**故意只有八个** —— 类型上 `Recipe['params']` 要五十个键，
    //    可**库里老数据真就是这个形状**，老的代码写进去的行不会自己长出七个新键。
    //    `openWork` 收的是 `unknown`，要演的正是这个"类型系统拦不住"的样子。
    const legacyRecipe = {
      params: {
        exposure: 20, contrast: 0, highlights: 0, shadows: 0,
        saturation: 0, temperature: 0, clarity: 0, vignette: 0,
      },
      edits: ['把后面那个人去掉'],
    }
    await renderApp()
    await uploadPhoto()          // 先让修图页有图 —— 没有它「套用」是灰的（下面 ③ 要按它）
    await openWork(legacyRecipe)

    // ① 表里**只有真改过的那一行**（亮度 +20）—— 幽灵行一多，这一句就红
    const rows = [...container.querySelectorAll('.recipe-params li')]
    expect(rows).toHaveLength(1)
    expect(rows[0]?.textContent).toContain('亮度')
    expect(rows[0]?.textContent).toContain('+20')
    // ② 屏幕上不许出现 undefined / NaN —— 幽灵行渲染出来就是「… undefined」这种字
    expect(container.textContent ?? '').not.toContain('undefined')
    expect(container.textContent ?? '').not.toContain('NaN')

    // ③ ★ 「套用」带走的也必须是**归一化过的那一份**：`onApply(params)` 直接进
    //    App 的 `setParams` —— 缺着七个键进状态，调色面板和色轮当场就坏
    //    （和上面那条用例（会话恢复）一模一样的病，只是入口不同）。
    const apply = container.querySelector('.recipe-apply') as HTMLButtonElement | null
    expect(apply?.disabled).toBe(false)
    await act(async () => {
      apply?.click()
      await new Promise(r => setTimeout(r, 0))
    })
    expect(canvasProps.props.at(-1)?.params).toEqual({ ...ZERO, exposure: 20 })
  })

  // ── ★ 2026-10-05（T12，滤镜）：配方里那一行 ──────────────────────────
  // 滤镜也是"这套配方"的一部分：详情页把它列在**同一张表**里，「套到别的图上」
  // 连它一起带走。配方里只存**名字**（id 对已经烤好的图没有意义，见 shared/works.ts），
  // 所以套用时按名字去清单里找现在那一条。

  it('★ 配方里有滤镜：表里多一行「滤镜 黄昏 80%」，套用时连滤镜一起套', async () => {
    // 变异：WorkDetailPage 不渲染那一行 → 头两句红；`onApply` 不把 lut 交出去 → 后两句红。
    vi.mocked(lutsMod.listLuts).mockResolvedValue({ luts: [HUANGHUN] })
    await renderApp()
    await uploadPhoto()                       // 「套到别的图上」要有照片才可用
    await openWork({ params: { ...ZERO }, edits: [], lut: { name: '黄昏', amount: 80 } })

    // ① 一行，而且就在那张表里（`.recipe-params`）—— 能带走的东西只有一处，
    //    新起一块就成了两处（"滤镜也是配方"这件事本身也一起丢了）。
    //    `?.` + `?? ''`：元素不在时要红成"少了一行"，不是测试自己崩在 null 上。
    const row = container.querySelector('.recipe-params li')
    expect(row?.querySelector('.recipe-param-name')?.textContent).toBe('Lut')
    expect(row?.querySelector('.recipe-param-value')?.textContent).toBe('黄昏 80%')
    // ② ★ 有滤镜就不是"原样" —— 哪怕五十个参数一个都没动（这份配方就是全 ZERO）。
    //    判据漏了滤镜的话，屏幕上会一边列着「滤镜 黄昏」一边说"没有调过色"。
    expect(container.textContent ?? '').not.toContain('这一张是原样')

    const apply = container.querySelector('.recipe-apply') as HTMLButtonElement | null
    await act(async () => {
      apply?.click()
      await new Promise(r => setTimeout(r, 0))
    })
    // ③ 连滤镜一起套：那一格是亮的，强度也是 80（不是选中时的默认 100）。
    await goNav('调色')
    await openLutPanel()
    expect(tileNamed('黄昏').getAttribute('aria-pressed')).toBe('true')
    const range = lutSection().querySelector('input[type="range"]') as HTMLInputElement
    expect(range.value).toBe('80')
  })

  it('★ 那张作品的滤镜已经删了：只套调色，手上那层也清掉，并把这件事说出来', async () => {
    // 清单里只剩另一条（黄昏被删了），而用户手上正套着它。套用之后：
    //   · 调色那半照常套上；
    //   · 手上那层颜色**清掉**（2026-10-05 审查裁定：这一格是**替换**、不是合并 ——
    //     作品那套参数是在**黄昏**下调出来的，再叠一个无关的夕阳，出来的画面
    //     两边都不是；而且套完再存一次，新作品的配方会悄悄记上那个被带来的夕阳）；
    //   · 少掉的那半**说出来** —— 不说的话他就是对着一个不是那张作品的样子，
    //     还以为整个配方都套上了。
    // 变异：miss 分支不清手上那层（或压根不调 noticeBad）→ ② / ③ 红。
    vi.mocked(lutsMod.listLuts).mockResolvedValue({ luts: [{ ...HUANGHUN, id: 2, name: '夕阳' }] })
    await renderApp()
    await uploadPhoto()
    await goNav('调色')
    await openLutPanel()
    await act(async () => { tileNamed('夕阳').click(); await new Promise(r => setTimeout(r, 0)) })
    expect(tileNamed('夕阳').getAttribute('aria-pressed')).toBe('true')   // 前提：手上在用

    await openWork({ params: { ...ZERO, exposure: 20 }, edits: [], lut: { name: '黄昏', amount: 80 } })
    const apply = container.querySelector('.recipe-apply') as HTMLButtonElement | null
    await act(async () => {
      apply?.click()
      await new Promise(r => setTimeout(r, 0))
    })

    // ① 调色那半真的套上了（"只套调色"不是一个说法）
    expect(canvasProps.props.at(-1)?.params).toEqual({ ...ZERO, exposure: 20 })
    // ② 把少掉的那半说出来
    expect(container.querySelector('.notice')?.textContent ?? '').toContain('那张作品用的 Lut 已经删了')
    // ③ 手上那层也被清掉 —— 这一格由这张作品的配方**唯一决定**（替换，不是合并）
    await goNav('调色')
    await openLutPanel()
    expect(tileNamed('不用').getAttribute('aria-pressed')).toBe('true')
    expect(tileNamed('夕阳').getAttribute('aria-pressed')).toBe('false')
  })

  it('★ 配方里没有滤镜（老作品连 lut 这个键都没有）：套用时把手上那层清掉', async () => {
    // 两件事一起钉：
    //   ① "配方里没有滤镜" → 手上那层颜色要清掉。不清的话用户看到的画面和
    //      这张作品的配方对不上（它本来就没滤镜），而且一句话都不说。
    //   ② 2026-10-05 之前存的老作品，库里那份 recipe JSON **没有 `lut` 键** ——
    //      `handleGetWork` 原样返回，读出来是 `undefined` 而不是 `null`；
    //      这份夹具故意不写那个键，演的就是这个"类型系统拦不住"的形状
    //      （`WorkDetailPage` 里那句 `?? null` 就是为它写的）。
    // 变异：`onApply` 开头不写 `if (!recipeLut) setLut(null)` → 最后两句红。
    vi.mocked(lutsMod.listLuts).mockResolvedValue({ luts: [HUANGHUN] })
    await renderApp()
    await uploadPhoto()
    // 先在手上套一个滤镜 —— 不然"被清掉"这件事根本没发生（测不到）
    await goNav('调色')
    await openLutPanel()
    await act(async () => { tileNamed('黄昏').click(); await new Promise(r => setTimeout(r, 0)) })
    expect(tileNamed('黄昏').getAttribute('aria-pressed')).toBe('true')   // 前提：手上在用

    await openWork({ params: { ...ZERO, exposure: 20 }, edits: [] })      // ← 没有 lut 键
    const apply = container.querySelector('.recipe-apply') as HTMLButtonElement | null
    await act(async () => {
      apply?.click()
      await new Promise(r => setTimeout(r, 0))
    })
    // 调色那半照常套上（别把整件事一起丢了）
    expect(canvasProps.props.at(-1)?.params).toEqual({ ...ZERO, exposure: 20 })
    await goNav('调色')
    await openLutPanel()
    expect(tileNamed('不用').getAttribute('aria-pressed')).toBe('true')
    expect(tileNamed('黄昏').getAttribute('aria-pressed')).toBe('false')
  })

  // ── ★ 2026-10-10（「我的预设」，设计 §5.4）：配方卡上那颗「把这套存成预设」 ──
  // 第二个存入口（spec §8.1 原话：「看到调得好的一键存下来」）—— 停在**这张作品的
  // 配方**上就能存，不用先"套到手上 → 再回面板头存一遍"。
  // ⚠️ 存的是**配方那套参数**，而且**只有那五十个**（设计 §0：预设不含 Lut）。
  // 那一行的样子（起名 + 存下来）和面板头那块是**同一份**（`PresetSaveRow`）——
  // 抄第二份的话，"成功清空输入框""失败保留刚打的字"这些账会只记在一边。

  it('配方那栏有「把这套存成预设」：点了就地展开起名那一行', async () => {
    // 变异：不渲染那颗按钮 → 前两句红；展开块做成弹窗 → `[role=dialog]` 那条红。
    await openWork()

    // ⚠️ 按**类名**找（结构），文案单独一条钉住 —— 和这一页「套用」「改名」
    //    那几条同一条规矩：按钮不在时要红成"少了一颗按钮"，
    //    不是测试自己崩在 null 上。
    const btn = container.querySelector('.recipe-save-preset') as HTMLButtonElement | null
    expect(btn?.textContent ?? '').toContain('把这套存成预设')
    expect(btn?.getAttribute('aria-expanded')).toBe('false')
    expect(container.querySelector('input.my-presets-name')).toBeNull()   // 起点：收着的

    await act(async () => { btn?.click(); await new Promise(r => setTimeout(r, 0)) })
    expect(btn?.getAttribute('aria-expanded')).toBe('true')

    // **就地**：那一行摊在「调色」那张配方卡里（全站不弹窗）
    const box = [...container.querySelectorAll('.recipe-box')][0]!
    const row = box.querySelector('.my-presets-save')
    expect(row, '起名那一行就摊在配方卡里').toBeTruthy()
    // 摆出来的就是面板头那座「我的预设」的第一行（同一格输入框、同一颗「存下来」）
    expect((row?.querySelector('input') as HTMLInputElement | null)?.placeholder).toBe('给这套起个名…')
    expect((row?.querySelector('button')?.textContent ?? '').trim()).toBe('存下来')
    expect(container.querySelector('[role="dialog"]')).toBeNull()

    // 再点一下 = 收起（就地展开没有"怎么关"的焦虑）
    await act(async () => { btn?.click(); await new Promise(r => setTimeout(r, 0)) })
    expect(container.querySelector('.my-presets-save')).toBeNull()
  })

  it('存下来的是**这份配方的 params**（不是当前修图那套 —— 用户看的正是这份）', async () => {
    // 这一条守的是这个入口的**全部意义**：他是对着**这张作品的配方**按的那颗
    // 按钮。存成"手上正在改的那套"就是骗人 —— 而两套参数在屏幕上长得一模一样
    // （都是几个数字），**只有这一条断言分得开**。
    // 变异：`onSavePreset` 那头换成 App 手上那套（`savePreset(name, params)`）→ 红。
    const store = withPresets([])
    await renderApp()
    await uploadPhoto()
    // 先把修图页那套改成和配方**分得开**的样子（40 ≠ 配方里的 20）
    vi.mocked(api.postRoute).mockResolvedValueOnce(
      decision({ route: 'params', paramDeltas: { exposure: 40 }, reply: '亮了一点。' }))
    await say('亮一点')
    expect(canvasProps.props.at(-1)?.params.exposure, '前提：手上那套不是这张作品的配方').toBe(40)

    // 配方 = { ...ZERO, exposure: 20, contrast: 5 } + 一层 Lut。
    //   ★ Lut 是**故意**放进去的：预设只含那五十个参数、不含 Lut（设计 §0），
    //     下面那句 `toEqual` 是**精确的** —— 多送一个 `lut` 字段就红。
    await openWork({
      params: { ...ZERO, exposure: 20, contrast: 5 },
      edits: ['把后面那个人去掉'],
      lut: { name: '黄昏', amount: 80 },
    })

    const btn = container.querySelector('.recipe-save-preset') as HTMLButtonElement | null
    await act(async () => { btn?.click(); await new Promise(r => setTimeout(r, 0)) })
    // ⚠️ 打字走 `typeIn`（受控输入框：直接 `box.value = …` React 收不到，见它的注释）。
    //    先正面对一句"那格真的在" —— 少了它，按钮不在时红的是 `typeIn` 内部那句
    //    "not a valid instance of HTMLInputElement"（"测试自己坏了"的语气）。
    const nameBox = container.querySelector('input.my-presets-name') as HTMLInputElement | null
    expect(nameBox, '点开那一行之后才有的打字格').toBeTruthy()
    await typeIn(nameBox!, '黄昏旅拍')
    await clickByText('存下来')

    const posts = fetchMock.mock.calls.filter(([u, init]) =>
      u === '/api/presets' && (init as RequestInit | undefined)?.method === 'POST')
    expect(posts).toHaveLength(1)
    // ★ 是**这份配方**（20 / 5），不是手上那套（exposure 40）：整份一起送、一个不多一个不少。
    expect(bodyOf(posts[0]!)).toEqual({
      name: '黄昏旅拍', params: { ...ZERO, exposure: 20, contrast: 5 },
    })
    // 存完真的进了名单（App 那条回调重拉过 —— 不是往本地名单里塞一条），
    // 输入框清空（和面板头那块**同一份**行为：成功才清）。
    expect(store.rows().map(r => r.name)).toContain('黄昏旅拍')
    expect((container.querySelector('input.my-presets-name') as HTMLInputElement).value).toBe('')
  })
})

describe('保存 = 存进作品集（Task 13）', () => {
  /**
   * 点界面上一个按钮。
   *
   * ⚠️ 按**文案**找（和本文件已有的 `goNav` / `topbar` 同一个形状，不另造一套）。
   *   但**不写成 `as HTMLButtonElement` 那种"类型上的谎话"**：按钮不在时
   *   报的是这一句「现在屏幕上只有 …」，而不是 `Cannot read properties of
   *   undefined` —— 后者是"测试自己坏了"的语气，而实际发生的是"那个按钮没了"。
   *   （本项目为这个形状付过三次，见 Task 12 的 F5 / R4。）
   */
  async function clickTop(label: string) {
    const btns = [...container.querySelectorAll('button')]
    const btn = btns.find(b => (b.textContent ?? '').trim() === label) ?? null
    if (!btn) {
      throw new Error(`屏幕上没有「${label}」这个按钮 —— 现在只有 ${
        btns.map(b => (b.textContent ?? '').trim()).join(' / ')}`)
    }
    await act(async () => {
      btn.click()
      // ⚠️ **两轮，不是一轮。** 点「存进作品」之后 App 得先把画布上那个 Blob 读成
      //    data URL 才发得出请求，而这一步（`blobToDataUrl`）走的是 jsdom 的
      //    `FileReader` —— 它把回调排在 **`setImmediate`** 上，和一个
      //    `setTimeout(0)` 谁先谁后**没有保证**（一个是 check 阶段、一个是 timers 阶段）。
      //    只等一轮时实测：那条「存不进去」会偶发停在「准备中…」——
      //    即断言跑的时候 FileReader 还没回调，不是功能坏了。
      //    两轮必然跨过那个 check 阶段，而它之后的整条链（fetch → 解析 → setState）
      //    全是微任务，会在同一轮里走完。
      await new Promise(r => setTimeout(r, 0))
      await new Promise(r => setTimeout(r, 0))
    })
  }

  /** 保存那一条请求的 body（没有就是 undefined）。 */
  function savedBody(): any {
    const call = fetchMock.mock.calls.find(c => c[0] === '/api/works' && c[1]?.method === 'POST')
    return call ? JSON.parse(String(call[1]!.body)) : undefined
  }

  /**
   * ★ 作品页那张缩略图的上限 —— **这是个产品决定，不是一个实现细节**。
   * 和 `shared/account.test.ts` 开头那条规矩一个意思（那里钉的是 `USERNAME_MIN 就是 2`）：
   * 它被改了就应该是这一条红，而不是这一条跟着改。
   *
   * 480 是怎么算出来的（实测，数字在 `.superpowers/sdd/2026-09-25-gallery/thumb-sharpness.json`）：
   *   · `.gallery-thumb` 是 `width: 100%; aspect-ratio: 1/1; object-fit: cover`
   *     —— **一个正方形的框、按宽度铺**，`cover` 的系数是 `max(框宽/图宽, 框高/图高)`，
   *     正方形框里起决定作用的是缩略图的**短边**；而 `makeThumbnail` 限的是**长边**
   *     （`fitWithin`）。**限制的是长边、决定清晰度的是短边** —— 错配就在这儿。
   *   · 竖图（1200×1600）在 `maxSide = 480` 下是 **360×480**，短边 360；格子最宽实测
   *     181 CSS → DPR 2 时要铺 362 设备像素，360 差 0.6%（项目接受的那条线是 1.05×）。
   *   · 160 时短边只有 120：`181/120 = ` **1.51×**（DPR 2 的屏上 3.02×）—— 这就是它糊的原因。
   */
  it('★ 作品页那张缩略图的上限是 480，而且保存时**真的传下去了**', async () => {
    // ① 产品决定本身。变异：把真值（`GALLERY_THUMB_MAX_SIDE`）改回 160 → 这一条红。
    //    真值是从 importOriginal 进来的，所以改真值这里会跟着变 —— 不是"断言的是
    //    mock 里抄的那一份"（那种断言改了真值也不红，等于没守）。
    expect(thumbMod.GALLERY_THUMB_MAX_SIDE).toBe(480)

    // ② 常量对了也白对：`saveOnce` 不传的话 `makeThumbnail` 会回落到默认的 160，
    //    一声不吭。变异：把 App.tsx 那一行的第二个实参去掉 → 这一条红。
    const inner = fetchMock.getMockImplementation()!
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) =>
      (url === '/api/works' && init?.method === 'POST') ? jsonResponse({ id: 9 }) : inner(url, init))
    await renderApp()
    await uploadPhoto()
    await clickTop('存进作品')
    expect(savedBody()).toBeTruthy()     // 先证明那一趟真的走到存了，别让 ② 红在别的原因上
    expect(thumbMod.makeThumbnail).toHaveBeenCalledWith(expect.anything(), 480)
  })

  it('★ 保存时把原文件名和 EXIF 拍摄时间带给作品集', async () => {
    const takenAtMs = new Date(2026, 9, 21, 8, 15, 30).getTime()
    vi.mocked(photoInfo.readLensInfo).mockResolvedValue({
      make: 'SONY',
      model: 'ILCE-7CM2',
      lens: 'FE 50mm F1.4 GM',
      focalMm: 50,
      focal35mm: 50,
      hasExif: true,
      takenAt: '2026-10-21 08:15',
      takenAtMs,
    })
    const inner = fetchMock.getMockImplementation()!
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => (
      url === '/api/works' && init?.method === 'POST'
        ? jsonResponse({ id: 9 })
        : inner(url, init)
    ))

    await renderApp()
    await uploadPhoto()
    await clickTop('存进作品')

    expect(savedBody()).toMatchObject({
      sourceName: 'p.jpg',
      capturedAt: takenAtMs,
      cameraMake: 'SONY',
      cameraModel: 'ILCE-7CM2',
      lensModel: 'FE 50mm F1.4 GM',
    })
  })

  it('★ 点「存进作品」是存进作品集，**没有偷偷下载**（§3.4）', async () => {
    const inner = fetchMock.getMockImplementation()!
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) =>
      (url === '/api/works' && init?.method === 'POST')
        ? jsonResponse({ id: 9 })
        : inner(url, init))

    await renderApp()
    await uploadPhoto()
    await clickTop('存进作品')

    expect(savedBody()).toBeTruthy()
    // ★ 「保存不再自动下载」—— 变异：把 downloadImage 加回保存流程 → 必须红
    expect(saveMod.downloadImage).not.toHaveBeenCalled()
    expect(container.textContent).toContain('存好了')
  })

  it('★ 通报条带 role="status"：读屏能听见「存好了…」这类通报（2026-10-11）', async () => {
    // ★ 设计跟进 T5（spec §二 #6）。`.notice` 是"这件事成了 / 没成"的**通报** ——
    //   它不是页面上的内容，而是**刚刚发生的一件事**，读屏软件该主动念出来。
    //   ⚠️ 提问条（`.ask`）和存失败条（`.save-fail`）**不加**：前者在等用户回答、
    //   后者是"图还在，先拿到手"，都不是"通报"的性质 —— 别顺手一起加。
    //   ⚠️ 忙态气泡也**刻意没有** aria-live：它里面的秒表每秒变一次，会把读屏刷屏
    //   （设计稿 §三 的裁定，那不是漏项）。
    const inner = fetchMock.getMockImplementation()!
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) =>
      (url === '/api/works' && init?.method === 'POST') ? jsonResponse({ id: 9 }) : inner(url, init))
    await renderApp()
    await uploadPhoto()
    await clickTop('存进作品')

    // 前提：那条通报**真的出现了**（少了这半句，元素不在时下面会红成"没有东西"）
    const notice = container.querySelector('.notice')
    expect(notice?.textContent ?? '').toContain('存好了')
    expect(notice?.getAttribute('role')).toBe('status')
    // 变异：把 role="status" 从 `.notice` 根元素上删掉 → 这一条红
  })

  it('★ 配方带着「用户说过的话」，而且**没有**那个英文 prompt', async () => {
    const inner = fetchMock.getMockImplementation()!
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) =>
      (url === '/api/works' && init?.method === 'POST') ? jsonResponse({ id: 9 }) : inner(url, init))

    await renderApp()
    await uploadPhoto()
    vi.mocked(api.postRoute).mockResolvedValueOnce(decision({ reply: '好。' }))
    await say('亮一点')
    await clickTop('存进作品')

    const body = savedBody()
    // ⚠️ **`toEqual` 不是 `toContain`，这一条是本轮改的。**
    // 原来写的是 `expect(...edits).toContain('亮一点')` + 另起一句
    // `expect(JSON.stringify(...edits)).not.toContain('MODEL:')`，注释说后者守的是
    // "不许混进给图片模型的英文 prompt"。**而 `'MODEL:'` 这三个字母在生产代码里根本不存在** ——
    // 它只出现在 `App.test.tsx` 那个假图 dataUrl 里（`:374` 那几处都在查**送上去的图**）。
    // 所以那句守的其实是"edits 里没有图片的 data URL"，**和它注释写的那件事不是一回事**；
    // 而计划给它配的**变异 C 正是因此永远红不了**。
    // 换成 `toEqual` 之后，配方里多出**任何**东西都会红 —— 英文 prompt 也在内，
    // 而且不再依赖"猜一个记号"。
    expect(body.recipe.edits).toEqual(['亮一点'])
    // ★ 2026-10-05（T12）：配方多了第三栏 `lut`（记的是滤镜的**名字** + 强度；
    //   这一趟没用滤镜，所以是**显式 null**，不是缺键 —— 老作品那个缺键的形状
    //   只在"读 2026-10-05 之前存的行"时才出现，`WorkDetailPage` 那边兜着）。
    //   `toEqual` 那个理由照旧：配方里多出**任何**东西都会红。
    expect(Object.keys(body.recipe).sort()).toEqual(['edits', 'lut', 'params'])
    expect(body.recipe.lut).toBeNull()
  })

  it('★ 保存时配方里记的是滤镜的**名字**和强度，不是 id', async () => {
    // 作品详情页那一行、以及「套到别的图上」按名字找回那一条，全靠这里存的形状：
    // 名字是**带得走**的那半，id 换个账号/换次导入就不是同一个东西了。
    // 变异：`recipeNow` 不带 lut → 红；记 id / 记 "1" 这种 → 红。
    const s = makeSession(7, 3, '上次那句', 'S7')
    s.steps[s.steps.length - 1]!.lut = { lutId: 1, amount: 80 }
    withSessions([s])
    vi.mocked(lutsMod.listLuts).mockResolvedValue({ luts: [HUANGHUN] })
    const inner = fetchMock.getMockImplementation()!
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) =>
      (url === '/api/works' && init?.method === 'POST') ? jsonResponse({ id: 9 }) : inner(url, init))

    await renderApp()
    // 前提：接回来的这张照片真的在用「黄昏」80（不然下面守的是个没发生的事）
    await goNav('调色')
    await openLutPanel()
    expect(tileNamed('黄昏').getAttribute('aria-pressed')).toBe('true')

    await clickTop('存进作品')
    expect(savedBody().recipe.lut).toEqual({ name: '黄昏', amount: 80 })
  })

  it('★ 同一张照片存第二次，问「替换还是再存一张」（§3.4）', async () => {
    const inner = fetchMock.getMockImplementation()!
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) =>
      (url === '/api/works' && init?.method === 'POST') ? jsonResponse({ id: 9 }) : inner(url, init))

    await renderApp()
    await uploadPhoto()
    await clickTop('存进作品')
    await clickTop('存进作品')          // 第二次

    expect(container.textContent).toContain('上次那张要替换掉吗')
    expect(container.textContent).toContain('替换')
    expect(container.textContent).toContain('再存一张')
    // 而且**这一下还没发出去** —— 得等他回答
    expect(fetchMock.mock.calls.filter(c => c[0] === '/api/works' && c[1]?.method === 'POST')).toHaveLength(1)
  })

  // ★★ 下面两条是**派发前补的**：上面那条只验了"问句出现、而且第一次还没发出去"，
  //    而**按下去之后发生了什么是零覆盖的** —— 和 Task 12 那个「套用没进仓库」是同一个形状：
  //    那个按钮存在的理由，恰恰是唯一没人守的那件事。
  it('★ 点「替换」真的打到 PUT /api/works/9 上 —— 不然「替换」只是个说法', async () => {
    const inner = fetchMock.getMockImplementation()!
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === '/api/works' && init?.method === 'POST') return jsonResponse({ id: 9 })
      if (url === '/api/works/9' && init?.method === 'PUT') return jsonResponse({ id: 9 })
      return inner(url, init)
    })

    await renderApp()
    await uploadPhoto()
    await clickTop('存进作品')
    await clickTop('存进作品')
    await clickTop('替换')          // 回答那个问句

    expect(fetchMock.mock.calls.filter(c => c[0] === '/api/works/9' && c[1]?.method === 'PUT')).toHaveLength(1)
    // ★ 替换走的是 PUT，**不是又 POST 一张** —— 后者会让作品集里凭空多出一张。
    //   ⚠️ 变异（把 `replaceWork(replaceId, body)` 换成 `createWork(body)`）**只报上面
    //   那一条**（PUT 数 0），下面这句**根本不会执行**：Vitest 只报一个 `it` 里第一个
    //   失败的断言。原稿写的"两条一起红"是**错的** —— 那是一种"看起来更严格、其实
    //   观察不到"的写法（计划的竣工回顾里专门更正过）。
    expect(fetchMock.mock.calls.filter(c => c[0] === '/api/works' && c[1]?.method === 'POST')).toHaveLength(1)
  })

  it('★ 点「再存一张」是**新存一张** —— 明确说了就允许（§3.4）', async () => {
    const inner = fetchMock.getMockImplementation()!
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === '/api/works' && init?.method === 'POST') return jsonResponse({ id: 9 })
      if (url === '/api/works/9' && init?.method === 'PUT') return jsonResponse({ id: 9 })
      return inner(url, init)
    })

    await renderApp()
    await uploadPhoto()
    await clickTop('存进作品')
    await clickTop('存进作品')
    await clickTop('再存一张')

    expect(fetchMock.mock.calls.filter(c => c[0] === '/api/works' && c[1]?.method === 'POST')).toHaveLength(2)
    expect(fetchMock.mock.calls.filter(c => c[0] === '/api/works/9' && c[1]?.method === 'PUT')).toHaveLength(0)
  })

  it('★★ 配方定格在**问的那一刻** —— 横幅挂着时又改了一版，回答「替换」存的仍是那一套（终审 M4）', async () => {
    // 终审 M4：`asking` 里原来只存了 `blob`，配方是按下按钮那一刻**现读**的。
    // 他在横幅挂着的时候回头又改了一版（或又生成一次），再点「替换」—— 存进去的是
    // **旧那张图 + 新那套配方**。后果不是"少记一笔"：详情页会把一套这张图上
    // **根本没发生过**的调整当教学讲给他，而 §3.5.1 说这一页的全部价值就在
    // "配方是真的"。
    const inner = fetchMock.getMockImplementation()!
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === '/api/works' && init?.method === 'POST') return jsonResponse({ id: 9 })
      if (url === '/api/works/9' && init?.method === 'PUT') return jsonResponse({ id: 9 })
      return inner(url, init)
    })

    await renderApp()
    await uploadPhoto()
    await clickTop('存进作品')          // 第一次：POST，savedId = 9
    await clickTop('存进作品')          // 第二次：问「替换掉吗」—— **配方在这一刻定格**
    expect(container.textContent).toContain('上次那张要替换掉吗')

    // 他还没回答，回头又改了一版：这一下**同时**改了 params 和"用户说过的原话"。
    // 两样都改，是因为配方两个字段各要有人咬（只改一样的话，另一个字段漏掉快照看不出来）。
    vi.mocked(api.postRoute).mockResolvedValueOnce(
      decision({ route: 'params', paramDeltas: { exposure: 20 }, reply: '给你提亮了。' }))
    await say('亮一点')

    await clickTop('替换')

    const call = fetchMock.mock.calls.find(c => c[0] === '/api/works/9' && c[1]?.method === 'PUT')
    // 没打到 PUT 时给 `undefined`（而不是崩在 `!` 上）：红出来的是
    // `expected undefined to equal []`，一眼看得出是"那一下没存"，不是"测试自己坏了"。
    // `call` 有值 ⇒ `call[1]` 必有：`find` 的条件里已经 `c[1]?.method === 'PUT'` 过了一遍。
    const body = call ? JSON.parse(String(call[1]!.body)) : undefined
    // ★ 必须是**问的那一刻**那一份：一句原话都还没有、参数还是零。
    //   变异：`saveOnce` 里把 `recipeAt ?? recipeNow()` 改回无条件 `recipeNow()`
    //   （或 `answerAsk` 不传 `cur.recipe`）→ 这两条红（会变成 ['亮一点'] / 20）。
    expect(body?.recipe.edits).toEqual([])
    expect(body?.recipe.params.exposure).toBe(0)
  })

  it('★★ 存不进去的时候，屏幕上必须出现一个**能拿到图**的按钮（§6.6 ①）', async () => {
    // §10 说这条「最容易漏」。它的重要性不在"报错报得好"，而在
    // **那一刻用户手里的图只在屏幕上** —— 关掉页面就没了，而他要的是发朋友圈。
    const inner = fetchMock.getMockImplementation()!
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) =>
      (url === '/api/works' && init?.method === 'POST')
        ? jsonResponse({ error: { code: 'BAD_REQUEST', message: '这张图太大了，存不下' } }, 413)
        : inner(url, init))

    await renderApp()
    await uploadPhoto()
    await clickTop('存进作品')

    expect(container.textContent).toContain('没能存进「作品」')
    // ⚠️ 按**类名**找那个盒子（结构），文案单独一条钉住 —— 不做"按文案找元素"。
    const dl = container.querySelector('.save-fail button.download') as HTMLButtonElement | null
    // 文案：按钮就叫「下载」（★ 2026-10-11 全站一名 —— 原来是「下载到电脑」，
    // 和顶栏、详情页各叫各的；变异：改回旧名 → 这一条红）
    expect((dl?.textContent ?? '').trim()).toBe('下载')
    expect(dl).toBeTruthy()                                 // 结构：它真的在
    expect(dl?.disabled).toBe(false)          // ★ 按钮得真的能按
    await act(async () => { dl?.click(); await new Promise(r => setTimeout(r, 0)) })
    expect(saveMod.downloadImage).toHaveBeenCalled()   // ★ 而且是**这一下**才下载的
  })

  it('★ 存失败之后又改了一版 —— 横幅说的是「刚才那张」，给的也是刚才那张', async () => {
    // 这条横幅**不随画面变消失**（故意的，见 App.tsx 那段注释：清掉的话用户就
    // 再也拿不到那张图了）。而画面是会变的：他回头又改了一版，屏幕上那张就不是
    // 失败那一刻那张了。这时候如果那句还写「这一张」，它**指向屏幕上这张**，
    // 而按钮给的是失败那一刻那张 —— 一句话和它对不上的行为，比没有这句话更糟。
    //
    // ⚠️ **这里用的"画面变了"是「又改了一版」，不是"传一张新照片"。** 应用里
    //    **没有换图入口**（Uploader 只在还没有图的时候渲染，见 :724 那段注释），
    //    换一张照片的唯一动作是重开一次 —— 而重开连 `saveFail` 一起清掉，
    //    所以横幅边上**从来不会**出现另一张照片。把这条用例写成"传一张新照片"
    //    是演不出来的（也是错的）：要么先卸载重挂（横幅当场没了，断言假的），
    //    要么偷偷改 state。所以量的是**真的会发生**的那种画面变化。
    //
    // 失败那一刻做出来的图，和后面再做的图**故意不一样**：
    // 一样的话"给的是哪张"就分不出来了（下面那条 toHaveBeenCalledWith 会永远绿）。
    const failedBlob = new Blob(['失败那一刻那版'], { type: 'image/jpeg' })
    const laterBlob = new Blob(['又改了一版'], { type: 'image/jpeg' })
    vi.mocked(saveMod.buildExportBlob).mockImplementationOnce(async () => failedBlob)
    vi.mocked(saveMod.buildExportBlob).mockImplementation(async () => laterBlob)

    const inner = fetchMock.getMockImplementation()!
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) =>
      (url === '/api/works' && init?.method === 'POST')
        ? jsonResponse({ error: { code: 'BAD_REQUEST', message: '这张图太大了，存不下' } }, 413)
        : inner(url, init))

    await renderApp()
    await uploadPhoto()
    await clickTop('存进作品')
    expect(container.textContent).toContain('没能存进「作品」')

    // 用户没关横幅，回头又改了一版：生成一张新的底，屏幕上那张**换人了**。
    vi.mocked(api.postRoute).mockResolvedValueOnce(
      decision({ route: 'generate', editPrompt: '去掉后面那个人' }))
    vi.mocked(api.postEdit).mockResolvedValue({
      imageDataUrl: 'data:image/png;base64,AAA', width: 1200, height: 800,
    })
    await say('把后面那个人去掉')
    // 先证明"画面真的变了" —— 少了这一句，下面那些断言可能是在一个什么都没变的
    // 界面上绿掉的（这条用例的前提就是它变了）。`toMatchObject` 是对着
    // `canvasProps.images` 那个类型（只有 width/height）读 `__tag` 的老实写法：
    // 假的位图自带记号，而直接 `.bitmap.__tag` 过不了类型检查。
    expect(canvasProps.images.at(-1)).toMatchObject({ bitmap: { __tag: 'decoded-1' } })

    // 横幅还在，而且**指的还是刚才那张**
    const fail = container.querySelector('.save-fail')
    expect(fail).toBeTruthy()
    expect(fail?.textContent ?? '').toContain('刚才那张')
    // ⚠️ **只扫横幅那一段，不扫整个屏幕。** 原来写的是 `container.textContent`
    //   `.not.toContain('这一张')` —— 那是在赌"整屏别处恰好没有这几个字"：作品页和
    //   详情页各有一句「这一张」，它们**今天**不在这一屏上。赌这种巧合的断言会在
    //   别人加一句文案那天**悄悄失效**（不红了，而不是红得看不懂），而"整屏扫一句
    //   否定"正是本段栽过第二次的形状（上一次是详情页那条 `not.toContain('你电脑')`
    //   扫了整个 container，Task 12 收的）。
    //   变异：把横幅那句改回「这一张」→ 上面那条红（这一条是同一个意思的另一半：
    //   屏幕上已经是新的一版了，横幅就不该说"这一张"）。
    expect(fail?.textContent ?? '').not.toContain('这一张')

    // ★ 而按钮给的必须是**失败那一刻那版**，不是屏幕上现在这版。
    const dl = container.querySelector('.save-fail button.download') as HTMLButtonElement | null
    expect(dl).toBeTruthy()
    await act(async () => { dl?.click(); await new Promise(r => setTimeout(r, 0)) })
    expect(saveMod.downloadImage).toHaveBeenCalledWith(failedBlob, 'p_pinkrose.jpg')
  })

  it('★ 图根本没能导出来的时候，屏幕上不许出现「图还在」（那是骗人）', async () => {
    // ★ 派发前补的。上面那条走的是"存不上，但图做出来了" —— 而 `blob` 为 null 是
    //   **另一种失败**：`buildExportBlob` 自己就炸了。那时说"图还在，先拿到手"，
    //   用户会去找一个屏幕上根本没有的按钮。
    vi.mocked(saveMod.buildExportBlob).mockRejectedValueOnce(new Error('画布太大'))
    await renderApp()
    await uploadPhoto()
    await clickTop('存进作品')

    expect(container.textContent).toContain('没能存进「作品」')
    // 变异：把那两句的三目压成永远走第一句 → 这一条红
    expect(container.textContent).not.toContain('图还在')
    expect(container.querySelector('.save-fail button.download')).toBeNull()
  })
})

describe('对话列表：页头与搜索', () => {
  /** 页头那格搜索框。和作品页同一个类名 —— 两页不会同时在屏上。 */
  const searchBox = () => container.querySelector('.gallery-search') as HTMLInputElement

  it('页头在：标题是「我的对话」，搜索框和作品页同一副长相（同一个类名）', async () => {
    withSessions([makeSession(7, 2, '把天调蓝一点', 'S7')])
    await renderApp()
    await goNav('对话')

    expect(container.querySelector('.gallery-title')?.textContent).toBe('我的对话')
    expect(searchBox()).toBeTruthy()
    // 作品页那套头部是**吸顶**的：类名一样，样式就跟着一样（同一种组件全站一份长相）
    expect(container.querySelector('.sessions .gallery-head')).toBeTruthy()
  })

  it('★ 按名字搜：只留下名字里带那几个字的', async () => {
    withSessions([
      { ...makeSession(7, 2, 'A 的话', 'A'), originalName: '古镇.jpg' },
      { ...makeSession(9, 2, 'B 的话', 'B'), originalName: '海边日落.jpg' },
    ])
    await renderApp()
    await goNav('对话')
    expect(container.querySelectorAll('.session-row')).toHaveLength(2)

    await typeIn(searchBox(), '海边')
    const rows = [...container.querySelectorAll('.session-row')]
    expect(rows).toHaveLength(1)
    expect(rows[0]!.textContent ?? '').toContain('海边日落')
  })

  it('★ 搜「9月25」能找到那天改的 —— 日期住在**分组标题**上（作品页住在名字里，两页承诺一样、取法不同）', async () => {
    const day = new Date('2026-09-25T14:30:00').getTime()
    withSessions([
      { ...makeSession(7, 2, 'A 的话', 'A'), updatedAt: day, originalName: '古镇.jpg' },
      { ...makeSession(9, 2, 'B 的话', 'B'), updatedAt: new Date('2026-08-01T10:00:00').getTime(), originalName: '海边日落.jpg' },
    ])
    await renderApp()
    await goNav('对话')

    await typeIn(searchBox(), '9月25')
    const rows = [...container.querySelectorAll('.session-row')]
    expect(rows).toHaveLength(1)
    expect(rows[0]!.textContent ?? '').toContain('古镇')
  })

  it('搜不到时说"没找到 · 换个字"，而且**不是**"还没改过照片" —— 两件事不能混（§3.7）', async () => {
    withSessions([makeSession(7, 2, '把天调蓝一点', 'S7')])
    await renderApp()
    await goNav('对话')

    await typeIn(searchBox(), '根本没有的字')
    const none = container.querySelector('.gallery-none')
    // `?? ''`：元素整个不在了时要红成一句人话，别红成 vitest 的"参数非法"
    expect(none?.textContent ?? '').toContain('没找到')
    expect(none?.textContent ?? '').toContain('换个字')
    // "筛掉了"不是"一条都没有"：空态说错了，用户会以为自己的记录没了
    expect(container.querySelector('.sessions-empty')).toBeNull()
    // 搜索框自己得留着 —— 不然搜错一个字只能刷新页面
    expect(searchBox()).toBeTruthy()
  })

  it('对话页打不开：同上（两页一个形状）', async () => {
    // ★ 2026-10-11：和作品页那一条**同一副样子**（居中一句 + 一颗「再试一次」）——
    //   同一个毛病在两页里的解法只有一份（`ui/kit/ErrorState`），别长歪。
    // ⚠️ 挂载时 App 自己就**会问一次** `/api/sessions`（"上次那条"，见
    //   `useLoadSession` 那个 effect），所以闸不能用"第几个请求"当判据 ——
    //   先让挂载那趟跑完，再合上闸，坏的就一定是**这一页读到的那一趟**。
    let failNext = false
    let gets = 0
    const inner = fetchMock.getMockImplementation()!
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === '/api/sessions' && (init?.method ?? 'GET') === 'GET') {
        gets += 1
        if (failNext) {
          failNext = false
          return jsonResponse({ error: { code: 'INTERNAL', message: 'SENTINEL-对话列表打不开' } }, 500)
        }
      }
      return inner(url, init)
    })
    await renderApp()
    await act(async () => { await new Promise(r => setTimeout(r, 0)) })   // 放走"上次那条"那一趟
    failNext = true
    await goNav('对话')

    const err = container.querySelector('.error-state.empty-state')
    expect(err?.textContent ?? '').toContain('SENTINEL-对话列表打不开')
    // ★ 退役的那句**一个字都不许再出现**
    expect(container.textContent).not.toContain('刷新一下页面')
    // 页头（标题 + 搜索框）还在 —— 四种状态里它都在，照作品页
    expect(container.querySelector('.gallery-title')?.textContent).toBe('我的对话')
    expect(searchBox()).toBeTruthy()

    const before = gets
    await clickByText('再试一次')
    expect(gets).toBe(before + 1)              // 真的重新发了一次，不是只把红字收掉
    // 这一趟才成功 → 空态（这个账号一条都没有），错误态整个让位
    expect(container.querySelector('.sessions-empty-title')?.textContent)
      .toContain('还没改过照片')
    expect(container.querySelector('.error-state')).toBeNull()
  })
})

describe('作品页：批量处理入口', () => {
  it('欢迎页多选相册 → 直接进批量工作区，照片已经预填', async () => {
    withWorks([])
    await renderApp()

    const input = container.querySelector('input[type="file"][multiple]') as HTMLInputElement
    expect(input, '欢迎页的相册入口应支持多选').toBeTruthy()
    const a = new File(['a'], 'a.jpg', { type: 'image/jpeg' })
    const b = new File(['b'], 'b.jpg', { type: 'image/jpeg' })
    Object.defineProperty(input, 'files', { value: [a, b], configurable: true })
    await act(async () => {
      input.dispatchEvent(new Event('change', { bubbles: true }))
      await new Promise(r => setTimeout(r, 0))
    })

    expect(location.pathname).toBe('/app/works')
    await vi.waitFor(() => expect(container.querySelector('.batch-page')).toBeTruthy())
    await vi.waitFor(() => expect(container.textContent).toContain('2 / 20'))
    expect(container.textContent).toContain('a.jpg')
    expect(container.textContent).toContain('b.jpg')
  })

  it('从作品页进入批量工作区，再原路返回', async () => {
    withWorks([WORK(1, Date.now(), '测试作品')])
    await renderApp()
    await goNav('作品')

    const entry = [...container.querySelectorAll('button')]
      .find(b => (b.textContent ?? '').trim() === '批量处理') as HTMLButtonElement | undefined
    expect(entry).toBeTruthy()
    await act(async () => { entry!.click() })

    await vi.waitFor(() => expect(container.querySelector('.batch-page')).toBeTruthy())
    expect(container.querySelector('.gallery-title')?.textContent).toBe('批量处理')
    expect(container.querySelector('input[type="file"]')).toBeTruthy()
    const start = [...container.querySelectorAll('button')]
      .find(b => (b.textContent ?? '').includes('开始处理')) as HTMLButtonElement
    expect(start.disabled).toBe(true)

    const back = container.querySelector('.batch-back') as HTMLButtonElement
    await act(async () => { back.click() })
    expect(container.querySelector('.batch-page')).toBeNull()
    expect(container.querySelector('.gallery-title')?.textContent).toBe('我的作品')
  })

  it('从作品页进入拼图工作区，再原路返回', async () => {
    withWorks([WORK(1, Date.now(), '测试作品')])
    await renderApp()
    await goNav('作品')

    const entry = [...container.querySelectorAll('button')]
      .find(b => (b.textContent ?? '').trim() === '拼图') as HTMLButtonElement | undefined
    expect(entry).toBeTruthy()
    await act(async () => { entry!.click() })

    await vi.waitFor(() => expect(container.querySelector('.collage-page')).toBeTruthy())
    expect(container.querySelector('.gallery-title')?.textContent).toBe('拼图')
    const start = [...container.querySelectorAll('button')]
      .find(b => (b.textContent ?? '').includes('生成拼图')) as HTMLButtonElement
    expect(start.disabled).toBe(true)

    const back = container.querySelector('.batch-back') as HTMLButtonElement
    await act(async () => { back.click() })
    expect(container.querySelector('.collage-page')).toBeNull()
    expect(container.querySelector('.gallery-title')?.textContent).toBe('我的作品')
  })

  it('从作品页进入全景工作区，再原路返回', async () => {
    withWorks([WORK(1, Date.now(), '测试作品')])
    await renderApp()
    await goNav('作品')

    const entry = [...container.querySelectorAll('button')]
      .find(b => (b.textContent ?? '').trim() === '全景') as HTMLButtonElement | undefined
    expect(entry).toBeTruthy()
    await act(async () => { entry!.click() })

    await vi.waitFor(() => expect(container.querySelector('.panorama-page')).toBeTruthy())
    expect(container.querySelector('.gallery-title')?.textContent).toBe('全景')
    const start = [...container.querySelectorAll('button')]
      .find(b => (b.textContent ?? '').includes('生成全景')) as HTMLButtonElement
    expect(start.disabled).toBe(true)

    const back = container.querySelector('.batch-back') as HTMLButtonElement
    await act(async () => { back.click() })
    expect(container.querySelector('.panorama-page')).toBeNull()
    expect(container.querySelector('.gallery-title')?.textContent).toBe('我的作品')
  })

  it('从作品页进入 HDR 合成，再原路返回', async () => {
    withWorks([WORK(1, Date.now(), '测试作品')])
    await renderApp()
    await goNav('作品')

    const entry = [...container.querySelectorAll('button')]
      .find(b => (b.textContent ?? '').trim() === 'HDR 合成') as HTMLButtonElement | undefined
    expect(entry).toBeTruthy()
    await act(async () => { entry!.click() })

    await vi.waitFor(() => expect(container.querySelector('.hdr-page')).toBeTruthy())
    expect(container.querySelector('.gallery-title')?.textContent).toBe('HDR 合成')
    const start = [...container.querySelectorAll('button')]
      .find(b => (b.textContent ?? '').includes('生成 HDR')) as HTMLButtonElement
    expect(start.disabled).toBe(true)

    const back = container.querySelector('.batch-back') as HTMLButtonElement
    await act(async () => { back.click() })
    expect(container.querySelector('.hdr-page')).toBeNull()
    expect(container.querySelector('.gallery-title')?.textContent).toBe('我的作品')
  })
})

describe('作品页：相册整组处理', () => {
  const album = (workCount: number) => ({
    id: 1, name: '旅行', createdAt: Date.now(), workCount,
  })

  /** 给 fetch 接上相册清单、相册里的作品，以及按 id 取原图的那条路。 */
  function withAlbumWorks(
    works: ReturnType<typeof WORK>[],
    fetchFile?: (url: string) => Response | null,
  ) {
    withWorks(works)
    const inner = fetchMock.getMockImplementation()!
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === '/api/albums' && (init?.method ?? 'GET') === 'GET') {
        return jsonResponse({ albums: [album(works.length)] })
      }
      if (url === '/api/works?album=1') return jsonResponse({ works })
      const file = fetchFile?.(url)
      if (file) return file
      return inner(url, init)
    })
  }

  async function pickAlbum(id = 1) {
    const filter = container.querySelector('select[aria-label="按相册筛选"]') as HTMLSelectElement
    expect(filter, '相册筛选应在作品页').toBeTruthy()
    const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!
    await act(async () => {
      setter.call(filter, String(id))
      filter.dispatchEvent(new Event('change', { bubbles: true }))
      await new Promise(r => setTimeout(r, 0))
    })
  }

  it('★ 相册里选「批量处理相册」→ 按作品取原图进批量页，来源和张数说清楚', async () => {
    const now = Date.now()
    const works = [WORK(1, now, '海边'), WORK(2, now - 1_000, '山上')]
    const fileCalls: string[] = []
    withAlbumWorks(works, (url) => {
      if (!url.startsWith('/api/works/')) return null
      fileCalls.push(url)
      if (url.startsWith('/api/works/1/file')) {
        return new Response('jpeg-1', { status: 200, headers: { 'content-type': 'image/jpeg' } })
      }
      if (url.startsWith('/api/works/2/file')) {
        return new Response('jpeg-2', { status: 200, headers: { 'content-type': 'image/jpeg' } })
      }
      return null
    })

    await renderApp()
    await goNav('作品')
    await pickAlbum()
    await vi.waitFor(() => expect(container.querySelectorAll('.gallery-cell')).toHaveLength(2))

    expect(container.textContent).toContain('批量处理相册')
    expect(container.textContent).toContain('下载相册')
    await clickByText('批量处理相册')
    await vi.waitFor(() => expect(container.querySelector('.batch-page')).toBeTruthy())

    expect(container.textContent).toContain('2 / 20')
    expect(container.textContent).toContain('海边_1.jpg')
    expect(container.textContent).toContain('山上_2.jpg')
    expect(container.querySelector('.batch-source-note')?.textContent)
      .toContain('来自相册「旅行」，2 张照片。')
    // 整组处理要的是原图，不是列表那张缩略图
    expect(fileCalls).toHaveLength(2)
    expect(fileCalls.every(url => url.includes('/file?v='))).toBe(true)
    expect(fileCalls.some(url => url.includes('/thumb'))).toBe(false)
  })

  it('★ 相册超过 20 张只取前 20；单张失败不拖垮整组，并把张数带进批量页', async () => {
    const now = Date.now()
    const works = Array.from({ length: 21 }, (_, i) => WORK(i + 1, now - i, `第${i + 1}张`))
    const noisy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      withAlbumWorks(works, (url) => {
        if (!url.startsWith('/api/works/')) return null
        if (url.startsWith('/api/works/3/file')) {
          return new Response('bad', { status: 500 })
        }
        if (/^\/api\/works\/\d+\/file/.test(url)) {
          return new Response('jpeg', { status: 200, headers: { 'content-type': 'image/jpeg' } })
        }
        return null
      })

      await renderApp()
      await goNav('作品')
      await pickAlbum()
      const burstToggle = container.querySelector(
        'button[aria-label="展开所有连拍组"]',
      ) as HTMLButtonElement | null
      if (burstToggle) {
        await act(async () => {
          burstToggle.click()
          await new Promise(r => setTimeout(r, 0))
        })
      }
      await vi.waitFor(() => expect(container.querySelectorAll('.gallery-cell')).toHaveLength(21))

      await clickByText('批量处理相册')
      await vi.waitFor(() => expect(container.querySelector('.batch-page')).toBeTruthy(), { timeout: 5_000 })

      expect(container.textContent).toContain('19 / 20')
      expect(container.textContent).not.toContain('第21张')
      expect(container.querySelector('.batch-source-note')?.textContent)
        .toContain('共 21 张，本次先处理前 20 张，1 张没取到')
    } finally {
      noisy.mockRestore()
    }
  })

  it('★ 相册整组下载：复用原图 ZIP 打包，并如实说下载了几张', async () => {
    const now = Date.now()
    const works = [WORK(1, now, 'A'), WORK(2, now - 1_000, 'B')]
    withAlbumWorks(works, (url) => {
      if (url.startsWith('/api/works/1/file')) {
        return new Response('jpeg-a', { status: 200, headers: { 'content-type': 'image/jpeg' } })
      }
      if (url.startsWith('/api/works/2/file')) {
        return new Response('jpeg-b', { status: 200, headers: { 'content-type': 'image/jpeg' } })
      }
      return null
    })

    await renderApp()
    await goNav('作品')
    await pickAlbum()
    await vi.waitFor(() => expect(container.querySelectorAll('.gallery-cell')).toHaveLength(2))

    const download = [...container.querySelectorAll('button')]
      .find(b => (b.textContent ?? '').trim() === '下载相册') as HTMLButtonElement
    expect(download).toBeTruthy()
    await act(async () => {
      download.click()
      await new Promise(r => setTimeout(r, 50))
    })
    await vi.waitFor(() => expect(saveMod.downloadImage).toHaveBeenCalledTimes(1))
    await vi.waitFor(() => expect(container.textContent).toContain('已下载 2 张'))
  }, 15_000)

  it('★ 从相册批量页返回后再用普通批量入口，不会把上一组相册照片偷偷带回来', async () => {
    const now = Date.now()
    const works = [WORK(1, now, 'A')]
    withAlbumWorks(works, (url) => (
      url.startsWith('/api/works/1/file')
        ? new Response('jpeg-a', { status: 200, headers: { 'content-type': 'image/jpeg' } })
        : null
    ))

    await renderApp()
    await goNav('作品')
    await pickAlbum()
    await vi.waitFor(() => expect(container.querySelectorAll('.gallery-cell')).toHaveLength(1))

    await clickByText('批量处理相册')
    await vi.waitFor(() => expect(container.querySelector('.batch-page')).toBeTruthy())
    const back = container.querySelector('.batch-back') as HTMLButtonElement
    await act(async () => { back.click(); await new Promise(r => setTimeout(r, 0)) })
    expect(container.querySelector('.batch-page')).toBeNull()

    await clickByText('批量处理')
    expect(container.querySelector('.batch-page')).toBeTruthy()
    expect(container.textContent).toContain('0 / 20')
    expect(container.querySelectorAll('.batch-file-row')).toHaveLength(0)
  })
})

describe('作品页：多选下载', () => {
  it('勾两张作品 → 一次下载 ZIP，并如实说下载了几张', async () => {
    const now = Date.now()
    withWorks([WORK(1, now, 'A'), WORK(2, now, 'B')])
    const inner = fetchMock.getMockImplementation()!
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url.startsWith('/api/works/1/file')) {
        return new Response('jpeg-a', { status: 200, headers: { 'content-type': 'image/jpeg' } })
      }
      if (url.startsWith('/api/works/2/file')) {
        return new Response('jpeg-b', { status: 200, headers: { 'content-type': 'image/jpeg' } })
      }
      return inner(url, init)
    })
    await renderApp()
    await goNav('作品')
    await clickByText('多选')
    const cells = [...container.querySelectorAll<HTMLButtonElement>('.gallery-cell')]
    await act(async () => { cells[0]!.click(); cells[1]!.click() })
    const download = container.querySelector('.gallery-select-download') as HTMLButtonElement
    expect(download).toBeTruthy()
    await act(async () => {
      download.click()
      await new Promise(r => setTimeout(r, 30))
    })
    await vi.waitFor(() => expect(saveMod.downloadImage).toHaveBeenCalledTimes(1))
    await vi.waitFor(() => expect(container.textContent).toContain('已下载 2 张'))
  }, 15_000)
})
