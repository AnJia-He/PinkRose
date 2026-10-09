// @vitest-environment jsdom
/**
 * App 级的验收测试 —— **会话那一簇**：落盘、恢复、删除。
 * （2026-10-09 从 App.test.tsx 拆出来的之一；脚手架在 `test/appHarness.tsx`。）
 *
 * ⚠️ 第一个 import（`test/appHarness`）**必须是它**：那堆 `vi.mock` 是
 *   在那个模块被求值时注册的，排在它后面加载的模块才拿得到假的。
 */
import { OK, bodyOf, canvasProps, clickByText, container, decision, decodedBitmaps, fakeDecoded, fetchMock, goNav, jsonResponse, lastReply, makeGate, makeSession, renderApp, reopenApp, root, say, typeIn, uploadPhoto, waitPersist, withSessions, withSessionsError } from './test/appHarness'
import { act } from 'react'
import { ZERO, type Adjustments } from '../shared/adjustments.ts'
import { PRESETS } from './core/presets'
import * as decodeMod from './image/decode'
import * as api from './api/client'
import * as saveMod from './export/save'
import * as thumbMod from './core/thumbnail'
import { describe, expect, it, vi } from 'vitest'
import type {
  RouteDecision, SessionDetail,
} from './test/appHarness'

describe('会话落盘：上传建会话、每一步更新', () => {
  /** 打到会话那两条路上的请求（建会话 / 每一步更新）。 */
  const sessionCalls = (url: string, method: 'POST' | 'PUT') =>
    fetchMock.mock.calls.filter(([u, init]) => u === url && (init?.method ?? 'GET') === method)

  /** 拨一条调色滑块（和「账本」那几组同款：点数字 → 打字 → 回车）。 */
  async function setSlider(name: string, value: number) {
    const row = [...container.querySelectorAll('.panel .slider')]
      .find(el => el.querySelector('.slider-label')?.textContent === name)
    expect(row, `调色面板里该有一条「${name}」`).toBeTruthy()
    await act(async () => {
      ;(row!.querySelector('.slider-value') as HTMLElement).click()
      await new Promise(r => setTimeout(r, 0))
    })
    const box = row!.querySelector('input.slider-edit') as HTMLInputElement
    await typeIn(box, String(value))
    await act(async () => {
      box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
      await new Promise(r => setTimeout(r, 0))
    })
  }

  /** 进裁剪 → 立刻「完成」= **换了底图**（账本上加一笔、落盘那趟 `baseChanged`）。 */
  async function cropOnce() {
    const cell = container.querySelector('[aria-label="裁剪"]') as HTMLButtonElement
    expect(cell, '工具行里该有「裁剪」').toBeTruthy()
    await act(async () => { cell.click(); await new Promise(r => setTimeout(r, 0)) })
    await clickByText('完成')
  }

  it('★ 上传照片 → 会建一条会话；原图、缩略图、照片名一起送上去', async () => {
    await renderApp()
    await uploadPhoto()

    const posts = sessionCalls('/api/sessions', 'POST')
    expect(posts).toHaveLength(1)
    const body = bodyOf(posts[0]!)
    // ★ `image` 必须是**原图那一版**（`bitmapToDataUrl`：0.92 画质、不缩边）——
    //   它是"回头接着改"的那张底。变异：拿 `makeThumbnail` 冒充（0.7 画质、
    //   缩到 480）→ 这一句红。真发生了的话用户回头打开这条会话，底图是糊的，
    //   而**没有任何地方会报错**（这一条守的就是它）。
    expect(body.image).toBe('original:upload')
    // 列表上那张小图（spec §6.3 用的是"最后那张"的样子；刚上传时就是这张）
    expect(body.thumb).toBe('thumb:upload')
    // 照片**上传时的名字**：列表标题和恢复之后「下载」的文件名都靠它（§6.3）
    expect(body.name).toBe('p.jpg')
  })

  it('★ 服务端没建成就**不能假装在存** —— 说一声，修图照常', async () => {
    // 建会话是"锦上添花"：它没成，**本地修图一点都不该受影响**（调色是免费的、
    // 本地的）。但不许静默 —— 用户以为在存、其实什么都没存，是这个项目最恨的
    // 一种失败：等他刷新才发现，而那时候他已经说不清丢了什么。
    withSessionsError()
    await renderApp()
    await uploadPhoto()

    // ① 屏幕上必须说一声，而且说的是**这件事**（不是"这张图打不开"那种甩锅话）
    expect(container.querySelector('.notice')?.textContent ?? '')
      .toContain('这次的改动暂时存不下来')

    // ② 修图照常：照片在、话能说、颜色真的调上去了。
    //   （少了这半条，一个"建会话失败就把整个应用卡住"的实现也能过。）
    expect(canvasProps.images.at(-1)).toBeTruthy()
    vi.mocked(api.postRoute).mockResolvedValueOnce(
      decision({ route: 'params', paramDeltas: { exposure: 20 }, reply: '给你提亮了。' }))
    await say('亮一点')
    expect(lastReply()).toContain('提亮了')
  })

  it('★ 每一步都落盘：说过的话、调过的参数都在；底图没换就不重传它', async () => {
    await renderApp()
    await uploadPhoto()
    // 第一次落盘：上传那一版的**话和参数** —— 底图建会话时就已经在服务端了，
    // 所以这一趟**不带** `base`（另一条用例钉着它）
    await waitPersist()

    // 再动一下 —— 说一句"亮一点"。⚠️ 这条**只改 params，不动 history**
    // （裁定 ⑤：改 params 从来不 push 快照）。它钉的是**请求体那一半**：
    //  `params` 必须作为单独一条路送出去（不看 `history`、不看快照）。
    //  ⚠️ 别以为它还守着依赖数组那一半：`say` 同时**加了 messages**，副作用
    //  本来就会因此重跑、读到的是新 `params` —— 把 `params` 从依赖里删掉，
    //  这条**照样绿**（2026-10-01 评审查出来的）。依赖那一半由下面那条
    //  「只动参数…也要落盘」钉。
    vi.mocked(api.postRoute).mockResolvedValueOnce(
      decision({ route: 'params', paramDeltas: { exposure: 20 }, reply: '给你提亮了。' }))
    await say('亮一点')
    await waitPersist()

    const puts = sessionCalls('/api/sessions/1', 'PUT')
    // 两次改动 → 恰好两次请求（拖滑块会一路推出很多版，防抖没做的话这里是一串）
    expect(puts).toHaveLength(2)
    const body = bodyOf(puts[1]!)
    expect(body.messages.map((m: { text: string }) => m.text)).toContain('亮一点')
    // ★ 参数单独走的那条路：它落在 `stateStepId` 指名的那一步上（这里是唯一
    //   那一步），不是靠 history 带过去的
    expect(body.params.exposure).toBe(20)
    // ★ 底图没换就不许传 `base`（也不许重做缩略图）—— 传了就是多存一个
    //   没人引用的文件，而服务端会把好好的缩略图删了重存（§4.3 那条的落点）
    expect(body.base).toBeUndefined()
    expect(body.thumb).toBeUndefined()
    // 而且步骤还是那一步 —— 参数步不推快照
    expect(body.steps).toHaveLength(1)
  })

  it('★ 建会话送上去的那张底图，落盘时不许**再传一遍**', async () => {
    await renderApp()
    await uploadPhoto()
    await waitPersist()

    const puts = sessionCalls('/api/sessions/1', 'PUT')
    // 这一趟该照常落盘（话和参数要送）—— 只是**不带图**
    expect(puts).toHaveLength(1)
    const body = bodyOf(puts[0]!)
    // ★ 建会话已经把这张图当 `original` + `base` 各存了一份。第一趟落盘
    //   要是再带一次 `base`，服务端 `handleUpdateSession` 会把它存成**新文件**
    //   —— 每条会话白白多背一张没人引用的全尺寸图 + 一张缩略图，外加一次
    //   白费的整图上传（2048 长边 JPEG 的 base64，一个来回）。
    // ★ 2026-10-08（账本 Task 7）：判据是**没有待办**（`dirtyRef.current === null`）
    //   —— 上传这条路没人记过账，所以第一趟什么都不该带。
    //   变异：`onPick` 里给那一版记一笔 `markDirty(id, true)`（"刚上传的底图
    //   再传一遍"那种写法）→ 这两句红。
    expect(body.base).toBeUndefined()
    expect(body.thumb).toBeUndefined()
    // 状态那三件也不带（没人脏 = 一个字节都不动）
    expect(body.stateStepId).toBeUndefined()
    expect(body.params).toBeUndefined()
  })

  it('★ 只动参数（不推快照、不说话）也要落盘 —— 参数有自己的那条依赖', async () => {
    await renderApp()
    await uploadPhoto()
    await waitPersist()   // PUT #1：上传那一趟

    // 打开调色面板，套一个预设 —— 这条路**不碰** messages、**不碰** history
    // （裁定 ⑤：改参数从来不 push 快照；预设和滑块、重置同级）。
    // ⚠️ 为什么必须是这种"只动参数"的改动：上面那条里的 `say('亮一点')` 会
    // **同时**改 messages，副作用本来就会重跑 —— 光靠它，把 `params` 从依赖
    // 数组里删掉也照样绿（2026-10-01 评审查出来的）。只有这里这一下能真的红：
    // 删掉 `params` 依赖 → 这次点击没有任何东西再触发副作用 → 第二个 PUT
    // 根本不会发生，而屏幕上什么都不说 —— 用户拖完滑块刷新回到拖之前。
    // ★ 2026-10-04：这一步原来点的是**顶栏**那颗「调色」，现在它搬去了左栏 ——
    // 走 `goNav`（按文字找，和别处的导航点击同一个路数），断言一个字不用改。
    await goNav('调色')
    const click = async (el: HTMLElement) => {
      await act(async () => { el.click(); await new Promise(r => setTimeout(r, 0)) })
    }
    // ★ 2026-10-05：预设从面板里那排药丸搬去了**照片左边那条预设栏**
    //    （`.rail-tile`）—— 第 0 格是「原图」（归零 + 摘滤镜），第 1 格才是第一个预设。
    const preset = container.querySelectorAll('.rail-tile')[1] as HTMLButtonElement
    await click(preset)
    await waitPersist()

    const puts = sessionCalls('/api/sessions/1', 'PUT')
    // 两次改动 → 恰好两次请求
    expect(puts).toHaveLength(2)
    const before = bodyOf(puts[0]!)
    const after = bodyOf(puts[1]!)
    // 参数真的变了、而且送出来了 —— 而且送的是**整组**：套预设 = 整组赋值
    // （`{...ZERO, …}` 的长拷贝），不是往当前参数上叠。这条比"exposure 是 8"
    // 更严：谁把 `setParams({...p.adjustments})` 改成合并写法，这里就红。
    expect(after.params).not.toEqual(before.params)
    expect(after.params).toEqual(PRESETS[0]!.adjustments)
    // 而这一趟**没有**新消息、没有新步骤 —— 它真的是"只动参数"那一路
    expect(after.messages).toEqual(before.messages)
    expect(after.steps).toHaveLength(before.steps.length)
  })

  it('★ 刷新/关页面前，把还没到点的那趟发出去 —— 而且走 keepalive（I1）', async () => {
    // 2026-10-01 终审 I1：验收线第 1 条是「上传 → 说一句话 → **刷新** →
    // 照片、对话、参数全在」，而验收的人正是**看到结果就按 F5** —— 那一刻
    // 800ms 防抖还没到点，而那个闹钟是挂在 effect 里的，页面一卸载就没了：
    // 那句话**一个字节都没发出去**，连一条失败通报都没有（请求压根没发）。
    // 修法：`pagehide` / `visibilitychange(hidden)` 各挂一条 → `flushPersist(true)`。
    //   ⚠️ 必须带 keepalive —— 普通 fetch 会在卸载时被浏览器掐断（接线那条
    //   在 client.test.ts 里钉；这里钉的是"这两个事件真的会触发落盘"）。
    // 变异：把那个 effect 删掉 → 下面第一句红（只剩 1 个 PUT，第 2 句没发出去）。
    await renderApp()
    await uploadPhoto()
    await waitPersist()                                  // PUT #1：上传那一趟
    expect(sessionCalls('/api/sessions/1', 'PUT')).toHaveLength(1)

    vi.mocked(api.postRoute).mockResolvedValueOnce(
      decision({ route: 'params', paramDeltas: { exposure: 20 }, reply: '给你提亮了。' }))
    await say('亮一点')                                   // **不等** waitPersist

    // ① 按了 F5：`pagehide` 先到
    await act(async () => {
      window.dispatchEvent(new Event('pagehide'))
      await new Promise(r => setTimeout(r, 0))
    })
    let puts = sessionCalls('/api/sessions/1', 'PUT')
    expect(puts).toHaveLength(2)
    expect(bodyOf(puts[1]!).messages.map((m: { text: string }) => m.text)).toContain('亮一点')
    // 页面正在消失 → 这一趟必须点名 keepalive（普通 fetch 发不完）
    expect((puts[1]![1] as RequestInit).keepalive).toBe(true)

    // ② 再来一趟，这次演"切到后台"（`visibilitychange → hidden`）：移动端标签页
    //    被冻结前多半只来这一个（`pagehide` 不一定来）—— 少挂它就有一种
    //    "页面要走了"接不住。jsdom 的 `visibilityState` 恒为 visible，
    //    这里临时盖成 hidden（用 own property 盖住原型上的 getter，跑完就摘）。
    vi.mocked(api.postRoute).mockResolvedValueOnce(
      decision({ route: 'params', paramDeltas: { exposure: 30 }, reply: '好。' }))
    await say('再亮一点')
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true })
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'))
      await new Promise(r => setTimeout(r, 0))
    })
    Reflect.deleteProperty(document, 'visibilityState')
    puts = sessionCalls('/api/sessions/1', 'PUT')
    expect(puts).toHaveLength(3)
    expect(bodyOf(puts[2]!).messages.map((m: { text: string }) => m.text)).toContain('再亮一点')
  })

  it('★ 底图换过的那趟落盘：上路的是**压过的**那条路（`bitmapToDataUrl`），不是画布直出', async () => {
    // 为什么这条路要单独钉：出网的字节必须过 `MAX_DIMENSION` 那顶帽子 ——
    // 落盘那趟的暴露面是"**提供方回的图比它声明的更大**"那条偏差分支
    // （`App.tsx` 的"以实际为准，不拉伸"），4096² 的 JPEG 0.9 能顶到服务端 8MB。
    // 画布直出（`el.toDataURL`）没有帽子。测试台里两条出路的假货长得不一样
    // （`original:` vs `canvas:`），所以分得清 —— 帽子本身在
    // `src/core/thumbnail.test.ts` 里对着**真函数**量（画了多大、什么画质）。
    // ★ 2026-10-08（账本）：编码的**入参**从画布换成了**这一步的位图**（spec §3
    //   那个"刷新后参数翻倍"的 bug）—— 下面第一句钉的就是"根本没碰画布"。
    vi.mocked(api.postRoute).mockResolvedValueOnce(
      decision({ route: 'generate', editPrompt: '去掉后面的路人' }))
    vi.mocked(api.postEdit).mockResolvedValue({
      imageDataUrl: 'data:image/png;base64,AAA', width: 1200, height: 800,
    })

    await renderApp()
    await uploadPhoto()
    await waitPersist()   // PUT #1：底图没换，不带 base

    await say('把后面那个人去掉')
    await waitPersist()   // PUT #2：底图换了 —— 这一趟必须带 base

    const puts = sessionCalls('/api/sessions/1', 'PUT')
    expect(puts).toHaveLength(2)
    const body = bodyOf(puts[1]!)
    // ★ 变异：把 `patch.base` 改回 `bitmapToDataUrl(el, 0.9)` → 这两句红
    //   （入参变成画布那个 `<canvas>`；`body.base` 变成 `original:画布`）。
    const generated = decodedBitmaps.at(-1)!
    expect(vi.mocked(thumbMod.bitmapToDataUrl).mock.calls.at(-1)![0]).toBe(generated)
    expect(body.base).toBe(`original:${(generated as unknown as { __tag: string }).__tag}`)
    // 缩略图照旧跟着换（列表上要显示"最后那张"的样子），而且**还是从画布抓的**
    // —— 它要的就是"现在的观感"，和底图那条路正好相反。
    expect(body.thumb).toContain('thumb:')
    // 状态挂在这一趟新长出来的那一版上（id 3 = 欢迎语 1、你问的那句 2、
    // 生成那一步 3 —— `applyDecision` 为这一步单独发一个号）
    expect(body.stateStepId).toBe(3)
  })

  it('★★（10-08 探针的 bug）落盘的底图来自**干净位图**，不是画布 —— 刷新后参数不许翻倍', async () => {
    // 根因（spec §3）：`patch.base` 原来是从**画布**编码的，而画布上跑过
    // `render(params)` —— 存下去的像素**带着参数**。恢复时 `setImage(base)` +
    // `setParams(同一套参数)`，参数就被作用了两次（真机实测：画布平均亮度
    // 100.73 → 120.88，对照组 0.00）。触发要三件同时：非零参数 + 换底图 + 刷新。
    // 修法：底图一律从**那一版的位图**编码（`S(V).base.bitmap`）、画布只留给封面；
    // 顺带治好"画布不在就整份 patch 扔掉"那条老毛病（底图不再依赖画布）。
    // 变异：把 `patch.base` 改回 `bitmapToDataUrl(el, 0.9)` → 下面①②当场红。
    await renderApp()
    await uploadPhoto()
    await goNav('调色')
    await setSlider('亮度', 60)          // 画布上从此带着参数
    await cropOnce()                     // 这一刀换了底图 → 这一版脏了、要重传
    await waitPersist()

    const body = bodyOf(sessionCalls('/api/sessions/1', 'PUT').at(-1)!)
    const cropped = (canvasProps.images.at(-1) as unknown as { bitmap: ImageBitmap }).bitmap
    // ① 编码的**入参**是那一步的位图对象本身（同一个对象，不是"看着差不多"）
    expect(vi.mocked(thumbMod.bitmapToDataUrl).mock.calls.at(-1)![0]).toBe(cropped)
    // ② 送上去的就是那张**没调过色**的位图（`cropped`），不是画布（`original:画布`）
    expect(body.base).toBe('original:cropped')
    // ③ 状态（参数）挂在**被裁的那一版**上 —— `stateStepId` 指它，不是含糊的"最后一步"
    expect(body.stateStepId).toBe(1)
    expect(body.params.exposure).toBe(60)
  })

  it('★ 站在**旧版本**上改 → 状态挂在旧版本上（`stateStepId` 指它，不是最后一步）', async () => {
    // 旧的 `atTip` 规则是"只有站在最新一步才送 params" —— 它治的是"旧版本的参数
    // 被塞进最后一步"那个病，代价却是**站在旧版本上调的色根本送不出去**
    // （屏幕上照变，刷新就没了）。今天按 spec §7.2 换成"哪一版脏了送哪一版"。
    // 变异：payload 里不写 `stateStepId` → 第一句红（服务端会写到最后一步）。
    withSessions([makeSession(7, 3, '上次那句', 'S7')])
    await renderApp()

    // 站到**第一版**上（转盘第一格），在那儿拖一档亮度
    await act(async () => {
      (container.querySelectorAll('.strip-node')[0] as HTMLElement).click()
      await new Promise(r => setTimeout(r, 0))
    })
    await goNav('调色')
    await setSlider('亮度', 40)
    await waitPersist()

    const body = bodyOf(sessionCalls('/api/sessions/7', 'PUT').at(-1)!)
    expect(body.stateStepId, '状态挂在 id 1 那一版上').toBe(1)
    expect(body.params.exposure).toBe(40)
    expect(body.lut).toBeNull()
    // 而这一版**没换过底图** → 不许带 base（参数步不产生新图，§4.3）
    expect(body.base).toBeUndefined()
  })

  it('★ 跳版本之前先把**上一版欠的那趟**发出去（不等那 800ms）', async () => {
    // 消灭"两版同时脏"（spec §7.2）：跳走 = 那一版离开视线，它欠的账先结掉。
    // 落点：`onJump` 里 `flushEdit()` **之后**那一句 `flushPersist()`
    // （先定稿那一笔，再把它连状态一起发出去）。
    // 变异：去掉 `onJump` 里那句 `flushPersist()` → 第一句红（跳转会让落盘
    // effect 重跑、把 800ms 的闹钟重排一遍，这一趟就没发出去）。
    vi.mocked(api.postRoute).mockResolvedValue(
      decision({ route: 'generate', editPrompt: '改一下', reply: '好了。' }))
    vi.mocked(api.postEdit).mockResolvedValue(OK)

    await renderApp()
    await uploadPhoto()
    await say('先改一次')                 // 转盘两格；生成那一版是 id 3
    await waitPersist()

    await goNav('调色')
    await setSlider('亮度', 50)           // 第二版脏了 —— 800ms 还没到点
    await goNav('修图')
    const before = sessionCalls('/api/sessions/1', 'PUT').length
    await act(async () => {
      (container.querySelectorAll('.strip-node')[0] as HTMLElement).click()
      await new Promise(r => setTimeout(r, 0))
    })

    const puts = sessionCalls('/api/sessions/1', 'PUT')
    expect(puts.length, '跳走那一刻，上一版那趟已经上路').toBe(before + 1)
    const body = bodyOf(puts.at(-1)!)
    expect(body.stateStepId, '发出去的是**上一版**（id 3）的最新状态').toBe(3)
    expect(body.params.exposure).toBe(50)
  })
})

describe('恢复：打开就接着上次那条', () => {
  /** 屏幕上所有气泡的文字（用户的和助手的都在里面）。 */
  const bubbleTexts = () =>
    [...container.querySelectorAll('.bubble-text')].map(e => e.textContent ?? '')
  /** 打到某条会话上的更新请求。 */
  const putCalls = (url: string) =>
    fetchMock.mock.calls.filter(([u, init]) => u === url && (init?.method ?? 'GET') === 'PUT')
  /** 「下载」那颗按钮（桌面浏览器那一档：`canShare` 假成 false）。 */
  const downloadBtn = () =>
    [...container.querySelectorAll('.actions button')]
      .find(b => (b.textContent ?? '').includes('下载')) as HTMLButtonElement | undefined

  it('★ 打开就接着上次那条 —— 而且屏幕上要说清"这是上次没做完的"', async () => {
    const { stepGets } = withSessions([makeSession(7, 7, '把天调蓝一点', 'S7')])
    await renderApp()

    // ① 画布上有图（假的 `createImageBitmap` 统一回 1200×800）——
    //    这一句其实是"画布上真的接上了那张"，而不是"某个 state 变了"。
    expect(canvasProps.images.at(-1)).toMatchObject({ width: 1200, height: 800 })

    // ② 对话回来了：用户那句和助手那几句都在
    expect(bubbleTexts()).toContain('把天调蓝一点')
    expect(bubbleTexts()).toContain('S7第 6 步')

    // ③ ★ 步骤**一步都不许截断**（§7：这一版明确不做"只取最后 K 步"）。
    //    截断的后果不是"少几张缩略图"：`cutAfter` 找不到 id 就原样返回一份拷贝，
    //    老步骤那一格会变成**点了没反应**的死格子，而且不报错。
    //    `MAX_SNAPSHOTS` 是 6，这里给 7 步 —— 截断的话这里只剩 5 格。
    //    （★ 2026-10-06 晚：判据从"对话里的跳按钮"换成了转盘上的格子。）
    expect(container.querySelectorAll('.strip-node')).toHaveLength(7)

    // ④ `reusesPrev` 的那一步**不重新下载**（它和上一步是同一张图）：
    //    7 步里第 2 步（id 3）带这个标记，所以只该有 6 次取图。
    //    变异：不看 `reusesPrev` 每步都下一遍 → 第一条变成 7、第二条红。
    expect(stepGets).toHaveLength(6)
    expect(stepGets.some(u => u.endsWith('/3'))).toBe(false)

    // ⑤ ★ 必须说一句"这是上次的"（§6.2）—— 不说的话用户以为照片是刚传的
    expect(container.querySelector('.notice')?.textContent ?? '')
      .toContain('这是上次没做完的那张')

    // ⑥ 「按住看原图」那张预览要**从原图重新生成**一份（它本来是内存里的 data URL）
    expect(canvasProps.props.at(-1)?.originalPreview).toBeTruthy()

    // ⑦ ★★ 「保存 / 分享 / 下载」三条路还活着。它们共同的开头要一个**真 File**
    //    （`originalFileRef`），恢复出来的会话原来没有它 —— 三颗按钮会一起
    //    "点了没反应"，不报错、也不提示。名字还必须来自**用户上传时那个名字**：
    //    兜一个空名字的话 `buildFilename` 给出的是 `_pinkrose.jpg` 这种没法看的。
    //    变异：恢复时不重建那个 File（或者不传名字）→ 这两句红。
    const dl = downloadBtn()
    expect(dl).toBeTruthy()
    await act(async () => { dl!.click(); await new Promise(r => setTimeout(r, 0)) })
    expect(saveMod.downloadImage).toHaveBeenCalledWith(expect.anything(), '古镇_pinkrose.jpg')
    expect(saveMod.buildExportBlob).toHaveBeenCalledWith(
      expect.anything(), expect.objectContaining({ name: '古镇.jpg' }), 'image/jpeg', 0.95)

    // ⑧ 刚接回来的这一版**就是服务端上那一版**：下一次落盘不许把整张底图重传
    //    （不记的话，服务端每收一次 `base` 就多存一个没人引用的文件，而这是
    //     一进页面就会发生的第一趟）
    await waitPersist()
    const puts = putCalls('/api/sessions/7')
    expect(puts).toHaveLength(1)
    expect(bodyOf(puts[0]!).base).toBeUndefined()

    // ⑨ ★ 跳步在**恢复之后**真的按得动（设计 §9 第 4 条）。
    //    这一条和 ③ 是同一件事的两半：③ 说格子都在，⑨ 说点下去画面真的回去。
    //    截断步骤的后果在这里现原形 —— `cutAfter` 找不到 id 时**原样返回一份拷贝**：
    //    格子还在、点下去什么都不会发生、一句错也不报。
    //    （★ 2026-10-06 晚：点的是**转盘上第一格**=原图，语义一字不差。）
    const nodes = [...container.querySelectorAll('.strip-node')] as HTMLButtonElement[]
    await act(async () => { nodes[0]!.click(); await new Promise(r => setTimeout(r, 0)) })
    // 跳回**最老那一步**：画布换成它的底图（恢复时第一张解出来的就是它），
    // 参数也跟着回去 —— 只还原图不还原参数，画面和滑块就是对不上的两回事
    // （`onJump` 里那两行注释说的就是这个）。
    const back = canvasProps.images.at(-1) as unknown as { bitmap: ImageBitmap }
    expect(back.bitmap).toBe(decodedBitmaps[0])
    expect(canvasProps.props.at(-1)?.params).toEqual({ ...ZERO, exposure: 0 })
    await waitPersist()
  })

  it('★ 纯跳转（谁都没改）不发带 `stateStepId` 的 PUT —— 跳转不改任何一版的"现在"', async () => {
    // ★ 2026-10-08（账本）：这条原来是「跳到旧步骤 → 不把"现在这一版参数"写到
    //   服务端的**最后一步**上」—— 当初靠 `atTip`（站在最新一步才送）挡住。
    //   现在状态按 `stateStepId` 挂在**指名的那一版**上，"最后一步"那个坑从根上
    //   没有了；规矩升级成更强的一条：**没改就不送**。
    //   跳转只挪"站在哪一版"，`params`/`lut`/`base` 一个字节都没动 —— 这一趟要是
    //   还送，服务端就会把某几个值写进某一版，而用户只是看了一眼别的版本。
    // 变异：`run` 里无条件带上 `stateStepId`/`params`/`lut` → 下面三句红。
    withSessions([makeSession(7, 3, '上次那句', 'S7')])
    await renderApp()

    const nodes = [...container.querySelectorAll('.strip-node')] as HTMLButtonElement[]
    await act(async () => { nodes[0]!.click(); await new Promise(r => setTimeout(r, 0)) })
    await waitPersist()

    const body = bodyOf(putCalls('/api/sessions/7').at(-1)!)
    // ① 步骤还是全部（跳转不删）—— id 是 1、3、5
    expect((body.steps as { id: number }[]).map(s => s.id)).toEqual([1, 3, 5])
    // ② 状态三件一个都没送（服务端那边 = 一个字节都不动）
    expect(body.stateStepId).toBeUndefined()
    expect(body.params).toBeUndefined()
    expect(body.lut).toBeUndefined()
  })

  it('★ 恢复出来的**每一步**都带着小图 —— 刷新前后同一条对话长得一样（spec §5）', async () => {
    // 服务端不存每一步的缩略图（spec §5：「客户端本来就会给每一步生成缩略图…
    // 恢复的时候现生成就行」）—— 而恢复那条路原来给每一步塞的是 `thumb: ''`，
    // 于是**什么都不渲染**：活着的时候时间轴上每一格都有小图，刷新之后只剩
    // 最后一格有。用户看到的差别是"我改过的那几步去哪了"，而套件里**一个红都
    // 不会有** —— 空串只是"不渲染"。
    // （★ 2026-10-06 晚：这套判据原来量的是"每条助手气泡下面挂的小图"，
    //   照片搬进时间轴之后跟着搬 —— 量的是同一批 `history[].thumb`。）
    // 变异：恢复循环里改回 `thumb: ''` → 下面第一句红（只剩 1 张 = 最后那步的）。
    withSessions([makeSession(7, 3, '把天调蓝一点', 'S7')])
    await renderApp()

    // 3 步 → 时间轴上 3 格，每格都该有小图
    const thumbs = [...container.querySelectorAll('img.strip-thumb')]
    expect(thumbs).toHaveLength(3)
    const srcs = thumbs.map(t => t.getAttribute('src') ?? '')
    expect(srcs.every(s => s.startsWith('thumb:'))).toBe(true)
    // 第 2 步是 `reusesPrev`（和第 1 步**同一张图**）—— 小图直接接着用，不重做：
    // 重做一遍只会得到像素级不同、肉眼一样的两张，而"看着像换了一张"正是这条防的。
    expect(srcs[1]).toBe(srcs[0])
    expect(new Set(srcs).size).toBe(2)

    // 而且补缩略图那个 effect **不会**一遍遍地重算：它的记号（`thumbStateRef`）
    // 认的是"**当前这一版的样子**"（id + 底图 + 参数 + 滤镜，四样引用一个不变
    // 就收手）—— ★ Task 8 之前这里写的是"只认 `history` 最后一步、`last.thumb`
    // 非空就收手"，那个形状已经退役（它让裁剪之后的小图永远停在改之前）。
    await waitPersist()
    expect(container.querySelectorAll('img.strip-thumb')).toHaveLength(3)
  })

  it('★ 恢复出来的会话之间不串 —— 切到另一条，上一条的话不能跟过来', async () => {
    // 两条会话，内容一眼分得开（助手那几句也带着自己那条的前缀）
    const nine = makeSession(9, 2, 'S9-用户说的', 'S9')
    const seven = makeSession(7, 2, 'S7-用户说的', 'S7')
    const { serve } = withSessions([seven, nine])
    await renderApp()

    // ① 接回来的是**最近动过的那条**（列表是服务端按 updated_at 倒序给的），
    //    另一条的话一个字都不许出现 —— 两条都接回来、或者接错一条，都红。
    expect(bubbleTexts()).toContain('S9-用户说的')
    expect(bubbleTexts()).toContain('S9第 1 步')
    expect(document.body.textContent ?? '').not.toContain('S7')

    // ② 接着改：改动要落在**这一条**上。串了的话会写进另一条 ——
    //    那种错不报错，只在用户下次打开另一条会话时才发现（话跑到别人那儿去了）。
    vi.mocked(api.postRoute).mockResolvedValueOnce(decision({ reply: '好。' }))
    await say('再亮一点')
    await waitPersist()
    expect(putCalls('/api/sessions/7')).toHaveLength(0)
    const puts = putCalls('/api/sessions/9')
    expect(puts).toHaveLength(1)
    const texts = bodyOf(puts[0]!).messages.map((m: { text: string }) => m.text)
    expect(texts).toContain('S9-用户说的')
    expect(texts).toContain('再亮一点')
    expect(texts).not.toContain('S7-用户说的')

    // ③ 换一条：今天"切到另一条"的现实形态就是**重开一次页面**
    //    （会话列表是 Task 6 的事）。重开之后接回来的是服务端上最近动过的那条，
    //    上一条的话一句都不能跟过来。
    serve([seven])
    await reopenApp()
    expect(bubbleTexts()).toContain('S7-用户说的')
    expect(bubbleTexts()).not.toContain('S9-用户说的')
  })

  it('★★ 在 A 里改点东西，从列表里切到 B —— 落盘打在 B 的 id 上、body 里没有 A 的话', async () => {
    // Task 6 新增的那条路：**从列表里点开一条**（`loadSession(id, 'open')`）。
    // 它和挂载那条恢复路共用同一份代码，但多了一个挂载时没有的动作：**切走** ——
    // A 那一份状态（history / messages / params / sessionId）此刻正挂在屏幕上。
    //
    // ⚠️ 这条用例钉的是 `loadSession` 里那句「写状态那一批里一次 `await` 都不许有」：
    //   中途让出的话，落盘那个 effect 会带着**旧 history + 新 sessionId** 跑一次 ——
    //   那等于**把 A 的活儿写进 B**。写错了不报错、看起来也一切正常：用户切过去、
    //   屏幕上确实是 B 的照片，只是 B 的对话里凭空多了一句他从没说过的话，
    //   而 B 原来的对话被整段顶掉（下次打开 B 才发现）。
    const nine = { ...makeSession(9, 1, 'S9-用户说的', 'S9'), originalName: '九号.jpg' }
    const seven = { ...makeSession(7, 1, 'S7-用户说的', 'S7'), originalName: '七号.jpg' }
    withSessions([seven, nine])
    await renderApp()

    // ① 打开就接回**最近动过的那条**（A = id 9）
    expect(bubbleTexts()).toContain('S9-用户说的')
    expect(bubbleTexts()).not.toContain('S7-用户说的')
    // A 这一趟解出来的位图（第 1 步那张 + 原图那张）：切走时**一个都不许漏**
    const aBitmaps = [...decodedBitmaps]

    // ② 在 A 里改点东西，等它落盘 —— 这句就是待会儿**不许出现在 B 里**的那句
    vi.mocked(api.postRoute).mockResolvedValueOnce(decision({ reply: '好。' }))
    await say('A 里加的这句')
    await waitPersist()
    expect(putCalls('/api/sessions/9')).toHaveLength(1)

    // ③ 走**真入口**切到 B：左栏「对话」→ 点「七号」那一行
    await goNav('对话')
    const row = [...container.querySelectorAll('.session-row')].find(
      r => (r.textContent ?? '').includes('七号'))
    expect(row).toBeTruthy()
    await act(async () => {
      ;(row!.querySelector('.session-open') as HTMLButtonElement).click()
      await new Promise(r => setTimeout(r, 0))
    })
    // 这一趟是"取详情 → 一步步下图解码 → 取原图"几段往返。**故意等够**（连落盘那层
    // 防抖一起过）：下面 ⑥ 要断的是"落盘打在哪条上"，早些断的话，一个把状态**分两批**
    // 写的实现还没跑到第二批 —— 那时候它看起来反而像是没毛病。
    await waitPersist()

    // ④ 屏幕上换成 B 了：对话跟着换
    expect(bubbleTexts()).toContain('S7-用户说的')
    expect(bubbleTexts()).not.toContain('S9-用户说的')
    // ⚠️ 点开这一条**不许说**「这是上次没做完的那张」：用户明明点的是另一条，
    //    那句话会被读成"我点开的这条就是上次那条" —— 一句假话（见 loadSession 头 ③）。
    expect(container.querySelector('.notice')?.textContent ?? '')
      .not.toContain('这是上次没做完的')
    // ⑤ 切走那条（A）的位图要**还回去** —— 不还，切几次就把标签页拖垮
    //    （`setHistory` 那个 updater 里的 `bitmapsToClose(prev, [])`）。
    for (const b of aBitmaps) expect(vi.mocked(b.close)).toHaveBeenCalled()

    // ⑥ ★★ 落盘这一趟：打的是 **B 的 id**，而且 body 里**没有 A 的那句话**。
    //    两句缺一不可 —— 只看"B 收到了 PUT"的话，把 `setHistory` 和 `setSessionId`
    //    分两批写的实现也会绿：那时候 B 收到的正是 A 的整份活儿。
    await waitPersist()
    expect(putCalls('/api/sessions/9')).toHaveLength(1)   // A 上还是原来那一趟，没有第二次
    const puts = putCalls('/api/sessions/7')
    expect(puts).toHaveLength(1)
    const texts = bodyOf(puts[0]!).messages.map((m: { text: string }) => m.text)
    expect(texts).toContain('S7-用户说的')
    expect(texts).not.toContain('A 里加的这句')
    expect(texts).not.toContain('S9-用户说的')
  })

  it('★★ 在 A 里说完就切走，**不等**防抖 —— A 那句话照样落盘，不丢', async () => {
    // 切会话（和「新的一张」）会把落盘那层的防抖计时器连根清掉 —— 计时器是挂在
    // effect 的清理里的，`sessionId` 一变就清。所以**进 `loadSession` 的第一件事**
    // 就是把还没到点的那一趟立刻发出去（`flushPersist`），那时候 `sessionId`
    // 还是 A，闭包里那份 payload 也是 A 的。
    //
    // ⚠️ 这条用例里**故意不 waitPersist**：等了就是把 800ms 让过去，那时候
    //   "有没有那句 flush"在断言里分不出来（正是这条用例要咬的东西）。
    const nine = { ...makeSession(9, 1, 'S9-用户说的', 'S9'), originalName: '九号.jpg' }
    const seven = { ...makeSession(7, 1, 'S7-用户说的', 'S7'), originalName: '七号.jpg' }
    withSessions([seven, nine])
    await renderApp()
    expect(bubbleTexts()).toContain('S9-用户说的')      // A = 9（最近动过的那条）

    vi.mocked(api.postRoute).mockResolvedValueOnce(decision({ reply: '好。' }))
    await say('切走之前说的这句')

    // 立刻切走（几毫秒内）—— 800ms 的防抖还没到点
    await goNav('对话')
    const row = [...container.querySelectorAll('.session-row')].find(
      r => (r.textContent ?? '').includes('七号'))
    expect(row).toBeTruthy()
    await act(async () => {
      ;(row!.querySelector('.session-open') as HTMLButtonElement).click()
      await new Promise(r => setTimeout(r, 0))
    })
    await waitPersist()

    // ★ A 那一趟要**真的发出去**，而且带的是切走之前那句话
    const putsA = putCalls('/api/sessions/9')
    expect(putsA).toHaveLength(1)
    const textsA = bodyOf(putsA[0]!).messages.map((m: { text: string }) => m.text)
    expect(textsA).toContain('切走之前说的这句')
    // 切过去那条照旧（这正是 ★★ 那条用例钉的事，这里顺带再量一次）
    expect(bubbleTexts()).toContain('S7-用户说的')
    expect(putCalls('/api/sessions/7')).toHaveLength(1)
  })

  it('★★ 生成完**不等落盘**就切走（底图换了那趟）—— 那一版底图照样发得出去', async () => {
    // 2026-10-01 终审 C1。落盘那趟原来是在**发的时候**现读 `canvasElRef.current`
    // 的，而画布只在「修图」那一屏存在（`{view.kind === 'edit' && …}` 一卸载，
    // Canvas 的回调 ref 就把它置回 null）。切导航**不会**让落盘那个 effect 重跑
    // （依赖里没有 `view`），于是 800ms 防抖还没到点就切走的话：
    //   · 闹钟响时人在别的屏上 → `if (!el)` 把**整份 patch**（messages / steps /
    //     params / base / thumb）一起扔掉，只有一行 console.error；
    //   · 更糟的是 `flushPersist`（切会话时那个"提前点掉"）走的**是同一个 `run`**
    //     —— 它本来正是为这个窗口写的，结果也被同一句 `if (!el)` 吞掉。
    // 后果是**用户花了钱生成的那一步永远到不了服务端**：刷新回到生成之前，
    // 而且不是"请求失败了"，是**压根没发**（连失败通报都没有）。
    //
    // 修法：`el` 在 effect 体里就拿到手（和 `snapshot` / `messagesNow` 并列）——
    // effect 每次 `history` / `params` 变化都会重跑，所以这一份记号永远是
    // "最后一次改动时那张画布"；而**画布卸载之后像素还在**（元素被 ref 引用着，
    // `drawImage` / `toDataURL` 照常工作）—— 这正是这个修法成立的原因。
    // 变异：`run` 里改回现读 `canvasElRef.current` → 下面第一句红（一个 PUT 都没有）。
    const nine = { ...makeSession(9, 1, 'S9-用户说的', 'S9'), originalName: '九号.jpg' }
    const seven = { ...makeSession(7, 1, 'S7-用户说的', 'S7'), originalName: '七号.jpg' }
    withSessions([seven, nine])
    await renderApp()
    expect(bubbleTexts()).toContain('S9-用户说的')      // A = 9（最近动过的那条）

    // 在 A 里**换一次底图**（生成式编辑）—— 只有 `baseChanged` 的那趟才带得上
    // `base`（生成落地时 `markDirty(新版本的 id, true)`）；光说话那种连待办都不标
    // （`dirtyRef` 一直是空的），钉不到这个洞。
    vi.mocked(api.postRoute).mockResolvedValueOnce(
      decision({ route: 'generate', editPrompt: '去掉路人' }))
    vi.mocked(api.postEdit).mockResolvedValue({
      imageDataUrl: 'data:image/png;base64,AAA', width: 1200, height: 800,
    })
    await say('把后面那个人去掉')      // ← 生成已经落地（底图换了）；**故意不等 waitPersist**
    // ⚠️ 这个记号要**当场**记（生成刚回来那一刻 `decodedBitmaps` 的尾巴就是它）：
    //    下面切到 B 还会解出 B 的步骤图和原图，尾巴就不再是它了。
    const genBase = decodedBitmaps.at(-1)!

    // 800ms 没到就切走：左栏「对话」→ 点开另一条（这条路的第一句就是 `flushPersist`）
    await goNav('对话')
    const row = [...container.querySelectorAll('.session-row')].find(
      r => (r.textContent ?? '').includes('七号'))
    expect(row).toBeTruthy()
    await act(async () => {
      ;(row!.querySelector('.session-open') as HTMLButtonElement).click()
      await new Promise(r => setTimeout(r, 0))
    })
    await waitPersist()

    // ★ A 那一趟要**真的发出去**，而且**带着换了的那版底图** —— 两半缺一不可：
    //   只看"有没有 PUT"，一个把 base 悄悄丢掉（或者退回旧底图）的实现照样绿，
    //   而那一版底图是用户花钱生成的，丢了就是刷新回到生成之前。
    // ★ 2026-10-08（账本 Task 7）：这条用例的**病根被连根拔掉了** —— 底图今天
    //   从**那一步的位图**编码，画布在不在跟它没关系（这正是修 spec §3 那个
    //   "刷新后参数翻倍"时白捡的好处）。所以断言从"画布直出的假货"换成
    //   "**生成回来的那张位图**"：更严了，而且再也不依赖"画布元素被 ref 攥着"。
    const putsA = putCalls('/api/sessions/9')
    expect(putsA).toHaveLength(1)
    const bodyA = bodyOf(putsA[0]!)
    expect(vi.mocked(thumbMod.bitmapToDataUrl).mock.calls.at(-1)![0]).toBe(genBase)
    expect(bodyA.base).toBe(`original:${(genBase as unknown as { __tag: string }).__tag}`)
    // 状态挂在**新长出来的那一版**上（id 写死没意义 —— 这条是从恢复来的会话，
    // 号接着服务端上那些走），不是含糊的"最后一步"。
    const stepsA = bodyA.steps as { id: number; label: string }[]
    expect(stepsA.at(-1)!.label).toBe('生成式编辑')
    expect(bodyA.stateStepId).toBe(stepsA.at(-1)!.id)
    // 顺带：切过去那条照旧接回来（切走本身没被这趟影响）
    expect(bubbleTexts()).toContain('S7-用户说的')
    expect(putCalls('/api/sessions/7')).toHaveLength(1)
  })

  it('★★ 切走之后 A 那趟落盘才回来 —— 那笔账不许被销到 B 头上（B 的下一次落盘不许重传底图）', async () => {
    // 2026-10-01 评审抓到的 Minor：这条守卫原来长在
    // `if (changed) lastPersistedBaseSeqRef.current = sending` 上，没有"我回来时
    // 还是不是当时那条"的判据。而**切走前 flush**（同一轮加的）让"A 的应答在切走
    // 之后才回来"从"几乎撞不上"变成常事：A 的应答把记号拨到 A 头上 → B 的下一次
    // 落盘以为底图换了 → **重传一整张服务端手里已经有的底图**（外加一次缩略图重做
    // + 服务端把好好的缩略图删了重存，§4.3 那条的落点）。
    // 不丢数据、不错内容 —— 纯粹白花流量、多存一份没人引用的文件。
    // ★ 2026-10-08（账本 Task 7）：记号换成了"待办"（`dirtyRef`），销账那句的形状
    // 一个字没变：`dirtyRef.current === sending && sessionIdRef.current === sessionId`
    // （前半 = "这一趟在路上时你又动了手，那笔账不许被这趟销掉"；后半 = "我回来时
    // 已经不是当时那条会话了"）。这条用例钉的是**行为**：B 的下一次落盘不许重传。
    // ⚠️ 别在这儿写"把后半去掉就红"—— 今天它**不会红**：切会话时 `loadSession`
    //   已经把待办清成 null 了，前半也拦得住；那半是保险（两层防线，缺一层都不报错，
    //   正是这个项目最怕的形状）。
    const nine = { ...makeSession(9, 1, 'S9-用户说的', 'S9'), originalName: '九号.jpg' }
    const seven = { ...makeSession(7, 1, 'S7-用户说的', 'S7'), originalName: '七号.jpg' }
    withSessions([seven, nine])

    // 挂住**打给 A 的 PUT 应答**：请求照常发出去（服务端那边已经存了），只是不回来
    const gateA = makeGate()
    const inner = fetchMock.getMockImplementation()!
    let holdA = false
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (holdA && url === '/api/sessions/9' && (init?.method ?? 'GET') === 'PUT') await gateA.promise
      return inner(url, init)
    })

    await renderApp()
    expect(bubbleTexts()).toContain('S9-用户说的')

    // 在 A 里**换一次底图**（生成式编辑）—— 只有它还欠着"像素"那一笔账
    // （`markDirty(新版本的 id, true)`，= `dirtyRef.baseChanged`）才写得到那个记号；
    // "改一句话"那种根本写不到它（那一趟连待办都没有），钉不住这个洞。
    vi.mocked(api.postRoute).mockResolvedValueOnce(
      decision({ route: 'generate', editPrompt: '去掉路人' }))
    vi.mocked(api.postEdit).mockResolvedValue({
      imageDataUrl: 'data:image/png;base64,AAA', width: 1200, height: 800,
    })
    holdA = true
    await say('把后面那个人去掉')
    await waitPersist()          // 这一趟发出去的是**底图**（应答被挂住）
    const putsA = putCalls('/api/sessions/9')
    expect(putsA.some(c => bodyOf(c).base !== undefined)).toBe(true)

    // 切到 B —— 这一趟 `loadSession` 会替 B 把记号对齐
    await goNav('对话')
    const row = [...container.querySelectorAll('.session-row')].find(
      r => (r.textContent ?? '').includes('七号'))
    expect(row).toBeTruthy()
    await act(async () => {
      ;(row!.querySelector('.session-open') as HTMLButtonElement).click()
      await new Promise(r => setTimeout(r, 0))
    })
    await waitPersist()
    expect(bubbleTexts()).toContain('S7-用户说的')
    const putsBSoFar = putCalls('/api/sessions/7').length

    // 放 A 那趟的应答回来 —— **人已经站在 B 上了**
    await act(async () => { gateA.open(); await new Promise(r => setTimeout(r, 10)) })

    // 在 B 里说一句 → B 的下一次落盘。B 的底图**没换过**，这趟不许带 `base`
    vi.mocked(api.postRoute).mockResolvedValueOnce(decision({ reply: '好。' }))
    await say('B 里说一句')
    await waitPersist()

    const putsB = putCalls('/api/sessions/7').slice(putsBSoFar)
    expect(putsB.length).toBeGreaterThan(0)
    for (const c of putsB) {
      const body = bodyOf(c)
      // ★ 这一趟的账**从头到尾是干净的**：B 没换过底图、也没人在 B 上动过手，
      //   所以上路只有"话和步骤"。谁把 A 那笔待办（或者"底图换过"那个判据）
      //   漏进这一趟，`body.base` 就是一整张 data URL、`body.thumb` 也跟着在
      //   —— 这两句当场红。
      //   （⚠️ "拆哪一句判据才会红"见函数头那条 ⚠️：今天两层防线都在，单独拿掉
      //   一层不会让这条红，所以别在这儿写"拿掉 X 就红"。）
      expect(body.base).toBeUndefined()
      expect(body.thumb).toBeUndefined()
    }
  })

  it('★ 「新的一张」回到选照片那一屏 —— 下一张会开**新的**一条，不写回旧的那条', async () => {
    // §6.4：顶栏那颗「新的一张」= "我再改一张"。它**不删**当前这条会话
    // （那条已经在服务端上存着了），只是回到上传前那一屏。
    withSessions([makeSession(7, 1, '旧的那句', 'S7')])
    await renderApp()
    expect(bubbleTexts()).toContain('S7第 0 步')
    const oldBitmaps = [...decodedBitmaps]

    const btn = [...container.querySelectorAll('.actions button')]
      .find(b => (b.textContent ?? '').trim() === '新的一张') as HTMLButtonElement | undefined
    expect(btn).toBeTruthy()
    await act(async () => { btn!.click(); await new Promise(r => setTimeout(r, 0)) })

    // ① 回到"选一张照片"那一屏；顶栏那一排（只在有图时出现）跟着收起来
    expect(container.querySelector('canvas')).toBeNull()
    expect(container.querySelector('input[type="file"]')).toBeTruthy()
    expect(container.querySelector('.actions')).toBeNull()
    // ② 刚切走那条的位图要还回去
    for (const b of oldBitmaps) expect(vi.mocked(b.close)).toHaveBeenCalled()
    // ★ ③ §6.4 明说的一句：**它不删**当前这条会话（那条已经在服务端上存着了，
    //    左栏「对话」里还找得到）。少了这条断言，"顺手把旧的那条删掉"这种
    //    改法在测试里是绿的 —— 而用户回头就找不到自己改过的东西了。
    expect(fetchMock.mock.calls.filter(([, init]) => (init?.method ?? 'GET') === 'DELETE'))
      .toHaveLength(0)
    // ⚠️ 切走那一刻**已经排上队**的那趟落盘会先发出去（`flushPersist`）——
    //    发的是上一条**自己的**内容。把此刻的条数记下来：下面要断的是**它不再长**。
    const putsTo7 = putCalls('/api/sessions/7').length

    // ④ 下一张是**新的一条会话**（`POST /api/sessions` 回的是 id 1），
    //    落盘要打在 1 上 —— 归零 `sessionId` 少一处，新照片的消息和步骤就会
    //    写进**上一条会话**（用户回头打开那条，会看到一张不是自己的照片）。
    await uploadPhoto()
    await act(async () => { await new Promise(r => setTimeout(r, 0)) })
    vi.mocked(api.postRoute).mockResolvedValueOnce(decision({ reply: '好。' }))
    await say('新的这张改一下')
    await waitPersist()
    // 旧会话一条都没多 —— 而且**说过的那几句里没有新这张的任何一个字**
    expect(putCalls('/api/sessions/7')).toHaveLength(putsTo7)
    for (const c of putCalls('/api/sessions/7')) {
      const said = bodyOf(c).messages.map((m: { text: string }) => m.text)
      expect(said).not.toContain('新的这张改一下')
    }
    const puts = putCalls('/api/sessions/1')
    expect(puts).toHaveLength(1)
    const texts = bodyOf(puts[0]!).messages.map((m: { text: string }) => m.text)
    expect(texts).toContain('新的这张改一下')
    expect(texts).not.toContain('S7第 0 步')
  })

  /**
   * 列表上把某一条删掉：先点行尾那颗「…」，再点菜单里的「删除」，最后点确认条
   * 上的「删掉」。
   *
   * ★ 2026-10-06 下午：行操作收进了「…」菜单（用户要的豆包式）—— 原来常驻的
   *   「删除」按钮没有了。⚠️ 「…」是图标键（没有可见文字）只能按类名找；菜单
   *   是行的**兄弟节点**，得从行外面（它的父元素）找。
   */
  async function deleteRow(name: string) {
    const row = [...container.querySelectorAll('.session-row')].find(
      r => (r.textContent ?? '').includes(name))
    expect(row).toBeTruthy()
    const hit = async (text: string) => {
      const b = [...row!.querySelectorAll('button')].find(
        x => (x.textContent ?? '').trim() === text) as HTMLButtonElement | undefined
      expect(b).toBeTruthy()
      await act(async () => { b!.click(); await new Promise(r => setTimeout(r, 0)) })
    }
    const step = async (el: Element | null | undefined) => {
      expect(el, '会话行上没有「…」或菜单里没有【删除】').toBeTruthy()
      await act(async () => { (el as HTMLButtonElement).click(); await new Promise(r => setTimeout(r, 0)) })
    }
    await step(row!.querySelector('.session-more'))
    await step([...(row!.parentElement ?? row!).querySelectorAll('button')].find(
      x => (x.textContent ?? '').trim() === '删除'))
    await hit('删掉')
  }

  /**
   * ★★ 2026-10-02 用户报的那条：「我把对话的历史删掉了，为什么修图中还是有我上传的照片呢」。
   *
   * 根因：`SessionsPage` 只从 App 领 `onOpen` / `onNew` —— **没有 `onDeleted`**。
   * 删掉的是服务端那一行和列表里那一格，App 手上那份"正在改的照片"**一个字节没动**。
   *
   * ⚠️ 后果不止"看着奇怪"，而且比看着奇怪糟得多：那是**静静地写不进去** ——
   *   `sessionId` 还指着一条已经不存在的会话，之后再改什么都打在 404 上
   *   （屏幕上只有一句"刚才那一步没存下来"），刷新一看全没。正是这个项目最恨的
   *   那种失败：错了不报错，只是悄悄丢东西。
   *
   * 所以要钉两件事：**照片跟着走掉** + **不再往那条死会话上写一个字**。
   */
  it('★★ 删掉**正在改**的那条会话：屏幕上那张照片跟着走，而且不许再往那条上写', async () => {
    const nine = { ...makeSession(9, 1, 'S9-用户说的', 'S9'), originalName: '九号.jpg' }
    withSessions([nine])
    await renderApp()
    // ① 开门接着上次那条：画布上有图，对话在
    expect(bubbleTexts()).toContain('S9-用户说的')
    expect(container.querySelector('canvas')).toBeTruthy()
    const openBitmaps = [...decodedBitmaps]

    // ② 说一句话 —— 那一刻 800ms 的防抖**刚排上队**，故意不等它
    vi.mocked(api.postRoute).mockResolvedValueOnce(decision({ reply: '好。' }))
    await say('删之前刚说的这句')

    // ③ 走**真入口**去「对话」把它删掉
    await goNav('对话')
    await deleteRow('九号')

    // ④ ★ 那一趟**已经排上队**的落盘不许发出去：它打的就是刚被删掉的那条，
    //    发出去只会 404，屏幕上多一句"刚才那一步没存下来" —— 一句关于
    //    **用户刚亲手删掉的那条会话**的警报。该做的是把它**扔掉**，不是 flush。
    //    ⚠️ 必须**等过那 800ms 的防抖**再断：不等的话，一个"什么都没做"的实现
    //    也过得了这一句 —— 闹钟还没响而已。
    await waitPersist()
    expect(putCalls('/api/sessions/9')).toHaveLength(0)

    // ⑤ 回「修图」：那张照片要**跟着走** —— 回到"选一张照片"那一屏
    await goNav('修图')
    expect(container.querySelector('canvas')).toBeNull()
    expect(container.querySelector('input[type="file"]')).toBeTruthy()
    //    放下的那张的位图要还回去（不还就是"删几次把标签页拖垮"）
    for (const b of openBitmaps) expect(vi.mocked(b.close)).toHaveBeenCalled()
  })

  it('删掉的是**别人那条**会话：手上正在改的这张一点都不能动', async () => {
    // 上一条的反面。用户在列表里收拾旧账是常事，而**手上这张可能正改到一半** ——
    // 删的要不是它，多动一下就是把人家干到一半的活儿抹了，而且不报错。
    // 判据只有一条：`id === sessionIdRef.current`。
    const nine = { ...makeSession(9, 1, 'S9-用户说的', 'S9'), originalName: '九号.jpg' }
    const seven = { ...makeSession(7, 1, 'S7-用户说的', 'S7'), originalName: '七号.jpg' }
    withSessions([seven, nine])
    await renderApp()                       // 接回最近动过的九号
    expect(bubbleTexts()).toContain('S9-用户说的')

    await goNav('对话')
    await deleteRow('七号')                  // 删的**不是**手上那条

    await goNav('修图')
    // 照片还在、对话还在 —— 而且之后照常能落盘
    expect(container.querySelector('canvas')).toBeTruthy()
    expect(bubbleTexts()).toContain('S9-用户说的')
    vi.mocked(api.postRoute).mockResolvedValueOnce(decision({ reply: '好。' }))
    await say('删别人的那条之后说的')
    await waitPersist()
    const puts = putCalls('/api/sessions/9')
    expect(puts).toHaveLength(1)
    expect(bodyOf(puts[0]!).messages.map((m: { text: string }) => m.text))
      .toContain('删别人的那条之后说的')
  })

  it('★ 连点两条会话：被顶掉的那一趟**不许**说「没打开」 —— 它没失败，只是慢了一步', async () => {
    // 2026-10-01 评审抓到的 Minor：`discard()` 原来只有一句 `noticeBad`。
    // 用户点了五号、还没回来又点了七号（或者手抖连点两下）时，先出发的那一趟
    // 回来一看自己已经被顶掉了，照样往屏上挂一句「这条对话没打开，再试一次？」——
    // 而屏幕上跑的是**他真正要打开的那条**：那句话说的是另一条，而且什么都没失败。
    // ★ 判据是 `gen`：**被更新的一趟顶掉不是出错** —— 位图照还（`releaseDecoded`），
    //   但通报和日志都不该有（连点两下就会走一趟这个出口，记成 error 会把真错误淹掉）。
    const five = { ...makeSession(5, 1, '五号那句', 'S5'), originalName: '五号.jpg' }
    const seven = { ...makeSession(7, 1, '七号那句', 'S7'), originalName: '七号.jpg' }
    withSessions([five, seven])
    const gate = makeGate()
    const inner = fetchMock.getMockImplementation()!
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      // 只挂住**五号那一条的详情**：七号那条照常走完 —— 于是五号这趟回来时，
      // `loadSeqRef` 已经被七号推过一格了（就是"被顶掉"那一刻的真形状）。
      if (url === '/api/sessions/5' && (init?.method ?? 'GET') === 'GET') await gate.promise
      return inner(url, init)
    })
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const clickRow = async (name: string) => {
      const row = [...container.querySelectorAll('.session-row')].find(
        r => (r.textContent ?? '').includes(name))
      expect(row).toBeTruthy()
      await act(async () => {
        ;(row!.querySelector('.session-open') as HTMLButtonElement).click()
        await new Promise(r => setTimeout(r, 0))
      })
    }

    await renderApp()                  // 挂载先接回最近动过的那条（id 7）
    await goNav('对话')
    await clickRow('五号')             // 第一趟：卡在详情上
    await goNav('对话')                // 还没回来就又回了列表
    await clickRow('七号')             // 第二趟：这一条才是用户要的
    await waitPersist()                // 七号接回来了（屏幕上现在是它）
    expect(bubbleTexts()).toContain('S7第 0 步')

    // 放五号那趟进来 —— 它晚了，但它**什么都没做错**
    await act(async () => { gate.open(); await new Promise(r => setTimeout(r, 10)) })

    // ① 那句假话一个字都不许出现
    expect(container.querySelector('.notice')?.textContent ?? '').not.toContain('没打开')
    // ② 屏幕上还是七号：被顶掉的那趟**一个状态都不许写**
    expect(bubbleTexts()).toContain('S7第 0 步')
    expect(bubbleTexts()).not.toContain('S5第 0 步')
    // ③ 也不许记成 error —— "慢了半步"不是故障
    expect(errSpy.mock.calls.some(c => String(c[0]).includes('作废'))).toBe(false)
    errSpy.mockRestore()
  })

  it('★ 自己那张照片还在开的时候点了条会话 —— 旧会话不许把它顶掉', async () => {
    // 2026-10-01 评审抓到的 Minor：`loadSession('open')` 那道"用户自己动手了"的
    // 判据（以及更早那个布尔）**看不出"有一张照片还在开"**。
    // 窗口就摆在 `onPick` 的两趟 await 中间：进门时 `pickSeqRef` 已经 +1，而
    // `baseSeqRef` 要等解码完才 +1 —— 这几十到几百毫秒里，用户回左栏点了一条
    // 会话（左栏**永远点得动**，导航从来不是 disabled）。那趟会话于是把照片、
    // 对话、步骤整段铺上来，过一会儿再被 `onPick` 盖回去（顺带把旧会话那几个
    // 刚解码出来的位图漏在内存里 —— `onPick` 关的是它闭包里的那份旧 `history`）。
    // ★ 判据是"**现在**有一张在飞"（`pickSeqRef > pickSettledSeqRef`），不是
    //   "曾经选过照片"：后者单调，而"上回那张早开好了"之后用户照样该能点开会话
    //   （★★ 那条用例走的正是这一路，别把它一起挡了）。
    withSessions([{ ...makeSession(7, 1, '上次那句', 'S7'), originalName: '七号.jpg' }])
    const detailGate = makeGate()
    const decodeGate = makeGate()
    const inner = fetchMock.getMockImplementation()!
    // ⚠️ 闸门要有开关：挂载那条恢复取的**也是** `/api/sessions/7` —— 一直挂着的话
    //   连页面都打不开（照片、顶栏那颗「新的一张」都不会出现）。下面要点开时才合上。
    let holdDetail = false
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (holdDetail && url === '/api/sessions/7' && (init?.method ?? 'GET') === 'GET') {
        await detailGate.promise
      }
      return inner(url, init)
    })
    // 选的这张卡在解码里 —— 演"正在打开照片…"那几十毫秒。
    // ⚠️ 只有 `decodeImageFile` 会吃掉这层 mock：恢复那条路走的是 `createImageBitmap`。
    vi.mocked(decodeMod.decodeImageFile).mockImplementationOnce(async () => {
      await decodeGate.promise
      return fakeDecoded('picked')
    })
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    await renderApp()                  // 恢复把 7 接回来（和这趟无关，只是要有条会话）
    // 回到"选一张照片"那一屏，然后开始选 —— 这一张就卡在解码里
    const btn = [...container.querySelectorAll('.actions button')]
      .find(b => (b.textContent ?? '').trim() === '新的一张') as HTMLButtonElement
    await act(async () => { btn.click(); await new Promise(r => setTimeout(r, 0)) })
    expect(container.querySelector('input[type="file"]')).toBeTruthy()
    const input = container.querySelector('input[type="file"]') as HTMLInputElement
    Object.defineProperty(input, 'files', {
      value: [new File(['y'], 'q.jpg', { type: 'image/jpeg' })], configurable: true })
    await act(async () => {
      input.dispatchEvent(new Event('change', { bubbles: true }))
      await new Promise(r => setTimeout(r, 0))
    })

    // 照片还在开，用户回左栏点了「七号」那一条（左栏这时候点得动）
    await goNav('对话')
    const row = [...container.querySelectorAll('.session-row')].find(
      r => (r.textContent ?? '').includes('七号'))
    expect(row).toBeTruthy()
    // 到这一刻为止打给七号的更新（「新的一张」会把上一条**没到点**的那趟落盘
    // 提前发出去，那是它该做的）。下面要断的是"这趟作废的载入**一个字节都没多写**"。
    const putsTo7 = putCalls('/api/sessions/7').length
    holdDetail = true
    await act(async () => {
      ;(row!.querySelector('.session-open') as HTMLButtonElement).click()
      await new Promise(r => setTimeout(r, 0))
    })
    // 放详情过去：这趟必须认出"他手上有一张还在开"，当场作废
    await act(async () => { detailGate.open(); await new Promise(r => setTimeout(r, 10)) })

    // ① 七号那条一个字都没上来：画布上没有它的照片，也没有它的话
    //    （用户那张还在解码，屏幕上本来就该还是"选一张照片"那一屏）
    expect(container.querySelector('canvas')).toBeNull()
    expect(bubbleTexts()).not.toContain('S7第 0 步')
    // ② 而且**一个字节都没多写**：作废的载入不许把老会话的整份状态推上服务端
    expect(putCalls('/api/sessions/7')).toHaveLength(putsTo7)
    // ③ 作废要留痕（不许静默）—— 这趟是"用户自己动手"顶掉的
    expect(errSpy.mock.calls.some(c => String(c[0]).includes('作废'))).toBe(true)

    // ④ 用户那张照常开完：画布上是它，七号的话一句都没跟过来
    await act(async () => { decodeGate.open(); await new Promise(r => setTimeout(r, 0)) })
    const shown = canvasProps.images.at(-1) as unknown as { bitmap: { __tag: string } }
    expect(shown.bitmap.__tag).toBe('picked')
    expect(bubbleTexts()).not.toContain('S7第 0 步')
    errSpy.mockRestore()
  })

  it('★ 恢复还在路上时用户先传了照片 —— 上次那条不许把新的顶掉', async () => {
    // 恢复是一串网络往返（列表 → 详情 → 每一步的图）。这几百毫秒里屏幕上
    // 还是"选一张照片"那一屏 —— 用户完全可能先自己传一张。这时候把恢复的
    // 结果盖上去，等于**把他刚传的那张顶掉**：屏幕上换成旧照片，而他刚建的那条
    // 会话在服务端已经存在（列表里凭空多一条），两边都不报错。
    // ★ 这条会话故意给**两步**，而且第 2 步带 `reusesPrev`（`makeSession` 里那个
    //   `i === 1`）：作废发生在下载之前的话，这几步一步都不许被碰到（见下面 ④）。
    //   "两步共用一个位图对象、释放时只关一次"那一件事现在由**卸载**那条用例钉着
    //   （它那条路真的会解出来再扔）。
    withSessions([makeSession(7, 2, '上次那句', 'S7')])
    const gate = makeGate()
    const inner = fetchMock.getMockImplementation()!
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === '/api/sessions' && (init?.method ?? 'GET') === 'GET') await gate.promise
      return inner(url, init)
    })
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    // 这一趟之前已经解出来过几张（上传那张走的是 `decodeImageFile`，不从这里过；
    // 记一笔是为了只数**恢复这一趟**解出来的）
    const decodedBefore = decodedBitmaps.length

    await renderApp()          // 「我是谁」回来之后，恢复就上路了，卡在列表那一趟
    await uploadPhoto()        // 用户等不及，自己传了一张
    await act(async () => { gate.open(); await new Promise(r => setTimeout(r, 0)) })

    // ① 画布上还是**用户刚传的那张**（假的解码器给它挂的记号是 `upload`）
    const shown = canvasProps.images.at(-1) as unknown as { bitmap: { __tag: string } }
    expect(shown.bitmap.__tag).toBe('upload')
    // ② 而且不许说"这是上次没做完的那张" —— 那会儿屏幕上根本不是上次那张
    expect(container.querySelector('.notice')?.textContent ?? '')
      .not.toContain('这是上次没做完的')
    // ③ 也不能静默：这一次作废要在控制台留痕
    expect(errSpy.mock.calls.some(c => String(c[0]).includes('作废'))).toBe(true)
    errSpy.mockRestore()

    // ④ ★ 作废时那些位图要关掉，而且**一个对象只关一次**。
    //    两步共用一个位图对象（第 2 步 `reusesPrev`），所以这一步只该下载一次、
    //    只该解码出一个位图；关的时候也只是**一个** —— 按对象去重（`new Set`）
    //    就是干这个的，少了它这里会变成 2。
    //
    //    ⚠️ 把这条钉住的理由不是"关两遍会抛"：2026-10-01 在真 Chrome 里试过，
    //    同一个 `ImageBitmap` 连关两次**不抛**，第二次是空操作。钉的是**意图**
    //    —— 一个位图对应一次释放，将来真出现"关了还在用的那张"这类问题时，
    //    数得清才查得动。
    //    （这个"只关一次"的账现在由下面那条**卸载**的用例管着：这一条路已经
    //      一张都不解了，见 ④。两边合起来覆盖的还是同一件事。）
    //
    // ④ ★ 这一趟**连一步都不该解**。2026-10-01（Task 6）把这道闸门从"解码之后"
    //    挪到了"拿到详情之后"：用户已经在自己那张照片上干活了，我们没理由再把
    //    旧会话那几步的图**下载回来、解码、再扔掉** —— 每张都是全尺寸图。
    //    （原来那种写法走到这儿会解出 1 张。）
    const decoded = decodedBitmaps.slice(decodedBefore)
    expect(decoded).toHaveLength(0)
  })

  it('★ 恢复下到一半页面被关掉（卸载）—— 前面已经解出来的位图一个都不许漏', async () => {
    // `alive` 那条出路（组件已经卸载）原来只关了**手上刚解出来的那一个**就 `return`
    // 了 —— 前面几步先解出来的那些**全留在那儿**，一个都没人管。而这条出路恰恰是
    // 日常里最常走的一条：恢复是"打开页面就自动跑"的，用户开完随手就关/切走，
    // 那串网络往返多半是**跑到一半被打断**的。
    // 一步的会话量不出这件事（只有一个位图，两条出路看起来一模一样）—— 要三步：
    // 第 1 步先解出来、第 2 步 `reusesPrev` 不再下载、第 3 步**卡在路上**，
    // 这时候卸载，第 3 步回来时就该把**两个**都还回去。
    withSessions([makeSession(7, 3, '上次那句', 'S7')])
    const stepGate = makeGate()
    const inner = fetchMock.getMockImplementation()!
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === '/api/sessions/7/file/step/5') await stepGate.promise
      return inner(url, init)
    })
    const decodedBefore = decodedBitmaps.length

    await renderApp()
    await act(async () => { await new Promise(r => setTimeout(r, 10)) })  // 前两步落地，卡在第 3 步
    await act(async () => root.unmount())                                // 用户把页面关了
    await act(async () => { stepGate.open(); await new Promise(r => setTimeout(r, 0)) })

    const decoded = decodedBitmaps.slice(decodedBefore)
    expect(decoded).toHaveLength(2)                     // 第 1 步那个 + 第 3 步刚解出来的那个
    for (const b of decoded) expect(vi.mocked(b.close)).toHaveBeenCalled()
    // ★ 而且**一个对象只关一次**：第 2 步是 `reusesPrev`（和第 1 步共用同一个位图），
    //   `releaseDecoded` 里那个 `new Set` 就是干这个的 —— 少了它会变成 2。
    //   （2026-10-01 Task 6：这条账原来挂在上一条用例上，那条路现在一张都不解了。）
    expect(vi.mocked(decoded[0]!.close)).toHaveBeenCalledTimes(1)
  })

  it('★ 原图取回来了、缩略图这一步却炸了 —— 那张位图照样要还回去', async () => {
    // `oi.close()` 原来**不在 `finally` 里**：`makeThumbnail` 一炸就直接跳进
    // catch，那张原图的位图从头到尾没人关。这条路上报给用户的说法是对的
    // （"原图没取回来、三颗按钮可能用不了"），所以**看不出坏** —— 但它一天天
    // 攒起来就是内存。`finally` 是让"报了错"不等于"把东西丢那儿不管"。
    withSessions([makeSession(7, 1, '上次那句', 'S7')])
    // ⚠️ 2026-10-01 终审 I2 之后，恢复**每一步都现做一张缩略图**（160 那张），
    //   所以「第一次 `makeThumbnail` 调用」已经不是原图预览了 —— 判据改成看
    //   **传给它的边长上限**：预览那张是 1280（`ORIGINAL_PREVIEW_MAX_SIDE`），
    //   气泡小图是 160。要炸的仍然只是**原图预览**那一趟。
    const realThumb = vi.mocked(thumbMod.makeThumbnail).getMockImplementation()!
    vi.mocked(thumbMod.makeThumbnail).mockImplementation((src, maxSide) => {
      if (maxSide === 1280) throw new Error('画布罢工了')
      return realThumb(src, maxSide)
    })
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const decodedBefore = decodedBitmaps.length

    await renderApp()

    // 原图那个位图是恢复这趟解出来的**第二个**（第一个是第 1 步的图）
    expect(decodedBitmaps.length - decodedBefore).toBe(2)
    expect(vi.mocked(decodedBitmaps[decodedBefore + 1]!.close)).toHaveBeenCalled()
    // 而且报错那条路照旧：坏消息要出来（缩略图炸 = 原图这条腿没走完）
    expect(errSpy.mock.calls.some(c => String(c[0]).includes('原图没取回来'))).toBe(true)
    errSpy.mockRestore()
  })

  it('★ 恢复落在"点了选图、解码还没回来"那个窗口里 —— 也不许顶掉新的', async () => {
    // 2026-10-01 评审抓到的那条缝：`onPick` 进门之后有两趟 await
    // （`decodeImageFile`、`fitToDevice`），而 `baseSeqRef` 要等解码完才 `++`。
    // 只看 `baseSeqRef` 的话，这几十~几百毫秒里恢复会以为"用户还没动手"，把旧会话
    // 照常写上去、再被 `onPick` 覆盖 —— **唯独那句通报没人覆盖**：用户盯着自己
    // 刚传的照片，屏幕上写着「这是上次没做完的那张」。那正是 §6.2 要防的错，
    // 只是方向反过来了。上一條用例（`uploadPhoto()` 整趟跑完才放行）**盖不住它** ——
    // 那时候 `baseSeqRef` 已经推过了，两道判据里少哪一道都照样绿。
    withSessions([makeSession(7, 1, '上次那句', 'S7')])
    const listGate = makeGate()
    const decodeGate = makeGate()
    const inner = fetchMock.getMockImplementation()!
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === '/api/sessions' && (init?.method ?? 'GET') === 'GET') await listGate.promise
      return inner(url, init)
    })
    vi.mocked(decodeMod.decodeImageFile).mockImplementationOnce(async () => {
      await decodeGate.promise
      return fakeDecoded('upload')
    })
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    await renderApp()               // 恢复上路，卡在列表那一趟

    // 用户点了选图 —— 只放它跑进门（置位 + setBusy），**不等它解码回来**
    const input = container.querySelector('input[type="file"]') as HTMLInputElement
    Object.defineProperty(input, 'files', {
      value: [new File(['x'], 'p.jpg', { type: 'image/jpeg' })], configurable: true })
    await act(async () => {
      input.dispatchEvent(new Event('change', { bubbles: true }))
      await new Promise(r => setTimeout(r, 0))
    })

    // 现在放恢复过去：它必须认出"用户已经动手了"，然后这次接回来的作废
    await act(async () => { listGate.open(); await new Promise(r => setTimeout(r, 0)) })
    // ① 屏幕上不许出现"这是上次没做完的" —— 照片是用户自己刚传的那张
    expect(container.querySelector('.notice')?.textContent ?? '')
      .not.toContain('这是上次没做完的')
    // ② 作废要有痕（不许静默）
    expect(errSpy.mock.calls.some(c => String(c[0]).includes('作废'))).toBe(true)

    await act(async () => { decodeGate.open(); await new Promise(r => setTimeout(r, 0)) })
    // ③ 上传照常跑完：画布上是用户那张，旧会话的话一句都没跟过来
    const shown = canvasProps.images.at(-1) as unknown as { bitmap: { __tag: string } }
    expect(shown.bitmap.__tag).toBe('upload')
    expect(bubbleTexts()).not.toContain('S7第 0 步')
    errSpy.mockRestore()
  })

  it('★ 接着说话不许撞号 —— 恢复之后新消息、新步骤的 id 要排在旧的后面', async () => {
    // 2026-10-01 评审抓到的 Critical：本地那个 id 计数器**每次挂载都从 0 重来**，
    // 而每个会话的号都从 1 开始（欢迎语 = 1，同时是第 1 步的 id）。
    // 恢复时不同步跳过去，后果全是**真 id 上的碰撞**：
    //   · 用户恢复之后说的第一句话拿到 1 —— 和接回来的欢迎语重号；
    //   · 助手那条拿到 2 —— 只要旧历史里有 id 2 的步骤，新生成的那一步就和它同号，
    //     而服务端 `mergeSteps` 是**按 id 对齐**的：旧的那条被推两遍，
    //     用户刚花钱生成的这一步**整条丢掉**，刷新就没了。
    // 原来那条 fixture 用的是 700 这种号（永远不会撞），所以整套测试都是绿的。
    const seven = makeSession(7, 3, '旧的那句', 'S7')
    withSessions([seven])
    await renderApp()

    // 前提摆出来：这条会话把 1..6 用满了（步骤 1/3/5，消息 1..6）
    const restoredMax = Math.max(
      ...seven.messages.map(m => m.id), ...seven.steps.map(s => s.id))
    expect(restoredMax).toBe(6)

    // ① 说一句普通的话（用户那条要一个新号）
    vi.mocked(api.postRoute).mockResolvedValueOnce(decision({ reply: '好。' }))
    await say('再亮一点')
    // ② 再来一次**生成**（助手那条 + 这一步也是新号）—— 这条最贵
    vi.mocked(api.postRoute).mockResolvedValueOnce(
      decision({ route: 'generate', editPrompt: '把天调蓝' }))
    vi.mocked(api.postEdit).mockResolvedValue({
      imageDataUrl: 'data:image/png;base64,AAA', width: 1200, height: 800 })
    await say('把天调蓝')
    await waitPersist()

    const body = bodyOf(putCalls('/api/sessions/7').at(-1)!)
    // ③ 一个号都不许重复 —— 重号正是"服务端按 id 对齐时把新的顶掉"的成因。
    //    注意是**各表内部**不重复：助手那条消息和它生成的那一步**本来就同号**
    //    （`say` 一次拿一个号，消息和快照共用），跨两张表去重是错的。
    const msgIds = body.messages.map((m: { id: number }) => m.id)
    const stepIds = body.steps.map((s: { id: number }) => s.id)
    expect(new Set(msgIds).size).toBe(msgIds.length)
    expect(new Set(stepIds).size).toBe(stepIds.length)
    // ④ 新加的那些号都要**严格大于**接回来的最大值
    const find = (t: string) => body.messages.find((m: { text: string }) => m.text === t)
    expect(find('再亮一点').id).toBeGreaterThan(restoredMax)
    expect(find('把天调蓝').id).toBeGreaterThan(restoredMax)
    expect(body.steps.at(-1).id).toBeGreaterThan(restoredMax)
    // ⑤ 老的步骤一步没少、也没被顶掉（这正是"丢掉刚生成那一步"的现场）
    expect(body.steps.map((s: { id: number }) => s.id).slice(0, 3)).toEqual([1, 3, 5])
  })

  it('★ 原图没取回来 —— 好消息不许把坏消息吞掉（三颗按钮都要点名）', async () => {
    // 两条通报**只有一格**（`notice` 是一个对象）。brief 的写法是"catch 里先设坏
    // 的那条、后面再无条件设一句'接着改就行'"—— 同一个批次里**后设的赢**，
    // 用户只会看到好消息，而那一刻「存进作品」「分享」「下载」其实是坏的。
    // 这条用例钉住那个合并：两半都得在，而且得留得住。
    withSessions([makeSession(7, 1, '上次那句', 'S7')], { originalFails: true })
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    await renderApp()

    const notice = container.querySelector('.notice')!
    // ① §6.2 那句不能丢 —— 正是它告诉用户照片不是刚传的
    expect(notice.textContent ?? '').toContain('这是上次没做完的那张')
    // ② 坏消息也要在，而且**三颗按钮都点名**（能分享的设备上，用户看到的是「分享」）
    expect(notice.textContent ?? '').toContain('原图没取回来')
    expect(notice.textContent ?? '').toContain('「存进作品」「分享」「下载」')
    // ③ 它得**留得住**：只有 tone: 'ok' 那条会在 4 秒后自己走
    expect(notice.className).not.toContain('ok')
    // ④ 预览确实没生成出来 —— 不是"报了坏消息但其实一切正常"
    expect(canvasProps.props.at(-1)?.originalPreview).toBeNull()
    expect(errSpy.mock.calls.some(c => String(c[0]).includes('原图没取回来'))).toBe(true)
    errSpy.mockRestore()
  })

  it('★ 票失效 → 重新登录 —— 恢复**不许**再跑一遍（那会盖掉用户手上的活儿）', async () => {
    // 依赖数组里那个 `user` 是**会变**的：票中途失效 → 回登录页 → 重新登录，
    // 走的就是"置空再填回来"，而那条路**故意不卸载 App**（修图状态原样还在）。
    // 恢复要是跟着 `user` 重跑一遍，就是拿服务端那份**盖掉他手上这份**：
    // 重新登录之前说过的那句话、改过的那一版，当场消失，而且一句话都不说。
    // （`restoreTriedRef` 就是为这条存在的；去掉它这条用例必须红。）
    const { listCount } = withSessions([makeSession(7, 1, '上次那句', 'S7')])
    // 这一趟走**真的 postRoute**，让 /api/route 真回 401（和"票失效"那条用例同款：
    // 直接 reject 一个 ApiError 会漏掉"后端回的 code 是不是 UNAUTHORIZED"那半截）
    const real = await vi.importActual<typeof import('./api/client')>('./api/client')
    vi.mocked(api.postRoute).mockImplementation(real.postRoute)
    const inner = fetchMock.getMockImplementation()!
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) =>
      url === '/api/route'
        ? jsonResponse({ error: { code: 'UNAUTHORIZED', message: '先登录一下' } }, 401)
        : inner(url, init))

    await renderApp()
    expect(bubbleTexts()).toContain('S7第 0 步')   // 接回来了
    expect(listCount()).toBe(1)

    await say('亮一点')                            // 票失效 → 回登录页
    expect(container.querySelector('.login-box')).toBeTruthy()
    // 重新登录（App 没有卸载）。`fillAndSubmit` 定义在「登录这道门」那个
    // describe 里，这边够不着，就地写一遍同款：受控输入框得走原型上的 setter。
    await act(async () => {
      const setv = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
      for (const [which, val] of [['username', '小明'], ['password', 'password123']] as const) {
        const el = container.querySelector<HTMLInputElement>(
          `.login-field input[name="${which}"]`)!
        setv.call(el, val)
        el.dispatchEvent(new Event('input', { bubbles: true }))
      }
    })
    await act(async () => {
      ;(container.querySelector('form.login-box') as HTMLFormElement)
        .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
      await new Promise(r => setTimeout(r, 0))
    })

    // ① 恢复**一次都没多跑**：列表只问过那一趟
    expect(listCount()).toBe(1)
    // ② 用户手上的活儿还在：重新登录之前说的那句、和接回来的对话，都还在
    expect(container.textContent).toContain('亮一点')
    expect(bubbleTexts()).toContain('S7第 0 步')
  })

  it('★ 老格式的会话（params 只有八根）接回来：15 根滑块都在、一个 NaN 都没有', async () => {
    // 2026-10-04「专业面板」那一轮 Task 6。会话是之前存进库里的：那一步的 `params`
    // **只有那八根**，新加的那七条（自然饱和度 / 色彩平衡三轴 / 分离色调）在那种行里
    // 根本不存在 —— 取出来是 `undefined`。不归一化的话它一路飘到底：
    //   · 面板上七根滑块落不到 0（四条量程到 -100 的停在最小端、数字那格空空）；
    //   · 色轮的三根轴算出来是 `NaN`（`data-x="NaN"`，圆点画不出来）；
    //   · 这一份还会被当成"当前参数"接着用，下次落盘照旧缺着七个键。
    // —— 全都是"不报错"的那种坏。
    //
    // ⚠️ 那两个 `as` 是**故意的**：类型上 `SessionStep['params']` 要十五个键，
    //    可**库里老数据真就是这个形状** —— 夹具要演的是"类型系统拦不住"的
    //    那个样子，不是一份合法的 `Adjustments`。`messages: []` 只是把类型补全
    //    （brief 的夹具没写这一栏），不影响这条用例要量的东西。
    const legacyParams = {
      exposure: 0, contrast: 0, highlights: 0, shadows: 0,
      saturation: 0, temperature: 0, clarity: 0, vignette: 0,
    } as unknown as Adjustments
    const legacy: SessionDetail = {
      id: 9001, title: null, originalName: '老照片.jpg',
      createdAt: 0, updatedAt: 0, hasThumb: false, stepCount: 1,
      messages: [],
      steps: [{ id: 1, label: '原图', at: 0, reusesPrev: false, params: legacyParams }],
    }
    withSessions([legacy])
    await renderApp()
    // 恢复落在修图页；面板在「调色」那一屏 —— 照本组别处用例的走法切过去
    await goNav('调色')

    // ① 面板上 15 根都在（新键缺失 → 落成 0，而不是消失）
    expect(container.querySelectorAll('.slider').length).toBe(15)
    // ② 而且每一根都**真的显示 0** —— 缺的新键不许是空数字：`undefined` 交给滑块，
    //    数字那格什么都不渲染、拇指停在量程最小端（"四条 -100"就是这么来的）。
    expect([...container.querySelectorAll('.slider-value')].map(e => e.textContent))
      .toEqual(Array<string>(15).fill('0'))
    // ③ 色轮上不许是 NaN：三根轴里任何一个 `undefined`，算出来就是 `NaN`
    //    （`data-x="NaN"` —— 真机库里那条老会话实测就是这个样子）。
    const wheel = container.querySelector('.color-wheel')
    expect(wheel?.getAttribute('data-x')).toBe('0')
    expect(wheel?.getAttribute('data-y')).toBe('0')
    // ④ 屏幕上不许出现 NaN（`undefined` 一路飘到底时渲染出来的就是这个字样）
    expect(container.textContent ?? '').not.toContain('NaN')
  })
})

describe('删除记录 —— 单条走「…」菜单，多条走勾选批量', () => {
  /** 屏幕上所有气泡的文字（用户的和助手的都在里面）。 */
  const bubbleTexts = () =>
    [...container.querySelectorAll('.bubble-text')].map(e => e.textContent ?? '')
  /** 打到某条会话上的更新请求（照「恢复」那个 describe 里那条）。 */
  const putCalls = (url: string) =>
    fetchMock.mock.calls.filter(([u, init]) => u === url && (init?.method ?? 'GET') === 'PUT')
  /** 一步一格 —— **转盘上的格子**（★ 2026-10-06 晚起对话里那两颗文字提示退役了），
   *  顺序 = 步骤顺序，站着那格是 `<span>`。 */
  const stepItems = () =>
    [...container.querySelectorAll<HTMLElement>('.strip-node')]

  /** 按**气泡文字**认那条消息（找不到时给一句人话，别让测试死在 null 上）。 */
  function msgOf(text: string): HTMLElement {
    const msg = [...container.querySelectorAll<HTMLElement>('.msg')].find(
      m => (m.querySelector('.bubble-text')?.textContent ?? '') === text)
    expect(msg, `屏幕上没有「${text}」这条消息`).toBeTruthy()
    return msg!
  }

  /**
   * 某条消息末尾那颗「…」。
   *
   * ⚠️ 它和勾选框都是**图标 / 控件键**、没有可见文字，不能像别的按钮那样按
   *   文字找（和左栏「个人设置」那颗同一条规矩：只能按类名 / `aria-label` 找）
   *   —— 所以这一组帮手都是在消息里按类名挖。
   */
  function moreBtnOf(text: string): HTMLButtonElement {
    const btn = msgOf(text).querySelector('.msg-more') as HTMLButtonElement | null
    expect(btn, `「${text}」这条上没有「…」`).toBeTruthy()
    return btn!
  }

  /** 某条消息的菜单里那颗【删除】（点开「…」之后才在）。 */
  function menuDelOf(text: string): HTMLButtonElement {
    const btn = msgOf(text).querySelector('.msg-menu .msg-menu-del') as HTMLButtonElement | null
    expect(btn, `「${text}」这条的菜单里没有【删除】`).toBeTruthy()
    return btn!
  }

  /** 某条消息的菜单里那颗【多选】。 */
  function pickItemOf(text: string): HTMLButtonElement {
    const btn = msgOf(text).querySelector('.msg-menu .msg-menu-pick') as HTMLButtonElement | null
    expect(btn, `「${text}」这条的菜单里没有【多选】`).toBeTruthy()
    return btn!
  }

  /** 某条消息的勾选框（选择模式里才有）。 */
  function pickBoxOf(text: string): HTMLInputElement {
    const box = msgOf(text).querySelector('.msg-pick') as HTMLInputElement | null
    expect(box, `「${text}」这条上没有勾选框`).toBeTruthy()
    return box!
  }

  /** 那条消息的气泡（选择模式里点它 = 勾选）。 */
  function bubbleOf(text: string): HTMLElement {
    const el = msgOf(text).querySelector('.bubble') as HTMLElement | null
    expect(el, `「${text}」这条上没有气泡`).toBeTruthy()
    return el!
  }

  /** 选择模式操作条上那颗【删除】。 */
  function selectDelBtn(): HTMLButtonElement {
    const btn = container.querySelector('.chat-select-del') as HTMLButtonElement | null
    expect(btn, '选择条上没有【删除】').toBeTruthy()
    return btn!
  }

  /** 「…」→【删除】两下 —— 单条删除就这一条路。 */
  async function delVia(text: string) {
    await clickEl(moreBtnOf(text))
    await clickEl(menuDelOf(text))
  }

  /** 「…」→【多选】两下 —— 进选择模式就这一条路。 */
  async function enterSelect(text: string) {
    await clickEl(moreBtnOf(text))
    await clickEl(pickItemOf(text))
  }

  async function clickEl(el: HTMLElement) {
    await act(async () => { el.click(); await new Promise(r => setTimeout(r, 0)) })
  }

  /** 上传 + 生成一版：messages = [欢迎(1), 用户话(2), 回复(3)]，history = [1, 3]。 */
  async function oneVersion() {
    vi.mocked(api.postRoute).mockResolvedValueOnce(
      decision({ route: 'generate', editPrompt: '改一下', reply: '好，改好了。' }))
    vi.mocked(api.postEdit).mockResolvedValue(OK)
    await renderApp()
    await uploadPhoto()
    await say('先改一次')
  }

  it('纯文字那条：点开「…」→【删除】直接删 —— 不问、时间轴不跟着走、钱一分不花', async () => {
    // ★ 2026-10-06（更晚）：**「…」一轮只有一颗、挂在助手的回复上**（用户原话：
    //   「不用每个对话下面都有省略号，可以一段对话里有一个了，一问一答就是一段
    //   对话」）—— 所以这条用例演的"纯文字那条"从**用户的话**换成了**助手的
    //   纯文字回复**（`route: 'params'` 那种，身后没有一步）。用户自己那句话
    //   现在末尾没有「…」，单删它只剩批选那条路（见下面多选那一组）。
    // ★ 2026-10-08（用户原话：「属于一段对话的记录被删除了，另一条对话记录
    //   还被保留这肯定不对的」）：**删一条 = 删它这一问一答** —— 点回复上的
    //   删除，问句一起走（不然屏幕上留一个没人回答的问题，在他眼里就是坏的）。
    vi.mocked(api.postRoute).mockResolvedValueOnce(
      decision({ route: 'params', paramDeltas: { exposure: 10 }, reply: '这句不用改图。' }))
    await renderApp()
    await uploadPhoto()
    await say('你好')
    expect(bubbleTexts()).toEqual(['准备好啦，说说想怎么改？', '你好', '这句不用改图。'])
    expect(container.querySelectorAll('.strip-node')).toHaveLength(1)   // 只有原图
    const posts = vi.mocked(api.postEdit).mock.calls.length

    // ① 点「…」之前没有菜单；点开之后菜单里有【删除】
    expect(container.querySelector('.msg-menu')).toBeNull()
    await clickEl(moreBtnOf('这句不用改图。'))
    expect(menuDelOf('这句不用改图。').textContent).toBe('删除')
    await clickEl(menuDelOf('这句不用改图。'))

    // ② 那一问一答**立刻**一起没了（身后没有一步，不用确认）
    expect(bubbleTexts()).not.toContain('这句不用改图。')
    expect(bubbleTexts()).not.toContain('你好')
    expect(container.querySelectorAll('.msg')).toHaveLength(1)
    // ③ 没有确认条；菜单也跟着那条消息一起没了（别留一条悬着的菜单）
    expect(container.textContent).not.toContain('删了就找不回来了')
    expect(container.querySelector('.msg-menu')).toBeNull()
    // ④ 它身后没有一步：时间轴上一格不少、也没花什么钱
    expect(container.querySelectorAll('.strip-node')).toHaveLength(1)
    expect(api.postEdit).toHaveBeenCalledTimes(posts)
  })

  it('带图那条：菜单里【删除】先就地问一句；「算了」→ 什么都没变', async () => {
    await oneVersion()
    const msgs = container.querySelectorAll('.msg').length
    const thumbs = container.querySelectorAll('.strip-node').length
    const posts = vi.mocked(api.postEdit).mock.calls.length

    await delVia('好，改好了。')

    // ① 菜单收掉了（问的话在条子上，菜单不再挂着）
    expect(container.querySelector('.msg-menu')).toBeNull()
    // ② 条子出来了 —— 但还没删任何东西
    expect(container.textContent).toContain('删了就找不回来了。')
    expect(bubbleTexts()).toContain('好，改好了。')
    expect(container.querySelectorAll('.msg')).toHaveLength(msgs)
    expect(container.querySelectorAll('.strip-node')).toHaveLength(thumbs)
    expect(api.postEdit).toHaveBeenCalledTimes(posts)      // 钱也没花
    // ③ 正在问它的这条上，「…」先收掉（两颗并存会像"删除点了没反应"）
    const asking = [...container.querySelectorAll<HTMLElement>('.msg')].find(
      m => m.querySelector('.msg-confirm'))
    expect(asking!.querySelector('.msg-more')).toBeNull()

    await clickByText('算了')

    // 条子收了，一切照旧（连那颗「…」都回来了）
    expect(container.textContent).not.toContain('删了就找不回来了')
    expect(bubbleTexts()).toContain('好，改好了。')
    expect(container.querySelectorAll('.msg')).toHaveLength(msgs)
    expect(container.querySelectorAll('.strip-node')).toHaveLength(thumbs)
    expect(moreBtnOf('好，改好了。').disabled).toBe(false)
  })

  it('「…」是开关：再点一下就收起；开一条时别的自己收 —— 一次只开一条', async () => {
    // ★ 2026-10-06（更晚）：「…」一轮一颗、挂在**助手那条**上 —— 所以"开 A 再开
    //   B"要**两轮**（两条回复）才演得出来，原来那版是拿"用户话 + 回复"凑的。
    vi.mocked(api.postRoute)
      .mockResolvedValueOnce(decision({ route: 'generate', editPrompt: '改一下', reply: '第一版好了。' }))
      .mockResolvedValueOnce(decision({ route: 'generate', editPrompt: '再改一下', reply: '第二版好了。' }))
    vi.mocked(api.postEdit).mockResolvedValue(OK)
    await renderApp()
    await uploadPhoto()
    await say('先改一次')
    await say('再改一次')
    // 点开 → 一条菜单；同一个「…」再点 → 收起
    await clickEl(moreBtnOf('第一版好了。'))
    expect(container.querySelectorAll('.msg-menu')).toHaveLength(1)
    await clickEl(moreBtnOf('第一版好了。'))
    expect(container.querySelectorAll('.msg-menu')).toHaveLength(0)
    // 开 A、再开 B：只剩 B 那条（A 自己收起来，不会两条菜单并排挂着）
    await clickEl(moreBtnOf('第一版好了。'))
    await clickEl(moreBtnOf('第二版好了。'))
    const menus = container.querySelectorAll('.msg-menu')
    expect(menus).toHaveLength(1)
    expect(menus[0]!.closest('.msg')?.querySelector('.bubble-text')?.textContent)
      .toBe('第二版好了。')
  })

  /**
   * ★★ 2026-10-06（用户截图报的）：「**我正常点击省略号，选项却是在下面**」。
   *
   * 那个"下面"是**滚动区外面**：菜单是就地展开的（`.msg` 的孩子、排在操作行
   * 后面），点**最后一条**消息的「…」时它会长到 `.chat-log` 的下沿之外 ——
   * 真机量过：菜单 65×75.5、**伸出 68px**。屏幕上就成了"按钮亮了、菜单没出来"
   * （要自己往下滚才看得见）—— 正是他截的那张图。
   *
   * ⚠️ jsdom 没有排版（`getBoundingClientRect` 全返回 0），所以这一组给**两只
   *   盒子**装一份假几何：对话区下沿 200、菜单下沿 260 —— "伸出 60px"就是这条
   *   要演的那件事。判据只有一条：对话区把 `scrollTop` 推了那 60px。
   */
  describe('「…」菜单不许开到滚动区外面', () => {
    /** 假几何：对话区下沿 `logBottom`、菜单下沿 `menuBottom`。 */
    function fakeBoxes(logBottom: number, menuBottom: number) {
      const log = container.querySelector('.chat-log') as HTMLElement
      Object.defineProperty(log, 'scrollTop', { value: 0, writable: true, configurable: true })
      const real = Element.prototype.getBoundingClientRect
      const rect = (bottom: number) => ({
        x: 0, y: bottom - 10, top: bottom - 10, right: 100, bottom, left: 0,
        width: 100, height: 10, toJSON: () => ({}),
      }) as DOMRect
      Element.prototype.getBoundingClientRect = function (this: Element) {
        if ((this as HTMLElement).classList?.contains('chat-log')) return rect(logBottom)
        if ((this as HTMLElement).classList?.contains('msg-menu')) return rect(menuBottom)
        return real.call(this)
      }
      return { log, restore: () => { Element.prototype.getBoundingClientRect = real } }
    }

    it('★ 最后一条：菜单伸出下沿 → 对话区跟着滚，把它带进视野', async () => {
      await oneVersion()
      const { log, restore } = fakeBoxes(200, 260)      // 伸出 60px
      try {
        const mores = [...container.querySelectorAll<HTMLButtonElement>('.msg-more')]
        await clickEl(mores[mores.length - 1])
        expect(container.querySelector('.msg-menu'), '菜单没开').toBeTruthy()
        expect(log.scrollTop, '菜单伸出去了、对话区却没跟 —— 用户看到的还是"点了没反应"')
          .toBe(60)
      } finally { restore() }
    })

    it('菜单本来就在视野里 → 一点都不滚（别把人家正在读的位置挪走）', async () => {
      await oneVersion()
      const { log, restore } = fakeBoxes(200, 180)      // 完整在视野里
      try {
        const mores = [...container.querySelectorAll<HTMLButtonElement>('.msg-more')]
        await clickEl(mores[mores.length - 1])
        expect(container.querySelector('.msg-menu')).toBeTruthy()
        expect(log.scrollTop).toBe(0)
      } finally { restore() }
    })

    /**
     * ★ 真机上量到的：修好之后菜单底边还差 **0.42px** 露在外面 —— `scrollTop`
     * 会被浏览器落成整数，差不到一个像素的那一加等于没动。所以那一滚要**向上
     * 取整**（多滚 1px 的代价是零，少滚 0.4px 就是"底下永远缺一条边"）。
     */
    it('只伸出不到一个像素 → 也要滚（scrollTop 走整数，向上取整）', async () => {
      await oneVersion()
      const { log, restore } = fakeBoxes(200.4, 260.8)  // 伸出 60.4px（.4 那截要进上去）
      try {
        const mores = [...container.querySelectorAll<HTMLButtonElement>('.msg-more')]
        await clickEl(mores[mores.length - 1])
        expect(log.scrollTop).toBe(61)
      } finally { restore() }
    })
  })

  it('★「确认删除」→ 那条话和那一步一起没；站在哪一步删它，画面就挪到**剩下的最后一步**', async () => {
    // 两版：history = [原图(1), 第1版(3), 第2版(5)]。跳到**第 1 版**上把它删掉
    // —— 剩下的最后一步是**第 2 版**（不是原图，"挪到前一个"那种写法会对不上）。
    // ★ 2026-10-08：删'第一版好了。' = 删它这一问一答 —— '先改一次'（它的问句）
    //   跟着一起走（配对的规则在 `core/messages.ts`）。
    vi.mocked(api.postRoute)
      .mockResolvedValueOnce(decision({ route: 'generate', editPrompt: '改一下', reply: '第一版好了。' }))
      .mockResolvedValueOnce(decision({ route: 'generate', editPrompt: '再改一下', reply: '第二版好了。' }))
    vi.mocked(api.postEdit).mockResolvedValue(OK)
    await renderApp()
    await uploadPhoto()
    await say('先改一次')
    await say('再改一次')

    expect(container.querySelectorAll('.strip-node')).toHaveLength(3)
    expect(decodedBitmaps).toHaveLength(2)                 // 两版各自的底图
    await clickEl(stepItems()[1]!)                         // 跳到第 1 版那一步
    expect(canvasProps.images.at(-1)).toMatchObject({ bitmap: decodedBitmaps[0] })

    await delVia('第一版好了。')
    await clickByText('确认删除')

    // ① 它这一问一答都没了；② 时间轴上少一格；③ 消息少两条（欢迎 + 再改一次 + 第2版）
    expect(bubbleTexts()).not.toContain('第一版好了。')
    expect(bubbleTexts()).not.toContain('先改一次')
    expect(container.querySelectorAll('.strip-node')).toHaveLength(2)
    expect(container.querySelectorAll('.msg')).toHaveLength(3)

    // ④ 被删那一步的位图**还了回去**；剩下那一步的位图还活着（画面正用着它）
    expect(decodedBitmaps[0]!.close).toHaveBeenCalled()
    expect(decodedBitmaps[1]!.close).not.toHaveBeenCalled()

    // ⑤ 站在被删的那一步上 → 画面挪到**剩下的最后一步**（第 2 版），
    //    转盘上那格位置标记跟着走 —— 不许留在一个已经不存在的步骤上
    expect(canvasProps.images.at(-1)).toMatchObject({ bitmap: decodedBitmaps[1] })
    expect(container.querySelectorAll('.strip-node.current')).toHaveLength(1)
    expect(stepItems().at(-1)!.className).toContain('current')   // 标记落在最后那格
    expect(stepItems()).toHaveLength(2)                    // 原图 + 第 2 版，正好两步
  })

  it('★ 删**中间**那一步（不是当前步、后面还有步）：画面一动不动，位图只还了被删那张', async () => {
    // App 接线的那一棒（`core/history.test.ts` 只在单元层钉着 `bitmapsToClose`
    // 这个 helper）：站在最新一步上删掉**中间**那一步时，画面 / 位置都不许动 ——
    // 动的只有被删那一步自己。
    vi.mocked(api.postRoute)
      .mockResolvedValueOnce(decision({ route: 'generate', editPrompt: '改一下', reply: '第一版好了。' }))
      .mockResolvedValueOnce(decision({ route: 'generate', editPrompt: '再改一下', reply: '第二版好了。' }))
    vi.mocked(api.postEdit).mockResolvedValue(OK)
    await renderApp()
    await uploadPhoto()
    const originalBase = (canvasProps.images.at(-1) as unknown as { bitmap: ImageBitmap }).bitmap
    await say('先改一次')
    await say('再改一次')

    const shown = canvasProps.images.at(-1)                // 画面上现在是第 2 版
    expect(shown).toMatchObject({ bitmap: decodedBitmaps[1] })

    await delVia('第一版好了。')             // 删的是中间那一步
    await clickByText('确认删除')

    // ① 那一问一答和那一步没了（时间轴 3 格 → 2 格），但**画面一动不动**（站的是第 2 版）
    expect(bubbleTexts()).not.toContain('第一版好了。')
    expect(bubbleTexts()).not.toContain('先改一次')   // ★ 2026-10-08：问句一起走
    expect(container.querySelectorAll('.strip-node')).toHaveLength(2)
    expect(canvasProps.images.at(-1)).toBe(shown)
    // ② 位图账：被删那一步的还了；第 2 版的和原图那张**一张都没碰**
    expect(decodedBitmaps[0]!.close).toHaveBeenCalled()
    expect(decodedBitmaps[1]!.close).not.toHaveBeenCalled()
    expect(originalBase.close).not.toHaveBeenCalled()
    // ③ 位置也没动：还站在第 2 版上（转盘那格位置标记落在最末）
    expect(stepItems().at(-1)!.className).toContain('current')
  })

  it('★（评审 Important）删掉**最新那一步**：下一趟落盘要把封面一起送上去 —— 而且是新 tip 那张', async () => {
    // 服务端手里的封面必须跟着 steps 走：只删 steps 不换封面，重开就是
    // "编辑器显示 v1、左栏列表封面是 v2"的静默不一致。根因是删除没有记账
    // （老代码推的是 `baseSeqRef`，落盘那时判"底图换过没有"用的就是它）。
    // 两版的曝光**故意不一样**：封面换没换、换成哪一版，这个数才分得出来。
    vi.mocked(api.postRoute)
      .mockResolvedValueOnce(decision({
        route: 'both', paramDeltas: { exposure: 40 }, editPrompt: '改一下', reply: '第一版好了。' }))
      .mockResolvedValueOnce(decision({
        route: 'both', paramDeltas: { exposure: -20 }, editPrompt: '再改一下', reply: '第二版好了。' }))
    vi.mocked(api.postEdit).mockResolvedValue(OK)
    await renderApp()
    await uploadPhoto()
    await say('先改一次')                                 // 第 1 版：曝光 +40
    await say('再改一次')                                 // 第 2 版：又 -20（不是同一个数）
    await waitPersist()                                   // 先把前两版追平 —— 下一趟才是"删除"那趟
    const before = putCalls('/api/sessions/1').length
    expect(bodyOf(putCalls('/api/sessions/1').at(-1)!).thumb).toBeTruthy()

    await delVia('第二版好了。')             // 站在第 2 版上删掉它
    await clickByText('确认删除')
    await waitPersist()

    const puts = putCalls('/api/sessions/1')
    expect(puts.length).toBeGreaterThan(before)
    const body = bodyOf(puts.at(-1)!)
    // ① 那一趟要**重新带上封面**（服务端才会把旧像素换掉）——
    //    变异：删除处理器里不 `markDirty(新 tip 的 id, true)` → 这一句当场红
    //    （没有待办 = 这一趟不带 thumb）。
    expect(body.thumb, '删掉最新这一步之后，落盘没把新封面送上去').toBeTruthy()
    // ② 而且它来自**新 tip 的画面**：画布现在画的是第 1 版（曝光 40）、
    //    缩略图就是从这块画布上抓的 —— 锚在"屏幕上真正看到的"上，不写死字符串
    const canvas = container.querySelector('canvas') as HTMLCanvasElement
    const rendered = JSON.parse(canvas.dataset.rendered!)
    expect(rendered.exposure).toBe(40)
    expect(body.thumb).toBe('thumb:' + JSON.stringify(rendered))
    // ③ 位图账照旧：被删那版的还了，新 tip 的还活着
    expect(decodedBitmaps[1]!.close).toHaveBeenCalled()
    expect(decodedBitmaps[0]!.close).not.toHaveBeenCalled()
  })

  it('「原图」那条没有「…」—— 它是这条会话的锚', async () => {
    await oneVersion()
    const msgs = [...container.querySelectorAll<HTMLElement>('.msg')]
    const welcome = msgs.find(
      m => (m.querySelector('.bubble-text')?.textContent ?? '').includes('准备好啦'))
    expect(welcome).toBeTruthy()
    expect(welcome!.querySelector('.msg-more')).toBeNull()
    // ⚠️ 这不是"选择器没找着"：助手那条回复上那颗照常在（★ 2026-10-06 更晚：
    //    **「…」一轮只有一颗**，所以这里从 2 变成了 1 —— 用户自己那句话也没有了，
    //    下一条用例专门钉那件事）。
    expect(msgs.filter(m => m.querySelector('.msg-more'))).toHaveLength(1)
  })

  /**
   * ★★ 2026-10-06（更晚）用户原话：「**不用每个对话下面都有省略号，可以一段对话里
   * 有一个了，一问一答就是一段对话**」。
   *
   * 落成两条：① 一轮（一问 + 一答）**只有一颗**「…」；② 挂在**助手那句回复**上
   * （一轮的末尾）—— 豆包也是这么放的（操作挂在回答底下）。
   *
   * ⚠️ 判据是 `hasMenu` 不是 `delable`：用户那句话**照样勾得动、批选里删得掉**
   *   （下面多选那一组钉着）—— "一轮一颗「…」"不该顺手把批量删除也削掉一块。
   */
  it('★「…」一轮只有一颗：挂在助手的回复上，用户自己那句话没有', async () => {
    await oneVersion()
    const byText = (t: string) => [...container.querySelectorAll<HTMLElement>('.msg')]
      .find(m => (m.querySelector('.bubble-text')?.textContent ?? '') === t)!
    expect(byText('先改一次').querySelector('.msg-more')).toBeNull()      // 用户的话：没有
    expect(byText('好，改好了。').querySelector('.msg-more')).toBeTruthy() // 助手的回复：有
    expect(container.querySelectorAll('.msg-more')).toHaveLength(1)       // 全屏就这一颗
  })

  it('删完之后落盘那一趟：被删的步骤 id 和那句话都不在 PUT 里', async () => {
    // 删是**靠"少送"完成的**（服务端 `mergeSteps` 对没送来的 id 就是删），
    // 所以这一趟 PUT 的 body 就是删除本身 —— 它脏了，删除就没生效
    // （或者更糟：把别的记录也带走了）。
    await oneVersion()
    await delVia('好，改好了。')
    await clickByText('确认删除')
    await waitPersist()

    const puts = putCalls('/api/sessions/1')
    expect(puts.length).toBeGreaterThan(0)
    const body = bodyOf(puts.at(-1)!)
    expect(body.steps.map((s: { id: number }) => s.id)).not.toContain(3)     // 被删那一步
    expect(body.messages.map((m: { id: number }) => m.id)).not.toContain(3) // 被删那句话
    expect(JSON.stringify(body)).not.toContain('改好了')
    // 而且原图那一步**还在** —— 删一条记录不是把会话清空
    expect(body.steps.map((s: { id: number }) => s.id)).toContain(1)
  })

  it('忙的时候「…」是禁用的 —— 点了也删不动', async () => {
    await oneVersion()
    // 用**路由**那一段挂住（「正在思考…」，还没开始生成）：钉的是 `busy` 这个
    // 总闸门，不是"生成中"那一格。
    // ★ 2026-10-06（更晚）：「…」只在**助手的回复**上 —— 所以要挂住的是**第二轮**
    //   的路由，这样前一轮那条回复（带着「…」）还留在屏幕上；挂第一轮的话，
    //   屏幕上压根没有「…」可点。
    const gate = makeGate<RouteDecision>()
    vi.mocked(api.postRoute).mockReturnValueOnce(gate.promise)
    await say('再改一次')
    expect(canvasProps.props.at(-1)?.busy).toBe(false)     // 这趟还没走到生成

    const btn = moreBtnOf('好，改好了。')
    expect(btn.disabled).toBe(true)

    await clickEl(btn)                                     // 点了也打不开菜单
    expect(container.querySelector('.msg-menu')).toBeNull()
    expect(bubbleTexts()).toContain('好，改好了。')

    // 放行，让这一趟收工（不留下挂着的 promise）
    await act(async () => {
      gate.open(decision({ route: 'params' }))
      await new Promise(r => setTimeout(r, 0))
    })
  })

  /**
   * ★ 2026-10-06 下午（他的第二问：「是像这样可选择性的删除吗？」——一张勾选框的
   * 截图，控制器问过之后他选的：**两种都要**）。
   *
   * 多选 = 菜单里的【多选】进"选择模式"：每条消息旁出现勾选框（「原图」那条没有
   * —— 它是锚）、输入框让位给操作条「已选 N 条 ｜ 删除 ｜ 取消」。删除那条路和
   * 单条同规矩：勾的里面**有带图的步骤**就先问一句（说清几张），全是纯文字就直删。
   *
   * 这一组钉的还是**用户看得见的行为**：怎么进、怎么勾、勾了没有、删前问没问、
   * 删完画面在哪、退出没有，以及落盘那趟送出去的干不干净。
   */
  it('菜单第二项【多选】→ 选择模式：每条一个勾选框（原图没有）、输入框让位给操作条、别的按钮全收', async () => {
    await oneVersion()
    await clickEl(moreBtnOf('好，改好了。'))
    expect(pickItemOf('好，改好了。').textContent).toBe('多选')

    await clickEl(pickItemOf('好，改好了。'))

    // 勾选框：用户话 + 回复各一个；「原图」那条没有（它是锚，不给勾）
    expect(container.querySelectorAll('.msg-pick')).toHaveLength(2)
    const welcome = [...container.querySelectorAll<HTMLElement>('.msg')].find(
      m => (m.querySelector('.bubble-text')?.textContent ?? '').includes('准备好啦'))
    expect(welcome!.querySelector('.msg-pick')).toBeNull()
    // 输入框让位给操作条
    expect(container.querySelector('.chat-input')).toBeNull()
    expect(container.querySelector('.chat-select')?.textContent).toContain('已选 0 条')
    // 平时那一排（再来一版 / 「…」）全收 —— 选择模式里没有别的可点
    expect(container.querySelectorAll('.msg-more')).toHaveLength(0)
    expect(container.querySelectorAll('.bubble-rerun')).toHaveLength(0)
  })

  it('勾一条算一条：勾的是**它这一问一答** —— 点勾选框、点那条消息都能勾；再点一下整轮取消', async () => {
    await oneVersion()
    await enterSelect('好，改好了。')
    const countText = () => container.querySelector('.chat-select')?.textContent ?? ''

    // ★ 2026-10-08（用户原话：「属于一段对话的记录被删除了，另一条对话记录
    //   还被保留这肯定不对的」）：勾的分量和删除一样是**一问一答** ——
    //   勾问句，它的回答跟着亮（"已选 N 条"数出来的就是真会走的那几条）。
    await clickEl(pickBoxOf('先改一次'))
    expect(pickBoxOf('先改一次').checked).toBe(true)
    expect(pickBoxOf('好，改好了。').checked).toBe(true)
    expect(countText()).toContain('已选 2 条')

    await clickEl(pickBoxOf('先改一次'))          // 再点一下 = 整轮取消
    expect(pickBoxOf('先改一次').checked).toBe(false)
    expect(pickBoxOf('好，改好了。').checked).toBe(false)
    expect(countText()).toContain('已选 0 条')

    await clickEl(bubbleOf('先改一次'))           // 点那条消息本身也能勾（同一条路）
    expect(countText()).toContain('已选 2 条')

    // ★ 2026-10-06（晚）：小图搬出对话区之后，"点图 = 勾选（不跳）"那个双关
    //   没有了 —— 时间轴是**纯导航**（它不在被勾的那堆东西里），选择模式下
    //   照常能跳：勾着的一条不动，只是大图换过去看一眼。
    const shown = canvasProps.images.at(-1)
    await clickEl(container.querySelectorAll<HTMLElement>('.strip-node')[0]!)  // 原图那格
    expect(canvasProps.images.at(-1)).not.toBe(shown)   // 画面真的换过去了
    expect(countText()).toContain('已选 2 条')           // 勾照样在
  })

  it('一条都没勾时【删除】是禁用的 —— 不留一个点了没用的按钮', async () => {
    await oneVersion()
    await enterSelect('好，改好了。')
    expect(selectDelBtn().disabled).toBe(true)
    await clickEl(pickBoxOf('先改一次'))
    expect(selectDelBtn().disabled).toBe(false)
  })

  it('勾的全是纯文字：点【删除】直接删 —— 不问、不花钱、删完退出选择模式', async () => {
    // ★ 2026-10-08：这一组改用 `route: 'params'` 那一轮演（身后没有一步的
    //   一问一答）—— 勾"先改一次"那种带图的，它的搭子（带图的回复）会一起
    //   被带进来，那就该走"先问一句"那条路了（下面那条用例钉着）。
    vi.mocked(api.postRoute).mockResolvedValueOnce(
      decision({ route: 'params', paramDeltas: { exposure: 10 }, reply: '这句不用改图。' }))
    await renderApp()
    await uploadPhoto()
    await say('你好')
    await enterSelect('这句不用改图。')
    const posts = vi.mocked(api.postEdit).mock.calls.length
    await clickEl(pickBoxOf('你好'))
    await clickEl(selectDelBtn())

    expect(container.textContent).not.toContain('删了就找不回来了')
    expect(bubbleTexts()).not.toContain('你好')
    expect(bubbleTexts()).not.toContain('这句不用改图。')
    expect(container.querySelectorAll('.msg')).toHaveLength(1)
    expect(container.querySelectorAll('.strip-node')).toHaveLength(1)   // 一步没动
    expect(api.postEdit).toHaveBeenCalledTimes(posts)
    // 退出选择模式：输入框回来了、勾选框没了
    expect(container.querySelector('.chat-select')).toBeNull()
    expect(container.querySelector('.chat-input')).toBeTruthy()
    expect(container.querySelectorAll('.msg-pick')).toHaveLength(0)
  })

  it('选中的里带图：先问一句（说清几张）——「算了」什么都没变、勾还都在', async () => {
    await oneVersion()
    await enterSelect('好，改好了。')
    // ★ 2026-10-08：只勾"先改一次" —— 它这一问一答会**一起亮**（配对规则），
    //   带图的那条因此照样被数进那一句里。
    await clickEl(pickBoxOf('先改一次'))
    const msgs = container.querySelectorAll('.msg').length
    const thumbs = container.querySelectorAll('.strip-node').length

    await clickEl(selectDelBtn())

    expect(container.textContent).toContain('1 张生成过的图')
    expect(container.textContent).toContain('删了就找不回来了')
    expect(container.querySelectorAll('.msg')).toHaveLength(msgs)    // 还没删
    expect(container.querySelectorAll('.strip-node')).toHaveLength(thumbs)

    await clickByText('算了')
    // 退回操作条：勾还都在、还在选择模式里
    expect(pickBoxOf('先改一次').checked).toBe(true)
    expect(pickBoxOf('好，改好了。').checked).toBe(true)
    expect(container.querySelector('.chat-select')?.textContent).toContain('已选 2 条')
  })

  it('★「确认删除」→ 选中的一起没；站在被删的那步上 → 画面挪到剩下的最后一步', async () => {
    // 两版：history = [原图(1), 第1版(3), 第2版(5)]。站在第 1 版上，把它删掉
    // —— 剩下的最后一步是第 2 版（不是原图，"挪到前一个"那种写法会对不上）。
    // ★ 2026-10-08：勾'第一版好了。' = 它这一问一答一起勾（'先改一次'跟着亮）。
    vi.mocked(api.postRoute)
      .mockResolvedValueOnce(decision({ route: 'generate', editPrompt: '改一下', reply: '第一版好了。' }))
      .mockResolvedValueOnce(decision({ route: 'generate', editPrompt: '再改一下', reply: '第二版好了。' }))
    vi.mocked(api.postEdit).mockResolvedValue(OK)
    await renderApp()
    await uploadPhoto()
    await say('先改一次')
    await say('再改一次')

    await clickEl(stepItems()[1]!)                         // 跳到第 1 版那一步
    expect(canvasProps.images.at(-1)).toMatchObject({ bitmap: decodedBitmaps[0] })

    await enterSelect('第一版好了。')
    await clickEl(pickBoxOf('第一版好了。'))
    await clickEl(selectDelBtn())
    await clickByText('确认删除')

    // ① 两句被勾的话都没了；② 时间轴少一格；③ 消息少两条（欢迎 + 再改一次 + 第2版）
    expect(bubbleTexts()).not.toContain('第一版好了。')
    expect(bubbleTexts()).not.toContain('先改一次')
    expect(container.querySelectorAll('.strip-node')).toHaveLength(2)
    expect(container.querySelectorAll('.msg')).toHaveLength(3)

    // ④ 站在被删的那一步上 → 画面挪到**剩下的最后一步**（第 2 版），
    //    转盘上那格位置标记跟着走（它挪到了最末那格）
    expect(canvasProps.images.at(-1)).toMatchObject({ bitmap: decodedBitmaps[1] })
    {
      const nodes = [...container.querySelectorAll<HTMLElement>('.strip-node')]
      expect(nodes.at(-1)!.className).toContain('current')
    }

    // ⑤ 位图账：被删那步的还了；剩下那步的还活着（画面正用着它）
    expect(decodedBitmaps[0]!.close).toHaveBeenCalled()
    expect(decodedBitmaps[1]!.close).not.toHaveBeenCalled()
    // ⑥ 退出选择模式了
    expect(container.querySelector('.chat-select')).toBeNull()
  })

  it('批量删完落盘那一趟：被删的步骤 id / 那些话都不在 PUT 里，没被删的一个不少', async () => {
    vi.mocked(api.postRoute)
      .mockResolvedValueOnce(decision({ route: 'generate', editPrompt: '改一下', reply: '第一版好了。' }))
      .mockResolvedValueOnce(decision({ route: 'generate', editPrompt: '再改一下', reply: '第二版好了。' }))
    vi.mocked(api.postEdit).mockResolvedValue(OK)
    await renderApp()
    await uploadPhoto()
    await say('先改一次')
    await say('再改一次')
    await waitPersist()

    await enterSelect('第一版好了。')
    await clickEl(pickBoxOf('第一版好了。'))    // ★ 2026-10-08：勾它 = 它的问句一起亮
    await clickEl(selectDelBtn())
    await clickByText('确认删除')
    await waitPersist()

    const body = bodyOf(putCalls('/api/sessions/1').at(-1)!)
    const stepIds = body.steps.map((s: { id: number }) => s.id)
    const msgIds = body.messages.map((m: { id: number }) => m.id)
    expect(stepIds).not.toContain(3)          // 被删那一步
    expect(msgIds).not.toContain(3)           // 那句话
    expect(msgIds).not.toContain(2)           // 它那个问句（一问一答一起走）
    expect(stepIds).toContain(1)              // 原图还在
    expect(stepIds).toContain(5)              // 第 2 版还在
    expect(JSON.stringify(body)).not.toContain('先改一次')
    expect(JSON.stringify(body)).not.toContain('第一版好了')
  })
})
