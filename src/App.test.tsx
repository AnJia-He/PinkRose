// @vitest-environment jsdom
/**
 * App 级的验收测试。**这一层以前是空的**，代价是两次真事故：
 * 一次是生成式编辑送错了图（第二次生成会把第一次花的钱作废），
 * 一次是一条路径少写一级（测试全绿，靠类型检查才发现）。
 *
 * 缺口具体是这一类：**回调的依赖数组漏一项 → 它永久捕获旧值 → 功能静默失灵**
 * （气泡照出、回复照有、照片纹丝不动，而测试和类型检查全绿）。这一层补的就是它。
 *
 * 原则：只测**用户能看见的行为**，不测实现细节 ——
 * 说了话之后该发的请求发了没有、不该花的钱花了没有、失败之后用户的设置还在不在。
 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RouteDecision, SuggestResponse } from '../shared/protocol.ts'
import { ZERO } from '../shared/adjustments.ts'

// ── 假扮：这些是浏览器能力，jsdom 里没有 ──────────────────────────────
// 原则是"只换掉必要的那一个，其余保留真的"，免得把要测的东西一起假掉。

/** 送到画布上的到底是哪一张 —— 「缩过的那张有没有真的被用上」只能这样看。
 *  用 hoisted：vi.mock 的工厂会被提到所有 import 之前执行。 */
const canvasProps = vi.hoisted(() => ({
  images: [] as { width: number; height: number }[],
  props: [] as { originalPreview: string | null; picking: boolean; marker: unknown }[],
}))

/** 画布：真的那个要 WebGL2。这里给一个真 <canvas> 并挂上 ref ——
 *  `send` 的守卫要求 canvasRef.current 非空，假成 null 的话一句都发不出去。 */
vi.mock('./ui/Canvas', async () => {
  const React = await import('react')
  return {
    default: ({ canvasRef, image, params, originalPreview, picking, marker, onPickPoint }: any) => {
      canvasProps.images.push(image)
      canvasProps.props.push({ originalPreview, picking, marker })
      return React.createElement('canvas', {
        ref: (node: HTMLElement | null) => {
          canvasRef.current = node
          // 模拟"渲染过了"：把当前参数写在节点上，缩略图能读到
          if (node) node.dataset.rendered = JSON.stringify(params)
        },
        // ⚠️ 报回来的坐标必须**跟着事件走**，不能写死 (0.5, 0.5)：
        //    写死的话"换个地方再点"那条测试永远不可能红 —— 第二次点被守卫
        //    吞掉也照样"看起来成功"。这里照真画布的意思把屏幕坐标换成 0~1
        //    （真画布除以画布的 rect，假画布除以假的宽度 1000）。
        onClick: (e: { clientX: number; clientY: number }) =>
          onPickPoint && onPickPoint(e.clientX / 1000, e.clientY / 1000),
      })
    },
  }
})

/** 问设备上限：真的那个要 WebGL2 上下文。**fitToLimit 保留真的** ——
 *  它才是要测的东西，假掉就只剩"我把自己的假设测了一遍"。 */
vi.mock('./render/limits', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./render/limits')>()
  return { ...actual, probeLimit: vi.fn() }
})

/** 真的缩像素要 2D 画布，jsdom 没有。 */
vi.mock('./image/resize', () => ({ resizeBitmap: vi.fn() }))

/** 导出那一条：`buildExportBlob` 要 canvas.toBlob（jsdom 没实现），
 *  `downloadImage` 要点一个 <a>，都会真动手。**`buildFilename` 保留真的** ——
 *  它是纯函数，而且文件名是要断言的东西。 */
vi.mock('./export/save', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./export/save')>()
  return {
    ...actual,
    buildExportBlob: vi.fn(),
    downloadImage: vi.fn(),
    shareImage: vi.fn(),
    canShareImage: vi.fn(),
  }
})

/** 送图前的缩放/编码：要 2D 画布，jsdom 没有。 */
vi.mock('./image/prepare', () => ({
  prepareForRouting: vi.fn(),
  prepareForModel: vi.fn(),
}))

/** 缩略图要 2D 画布，jsdom 没有。**返回画布上"此刻是什么颜色"** ——
 *  这样才测得出「缩略图是在画面更新之后才抓的」那件事。 */
vi.mock('./core/thumbnail', () => ({ makeThumbnail: vi.fn(), THUMB_MAX_SIDE: 160 }))

/** 把圈画进图里那一步要 2D 画布，jsdom 同样给不出来。
 *  **不假掉的话，整条「点了才花钱」的测试永远绿不了** —— 真的 markImage 会在
 *  `getContext('2d')` 那儿抛，`confirmMark` 走进 catch，`postEdit` 一次都不会被调。 */
vi.mock('./image/mark', () => ({ markImage: vi.fn(), MARKER_RADIUS_RATIO: 0.06 }))

/** 解码用户选的文件：要 createImageBitmap + 2D 画布。
 *  用 importOriginal 保留它的转发导出（size 那几个），因为别处会 import。 */
vi.mock('./image/decode', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./image/decode')>()
  return { ...actual, decodeImageFile: vi.fn() }
})

/** 三个网络出口。**保留真的 ApiError** —— App 里靠 `instanceof ApiError`
 *  决定给用户看哪句话，假掉它就把错误路径一起假掉了。 */
vi.mock('./api/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./api/client')>()
  return { ...actual, postRoute: vi.fn(), postSuggest: vi.fn(), postEdit: vi.fn() }
})

import App from './App'
import * as decodeMod from './image/decode'
import * as prepareMod from './image/prepare'
import * as api from './api/client'
import * as limitsMod from './render/limits'
import * as resizeMod from './image/resize'
import * as saveMod from './export/save'
import * as thumbMod from './core/thumbnail'
import * as markMod from './image/mark'

// ── 每张"底"带一个记号，好认出送上去的到底是哪一张 ──────────────────
let bitmapSeq = 0
function fakeBitmap(tag: string) {
  return { width: 1200, height: 800, close: vi.fn(), __tag: tag } as unknown as ImageBitmap
}
/** 上传染回来的**包装对象**（`decodeImageFile` 的返回类型），不是裸的 bitmap。 */
function fakeDecoded(tag: string) {
  return { bitmap: fakeBitmap(tag), width: 1200, height: 800 }
}

let container: HTMLDivElement
let root: Root

// ── 登录这件事（Task 7） ─────────────────────────────────────────────
/** 默认"已经登录"的那个人。修图那些测试的前提都是他。 */
const LOGGED_IN = { id: 1, username: '小明', email: 'a@b.com' }
/** 后端此刻认不认人。null = 没登录（`/api/me` 回 401）。 */
let meUser: { id: number; username: string; email: string } | null = LOGGED_IN
/** `/api/me` 这一路单独坏掉（登录成了、但紧接着那一次问不出"我是谁"）。 */
let meFails = false
/** 把 `/api/me` 那一次**挂住不回**，用来演"跟随请求还在半路"那一段。 */
let meGate: { promise: Promise<void>; open: () => void } | null = null
let fetchMock: ReturnType<typeof vi.fn>

function makeGate() {
  let open!: () => void
  const promise = new Promise<void>(res => { open = res })
  return { promise, open }
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body),
    { status, headers: { 'content-type': 'application/json' } })
}

function decision(over: Partial<RouteDecision> = {}): RouteDecision {
  return {
    route: 'params',
    paramDeltas: {},
    reply: '好。',
    editPrompt: '',
    needsDisambiguation: false,
    degraded: false,
    ...over,
  }
}

beforeEach(() => {
  // ★ 地址栏是所有用例共用的一份全局状态：上一个用例切到了 /works，
  //   不清掉的话，下一个用例一 `renderApp()` 就**已经在作品页**了。
  history.replaceState(null, '', '/')
  vi.clearAllMocks()
  bitmapSeq = 0
  canvasProps.images.length = 0
  canvasProps.props.length = 0
  ;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

  // ★ 假的缩略图 = **画布上此刻记着的那个参数**。
  //   Canvas 的 mock 每次渲染都会把当前 params 写在 data-rendered 上，
  //   所以这里拿到的就是"抓缩略图那一刻，画布显示的是哪一步"。
  //   两种入参都要接得住：画布（这一步）和位图（Task 3 的「按住看原图」）。
  vi.mocked(thumbMod.makeThumbnail).mockImplementation(
    (src: unknown) =>
      `thumb:${(src as { __tag?: string })?.__tag
        ?? (src as HTMLElement)?.dataset?.rendered
        ?? '还没画'}`)

  // 默认：设备很宽裕，什么都能画。要测"缩"的那几条自己把这个改小。
  vi.mocked(limitsMod.probeLimit).mockReturnValue({ maxSide: 8192, maxArea: null })
  // 默认：**不能分享**（和桌面浏览器一样），顶栏只有「微调 / 保存」。
  // 要测分享的那几条自己打开。
  vi.mocked(saveMod.canShareImage).mockReturnValue(false)
  vi.mocked(saveMod.buildExportBlob).mockResolvedValue(new Blob(['x'], { type: 'image/jpeg' }))
  vi.mocked(saveMod.shareImage).mockResolvedValue(undefined)
  // 真的缩像素要 2D 画布；这里让假实现回一张**带新尺寸**的位图，
  // 好断言"到底缩到了多少"——App 认的是位图自报的尺寸，不是请求的尺寸。
  vi.mocked(resizeMod.resizeBitmap).mockImplementation(
    async (_src: ImageBitmap, width: number, height: number) =>
      ({ width, height, close: vi.fn() }) as unknown as ImageBitmap)

  // 上传染回来的那张底（包一层：要用的是它的 .bitmap）
  vi.mocked(decodeMod.decodeImageFile).mockResolvedValue(fakeDecoded('upload'))
  // 路由用它（模拟"当前看到的画面"）
  vi.mocked(prepareMod.prepareForRouting).mockResolvedValue({
    dataUrl: 'data:image/jpeg;base64,ROUTING', width: 512, height: 341,
  })
  // ★ 关键：把**送进来的是哪张**回显进 dataUrl，这样断言才分得清
  //   "送的是当前这张底"还是"又送了一遍最初那张"
  vi.mocked(prepareMod.prepareForModel).mockImplementation(async (src: unknown) => ({
    dataUrl: `data:image/jpeg;base64,MODEL:${(src as { __tag: string }).__tag}`,
    width: 2048, height: 1365,
  }))
  // 生成回来的图：走 fetch -> blob -> createImageBitmap 这条真链路
  vi.stubGlobal('createImageBitmap', vi.fn(async () => fakeBitmap(`decoded-${++bitmapSeq}`)))
  // ★ 2026-09-25（Task 7）加：开页那一次 `/api/me` 要回一个**登录着的人**——
  //   这一整个文件测的是修图那条线，它的前提就是"已经登录"（后端现在只认
  //   登录过的人，不认就直接 401）。要测登录页本身的那几条把 `meUser` 置空。
  meUser = LOGGED_IN
  meFails = false
  meGate = null
  fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    if (url === '/api/me') {
      // `meGate` 演"跟随请求还在半路"：挂住不回，等测试放行
      if (meGate) await meGate.promise
      // `meFails` 演的是"登录/注册成功之后那一次问不出来"（服务器重启、网络瞬断）
      if (meFails) return jsonResponse({ error: { code: 'UNAUTHORIZED', message: '先登录一下' } }, 401)
      return meUser
        ? jsonResponse({ user: meUser })
        : jsonResponse({ error: { code: 'UNAUTHORIZED', message: '先登录一下' } }, 401)
    }
    // 注册 / 登录：把票（cookie）这件事省掉（jsdom 里没有 cookie 罐），
    // 就用"后端从此认这个人"来代替 —— 下一次 /api/me 会回他。
    if (url === '/api/login' || url === '/api/signup') {
      const body = JSON.parse(String(init?.body)) as { username: string; email?: string }
      meUser = { id: 1, username: body.username, email: body.email ?? 'a@b.com' }
      return jsonResponse({ user: meUser })
    }
    // 别的都是生成回来的那张图：fetch(url) -> blob -> createImageBitmap
    return { blob: async () => new Blob(['x']) }
  })
  vi.stubGlobal('fetch', fetchMock)

  // ★ 假的 markImage = "**画过圈的那张**"。把源图自己的记号带上、再加一层，
  //   这样断言分得清送出去的是原位图还是画了圈的：一旦谁改成不画圈直接送，
  //   送上去的那张就变回 `MODEL:upload`，测试立刻红。
  vi.mocked(markMod.markImage).mockImplementation(
    src => (({
      width: src.width, height: src.height,
      __tag: `marked:${(src as { __tag?: string }).__tag}`,
    }) as unknown as HTMLCanvasElement))

  vi.mocked(api.postSuggest).mockResolvedValue({ cards: [], degraded: false })

  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
})

// ── 三个"用户动作" ────────────────────────────────────────────────

async function renderApp() {
  await act(async () => { root.render(<App />) })
}

async function uploadPhoto() {
  const input = container.querySelector('input[type="file"]') as HTMLInputElement
  const file = new File(['x'], 'p.jpg', { type: 'image/jpeg' })
  Object.defineProperty(input, 'files', { value: [file], configurable: true })
  await act(async () => {
    input.dispatchEvent(new Event('change', { bubbles: true }))
    await new Promise(r => setTimeout(r, 0))
  })
}

/** 说一句话。输入框是非受控的，所以直接写 DOM 值再提交表单就行。 */
async function say(text: string) {
  const input = container.querySelector('input[name="text"]') as HTMLInputElement
  const form = container.querySelector('form.chat-input') as HTMLFormElement
  input.value = text
  await act(async () => {
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    await new Promise(r => setTimeout(r, 0))
  })
}

/** 助手说的最后一句（不含"正在…"那个气泡）。 */
function lastReply(): string {
  const bubbles = container.querySelectorAll('.bubble.assistant:not(.pending)')
  return bubbles.length ? (bubbles[bubbles.length - 1].textContent ?? '') : ''
}

/** 点左栏导航。按**文字**找，不按位置 —— 位置是排版的事，文字才是用户的认知。 */
async function goNav(name: string) {
  const btn = [...container.querySelectorAll('.nav button')].find(
    b => (b.textContent ?? '').trim() === name) as HTMLButtonElement
  expect(btn).toBeTruthy()
  await act(async () => {
    btn.click()
    await new Promise(r => setTimeout(r, 0))
  })
}

// ── 测试 ─────────────────────────────────────────────────────────

describe('对话式修图：钱花在对的地方', () => {
  it('说两句话改两次 —— 第二次送的是第一次改完的那张，不是最初那张', async () => {
    vi.mocked(api.postRoute).mockResolvedValue(
      decision({ route: 'generate', editPrompt: '去掉后面的路人' }))
    vi.mocked(api.postEdit).mockResolvedValue({
      imageDataUrl: "data:image/png;base64,AAA", width: 1200, height: 800,
    })

    await renderApp()
    await uploadPhoto()
    await say('把后面那个人去掉')

    expect(api.postEdit).toHaveBeenCalledTimes(1)
    expect((vi.mocked(api.postEdit).mock.calls[0][0] as { imageDataUrl: string }).imageDataUrl)
      .toContain('MODEL:upload')          // 第一次：送的就是上传的那张底

    // ★ 这一条是防"第二次生成把第一次作废"的。只测一次生成的话，
    //   送原图还是送当前底，断言分不出来。
    await say('天空换成黄昏')

    expect(api.postEdit).toHaveBeenCalledTimes(2)
    const second = (vi.mocked(api.postEdit).mock.calls[1][0] as { imageDataUrl: string }).imageDataUrl
    expect(second).toContain('MODEL:decoded-1')   // 送的是上一次生成回来的那张
    expect(second).not.toContain('MODEL:upload')  // 不是最初那张
  })

  it('只是调个色 —— 一个生成的钱都不该花，但颜色要真的调上去', async () => {
    vi.mocked(api.postRoute).mockResolvedValueOnce(
      decision({ route: 'params', paramDeltas: { exposure: 20 }, reply: '给你提亮了。' }))

    await renderApp()
    await uploadPhoto()
    await say('亮一点')

    expect(api.postEdit).not.toHaveBeenCalled()   // 纯调色这条路上一个生成的钱都不该花
    expect(lastReply()).toContain('提亮了')        // 也不能什么都不说

    // 而且要**真的生效**了：再发一句，这次请求里带的参数应当已经有那 20。
    // 少了这一半，测试就只证明"没花钱"，证明不了"钱省下来是因为颜色调上去了"。
    vi.mocked(api.postRoute).mockResolvedValueOnce(decision())
    await say('就这样')

    const second = vi.mocked(api.postRoute).mock.calls[1][0] as { params: { exposure: number } }
    expect(second.params.exposure).toBe(20)
  })

  it('回到上一步之后再说一句 —— 送的是回到的那张，不是跳之前那张', async () => {
    vi.mocked(api.postRoute).mockResolvedValue(
      decision({ route: 'generate', editPrompt: '改一下' }))
    vi.mocked(api.postEdit).mockResolvedValue({
      imageDataUrl: 'data:image/png;base64,AAA', width: 1200, height: 800,
    })

    await renderApp()
    await uploadPhoto()
    await say('先改一次')     // 生成回来的那张 = decoded-1
    await say('再改一次')     // 再生成一张      = decoded-2

    // 三步历史各挂一个「回到这一步」：原图、第一次生成、第二次生成
    const jumps = container.querySelectorAll('.bubble-jump')
    expect(jumps.length).toBe(3)

    // 退回最开始那一步（原图）
    await act(async () => { (jumps[0] as HTMLButtonElement).click() })

    await say('再来一次')

    const calls = vi.mocked(api.postEdit).mock.calls
    const last = (calls[calls.length - 1][0] as { imageDataUrl: string }).imageDataUrl
    // 已经退回原图了，送上去的就该是原图 ——
    // 要是「回到这一步」只退了历史没退画面，这里会拿到 decoded-2
    expect(last).toContain('MODEL:upload')
  })

  it('模型说「我不确定你指哪个」时 —— 一步都不许动', async () => {
    vi.mocked(api.postRoute).mockResolvedValue(
      decision({ route: 'generate', editPrompt: '去掉那个人', needsDisambiguation: true }))

    await renderApp()
    await uploadPhoto()
    await say('把那个去掉')

    // 一边问一边动手是最糟的组合：用户还没回答，钱已经花了，而且可能改错人
    expect(api.postEdit).not.toHaveBeenCalled()
    expect(lastReply()).toContain('不太确定')
  })

  it('生成失败时，用户已经调好的颜色一点都不能丢', async () => {
    vi.mocked(api.postRoute).mockResolvedValueOnce(
      decision({ route: 'both', paramDeltas: { exposure: 20 }, editPrompt: '换天空' }))
    vi.mocked(api.postEdit).mockRejectedValue(
      new api.ApiError('UPSTREAM_FAILED', 'AI 服务暂时没响应，再试一次'))

    await renderApp()
    await uploadPhoto()
    await say('亮一点，再把天空换掉')

    expect(lastReply()).toContain('再试一次')     // 失败要说话，不能闷着

    // 再发一句：这次路由请求里带的参数，应当还留着刚才那 20
    vi.mocked(api.postRoute).mockResolvedValueOnce(decision())
    await say('就这样')

    const second = vi.mocked(api.postRoute).mock.calls[1][0] as { params: { exposure: number } }
    expect(second.params.exposure).toBe(20)
  })
})

/**
 * 2026-09-23 加：**手机拍的照片，手机自己画不动**。
 *
 * 用户那台手机上实测撞到的：照片 4928×6560（32.3 MP），而那台机器自报的单边
 * 上限只有 4096。原来的行为是拒绝渲染并说明原因 —— 诚实，但用户**什么都拿不到**，
 * 而手机拍出来的照片本来就常常这么大。真实用户走到这一步只会关掉页面。
 *
 * 改成：超出上限就先把照片缩到刚好画得动，再照常修，并在对话里**明说**。
 * 说不说是这件事的关键 —— 悄悄缩是骗人，说了再缩是交付。
 */
describe('照片超出设备上限时：缩，但要说出来', () => {
  /** 用户那台手机的真实数字。 */
  const PHONE: limitsMod.RenderLimit = { maxSide: 4096, maxArea: null }
  const BIG = { width: 4928, height: 6560 }

  function uploadBigPhoto() {
    vi.mocked(decodeMod.decodeImageFile).mockResolvedValue({
      bitmap: fakeBitmap('big'), width: BIG.width, height: BIG.height,
    })
  }

  it('缩到刚好画得动，而且真的拿这张缩过的去渲染', async () => {
    vi.mocked(limitsMod.probeLimit).mockReturnValue(PHONE)
    uploadBigPhoto()

    await renderApp()
    await uploadPhoto()

    // 3076×4096 是 fitToLimit 算出来的（3076 而不是 3077：取整只往下取，
    // 宁可少一像素也不能顶过上限，理由见 src/render/limits.ts）
    expect(resizeMod.resizeBitmap).toHaveBeenCalledTimes(1)
    expect(vi.mocked(resizeMod.resizeBitmap).mock.calls[0].slice(1)).toEqual([3076, 4096])

    // ★ 只缩不换等于白缩：送到画布上的必须是缩过的那张
    expect(canvasProps.images.at(-1)).toMatchObject({ width: 3076, height: 4096 })
  })

  it('必须说出来，还要带上真实数字', async () => {
    vi.mocked(limitsMod.probeLimit).mockReturnValue(PHONE)
    uploadBigPhoto()

    await renderApp()
    await uploadPhoto()

    const said = container.textContent ?? ''
    expect(said).toContain('4928×6560')     // 原本多大
    expect(said).toContain('3076×4096')     // 按多大处理
    expect(said).toContain('比原图小')       // 代价也要说，不能只报喜
  })

  it('缩完要把原来那张位图关掉 —— 32 MP 的 GPU 内存不能就这么漏掉', async () => {
    vi.mocked(limitsMod.probeLimit).mockReturnValue(PHONE)
    uploadBigPhoto()

    await renderApp()
    await uploadPhoto()

    // 原图（4928×6560 ≈ 129 MB）换成了缩过的那张，旧的那份就没人再用了。
    // ImageBitmap 占的是 GPU 内存，不关会一直攒着 —— 这个项目已经栽过一次。
    const original = vi.mocked(decodeMod.decodeImageFile).mock.results[0].value
    expect((await original).bitmap.close).toHaveBeenCalled()
  })

  it('装得下的照片一个像素都不许动 —— 不能"反正缩一下更保险"', async () => {
    vi.mocked(limitsMod.probeLimit).mockReturnValue(PHONE)
    // 4032×3024 是普通手机原图，单边 4032 < 4096，本来就画得动
    vi.mocked(decodeMod.decodeImageFile).mockResolvedValue({
      bitmap: fakeBitmap('normal'), width: 4032, height: 3024,
    })

    await renderApp()
    await uploadPhoto()

    expect(resizeMod.resizeBitmap).not.toHaveBeenCalled()
    expect(canvasProps.images.at(-1)).toMatchObject({ width: 4032, height: 3024 })
    expect(container.textContent ?? '').not.toContain('比原图小')
  })

  it('连 WebGL2 都拿不到时不许乱缩 —— 该走原来那条"换浏览器"的提示', async () => {
    // 问不到上限说明根本没有 WebGL2。这时候按"猜一个上限"去缩是错的：
    // 真正的问题会在渲染那一步报出来，那句话比这里准（见 Canvas.tsx 的 fail）。
    vi.mocked(limitsMod.probeLimit).mockReturnValue(null)
    uploadBigPhoto()

    await renderApp()
    await uploadPhoto()

    expect(resizeMod.resizeBitmap).not.toHaveBeenCalled()
    expect(canvasProps.images.at(-1)).toMatchObject(BIG)
  })
})

/**
 * 2026-09-23 加。用户在真机上跑完那条 30 秒的线，回来说：
 * **「下载后用户第一时间是不知道在哪里的」** —— 时间够了，但那一段让人心里没底。
 *
 * 所以给一个分享入口。这里测的是**按钮的行为**；分享本身在 save.test.ts 里测。
 */
describe('导出：分享还是存下来，用户自己选', () => {
  /** 顶栏现在的按钮，从左到右。 */
  function topbarButtons(): string[] {
    return [...container.querySelectorAll('.actions button')].map(b => b.textContent ?? '')
  }

  function topbar(label: string): HTMLButtonElement {
    const btn = [...container.querySelectorAll('.actions button')]
      .find(b => (b.textContent ?? '').includes(label)) as HTMLButtonElement | undefined
    if (!btn) throw new Error(`顶栏没有「${label}」——现在只有 ${topbarButtons().join(' / ')}`)
    return btn
  }

  async function click(label: string) {
    await act(async () => {
      topbar(label).click()
      await new Promise(r => setTimeout(r, 0))
    })
  }

  it('能分享的设备上，多出一个「分享」', async () => {
    vi.mocked(saveMod.canShareImage).mockReturnValue(true)
    await renderApp()
    await uploadPhoto()
    expect(topbarButtons()).toEqual(['微调', '分享', '保存'])
  })

  it('不能分享的设备上没有「分享」—— 不留一个点了没用的按钮', async () => {
    // 桌面 Chrome 就是这样：navigator.share 在，但不认图片。
    vi.mocked(saveMod.canShareImage).mockReturnValue(false)
    await renderApp()
    await uploadPhoto()
    expect(topbarButtons()).toEqual(['微调', '保存'])
  })

  it('点「分享」→ 弹系统面板，**不走下载**', async () => {
    vi.mocked(saveMod.canShareImage).mockReturnValue(true)
    await renderApp()
    await uploadPhoto()
    await click('分享')

    expect(saveMod.shareImage).toHaveBeenCalledTimes(1)
    expect(saveMod.downloadImage).not.toHaveBeenCalled()
    // 文件名要带过去（微信那边可能用得上）
    expect(vi.mocked(saveMod.shareImage).mock.calls[0][1]).toBe('p_ruixing.jpg')
  })

  it('⚠️ 点「保存」→ 老老实实下载，**不许偷偷改成分享**', async () => {
    // 用户原话：「那有时候不想立即分享也得分享喽」。
    // 一条"能分享就一律分享"的实现会让这条红 —— 而那正是他不要的。
    vi.mocked(saveMod.canShareImage).mockReturnValue(true)
    await renderApp()
    await uploadPhoto()
    await click('保存')

    expect(saveMod.downloadImage).toHaveBeenCalledTimes(1)
    expect(saveMod.shareImage).not.toHaveBeenCalled()
  })

  it('用户关掉分享面板 → 什么都不发生，不弹错也不白下载', async () => {
    // shareImage 把"用户取消"当成正常结束（resolve）。这条钉的是 App
    // 不要去把它当失败处理 —— 当失败处理的话，用户每次取消都会被弹一句错、
    // 还会白下载一份，恰好是他刚表示不想要的东西。
    vi.mocked(saveMod.canShareImage).mockReturnValue(true)
    vi.mocked(saveMod.shareImage).mockResolvedValue(undefined)
    const alertSpy = vi.fn()
    vi.stubGlobal('alert', alertSpy)

    await renderApp()
    await uploadPhoto()
    await click('分享')

    expect(alertSpy).not.toHaveBeenCalled()
    expect(saveMod.downloadImage).not.toHaveBeenCalled()
  })

  it('分享真的失败 → 退回下载，至少让用户拿到图', async () => {
    vi.mocked(saveMod.canShareImage).mockReturnValue(true)
    vi.mocked(saveMod.shareImage).mockRejectedValue(new Error('NotAllowedError'))

    await renderApp()
    await uploadPhoto()
    await click('分享')

    expect(saveMod.downloadImage).toHaveBeenCalledTimes(1)
  })
})

/**
 * 2026-09-23 加。用户说过「对话的交付物看不到图片」—— 当时根子是版面把画布
 * 挤没了（见验收记录 §15），修好之后仍然值得把每一步的画面挂进对话里：
 * 它是「撤销」的入口（spec §2.4：不设撤销按钮，翻聊天记录就是撤销）。
 */
describe('历史缩略图：每一步都看得见', () => {
  /** 从对话里读某条助手消息挂的缩略图 */
  function thumbOf(index: number): string | null {
    const imgs = container.querySelectorAll<HTMLImageElement>('.bubble-thumb')
    return imgs[index]?.getAttribute('src') ?? null
  }

  it('传完照片，欢迎语那条上挂一张缩略图', async () => {
    await renderApp()
    await uploadPhoto()
    expect(thumbOf(0)).toBe('thumb:' + JSON.stringify(ZERO))
  })

  it('⚠️ 缩略图必须是**画面画完之后**抓的，不能是上一步的颜色', async () => {
    // 这条是整件事最容易错的地方。快照是在 setParams 的同一个批次里推入的，
    // 那一刻画布还没重画 —— 谁要是"推快照的时候顺手抓一张"，抓到的就是
    // **上一步的颜色**，而用户看到的缩略图和他点进去的画面**对不上**。
    //
    // 原理：假的 makeThumbnail 返回画布节点上记着的 params。
    // 抓早了 → 拿到上一步的 → 这条红。
    //
    // 用 'both' 而不是 'params'：纯参数路由**压根不推快照**（历史里
    // 还是只有原图那一步，缩略图也就无从谈起）；纯生成路由 params 没变，
    // 抓早抓晚拿到的一样，这条红不了。只有 'both' 同时满足
    // 「推了快照」和「params 变了」这两件事。
    vi.mocked(api.postRoute).mockResolvedValueOnce(
      decision({ route: 'both', paramDeltas: { exposure: 40 }, editPrompt: '提亮一点', reply: '提亮了。' }))
    vi.mocked(api.postEdit).mockResolvedValue({
      imageDataUrl: 'data:image/png;base64,AAA', width: 1200, height: 800,
    })

    await renderApp()
    await uploadPhoto()
    await say('亮一点')

    expect(thumbOf(1)).toBe('thumb:' + JSON.stringify({ ...ZERO, exposure: 40 }))
  })

  it('没改图的那些助手消息不挂缩略图', async () => {
    // 「我不太确定你指的是哪个」这种消息后面没有新的一步，不该挂图 ——
    // 挂了会让用户以为那一步真的改了什么。
    vi.mocked(api.postRoute).mockResolvedValueOnce(
      decision({ route: 'generate', editPrompt: '去掉那个人', needsDisambiguation: true }))

    await renderApp()
    await uploadPhoto()
    await say('把那个去掉')

    expect(container.querySelectorAll('.bubble-thumb')).toHaveLength(1)  // 只有原图那张
  })
})

/**
 * spec §2.5：「按住图 = 看原图，松手回来。跟 Instagram、美图一致，
 * 不要发明新交互。」
 *
 * 手机上有一个必须先挡掉的东西：**长按会弹出系统的"保存图片/复制"菜单**，
 * 跟我们要做的事直接打架。这条靠 CSS（见 styles.css 里那条注释），
 * 测试测不到，但真机验收要专门试一次。
 */
describe('按住看原图', () => {
  /**
   * 换一张照片。
   *
   * 应用里**没有"换一张"的入口** —— Uploader 只在还没有图的时候渲染，
   * 传完之后整页换成工作区。所以用户换一张的实际动作就是重开一次。
   * （这也是这条测试为什么不能简单再 `uploadPhoto()` 一次的原因：
   * 第二次根本找不到那个 file input。）
   */
  async function reopenWith(tag: string) {
    await act(async () => root.unmount())
    container.remove()
    container = document.createElement('div')
    document.body.appendChild(container)
    vi.mocked(decodeMod.decodeImageFile).mockResolvedValue(fakeDecoded(tag))
    root = createRoot(container)
    await renderApp()
    await uploadPhoto()
  }

  it('传完照片就备好了一张原图预览', async () => {
    await renderApp()
    await uploadPhoto()
    // 用 1280 抓的，不是 160（那是对话里的小图）
    expect(thumbMod.makeThumbnail).toHaveBeenCalledWith(
      expect.anything(), 1280)
    expect(canvasProps.props.at(-1)?.originalPreview).toContain('thumb:')
  })

  it('没传照片时没有原图预览', async () => {
    await renderApp()
    expect(canvasProps.props).toHaveLength(0)   // 画布还没渲染
  })

  it('换一张照片后，原图预览跟着换 —— 不能留着上一张', async () => {
    await renderApp()
    await uploadPhoto()
    // 假的 makeThumbnail 会把位图自带的 __tag 回显出来，所以这里读得出"是哪一张"。
    // 精确比 'thumb:upload'（不是 toContain）：从**画布**抓的话拿到的是画布上
    // 记着的 params，这里就会红 —— 而"从画布抓"正是这张预览唯一的错法
    // （那样用户按住看到的是一张带滤镜的"原图"，对比就没了意义）。
    expect(canvasProps.props.at(-1)?.originalPreview).toBe('thumb:upload')

    // 第二张换成另一张图。预览要是没更新，用户按住就会看到上一张照片。
    await reopenWith('second')
    expect(canvasProps.props.at(-1)?.originalPreview).toBe('thumb:second')
  })

  it('预览抓不到也不能把应用带走 —— 照片照修、对话照有', async () => {
    // 抓预览这件事真的会失败（拿不到 2D 上下文）。让它失败一次：
    // **第一次调用就是 onPick 里那次** —— 补缩略图的 effect 要等这次提交之后才跑。
    vi.mocked(thumbMod.makeThumbnail).mockImplementationOnce(() => {
      throw new Error('拿不到 2D 上下文，做不了缩略图')
    })
    const alertSpy = vi.fn()
    vi.stubGlobal('alert', alertSpy)

    await renderApp()
    await uploadPhoto()

    // 预览没了就是没了：Canvas 收到 null，按住不响应。这是唯一的代价。
    expect(canvasProps.props.at(-1)?.originalPreview).toBeNull()
    // 但别的一样都不能少 —— 欢迎语、以及历史里那一步（用户要靠它回到原图）。
    // 少了这些，用户拿到的是一张没有对话入口的照片，整个应用不可用。
    expect(lastReply()).toContain('准备好啦')
    expect(container.querySelectorAll('.bubble-jump')).toHaveLength(1)
    // 更不能弹"这张图打不开"—— 照片明明打开了，那是句假话。
    expect(alertSpy).not.toHaveBeenCalled()
  })
})

/**
 * spec §6.3：照片里人多的时候（"把后面那个人去掉" —— 后面三个人，哪个？），
 * 模型只能回 `needs_disambiguation`。前端请用户「在图上点一下要改的地方？」，
 * 点完把那个圈**画进图里**、连同用户的原话一起再送一次模型。
 *
 * **钱在这一步**：一次生成约 12,900 tokens。所以和用户商量后定死的是
 * **先画圈、确认了再改** —— 点错了不亏钱，还能换个地方再点。
 * 下面三条依次钉住：说拿不准 → 一分钱不花；点一下 → 还是不花；
 * **点了「就改这里」→ 这时候才花，而且送的是画过圈的那张、用的是他原来那句话**。
 */
describe('图上点选消歧', () => {
  /** 走到"模型说拿不准、正等用户点一下"这一步。 */
  async function askOnPhoto() {
    vi.mocked(api.postRoute).mockResolvedValueOnce(
      decision({ route: 'generate', editPrompt: '去掉那个人', needsDisambiguation: true }))
    await renderApp()
    await uploadPhoto()
    await say('把后面那个人去掉')
  }

  /** 在图上点一下 —— 假的 Canvas 把屏幕坐标换成 0~1（默认画面正中 0.5, 0.5）。 */
  async function tapPhoto(clientX = 500, clientY = 500) {
    const canvas = container.querySelector('canvas') as HTMLCanvasElement
    await act(async () => {
      canvas.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX, clientY }))
      await new Promise(r => setTimeout(r, 0))
    })
  }

  it('模型说拿不准 → 进入点选模式，且**一个生成的钱都不花**', async () => {
    await askOnPhoto()

    expect(api.postEdit).not.toHaveBeenCalled()          // 不许先动手
    expect(canvasProps.props.at(-1)?.picking).toBe(true) // 但请用户点一下
    expect(lastReply()).toContain('不太确定')
  })

  it('点一下 → 画面上出现标记，**还是没花钱**', async () => {
    await askOnPhoto()
    await tapPhoto()

    expect(canvasProps.props.at(-1)?.marker).toEqual({ x: 0.5, y: 0.5 })
    expect(api.postEdit).not.toHaveBeenCalled()
    expect(container.textContent).toContain('就改这里')
  })

  it('⚠️ 只有点了「就改这里」才花钱 —— 这是和用户定死的规矩', async () => {
    vi.mocked(api.postEdit).mockResolvedValue({
      imageDataUrl: 'data:image/png;base64,AAA', width: 1200, height: 800,
    })

    await askOnPhoto()
    await tapPhoto()
    expect(api.postEdit).not.toHaveBeenCalled()          // 到这儿为止还没花钱

    const confirm = [...container.querySelectorAll('button')]
      .find(b => (b.textContent ?? '').includes('就改这里')) as HTMLButtonElement
    expect(confirm).toBeTruthy()
    await act(async () => { confirm.click(); await new Promise(r => setTimeout(r, 0)) })

    expect(api.postEdit).toHaveBeenCalledTimes(1)
    // 送上去的是**画过圈的那张**，而且用的是用户原来那句话
    const req = vi.mocked(api.postEdit).mock.calls[0][0] as { editPrompt: string; imageDataUrl: string }
    expect(req.editPrompt).toContain('把后面那个人去掉')
    // ★ 位置靠圈、不靠嘴说：送出去的必须是 markImage 画过的**那一张**。
    //   谁把它改成"圈不画了、直接把原位图送上去"，这一条就红。
    expect(req.imageDataUrl).toContain('MODEL:marked:upload')

    // ★ 这一步还得挂在**一条真的消息**上。缩略图和「回到这一步」两处都是按
    //   消息 id 对号的 —— 用 `nextId()` 这种"没有消息的 id"会让这两样**双双
    //   静默失效**：用户点完圈，画面上什么都没多，也没法回到这一步。
    expect(container.querySelectorAll('.bubble-jump')).toHaveLength(2)
    expect(container.querySelectorAll('.bubble-thumb')).toHaveLength(2)
  })

  it('点错了还能换个地方再点 —— 第二次真的被采纳，不是"看着像成功"', async () => {
    await askOnPhoto()
    await tapPhoto(500, 500)
    expect(canvasProps.props.at(-1)?.marker).toEqual({ x: 0.5, y: 0.5 })

    // 换个地方再点：这一下必须**真的把标记挪过去**。
    // ★ 只断言"还能再点一下"是不够的 —— 把 `setPicking(false)` 装回
    //   onPickPoint（brief 的字面版本），第二次调用会在守卫那里 bail，
    //   而"标记还在、还是没花钱、条还在"那几条断言**照样全成立**：
    //   一条永远不会红的测试，等于没有。所以这里断的是**新坐标**。
    await tapPhoto(200, 800)
    expect(canvasProps.props.at(-1)?.marker).toEqual({ x: 0.2, y: 0.8 })
    expect(api.postEdit).not.toHaveBeenCalled()
    expect(container.textContent).toContain('就改这里')
  })

  it('⚠️ 卡片落进点选流程 —— 点了卡片，那条「就改这里」必须收掉', async () => {
    // 卡片是**会迟到**的：上传时发出去的那一次，`SUGGEST_WAIT_MS`（10 秒）一到
    // 就把用户先放出来，而它还在后台跑、回来了照样把卡片贴上。所以"卡片和
    // 确认条同时在屏上"这件事真会发生 —— 而那条确认守的是**哪一件事**，
    // 取决于用户有没有在这中间改过主意。
    //
    // 这一趟的三个时间点是关键，所以把定时器换成假的：
    //   ① 上传（卡片请求挂着）
    //   ② 10 秒到 → 超时那条路赢 → busy 清空，用户能说话了
    //   ③ 用户说了句拿不准的话 → 点选模式开着 → 卡片这时才落地
    let deliver!: (v: SuggestResponse) => void
    // 卡片那一次请求**挂着不回**（真实世界里它是"超时之后才回来"的那一半）
    vi.mocked(api.postSuggest).mockReturnValueOnce(new Promise(res => { deliver = res }))
    await renderApp()
    vi.useFakeTimers()
    try {
      const input = container.querySelector('input[type="file"]') as HTMLInputElement
      const file = new File(['x'], 'p.jpg', { type: 'image/jpeg' })
      Object.defineProperty(input, 'files', { value: [file], configurable: true })
      await act(async () => {
        input.dispatchEvent(new Event('change', { bubbles: true }))
        await vi.advanceTimersByTimeAsync(0)
      })
      // ② 10 秒过去。常量若被改大，这一步会红 —— 是响的，不是静默的。
      await act(async () => { await vi.advanceTimersByTimeAsync(10_000) })
    } finally {
      vi.useRealTimers()
    }

    vi.mocked(api.postEdit).mockResolvedValue({
      imageDataUrl: 'data:image/png;base64,AAA', width: 1200, height: 800,
    })
    vi.mocked(api.postRoute).mockResolvedValueOnce(
      decision({ route: 'generate', editPrompt: '去掉那个人', needsDisambiguation: true }))

    await say('把后面那个人去掉')
    expect(canvasProps.props.at(-1)?.picking).toBe(true)
    await tapPhoto()                          // 标记也有了
    expect(container.textContent).toContain('就改这里')

    // 但卡片是在**这之后**才落地的（① 那次请求还在半路）
    await act(async () => {
      deliver({
        cards: [{
          label: '把后面的人去掉', route: 'generate',
          paramDeltas: {}, editPrompt: '去掉后面那个人',
        }],
        degraded: false,
      })
      await new Promise(r => setTimeout(r, 0))
    })
    const card = [...container.querySelectorAll('button')].find(
      b => (b.textContent ?? '') === '把后面的人去掉') as HTMLButtonElement
    expect(card).toBeTruthy()

    // 用户改主意：点了这张卡片
    await act(async () => { card.click(); await new Promise(r => setTimeout(r, 0)) })

    expect(api.postEdit).toHaveBeenCalledTimes(1)      // 只花了卡片自己那一次
    // ★ 陈旧的那条「就改这里」守的是**已经被卡片取代的那件事**：留着它，
    //   再点一下就是白花一次生成（12,900 tokens），而且用的是旧标记 + 旧话。
    //   卡片改主意和用户开口说话是一回事 —— 上一条歧义就此翻篇。
    expect(container.textContent).not.toContain('就改这里')
    expect(canvasProps.props.at(-1)?.marker).toBeNull()
    expect(canvasProps.props.at(-1)?.picking).toBe(false)
  })

  it('⚠️ 点选期间跳回某一步 —— 那条「就改这里」必须跟着作废', async () => {
    // 「回到这一步」和缩略图是**全仓唯二没有 busy 闸门**的控件，而点选期间
    // busy 恰好是空的（模型说完"拿不准"就收工了）—— 所以这条路径**一个竞态都
    // 不需要**就够得到，用户点两下就能走到：点选期间跳走 → 确认条还在 →
    // 点「就改这里」→ confirmMark 的四道守卫全过 → 把**旧标记**画在**换过的
    // 底图**上、配旧那句话，扣一次生成的钱（约 12,900 tokens）。
    // 跳走和下一条消息是一回事：上一条歧义翻篇。
    await askOnPhoto()
    await tapPhoto()
    expect(container.textContent).toContain('就改这里')

    const jump = container.querySelector('.bubble-jump') as HTMLButtonElement
    expect(jump).toBeTruthy()
    await act(async () => { jump.click(); await new Promise(r => setTimeout(r, 0)) })

    expect(container.textContent).not.toContain('就改这里')
    expect(canvasProps.props.at(-1)?.marker).toBeNull()
    expect(canvasProps.props.at(-1)?.picking).toBe(false)
  })

  it('取消掉就不点选了（不点也能继续说话）', async () => {
    await askOnPhoto()

    const cancel = [...container.querySelectorAll('button')]
      .find(b => (b.textContent ?? '').includes('不用了')) as HTMLButtonElement
    expect(cancel).toBeTruthy()
    await act(async () => { cancel.click() })

    expect(canvasProps.props.at(-1)?.picking).toBe(false)
  })
})

/**
 * 2026-09-25 加（Task 7）。**前端从这一天起知道有"登录"这件事了**：
 * 后端那三个 AI 接口只认登录过的人，所以这一层的验收就是那两句话 ——
 * 没登录时不把修图那套挂出来（挂上去也只是让用户先挑好照片再在下一步撞 401），
 * 登录之后真的进得来。
 */
describe('登录这道门', () => {
  /** 往受控输入框里打字。React 靠自己的 value tracker 判断"值变没变"，
   *  直接写 `el.value` 它看不见 —— 得用原型上的 setter 绕过去再派一个 input 事件。 */
  function type(el: HTMLInputElement, value: string) {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
    setter.call(el, value)
    el.dispatchEvent(new Event('input', { bubbles: true }))
  }

  async function fillAndSubmit(username: string, password: string) {
    // 登录模式下就两个输入框：名字、密码
    const [name, pass] = container.querySelectorAll<HTMLInputElement>('.login-field input')
    await act(async () => {
      type(name, username)
      type(pass, password)
    })
    const form = container.querySelector('form.login-box') as HTMLFormElement
    await act(async () => {
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
      await new Promise(r => setTimeout(r, 0))
    })
  }

  const calledWith = (path: string) => fetchMock.mock.calls.filter(c => c[0] === path)

  it('没登录 → 只有登录页，修图那套一个都不挂载', async () => {
    meUser = null
    await renderApp()

    expect(container.querySelector('.login-box')).toBeTruthy()
    // 上传入口**不出现**：让用户先挑好照片、再在下一步撞 401，是最糟的顺序。
    expect(container.querySelector('input[type="file"]')).toBeNull()
  })

  it('登录成功 → 进得来（上传入口出现），请求也带着 cookie', async () => {
    meUser = null
    await renderApp()
    await fillAndSubmit('小明', 'password123')

    expect(container.querySelector('input[type="file"]')).toBeTruthy()
    expect(container.querySelector('.login-box')).toBeNull()

    // 会话在 cookie 里，不带 credentials 的话浏览器根本不发它 ——
    // 现象是「登录了还是用不了」，排查时很难往这里想（见 api/client.ts 那段注释）。
    const call = calledWith('/api/login')[0]
    expect((call[1] as RequestInit).credentials).toBe('same-origin')
    // 登录成功后 App 是**重新问一次 /api/me** 拿的真身，不是拿名字拼的假人
    expect(calledWith('/api/me').length).toBeGreaterThan(1)
  })

  it('⚠️ 密码太短 → 一个请求都不发，而且说清为什么', async () => {
    meUser = null
    await renderApp()
    await fillAndSubmit('小明', 'short')

    expect(container.textContent).toContain('密码至少 8 位')
    expect(calledWith('/api/login')).toHaveLength(0)
  })

  it('⚠️ 登录成了、紧接着那一次 /api/me 失败 → 按钮不能还是「稍等…」', async () => {
    // 这条钉的是一个**死胡同**，不是"体验差"：onDone() 只是让 App 去问一次
    // /api/me，那一次失败也返回 null，于是 App 又渲染回登录页 —— 而 React 在
    // 同一个位置**复用组件 state**，登录页里那个 busy 还是 true。
    // 用户看到的是一个永远转下去的「稍等…」，唯一的出路是刷新页面。
    //
    // 项目规矩：凡是说"不行"的地方都要同时说"那怎么办"。一个永远转的按钮
    // 连"不行"都没说 —— 用户不知道要不要等，比报错更糟。
    // 这一条不用把 `meUser` 置空：`meFails` 一开，/api/me **每一次**都回 401
    // （不管是开页那次还是跟随那次），置空那一行是冗余的。
    meFails = true
    await renderApp()
    await fillAndSubmit('小明', 'password123')

    const submit = container.querySelector('.login-submit') as HTMLButtonElement
    expect(submit.disabled).toBe(false)          // 不能卡在"忙"上
    expect(submit.textContent).toContain('登录')   // 而且要重新说清这一步是干什么的
    // 用户打过的字也得还在：让他从头再打一遍密码，是最气人的一种失败
    // （顺带它还是"组件没被重新挂载"的探针 —— 重新挂载的话 state 会清空）
    expect((container.querySelectorAll<HTMLInputElement>('.login-field input')[0]).value)
      .toBe('小明')
  })

  it('★ 跟随请求还在半路时按钮必须还是「稍等…」—— 不许留一个"再点一次"的窗口', async () => {
    // 反过来的那个坑：登录成功、`onDone()` 也调了，但 App 问「我是谁」那一次
    // **还没回来**。这时候就把按钮放开的话，用户看到的是
    // 「点完按钮又从『稍等…』变回『登录』，画面什么都没发生」—— 这正是最容易
    // 诱发"再点一下"的形状（再点一下就是第二次注册/登录请求）。
    // 窗口长度 = **一次 /api/me 往返**：本机几毫秒，但真机走移动网是几十到
    // 几百毫秒、差网能到秒级 —— 所以它得被「稍等…」盖住，而不是"反正很快"。
    meUser = null
    await renderApp()

    // 登录那一次照常成功；`onDone` 之后那一次 /api/me 挂住不回
    const gate = makeGate()
    meGate = gate
    await fillAndSubmit('小明', 'password123')

    const submit = container.querySelector('.login-submit') as HTMLButtonElement
    expect(submit.disabled).toBe(true)            // ← 窗口必须在
    expect(submit.textContent).toContain('稍等')

    // 放行：App 这才认出人，进主界面
    await act(async () => {
      gate.open()
      await new Promise(r => setTimeout(r, 0))
    })
    expect(container.querySelector('input[type="file"]')).toBeTruthy()
    expect(container.querySelector('.login-box')).toBeNull()
  })

  it('★ 用着用着票失效了（/api/route 回 401）→ 回到登录页，而不是一句提示', async () => {
    // ⚠️ 这条钉的是一个**死胡同**，落在 Task 6 和 Task 7 的**缝**里：
    // Task 6 的审查问"三个 AI 接口挡没挡住没登录的人"，Task 7 的审查问"登录页
    // 本身对不对"，**没有人问"401 到了前端之后会发生什么"**。
    // 而这一段界面上没有"退出"按钮、也没有用户管理页 —— 401 没人处理的话，
    // 用户看到的只是聊天里一句「先登录一下」，屏幕上没有任何回到登录页的路，
    // **唯一的出路是刷新页面**。和 2d333bb 修掉的是同一个形状。
    //
    // 这里**特意走真的 postRoute**（这个文件平时把它整个假掉）：让 /api/route
    // 真回一个 401，把 "401 → ApiError(UNAUTHORIZED) → App 认出来" 整条链走完。
    // 直接拿一个 ApiError 去 reject 会漏掉前半截 —— 而前半截正是"后端回的
    // code 到底是不是 UNAUTHORIZED"，链子断在那儿，App 这边再对也没用。
    const real = await vi.importActual<typeof import('./api/client')>('./api/client')
    vi.mocked(api.postRoute).mockImplementation(real.postRoute)
    const inner = fetchMock.getMockImplementation()!
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) =>
      url === '/api/route'
        ? jsonResponse({ error: { code: 'UNAUTHORIZED', message: '先登录一下' } }, 401)
        : inner(url, init))

    await renderApp()
    await uploadPhoto()
    const before = canvasProps.images.at(-1)   // 已经打开的那张照片
    await say('亮一点')

    // 回到登录页：登录框在，修图那套（连选照片的入口）整个不在了
    expect(container.querySelector('.login-box')).toBeTruthy()
    expect(container.querySelector('input[type="file"]')).toBeNull()

    // ★ 而且**再登录回来之后，那张照片还在**。
    //   这就是"置空 user 而不是整页重载"要的副作用：App 没有卸载，修图状态
    //   原样留着。少了这一条，"回登录页"可以用 `location.reload()` 蒙过去 ——
    //   用户回来面对的是一张白纸，刚才那张照片得重新选。
    await fillAndSubmit('小明', 'password123')
    // 回来了，而且**一样都没丢**：登录页没了、照片还在画布上、刚才那句话还在
    // （注意这里不能拿 `input[type=file]` 当"回来了"的判据 —— 那是**没照片**时
    //  才有的上传入口，而这一趟照片一直都在。）
    expect(container.querySelector('.login-box')).toBeNull()
    expect(canvasProps.images.at(-1)).toBe(before)
    expect(container.textContent).toContain('亮一点')
  })

  it('★ 票失效的**另一条**路（/api/edit 回 401）也得回登录页 —— 两处 catch 各要有人咬', async () => {
    // 上面那条走的是 send → /api/route；这一条走的是生成那一段 → /api/edit。
    // "回登录页"在两处 catch 里各写了一遍（send / runGenerate），**只修一处照样
    // 是一条死胡同** —— 所以两处各要有一条测试咬住。只测其中一处的话，另一处
    // 删掉之后全仓照样绿，那条缝就还开着。
    const real = await vi.importActual<typeof import('./api/client')>('./api/client')
    vi.mocked(api.postEdit).mockImplementation(real.postEdit)
    const inner = fetchMock.getMockImplementation()!
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) =>
      url === '/api/edit'
        ? jsonResponse({ error: { code: 'UNAUTHORIZED', message: '先登录一下' } }, 401)
        : inner(url, init))
    vi.mocked(api.postRoute).mockResolvedValue(
      decision({ route: 'generate', editPrompt: '去掉后面的路人' }))

    await renderApp()
    await uploadPhoto()
    await say('把后面那个人去掉')

    expect(container.querySelector('.login-box')).toBeTruthy()
    expect(container.querySelector('form.chat-input')).toBeNull()   // 修图界面整个让位
  })
})

/**
 * spec §3.2：「切导航不丢工作 —— 修到一半跑去看作品，切回来还在原地」。
 *
 * 这一条**不是靠"记得保存"**：切界面只动 `view` 这一个 state，别的 state
 * （照片、参数、对话、历史）一个都不碰，所以"不丢"是结构上的必然。
 * 测试咬住的是三样最容易在"顺手清一下"里被丢掉的：说过的话、那张底、画布。
 *
 * 后两条补的是同一个承诺的另外半边：**地址栏也是一条入口** —— 浏览器后退 / 前进
 * 得跟着走（只认那两个按钮的话，按了后退键就成了"屏幕和地址栏说的不是一回事"），
 * 以及"同一个地方再点一次"不该多推一条历史。
 *
 * ⚠️ 它同时钉住那个**会让用例互相污染的坑**：`history.pushState` 改的是
 * 全局 `location`，jsdom 里所有用例共用同一个 —— 所以上面 `beforeEach` 里
 * 那句 `history.replaceState(null, '', '/')` 是这条测试的**前提**，不是装饰。
 */
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
    expect(location.pathname).toBe('/works')

    await goNav('修图')
    // ★ 三样都还在：说过的话、那张底、那个画布
    expect(container.textContent).toContain('亮一点')
    expect(container.querySelector('canvas')).toBeTruthy()
    expect(canvasProps.images.at(-1)).toBeTruthy()
  })

  it('★ 浏览器后退 / 前进 —— 界面跟着地址走，不是只跟着那两个按钮走', async () => {
    // 按钮只是**改地址的其中一条路**。用户按的是浏览器后退键时，
    // 地址变了而 `view` 不动 —— 屏幕上是修图页、地址栏是 /works，
    // 再点一下就走到别的地方去了。popstate 就是接住这一半的。
    //
    // 这里手动 pushState + 派发 popstate 来演"后退"：真正的 history.back()
    // 在 jsdom 里是异步排队的一步，而这条要断言的**只是那个监听的契约** ——
    // 它读的就是 `location.pathname`，所以把地址摆好、把事件递进去就够。
    await renderApp()
    await uploadPhoto()
    expect(container.querySelector('.workspace')).toBeTruthy()   // 起点：修图页

    history.pushState(null, '', '/works')
    await act(async () => {
      window.dispatchEvent(new PopStateEvent('popstate'))
      await new Promise(r => setTimeout(r, 0))
    })
    // 真的切了 —— 用 .placeholder 正面确认是**作品页那一支**，不是"两边都没了"
    expect(container.querySelector('.placeholder')).toBeTruthy()
    expect(container.querySelector('.workspace')).toBeNull()

    // 再按一次前进（或者后退），回到修图页 —— 两个方向都得跟
    history.pushState(null, '', '/')
    await act(async () => {
      window.dispatchEvent(new PopStateEvent('popstate'))
      await new Promise(r => setTimeout(r, 0))
    })
    expect(container.querySelector('.workspace')).toBeTruthy()
    expect(container.querySelector('.placeholder')).toBeNull()
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
    expect(location.pathname).toBe('/works')
  })
})
