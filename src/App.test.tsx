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
  props: [] as { originalPreview: string | null; picking: boolean; marker: unknown
                  params: Record<string, number> }[],
}))

/** 画布：真的那个要 WebGL2。这里给一个真 <canvas> 并挂上 ref ——
 *  `send` 的守卫要求 canvasRef.current 非空，假成 null 的话一句都发不出去。 */
vi.mock('./ui/Canvas', async () => {
  const React = await import('react')
  return {
    default: ({ canvasRef, image, params, originalPreview, picking, marker, onPickPoint }: any) => {
      canvasProps.images.push(image)
      canvasProps.props.push({ originalPreview, picking, marker, params })
      return React.createElement('canvas', {
        ref: (node: HTMLElement | null) => {
          canvasRef.current = node
          // 模拟"渲染过了"：把当前参数写在节点上，缩略图能读到
          if (node) {
            node.dataset.rendered = JSON.stringify(params)
            // 真的 `toDataURL` 要 2D 画布，jsdom 给不出来（回一个 `'data:,'`，
            // 还往控制台刷一行 "Not implemented"）。落盘那条路要拿它当**底图**的
            // 字节（`el.toDataURL('image/jpeg', 0.9)`）—— 假的这一版把"此刻画布上
            // 是哪一版参数"带上，断言才分得清送出来的底图是哪一版。
            ;(node as HTMLCanvasElement).toDataURL = () => `canvas:${node.dataset.rendered}`
          }
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
 *  这样才测得出「缩略图是在画面更新之后才抓的」那件事。
 *
 *  ⚠️ 常量走 `importOriginal` 拿**真的那一份**，不在这里另写一个数
 *  （原来写的是 `THUMB_MAX_SIDE: 160`）。工厂式 mock **只导出它写出来的那几个名字**，
 *  缺的那个名字就是这类坑的来源。本轮实测了它的两种形态（都不是"测试会红"）：
 *    · 只写 `THUMB_MAX_SIDE`（原来的写法）：访问缺的那个名字时 vitest **当场抛**
 *      （`No "GALLERY_THUMB_MAX_SIDE" export is defined on the mock`）—— 而那句访问
 *      在 `saveOnce` 的 `try` 里，于是被 catch 吞掉、只留一行 console.error，
 *      **作品没有缩略图地存进去**，测试一条都不红；
 *    · mock 里自己写死一个旧值：那更坏 —— `makeThumbnail(canvas, 160)` 一声不吭地
 *      照做，测试全绿而量出来的尺寸永远是错的。
 *  所以只假掉 `makeThumbnail` 这一个真需要画布的东西，常量原样透传 —— 下面
 *  「★ 作品页那张缩略图的上限是 480」那一条守着这两件事。
 *
 *  `bitmapToDataUrl`（Task 4：建会话时要送的**原图**）同理，也是 canvas → `toDataURL`：
 *  不假掉的话 jsdom 那边 `getContext('2d')` 回 null，函数当场抛 —— 建会话那条路
 *  整条走不到，而现象只是屏幕上多一句"存不下来"。 */
vi.mock('./core/thumbnail', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./core/thumbnail')>()
  return { ...actual, makeThumbnail: vi.fn(), bitmapToDataUrl: vi.fn() }
})

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
import { formatSize, modelValue } from './ui/AccountPage'
import type { PublicConfig } from './api/models'
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

/** 把一个**还在飞的请求挂住不回**，返回它的 promise 和放行用的 `open`。
 *
 *  "挂住一个请求"这个动作在本文件里出现过好几处（`/api/me` 两条、建议卡片两条），
 *  手搓的写法每处都要重复三行 `let open!` + `new Promise(res => { open = res })`。
 *  `T` 是**那个请求的返回类型**（不给就是 `void`）—— 卡片那两条要的是
 *  `SuggestResponse`，写成 `void` 的话放行时带的数据会被丢掉。
 */
function makeGate<T = void>() {
  let open!: (v: T) => void
  const promise = new Promise<T>(res => { open = res })
  return { promise, open }
}

// ── 假扮：IntersectionObserver（jsdom 里没有这个浏览器能力）─────────────
// 作品页靠它知道"用户滚到底了"，而"滚动"在 jsdom 里根本演不出来 —— 所以这里
// 给一个**能被测试按下去**的假的：记下谁在观察**哪个节点**，测试想演"滚到底了"
// 就按一下。
/** 现在活着的观察者。`beforeEach` 要清空 —— 上一条用例的组件已经卸载了。 */
const ioObservers: FakeIntersectionObserver[] = []
/** 演"用户滚到底了"：把那条通知递给所有**真的在看东西**的观察者。
 *  ⚠️ 一个没看任何元素的观察者**不通知** —— `io.observe(el)` 得真的算数：
 *  把它整句删掉，这条测试必须红（"测试看不见它"那一类，这个仓库咬过好几次）。 */
function scrollToEnd() {
  for (const o of [...ioObservers]) {
    if (o.watching.size > 0) o.cb([{ isIntersecting: true }])
  }
}
class FakeIntersectionObserver {
  cb: (entries: { isIntersecting: boolean }[]) => void
  /** 正在看谁 —— 真 IO 有这个集合，假的也得有，不然 `observe()` 就是个摆设。 */
  watching = new Set<Element>()
  constructor(cb: (entries: { isIntersecting: boolean }[]) => void) {
    this.cb = cb
    ioObservers.push(this)
  }
  observe(el: Element) { this.watching.add(el) }
  unobserve(el: Element) { this.watching.delete(el) }
  /** ⚠️ 必须**真的**注销：React 每次重设观察者都会先断开上一个，
   *  不生效的话按一下"滚到底"会把那个已经作废的回调一起点火 —— limit 加两倍，
   *  而"一次滚到底到底接了多少张"正是这条要测的东西。 */
  disconnect() {
    this.watching.clear()
    const i = ioObservers.indexOf(this)
    if (i >= 0) ioObservers.splice(i, 1)
  }
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body),
    { status, headers: { 'content-type': 'application/json' } })
}

/** 一条作品的**元数据**（列表和详情这两条路共用这个形状）。
 *  原来是「作品页」那个 describe 里的局部函数，Task 12 挪到了这里 ——
 *  详情页的用例也要造同一种东西，**造两份**的话哪天接口多一个字段，
 *  只会有一份跟着改。第三个参数 `alias` 从 Task 11 起就在（默认 null = 用时间当名字）。 */
const WORK = (id: number, updatedAt: number, alias: string | null = null) =>
  ({ id, alias, createdAt: updatedAt, updatedAt, bytes: 100, hasThumb: true })

/** 给 fetch 加上"取作品列表"这一条路。**只加不改** —— 别的请求仍然走原来的实现。
 *  （原来住在「作品页」那个 describe 里；Task 8 那一轮修使用情况时，用户管理页
 *   也要拉同一个接口 —— 照上面 WORK 那条注释的道理，两个用例组共用的桩子就一份。） */
function withWorks(works: unknown[]) {
  const inner = fetchMock.getMockImplementation()!
  fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
    if (url === '/api/works' && (init?.method ?? 'GET') === 'GET') return jsonResponse({ works })
    return inner(url, init)
  })
}

/** 盖上"取作品列表失败"这一条 —— 500 + 一句服务端的话（用 sentinel 认领它）。 */
function withWorksError(message: string) {
  const inner = fetchMock.getMockImplementation()!
  fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
    if (url === '/api/works' && (init?.method ?? 'GET') === 'GET') {
      return jsonResponse({ error: { code: 'INTERNAL', message } }, 500)
    }
    return inner(url, init)
  })
}

/** 挂住"取作品列表"这一条（演"请求还在半路"）。返回放行开关。 */
function withWorksGate() {
  const inner = fetchMock.getMockImplementation()!
  let open: () => void = () => {}
  const promise = new Promise<void>((r) => { open = r })
  fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
    if (url === '/api/works' && (init?.method ?? 'GET') === 'GET') {
      await promise
      return jsonResponse({ works: [] })
    }
    return inner(url, init)
  })
  return { open }
}

/** 一套模型配置的**公共形状**（Task 9，§7.4）。
 *  ⚠️ 这里**没有 `apiKey`**，也不许有 —— 服务端只回 `keyHint`（头尾两位），
 *  明文钥匙连界面都拿不到（§7.7）。这个形状和 `src/api/models.ts` 的
 *  `PublicConfig` 是同一个，所以直接用它当类型：接口多一个字段时两边一起红。 */
const MODEL = (id: number, o: Partial<PublicConfig> = {}): PublicConfig => ({
  id, kind: 'chat', provider: 'openai-compatible',
  baseUrl: 'https://api.deepseek.com/v1', modelId: 'deepseek-chat',
  alias: '我的便宜货', keyHint: 'sk-…4f2', active: false, ...o,
})

/** 给 fetch 加上"取模型清单"这一条路（`GET /api/models`）。
 *  用户管理页的「模型」那一行要拿它算右边那格写什么，模型设置页整页都要它。 */
function withModels(configs: PublicConfig[]) {
  const inner = fetchMock.getMockImplementation()!
  fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
    if (url === '/api/models' && (init?.method ?? 'GET') === 'GET') return jsonResponse({ configs })
    return inner(url, init)
  })
}

/** 盖上"取模型清单失败"这一条 —— 500 + 一句服务端的话（用 sentinel 认领它）。 */
function withModelsError(message: string) {
  const inner = fetchMock.getMockImplementation()!
  fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
    if (url === '/api/models' && (init?.method ?? 'GET') === 'GET') {
      return jsonResponse({ error: { code: 'INTERNAL', message } }, 500)
    }
    return inner(url, init)
  })
}

/** 盖上"**建会话失败**"这一条 —— 500。
 *  演的是"那一次锦上添花没成"：修图照常，但屏幕上必须说一声（Task 4）。 */
function withSessionsError() {
  const inner = fetchMock.getMockImplementation()!
  fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
    if (url === '/api/sessions' && (init?.method ?? 'GET') === 'POST') {
      return jsonResponse({ error: { code: 'INTERNAL', message: '建不起来' } }, 500)
    }
    return inner(url, init)
  })
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
  // ★ 地址栏是所有用例共用的一份全局状态：上一个用例切到了 /app/works，
  //   不清掉的话，下一个用例一 `renderApp()` 就**已经在作品页**了。
  //
  // ⚠️ 起点是 **`/app` 不是 `/`**（2026-09-30 改）：`/` 现在是**落地页**，
  //   而这一个文件测的是 App。摆成 `/` 的话每一条用例渲染出来的都是落地页
  //   （App 里那条 `view.kind === 'landing'` 的早返回），**76 条一起红**。
  history.replaceState(null, '', '/app')
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

  // ★ 假的 `bitmapToDataUrl` = **原图那一版**，前缀和缩略图**分开**。
  //   分开是有用的：会话的 `image` 字段是"回头接着改的那张底"，它必须走
  //   `bitmapToDataUrl`（0.92 画质、不缩边）。谁要是拿 `makeThumbnail` 顶上，
  //   送上去的就会变成 `thumb:…` —— 断言当场红。不分开的话两者一模一样，
  //   用户的底图**静默地**变糊，测试全绿。
  vi.mocked(thumbMod.bitmapToDataUrl).mockImplementation(
    (src: unknown) => `original:${(src as { __tag?: string })?.__tag ?? '画布'}`)

  // 默认：设备很宽裕，什么都能画。要测"缩"的那几条自己把这个改小。
  vi.mocked(limitsMod.probeLimit).mockReturnValue({ maxSide: 8192, maxArea: null })
  // 默认：**不能分享**（和桌面浏览器一样），顶栏只有「调色 / 保存」。
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
    // 作品列表（Task 11）：默认这个账号**还没有作品** —— 切导航那几条会走到作品页，
    // 而"接口根本没接上"（下面那句兜底的 blob 形状）会让它显示一句读取失败。
    // 要测有作品的样子，各用例自己用 withWorks 盖上一条真的。
    if (url === '/api/works' && (init?.method ?? 'GET') === 'GET') {
      return jsonResponse({ works: [] })
    }
    // 模型清单（Task 9）：用户管理页的「模型」那一行要拿它算右边那格。
    // 默认**一套都没有**（右边写「默认」，那是事实）—— 要测"接了模型"的样子，
    // 各用例自己用 withModels 盖上一条真的。
    if (url === '/api/models' && (init?.method ?? 'GET') === 'GET') {
      return jsonResponse({ configs: [] })
    }
    // 会话（Task 4）：**上传照片就会建一条**。默认**建得成**（id = 1）——
    // 「服务端没建成就不能假装在存」那条用例自己把这一格盖成 500。
    if (url === '/api/sessions' && (init?.method ?? 'GET') === 'POST') {
      return jsonResponse({ id: 1 })
    }
    // 每一步落盘那次更新（`PUT /api/sessions/:id`）。⚠️ **必须接住**：
    // 落盘那一层有 800ms 防抖，慢机器上真有用例会活过那一秒 —— 掉进下面
    // 兜底那个 blob 形状的话，屏幕上会多出一条"刚才那一步没存下来"的通报，
    // 而它跟那条用例要测的事**一点关系都没有**（随机噪声比没有测试更糟）。
    if (/^\/api\/sessions\/\d+$/.test(url) && (init?.method ?? 'GET') === 'PUT') {
      // 响应是 `SessionMeta`；App 那边不用它的内容（只等它成功），给形状就行。
      return jsonResponse({
        id: 1, title: null, originalName: null,
        createdAt: 0, updatedAt: 0, hasThumb: false, stepCount: 1,
      })
    }
    // 退出登录（Task 8）：清 cookie 那一步在服务端，这里就用"后端从此不认这个人"
    // 代替。**必须真的接住这一条** —— 让它掉进下面那个兜底的 blob 形状的话，
    // `post()` 会在读正文那一步炸成 ApiError，而 AccountPage 那个 `.catch` 会把
    // 它吞掉：退出**照样能成**，于是"点了退出"的测试绿在一个错误路径上。
    // （那条兜底本身是对的：网络失败也不该把人困在页面上。）
    if (url === '/api/logout') {
      meUser = null
      return jsonResponse({ ok: true })
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

  // 作品页那条"滚到底再取 60 张"（Task 11）。清空上一批观察者 —— 它们的组件
  // 已经卸载了，留着的话一条"滚到底"会同时点火到已经不存在的树上。
  ioObservers.length = 0
  vi.stubGlobal('IntersectionObserver', FakeIntersectionObserver)

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

  /**
   * ★ 2026-09-30 加（「停止」按钮）。
   *
   * 为什么值得一条：生成要十几秒，而在这之前用户**没有任何出口** ——
   * 那一格只有一个 `disabled` 的「发送」和一句"正在改…大约 10 秒"。
   * AI 产品在这个位置放的都是「停止」（ChatGPT / Claude / Gemini，
   * 组件库那边是 Ant Design X 的 Sender `loading` 态），我们没有。
   *
   * 这一条钉三件事，少一件这个按钮就只做了一半：
   *   ① 生成中那一格**是「停止」**（不是按不动的「发送」）；
   *   ② 按下去真的把这次请求**掐断**（signal 真的 abort 了）；
   *   ③ 收尾说一句「停了。」——而且**不能说"没改成功"**：
   *      是用户主动叫停的，说那句像在怪他。
   */
  it('★ 生成中可以停 —— 真的掐断，而且说「停了」不说"没改成功"', async () => {
    vi.mocked(api.postRoute).mockResolvedValue(
      decision({ route: 'generate', editPrompt: '去掉后面的路人' }))

    // 这一次生成**永远不返回**，除非被 abort —— 就是那十几秒的样子。
    // 假实现必须照着真 fetch 的规矩来：signal 一 abort 就抛 AbortError。
    // 少了这一半，"点了停止"之后 Promise 还挂着，界面永远停在忙。
    let seen: AbortSignal | undefined
    vi.mocked(api.postEdit).mockImplementation((_o, signal) => {
      seen = signal
      return new Promise((_res, rej) => {
        signal?.addEventListener('abort', () => {
          const e = new Error('aborted'); e.name = 'AbortError'; rej(e)
        })
      })
    })

    await renderApp()
    await uploadPhoto()
    await say('把后面那个人去掉')

    const before = container.querySelector('.chat-input button') as HTMLButtonElement
    expect(before.textContent).toBe('停止')
    expect(seen?.aborted).toBe(false)

    await act(async () => {
      before.click()
      await new Promise(r => setTimeout(r, 0))
    })

    expect(seen?.aborted).toBe(true)     // ② 请求真的被掐断了
    expect(lastReply()).toBe('停了。')     // ③ 有收尾 —— 不是一片安静
    // ③ 的后半句：不能把用户自己的决定说成一次失败
    expect(container.textContent ?? '').not.toContain('没改成功')
    expect(container.textContent ?? '').not.toContain('再试一次')
    // ① 停完那一格回到「发送」，用户马上能说下一句
    const after = container.querySelector('.chat-input button') as HTMLButtonElement
    expect(after.textContent).toBe('发送')
    expect((container.querySelector('.bubble.pending'))).toBeNull()
  })

  it('⚠️ 停的是**这一次** —— 停了之后下一句话照常能发出去', async () => {
    vi.mocked(api.postRoute).mockResolvedValue(
      decision({ route: 'generate', editPrompt: '去掉路人' }))
    vi.mocked(api.postEdit).mockImplementation((_o, signal) => {
      return new Promise((_res, rej) => {
        signal?.addEventListener('abort', () => {
          const e = new Error('aborted'); e.name = 'AbortError'; rej(e)
        })
      })
    })

    await renderApp()
    await uploadPhoto()
    await say('把后面那个人去掉')
    await act(async () => {
      (container.querySelector('.chat-input button') as HTMLButtonElement).click()
      await new Promise(r => setTimeout(r, 0))
    })

    // 第二次照常走完 —— 那个 abort 只属于第一次
    vi.mocked(api.postEdit).mockResolvedValue({
      imageDataUrl: 'data:image/png;base64,AAA', width: 1200, height: 800,
    })
    await say('换成黄昏')

    expect(api.postEdit).toHaveBeenCalledTimes(2)
    expect(vi.mocked(api.postEdit).mock.calls[1][1]?.aborted).toBe(false)
  })
})

/**
 * ★ 2026-09-30 加。AI 产品每条回复下面那排操作里，我们真正缺的那一颗
 * （组件库那边叫 Actions）。
 *
 * 为什么对我们格外有用：**模型是不确定的** —— 同一个 prompt 连打三次，
 * 天空的蓝色分别是 (12,133,248) / (0,163,236) / (1,151,237)（09-21 实测）。
 * "这版差一点"本来就该能再掷一次，而不是让用户把同一句话再打一遍
 * （那样他还会怀疑是自己没说清楚）。
 */
describe('★ 再来一版：同一句话重掷一次', () => {
  const P1 = 'Remove the person in the background.'
  const P2 = 'Change the sky to dusk.'

  /** 上传 → 说两句话，各生成一版。 */
  async function twoVersions() {
    vi.mocked(api.postRoute).mockResolvedValueOnce(
      decision({ route: 'generate', editPrompt: P1, reply: '好，这就去掉。' }))
    await renderApp()
    await uploadPhoto()
    await say('把后面那个人去掉')
    vi.mocked(api.postRoute).mockResolvedValueOnce(
      decision({ route: 'generate', editPrompt: P2, reply: '好，换成黄昏。' }))
    await say('天空换成黄昏')
  }

  const OK = { imageDataUrl: 'data:image/png;base64,AAA', width: 1200, height: 800 }

  it('★ 重跑的是**当初那句话**，而且从**那一版的底图**跑 —— 且不再过一遍路由', async () => {
    vi.mocked(api.postEdit).mockResolvedValue(OK)
    await twoVersions()

    // 两条生成出来的回复，各挂一颗（原图那条没有，见下一条）
    const btns = container.querySelectorAll('.bubble-rerun')
    expect(btns.length).toBe(2)

    await act(async () => {
      (btns[0] as HTMLButtonElement).click()
      await new Promise(r => setTimeout(r, 0))
    })

    const calls = vi.mocked(api.postEdit).mock.calls
    expect(calls.length).toBe(3)
    const last = calls[2][0] as { imageDataUrl: string; editPrompt: string }
    expect(last.editPrompt).toBe(P1)                          // 当初那句话，不是第二句
    expect(last.imageDataUrl).toContain('MODEL:decoded-1')    // 第一版的底，不是第二版
    // ★ 重掷**不过路由**：同样的意思不必再让模型读一遍照片 —— 那是一次白花的钱
    expect(vi.mocked(api.postRoute).mock.calls.length).toBe(2)
    expect(lastReply()).toContain('又出了一版')
  })

  it('⚠️ 原图那一条没有「再来一版」—— 它没有"当初那句话"', async () => {
    vi.mocked(api.postEdit).mockResolvedValue(OK)
    await renderApp()
    await uploadPhoto()

    // 还没改过：历史里只有原图那一步
    expect(container.querySelectorAll('.bubble-jump').length).toBe(1)
    expect(container.querySelectorAll('.bubble-rerun').length).toBe(0)
  })

  it('⚠️ 忙的时候那颗是禁用的 —— 再掷一次就是两次生成同时在跑，钱是两倍', async () => {
    vi.mocked(api.postEdit).mockResolvedValue(OK)
    await twoVersions()

    // 再发一句，让这次生成挂在半路（busy 非空）
    vi.mocked(api.postRoute).mockResolvedValueOnce(
      decision({ route: 'generate', editPrompt: 'x', reply: '好。' }))
    vi.mocked(api.postEdit).mockImplementation((_o, signal) => new Promise((_res, rej) => {
      signal?.addEventListener('abort', () => {
        const e = new Error('aborted'); e.name = 'AbortError'; rej(e)
      })
    }))
    await say('再改一处')

    expect((container.querySelector('.bubble-rerun') as HTMLButtonElement).disabled).toBe(true)

    // 收尾：把这次生成停掉，免得留下一个挂着的 Promise
    await act(async () => {
      (container.querySelector('.chat-input button.stop') as HTMLButtonElement).click()
      await new Promise(r => setTimeout(r, 0))
    })
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
    expect(topbarButtons()).toEqual(['调色', '分享', '保存'])
  })

  it('不能分享的设备上，那一格换成「下载」', async () => {
    // 桌面 Chrome 就是这样：`navigator.share` 在，但不认图片 —— 所以「分享」
    // 点了弹不出任何东西，**不该出现**（这条测试前半句就是钉它的）。
    //
    // ⚠️ **2026-09-30 改了后半句。** 原来这里断言的是 `['调色', '保存']`：
    //    那一格**空着**，理由是"不留一个点了没用的按钮"。可 2026-09-29 的
    //    产品能力测试量出来：**桌面上没有任何一条路能把图拿到手** ——
    //    「保存」只进作品集，唯一的「下载到电脑」藏在**保存失败的横幅**里，
    //    也就是说**存成功了反而拿不到**。所以那一格不该空着，它该换成
    //    同一个动作（"把图给我"）在桌面上的另一种给法。
    //    两半都得守：堵上整条路不行，留一个点了没反应的按钮也不行。
    vi.mocked(saveMod.canShareImage).mockReturnValue(false)
    await renderApp()
    await uploadPhoto()
    expect(topbarButtons()).toEqual(['调色', '下载', '保存'])
  })

  it('点「下载」→ 真的下载一份，文件名和分享那条一样', async () => {
    vi.mocked(saveMod.canShareImage).mockReturnValue(false)
    await renderApp()
    await uploadPhoto()
    await click('下载')

    expect(saveMod.downloadImage).toHaveBeenCalledTimes(1)
    expect(vi.mocked(saveMod.downloadImage).mock.calls[0][1]).toBe('p_ruixing.jpg')
    // ★ 它是"把图给我"，不是"存进作品集"—— 两条路不许串。
    //   变异：把 onDownload 接成 onSave → 这里红。
    expect(fetchMock.mock.calls.some(
      c => c[0] === '/api/works' && c[1]?.method === 'POST')).toBe(false)
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

  it('⚠️ 点「保存」→ 不偷偷下载，也不偷偷变成分享（§3.4）', async () => {
    // ⚠️ **这条 2026-09-25（Task 13）改过一半。** 原文是「老老实实下载，
    //   不许偷偷改成分享」—— §3.4 把前半句改了：保存现在只做"存进作品集"
    //   这一件事，下载挪到作品集里、由用户自己决定要哪张。
    //   后半句照旧守着 —— 用户原话：「那有时候不想立即分享也得分享喽」。
    //   一条"能分享就一律分享"的实现会让它红，而那正是他不要的。
    vi.mocked(saveMod.canShareImage).mockReturnValue(true)
    await renderApp()
    await uploadPhoto()
    await click('保存')

    expect(saveMod.downloadImage).not.toHaveBeenCalled()
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
    // 卡片是**会迟到**的：上传时发出去的那一次要 11~15 秒才回来，而（2026-09-30
    // 起）用户**在那之前就能说话**了。所以"卡片和确认条同时在屏上"这件事真会发生
    // —— 而那条确认守的是**哪一件事**，取决于用户有没有在这中间改过主意。
    //
    // 时间线：① 上传（卡片请求挂着）→ ② 用户说了句拿不准的话 → ③ 卡片才落地。
    // 卡片那一次请求**挂着不回**（真实世界里它是"晚到"的那一半）
    const gate = makeGate<SuggestResponse>()
    vi.mocked(api.postSuggest).mockReturnValueOnce(gate.promise)
    await renderApp()
    // ⚠️ **这一趟不需要假定时器**（2026-09-30 删掉了）。原来这里要
    // `advanceTimersByTimeAsync(10_000)` 把用户从等待里"放出来"，而那次改动之后
    // 用户从上传那一刻起就能说话 —— 那 10 秒**什么都不再断言了**，留着只会让
    // 下一个人以为它还管着什么（原注释甚至写着"常量若被改大这一步会红"，
    // 而那时它已经是句假话：改大照样绿）。
    await uploadPhoto()
    // 顺手把新行为钉住：**卡片还在路上时，发送键必须是能按的**。
    // （下面 `say()` 能真的把话送到模型，靠的就是它 —— 但那是**间接**的：
    //  发送键要是变回 disabled，坏掉的是后面几条断言，报错看着像别的事。）
    const sendBtn = container.querySelector('.chat-input button') as HTMLButtonElement
    expect(sendBtn.disabled).toBe(false)

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
      gate.open({
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

  it('★ 底图换过之后，晚到的卡片必须丢掉 —— 否则点一下就是白花一次钱', async () => {
    // 卡片是照着**上传那一刻那张照片**算的，实测要 11~15 秒才回来
    // （而用户从 2026-09-30 起不用再等它了，发送键当场就是亮的）。
    // 这十几秒里他完全可能已经改过一版 —— 一次生成式编辑就会换掉底图。
    // 「把后面的人去掉」（生成路，一次约 12,900 tokens）在人已经被去掉之后
    // 还挂在屏上，点一下就是**花钱去改一件已经做完的事**。
    //
    // ⚠️ 判据是**底图变没变**，不是"用户开没开口"：参数类的话（"亮一点"）
    //   不换底图，卡片说的仍然成立（后面那两个人还在），照旧该落地 ——
    //   上面那条「卡片落进点选流程」钉的正是另一半。
    const gate = makeGate<SuggestResponse>()
    vi.mocked(api.postSuggest).mockReturnValueOnce(gate.promise)

    await renderApp()
    await uploadPhoto()
    // 先钉住"这时候确实在等卡片" —— 少了它，下面那条"没有卡片"可能只是因为
    // 卡片压根没在等（把 SUGGEST_WAIT_MS 那段整个删掉，这条测试会静默地绿）。
    expect(container.textContent).toContain('正在看这张照片能改什么')

    // 换掉底图：一句结构性的改动 → 走生成路 → setImage(新底图)
    vi.mocked(api.postEdit).mockResolvedValue({
      imageDataUrl: 'data:image/png;base64,AAA', width: 1200, height: 800,
    })
    vi.mocked(api.postRoute).mockResolvedValueOnce(
      decision({ route: 'generate', editPrompt: '去掉后面那些人' }))
    await say('把后面那些人去掉')

    // 卡片**在这之后**才落地
    await act(async () => {
      gate.open({
        cards: [{
          label: '把后面的人去掉', route: 'generate',
          paramDeltas: {}, editPrompt: '去掉后面那些人',
        }],
        degraded: false,
      })
      await new Promise(r => setTimeout(r, 0))
    })

    const labels = [...container.querySelectorAll('.card')].map(c => c.textContent ?? '')
    expect(labels).not.toContain('把后面的人去掉')
    // 那句"正在看…"也该收了（卡片回来了，不管收没收下，等待都结束了）
    expect(container.textContent).not.toContain('正在看这张照片能改什么')
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

  /** 按**字段名**取某一格 —— 2026-09-25 起不再按"第几个"。
   *
   *  ⚠️ 这一条是那次踩出来的教训，不是洁癖。三格的顺序从「名字、邮箱、密码」
   *  换成「名字、密码、邮箱」（用户拍板）时，全仓**有十七处**按位置填这几格的代码
   *  （这个文件里十处、`.superpowers/` 下的验收探针里七处），谁都没写字段名。
   *  它们**不会红** —— 填错框不是错，`type()` 照常成功、事件照常送到另一个
   *  input 上，只是那笔字进了别人的格子，而后果要等到服务端回一句"密码不对"
   *  才看得见（这一轮真跑过对照：按位置填 + 顺序换回去，那条用例**照样绿**）。
   *  所以钩子（`name` 属性）现在是唯一的取法，顺序怎么调都不影响这些测试。
   *
   *  找不到就**抛**（而不是返回 null）：调用处要的失败语气是"屏幕上少了那一格"，
   *  不是 `Cannot read properties of null` —— 后者读起来像"测试自己坏了"。 */
  function field(which: 'username' | 'password' | 'email'): HTMLInputElement {
    const el = container.querySelector<HTMLInputElement>(`.login-field input[name="${which}"]`)
    if (!el) throw new Error(`屏幕上没有 name="${which}" 那一格`)
    return el
  }

  async function fillAndSubmit(username: string, password: string) {
    // 登录模式下就两个输入框：名字、密码（按字段名取，不按"第几个"）
    const name = field('username')
    const pass = field('password')
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

  /** 切到注册模式。有几条规矩（"密码至少 8 位"、"密码不能和名字一样"）**只属于注册**，
   *  要测它们就得先站到那条路上 —— 登录模式下连邮箱那一格都不渲染。 */
  async function switchToSignup() {
    const sw = container.querySelector('.login-switch') as HTMLButtonElement | null
    expect(sw).toBeTruthy()
    await act(async () => {
      sw?.click()
      await new Promise(r => setTimeout(r, 0))
    })
  }

  // ── 密码那一格的「看得见」开关（2026-09-25 加） ─────────────────────
  /** 密码那一格。
   *  ⚠️ 按**字段名**找，**不按 `[type=password]` 找** —— 这几条测试要断言的
   *  恰恰是它的 `type` 会变，拿 `type` 当锚点的话开关一按它自己就先失联了
   *  （选择器再也找不到那个元素，红得莫名其妙）。
   *
   *  这里**原来还有一个理由**：「按结构找，密码两种模式都在最后」。那个说法在
   *  2026-09-25 顺序换成「名字、密码、邮箱」之后就**不成立了** —— 注册模式下
   *  最后一个是邮箱。所以这条注释和那个取法一起改了：位置是个会变的答案。
   */
  function passwordBox(): HTMLInputElement | null {
    return container.querySelector<HTMLInputElement>('.login-field input[name="password"]')
  }

  /** 点一下那个开关。按**类名**找，不按文案找。
   *  `expect(...).toBeTruthy()` 先挡一道：开关不在时要红成"少了这个控件"，
   *  而不是 `Cannot read properties of null` —— 那是"测试自己坏了"的语气。 */
  async function toggleEye() {
    const eye = container.querySelector('.login-eye') as HTMLButtonElement | null
    expect(eye).toBeTruthy()
    await act(async () => {
      eye?.click()
      await new Promise(r => setTimeout(r, 0))
    })
  }

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

  it('⚠️ 注册模式下密码太短 → 一个请求都不发，而且说清为什么', async () => {
    // ⚠️ 这条**原来是在登录模式下测的**（那时候登录页也跑注册那套规矩）。
    // 2026-09-25 起登录不再跑它，所以这条挪回它真正的主人：注册。
    // 断言一个字没改，只换了模式 —— 它钉的是「密码至少 8 位」这条注册规矩
    // 真的接在**注册**这条路上（谁把那行 `checkPassword` 删了，这条红）。
    meUser = null
    await renderApp()
    await switchToSignup()

    // 按字段名填（原来是 `boxes[0]/[1]/[2]` = 名字/邮箱/密码 —— 顺序一换就全错位）
    await act(async () => {
      type(field('username'), '小明')
      type(field('email'), 'a@b.com')
      type(field('password'), 'short')
    })
    const form = container.querySelector('form.login-box') as HTMLFormElement
    await act(async () => {
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
      await new Promise(r => setTimeout(r, 0))
    })

    expect(container.textContent).toContain('密码至少 8 位')
    expect(calledWith('/api/signup')).toHaveLength(0)
  })

  it('★ 登录模式下密码太短**不拦** —— 打的是什么就是什么，对不对由服务端说', async () => {
    // 「至少 8 位」是给**新密码**定的规矩。登录时用户打的是什么就是什么：
    // 一个老账号的密码可能只有 6 位（规则改过，或者他注册得早），本地按今天的
    // 注册规矩拦下来，等于**他自己的密码永远打不进去** —— 而屏幕上那句
    // "密码至少 8 位"还会让他开始怀疑是自己记错了。
    meUser = null
    await renderApp()
    await fillAndSubmit('小明', 'short')

    // ★ 变异：把登录那条路上的 `checkPassword` 加回来 → **红在这一句**
    //   （`expected [] to have a length of 1`）。
    const call = calledWith('/api/login')
    expect(call).toHaveLength(1)
    // 而且是**原话**送出去的：没被"顺手"补长、截短或者归一化（那是别人密码的一部分）。
    expect(JSON.parse(String((call[0]?.[1] as RequestInit).body)).password).toBe('short')
  })

  it('★★ 用户撞的那个 case：登录模式下打 `Admin`，屏幕上不许出现"留给官方账号"', async () => {
    // 2026-09-25 用户真撞的：他在登录页打 `admin` / `admin123`，屏幕上跳出
    // 「这个名字是留给官方账号的，换一个吧」—— **一个请求都没发出去**。
    // 那句话回答的是"能不能拿这个名字注册"，而他要问的是"我能不能进去"；
    // 他读完问的是「是已经有这个账户了吗？」。
    //
    // 这里打 `Admin`（大写）而不是 `admin`：同一个 case —— `checkUsername` 会先
    // 折小写再撞保留名 —— 顺带把**归一化**也钉住（请求体里必须是 `admin`）。
    meUser = null
    await renderApp()

    // 服务端此刻的答案就是新的那一句（服务端那边有两条自己的测试钉着）。
    // 这里**故意让它失败**：不然登录成功、页面切走，就看不见"服务端那句话
    // 到底有没有到屏幕上"。
    const inner = fetchMock.getMockImplementation()!
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) =>
      url === '/api/login'
        ? jsonResponse({ error: { code: 'BAD_REQUEST', message: '没有这个账号，去注册一个吧' } }, 400)
        : inner(url, init))

    await fillAndSubmit('Admin', 'admin123')

    // ① 注册规矩的话一个字都不许出现在登录页上
    expect(container.textContent).not.toContain('留给官方账号')
    expect(container.textContent).not.toContain('官方')
    // ② 请求真的发出去了 —— 而且名字是**归一化之后**的（`Admin` → `admin`）。
    //   ★ 变异：把登录模式也加回 `checkUsername`（老代码）→ 红在①②
    //     （一个请求都没有，屏幕上还挂着"留给官方账号"）；
    //     把 `normalizeUsername` 换成原样送 `username` → 红在第②句。
    const call = calledWith('/api/login')
    expect(call).toHaveLength(1)
    expect(JSON.parse(String((call[0]?.[1] as RequestInit).body)))
      .toEqual({ username: 'admin', password: 'admin123' })
    // ③ 屏幕上出现的是**服务端那句话** —— 登录页对"名字在不在"一无所知，
    //   它只能把问题交出去，然后把答案原样摆出来。
    //   ⚠️ 这句话现在**自己带着出路**（「…去注册一个吧」，2026-09-25 用户拍板加），
    //   而下面那颗「还没有账号？注册一个」按钮**还在** —— 两处在意思上是重复的，
    //   那是用户要的重复，第四句守着"别顺手把按钮删了"。
    expect(container.querySelector('.login-error')?.textContent).toBe('没有这个账号，去注册一个吧')
    expect(container.querySelector('.login-switch')?.textContent).toContain('还没有账号')
    // 失败就是失败：还停在登录页，没有"半进去"这回事。
    expect(container.querySelector('.login-box')).toBeTruthy()
  })

  it('登录模式下名字是空的 → 「起个名字吧」，一个请求都不发', async () => {
    // 登录这条路上**只剩这一条**本地规矩：名字不能空 —— 空了连"查谁"都无从谈起。
    // 顺便它还是"出路"那一类：说了哪里不对，用户就知道该往哪儿填。
    //
    // 两次输入：一次真的是空的，一次只有空格。后者钉的是**先归一化、再判空**，
    // 写成 `username.length === 0` 的话它会溜过去 —— 发一条用户名是几个空格的
    // 登录请求出去，服务端只能回一句用户看不懂的话。
    meUser = null
    await renderApp()

    await fillAndSubmit('', 'password123')
    expect(container.querySelector('.login-error')?.textContent).toBe('起个名字吧')
    expect(calledWith('/api/login')).toHaveLength(0)

    await fillAndSubmit('   ', 'password123')
    expect(container.querySelector('.login-error')?.textContent).toBe('起个名字吧')
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
    // ⚠️ 两格**各看一次**，而且按字段名看：原来只看 `[0]` 那一格，也就是**只看
    //    名字**。密码在不在没人管，而"密码被清空"恰恰是这里最气人的那一种。
    expect(field('username').value).toBe('小明')
    expect(field('password').value).toBe('password123')
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

  it('★ 登录请求还在半路时，两颗按钮都得是禁用的（切换那颗也不许半路换模式）', async () => {
    // ★ 上一轮探针实测出来的形状（四条断言全中）：忙的时候点那颗切换按钮，
    //   **标题当场翻成「注册」**，而在飞的仍是一条**登录**请求 —— 它要是失败，
    //   服务端那句关于**登录**的话（「没有这个账号，去注册一个吧」）会落在
    //   「注册」标题底下。用户读到一句**归错地方**的话，照着它一步也走不下去。
    //
    //   为什么这轮才看得见：副标题上一轮删了、提交按钮忙的时候只肯说「稍等…」，
    //   于是忙的这几秒里**标题是屏上唯一还在说模式的字**（上面那条「标题就说这一步
    //   是干什么的」守的就是它）。标题以前写死「随心」、不参与模式，切换过去也
    //   看不出来 —— 这个错位一直躲在"看不出来"里。
    //
    //   `submit` 开头那句 `if (busy) return` 是**同一件事的半边**，它挡的是
    //   "用户等不及连点两下、交出去两条"；这一条守的是**另外半边**。
    //
    // ★ 变异（这一轮跑过）：把 `disabled={busy}` 从 `.login-switch` 上删掉 →
    //   红在 `expect(sw.disabled).toBe(true)`（`expected false to be true`）。
    meUser = null
    await renderApp()

    // 把**登录那一次请求**挂住不回。⚠️ 特意不用上面那条的 `meGate`：那条挂的是
    // 跟进的 `/api/me`，而这里要的形状是"用户点切换的那一瞬间，在飞的是登录请求
    // **本身**"—— 只有这个形状才演得到"它失败时那句话落在错误的标题底下"。
    const gate = makeGate()
    const inner = fetchMock.getMockImplementation()!
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === '/api/login') await gate.promise
      return inner(url, init)
    })

    await fillAndSubmit('小明', 'password123')

    // 前提之一：确实"忙着"（提交按钮的口径 —— 它和切换按钮读的是同一个 `busy`）
    const submit = container.querySelector('.login-submit') as HTMLButtonElement
    expect(submit.disabled).toBe(true)
    expect(submit.textContent).toContain('稍等')
    // 前提之二：那条登录请求**真的在飞**。少了这一句，"忙"可以是本地校验卡住的假象，
    // 而这条用例讲的正是"在飞的那条和屏上说的模式对不上"。
    expect(calledWith('/api/login')).toHaveLength(1)

    // ★ 这一条的主角：提交按钮挡了、切换按钮没挡，等于没挡 —— 两处是同一个判断
    //   的落地，得一挡全挡。
    const sw = container.querySelector('.login-switch') as HTMLButtonElement
    // 少了这颗按钮要红成"少了这颗按钮"，不是 `Cannot read properties of null`
    expect(sw).toBeTruthy()
    expect(sw.disabled).toBe(true)

    // ★ 而且**点它模式不变** —— 这才是用户看得见的那一句。
    //   （jsdom 照 HTML 规范实现：点一颗禁用的表单控件等于没点。）
    await act(async () => {
      sw.click()
      await new Promise(r => setTimeout(r, 0))
    })
    expect(container.querySelector('.login-title')?.textContent).toBe('登录')
    // 提交按钮也还在等它那条请求：忙的这几秒它一个字都不说模式（见上面标题那段），
    // 所以此刻屏幕上还在说"这一步是登录"的只有标题 —— 这正是不能让它翻面的理由。
    expect((container.querySelector('.login-submit') as HTMLButtonElement).textContent).toContain('稍等')

    // 放行：让在飞的那条走完（不在用例末尾留一个挂着的 promise），
    // 顺便确认"挡住切换"没有把正常这条路一起挡坏。
    await act(async () => {
      gate.open()
      await new Promise(r => setTimeout(r, 0))
    })
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

  it('⚠️ 从登录切到注册 → 框里那几个字不能跟着过去', async () => {
    // 用户在用的时候发现的：「如果没有账号，切到注册页面不应该自动填充用户在
    // 登录页填充的信息」。查下去发现这不是"有人想过、权衡后留下的设计"，是
    // **没人想过** —— 那个切换按钮原来只做 setMode + setError(null)，三个输入
    // state 一个字都没动，注释里也只解释了为什么清 error。而它**一条测试都没有**，
    // 所以一直没人看见。
    //
    // 代价最难看清的是密码那一格：登录页上它问的是"我的密码"，注册页上它问的是
    // "给我设的新密码"，于是用户在登录页手滑打错的一个字符，会在他毫不知情的
    // 情况下变成新账号的密码。
    meUser = null
    await renderApp()

    // 登录模式下只有两个框：名字、密码（邮箱那一格在注册模式下才渲染）
    // 数**几个**仍然是位置无关的判据（"登录页不给邮箱格"就靠它），所以留着；
    // 但**填哪一格**一律按字段名走，不按第几个。
    expect(container.querySelectorAll('.login-field input')).toHaveLength(2)
    const beforeName = field('username')
    const beforePass = field('password')
    await act(async () => {
      type(beforeName, '小明')
      type(beforePass, 'password123')
    })
    // ★ 前提：字**真的**打进去了。少了这两行，下面"三个框都是空的"是白捡的 ——
    //   `type` 哪天失灵（React 换了 tracker 的挂法之类），这条测试照样绿。
    expect(beforeName.value).toBe('小明')
    expect(beforePass.value).toBe('password123')

    const sw = container.querySelector('.login-switch') as HTMLButtonElement
    expect(sw).toBeTruthy()
    await act(async () => {
      sw.click()
      await new Promise(r => setTimeout(r, 0))
    })

    // 模式真的换了：提交按钮上的字从「登录」改成了「注册」。
    // **按类名定位、只看文案** —— 按文案找元素的话，这条会退化成
    // "我按那句话找到了那个按钮"，而不是"用户看到的字变了没有"。
    //
    // ⚠️ 这里**原来还看一个 `.login-sub`（副标题）**：登录模式说"登录一下，你的图
    //    都在这儿"、注册模式说"注册一个，图就留下来了"。2026-09-25 用户看过页面
    //    之后说那一行不要了，元素整个不再渲染 —— 于是信号换成**提交按钮的文案**
    //    （`登录` / `注册`，见 LoginPage 里那行 `busy ? '稍等…' : …`）。
    //    它同样稳：不忙的时候这两种模式就这两个词，而这条用例从头到尾不碰 busy。
    //    **换的只是信号，守的东西没换** —— 下面这几句仍然要能被"点了切换却不改
    //    mode"咬住（这一轮的变异跑过：把 `setMode(...)` 摘掉，这条立刻红）。
    const submit = container.querySelector('.login-submit') as HTMLButtonElement
    expect(submit).toBeTruthy()
    expect(submit.textContent).toContain('注册')

    // 三个框全空：现在是名字、密码、邮箱（**逐格按字段名看**，不按"第几个"）
    expect(container.querySelectorAll('.login-field input')).toHaveLength(3)
    expect(field('username').value).toBe('')
    expect(field('password').value).toBe('')
    expect(field('email').value).toBe('')

    // ── 反向那半圈：注册 → 登录 → 注册 ────────────────────────────────
    // 上面那半圈**碰不到邮箱那一格**（它在登录模式下根本不渲染），所以它是
    // 「登录页填的东西跟过去」这一半；邮箱那一格只有这半圈守得住 ——
    // 实测：单独删掉 `setEmail('')` 那一行，上面的断言全绿。
    // 先在注册页把三个框都填上，再往回切两次，看它们有没有原地复活。
    const switchOnce = async () => {
      const btn = container.querySelector('.login-switch') as HTMLButtonElement
      expect(btn).toBeTruthy()
      await act(async () => {
        btn.click()
        await new Promise(r => setTimeout(r, 0))
      })
    }
    /** 一次把三格都填上。**按字段名填** —— 原来传的是 `['阿花', 'a@b.com',
     *  'password123']` 再按 `i` 取第几格，顺序一换成「名字/密码/邮箱」，
     *  这个数组就把邮箱打进了密码格（而测试照样绿）。 */
    const fillAll = async (username: string, password: string, email: string) => {
      await act(async () => {
        type(field('username'), username)
        type(field('password'), password)
        type(field('email'), email)
      })
    }

    await fillAll('阿花', 'password123', 'a@b.com')
    await switchOnce()                        // 注册 → 登录
    expect(container.querySelectorAll('.login-field input')).toHaveLength(2)
    // ★ 这一步的断言不是装饰：少了它，一个**只往一个方向清**的写法能溜过去 ——
    //   比如 `if (mode === 'login') { 清空 }`：登录 → 注册那半圈照清（上面全绿），
    //   反向不清（这里不查的话也绿），而最后那一步又清了一遍（还是绿）。
    expect(field('username').value).toBe('')
    expect(field('password').value).toBe('')
    await switchOnce()                        // 登录 → 再注册
    expect(container.querySelectorAll('.login-field input')).toHaveLength(3)
    expect(field('username').value).toBe('')
    expect(field('password').value).toBe('')
    expect(field('email').value).toBe('')
  })

  it('★ 标题就说这一步是干什么的：登录页「登录」、注册页「注册」（用户拍板）', async () => {
    // 用户 2026-09-25 的原话：「登录页显示登录，注册页显示注册」。
    // 这里原来写死的是「随心」—— 那个中文名是**写账号那一段的计划时自己起的**，
    // 设计文档里从来没有过（文档里一直只叫 `RuiXing`）。他看到成品之后问
    // 「这个随心是啥？」，查出来的就是这个来历，于是拍了这一条。
    //
    // ⚠️ 这条守的不只是"两个词长什么样"，还有**它得跟着 `mode` 走**：
    //    副标题上一轮被删了（见 `LoginPage.tsx` 标题下面那段），所以这一屏上
    //    **仅剩的**那个一定会说话的模式标记就是这个标题 —— 另一个是提交按钮，
    //    而它 `busy` 的时候会变成「稍等…」（那几秒它不说模式，只有标题还在说）。
    //
    // ⚠️ 所以两个模式**各断一次**，而且走用户点的那颗按钮切 —— 只断登录那一半的话，
    //    写死成 `'登录'` 照样绿（"看着在守、其实守不住"那个形状，本仓库栽过）。
    //
    // ★ 变异（这一轮跑过）：写死成 `'登录'` → **红在第二句**；
    //   写死回 `'随心'` → 两句都红（`expected '随心' to be '登录'`）。
    meUser = null
    await renderApp()

    const title = () => container.querySelector('.login-title')?.textContent
    // 少了那颗标题要红成"少了标题"，不是 `expected undefined to be '登录'`
    expect(container.querySelector('.login-title')).toBeTruthy()
    expect(title()).toBe('登录')

    // 切过去（走 `.login-switch` 那颗真按钮，不是直接改 state）
    await switchToSignup()
    expect(title()).toBe('注册')
  })

  it('★ 点一下那个开关，密码就看得见了；再点一下，又变回圆点', async () => {
    // 用户报的原话：「我输的密码是admin123，是已经有这个账户了吗？还是提示信息不对？
    // **密码输入框加入一个可视化**」—— 打进去全是圆点，他没有任何办法确认自己打对没有。
    meUser = null
    await renderApp()

    const pass = passwordBox()
    expect(pass).toBeTruthy()

    expect(pass?.getAttribute('type')).toBe('password')   // 起点：圆点

    // 先在框里打一笔字 —— 下面"看得见"那半件事要断言的是**同一格、同一笔字**。
    // 从一个空框开始的话，`value` 那两句是白捡的（空框永远等于空框）。
    await act(async () => { if (pass) type(pass, 'admin123') })
    expect(pass?.value).toBe('admin123')

    await toggleEye()
    // ★ 变异 A：把 `type={showPassword ? 'text' : 'password'}` 换回写死的
    //   `type="password"` → **红在这一句**（`expected 'password' to be 'text'`）。
    expect(pass?.getAttribute('type')).toBe('text')
    // 而且是**同一格、字没丢**：谁要是"另外找个元素去显示明文"，用户刚打的密码就没了。
    expect(pass?.value).toBe('admin123')
    // 那颗眼睛的"名字"也得跟着说反话 —— 停在「显示密码」的话，读屏的人听到的还是"显示"。
    // （2026-09-25 第二轮：按钮上那两个字**换成了图标**，所以这里断言的从
    //  `textContent` 改成了 `aria-label` —— 图是猜的，文字才是说得清的。）
    expect(container.querySelector('.login-eye')?.getAttribute('aria-label')).toBe('隐藏密码')

    await toggleEye()
    expect(pass?.getAttribute('type')).toBe('password')
    expect(container.querySelector('.login-eye')?.getAttribute('aria-label')).toBe('显示密码')
  })

  it('★ 那颗眼睛的"名字"必须跟着状态走 —— 图标是猜的，文字才说得清', async () => {
    // 为什么这一条是硬要求：**哪张眼睛代表哪个状态，市场上没有共识** ——
    // 三个真实讨论的标题就是「我的眼睛按钮反了：该显示的时候变成了隐藏」、
    // 「Material Design 里密码切换图标是反的」、「两个状态下长得一样（bug）」。
    // 所以图标本身是**猜的**，说得清的是文字。而用户能拿到的文字只有两处：
    // `title`（鼠标停上去看得见）和 `aria-label`（读屏听到的）——
    // 两个都必须说**点下去会发生什么**，而且必须跟着状态走。
    //
    // ★ 变异①：把 aria-label / title 写死成一句话（不跟状态变）→ 这条红
    //   （露着的时候听到的还是"显示密码"，读屏的人会以为点下去是显示）。
    // ★ 变异②：把 title 删掉 → 红在 `expected null to be '显示密码'`
    //   （鼠标停上去什么也没有，用户只能靠猜图标）。
    meUser = null
    await renderApp()

    const eye = () => container.querySelector('.login-eye')
    expect(eye()).toBeTruthy()                       // 少了这个控件要红成"少了控件"
    // 图标本体是**内联** SVG（零新依赖那条线上，这也顺带证明"眼睛真的画出来了"）。
    expect(eye()?.querySelector('svg')).toBeTruthy()
    // 默认藏在状态：说的是"点下去会让你看见"
    expect(eye()?.getAttribute('aria-label')).toBe('显示密码')
    expect(eye()?.getAttribute('title')).toBe('显示密码')

    await toggleEye()
    expect(passwordBox()?.getAttribute('type')).toBe('text')   // 前提：真的切到明文了
    expect(eye()?.getAttribute('aria-label')).toBe('隐藏密码')
    expect(eye()?.getAttribute('title')).toBe('隐藏密码')
    // 两个说法必须**一致**：一个说"显示"一个说"隐藏"的话，看的人和听的人
    // 得到的是两回事 —— 而那正是那个图标本身没法解决的歧义。
    expect(eye()?.getAttribute('title')).toBe(eye()?.getAttribute('aria-label'))
  })

  it('★★ 点那个开关**不会**把表单交上去 —— 它在 `<form>` 里，漏个 type 就是提交按钮', async () => {
    // 这一条是给那个按钮上的 `type="button"` 兜底的。它所在的
    // `<form className="login-box" onSubmit={submit}>` 是**真的表单**，
    // 而表单里一个不写 `type` 的 `<button>` **默认就是 `submit`**：
    // 用户想看一眼密码打对没有，点一下「显示」—— 填好的密码**当场被交上去**。
    // 这是这一件里最容易犯、也最贵的错，所以它得有一条自己的断言。
    //
    // ★ 两个框**先填成能过前端校验的样子**再点。留空的话，漏写 type 也只会走到
    //   「起个名字吧」那一句，**一个请求都不会发** —— 那样"没发请求"这条断言
    //   看着在守、其实守不住（不加前提的断言是白捡的，本仓库栽过这个形状）。
    meUser = null
    await renderApp()

    const name = field('username')
    const pass = field('password')
    await act(async () => {
      type(name, '小明')
      type(pass, 'password123')
    })
    // 前提：字真的都进去了（名字不合法的话，下面那几条全是白捡的）
    expect(name.value).toBe('小明')
    expect(pass.value).toBe('password123')

    await toggleEye()

    // ★ 变异 B：把 `type="button"` 删掉 → **红在下面第一句**
    //   （`expected [ [ '/api/login', … ] ] to have a length of 0`）。
    expect(calledWith('/api/login')).toHaveLength(0)             // 一个请求都没发出去
    expect(container.querySelector('.login-box')).toBeTruthy()   // 还停在登录页：模式没变
    expect(container.querySelector('.login-submit')?.textContent).toContain('登录')
    expect(container.querySelector('.login-error')).toBeNull()   // 也没有多出一句提示
  })

  it('★ 切模式之后，开关回到「隐藏」—— 密码都清空了，还开着明文没道理', async () => {
    meUser = null
    await renderApp()

    await toggleEye()
    expect(passwordBox()?.getAttribute('type')).toBe('text')   // 前提：它真的开着

    const sw = container.querySelector('.login-switch') as HTMLButtonElement | null
    expect(sw).toBeTruthy()
    await act(async () => {
      sw?.click()
      await new Promise(r => setTimeout(r, 0))
    })

    // ★ 变异 C：把切换 handler 里那句 `setShowPassword(false)` 去掉 →
    //   **红在这一句**（模式切了、密码也清空了，但那一格还开着明文）。
    expect(passwordBox()?.getAttribute('type')).toBe('password')
    expect(container.querySelector('.login-eye')?.getAttribute('aria-label')).toBe('显示密码')
  })

  it('★ 三个框的先后是「名字 → 密码 → 邮箱」（用户拍板），而且它们挂着自己的字段名', async () => {
    // 用户 2026-09-25 的原话：「这三个的顺序依次是账户和密码然后是邮箱」。
    // 道理是**必填的两个挨着，性质不同的那个放最后**（邮箱是留给"以后找回密码"
    // 的备件，见设计 §6.4）。
    //
    // ⚠️ 这一条不只是在钉一个审美决定 —— 它是**位置式取法**的唯一守卫。
    // 这个仓库里原来有十七处代码按"第几个框"去填这三格（这个文件里十处、
    // `.superpowers/` 下的验收探针七处），谁都没写字段名：顺序一换，它们
    // **照样是绿的**，只是全都在往错误的框里打字（对照实测过，见 `field()` 那段）。
    // 那些地方现在都改按 `name` 取了，而这一条负责在有人把顺序调回去时
    // **当场喊一声**，而不是让一屏绿着的测试继续骗人。
    //
    // ★ 变异①：把 LoginPage 里邮箱那一块挪回密码前面 → 红在第①句
    //   （`['username','email','password']` vs `['username','password','email']`）。
    // ★ 变异②：把三个 `name=` 属性删掉 → 红在第①句（`[null,null,null]`）。
    meUser = null
    await renderApp()
    await switchToSignup()

    const inputs = [...container.querySelectorAll<HTMLInputElement>('.login-field input')]
    // 前提：注册模式下真的是三格（少一个的话下面两句比的是别的东西）
    expect(inputs).toHaveLength(3)

    // ① 每一格挂着自己的字段名 —— 这是那些代码现在取值的**钩子**，也是这一格的身份
    expect(inputs.map(i => i.getAttribute('name'))).toEqual(['username', 'password', 'email'])

    // ② 再拿**不依赖那个钩子**的东西钉一遍顺序：三格各自的 `type`。
    //    只钉 `name` 的话，把钩子挂错元素（比如 `name="password"` 挂到邮箱那格上）
    //    这一条照样绿 —— 而那正是最坏的一种错：钩子看着在、指向却是别人。
    //    名字格没有 type（就是默认的文本），密码是 password，邮箱是 email。
    //    ⚠️ 密码那格的 type 会跟着那颗小眼睛变，这里断言的是**默认**（圆点）那一档。
    expect(inputs.map(i => i.getAttribute('type') ?? 'text')).toEqual(['text', 'password', 'email'])
  })

  it('★ 星号只属于注册页：登录那两格不标「必填」，注册三格都标 —— 星号自己不会说话', async () => {
    // 用户 2026-09-25 的第 2 条：「账户和密码是必填的所以可以打上"*"」。**邮箱也是
    // 必填的** —— 他以为它选填，是因为它没标星号
    // （设计 §6.4：邮箱是找回密码的唯一通道，而找回密码排在第三段）。
    //
    // ⚠️ 2026-09-26 用户又拍了第 3 条（原话）：「登录页的密码和账户不用加"*"」。
    //    道理是"必填"在登录页上是**废话** —— 不填根本登不进去；那个记号本来就是
    //    **注册表单**的约定（注册时你可能有得选）。所以这一条从"三格都标"改成
    //    **按模式分**：登录页那两格都没有，注册页三格都有 —— **两个方向都得红**，
    //    证明它守的是"按模式分"而不是"反正有没有"。
    //
    // ⚠️ 他当时还要了另半件：「找个地方解释"*"是必填」。上一轮落地的是一句**屏上
    //    看得见**的 `.login-hint`「打 * 的都得填」。**2026-09-25 他又看过页面，
    //    说那一句不要了** —— 元素删除，钉着它的那段断言**跟着删掉**（不是改松：
    //    它守的东西已经不存在了）。所以现在这句话**屏上那一半没有了**，
    //    只剩下面这一条：可访问性树里那份「（必填）」—— 而它现在也**只管注册页**。
    //
    // ⚠️ 光加一个裸的 `<span>*</span>` **不算做完**：读屏软件念一个孤零零的星号，
    //    听的人既不知道它什么意思，也不知道它在修饰哪一格。所以每一格的标签里
    //    都配了一份**只在可访问性树里在**的字（`Req` 里那份 `.login-sr` 的
    //    「（必填）」），于是那一格的可读名字是「名字（必填）」。
    //    而星号自己挂 `aria-hidden`：不然会听到"名字 星号 （必填）"，
    //    那个音节没有任何意义。
    //
    // ⚠️ 另外**故意没有**加 HTML 的 `required`：它会让浏览器用**自己语言**的
    //    气泡抢先弹出来，把本仓库那几句自己写的中文提示挤掉（`checkUsername` /
    //    `checkEmail` / `checkPassword`）。最后一句钉着"没人把它加回来"。
    //
    // ★ 变异 A（这一轮跑过）：把 `<Req />` 加回**登录模式**的名字或密码那一格 →
    //   红在第 ① 段（"登录页 xxx 那格不该有星号"，或紧跟着那句"读屏不该听到必填"）。
    // ★ 变异 B（这一轮跑过）：把**注册模式**那三格里的 `<Req />` 去掉 →
    //   红在第 ② 段（`username 那一格读不出"必填"`）。
    // ★ 变异③：把某一格 `.login-star` 里的 `*` 去掉（但 `.login-sr` 留着）→
    //   红在下面那句 `expect(m.name).toContain('*')`（`star?.textContent` 也红）。
    // ★ 变异④：只留裸 `<span>*</span>`（把 `.login-sr` 那半截删掉）→ 红在
    //   「标签里有读得出的'必填'」。
    // ★ 变异⑤：把 `.login-sr` 换成 `display: none`（jsdom 里查不出来）——
    //   这一条**拦不住**，只有 styles.css 里那段注释知道。写在这儿免得下一个人
    //   以为这条测试把它也守住了。
    //
    // ⚠️ 原来这里还列着一条变异「删掉 `<p className="login-hint">` 那一行 → 红在
    //    屏上那句解释」。那句被用户删了，元素和那条变异一起走。
    meUser = null
    await renderApp()

    // ⚠️ 这里原来是 ①：钉着屏上那句解释（`.login-hint`）的**字和位置**，以及
    //    "它必须真的看得见"（不能借 `.login-sr` 那套藏起来）。那句被用户删了，
    //    元素和那段断言一起走 —— `LoginPage.tsx` 标题下面记着这件事的代价。

    /** 读屏软件听到的那一格名字 = 它的 `<label>` 的文字。
     *  名字/邮箱那两格的 label 是**包着** input 的，密码那格是 `htmlFor` 配对的 ——
     *  两种都得认（只认前一种的话，密码那格会静默地被跳过）。 */
    const readableName = (el: HTMLInputElement) => {
      const wrap = el.closest('label')
      if (wrap) return wrap.textContent ?? ''
      return container.querySelector(`label[for="${el.id}"]`)?.textContent ?? ''
    }
    /** 一格此刻"必填"那套记号：星号在不在、读屏听不听得见、有没有原生 `required`。
     *  三样一起看，因为它们**各自会被一种改法漏掉**：只钉星号的话，星号还在而
     *  `.login-sr` 被顺手删掉（或换成 `display: none`）照样绿，而"听不听得见"
     *  恰恰是用户要的那半；只钉可读名字的话，星号被摘掉也照样绿。 */
    const reqMarks = (el: HTMLInputElement) => ({
      star: el.closest('.login-field')?.querySelector('.login-star') ?? null,
      name: readableName(el),
      native: el.hasAttribute('required'),
    })

    // ① **登录页**（打开产品就是这一屏）：名字、密码两格**都不标**"必填"。
    //    ★ 变异 A 红在这里。
    for (const which of ['username', 'password'] as const) {
      const m = reqMarks(field(which))
      expect(m.star, `登录页 ${which} 那格不该有星号`).toBeNull()
      expect(m.name, `登录页 ${which} 那格读屏不该听到"必填"`).not.toContain('必填')
      expect(m.name).not.toContain('*')
      expect(m.native).toBe(false)
    }
    // 前提：登录页真的只有那两格。少这句的话，将来谁把邮箱那一格漏在登录模式下，
    // 上面那个循环还是绿的（它只遍历两格）—— 而"登录页问的只有我是谁"是另一条
    // 测试在管的事，这里只说"这一段比的是那两格"。
    expect(container.querySelectorAll('.login-field input')).toHaveLength(2)

    // ② **注册页**：三格都标（用户 2026-09-25 要的那一条，原样保留）。
    //    ★ 变异 B 红在这里。
    await switchToSignup()
    expect(container.querySelectorAll('.login-field input')).toHaveLength(3)
    for (const which of ['username', 'password', 'email'] as const) {
      const el = field(which)
      const m = reqMarks(el)
      expect(m.name, `${which} 那一格读不出"必填"`).toContain('必填')
      expect(m.name).toContain('*')          // 星号也在同一格里
      expect(m.star?.textContent).toBe('*')
      expect(m.star?.getAttribute('aria-hidden')).toBe('true')
      // ★ 而且**不要**原生 `required`（原因见上面那段注释）。
      expect(m.native).toBe(false)
    }
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
})

/**
 * 2026-09-25 加（Task 11）。**第一眼能看见作品的那个界面**（spec §3.5 ③）：
 * 按天分组 / 先摆 60 张 / 能搜。
 *
 * 这一层守的三件事都是用户看得见的：
 *   ① 500 张不能一次全摆出来 —— §10 点名的"屏幕会卡"；
 *   ② 没起名字时名字就是时间，所以搜「9月25」等于按日期搜（§3.5 的"一个机制两种用法"）；
 *   ③ 一张都没有时说的是一句**有出路**的话，不是白屏（§3.7）。
 */
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
   * 往搜索框里打字。
   *
   * ⚠️ 直接写 `box.value = '…'` 再派一个 input 事件**不行**：React 18 给受控输入
   * 挂了自己的 value tracker，而 `el.value = x` 走的正是 React 那个 setter ——
   * tracker 跟着一起更新，于是 React 认为"值没变"、onChange 一次都不调。
   * 实测（brief 的字面写法）：搜完之后两个格子全都还在，这条断言红在"2 ≠ 1"。
   * 得用**原型上的 setter** 绕过去值才真的"变"了（登录页那条同理，
   * 见「登录这道门」里的 type()）。
   */
  async function typeIn(box: HTMLInputElement, text: string) {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
    await act(async () => {
      setter.call(box, text)
      box.dispatchEvent(new Event('input', { bubbles: true }))
      await new Promise(r => setTimeout(r, 0))
    })
  }

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

  it('一张作品都没有时，说的是一句有出路的话，不是白屏', async () => {
    withWorks([])
    await renderApp()
    await goNav('作品')
    expect(container.querySelector('.gallery')).toBeTruthy()
    expect(container.textContent).toContain('还没有作品')
  })

  it('★ 取列表失败时，除了"不行"还得给一句"怎么办"（§3.7）', async () => {
    // 计划里的全局约束：凡告诉用户"不行"，都要同时告诉他"那怎么办" ——
    // 只说"不行"的地方都是死胡同。
    withWorksError('SENTINEL-列表读不出来')
    await renderApp()
    await goNav('作品')

    expect(container.querySelector('.gallery-error')?.textContent ?? '').toContain('SENTINEL-列表读不出来')
    // 出路那句话 —— 这一页不新造按钮，"刷新一下"是用户本来就有的。
    // （原来这里写着"重试逻辑是 Task 12 的事"：Task 12 交出去的是详情页，
    //   **没有**给作品页加重试 —— 作品页的出路到今天还是"刷新一下"。
    //   那句话是假的，2026-09-25 改掉；`GalleryPage.tsx` 里同一句假话
    //   2026-09-25 的第二轮也跟着改了 —— 现在两处说的是同一件事。）
    expect(container.querySelector('.gallery-hint')?.textContent ?? '').toContain('刷新')
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
})

/**
 * 2026-09-25 加（Task 12）。**点开一张图之后那一页**（spec §3.5.1）：
 * 配方永远分成两栏 —— 调色是配方（能带走），AI 编辑是这张图的经历（带不走）。
 *
 * 这一层守的是五件用户看得见的事：
 *   ① 两栏永远是两栏，而且 AI 那栏**一个「套用」按钮都没有** —— 给了就是骗人
 *      （「把后面那个人去掉」换一张照片就是另一回事）；
 *   ② 名字只有一份：详情页和作品页对同一张图必须叫**同一个名字** ——
 *      §3.5 的「名字就是日期，所以搜日期也能搜到」正是建立在这一条上；
 *   ③ 没有图的时候「套用调色」是**禁用**的，而且说了为什么、怎么办（§3.7）；
 *      **有**图的时候它得真的把那套调色带到修图页的**画布上**去（2026-09-25 补，
 *      那才是这一页存在的理由）；
 *   ④ 删除确认不许替用户编一句"你电脑上那份还在" —— 服务器不可能知道；
 *   ⑤ 打不开这一张时也要说"那怎么办"（§3.7），说法和作品页同源。
 */
describe('作品详情页：这张图怎么来的', () => {
  /** 打开第 1 张作品的详情页。 */
  async function openWork(recipe?: unknown) {
    const inner = fetchMock.getMockImplementation()!
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === '/api/works') return jsonResponse({ works: [WORK(1, 1_700_000_000_000)] })
      if (url === '/api/works/1' && (init?.method ?? 'GET') === 'GET') {
        return jsonResponse({
          id: 1, alias: null, createdAt: 1_700_000_000_000, updatedAt: 1_700_000_000_000,
          bytes: 100, hasThumb: true,
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
    expect(boxes[0]!.querySelectorAll('button').length).toBe(1)   // 调色那栏有「套用」
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
  })

  it('★ 改个中文名，网址一动不动（§3.5.1）', async () => {
    await openWork()
    const before = location.pathname + location.search
    const inner = fetchMock.getMockImplementation()!
    let patches = 0
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === '/api/works/1' && init?.method === 'PATCH') {
        patches += 1
        return jsonResponse({ id: 1, alias: '海边那张', createdAt: 0, updatedAt: 0, bytes: 0, hasThumb: true })
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

  it('★ 打不开这一张时也要说"那怎么办"（§3.7）—— 和作品页一个说法', async () => {
    // §3.7 是全局约束：凡告诉用户"不行"，都要同时告诉他"那怎么办"。
    // 加载失败那一屏原来**只有一句"不行"** —— 用户读到的是死胡同
    // （返回按钮在那儿不等于说了出路）。这里**不新造按钮、不新造重试逻辑**：
    // 和作品页同一条出路、同一句话（"刷新一下"是用户本来就有的）。
    const inner = fetchMock.getMockImplementation()!
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === '/api/works') return jsonResponse({ works: [WORK(1, 1_700_000_000_000)] })
      if (url === '/api/works/1' && (init?.method ?? 'GET') === 'GET') {
        return jsonResponse({ error: { code: 'NOT_FOUND', message: 'SENTINEL-没有这张作品' } }, 404)
      }
      return inner(url, init)
    })
    await renderApp()
    await goNav('作品')
    await act(async () => {
      (container.querySelector('.gallery-cell') as HTMLButtonElement).click()
      await new Promise(r => setTimeout(r, 0))
    })

    expect(container.querySelector('.detail-error')?.textContent ?? '')
      .toContain('SENTINEL-没有这张作品')
    // 变异：把这句提示删掉 → 这一条红（`expected '' to contain '刷新'`）。
    // `?? ''`：元素不在了要红成"少了一句话"，不是 vitest 那句"参数组合非法"。
    expect(container.querySelector('.detail-hint')?.textContent ?? '').toContain('刷新')
  })

  it('删除确认只说「删了就找不回来了」', async () => {
    await openWork()
    // ⚠️ 同样按**类名**找（见上面「套用」「改名」两条）：`.find(...)!` 那种写法在
    //   按钮不在时崩成 `Cannot read properties of undefined (reading 'click')`。
    const del = container.querySelector('.detail-delete') as HTMLButtonElement | null
    expect(del?.textContent ?? '').toContain('删除')      // 文案单独一条钉住
    await act(async () => { del?.click(); await new Promise(r => setTimeout(r, 0)) })

    // ⚠️ **只扫确认框那一段，不是整个 container。** 整屏里本来就有一句
    //   「下载到我的电脑」（那是**真的**，图就在他手上）—— 拿整屏去跑
    //   `not.toContain('你电脑')`，赌的是那句文案的字，不是在校验确认框说了什么。
    //   今天的 `下载到我的电脑` 恰好不含「你电脑」也恰好不含「下载的」，
    //   所以两种写法今天都是绿的 —— 那正是"今天能过靠的是巧合"。
    const confirm = container.querySelector('.detail-confirm')
    expect(confirm).toBeTruthy()   // 点完得真的弹出确认 —— 没弹时下面几句会崩在 null 上，红得看不懂
    expect(confirm!.textContent).toContain('删了就找不回来了')
    // ★ 不许说"你电脑上那份还在" —— 服务器**不可能**知道用户本地有没有那张图
    //   （他可能下载过、可能没下载、也可能下载完又删了）。宁可少安慰一句，不能骗人（§3.5）
    expect(confirm!.textContent).not.toContain('你电脑')
    expect(confirm!.textContent).not.toContain('下载的')
  })
})

/**
 * 2026-09-25 加（Task 13 —— 13 个任务里的最后一个）。**「保存」= 存进作品集**（§3.4）。
 *
 * 四件事在这一层钉住：
 *   ① 点「保存」不再偷偷下载。下载挪到作品集里，由用户自己决定要哪张、存到哪
 *      —— 顺带也不再往他的下载文件夹堆东西；
 *   ② 同一张照片存第二次起问一句「上次那张要替换掉吗」，而且**问完之后按下去
 *      发生的事也得是对的**：替换走 PUT（不是又 POST 一张）；
 *   ③ §6.6 ①（§10 点名它「最容易漏」）：**存不进去的时候，改好的图只在屏幕上**
 *      —— 一关页面就没了，而用户那一刻要的是"拿到图去发朋友圈"。作品集满了是
 *      **我们这边的限制**，不该让他连图都拿不到。所以当场得有一个真能按的
 *      「下载到电脑」。反过来，图**根本没导出来**的时候不许说"图还在"（那是骗人，
 *      用户会去找一个屏幕上不存在的按钮）。
 *   ④ ②那条问句挂着的时候，**配方定格在问的那一刻**（终审 M4）：他回头又改了一版
 *      再回答「替换」，存的仍是那张图当时的调整 —— 图和配方不能来自两个时刻。
 */
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
      // ⚠️ **两轮，不是一轮。** 点「保存」之后 App 得先把画布上那个 Blob 读成
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
    await clickTop('保存')
    expect(savedBody()).toBeTruthy()     // 先证明那一趟真的走到存了，别让 ② 红在别的原因上
    expect(thumbMod.makeThumbnail).toHaveBeenCalledWith(expect.anything(), 480)
  })

  it('★ 点「保存」是存进作品集，**没有偷偷下载**（§3.4）', async () => {
    const inner = fetchMock.getMockImplementation()!
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) =>
      (url === '/api/works' && init?.method === 'POST')
        ? jsonResponse({ id: 9 })
        : inner(url, init))

    await renderApp()
    await uploadPhoto()
    await clickTop('保存')

    expect(savedBody()).toBeTruthy()
    // ★ 「保存不再自动下载」—— 变异：把 downloadImage 加回保存流程 → 必须红
    expect(saveMod.downloadImage).not.toHaveBeenCalled()
    expect(container.textContent).toContain('存好了')
  })

  it('★ 配方带着「用户说过的话」，而且**没有**那个英文 prompt', async () => {
    const inner = fetchMock.getMockImplementation()!
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) =>
      (url === '/api/works' && init?.method === 'POST') ? jsonResponse({ id: 9 }) : inner(url, init))

    await renderApp()
    await uploadPhoto()
    vi.mocked(api.postRoute).mockResolvedValueOnce(decision({ reply: '好。' }))
    await say('亮一点')
    await clickTop('保存')

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
    expect(Object.keys(body.recipe).sort()).toEqual(['edits', 'params'])   // 两栏，不是一坨
  })

  it('★ 同一张照片存第二次，问「替换还是再存一张」（§3.4）', async () => {
    const inner = fetchMock.getMockImplementation()!
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) =>
      (url === '/api/works' && init?.method === 'POST') ? jsonResponse({ id: 9 }) : inner(url, init))

    await renderApp()
    await uploadPhoto()
    await clickTop('保存')
    await clickTop('保存')          // 第二次

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
    await clickTop('保存')
    await clickTop('保存')
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
    await clickTop('保存')
    await clickTop('保存')
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
    await clickTop('保存')          // 第一次：POST，savedId = 9
    await clickTop('保存')          // 第二次：问「替换掉吗」—— **配方在这一刻定格**
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
    await clickTop('保存')

    expect(container.textContent).toContain('没能存进作品集')
    // ⚠️ 按**类名**找那个盒子（结构），文案单独一条钉住 —— 不做"按文案找元素"。
    const dl = container.querySelector('.save-fail button.download') as HTMLButtonElement | null
    expect(dl?.textContent ?? '').toContain('下载到电脑')   // 文案：按钮叫这个
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
    await clickTop('保存')
    expect(container.textContent).toContain('没能存进作品集')

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
    expect(saveMod.downloadImage).toHaveBeenCalledWith(failedBlob, 'p_ruixing.jpg')
  })

  it('★ 图根本没能导出来的时候，屏幕上不许出现「图还在」（那是骗人）', async () => {
    // ★ 派发前补的。上面那条走的是"存不上，但图做出来了" —— 而 `blob` 为 null 是
    //   **另一种失败**：`buildExportBlob` 自己就炸了。那时说"图还在，先拿到手"，
    //   用户会去找一个屏幕上根本没有的按钮。
    vi.mocked(saveMod.buildExportBlob).mockRejectedValueOnce(new Error('画布太大'))
    await renderApp()
    await uploadPhoto()
    await clickTop('保存')

    expect(container.textContent).toContain('没能存进作品集')
    // 变异：把那两句的三目压成永远走第一句 → 这一条红
    expect(container.textContent).not.toContain('图还在')
    expect(container.querySelector('.save-fail button.download')).toBeNull()
  })
})

/**
 * 用户管理页（Task 8，spec §3.6 / §3.2）。
 *
 * 它**不占一个一级导航位置**：收在右上角那颗 👤 后面（§3.2）—— 一辈子点几次。
 * 用户名 / 使用情况 / 模型 / 退出登录，四个都真能用。
 *
 * ⚠️ **「模型」那一行是 Task 9 补上的**（2026-09-30）：`{ kind: 'models' }` 那一页
 * 立起来之后才挂得上 —— 先挂上去就是一颗"点了哪都不去"的按钮，这个项目不许有
 * 那种按钮（见 `.nav-item` / 保存横幅那几处的注释）。它右边那格写的是**别名**
 * （或者「默认」），绝不是型号名（§7.3）。
 *
 * ⚠️ 这一页有一条**否定**断言（不许出现型号名 / 我们的地址，§7.3）。否定断言
 * 最容易变成假绿 —— 页面压根没渲染时它照样通过 —— 所以它前面先钉一句
 * "这一页真的开着"，见下面那一条的注释。
 */
describe('用户管理页', () => {
  /** 从右上角那颗 👤 进去 —— 用户真会走的那一条路。 */
  async function openAccount() {
    const btn = container.querySelector('.user-btn') as HTMLButtonElement | null
    expect(btn).toBeTruthy()
    await act(async () => {
      btn?.click()
      // 这一页挂载时会自己去拉一次作品列表（使用情况）。**两个滴答**：
      // 第一个让点击引起的渲染落定，第二个让那次请求的 `.then` 也落定 ——
      // 只放一个的话，下面「显示的是真数」那几条看到的是"还在路上"的占位。
      await new Promise(r => setTimeout(r, 0))
      await new Promise(r => setTimeout(r, 0))
    })
  }

  /** 使用情况那一格现在写的是什么（`.account-stats` 整格不在时回 null）。 */
  function statsText(): string | null {
    return container.querySelector('.account-stats')?.textContent ?? null
  }

  it('★ /app/account 打得开，而且不是白屏', async () => {
    // 这一条走**网址**（不是点按钮）：地址栏是可以被直接打开的 —— F5、收藏夹、
    // 别人发来的一条链接。`viewFromPath` 少认一行，打开这里的人拿到的就是
    // 落地页或修图页，而不是他点开的那一页；而白屏是最差的那种答案。
    history.replaceState(null, '', '/app/account')
    await renderApp()

    expect(container.querySelector('.account')).toBeTruthy()
    // 用户名是这一页的主句（§3.6 那张图最上面那一行）—— 它在，这一页就没白
    expect(container.querySelector('.account-name')?.textContent).toBe(LOGGED_IN.username)
  })

  it('★ 右上角那颗 👤 点得开它，而且地址栏跟着走', async () => {
    // 顶栏那两颗按钮（分享 / 保存）只在**有照片**的时候才在，而 👤 无论如何都在：
    // 用户第一次进来、还没选图的时候也该找得到自己那一页。
    await renderApp()
    expect(container.querySelector('.welcome')).toBeTruthy()   // 起点：还没选图的修图页
    await openAccount()

    expect(container.querySelector('.account')).toBeTruthy()
    // 地址栏也得跟着走 —— 这一页可以直接发链接、也可以 F5（`pathOf` 少一行就断）
    expect(location.pathname).toBe('/app/account')
  })

  it('★ 页面上不许出现我们自己用的模型名或接口地址（§7.3 + §10 的变异测试）', async () => {
    // 变异：把 `sensenova-6.8-flash-lite` / `token.sensenova.cn` 写死进这一页
    // → 这一条必须红。用户看到的只该是「默认」和别名 —— 型号名对他没意义，
    // 限制才有意义（§7.3）。
    await renderApp()
    await openAccount()
    // ★ 前提：这一页**真的开着**。少了这一句，下面两条 `not.toContain` 会因为
    //   "整页什么都没渲染"而白白通过 —— 否定断言最典型的假绿。（本文件在
    //   `.save-fail` 那两条上踩过同一个坑，那边是靠"只扫横幅那一段"解决的。）
    expect(container.querySelector('.account')).toBeTruthy()
    expect(document.body.textContent ?? '').not.toContain('sensenova')
    expect(document.body.textContent ?? '').not.toContain('token.sensenova.cn')
  })

  it('★ 点「退出登录」→ 真的退出去了', async () => {
    await renderApp()
    await openAccount()

    const out = container.querySelector('.account-signout') as HTMLButtonElement | null
    expect(out?.textContent).toBe('退出登录')
    expect(out?.disabled).toBe(false)          // 按钮得真的能按
    await act(async () => {
      out?.click()
      await new Promise(r => setTimeout(r, 0))
    })

    // ① 服务端**真的被通知了**：会话在 cookie 里，前端清不掉它 ——
    //    只把人放走、不告诉后端，下次刷新他又"登着"回来了。
    expect(fetchMock.mock.calls.some(c => c[0] === '/api/logout' && c[1]?.method === 'POST'))
      .toBe(true)
    // ② 人已经不在这一页上了。回到登录页 —— App 里每一处"票不管用了"都回那儿
    //    （见 isUnauthorized 那段注释），"退出登录"是同一件事的用户主动版。
    expect(container.querySelector('.account')).toBeNull()
    expect(container.querySelector('.login-box')).toBeTruthy()
  })

  it('★ 退出的请求失败也要放人走 —— 不能因为网络不好就把人困在页面上', async () => {
    // 服务端那条路是幂等的、只清一个 cookie（连请求体都不读），而用户要的是"离开"。
    // 困住他的形状是：点了退出、屏幕上什么都没变 —— 他只会以为自己没点着，
    // 然后再点一次、再点一次。
    // 变异：把 AccountPage 里那个 `.catch(() => {})` 删掉 → 这一条红
    //      （`.then(onSignedOut)` 挂在一条已经 reject 的链上，永远不会执行）。
    const inner = fetchMock.getMockImplementation()!
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) =>
      url === '/api/logout'
        ? jsonResponse({ error: { code: 'INTERNAL', message: '没清干净' } }, 500)
        : inner(url, init))

    await renderApp()
    await openAccount()
    const out = container.querySelector('.account-signout') as HTMLButtonElement
    await act(async () => {
      out.click()
      await new Promise(r => setTimeout(r, 0))
    })

    expect(container.querySelector('.account')).toBeNull()
    expect(container.querySelector('.login-box')).toBeTruthy()
  })

  it('★ 使用情况显示的是**真数** —— 不是写死的 0', async () => {
    // 第一版是 App 传死 `workCount={0}`：这一页对**每个**存过作品的人都说
    // 「0 张作品」。现在它自己去拉一次（只回元数据，不带图）。
    // 变异：把那一格改回写死 `0` → 这一条红。
    const MIB = 1024 * 1024
    withWorks([
      { ...WORK(1, 1_700_000_000_000), bytes: 6 * MIB },
      { ...WORK(2, 1_700_000_000_000), bytes: 4 * MIB },
    ])
    await renderApp()
    await openAccount()

    expect(statsText()).toMatch(/^2\s*张作品/)
    expect(statsText()).toContain('10 MB')       // 6 + 4，体积是加出来的，不是编的
    expect(container.querySelectorAll('.stat')).toHaveLength(2)
  })

  it('★ 服务端没给 bytes 时只说张数，不硬凑一个体积出来', async () => {
    // 「别硬凑」的具体形状：**缺的那几张不许当 0 算** —— 那会把总量报小，
    // 同样是假话。算不出来就整格不说（§3.6 那两格，少一格不碍事）。
    withWorks([{ id: 1, alias: null, createdAt: 0, updatedAt: 0, hasThumb: true }])
    await renderApp()
    await openAccount()

    expect(statsText()).toMatch(/^1\s*张作品/)
    expect(statsText()).not.toContain('MB')
    expect(statsText()).not.toContain('KB')
    expect(container.querySelectorAll('.stat')).toHaveLength(1)
  })

  it('★ 拿不到使用情况时**一个数字都不显示** —— 绝不退回 0', async () => {
    // ★★ 这一条就是审查说的那个 bug 的形状。审查原话：
    //   「任何有作品的人都会在自己的账号页看到『0 张作品』……这不是能力免责声明，
    //     而是关于用户数据的一句假话」（《文案规范》§3：写之前先问"这句话在
    //     什么情况下是假的？"）。
    // 变异：把「拿不到就整格不出现」改成画 0（= 第一版的行为）→ 这一条必须红。
    withWorksError('SENTINEL-数不出来')
    await renderApp()
    await openAccount()

    // 前提：这一页**真的开着**。少了它，下面"没有数字"会因为整页没渲染而假绿。
    expect(container.querySelector('.account')).toBeTruthy()
    expect(container.querySelector('.account-name')?.textContent).toBe(LOGGED_IN.username)
    expect(statsText()).toBeNull()
    expect(container.textContent).not.toMatch(/\d+\s*张作品/)
  })

  it('★ 还没拉回来的时候显示占位「…」，也不是 0', async () => {
    // 「0」读起来是关于用户资产的一句**断言** —— 哪怕只闪半秒也不该是假的。
    // 变异：把占位换成写死的 `0` → 这一条红。
    const gate = withWorksGate()
    await renderApp()
    // 这里**不走 openAccount()** —— 它会把那两个滴答放过去，而这一条要的就是
    // "还在路上"的那一瞬间。
    const btn = container.querySelector('.user-btn') as HTMLButtonElement
    await act(async () => { btn.click() })

    expect(container.querySelector('.account')).toBeTruthy()
    expect(statsText()).toContain('…')
    expect(container.textContent).not.toMatch(/\d+\s*张作品/)

    // 放行之后回的是空列表 —— 那时候「0 张作品」就不是假话，而是事实。
    await act(async () => {
      gate.open()
      await new Promise(r => setTimeout(r, 0))
    })
    expect(statsText()).toMatch(/^0\s*张作品/)
  })

  it('★ 有「模型」这一项，点了进模型设置（Task 8 挪过来的那一条）', async () => {
    // 从 Task 8 手里接过来的：那一轮这一页只立了骨架，「模型」这一行**故意**
    // 没挂（视图还不存在）。现在那一页立起来了，这一条跟着搬过来。
    withModels([
      MODEL(1, { alias: '我的便宜货', modelId: 'deepseek-chat', active: true }),
      MODEL(2, { alias: '那个快的' }),
    ])
    await renderApp()
    await openAccount()

    const row = container.querySelector('.account-row') as HTMLButtonElement | null
    expect(row?.querySelector('.account-row-label')?.textContent).toBe('模型')
    // ★ 右边那格写的是**别名**（§7.3 / §7.4）—— 型号名只在设置里翻开来才露。
    //   写型号名不只是难读，还等于把他用的是谁家摊在这一页上。
    expect(row?.querySelector('.account-row-value')?.textContent).toBe('我的便宜货')
    expect(container.textContent).not.toContain('deepseek-chat')

    await act(async () => {
      row?.click()
      await new Promise(r => setTimeout(r, 0))   // 切页那一次渲染
      await new Promise(r => setTimeout(r, 0))   // 新页挂载时那一次"拉清单"
    })
    // 前提：那一页**真的开着**（少了这一句，下面那条地址断言会因为"什么都没渲染"假绿）
    expect(container.querySelector('.models')).toBeTruthy()
    expect(container.querySelector('.models-title')?.textContent).toBe('模型设置')
    // 地址栏也得跟着走 —— 这一页可以直接发链接、也可以 F5（`pathOf` 少一行就断）
    expect(location.pathname).toBe('/app/models')
  })

  it('★ 模型清单拿不到时，那一行右边那格**不出现**（不许替他写「默认」）', async () => {
    // 和「0 张作品」一模一样的毛病（§3.6 + 《文案规范》§3）：写「默认」等于
    // 替一个**接了自己模型**的人声明"你没接"。宁可少说一句，不说一句假的。
    // 变异：拿不到时画「默认」（= 第一版那种"给个看起来正常的默认值"）→ 这一条红。
    withModelsError('SENTINEL-模型清单拉不回来')
    await renderApp()
    await openAccount()

    const row = container.querySelector('.account-row') as HTMLButtonElement
    expect(row.querySelector('.account-row-label')?.textContent).toBe('模型')
    expect(row.querySelector('.account-row-value')).toBeNull()
    // 少一格不挡路：这一行照样点得进去
    expect(row.disabled).toBe(false)
  })

  it('modelValue：说得出"在用哪几套"，一套都没接才叫「默认」（§7.4）', () => {
    // 两个类别各自独立 —— 所以他可能"对话接了、图片没接"，
    // 那时候写「默认」是错的（有一半不是默认）。
    expect(modelValue([])).toBe('默认')
    expect(modelValue([MODEL(1, { active: true, alias: '我的便宜货' }), MODEL(2)])).toBe('我的便宜货')
    expect(modelValue([
      MODEL(1, { kind: 'chat', active: true, alias: '我的便宜货' }),
      MODEL(2, { kind: 'image', active: true, alias: '那个贵的' }),
    ])).toBe('我的便宜货、那个贵的')
    // 两栏各存一套同名的很常见 —— 写两遍像出了错
    expect(modelValue([
      MODEL(1, { kind: 'chat', active: true, alias: '出差那套' }),
      MODEL(2, { kind: 'image', active: true, alias: '出差那套' }),
    ])).toBe('出差那套')
    // 变异：只看第一套 / 不去重 / 一套都没有时也写个别名 → 这一条红
  })

  it('formatSize：三档各说一句话（§3.6 那张图只画了 MB 那一档）', () => {
    // 变异：把 MB / GB 那两档写反，或者给 MB 也留小数 → 这一条红。
    const MB = 1024 * 1024
    expect(formatSize(240 * 1024)).toBe('240 KB')
    expect(formatSize(342 * MB)).toBe('342 MB')
    expect(formatSize(1.5 * 1024 * MB)).toBe('1.5 GB')
  })
})

/**
 * 把"这一趟修图"存到服务端（Task 4）：**上传建会话、每一次改动落盘**。
 *
 * 这一层错了**不会报错**，只会静静地丢：刷新之后参数回到拖动之前、对话少几句,
 * 而屏幕上当时什么都没说。所以它值得自己的几条用例。
 */
describe('会话落盘：上传建会话、每一步更新', () => {
  /** 等过落盘那一层防抖（800ms）。
   *
   *  ★ **真的等**（真定时器），不用假定时器：这个文件从头到尾都用真定时器，
   *  而 `vi.useFakeTimers()` 会把三条路一起冻上（`act` 里的微任务、
   *  那些"挂住不回"的 gate、以及 React 自己的调度）。900 只是留个余量 ——
   *  `setTimeout` 保证的是"至少"这么久，慢机器上照样成立。 */
  const waitPersist = async () => {
    await act(async () => { await new Promise(r => setTimeout(r, 900)) })
  }
  /** 打到会话那两条路上的请求（建会话 / 每一步更新）。 */
  const sessionCalls = (url: string, method: 'POST' | 'PUT') =>
    fetchMock.mock.calls.filter(([u, init]) => u === url && (init?.method ?? 'GET') === method)
  const bodyOf = (call: unknown[]) => JSON.parse(String((call[1] as RequestInit).body))

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
    // 第一次落盘：上传那一版（底图在这个副作用眼里是新的，所以它带 `base`）
    await waitPersist()

    // 再动一下 —— 说一句"亮一点"。⚠️ 这条**只改 params，不动 history**
    //  （裁定 ⑤：改 params 从来不 push 快照）。所以落盘那条路要是没把 `params`
    //  单独带上、也没把它放进依赖数组，**这一整趟都不会再落盘** ——
    //  用户拖完滑块刷新一下回到拖动之前，而验收线第 1 条写着"参数全在"。
    vi.mocked(api.postRoute).mockResolvedValueOnce(
      decision({ route: 'params', paramDeltas: { exposure: 20 }, reply: '给你提亮了。' }))
    await say('亮一点')
    await waitPersist()

    const puts = sessionCalls('/api/sessions/1', 'PUT')
    // 两次改动 → 恰好两次请求（拖滑块会一路推出很多版，防抖没做的话这里是一串）
    expect(puts).toHaveLength(2)
    const body = bodyOf(puts[1]!)
    expect(body.messages.map((m: { text: string }) => m.text)).toContain('亮一点')
    // ★ 参数单独走的那条路：它落在**最后一步**上，不是靠 history 带过去的
    expect(body.params.exposure).toBe(20)
    // ★ 底图没换就不许传 `base`（也不许重做缩略图）—— 传了就是多存一个
    //   没人引用的文件，而服务端会把好好的缩略图删了重存（§4.3 那条的落点）
    expect(body.base).toBeUndefined()
    expect(body.thumb).toBeUndefined()
    // 而且步骤还是那一步 —— 参数步不推快照
    expect(body.steps).toHaveLength(1)
  })
})
